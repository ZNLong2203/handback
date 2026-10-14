"use client";

import { BarChart3, Bot, LayoutDashboard, Moon, PencilRuler, Sun } from "lucide-react";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { LoadBoundary, reloadPage, useLoadGuard } from "@/components/load-guard";
import { cx } from "@/components/ui";
import { PAGES, type PageId } from "@/lib/insights/report";
import type { SimpleKpis } from "@/lib/insights/simple-view";
import type { StudioDataSpec } from "@/lib/insights/studio-data";
import { SimpleView } from "./simple-view";

// AG Studio touches the DOM when it loads and is large, so it is loaded in
// the browser only, for this page only. If it throws, its code fails to load,
// or it has not drawn within STUDIO_DEADLINE_MS of visible time, the page
// shows the simple view instead (simple-view.tsx), from the same data.
const Studio = dynamic(() => import("./studio"), {
  ssr: false,
  loading: () => (
    <div className="grid h-full place-items-center rounded-[var(--radius-card)] border border-line bg-card text-sm text-muted">
      <span className="flex items-center gap-2">
        <BarChart3 className="h-4 w-4 animate-pulse-soft" aria-hidden /> Loading the dashboard…
      </span>
    </div>
  ),
});

const THEME_KEY = "handback-insights-theme";
const STUDIO_DEADLINE_MS = 15_000;

export function InsightsBoard({
  spec,
  kpis,
  month,
  licenseKey,
  ai,
  forceSimple = false,
}: {
  spec: StudioDataSpec;
  kpis: SimpleKpis;
  month: string;
  licenseKey: string | null;
  ai: boolean;
  /** INSIGHTS_FORCE_SIMPLE_VIEW=1 on the server: a switch for tests. */
  forceSimple?: boolean;
}) {
  const studio = useLoadGuard(STUDIO_DEADLINE_MS, forceSimple);
  const [page, setPage] = useState<PageId>("overview");
  const [editing, setEditing] = useState(false);
  const [dark, setDark] = useState(false);

  // The owner's choice, else the system's; kept in this browser only.
  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(THEME_KEY);
    } catch {}
    // eslint-disable-next-line react-hooks/set-state-in-effect -- read once after mount: the server cannot know the browser's preference
    setDark(stored ? stored === "dark" : window.matchMedia?.("(prefers-color-scheme: dark)").matches === true);
  }, []);
  const toggleDark = () => {
    setDark((d) => {
      try {
        localStorage.setItem(THEME_KEY, d ? "light" : "dark");
      } catch {}
      return !d;
    });
  };

  const themeButton = (
    <button
      type="button"
      onClick={toggleDark}
      aria-label={dark ? "Use the light theme" : "Use the dark theme"}
      className="inline-flex items-center gap-1.5 rounded-full border border-line bg-card px-3 py-1.5 font-medium text-ink-soft hover:text-ink"
    >
      {dark ? <Sun className="h-4 w-4" aria-hidden /> : <Moon className="h-4 w-4" aria-hidden />}
      {dark ? "Light" : "Dark"}
    </button>
  );

  if (studio.state.phase === "failed") {
    return (
      <div className="space-y-3">
        <div className="flex justify-end text-sm">{themeButton}</div>
        <div className={cx("rounded-[var(--radius-card)] border p-4", dark ? "border-[#322e45] bg-[#14121e]" : "border-line bg-paper")}>
          <SimpleView spec={spec} kpis={kpis} month={month} failure={studio.state} dark={dark} onRetry={reloadPage} />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav className="flex flex-wrap gap-1 rounded-full border border-line bg-card p-1 text-sm font-medium" aria-label="Dashboard pages">
          {PAGES.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setPage(p.id)}
              aria-current={page === p.id ? "page" : undefined}
              className={cx("rounded-full px-3.5 py-1.5", page === p.id ? "bg-ink text-white" : "text-ink-soft hover:bg-line/50 hover:text-ink")}
            >
              {p.label}
            </button>
          ))}
        </nav>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <button
            type="button"
            onClick={() => setEditing((e) => !e)}
            aria-pressed={editing}
            className={cx("inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 font-medium", editing ? "border-brand bg-brand-soft text-brand-ink" : "border-line bg-card text-ink-soft hover:text-ink")}
          >
            {editing ? <LayoutDashboard className="h-4 w-4" aria-hidden /> : ai ? <Bot className="h-4 w-4" aria-hidden /> : <PencilRuler className="h-4 w-4" aria-hidden />}
            {editing ? "Back to view" : ai ? "Edit and ask the deposit desk" : "Edit the layout"}
          </button>
          {themeButton}
        </div>
      </div>
      <div className={cx("h-[calc(100vh-12rem)] min-h-[760px] overflow-hidden rounded-[var(--radius-card)] border", dark ? "border-[#322e45] bg-[#14121e]" : "border-line bg-paper")}>
        <LoadBoundary onError={studio.onError}>
          <Studio
            spec={spec}
            month={month}
            licenseKey={licenseKey}
            ai={ai}
            mode={editing ? "edit" : "view"}
            dark={dark}
            page={page}
            onPage={setPage}
            onReady={studio.ready}
          />
        </LoadBoundary>
      </div>
    </div>
  );
}
