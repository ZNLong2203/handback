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
 * GEMINI_API_KEY is emptied there so the gallery does not depend on a live
 * model run. On Oct 8, 2026, live Gemini looking at the city bike photos as
 * the app then stored them (JPEG quality 85) did not report the missing rear
 * light in any of 4 runs; since they are stored at quality 95
 * (lib/photo-encoding.ts) it reported both changes in 5 of 5 local runs.
 * Without a key the app replays the recorded two-look Gemini run of the same
 * sample photos, its strip says so, and so do the captions. Keep the key to
 * use live Gemini: the run starts a new rental once if the two looks do not
 * both propose the phone holder and the rear light, then stops.
 *   # demo mode for the dispute desk (and, by default, the schedule and the dashboard)
 *   DEMO_MODE=true DATABASE_URL=memory APP_URL=http://localhost:3391 npx next start -p 3391
 *
 *   npx tsx --env-file-if-exists=.env.local scripts/gallery/generate.ts \
 *     --live http://localhost:3390 --demo http://localhost:3391
 *
 * The live target can be the deployed copy, so the browser frames show its
 * URL. Its counter is closed with SHOP_ACCESS_CODE there: put the code in
 * GALLERY_STAFF_CODE and the capture signs in on /shop/sign-in as staff do.
 * The code is read from the environment only, never printed, and every
 * screenshot is checked for it like the buyer's login. Once the sandbox seed
 * has filled that copy (the nightly demo reset, or `npm run seed:demo` with
 * SEED_VAULT_ID), the schedule and the dashboard can come from it too:
 *
 *   GALLERY_STAFF_CODE=… npx tsx --env-file-if-exists=.env.local scripts/gallery/generate.ts \
 *     --live https://handback-4qtc.onrender.com --shop-pages live --demo http://localhost:3391
 *
 * There the schedule capture settles Jordan's projector with a cracked lens
 * (two Gemini looks, live when the copy has a key, and one real sandbox
 * capture), once per reset day: a later run finds the agent's suggestions
 * already waiting and only photographs them. The dispute desk always comes
 * from --demo, labeled as the demo stand-in.
 *
 * Options:
 *   --live <url>         server in sandbox mode; runs the city bike story with the real v6 button
 *   --demo <url>         server in demo mode, started fresh (its schedule is shot before other bookings)
 *   --shop-pages <from>  where the schedule and dashboard slides come from: demo (default) or live
 *   --only <steps>       comma list of live, shop, demo, compose (default: all four, in that order)
 *   --out <dir>          output folder (default: private/devpost-gallery in the main checkout)
 *   --headed             show the browser while capturing
 *
 * The sandbox buyer's login (PAYPAL_SANDBOX_BUYER_EMAIL) and the staff code
 * are replaced in the DOM with a placeholder before every screenshot, and
 * each page is checked for them again before the picture is kept. A capture
 * can be repeated on its own; compose only reads raw/ and manifest.json.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";
import { sandboxBuyer } from "../lib/sandbox-browser";
import { captureDemo } from "./capture-demo";
import { captureLive } from "./capture-live";
import { captureShop, type ShopSource } from "./capture-shop";
import { compose } from "./compose";
import { log, readManifest, secretsFrom, ShotTaker, writeManifest } from "./shots";
import { staffCode } from "./staff";

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
    "shop-pages": { type: "string", default: "demo" },
    out: { type: "string" },
    headed: { type: "boolean", default: false },
  },
});

const steps = new Set((values.only ?? "live,shop,demo,compose").split(",").map((s) => s.trim()));
const shopFrom = values["shop-pages"] as ShopSource;
if (shopFrom !== "live" && shopFrom !== "demo") {
  console.error("--shop-pages must be live or demo.");
  process.exit(2);
}
const shopBase = shopFrom === "live" ? values.live : values.demo;
const out = path.resolve(values.out ?? defaultOut());
const rawDir = path.join(out, "raw");
const manifestFile = path.join(rawDir, "manifest.json");
mkdirSync(rawDir, { recursive: true });
const manifest = readManifest(manifestFile);
// The staff code goes on the list too: a page that ever showed it would fail the check before its picture is kept.
const code = staffCode();
const secrets = [...secretsFrom(process.env.PAYPAL_SANDBOX_BUYER_EMAIL), ...(code ? [code] : [])];

if ((steps.has("live") && !values.live) || (steps.has("demo") && !values.demo) || (steps.has("shop") && !shopBase)) {
  console.error(`Pass --live <url> and --demo <url> (the schedule and dashboard come from --${shopFrom}), or --only compose to rebuild the slides from earlier captures.`);
  process.exit(2);
}

log(`output: ${out}`);
if (steps.has("live") || steps.has("shop") || steps.has("demo")) {
  const browser = await chromium.launch({ headless: !values.headed });
  const taker = new ShotTaker(rawDir, manifest, secrets);
  try {
    if (steps.has("live")) {
      log(`live capture against ${values.live}`);
      await captureLive(browser, values.live!.replace(/\/$/, ""), sandboxBuyer(), taker, manifest);
      writeManifest(manifestFile, manifest);
    }
    if (steps.has("shop")) {
      log(`schedule and dashboard against ${shopBase} (${shopFrom === "live" ? "the live sandbox target" : "demo mode"})`);
      await captureShop(browser, shopBase!.replace(/\/$/, ""), shopFrom, taker, manifest);
      writeManifest(manifestFile, manifest);
    }
    if (steps.has("demo")) {
      log(`dispute desk against ${values.demo} (demo mode)`);
      await captureDemo(browser, values.demo!.replace(/\/$/, ""), taker, rawDir, manifest);
      writeManifest(manifestFile, manifest);
    }
  } finally {
    writeManifest(manifestFile, manifest);
    await browser.close();
  }
}

if (steps.has("compose")) await compose(out, manifest);
