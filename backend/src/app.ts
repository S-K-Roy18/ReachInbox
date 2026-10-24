import express from "express";
import cors from "cors";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import passport from "passport";
import { env } from "./utils/env";
import authRouter from "./routes/auth";
import campaignRouter from "./routes/campaigns";
import slackRouter from "./routes/slack";
import searchRouter from "./routes/search";
import queueDashboardRouter, { queueDashboardAccessRouter } from "./routes/queueDashboard";
import { errorHandler } from "./middleware/errorHandler";

const PgStore = connectPgSimple(session);
const sessionStores = new Set<{ close(): Promise<void> | void }>();

export async function closeAppSessionStores(): Promise<void> {
  const stores = [...sessionStores];
  sessionStores.clear();
  await Promise.all(stores.map((store) => store.close()));
}

export const createApp = () => {
  const app = express();
  const sessionStore = new PgStore({
    conString: env.DATABASE_URL,
    createTableIfMissing: true,
  });
  sessionStores.add(sessionStore);

  // CORS – allow frontend origin with credentials
  app.use(
    cors({
      origin: env.FRONTEND_URL,
      credentials: true,
    })
  );

  app.use(express.json());

  // Session middleware backed by PostgreSQL
  app.use(
    session({
      store: sessionStore,
      secret: env.SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        secure: env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: 1000 * 60 * 60 * 24, // 1 day
      },
    })
  );

  // Initialise Passport
  app.use(passport.initialize());
  app.use(passport.session());

  // Health endpoint
  app.get("/api/health", (req, res) => res.json({ status: "ok" }));

  // Auth routes
  app.use("/api/auth", authRouter);

  // Authenticated campaign routes
  app.use("/api/campaigns", campaignRouter);

  // Authenticated Slack integration routes
  app.use("/api/integrations/slack", slackRouter);

  // Authenticated search routes
  app.use("/api/search", searchRouter);

  // Allowlisted admin access only; Bull Board is read-only.
  app.use("/admin/queues", queueDashboardRouter);
  app.use("/api/admin", queueDashboardAccessRouter);

  // 404 handler
  app.use((_req, res) => {
    res.status(404).json({ error: "Not Found" });
  });

  // Central error handling
  app.use(errorHandler);

  return app;
};
