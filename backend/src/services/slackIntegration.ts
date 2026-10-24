import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "crypto";
import { z } from "zod";
import { env } from "../utils/env";
import { prisma } from "../utils/prisma";

const SLACK_AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize";
const SLACK_TOKEN_URL = "https://slack.com/api/oauth.v2.access";
const SLACK_MESSAGE_URL = "https://slack.com/api/chat.postMessage";
const SLACK_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export interface SlackOAuthState {
  value: string;
  userId: number;
  createdAt: number;
}

export interface SlackConnectionStatus {
  connected: boolean;
  teamId: string | null;
  connectedAt: Date | null;
}

export interface SlackAuthorization {
  accessToken: string;
  slackUserId: string;
  teamId: string;
}

export type SlackFailureStage = "configuration" | "oauth" | "notification";

export class SlackIntegrationError extends Error {
  constructor(readonly stage: SlackFailureStage, readonly code: string) {
    super(`Slack ${stage} failed (${code}).`);
    this.name = "SlackIntegrationError";
  }
}

const slackOAuthResponseSchema = z.object({
  ok: z.literal(true),
  access_token: z.string().min(1),
  scope: z.string(),
  authed_user: z.object({ id: z.string().min(1) }),
  team: z.object({ id: z.string().min(1) }),
});

const slackMessageResponseSchema = z.object({ ok: z.literal(true) });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isSlackConfigured(): boolean {
  return Boolean(
    env.SLACK_CLIENT_ID &&
      env.SLACK_CLIENT_SECRET &&
      env.SLACK_REDIRECT_URI &&
      env.SLACK_FRONTEND_REDIRECT_URL &&
      env.SLACK_TOKEN_ENCRYPTION_KEY
  );
}

function requireSlackConfiguration(): void {
  if (!isSlackConfigured()) throw new SlackIntegrationError("configuration", "NOT_CONFIGURED");
}

export function createSlackOAuthStateValue(): string {
  return randomBytes(32).toString("base64url");
}

export function isValidSlackOAuthState(
  expected: SlackOAuthState | undefined,
  received: string | undefined,
  userId: number,
  now = Date.now()
): boolean {
  if (!expected || !received || expected.userId !== userId) return false;
  if (!Number.isSafeInteger(expected.createdAt) || now - expected.createdAt < 0 || now - expected.createdAt > SLACK_OAUTH_STATE_TTL_MS) {
    return false;
  }
  const expectedBytes = Buffer.from(expected.value);
  const receivedBytes = Buffer.from(received);
  return expectedBytes.length === receivedBytes.length && timingSafeEqual(expectedBytes, receivedBytes);
}

export function createSlackAuthorizationUrl(state: string): string {
  requireSlackConfiguration();
  const url = new URL(SLACK_AUTHORIZE_URL);
  url.searchParams.set("client_id", env.SLACK_CLIENT_ID!);
  url.searchParams.set("scope", "chat:write");
  url.searchParams.set("redirect_uri", env.SLACK_REDIRECT_URI!);
  url.searchParams.set("state", state);
  return url.toString();
}

function getEncryptionKey(keyHex = env.SLACK_TOKEN_ENCRYPTION_KEY): Buffer {
  if (!keyHex || !/^[a-fA-F0-9]{64}$/.test(keyHex)) {
    throw new SlackIntegrationError("configuration", "ENCRYPTION_KEY_INVALID");
  }
  return Buffer.from(keyHex, "hex");
}

export function encryptSlackToken(token: string, keyHex?: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getEncryptionKey(keyHex), iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return `v1.${iv.toString("hex")}.${cipher.getAuthTag().toString("hex")}.${encrypted.toString("hex")}`;
}

export function decryptSlackToken(value: string, keyHex?: string): string {
  try {
    const [version, ivHex, tagHex, encryptedHex, extra] = value.split(".");
    if (version !== "v1" || !ivHex || !tagHex || !encryptedHex || extra) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", getEncryptionKey(keyHex), Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedHex, "hex")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new SlackIntegrationError("configuration", "TOKEN_DECRYPTION_FAILED");
  }
}

export function toSlackConnectionStatus(user: {
  slackAccessTokenEncrypted: string | null;
  slackUserId: string | null;
  slackTeamId: string | null;
  slackConnectedAt: Date | null;
}): SlackConnectionStatus {
  const connected = Boolean(user.slackAccessTokenEncrypted && user.slackUserId && user.slackTeamId);
  return {
    connected,
    teamId: connected ? user.slackTeamId : null,
    connectedAt: connected ? user.slackConnectedAt : null,
  };
}

export async function exchangeSlackAuthorizationCode(
  code: string,
  fetcher: typeof fetch = fetch
): Promise<SlackAuthorization> {
  requireSlackConfiguration();
  let response: Response;
  try {
    response = await fetcher(SLACK_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.SLACK_CLIENT_ID!,
        client_secret: env.SLACK_CLIENT_SECRET!,
        code,
        redirect_uri: env.SLACK_REDIRECT_URI!,
      }),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new SlackIntegrationError("oauth", "NETWORK_ERROR");
  }

  if (!response.ok) throw new SlackIntegrationError("oauth", "HTTP_ERROR");
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new SlackIntegrationError("oauth", "INVALID_RESPONSE");
  }
  const parsed = slackOAuthResponseSchema.safeParse(payload);
  if (!parsed.success || !parsed.data.scope.split(",").includes("chat:write")) {
    throw new SlackIntegrationError("oauth", "SLACK_REJECTED");
  }
  return {
    accessToken: parsed.data.access_token,
    slackUserId: parsed.data.authed_user.id,
    teamId: parsed.data.team.id,
  };
}

async function postSlackMessage(
  token: string,
  slackUserId: string,
  text: string,
  fetcher: typeof fetch = fetch
): Promise<void> {
  let response: Response;
  try {
    response = await fetcher(SLACK_MESSAGE_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        channel: slackUserId,
        text,
      }),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new SlackIntegrationError("notification", "NETWORK_ERROR");
  }
  if (!response.ok) throw new SlackIntegrationError("notification", "HTTP_ERROR");

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new SlackIntegrationError("notification", "INVALID_RESPONSE");
  }
  if (!slackMessageResponseSchema.safeParse(payload).success) {
    throw new SlackIntegrationError("notification", "SLACK_REJECTED");
  }
}

export function postSlackHourlyLimitNotification(
  token: string,
  slackUserId: string,
  campaignId: number,
  hourlyLimit: number,
  fetcher: typeof fetch = fetch
): Promise<void> {
  return postSlackMessage(
    token,
    slackUserId,
    `Campaign ${campaignId} reached its rolling hourly limit of ${hourlyLimit} emails. Remaining messages are queued until capacity is available.`,
    fetcher
  );
}

export function postSlackTestNotification(
  token: string,
  slackUserId: string,
  fetcher: typeof fetch = fetch
): Promise<void> {
  return postSlackMessage(
    token,
    slackUserId,
    "ReachInbox test notification: Slack is connected and hourly-limit notifications are enabled.",
    fetcher
  );
}

export async function sendSlackTestNotificationForUser(userId: number): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      slackAccessTokenEncrypted: true,
      slackUserId: true,
      slackTeamId: true,
    },
  });
  if (!user?.slackAccessTokenEncrypted || !user.slackUserId || !user.slackTeamId) {
    throw new SlackIntegrationError("notification", "NOT_CONNECTED");
  }

  const token = decryptSlackToken(user.slackAccessTokenEncrypted);
  await postSlackTestNotification(token, user.slackUserId);
}

export async function notifySlackCampaignRateLimit(
  userId: number,
  campaignId: number,
  hourlyLimit: number
): Promise<void> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        slackAccessTokenEncrypted: true,
        slackUserId: true,
      },
    });
    if (!user?.slackAccessTokenEncrypted || !user.slackUserId) {
      console.info("[slack] Hourly-limit notification skipped; user is not connected.");
      return;
    }

    const token = decryptSlackToken(user.slackAccessTokenEncrypted);
    await postSlackHourlyLimitNotification(token, user.slackUserId, campaignId, hourlyLimit);
    console.info(`[slack] Hourly-limit notification sent for campaign ${campaignId}.`);
  } catch (error) {
    if (error instanceof SlackIntegrationError) {
      console.warn(`[slack] Hourly-limit notification unavailable at ${error.stage} (${error.code}).`);
    } else {
      console.warn("[slack] Hourly-limit notification unavailable; rate limiting remains active.");
    }
  }
}

export function isSlackTestNotificationEnabled(nodeEnv: string): boolean {
  return nodeEnv === "development";
}