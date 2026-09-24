"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Papa from "papaparse";
import { ArrowLeft, Upload, Clock, Paperclip } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { RecipientChips } from "@/components/RecipientChips";
import {
  defaultStartTimeLocal,
  extractEmailsFromText,
  toIsoFromLocalInput,
} from "@/lib/utils";
import type { CreateCampaignResponse } from "@/types";

export default function ComposePage() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);

  const [recipients, setRecipients] = useState<string[]>([]);
  const [manualEntry, setManualEntry] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [delaySeconds, setDelaySeconds] = useState("2");
  const [hourlyLimit, setHourlyLimit] = useState("50");
  const [startTime, setStartTime] = useState("");
  const [showSchedule, setShowSchedule] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Set client side. Doing it in useState would run Date.now() during SSR too and
  // the two clocks can land on different minutes, which trips hydration.
  useEffect(() => {
    setStartTime(defaultStartTimeLocal(5));
  }, []);

  useEffect(() => {
    if (!authLoading && !user) router.replace("/");
  }, [authLoading, user, router]);

  if (authLoading || !user) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-white text-ink-faint">
        <Spinner size={24} />
      </div>
    );
  }

  const handleFile = (file: File) => {
    setParsing(true);
    Papa.parse(file, {
      complete: (result) => {
        const flat = (result.data as unknown[])
          .flat()
          .map((c) => String(c))
          .join("\n");
        const found = extractEmailsFromText(flat);

        setRecipients((prev) => Array.from(new Set([...prev, ...found])));
        setParsing(false);

        if (found.length === 0) {
          toast("error", "No email addresses found in that file.");
        } else {
          toast("success", `${found.length} email addresses detected.`);
        }
      },
      error: () => {
        setParsing(false);
        toast("error", "Could not read that file.");
      },
    });
  };

  const addManual = () => {
    const found = extractEmailsFromText(manualEntry);
    if (found.length === 0) {
      toast("error", "That does not look like an email address.");
      return;
    }
    setRecipients((prev) => Array.from(new Set([...prev, ...found])));
    setManualEntry("");
  };

  const submit = async () => {
    if (recipients.length === 0) return toast("error", "Add at least one recipient.");
    if (!subject.trim()) return toast("error", "Subject is required.");
    if (!body.trim()) return toast("error", "Body is required.");
    if (!startTime) return toast("error", "Pick a start time.");

    setSubmitting(true);
    try {
      const res = await api.post<CreateCampaignResponse>("/api/campaigns", {
        subject: subject.trim(),
        body: body.trim(),
        startTime: toIsoFromLocalInput(startTime),
        delayBetweenMs: Math.max(0, Number(delaySeconds) || 0) * 1000,
        hourlyLimit: Math.max(1, Number(hourlyLimit) || 1),
        recipients,
      });
      toast(
        "success",
        `${res.totalRecipients} emails scheduled, ${res.spacingMs / 1000}s apart.`
      );
      router.push("/dashboard");
    } catch (err) {
      toast("error", err instanceof Error ? err.message : "Failed to schedule.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-white">
      <header className="flex items-center gap-3 px-6 py-5">
        <button
          onClick={() => router.push("/dashboard")}
          className="text-ink transition-colors hover:text-ink-soft"
          aria-label="Back"
        >
          <ArrowLeft size={20} />
        </button>
        <h1 className="flex-1 text-lg text-ink">Compose New Email</h1>

        <span className="text-ink-faint">
          <Paperclip size={17} />
        </span>

        <div className="relative">
          <button
            onClick={() => setShowSchedule((s) => !s)}
            className="p-1 text-ink-faint transition-colors hover:text-ink"
            aria-label="Schedule"
          >
            <Clock size={17} />
          </button>

          {showSchedule && (
            <div className="absolute right-0 top-full z-20 mt-2 w-[280px] rounded-xl border border-line bg-white p-4 shadow-xl">
              <p className="mb-3 text-sm font-medium text-ink">Send Later</p>
              <input
                type="datetime-local"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
                className="w-full border-b border-line pb-2 text-sm text-ink"
              />
              <div className="mt-3 flex flex-col gap-1">
                {[
                  ["Start now", 0],
                  ["In 1 minute", 1],
                  ["In 5 minutes", 5],
                  ["In 1 hour", 60],
                  ["Tomorrow, 10:00 AM", -1],
                ].map(([label, mins]) => (
                  <button
                    key={label as string}
                    onClick={() => {
                      if (mins === -1) {
                        const d = new Date();
                        d.setDate(d.getDate() + 1);
                        d.setHours(10, 0, 0, 0);
                        const pad = (n: number) => String(n).padStart(2, "0");
                        setStartTime(
                          `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T10:00`
                        );
                      } else {
                        setStartTime(defaultStartTimeLocal(mins as number));
                      }
                    }}
                    className="rounded px-2 py-1.5 text-left text-sm text-ink-soft hover:bg-surface-muted"
                  >
                    {label as string}
                  </button>
                ))}
              </div>
              <div className="mt-3 flex justify-end gap-2">
                <button
                  onClick={() => setShowSchedule(false)}
                  className="px-3 py-1.5 text-sm text-ink-soft"
                >
                  Cancel
                </button>
                <Button size="sm" variant="outline" onClick={() => setShowSchedule(false)}>
                  Done
                </Button>
              </div>
            </div>
          )}
        </div>

        <Button variant="outline" size="sm" loading={submitting} onClick={submit}>
          Send Later
        </Button>
      </header>

      <div className="px-6 pb-16">
        <Row label="From">
          <span className="inline-flex items-center rounded-lg bg-surface-muted px-3 py-2 text-sm text-ink">
            3 Ethereal senders, assigned round robin
          </span>
        </Row>

        <Row label="To">
          <div className="flex flex-1 items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <RecipientChips
                recipients={recipients}
                onRemove={(email) =>
                  setRecipients((prev) => prev.filter((r) => r !== email))
                }
              />
              <div className="mt-2 flex items-center gap-2">
                <input
                  value={manualEntry}
                  onChange={(e) => setManualEntry(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === ",") {
                      e.preventDefault();
                      addManual();
                    }
                  }}
                  placeholder="Type an address and press Enter"
                  className="flex-1 bg-transparent py-1 text-sm text-ink"
                />
              </div>
              {recipients.length > 0 && (
                <p className="mt-1 text-xs text-brand">
                  {recipients.length} email address
                  {recipients.length === 1 ? "" : "es"} detected
                </p>
              )}
            </div>

            <button
              onClick={() => fileRef.current?.click()}
              className="flex shrink-0 items-center gap-1.5 text-sm text-brand"
            >
              {parsing ? <Spinner size={14} /> : <Upload size={14} />}
              Upload List
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.txt,text/csv,text/plain"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleFile(file);
                e.target.value = "";
              }}
            />
          </div>
        </Row>

        <Row label="Subject">
          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Subject"
            className="flex-1 bg-transparent py-1 text-sm text-ink"
          />
        </Row>

        <div className="flex items-center gap-6 border-b border-line py-4">
          <div className="flex items-center gap-3">
            <span className="text-sm text-ink">Delay between 2 emails</span>
            <input
              value={delaySeconds}
              onChange={(e) => setDelaySeconds(e.target.value.replace(/\D/g, ""))}
              placeholder="00"
              className="w-16 rounded-md border border-line px-3 py-1.5 text-center text-sm text-ink"
            />
            <span className="text-xs text-ink-faint">sec</span>
          </div>

          <div className="flex items-center gap-3">
            <span className="text-sm text-ink">Hourly Limit</span>
            <input
              value={hourlyLimit}
              onChange={(e) => setHourlyLimit(e.target.value.replace(/\D/g, ""))}
              placeholder="00"
              className="w-16 rounded-md border border-line px-3 py-1.5 text-center text-sm text-ink"
            />
          </div>

          {startTime && (
            <div className="flex items-center gap-2 text-sm text-ink-soft">
              <Clock size={14} className="text-ink-faint" />
              Starts {new Date(startTime).toLocaleString()}
            </div>
          )}
        </div>

        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Type Your Reply..."
          rows={16}
          className="mt-5 w-full resize-none rounded-lg bg-surface-muted p-5 text-sm text-ink"
        />
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-6 border-b border-line py-4">
      <span className="w-16 shrink-0 pt-1.5 text-sm text-ink-soft">{label}</span>
      <div className="flex min-w-0 flex-1 items-start">{children}</div>
    </div>
  );
}
