import { randomUUID } from "node:crypto";
import { createServer, Server } from "node:http";

async function runBullBoardTest(): Promise<void> {
  const testEmail = `queue-admin-${randomUUID()}@example.invalid`;
  process.env.BULL_BOARD_ADMIN_EMAILS = testEmail;

  const [{ env }, { prisma }, { createApp }, { emailQueue }] = await Promise.all([
    import("./src/utils/env"),
    import("./src/utils/prisma"),
    import("./src/app"),
    import("./src/queues/emailQueue"),
  ]);
  const connectPgSimple = require("connect-pg-simple") as (session: unknown) => new (options: object) => {
    set(sid: string, value: object, callback: (error?: Error | null) => void): void;
    destroy(sid: string, callback: (error?: Error | null) => void): void;
    close(): void;
  };
  const session = require("express-session") as unknown;
  const cookieSignature = require("cookie-signature") as { sign(value: string, secret: string): string };
  const Store = connectPgSimple(session);
  const store = new Store({ conString: env.DATABASE_URL, createTableIfMissing: true, pruneSessionInterval: false });
  const testId = randomUUID();
  const sessionId = `bull-board-test-${testId}`;
  let userId: number | undefined;
  let server: Server | undefined;

  try {
    const user = await prisma.user.create({
      data: {
        googleId: `bull-board-test-${testId}`,
        email: testEmail,
      },
    });
    userId = user.id;
    await new Promise<void>((resolve, reject) => {
      store.set(sessionId, {
        cookie: { originalMaxAge: null, expires: null, secure: false, httpOnly: true, path: "/", sameSite: "lax" },
        passport: { user: user.id },
      }, (error) => error ? reject(error) : resolve());
    });

    server = createServer(createApp());
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Dashboard test server failed to bind");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const cookie = `connect.sid=${encodeURIComponent(`s:${cookieSignature.sign(sessionId, env.SESSION_SECRET)}`)}`;

    const unauthorized = await fetch(`${baseUrl}/admin/queues`);
    if (unauthorized.status !== 401) throw new Error("Unauthenticated dashboard request was not rejected");

    const dashboard = await fetch(`${baseUrl}/admin/queues`, { headers: { cookie } });
    const contentType = dashboard.headers.get("content-type") ?? "";
    if (dashboard.status !== 200 || !contentType.includes("text/html")) {
      throw new Error("Allowlisted admin could not load Bull Board UI");
    }

    const queueResponse = await fetch(
      `${baseUrl}/admin/queues/api/queues?activeQueue=email-dispatch&status=failed&page=1&jobsPerPage=10`,
      { headers: { cookie } }
    );
    const queuePayload = await queueResponse.json() as { queues?: Array<{ name?: string; statuses?: string[] }> };
    const emailQueueStatus = queuePayload.queues?.find((queue) => queue.name === "email-dispatch");
    if (queueResponse.status !== 200 || !emailQueueStatus?.statuses?.includes("failed") || !emailQueueStatus.statuses.includes("delayed")) {
      throw new Error("Dashboard did not return failed/delayed queue status metadata");
    }

    const mutation = await fetch(`${baseUrl}/admin/queues/api/queues/pause`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: "{}",
    });
    if (mutation.status !== 405) throw new Error("Queue dashboard mutation was not rejected as read-only");

    console.log("Bull Board tests passed: admin UI, queue status API, authentication, and read-only behavior.");
  } finally {
    await new Promise<void>((resolve) => store.destroy(sessionId, () => resolve()));
    if (userId !== undefined) await prisma.user.deleteMany({ where: { id: userId } });
    if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
    await emailQueue.close();
    await prisma.$disconnect();
    store.close();
  }
}

runBullBoardTest().catch((error) => {
  console.error("Bull Board tests failed.");
  if (error instanceof Error) console.error(error.message);
  process.exitCode = 1;
});