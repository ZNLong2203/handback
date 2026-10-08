/**
 * The counter on a deployed copy is closed with SHOP_ACCESS_CODE. The
 * gallery signs in the way staff do, on /shop/sign-in, with the code from
 * GALLERY_STAFF_CODE, so its browser frames can show the deployed URL. The
 * code is never printed: it is typed into the sign-in form only, kept out of
 * every message, and added to the strings each screenshot is checked for.
 */
import type { Browser, BrowserContext, BrowserContextOptions } from "@playwright/test";
import { log } from "./shots";

export const STAFF_CODE_ENV = "GALLERY_STAFF_CODE";

type Health = { staffAccess?: { mode?: "open" | "code" | "misconfigured" } };

/** Whether the target's counter needs the access code, from its /api/health. */
export async function counterAccess(base: string): Promise<"open" | "code"> {
  const res = await fetch(`${base}/api/health`);
  if (!res.ok) throw new Error(`${base}/api/health answered ${res.status}`);
  const mode = ((await res.json()) as Health).staffAccess?.mode;
  if (mode === "misconfigured") throw new Error(`${base} has a counter nobody can open: its SHOP_ACCESS_CODE is set up wrong (see /api/health)`);
  return mode === "code" ? "code" : "open";
}

/** The staff code to sign in with, or null when it is not set. Read only from the environment. */
export function staffCode(): string | null {
  return process.env[STAFF_CODE_ENV]?.trim() || null;
}

/** Signs a browser context in to the counter of `base` with the staff code. Throws, without the code, when it is refused. */
export async function signInToCounter(ctx: BrowserContext, base: string, code: string): Promise<void> {
  const page = await ctx.newPage();
  try {
    await page.goto(`${base}/shop/sign-in?next=%2Fshop`, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await page.getByLabel("Access code").fill(code);
    await page.getByRole("button", { name: "Open the counter" }).click();
    const refused = page.getByText(/not the counter's access code|Too many wrong codes|closed/i);
    await Promise.race([page.waitForURL((url) => !url.pathname.startsWith("/shop/sign-in"), { timeout: 60_000 }), refused.first().waitFor({ timeout: 60_000 })]).catch(() => {});
    if (new URL(page.url()).pathname.startsWith("/shop/sign-in")) {
      const why = (await refused.first().innerText().catch(() => "")) || "the sign-in page did not let us through";
      throw new Error(`${base} refused ${STAFF_CODE_ENV}: ${why.trim().slice(0, 120)}`);
    }
    if (!(await ctx.cookies(base)).some((c) => c.name === "handback_staff")) throw new Error(`${base} let us in without a staff cookie; check the sign-in page`);
  } finally {
    await page.close();
  }
}

/**
 * A browser context for the counter of `base`: signed in when the target
 * asks for the access code, plain otherwise. A target that asks for it
 * without GALLERY_STAFF_CODE set is an error, not a capture of the sign-in page.
 */
export async function counterContext(browser: Browser, base: string, options: BrowserContextOptions): Promise<BrowserContext> {
  const ctx = await browser.newContext(options);
  if ((await counterAccess(base)) === "code") {
    const code = staffCode();
    if (!code) {
      await ctx.close();
      throw new Error(`${base} asks for the counter's access code. Set ${STAFF_CODE_ENV} to it (it is read from the environment and never printed).`);
    }
    try {
      await signInToCounter(ctx, base, code);
    } catch (err) {
      await ctx.close();
      throw err;
    }
    log(`signed in to the counter of ${base}`);
  }
  return ctx;
}
