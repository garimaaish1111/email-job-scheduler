import type { EmailStatus } from "@/types";

export function cn(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return "-";
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();

  return d.toLocaleString(undefined, {
    ...(sameDay ? { weekday: "short" } : { day: "2-digit", month: "short" }),
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
}

export function formatRelative(iso: string | null): string {
  if (!iso) return "";
  const diff = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60000);
  const suffix = diff < 0 ? "ago" : "from now";

  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ${suffix}`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ${suffix}`;
  return `${Math.round(hours / 24)}d ${suffix}`;
}

// datetime-local gives "2026-09-06T18:30" with no timezone. Sending that raw puts
// every send out by the UTC offset, which looks exactly like a scheduler bug.
export function toIsoFromLocalInput(value: string): string {
  return new Date(value).toISOString();
}

export function defaultStartTimeLocal(minutesAhead = 5): string {
  const d = new Date(Date.now() + minutesAhead * 60000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const STATUS_LABEL: Record<EmailStatus, string> = {
  SCHEDULED: "Scheduled",
  SENDING: "Sending",
  SENT: "Sent",
  FAILED: "Failed",
  RATE_LIMITED: "Rate limited",
};

const EMAIL_RE = /^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$/;

export function extractEmailsFromText(raw: string): string[] {
  const cells = raw.split(/[\r\n,;\t]+/);
  const seen = new Set<string>();
  const out: string[] = [];

  for (const cell of cells) {
    const value = cell.trim().replace(/^["']|["']$/g, "").toLowerCase();
    if (!EMAIL_RE.test(value)) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }

  return out;
}
