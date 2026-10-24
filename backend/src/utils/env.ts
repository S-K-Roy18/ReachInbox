// backend/src/utils/env.ts
import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

const EnvSchema = z.object({
  PORT: z.string().default("4000"),
  DATABASE_URL: z.string().url(),
  FRONTEND_URL: z.string().url(),
  GOOGLE_CLIENT_ID: z.string(),
  GOOGLE_CLIENT_SECRET: z.string(),
  GOOGLE_CALLBACK_URL: z.string().url(),
  SESSION_SECRET: z.string(),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  REDIS_HOST: z.string().default("localhost"),
  REDIS_PORT: z.string().default("6379"),
  ETHEREAL_USER: z.string().min(1).optional(),
  ETHEREAL_PASS: z.string().min(1).optional(),
}).superRefine((value, context) => {
  if (Boolean(value.ETHEREAL_USER) !== Boolean(value.ETHEREAL_PASS)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "ETHEREAL_USER and ETHEREAL_PASS must both be configured.",
    });
  }
});

export const env = EnvSchema.parse(process.env);
