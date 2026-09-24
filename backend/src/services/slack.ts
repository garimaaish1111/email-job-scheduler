import { claimHourlyNotification } from "./rateLimiter";

export async function notifyRateLimitReached(params: {
  webhookUrl: string | null;
  senderId: string;
  senderEmail: string;
  scope: "global" | "sender";
  resumesAt: Date;
}): Promise<"sent" | "no-webhook" | "already-notified" | "failed"> {
  if (!params.webhookUrl) return "no-webhook";

  const first = await claimHourlyNotification(
    params.scope === "global" ? "global" : params.senderId
  );
  if (!first) return "already-notified";

  const scopeLabel =
    params.scope === "global"
      ? "Global hourly send limit reached"
      : `Hourly limit reached for ${params.senderEmail}`;

  const text = `${scopeLabel}. Remaining emails have been deferred to the next hour window, resuming around ${params.resumesAt.toLocaleTimeString()}. No emails were dropped.`;

  try {
    const res = await fetch(params.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      console.error(`[slack] webhook responded ${res.status}`);
      return "failed";
    }
    return "sent";
  } catch (err) {
    console.error("[slack] notification failed", err);
    return "failed";
  }
}
