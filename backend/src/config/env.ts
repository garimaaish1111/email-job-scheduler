import "dotenv/config";
import { z } from "zod";

// Parsed once at boot so a missing or malformed variable crashes immediately and
// names itself, instead of arriving as undefined somewhere deep in the worker.
// Nothing else in the codebase should read process.env directly.
const schema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  FRONTEND_URL: z.string().url(),

  DATABASE_URL: z.string().min(1),
  REDIS_HOST: z.string().min(1),
  REDIS_PORT: z.coerce.number().int().positive(),
  ELASTICSEARCH_NODE: z.string().url(),

  JWT_SECRET: z.string().min(16),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  GOOGLE_CALLBACK_URL: z.string().url(),

  SLACK_CLIENT_ID: z.string().optional(),
  SLACK_CLIENT_SECRET: z.string().optional(),
  SLACK_REDIRECT_URI: z.string().optional(),

  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(5),
  MIN_DELAY_BETWEEN_EMAILS_MS: z.coerce.number().int().nonnegative().default(2000),
  MAX_EMAILS_PER_HOUR_PER_SENDER: z.coerce.number().int().positive().default(50),
  MAX_EMAILS_PER_HOUR_GLOBAL: z.coerce.number().int().positive().default(200),
  STALLED_SENDING_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),

  SMTP_HOST: z.string().min(1),
  SMTP_PORT: z.coerce.number().int().positive(),

  SENDER_1_NAME: z.string().min(1),
  SENDER_1_USER: z.string().email(),
  SENDER_1_PASS: z.string().min(1),
  SENDER_2_NAME: z.string().min(1),
  SENDER_2_USER: z.string().email(),
  SENDER_2_PASS: z.string().min(1),
  SENDER_3_NAME: z.string().min(1),
  SENDER_3_USER: z.string().email(),
  SENDER_3_PASS: z.string().min(1),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables:");
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;

export const SENDERS = [
  { name: env.SENDER_1_NAME, user: env.SENDER_1_USER, pass: env.SENDER_1_PASS },
  { name: env.SENDER_2_NAME, user: env.SENDER_2_USER, pass: env.SENDER_2_PASS },
  { name: env.SENDER_3_NAME, user: env.SENDER_3_USER, pass: env.SENDER_3_PASS },
] as const;

export const isSlackConfigured = Boolean(
  env.SLACK_CLIENT_ID && env.SLACK_CLIENT_SECRET && env.SLACK_REDIRECT_URI
);
