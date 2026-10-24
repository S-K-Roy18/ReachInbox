import express from "express";
import cors from "cors";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import passport from "passport";
import { env } from "./utils/env";
import authRouter from "./routes/auth";
import { errorHandler } from "./middleware/errorHandler";

const PgStore = connectPgSimple(session);

export const createApp = () => {
  const app = express();

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
      store: new PgStore({
        conString: env.DATABASE_URL,
        createTableIfMissing: true,
      }),
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

  // 404 handler
  app.use((_req, res) => {
    res.status(404).json({ error: "Not Found" });
  });

  // Central error handling
  app.use(errorHandler);

  return app;
};
