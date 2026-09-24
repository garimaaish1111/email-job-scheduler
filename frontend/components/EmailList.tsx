"use client";

import { Star, Inbox, SendHorizonal } from "lucide-react";
import type { Email } from "@/types";
import { Spinner } from "./ui/Spinner";
import { StatusPill } from "./ui/StatusPill";
import { EmptyState } from "./ui/EmptyState";
import { Button } from "./ui/Button";
import Link from "next/link";

interface EmailListProps {
  emails: Email[];
  loading: boolean;
  error: string | null;
  view: "scheduled" | "sent";
}

export function EmailList({ emails, loading, error, view }: EmailListProps) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-24 text-ink-faint">
        <Spinner size={22} />
      </div>
    );
  }

  if (error) {
    return (
      <EmptyState
        icon={Inbox}
        title="Could not load emails"
        description={error}
      />
    );
  }

  if (emails.length === 0) {
    return view === "scheduled" ? (
      <EmptyState
        icon={Inbox}
        title="No scheduled emails"
        description="Schedule a campaign and it will appear here with its send time."
        action={
          <Link href="/compose">
            <Button variant="outline">Compose</Button>
          </Link>
        }
      />
    ) : (
      <EmptyState
        icon={SendHorizonal}
        title="No sent emails yet"
        description="Once the worker sends a scheduled email it will show up here."
      />
    );
  }

  return (
    <ul>
      {emails.map((email) => (
        <EmailRow key={email.id} email={email} />
      ))}
    </ul>
  );
}

function EmailRow({ email }: { email: Email }) {
  const recipientName = email.recipientEmail.split("@")[0] ?? email.recipientEmail;

  const body = (
    <li className="flex items-center gap-4 border-b border-line px-6 py-4 transition-colors hover:bg-surface-muted/50">
      <span className="w-[150px] shrink-0 truncate text-sm text-ink" title={email.recipientEmail}>
        To: {recipientName}
      </span>

      <StatusPill
        status={email.status}
        scheduledAt={email.scheduledAt}
        sentAt={email.sentAt}
      />

      <span className="min-w-0 flex-1 truncate text-sm">
        <span className="font-semibold text-ink">{email.subject}</span>
        <span className="text-ink-faint"> - {email.body}</span>
      </span>

      {email.status === "FAILED" && email.errorMessage && (
        <span className="max-w-[220px] shrink-0 truncate text-xs text-danger-ink" title={email.errorMessage}>
          {email.errorMessage}
        </span>
      )}

      <Star size={16} className="shrink-0 text-ink-faint" />
    </li>
  );

  if (email.previewUrl) {
    return (
      <a href={email.previewUrl} target="_blank" rel="noreferrer" className="block">
        {body}
      </a>
    );
  }

  return body;
}
