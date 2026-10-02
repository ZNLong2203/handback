"use client";

import { Loader2 } from "lucide-react";
import { useState, useTransition, type ReactNode } from "react";
import type { ActionResult } from "@/app/actions";
import { Button } from "./ui";

type Variant = "primary" | "brand" | "released" | "charged" | "outline" | "ghost";

/**
 * A button bound to a server action, with a pending label and the action's
 * own error message. With `confirmLabel`, the first tap only asks; the
 * second runs it (for steps that move money or cannot be undone). A string
 * the action returns is shown as a status line.
 */
export function ActionButton({
  action,
  children,
  pendingLabel,
  confirmLabel,
  variant = "primary",
  size = "md",
  className,
}: {
  action: () => Promise<ActionResult<unknown>>;
  children: ReactNode;
  pendingLabel?: string;
  confirmLabel?: string;
  variant?: Variant;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const run = () =>
    startTransition(async () => {
      setError(null);
      setStatus(null);
      setAsking(false);
      const res = await action();
      if (!res.ok) setError(res.error);
      else if (typeof res.data === "string") setStatus(res.data);
    });
  return (
    <div className={className}>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant={variant} size={size} disabled={pending} onClick={() => (confirmLabel && !asking ? setAsking(true) : run())}>
          {pending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
          {pending && pendingLabel ? pendingLabel : asking && confirmLabel ? confirmLabel : children}
        </Button>
        {asking && !pending && (
          <Button variant="ghost" size={size === "lg" ? "md" : "sm"} onClick={() => setAsking(false)}>
            Cancel
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-2 max-w-prose text-sm font-medium text-charged">
          {error}
        </p>
      )}
      {status && (
        <p role="status" className="mt-2 max-w-prose text-sm text-ink-soft">
          {status}
        </p>
      )}
    </div>
  );
}
