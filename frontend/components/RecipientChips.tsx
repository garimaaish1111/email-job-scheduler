"use client";

import { useState } from "react";
import { X } from "lucide-react";

interface RecipientChipsProps {
  recipients: string[];
  onRemove: (email: string) => void;
  maxVisible?: number;
}

export function RecipientChips({
  recipients,
  onRemove,
  maxVisible = 3,
}: RecipientChipsProps) {
  const [expanded, setExpanded] = useState(false);

  if (recipients.length === 0) {
    return <span className="text-sm text-ink-faint">recipient@example.com</span>;
  }

  const visible = expanded ? recipients : recipients.slice(0, maxVisible);
  const hidden = recipients.length - visible.length;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {visible.map((email) => (
        <span
          key={email}
          className="inline-flex items-center gap-1 rounded-full border border-brand px-2.5 py-1 text-[13px] text-ink"
        >
          {email}
          <button
            type="button"
            onClick={() => onRemove(email)}
            className="text-ink-faint transition-colors hover:text-danger-ink"
            aria-label={`Remove ${email}`}
          >
            <X size={11} />
          </button>
        </span>
      ))}

      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="rounded-full border border-brand px-2.5 py-1 text-[13px] text-brand"
        >
          +{hidden}
        </button>
      )}

      {expanded && recipients.length > maxVisible && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="text-[13px] text-ink-faint hover:text-ink"
        >
          show less
        </button>
      )}
    </div>
  );
}
