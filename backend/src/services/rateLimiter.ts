import { connection } from "../queue/connection";

const HOUR_MS = 3_600_000;
const WINDOW_TTL_SECONDS = 3600;

// Read, compare and increment have to be one atomic step. Doing it as GET then
// INCR lets two workers both read 199 and both decide they are under a limit of
// 200. Redis runs Lua single threaded, so nothing interleaves here.
// Both counters are only incremented once both limits pass, otherwise a sender
// rejection would leave the global count inflated.
const SCRIPT = `
local globalKey = KEYS[1]
local senderKey = KEYS[2]
local globalLimit = tonumber(ARGV[1])
local senderLimit = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])

local globalCount = tonumber(redis.call('GET', globalKey) or '0')
if globalCount >= globalLimit then
  return -1
end

local senderCount = tonumber(redis.call('GET', senderKey) or '0')
if senderCount >= senderLimit then
  return -2
end

local g = redis.call('INCR', globalKey)
if g == 1 then
  redis.call('EXPIRE', globalKey, ttl)
end

local s = redis.call('INCR', senderKey)
if s == 1 then
  redis.call('EXPIRE', senderKey, ttl)
end

return s
`;

// BullMQ's own limiter is a fixed window counter, so it allows small bursts at
// window boundaries. This reserves the next send slot instead, which gives a
// hard floor and holds across worker processes.
const SPACING_SCRIPT = `
local key = KEYS[1]
local minGapMs = tonumber(ARGV[1])
local now = tonumber(ARGV[2])

local last = tonumber(redis.call('GET', key) or '0')
local slot = now
if last + minGapMs > now then
  slot = last + minGapMs
end

redis.call('SET', key, slot, 'PX', 3600000)
return slot - now
`;

declare module "ioredis" {
  interface RedisCommander<Context> {
    rateLimitConsume(
      globalKey: string,
      senderKey: string,
      globalLimit: number,
      senderLimit: number,
      ttl: number
    ): Promise<number>;
    reserveSendSlot(
      key: string,
      minGapMs: number,
      now: number
    ): Promise<number>;
  }
}

connection.defineCommand("rateLimitConsume", {
  numberOfKeys: 2,
  lua: SCRIPT,
});

connection.defineCommand("reserveSendSlot", {
  numberOfKeys: 1,
  lua: SPACING_SCRIPT,
});

// Putting the window in the key means counters roll over on their own at the top
// of each hour and old keys expire themselves. No reset job needed.
export function currentHourWindow(at: number = Date.now()): number {
  return Math.floor(at / HOUR_MS);
}

export function msUntilNextHourWindow(at: number = Date.now()): number {
  return HOUR_MS - (at % HOUR_MS);
}

export type RateLimitOutcome =
  | { allowed: true; senderCount: number }
  | { allowed: false; reason: "global" | "sender" };

export async function consumeRateLimit(params: {
  senderId: string;
  senderLimit: number;
  globalLimit: number;
}): Promise<RateLimitOutcome> {
  const window = currentHourWindow();
  const globalKey = `ratelimit:global:${window}`;
  const senderKey = `ratelimit:sender:${params.senderId}:${window}`;

  const result = await connection.rateLimitConsume(
    globalKey,
    senderKey,
    params.globalLimit,
    params.senderLimit,
    WINDOW_TTL_SECONDS
  );

  if (result === -1) return { allowed: false, reason: "global" };
  if (result === -2) return { allowed: false, reason: "sender" };
  return { allowed: true, senderCount: result };
}

export async function waitForSendSlot(minGapMs: number): Promise<number> {
  if (minGapMs <= 0) return 0;

  const waitMs = await connection.reserveSendSlot(
    "sendslot:global",
    minGapMs,
    Date.now()
  );

  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  return waitMs;
}

// NX means only the first blocked job of the hour wins the lock, so a sender that
// blocks 200 jobs still produces one Slack message.
export async function claimHourlyNotification(senderId: string): Promise<boolean> {
  const key = `slack:notified:${senderId}:${currentHourWindow()}`;
  const set = await connection.set(key, "1", "EX", WINDOW_TTL_SECONDS, "NX");
  return set === "OK";
}
