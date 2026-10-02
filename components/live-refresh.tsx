"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

/**
 * Subscribes to the server-sent-event stream for a rental (or the whole shop)
 * and re-renders the page when anything changes: a webhook, the customer's
 * answer on their phone, the counter settling. Nobody has to press refresh.
 */
export function LiveRefresh({ channel }: { channel: string }) {
  const router = useRouter();
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const source = new EventSource(`/api/live/${encodeURIComponent(channel)}`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.addEventListener("update", () => {
      clearTimeout(timer);
      timer = setTimeout(() => router.refresh(), 150);
    });
    return () => {
      clearTimeout(timer);
      source.close();
    };
  }, [channel, router]);

  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted" aria-live="polite">
      <span className={connected ? "h-2 w-2 animate-pulse-soft rounded-full bg-released" : "h-2 w-2 rounded-full bg-line-strong"} />
      {connected ? "Live" : "Connecting…"}
    </span>
  );
}
