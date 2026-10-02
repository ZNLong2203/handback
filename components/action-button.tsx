"use client";

import { Loader2 } from "lucide-react";
import { useState, useTransition, type ReactNode } from "react";
import type { ActionResult } from "@/app/actions";
import { Button } from "./ui";

type Variant = "primary" | "brand" | "released" | "charged" | "outline" | "ghost";

/** A button bound to a server action, with a pending label and the action's own error message. */
export function ActionButton({
  action,
  children,
  pendingLabel,
  variant = "primary",
  size = "md",
  className,
}: {
  action: () => Promise<ActionResult<unknown>>;
  children: ReactNode;
  pendingLabel?: string;
  variant?: Variant;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className={className}>
      <Button
        variant={variant}
        size={size}
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setError(null);
            const res = await action();
            if (!res.ok) setError(res.error);
          })
        }
      >
        {pending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
        {pending && pendingLabel ? pendingLabel : children}
      </Button>
      {error && (
        <p role="alert" className="mt-2 max-w-prose text-sm font-medium text-charged">
          {error}
        </p>
      )}
    </div>
  );
}
