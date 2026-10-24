import { NextFunction, Request, Response, Router } from "express";
import {
  createSlackAuthorizationUrl,
  createSlackOAuthStateValue,
  encryptSlackToken,
  exchangeSlackAuthorizationCode,
  isSlackConfigured,
  isSlackTestNotificationEnabled,
  isValidSlackOAuthState,
  sendSlackTestNotificationForUser,
  SlackIntegrationError,
  SlackOAuthState,
} from "../services/slackIntegration";
import { prisma } from "../utils/prisma";
import { env } from "../utils/env";
import { ensureAuthenticated } from "./auth";

const router = Router();

type SlackSession = Request["session"] & { slackOAuthState?: SlackOAuthState };

function getAuthenticatedUserId(req: Request): number | undefined {
  const userId = (req.user as { id?: unknown } | undefined)?.id;
  return typeof userId === "number" && Number.isSafeInteger(userId) && userId > 0 ? userId : undefined;
}

function saveSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => req.session.save((error) => error ? reject(error) : resolve()));
}

function redirectToFrontend(res: Response, status: "connected" | "error"): void {
  const redirectUrl = new URL(env.SLACK_FRONTEND_REDIRECT_URL ?? env.FRONTEND_URL);
  redirectUrl.searchParams.set("slack", status);
  res.redirect(302, redirectUrl.toString());
}

router.get("/status", ensureAuthenticated, async (req: Request, res: Response) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthenticated." });

  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        slackAccessTokenEncrypted: true,
        slackUserId: true,
        slackTeamId: true,
        slackConnectedAt: true,
      },
    });
    if (!user) return res.status(401).json({ error: "Unauthenticated." });
    const connected = Boolean(user.slackAccessTokenEncrypted && user.slackUserId && user.slackTeamId);
    return res.json({
      connected,
      teamId: connected ? user.slackTeamId : null,
      connectedAt: connected ? user.slackConnectedAt : null,
    });
  } catch {
    console.error("[slack] Connection-status lookup failed.");
    return res.status(500).json({ error: "Internal server error." });
  }
});

router.get("/oauth", ensureAuthenticated, async (req: Request, res: Response) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthenticated." });
  if (!isSlackConfigured()) return res.status(503).json({ error: "Slack integration is not configured." });

  try {
    const state: SlackOAuthState = {
      value: createSlackOAuthStateValue(),
      userId,
      createdAt: Date.now(),
    };
    (req.session as SlackSession).slackOAuthState = state;
    await saveSession(req);
    return res.redirect(302, createSlackAuthorizationUrl(state.value));
  } catch {
    console.error("[slack] OAuth authorization could not be started.");
    return res.status(500).json({ error: "Unable to start Slack authorization." });
  }
});

router.get("/callback", async (req: Request, res: Response, _next: NextFunction) => {
  const slackSession = req.session as SlackSession;
  const expectedState = slackSession.slackOAuthState;
  delete slackSession.slackOAuthState;

  try {
    await saveSession(req);
  } catch {
    console.error("[slack] OAuth session could not be updated.");
    return redirectToFrontend(res, "error");
  }

  const userId = getAuthenticatedUserId(req);
  const receivedState = typeof req.query.state === "string" ? req.query.state : undefined;
  if (!userId || !isValidSlackOAuthState(expectedState, receivedState, userId)) {
    console.warn("[slack] OAuth callback rejected due to invalid or expired state.");
    return redirectToFrontend(res, "error");
  }
  if (typeof req.query.error === "string" || typeof req.query.code !== "string") {
    console.info("[slack] OAuth authorization was not completed.");
    return redirectToFrontend(res, "error");
  }

  try {
    const authorization = await exchangeSlackAuthorizationCode(req.query.code);
    const encryptedToken = encryptSlackToken(authorization.accessToken);
    await prisma.user.update({
      where: { id: userId },
      data: {
        slackAccessTokenEncrypted: encryptedToken,
        slackUserId: authorization.slackUserId,
        slackTeamId: authorization.teamId,
        slackConnectedAt: new Date(),
      },
    });
    return redirectToFrontend(res, "connected");
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error &&
      typeof error.code === "string" && /^[A-Z0-9_-]{1,32}$/.test(error.code)
        ? ` (${error.code})`
        : "";
    console.error(`[slack] OAuth callback failed${code}.`);
    return redirectToFrontend(res, "error");
  }
});

if (isSlackTestNotificationEnabled(env.NODE_ENV)) {
  router.post("/test-notification", ensureAuthenticated, async (req: Request, res: Response) => {
    const userId = getAuthenticatedUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthenticated." });

    try {
      await sendSlackTestNotificationForUser(userId);
      return res.json({ sent: true });
    } catch (error) {
      if (error instanceof SlackIntegrationError && error.code === "NOT_CONNECTED") {
        return res.status(409).json({ error: "Slack is not connected for this user." });
      }
      if (error instanceof SlackIntegrationError) {
        console.warn(`[slack] Development test notification failed (${error.code}).`);
      } else {
        console.warn("[slack] Development test notification failed.");
      }
      return res.status(502).json({ error: "Slack test notification could not be sent." });
    }
  });
}

export default router;