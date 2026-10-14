"use client";

import { catchError, type ErrorInfo } from "next/error";
import { useCallback, useEffect, useState } from "react";

/**
 * What keeps a commercial component (AG Studio on Insights, Bryntum on the
 * Schedule) from taking its page down with it: an error boundary around it, a
 * deadline for it to say it has drawn, and a way for it to report that it
 * refused to run. Any of the three switches the page to its simple view,
 * drawn from the same server data without the component.
 */

export type LoadFailure = {
  reason: "forced" | "timeout" | "error" | "refused";
  /** A short technical note for the page, e.g. the error's message. */
  detail?: string;
};

export type LoadState = { phase: "loading" } | { phase: "ready" } | ({ phase: "failed" } & LoadFailure);

/** Renders nothing, and tells the page once that the component threw. */
function Report({ error, onError }: { error: unknown; onError: (error: unknown) => void }) {
  useEffect(() => onError(error), [error, onError]);
  return null;
}

/**
 * An error boundary (Next's catchError) for the component and the dynamic
 * import that loads it: a failed chunk load rejects React.lazy, which throws
 * here.
 */
export const LoadBoundary = catchError(function LoadBoundaryFallback(props: { onError: (error: unknown) => void }, { error }: ErrorInfo) {
  return <Report error={error} onError={props.onError} />;
});

/**
 * The load state of one component: `ready()` when it has drawn, `fail()`
 * when it threw or refused. While loading, a deadline of `timeoutMs` counts
 * only the time the tab is visible, because a browser may not draw anything
 * in a background tab. `forced` starts in the failed state (a test switch).
 */
export function useLoadGuard(timeoutMs: number, forced: boolean) {
  const [state, setState] = useState<LoadState>(() => (forced ? { phase: "failed", reason: "forced" } : { phase: "loading" }));
  const ready = useCallback(() => setState((s) => (s.phase === "loading" ? { phase: "ready" } : s)), []);
  const fail = useCallback((failure: LoadFailure) => setState((s) => (s.phase === "failed" ? s : { phase: "failed", ...failure })), []);
  const onError = useCallback((error: unknown) => fail({ reason: "error", detail: (error instanceof Error ? error.message : String(error)).slice(0, 200) }), [fail]);

  useEffect(() => {
    if (state.phase !== "loading") return;
    let elapsed = 0;
    let since: number | null = document.visibilityState === "visible" ? Date.now() : null;
    const settle = () => {
      if (since === null) return;
      const now = Date.now();
      elapsed += now - since;
      since = now;
    };
    const onVisibility = () => {
      settle();
      since = document.visibilityState === "visible" ? Date.now() : null;
    };
    const timer = setInterval(() => {
      settle();
      if (elapsed >= timeoutMs) fail({ reason: "timeout", detail: `not drawn after ${Math.round(timeoutMs / 1000)} seconds` });
    }, 250);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [state.phase, timeoutMs, fail]);

  return { state, ready, fail, onError };
}

/** Starts the page again, which loads the component again; a failed dynamic import is not retried in place. */
export const reloadPage = () => window.location.reload();
