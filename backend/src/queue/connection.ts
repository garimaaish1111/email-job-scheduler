import IORedis from "ioredis";
import { env } from "../config/env";

export const connection = new IORedis({
  host: env.REDIS_HOST,
  port: env.REDIS_PORT,
  // BullMQ uses blocking commands that stay open for seconds. ioredis would
  // otherwise give up on them after 20 retries.
  maxRetriesPerRequest: null,
});

connection.on("error", (err) => {
  console.error("[redis]", err.message);
});

export async function closeRedis(): Promise<void> {
  await connection.quit();
}
