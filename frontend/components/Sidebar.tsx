"use client";

import Link from "next/link";
import Image from "next/image";
import { useState } from "react";
import { Clock, Send, ChevronDown, LogOut, MessageSquare, LayoutGrid } from "lucide-react";
import { cn } from "@/lib/utils";
import { authUrls } from "@/lib/api";
import { Button } from "./ui/Button";
import type { EmailStats, User } from "@/types";

type View = "scheduled" | "sent";

interface SidebarProps {
  user: User;
  view: View;
  onViewChange: (view: View) => void;
  stats: EmailStats | null;
  onLogout: () => void;
}

export function Sidebar({ user, view, onViewChange, stats, onLogout }: SidebarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [avatarFailed, setAvatarFailed] = useState(false);

  const scheduledCount =
    stats === null
      ? null
      : stats.SCHEDULED + stats.SENDING + stats.RATE_LIMITED;
  const sentCount = stats === null ? null : stats.SENT + stats.FAILED;

  return (
    <aside className="flex h-full w-[240px] shrink-0 flex-col gap-4 overflow-y-auto border-r border-line bg-white px-4 py-5">
      <div className="px-2">
        <span className="font-mono text-2xl font-black tracking-tighter text-ink">
          ONB
        </span>
      </div>

      <div className="relative">
        <button
          onClick={() => setMenuOpen((o) => !o)}
          className="flex w-full items-center gap-2.5 rounded-xl bg-surface-muted px-3 py-2.5 text-left transition-colors hover:bg-line"
        >
          {user.avatarUrl && !avatarFailed ? (
            <Image
              src={user.avatarUrl}
              alt={user.name}
              width={32}
              height={32}
              className="h-8 w-8 shrink-0 rounded-full object-cover"
              // Google returns 403 for these when a referrer is sent.
              referrerPolicy="no-referrer"
              unoptimized
              onError={() => setAvatarFailed(true)}
            />
          ) : (
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand text-xs font-semibold text-white">
              {user.name.charAt(0).toUpperCase()}
            </span>
          )}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-semibold text-ink">
              {user.name}
            </span>
            <span className="block truncate text-[11px] text-ink-faint">
              {user.email}
            </span>
          </span>
          <ChevronDown size={14} className="shrink-0 text-ink-faint" />
        </button>

        {menuOpen && (
          <div className="absolute left-0 right-0 top-full z-20 mt-1 overflow-hidden rounded-xl border border-line bg-white shadow-lg">
            <a
              href={authUrls.queueDashboard}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-2 px-3 py-2.5 text-[13px] text-ink hover:bg-surface-muted"
            >
              <LayoutGrid size={14} className="text-ink-faint" />
              Queue dashboard
            </a>
            {user.slackConnected ? (
              <span className="flex items-center gap-2 px-3 py-2.5 text-[13px] text-ink-soft">
                <MessageSquare size={14} className="text-brand" />
                <span className="truncate">Slack: {user.slackChannel}</span>
              </span>
            ) : (
              <a
                href={authUrls.slackConnect}
                className="flex items-center gap-2 px-3 py-2.5 text-[13px] text-ink hover:bg-surface-muted"
              >
                <MessageSquare size={14} className="text-ink-faint" />
                Connect Slack
              </a>
            )}
            <button
              onClick={onLogout}
              className="flex w-full items-center gap-2 border-t border-line px-3 py-2.5 text-left text-[13px] text-ink hover:bg-surface-muted"
            >
              <LogOut size={14} className="text-ink-faint" />
              Logout
            </button>
          </div>
        )}
      </div>

      <Link href="/compose" className="block">
        <Button variant="outline" fullWidth>
          Compose
        </Button>
      </Link>

      <div className="mt-1">
        <p className="px-3 pb-1.5 text-[10px] font-semibold tracking-widest text-ink-faint">
          CORE
        </p>
        <nav className="flex flex-col gap-0.5">
          <NavItem
            icon={Clock}
            label="Scheduled"
            count={scheduledCount}
            active={view === "scheduled"}
            onClick={() => onViewChange("scheduled")}
          />
          <NavItem
            icon={Send}
            label="Sent"
            count={sentCount}
            active={view === "sent"}
            onClick={() => onViewChange("sent")}
          />
        </nav>
      </div>
    </aside>
  );
}

interface NavItemProps {
  icon: typeof Clock;
  label: string;
  count: number | null;
  active: boolean;
  onClick: () => void;
}

function NavItem({ icon: Icon, label, count, active, onClick }: NavItemProps) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-[13px] transition-colors",
        active
          ? "bg-brand-soft font-medium text-ink"
          : "text-ink-soft hover:bg-surface-muted"
      )}
    >
      <Icon size={15} className={active ? "text-brand" : "text-ink-faint"} />
      <span className="flex-1">{label}</span>
      {count !== null && (
        <span className="text-[11px] text-ink-faint">{count}</span>
      )}
    </button>
  );
}
