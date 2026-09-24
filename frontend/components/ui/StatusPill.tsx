import { Clock, Send, AlertTriangle, Timer, Loader } from "lucide-react";
import type { EmailStatus } from "@/types";
import { cn, formatDateTime } from "@/lib/utils";

interface StatusPillProps {
  status: EmailStatus;
  scheduledAt?: string;
  sentAt?: string | null;
}

const ICONS = {
  SCHEDULED: Clock,
  SENDING: Loader,
  SENT: Send,
  FAILED: AlertTriangle,
  RATE_LIMITED: Timer,
} as const;

const STYLES: Record<EmailStatus, string> = {
  SCHEDULED: "bg-amber-soft text-amber-ink",
  SENDING: "bg-brand-soft text-brand",
  SENT: "bg-surface-muted text-ink-soft",
  FAILED: "bg-danger-soft text-danger-ink",
  RATE_LIMITED: "bg-amber-soft text-amber-ink",
};

function pillLabel(props: StatusPillProps): string {
  switch (props.status) {
    case "SCHEDULED":
      return formatDateTime(props.scheduledAt ?? null);
    case "SENDING":
      return "Sending";
    case "SENT":
      return "Sent";
    case "FAILED":
      return "Failed";
    case "RATE_LIMITED":
      return "Rate limited";
  }
}

export function StatusPill(props: StatusPillProps) {
  const Icon = ICONS[props.status];

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium whitespace-nowrap",
        STYLES[props.status]
      )}
    >
      <Icon size={12} className={props.status === "SENDING" ? "animate-spin" : ""} />
      {pillLabel(props)}
    </span>
  );
}
