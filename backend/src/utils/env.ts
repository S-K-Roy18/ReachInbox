// backend/src/utils/env.ts
import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

const optionalEnvironmentString = z.preprocess(
  (value) => value === "" ? undefined : value,
  z.string().min(1).optional()
);

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
  SLACK_CLIENT_ID: optionalEnvironmentString,
  SLACK_CLIENT_SECRET: optionalEnvironmentString,
  SLACK_REDIRECT_URI: z.preprocess((value) => value === "" ? undefined : value, z.string().url().optional()),
  SLACK_FRONTEND_REDIRECT_URL: z.preprocess((value) => value === "" ? undefined : value, z.string().url().optional()),
  SLACK_TOKEN_ENCRYPTION_KEY: z.preprocess(
    (value) => value === "" ? undefined : value,
    z.string().regex(/^[a-fA-F0-9]{64}$/).optional()
  ),
  ELASTICSEARCH_URL: z.preprocess((value) => value === "" ? undefined : value, z.string().url().optional()),
  ELASTICSEARCH_API_KEY: optionalEnvironmentString,
  BULL_BOARD_ADMIN_EMAILS: optionalEnvironmentString,
}).superRefine((value, context) => {
  if (Boolean(value.ETHEREAL_USER) !== Boolean(value.ETHEREAL_PASS)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "ETHEREAL_USER and ETHEREAL_PASS must both be configured.",
    });
  }

  const slackSettings = [
    value.SLACK_CLIENT_ID,
    value.SLACK_CLIENT_SECRET,
    value.SLACK_REDIRECT_URI,
    value.SLACK_FRONTEND_REDIRECT_URL,
    value.SLACK_TOKEN_ENCRYPTION_KEY,
  ];
  if (slackSettings.some(Boolean) && !slackSettings.every(Boolean)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "All Slack OAuth, redirect, and token-encryption settings must be configured together.",
    });
  }
});

export const env = EnvSchema.parse(process.env);
