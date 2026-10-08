/**
 * Builds the Devpost image gallery: captures the app's screens, composes one
 * 2400x1600 slide per idea from small HTML templates, and writes numbered
 * images plus captions.md to private/devpost-gallery/ (gitignored; the images
 * hold real sandbox ids and never go into the repo).
 *
 * Two servers from one production build (npm run build):
 *
 *   # PayPal sandbox (keys from .env.local) on a throwaway in-memory database
 *   APP_URL=http://localhost:3390 DATABASE_URL=memory GEMINI_API_KEY= npx next start -p 3390
 *
 * GEMINI_API_KEY is emptied there on purpose: on Oct 8, 2026, live Gemini
 * looking at the city bike photos as the app stores them (re-encoded JPEG)
 * did not report the missing rear light in any of 4 runs, so the story could
 * not be told. Without a key the app replays the recorded two-look Gemini run
 * of the same sample photos, its strip says so, and so do the captions. Keep
 * the key to try live Gemini: the run starts a new rental once if the two
 * looks do not both propose the phone holder and the rear light, then stops.
 *   # demo mode for the schedule, the dashboard and the dispute desk
 *   DEMO_MODE=true DATABASE_URL=memory APP_URL=http://localhost:3391 npx next start -p 3391
 *
 *   npx tsx --env-file-if-exists=.env.local scripts/gallery/generate.ts \
 *     --live http://localhost:3390 --demo http://localhost:3391
 *
 * Options:
 *   --live <url>    server in sandbox mode; runs the city bike story with the real v6 button
 *   --demo <url>    server in demo mode, started fresh (the schedule is shot before other bookings)
 *   --only <steps>  comma list of live, demo, compose (default: all three)
 *   --out <dir>     output folder (default: private/devpost-gallery in the main checkout)
 *   --headed        show the browser while capturing
 *
 * The sandbox buyer's login (PAYPAL_SANDBOX_BUYER_EMAIL) is replaced in the
 * DOM with a placeholder before every screenshot, and each page is checked
 * for it again before the picture is kept. A capture can be repeated on its
 * own; compose only reads raw/ and manifest.json.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";
import { sandboxBuyer } from "../lib/sandbox-browser";
import { captureDemo } from "./capture-demo";
import { captureLive } from "./capture-live";
import { compose } from "./compose";
import { log, readManifest, secretsFrom, ShotTaker, writeManifest } from "./shots";

/** private/devpost-gallery in the main checkout, also when this runs from a git worktree. */
function defaultOut() {
  try {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim();
    return path.join(path.dirname(common), "private", "devpost-gallery");
  } catch {
    return path.resolve("private", "devpost-gallery");
  }
}

const { values } = parseArgs({
  options: {
    live: { type: "string" },
    demo: { type: "string" },
    only: { type: "string" },
    out: { type: "string" },
    headed: { type: "boolean", default: false },
  },
});

const steps = new Set((values.only ?? "live,demo,compose").split(",").map((s) => s.trim()));
const out = path.resolve(values.out ?? defaultOut());
const rawDir = path.join(out, "raw");
const manifestFile = path.join(rawDir, "manifest.json");
mkdirSync(rawDir, { recursive: true });
const manifest = readManifest(manifestFile);
const secrets = secretsFrom(process.env.PAYPAL_SANDBOX_BUYER_EMAIL);

if ((steps.has("live") && !values.live) || (steps.has("demo") && !values.demo)) {
  console.error("Pass --live <url> and --demo <url>, or --only compose to rebuild the slides from earlier captures.");
  process.exit(2);
}

log(`output: ${out}`);
if (steps.has("live") || steps.has("demo")) {
  const browser = await chromium.launch({ headless: !values.headed });
  const taker = new ShotTaker(rawDir, manifest, secrets);
  try {
    if (steps.has("live")) {
      log(`live capture against ${values.live}`);
      await captureLive(browser, values.live!.replace(/\/$/, ""), sandboxBuyer(), taker, manifest);
      writeManifest(manifestFile, manifest);
    }
    if (steps.has("demo")) {
      log(`demo capture against ${values.demo}`);
      await captureDemo(browser, values.demo!.replace(/\/$/, ""), taker, rawDir, manifest);
      writeManifest(manifestFile, manifest);
    }
  } finally {
    writeManifest(manifestFile, manifest);
    await browser.close();
  }
}

if (steps.has("compose")) await compose(out, manifest);
