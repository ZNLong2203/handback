"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { checkSignIn, clientAddress, safeNext, servedOverHttps, STAFF_COOKIE, staffAccess } from "@/lib/staff-access";

export type SignInState = { error: string | null };

/** The counter's sign-in form. The code itself is never stored; the cookie holds an HMAC derived from it. */
export async function signInAction(_prev: SignInState, form: FormData): Promise<SignInState> {
  const next = safeNext(String(form.get("next") ?? ""));
  if (staffAccess().mode === "open") redirect(next);
  const result = await checkSignIn(String(form.get("code") ?? ""), await clientAddress());
  if (!result.ok) return { error: result.error };
  if (result.token) {
    (await cookies()).set(STAFF_COOKIE, result.token.value, {
      httpOnly: true,
      sameSite: "lax",
      secure: await servedOverHttps(),
      path: "/",
      expires: result.token.expires,
    });
  }
  redirect(next);
}

export async function signOutAction(): Promise<void> {
  (await cookies()).delete(STAFF_COOKIE);
  redirect("/shop/sign-in");
}
