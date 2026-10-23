// backend/src/routes/auth.ts
import { Router, Request, Response, NextFunction } from "express";
import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import { env } from "../utils/env";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const router = Router();

// ---------- Passport configuration ----------
passport.use(
  new GoogleStrategy(
    {
      clientID: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      callbackURL: env.GOOGLE_CALLBACK_URL,
      passReqToCallback: true,
    },
    async (req, accessToken, refreshToken, profile, done) => {
      // Verify Google profile and upsert user
      try {
        const user = await prisma.user.upsert({
          where: { googleId: profile.id },
          update: {
            email: profile.emails?.[0].value ?? "",
            name: profile.displayName,
            avatarUrl: profile.photos?.[0].value,
          },
          create: {
            googleId: profile.id,
            email: profile.emails?.[0].value ?? "",
            name: profile.displayName,
            avatarUrl: profile.photos?.[0].value,
          },
        });
        return done(null, user);
      } catch (err) {
        return done(err as any, null);
      }
    }
  )
);

passport.serializeUser((user: any, done) => {
  done(null, user.id);
});
passport.deserializeUser(async (id: number, done) => {
  try {
    const user = await prisma.user.findUnique({ where: { id } });
    done(null, user);
  } catch (err) {
    done(err as any, null);
  }
});

// ---------- Helpers ----------
function ensureAuthenticated(req: Request, res: Response, next: NextFunction) {
  // @ts-ignore – added by passport
  if (req.isAuthenticated && req.isAuthenticated()) {
    return next();
  }
  res.status(401).json({ error: "Unauthenticated" });
}

// ---------- Routes ----------
// Initiate Google OAuth flow – state is handled internally by passport
router.get(
  "/google",
  passport.authenticate("google", { scope: ["profile", "email"] })
);

// Google OAuth callback
router.get(
  "/google/callback",
  passport.authenticate("google", { failureRedirect: "/" }),
  (req: Request, res: Response) => {
    // Regenerate session to avoid fixation attacks
    req.session.regenerate(() => {
      // @ts-ignore – session typing
      req.session.userId = (req.user as any).id;
      // Redirect to frontend protected page
      const redirectUrl = `${env.FRONTEND_URL}/dashboard`;
      res.redirect(redirectUrl);
    });
  }
);

// Return currently logged‑in user (safe fields only)
router.get("/me", ensureAuthenticated, async (req: Request, res: Response) => {
  // @ts-ignore – session typing
  const userId = req.session?.userId as number;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true, avatarUrl: true },
  });
  if (!user) {
    return res.status(401).json({ error: "Unauthenticated" });
  }
  res.json(user);
});

// Logout – destroy session & clear cookie
router.post("/logout", (req: Request, res: Response) => {
  req.logout(() => {});
  req.session.destroy(() => {
    // Clear the cookie (default name is connect.sid)
    res.clearCookie("connect.sid");
    res.json({ success: true });
  });
});

export default router;
