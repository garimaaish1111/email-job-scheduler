"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { Email, EmailListResponse, EmailStats, StatsResponse } from "@/types";

type View = "scheduled" | "sent";

interface UseEmailsResult {
  emails: Email[];
  total: number;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useEmails(view: View, pollMs = 5000): UseEmailsResult {
  const [emails, setEmails] = useState<Email[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await api.get<EmailListResponse>(
        `/api/emails?view=${view}&pageSize=100`
      );
      setEmails(data.emails);
      setTotal(data.total);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load emails");
    } finally {
      setLoading(false);
    }
  }, [view]);

  useEffect(() => {
    setLoading(true);
    void refresh();
    const id = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(id);
  }, [refresh, pollMs]);

  return { emails, total, loading, error, refresh };
}

export function useStats(pollMs = 5000): { stats: EmailStats | null } {
  const [stats, setStats] = useState<EmailStats | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const data = await api.get<StatsResponse>("/api/emails/stats");
        setStats(data.stats);
      } catch {
        setStats(null);
      }
    };
    void load();
    const id = setInterval(() => void load(), pollMs);
    return () => clearInterval(id);
  }, [pollMs]);

  return { stats };
}
