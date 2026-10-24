import { randomUUID } from "crypto";
import { createServer, Server } from "http";
import connectPgSimple from "connect-pg-simple";
import session from "express-session";
import { closeAppSessionStores, createApp } from "./src/app";
import { prisma } from "./src/utils/prisma";
import { env } from "./src/utils/env";
import { isSlackTestNotificationEnabled } from "./src/services/slackIntegration";
import { isElasticsearchConfigured } from "./src/services/elasticsearch";
import { emailQueue, getEmailJobId } from "./src/queues/emailQueue";
import {
  isBullBoardAdmin,
  parseBullBoardAdminEmails,
  sanitizeBullBoardJobData,
  sanitizeBullBoardResponse,
} from "./src/routes/queueDashboard";

const PgStore = connectPgSimple(session);
const sessionStore = new PgStore({
  conString: env.DATABASE_URL,
  createTableIfMissing: true,
  pruneSessionInterval: false,
});

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function signSessionId(sessionId: string): string {
  const cookieSignature = require("cookie-signature") as { sign(value: string, secret: string): string };
  return encodeURIComponent(`s:${cookieSignature.sign(sessionId, env.SESSION_SECRET)}`);
}

async function runCampaignApiTest(): Promise<void> {
  const dashboardAdmins = parseBullBoardAdminEmails("Ops@Example.com, admin@example.net ");
  assert(isBullBoardAdmin("ops@example.com", dashboardAdmins), "dashboard email allowlist should be case-insensitive");
  assert(!isBullBoardAdmin("other@example.com", dashboardAdmins), "unlisted email should not be authorized");
  const sanitizedJobData = sanitizeBullBoardJobData({
    campaignId: 11,
    recipientId: 22,
    recipientEmail: "private@example.invalid",
    subject: "Private subject",
    body: "Private email body",
  });
  assert(
    JSON.stringify(sanitizedJobData) === JSON.stringify({ campaignId: 11, recipientId: 22 }),
    "dashboard job payload should only include campaign and recipient IDs"
  );
  const sanitizedLegacyResponse = sanitizeBullBoardResponse({
    jobs: [{
      id: "email:11:22",
      data: { campaignId: 11, recipientId: 22, recipientEmail: "private@example.invalid", subject: "Private", body: "Secret" },
      returnValue: { accessToken: "secret" },
      failedReason: "safe diagnostic",
    }],
  });
  assert(
    JSON.stringify(sanitizedLegacyResponse) === JSON.stringify({
      jobs: [{ id: "email:11:22", data: { campaignId: 11, recipientId: 22 }, failedReason: "safe diagnostic" }],
    }),
    "dashboard response should redact legacy bodies, addresses, and return values while retaining job state diagnostics"
  );

  const token = randomUUID();
  const sessionIds: string[] = [];
  let userIds: number[] = [];
  let campaignId: number | undefined;
  let recipientIds: number[] = [];
  let server: Server | undefined;

  try {
    const owner = await prisma.user.create({
      data: {
        googleId: `campaign-api-owner-${token}`,
        email: `campaign-api-owner-${token}@example.invalid`,
      },
    });
    const otherUser = await prisma.user.create({
      data: {
        googleId: `campaign-api-other-${token}`,
        email: `campaign-api-other-${token}@example.invalid`,
      },
    });
    userIds = [owner.id, otherUser.id];

    const ownerSessionId = `campaign-api-owner-${token}`;
    const otherSessionId = `campaign-api-other-${token}`;
    sessionIds.push(ownerSessionId, otherSessionId);
    const testSession = (userId: number) => ({
      cookie: { originalMaxAge: null, expires: null, secure: false, httpOnly: true, path: "/", sameSite: "lax" },
      passport: { user: userId },
    });
    await Promise.all([
      new Promise<void>((resolve, reject) => sessionStore.set(ownerSessionId, testSession(owner.id), (error) => error ? reject(error) : resolve())),
      new Promise<void>((resolve, reject) => sessionStore.set(otherSessionId, testSession(otherUser.id), (error) => error ? reject(error) : resolve())),
    ]);

    server = createServer(createApp());
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert(address && typeof address !== "string", "Test server did not bind to a TCP port");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const ownerCookie = `connect.sid=${signSessionId(ownerSessionId)}`;
    const otherCookie = `connect.sid=${signSessionId(otherSessionId)}`;

    const request = async (path: string, options: RequestInit = {}, cookie?: string) => {
      const headers = new Headers(options.headers);
      if (options.body) headers.set("content-type", "application/json");
      if (cookie) headers.set("cookie", cookie);
      const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
      const body = await response.json();
      return { status: response.status, body };
    };

    const unauthenticatedRoutes: Array<[string, string, string?]> = [
      ["GET", "/api/campaigns"],
      ["GET", "/api/search/campaigns"],
      ["GET", "/api/search/recipients"],
      ["POST", "/api/search/reindex", "{}"],
      ["GET", "/api/admin/queue-dashboard-access"],
      ["GET", "/admin/queues"],
      ["GET", "/admin/queues/api/queues"],
      ["GET", "/api/integrations/slack/status"],
      ["GET", "/api/integrations/slack/oauth"],
      ["POST", "/api/campaigns", "{}"],
      ["GET", "/api/campaigns/1"],
      ["POST", "/api/campaigns/1/recipients", '{"emails":[]}'],
      ["POST", "/api/campaigns/1/schedule", "{}"],
    ];
    if (isSlackTestNotificationEnabled(env.NODE_ENV)) {
      unauthenticatedRoutes.push(["POST", "/api/integrations/slack/test-notification", "{}"]);
    }
    for (const [method, path, body] of unauthenticatedRoutes) {
      const result = await request(path, { method, body });
      assert(result.status === 401, `Expected unauthenticated ${method} ${path} to return 401`);
    }

    const spoofedCreate = await request("/api/campaigns", {
      method: "POST",
      body: JSON.stringify({
        userId: otherUser.id,
        subject: "Spoof attempt",
        body: "must be rejected",
      }),
    }, ownerCookie);
    assert(spoofedCreate.status === 400, "Client-supplied userId should be rejected");

    const created = await request("/api/campaigns", {
      method: "POST",
      body: JSON.stringify({
        subject: "Campaign API test",
        body: "Disposable API integration test",
        startTime: new Date(Date.now() + 60000).toISOString(),
        delayBetweenEmails: 0,
        hourlyLimit: 20,
      }),
    }, ownerCookie);
    assert(created.status === 201, "Campaign creation should return 201");
    campaignId = created.body.id;
    assert(Number.isSafeInteger(campaignId), "Campaign response did not include an ID");

    if (!isElasticsearchConfigured()) {
      const unavailableCampaignSearch = await request("/api/search/campaigns", { method: "GET" }, ownerCookie);
      const unavailableReindex = await request("/api/search/reindex", { method: "POST", body: "{}" }, ownerCookie);
      assert(unavailableCampaignSearch.status === 503, "Search should report Elasticsearch unavailable when not configured");
      assert(unavailableReindex.status === 503, "Reindex should report Elasticsearch unavailable when not configured");
    }

    const invalidRecipients = await request(`/api/campaigns/${campaignId}/recipients`, {
      method: "POST",
      body: JSON.stringify({ emails: ["invalid-address"] }),
    }, ownerCookie);
    assert(invalidRecipients.status === 400, "Invalid recipient address should return 400");

    const addedRecipients = await request(`/api/campaigns/${campaignId}/recipients`, {
      method: "POST",
      body: JSON.stringify({ emails: [" Test.User@Example.com ", "test.user@example.com"] }),
    }, ownerCookie);
    assert(addedRecipients.status === 201, "Valid recipient import should return 201");
    assert(addedRecipients.body.createdCount === 1, "Normalized duplicate emails should create one recipient");
    assert(addedRecipients.body.duplicateCount === 1, "Duplicate count should include the normalized duplicate");

    const otherList = await request("/api/campaigns", { method: "GET" }, otherCookie);
    assert(otherList.status === 200 && otherList.body.length === 0, "Other user must not see the owner's campaign");
    const otherDetail = await request(`/api/campaigns/${campaignId}`, { method: "GET" }, otherCookie);
    assert(otherDetail.status === 404, "Other user campaign detail should return 404");

    const ownList = await request("/api/campaigns", { method: "GET" }, ownerCookie);
    assert(ownList.status === 200 && ownList.body.length === 1, "Owner should see their campaign");
    assert(ownList.body[0].recipientCounts.PENDING === 1, "Campaign list should return recipient status counts");
    const detail = await request(`/api/campaigns/${campaignId}`, { method: "GET" }, ownerCookie);
    assert(detail.status === 200 && detail.body.recipients.length === 1, "Owner should see recipient details");
    assert(detail.body.recipients[0].email === "test.user@example.com", "Stored recipient should be normalized");

    const dashboardDenied = await request("/admin/queues", { method: "GET" }, ownerCookie);
    assert(dashboardDenied.status === 403, "Authenticated non-admin must not access Bull Board");
    const dashboardAccess = await request("/api/admin/queue-dashboard-access", { method: "GET" }, ownerCookie);
    assert(dashboardAccess.status === 200 && dashboardAccess.body.authorized === false, "non-admin status endpoint should return only an authorization flag");

    const slackStatus = await request("/api/integrations/slack/status", { method: "GET" }, ownerCookie);
    assert(slackStatus.status === 200 && slackStatus.body.connected === false, "Slack status should be authenticated and disconnected by default");
    assert(!("accessToken" in slackStatus.body) && !("slackAccessTokenEncrypted" in slackStatus.body), "Slack status must never return tokens");
    if (isSlackTestNotificationEnabled(env.NODE_ENV)) {
      const testNotification = await request(
        "/api/integrations/slack/test-notification",
        { method: "POST", body: "{}" },
        ownerCookie
      );
      assert(testNotification.status === 409, "Slack test notification should require this user's active Slack connection");
    }

    const scheduled = await request(`/api/campaigns/${campaignId}/schedule`, { method: "POST" }, ownerCookie);
    assert(scheduled.status === 200 && scheduled.body.scheduledCount === 1, "Scheduling should enqueue the eligible recipient");
    assert(scheduled.body.status === "SCHEDULED", "Future campaign should become SCHEDULED");
    recipientIds = detail.body.recipients.map((recipient: { id: number }) => recipient.id);
    const replay = await request(`/api/campaigns/${campaignId}/schedule`, { method: "POST" }, ownerCookie);
    assert(replay.status === 200 && replay.body.scheduledCount === 0, "Repeated scheduling should be idempotent");

    const jobs = await Promise.all(recipientIds.map((recipientId) => emailQueue.getJob(getEmailJobId(campaignId!, recipientId))));
    assert(jobs.every(Boolean) && new Set(jobs.map((job) => job?.id)).size === 1, "Expected one deterministic job for the recipient");
    console.log("Campaign API integration tests passed.");
  } finally {
    if (campaignId !== undefined) {
      await Promise.all(recipientIds.map(async (recipientId) => {
        const job = await emailQueue.getJob(getEmailJobId(campaignId!, recipientId));
        if (job) await job.remove();
      }));
      await prisma.emailCampaign.deleteMany({ where: { id: campaignId } });
    }
    if (userIds.length > 0) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await Promise.all(sessionIds.map((sessionId) => new Promise<void>((resolve) => sessionStore.destroy(sessionId, () => resolve()))));
    if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
    await emailQueue.close();
    await closeAppSessionStores();
    await prisma.$disconnect();
    sessionStore.close();
  }
}

runCampaignApiTest().catch((error) => {
  console.error("Campaign API integration test failed.");
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") {
    console.error(error.message);
  }
  process.exitCode = 1;
});