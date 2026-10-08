/**
 * Screenshot helpers for the gallery generator. Every capture is a full-page
 * PNG plus the page-space boxes of a few named elements ("anchors"), so the
 * slide templates can crop to a section after the fact without capturing
 * again. Before each screenshot, the sandbox buyer's login is replaced in the
 * DOM with a neutral placeholder, and the page is checked again afterwards.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Locator, Page } from "@playwright/test";

export type Box = { x: number; y: number; w: number; h: number };

export type Shot = {
  /** PNG file name inside the raw folder. */
  file: string;
  /** Page size in CSS pixels; the PNG is this times `scale`. */
  width: number;
  height: number;
  scale: number;
  /** Page-space boxes (CSS pixels) of named elements. */
  anchors: Record<string, Box>;
};

/** What a capture run learned: the shots, and facts the slides print (PayPal ids, timings). */
export type Manifest = {
  shots: Record<string, Shot>;
  facts: Record<string, string>;
};

export const MASK_PLACEHOLDER = "sandbox-buyer@example.com";

export function readManifest(file: string): Manifest {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Manifest;
  } catch {
    return { shots: {}, facts: {} };
  }
}

export function writeManifest(file: string, m: Manifest) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(m, null, 2) + "\n");
}

export const log = (msg: string) => console.log(`${new Date().toISOString().slice(11, 19)}  ${msg}`);

/** Strings that must never appear in a screenshot: the sandbox buyer's email and, when long enough, its local part. */
export function secretsFrom(email: string | undefined): string[] {
  if (!email) return [];
  const local = email.split("@")[0];
  return local && local.length >= 6 ? [email, local] : [email];
}

/**
 * Replaces every secret in text nodes, form values and attributes (also inside
 * shadow roots). Kept as plain JavaScript: tsx would wrap named functions in a
 * helper that does not exist inside the page.
 */
const MASK_JS = `(({ secrets, placeholder }) => {
  const localPlaceholder = placeholder.split("@")[0];
  const replaceAll = (v, needle, repl) => {
    const lower = v.toLowerCase();
    const n = needle.toLowerCase();
    let out = "";
    let i = 0;
    for (let j = lower.indexOf(n); j !== -1; j = lower.indexOf(n, i)) {
      out += v.slice(i, j) + repl;
      i = j + n.length;
    }
    return out + v.slice(i);
  };
  // The full address first, so the local part never leaves "@domain" behind.
  const swap = (v) => secrets.reduce((acc, s, i) => replaceAll(acc, s, i === 0 ? placeholder : localPlaceholder), v);
  let changed = 0;
  const visit = (root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const next = swap(n.nodeValue || "");
      if (next !== n.nodeValue) { n.nodeValue = next; changed++; }
    }
    for (const el of root.querySelectorAll("*")) {
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        const next = swap(el.value);
        if (next !== el.value) { el.value = next; changed++; }
      }
      for (const attr of Array.from(el.attributes)) {
        const next = swap(attr.value);
        if (next !== attr.value) { el.setAttribute(attr.name, next); changed++; }
      }
      if (el.shadowRoot) visit(el.shadowRoot);
    }
  };
  visit(document);
  return changed;
})`;

export async function maskPage(page: Page, secrets: string[]) {
  if (!secrets.length) return;
  const arg = JSON.stringify({ secrets, placeholder: MASK_PLACEHOLDER });
  for (const frame of page.frames()) {
    if (frame.isDetached()) continue;
    await frame.evaluate(`${MASK_JS}(${arg})`).catch((err: unknown) => {
      // A frame that navigates away mid-call has nothing left to mask; anything else is a bug.
      if (!/detached|navigat|destroyed/i.test(String(err))) throw err;
    });
  }
}

/** Throws when a secret is still readable on the page: its text, form values or placeholders, in any frame. */
export async function assertMasked(page: Page, secrets: string[]) {
  if (!secrets.length) return;
  for (const frame of page.frames()) {
    const visible = await frame
      .evaluate(() =>
        [
          document.body?.innerText ?? "",
          ...Array.from(document.querySelectorAll("input, textarea")).flatMap((el) => [(el as HTMLInputElement).value, el.getAttribute("placeholder") ?? ""]),
        ].join("\n"),
      )
      .catch(() => "");
    const text = visible.toLowerCase();
    for (const s of secrets) if (text.includes(s.toLowerCase())) throw new Error(`the sandbox buyer's login is still on ${page.url()} after masking`);
  }
}

type ShootOptions = {
  /** Named elements whose page-space boxes the templates crop to. */
  anchors?: Record<string, Locator>;
  /** Only the viewport, for pages that scroll inside their own panes. */
  viewportOnly?: boolean;
  /** Waits for animations (the money bar grows in about a second). */
  settleMs?: number;
};

export class ShotTaker {
  constructor(
    private readonly dir: string,
    private readonly manifest: Manifest,
    private readonly secrets: string[],
  ) {
    mkdirSync(dir, { recursive: true });
  }

  async shoot(page: Page, name: string, opts: ShootOptions = {}) {
    await page.waitForTimeout(opts.settleMs ?? 1400);
    // Web fonts and images must be in before the picture.
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all(
        Array.from(document.images)
          .filter((img) => !img.complete)
          .map((img) => new Promise((resolve) => ((img.onload = resolve), (img.onerror = resolve)))),
      );
    });
    await maskPage(page, this.secrets);
    await assertMasked(page, this.secrets);
    const anchors: Record<string, Box> = {};
    for (const [key, locator] of Object.entries(opts.anchors ?? {})) {
      const el = locator.first();
      if (!(await el.count())) {
        log(`  anchor "${key}" not found on ${name}`);
        continue;
      }
      anchors[key] = await el.evaluate((node, viewportOnly) => {
        const r = node.getBoundingClientRect();
        const dx = viewportOnly ? 0 : window.scrollX;
        const dy = viewportOnly ? 0 : window.scrollY;
        return { x: Math.round(r.left + dx), y: Math.round(r.top + dy), w: Math.round(r.width), h: Math.round(r.height) };
      }, Boolean(opts.viewportOnly));
    }
    const file = `${name}.png`;
    await page.screenshot({ path: path.join(this.dir, file), fullPage: !opts.viewportOnly, animations: "disabled", caret: "hide" });
    // Anything re-rendered during the screenshot must not have brought the login back.
    await assertMasked(page, this.secrets);
    const size = await page.evaluate((viewportOnly) => {
      if (viewportOnly) return { w: window.innerWidth, h: window.innerHeight };
      return { w: document.documentElement.scrollWidth, h: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight) };
    }, Boolean(opts.viewportOnly));
    const scale = await page.evaluate(() => window.devicePixelRatio);
    this.manifest.shots[name] = { file, width: size.w, height: size.h, scale, anchors };
    log(`  shot ${name} (${size.w}x${size.h} @${scale}x)`);
  }
}
