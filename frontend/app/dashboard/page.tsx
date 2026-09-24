"use client";

import { useEffect, useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Search, SlidersHorizontal, RotateCw } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { useEmails, useStats } from "@/hooks/useEmails";
import { Sidebar } from "@/components/Sidebar";
import { EmailList } from "@/components/EmailList";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { api } from "@/lib/api";
import type { Email, SearchResponse } from "@/types";

const SLACK_MESSAGES: Record<string, [("success" | "error" | "info"), string]> = {
  connected: ["success", "Slack connected. Rate limit alerts will post to your channel."],
  denied: ["info", "Slack connection cancelled."],
  invalid_state: ["error", "Slack connection expired. Try again."],
  failed: ["error", "Slack rejected the connection. Check the app configuration."],
};

function DashboardContent() {
  const router = useRouter();
  const params = useSearchParams();
  const { user, loading: authLoading, refresh, logout } = useAuth();
  const { toast } = useToast();

  const [view, setView] = useState<"scheduled" | "sent">("scheduled");
  const [query, setQuery] = useState("");
  const [searchHits, setSearchHits] = useState<Email[] | null>(null);
  const [searching, setSearching] = useState(false);

  const { emails, loading, error, refresh: refreshEmails } = useEmails(view);
  const { stats } = useStats();

  useEffect(() => {
    const slack = params.get("slack");
    if (!slack) return;
    const entry = SLACK_MESSAGES[slack];
    if (entry) toast(entry[0], entry[1]);
    void refresh();
    router.replace("/dashboard");
  }, [params, toast, refresh, router]);

  useEffect(() => {
    if (!authLoading && !user) router.replace("/");
  }, [authLoading, user, router]);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setSearchHits(null);
      return;
    }
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const res = await api.get<SearchResponse>(
          `/api/emails/search?q=${encodeURIComponent(q)}`
        );
        if (!res.searchAvailable) {
          toast("info", "Search is unavailable. Showing the full list.");
          setSearchHits(null);
          return;
        }
        setSearchHits(
          res.hits.map((h) => ({
            id: h.emailId,
            recipientEmail: h.recipientEmail,
            subject: h.subject,
            body: "",
            status: h.status,
            scheduledAt: h.scheduledAt,
            sentAt: h.sentAt,
            attempts: 0,
            errorMessage: null,
            previewUrl: null,
            sender: { name: h.senderEmail, email: h.senderEmail },
          }))
        );
      } catch {
        toast("error", "Search failed.");
      } finally {
        setSearching(false);
      }
    }, 350);

    return () => clearTimeout(timer);
  }, [query, toast]);

  if (authLoading || !user) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-white text-ink-faint">
        <Spinner size={24} />
      </div>
    );
  }

  const visible = searchHits ?? emails;

  return (
    <div className="flex h-screen overflow-hidden bg-white">
      <Sidebar
        user={user}
        view={view}
        onViewChange={(v) => {
          setView(v);
          setQuery("");
        }}
        stats={stats}
        onLogout={async () => {
          await logout();
          router.replace("/");
        }}
      />

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex shrink-0 items-center gap-3 px-6 py-4">
          <div className="relative flex-1">
            <Search
              size={15}
              className="absolute left-4 top-1/2 -translate-y-1/2 text-ink-faint"
            />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search"
              className="w-full rounded-full bg-surface-muted py-2.5 pl-11 pr-4 text-sm text-ink"
            />
            {searching && (
              <Spinner
                size={14}
                className="absolute right-4 top-1/2 -translate-y-1/2 text-ink-faint"
              />
            )}
          </div>
          <button
            className="p-2 text-ink-faint transition-colors hover:text-ink"
            title="Filter"
          >
            <SlidersHorizontal size={16} />
          </button>
          <button
            onClick={() => void refreshEmails()}
            className="p-2 text-ink-faint transition-colors hover:text-ink"
            title="Refresh"
          >
            <RotateCw size={16} />
          </button>
        </div>

        {searchHits !== null && (
          <p className="px-6 pb-2 text-xs text-ink-faint">
            {searchHits.length} result{searchHits.length === 1 ? "" : "s"} for
            &quot;{query}&quot;
          </p>
        )}

        <div className="flex-1 overflow-y-auto border-t border-line">
          <EmailList
            emails={visible}
            loading={loading && searchHits === null}
            error={error}
            view={view}
          />
        </div>
      </main>
    </div>
  );
}

export default function DashboardPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-white text-ink-faint">
          <Spinner size={24} />
        </div>
      }
    >
      <DashboardContent />
    </Suspense>
  );
}
