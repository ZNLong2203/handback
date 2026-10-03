"use client";

import { Loader2, LockKeyhole } from "lucide-react";
import { useActionState } from "react";
import { signInAction, type SignInState } from "@/app/shop/sign-in/actions";
import { Button } from "./ui";

/** Works without JavaScript too: the form posts to the server action, which redirects on success. */
export function StaffSignIn({ next }: { next: string }) {
  const [state, formAction, pending] = useActionState<SignInState, FormData>(signInAction, { error: null });
  return (
    <form action={formAction} className="mt-6 space-y-3">
      <input type="hidden" name="next" value={next} />
      <label htmlFor="code" className="block text-sm font-semibold">
        Access code
      </label>
      <input
        id="code"
        name="code"
        type="password"
        required
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        className="h-11 w-full rounded-xl border border-line-strong bg-card px-3 font-mono text-base outline-none focus:border-ink/50"
        aria-describedby={state.error ? "code-error" : undefined}
      />
      {state.error && (
        <p id="code-error" role="alert" className="text-sm font-medium text-charged">
          {state.error}
        </p>
      )}
      <Button type="submit" size="lg" className="w-full" disabled={pending}>
        {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <LockKeyhole className="h-4 w-4" aria-hidden />}
        {pending ? "Checking…" : "Open the counter"}
      </Button>
    </form>
  );
}
