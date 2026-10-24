import { Request, Response, Router } from "express";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import { emailQueue, EmailJobData } from "../queues/emailQueue";
import { env } from "../utils/env";
import { ensureAuthenticated } from "./auth";

export function parseBullBoardAdminEmails(value = env.BULL_BOARD_ADMIN_EMAILS): Set<string> {
  return new Set((value ?? "").split(",").map((email) => email.trim().toLowerCase()).filter(Boolean));
}

export function isBullBoardAdmin(email: string | undefined, admins = parseBullBoardAdminEmails()): boolean {
  return Boolean(email && admins.has(email.trim().toLowerCase()));
}

export function sanitizeBullBoardJobData(data: unknown): Partial<EmailJobData> {
  if (typeof data !== "object" || data === null) return {};
  const value = data as Record<string, unknown>;
  return {
    ...(typeof value.campaignId === "number" ? { campaignId: value.campaignId } : {}),
    ...(typeof value.recipientId === "number" ? { recipientId: value.recipientId } : {}),
  };
}

export function sanitizeBullBoardResponse(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeBullBoardResponse);
  if (!value || typeof value !== "object") return value;

  const safe: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "data") {
      safe.data = sanitizeBullBoardJobData(entry);
      continue;
    }
    if (["returnValue", "returnvalue"].includes(key)) continue;
    safe[key] = sanitizeBullBoardResponse(entry);
  }
  return safe;
}

const queueAdapter = new BullMQAdapter(emailQueue, {
  displayName: "Email dispatch",
  description: "ReachInbox email delivery queue (read-only)",
  readOnlyMode: true,
  allowRetries: false,
});
queueAdapter.setFormatter("data", sanitizeBullBoardJobData);
queueAdapter.setFormatter("returnValue", () => undefined);

const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath("/admin/queues");

createBullBoard({
  queues: [queueAdapter],
  serverAdapter,
  options: {
    uiConfig: {
      boardTitle: "ReachInbox Queue Monitor",
      hideDocsLink: true,
      hideRedisDetails: true,
      showWorkers: true,
    },
    handlerHooks: {
      before: ({ method }) => {
        if (["post", "put", "patch", "delete"].includes(method.toLowerCase())) {
          return { allow: false, status: 405, message: "Queue dashboard is read-only." };
        }
      },
      after: (_context, result) => {
        if (result && typeof result === "object" && "body" in result) {
          return { ...result, body: sanitizeBullBoardResponse(result.body) as typeof result.body };
        }
        return result;
      },
    },
  },
});

const router = Router();
router.use(ensureAuthenticated);
router.use((req: Request, res: Response, next) => {
  const email = (req.user as { email?: unknown } | undefined)?.email;
  if (typeof email !== "string" || !isBullBoardAdmin(email)) {
    return res.status(403).json({ error: "Queue dashboard access denied." });
  }
  return next();
});
router.use(serverAdapter.getRouter());

export default router;