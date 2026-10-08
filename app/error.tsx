"use client";

import { RotateCcw } from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";
import { Logo } from "@/components/brand";
import { Button, Card, Eyebrow } from "@/components/ui";

/** A page that failed to render. Server actions report their own errors next to their buttons, so this only covers loading a page. */
export default function PageError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <>
      <header className="mx-auto flex max-w-6xl items-center px-5 py-5">
        <Logo />
      </header>
      <main className="mx-auto max-w-xl px-5 pb-16 pt-6">
        <Card className="p-6 sm:p-8" role="alert">
          <Eyebrow>Something went wrong</Eyebrow>
          <h1 className="mt-1 font-display text-3xl font-bold tracking-tight">This page did not load</h1>
          <p className="mt-2 leading-relaxed text-ink-soft">Try again in a moment. If it keeps failing, the server log has the details.</p>
          {error.digest && <p className="mt-2 font-mono text-xs text-muted">reference {error.digest}</p>}
          <div className="mt-6 flex flex-wrap gap-3">
            <Button variant="brand" onClick={() => retry()}>
              <RotateCcw className="h-4 w-4" aria-hidden /> Try again
            </Button>
            <Link href="/" className="inline-flex h-11 items-center px-2 text-sm font-semibold text-ink-soft underline-offset-2 hover:underline">
              Go to the home page
            </Link>
          </div>
        </Card>
      </main>
    </>
  );
}
