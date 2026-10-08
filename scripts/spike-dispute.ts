/**
 * Sandbox spike for the dispute desk: a real buyer dispute on a real
 * settlement capture, answered from the counter's dispute panel.
 *
 *   settle   drives the running app to a settled rental (as sandbox-walkthrough.ts)
 *   file     logs in as the sandbox buyer at www.sandbox.paypal.com and files a
 *            "charged the wrong amount" case on the damage capture in the
 *            Resolution Center
 *   answer   the counter finds the dispute (GET /v1/customer/disputes by
 *            disputed_transaction_id), prepares and sends the evidence pack,
 *            and plays PayPal's part with the sandbox-only require-evidence
 *            and adjudicate calls, each only once PayPal offers its link
 *            (deciding for the shop, or for the customer with --customer-wins)
 *   replay   sends one small format-test evidence twice with the same
 *            PayPal-Request-Id, to see whether the Disputes API deduplicates
 *
 * Every phase logs the dispute as PayPal reports it (status, links, requested
 * evidence, fund movements). State is kept in .data/sandbox/spike-dispute.json so a
 * phase can be rerun on its own. Needs the dev server running in sandbox mode
 * and the sandbox buyer login in .env.local:
 *
 *   npx tsx --conditions=react-server --env-file-if-exists=.env.local scripts/spike-dispute.ts all [--replay] [--customer-wins]
 *   npx tsx --conditions=react-server --env-file-if-exists=.env.local scripts/spike-dispute.ts answer
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { chromium, type Browser, type Locator, type Page } from "@playwright/test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { paypalConfig } from "@/lib/paypal/config";
import { availableActions, chooseEvidenceType, requestedEvidence, type Dispute } from "@/lib/paypal/dispute-model";
import { PayPalDisputeApi } from "@/lib/paypal/disputes";
import { PayPalError } from "@/lib/paypal/errors";
import { bookAndSettle, sandboxBuyer, signInAsBuyer, step } from "./lib/sandbox-browser";

const BASE = process.env.SPIKE_URL ?? "http://localhost:3000";
const OUT = process.env.SPIKE_SHOTS;
const STATE_FILE = ".data/sandbox/spike-dispute.json";
/** What the customer says the lens hood should have cost, in the case they file. */
const CLAIMED_RIGHT_AMOUNT = "15.00";
const BUYER_NOTE = "I returned the camera kit and the shop charged 35 USD for a lens hood. I think 15 USD was the right amount.";

type State = { rentalId?: string; captureId?: string; authorizationId?: string; disputeId?: string; filedAt?: string; replayed?: boolean };

const cfg = paypalConfig();
if (cfg.mode !== "sandbox") throw new Error("Run this against the PayPal sandbox (PAYPAL_CLIENT_ID/SECRET set, DEMO_MODE not true)");
const api = new PayPalDisputeApi("sandbox");
const load = (): State => (existsSync(STATE_FILE) ? (JSON.parse(readFileSync(STATE_FILE, "utf8")) as State) : {});
const save = (s: State) => {
  mkdirSync(".data/sandbox", { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
};
const shot = async (page: Page, name: string) => {
  if (OUT) await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true }).catch(() => {});
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Outside the test runner Playwright waits forever by default. */
const newPage = async (browser: Browser) => {
  const context = await browser.newContext({ locale: "en-US", viewport: { width: 1280, height: 900 } });
  context.setDefaultTimeout(60_000);
  return context.newPage();
};

/** One line per dispute read: what PayPal says and offers right now. */
function describe(d: Dispute): string {
  const a = availableActions(d);
  const offered = Object.entries(a)
    .filter(([, v]) => v === true || Array.isArray(v))
    .map(([k, v]) => (Array.isArray(v) && v.length ? `${k}(${v.join("/")})` : k));
  const funds = (d.fund_movements ?? []).map((f) => `${f.reason} ${f.amount?.value ?? "?"} at ${f.initiated_time}`);
  return [
    `${d.status} / ${d.dispute_state ?? "-"} / ${d.dispute_life_cycle_stage ?? "-"}`,
    `offers: ${offered.join(", ") || "nothing"}`,
    `asks for: ${requestedEvidence(d).join(", ") || "-"}`,
    `due: ${d.seller_response_due_date ?? "-"}`,
    `funds: ${funds.join("; ") || "-"}`,
    `outcome: ${d.dispute_outcome?.outcome_code ?? "-"}${d.dispute_outcome?.outcome_reason ? ` (${d.dispute_outcome.outcome_reason})` : ""}`,
    `update_time ${d.update_time}`,
  ].join(" | ");
}

async function logDispute(id: string, label: string): Promise<Dispute | null> {
  // The sandbox API stalled now and then during our runs; a failed read is logged, not fatal.
  const d = await api.get(id).catch((e: unknown) => {
    step(`${label}: read failed (${e instanceof Error ? e.message : String(e)})`);
    return null;
  });
  if (d) step(`${label}: ${describe(d)}`);
  return d;
}

// ─── settle ─────────────────────────────────────────────────

async function settle(): Promise<State> {
  const browser = await chromium.launch({ headless: !process.argv.includes("--headed") });
  try {
    const context = await browser.newContext({ locale: "en-US", viewport: { width: 1280, height: 900 } });
    const r = await bookAndSettle(context, BASE, sandboxBuyer(), shot);
    if (!r.captureId) throw new Error("the rental settled without a damage capture; the dispute needs one");
    const state = { rentalId: r.rentalId, captureId: r.captureId, authorizationId: r.authorizationId ?? undefined };
    save(state);
    return state;
  } finally {
    await browser.close();
  }
}

// ─── file ───────────────────────────────────────────────────

/**
 * Files the case the way a renter would, through PayPal's own pages. The
 * buyer sees their side of the payment (another transaction id), so the
 * newest transaction for the settled amount is picked and the dispute is
 * checked against the capture id once PayPal shows it.
 */
async function fileDispute(state: State, amountLabel = "$35.00"): Promise<State> {
  const browser = await chromium.launch({ headless: !process.argv.includes("--headed") });
  try {
    const page = await newPage(browser);
    step("buyer: signing in at www.sandbox.paypal.com");
    await signInAsBuyer(page, sandboxBuyer());
    // The full list opens in a sheet, after the dashboard's own few cards; newest first.
    // A payment can take a minute or two to show up on the buyer's side.
    const cards = page.getByTestId("transaction-card");
    let pick = -1;
    for (let attempt = 1; pick === -1; attempt++) {
      await page.goto("https://www.sandbox.paypal.com/disputes/dashboard/", { timeout: 90_000 });
      await page.getByText("Choose a transaction to get started").waitFor({ timeout: 60_000 });
      const onDashboard = await cards.count();
      await page.getByTestId("show-all-activities").click();
      await cards.nth(onDashboard).waitFor({ timeout: 30_000 });
      await page.waitForTimeout(2000);
      // innerText keeps PayPal's non-breaking spaces ("$35.00\u00a0USD").
      const texts = (await cards.allInnerTexts()).map((t) => t.replace(/\s+/g, " "));
      // The settlement is the rental's last payment, so it must be the newest one; an older
      // payment of the same amount further down belongs to another rental.
      if (texts[onDashboard]?.includes(`${amountLabel} USD`)) pick = onDashboard;
      if (pick !== -1) break;
      if (attempt === 6) throw new Error(`the newest payment in the buyer's list is not ${amountLabel}: ${texts.slice(onDashboard, onDashboard + 4).join(" | ")}`);
      step(`  buyer: newest payment is "${texts[onDashboard]}", not ${amountLabel} yet; looking again in 30 s`);
      await sleep(30_000);
    }
    await cards.nth(pick).click();
    await page.getByTestId("report-button").click();
    await page.waitForURL(/\/resolutioncenter\/filing\//, { timeout: 60_000 });
    step(`buyer: filing on ${page.url()}`);
    // Payments on a saved wallet show an "automatic payment" page first.
    const reportToPayPal = page.getByTestId("step0-widget-continue-link");
    const billedWrong = page.getByTestId("elg-item-12"); // "I was billed a different amount or was billed twice"
    await reportToPayPal.or(billedWrong).first().waitFor({ timeout: 60_000 });
    if (await reportToPayPal.isVisible()) await reportToPayPal.click();
    await billedWrong.click();
    await page.locator("label[for=selection_issue_INCORRECT_AMOUNT]").click();
    await page.getByTestId("billing-issue-continue").click();
    const amount = page.getByTestId("correct_txn_amt-CurrencyInput");
    await amount.click();
    await amount.fill("");
    await amount.pressSequentially(CLAIMED_RIGHT_AMOUNT, { delay: 60 });
    await page.getByTestId("billing-additional-info-continue").click();
    await page.locator("label[for=selection_merchant_contacted_YES]").click();
    await page.getByTestId("seller-contacted-continue").click();
    await page.getByTestId("note").fill(BUYER_NOTE);
    await page.getByTestId("document-upload-continue").click();
    await shot(page, "f01-buyer-review");
    await page.getByRole("button", { name: "Submit" }).click();
    await page.getByText(/Case ID: PP-/).waitFor({ timeout: 60_000 });
    await shot(page, "f02-buyer-filed");
    const disputeId = /Case ID: (PP-[A-Z0-9-]+)/.exec(await page.locator("body").innerText())![1];
    const next = { ...state, disputeId, filedAt: new Date().toISOString() };
    save(next);
    step(`buyer: filed ${disputeId}`);
    // GET by id worked within two minutes in our runs; the dispute names the seller's capture.
    for (let i = 0; i < 20; i++) {
      const d = await api.get(disputeId).catch((e: unknown) => (e instanceof PayPalError && e.status === 404 ? null : Promise.reject(e)));
      if (d) {
        const tx = d.disputed_transactions?.[0]?.seller_transaction_id;
        step(`dispute ${disputeId} is on capture ${tx} (buyer transaction ${d.disputed_transactions?.[0]?.buyer_transaction_id}): ${describe(d)}`);
        if (state.captureId && tx !== state.captureId) throw new Error(`filed on ${tx}, not on the rental's capture ${state.captureId}`);
        break;
      }
      await sleep(15_000);
    }
    return next;
  } finally {
    await browser.close();
  }
}

// ─── answer, through the counter's panel ────────────────────

/** Clicks a panel button (and its confirmation, if it asks for one) and fails on any error the panel shows. */
async function act(page: Page, panel: Locator, name: string, confirm?: string) {
  await panel.getByRole("button", { name }).click();
  if (confirm) await panel.getByRole("button", { name: confirm }).click();
  await panel.getByRole("button", { name: /…$/ }).waitFor({ state: "detached", timeout: 120_000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const alert = panel.getByRole("alert");
  if (await alert.first().isVisible().catch(() => false)) throw new Error(`the panel showed: ${(await alert.first().innerText()).trim()}`);
}

/**
 * Answers the dispute from the counter's panel, acting on whatever PayPal
 * offers when the page is read, so a rerun picks up where the last one
 * stopped: send the pack while fewer than two rounds were sent, otherwise
 * play require-evidence; with --replay, use one more round for the
 * request-id experiment; then play adjudicate for the shop.
 */
async function answer(state: State, opts: { replay: boolean; decide: "PayPal decides for the shop" | "PayPal decides for the customer" }) {
  if (!state.rentalId || !state.disputeId) throw new Error(`run settle and file first (${STATE_FILE})`);
  const disputeId = state.disputeId;
  const browser = await chromium.launch({ headless: !process.argv.includes("--headed") });
  try {
    const page = await newPage(browser);
    await page.goto(`${BASE}/shop/rentals/${state.rentalId}`);
    const panel = page.getByRole("region", { name: "Charged the wrong amount" });

    step("counter: asking PayPal for disputes on the rental's captures");
    const started = Date.now();
    while (!(await panel.isVisible().catch(() => false))) {
      if (Date.now() - started > 20 * 60_000) throw new Error("PayPal did not list the dispute within 20 minutes");
      await page.getByRole("button", { name: "Check PayPal for disputes" }).click();
      const said = page.getByRole("status").filter({ hasText: /dispute/ }).last();
      await said.waitFor({ timeout: 60_000 }).catch(() => {});
      step(`  counter: "${(await said.innerText({ timeout: 1000 }).catch(() => "(no message)")).trim()}"`);
      if (await panel.isVisible().catch(() => false)) break;
      await sleep(30_000);
      await page.reload();
    }
    step(`counter: dispute panel shown after ${Math.round((Date.now() - started) / 1000)} s`);
    await logDispute(disputeId, "PayPal");
    await shot(page, "a01-panel");

    const ROUNDS = 2;
    const visible = (name: string) => panel.getByRole("button", { name }).isVisible().catch(() => false);
    let last = "";
    let idleSince = Date.now();
    for (;;) {
      // Act on what PayPal says now, not on what the page last stored.
      const refresh = panel.getByRole("button", { name: "Refresh from PayPal" });
      if (await refresh.isVisible().catch(() => false)) {
        await refresh.click().catch(() => {});
        await panel.getByRole("button", { name: /Reading PayPal…/ }).waitFor({ state: "detached", timeout: 90_000 }).catch(() => {});
        await page.waitForTimeout(1500);
      }
      if (await panel.getByText(/The shop keeps the charge\.|PayPal refunded|PayPal closed the case\./).first().isVisible().catch(() => false)) break;
      const sent = await panel.getByText(/^Sent .* as /).count();
      const before = Date.now();
      if (await visible("Send to PayPal")) {
        if (sent < ROUNDS) {
          if (await visible("Prepare the evidence pack")) await act(page, panel, "Prepare the evidence pack");
          step(`counter: sending the pack and both photos (round ${sent + 1})`);
          await act(page, panel, "Send to PayPal", "Send the pack and both photos to PayPal");
          step(`  pack ${(await panel.getByText(/^sha256 [0-9a-f]{64}$/).innerText()).slice(7)}`);
          await shot(page, `a02-sent-${sent + 1}`);
          await logDispute(disputeId, `after evidence round ${sent + 1}`);
        } else if (opts.replay && !state.replayed) {
          await replay(disputeId);
          state = { ...state, replayed: true };
          save(state);
        } else throw new Error("PayPal asks for evidence again, but this run has sent all its rounds");
      } else if ((await visible("PayPal asks the shop for evidence")) && (sent < ROUNDS || (opts.replay && !state.replayed))) {
        step("sandbox: require-evidence (SELLER_EVIDENCE)");
        await act(page, panel, "PayPal asks the shop for evidence");
        await logDispute(disputeId, "after require-evidence");
      } else if ((await visible(opts.decide)) && sent >= ROUNDS && (!opts.replay || state.replayed)) {
        step(`sandbox: adjudicate (${opts.decide})`);
        await act(page, panel, opts.decide);
        await logDispute(disputeId, "after adjudicate");
      }
      if (Date.now() - before > 2000) {
        idleSince = Date.now();
        continue;
      }
      // Nothing to do yet: PayPal is still moving the case. Read it again shortly.
      if (Date.now() - idleSince > 20 * 60_000) throw new Error("PayPal offered nothing new for 20 minutes");
      const d = await api.get(disputeId).catch(() => null);
      const now = d ? describe(d) : "read failed";
      if (now !== last) step(`  waiting: ${now}`);
      last = now;
      await sleep(20_000);
    }
    step(`decided after ${Math.round((Date.now() - started) / 1000)} s`);
    await logDispute(disputeId, "decided");
    await page.goto(`${BASE}/shop/rentals/${state.rentalId}`);
    await shot(page, "a06-counter-final");
  } finally {
    await browser.close();
  }
}

// ─── replay: does PayPal deduplicate on PayPal-Request-Id? ──

async function replay(disputeId: string) {
  const before = await api.get(disputeId);
  if (!availableActions(before).provideEvidence) throw new Error("replay needs a dispute that offers provide_evidence");
  const doc = await PDFDocument.create();
  doc.setCreationDate(new Date(0));
  doc.setModificationDate(new Date(0));
  doc.addPage([612, 200]).drawText("Format test from Handback's sandbox spike: the same request sent twice with one PayPal-Request-Id.", {
    x: 36,
    y: 150,
    size: 10,
    font: await doc.embedFont(StandardFonts.Helvetica),
  });
  const bytes = await doc.save();
  const submission = {
    evidenceType: chooseEvidenceType(before),
    notes: "Format test from Handback's sandbox spike: this request is sent twice with the same PayPal-Request-Id.",
    files: [{ name: "spike-replay.pdf", contentType: "application/pdf" as const, bytes }],
  };
  const requestId = `spike-replay:${disputeId}:${before.update_time}`;
  const count = (d: Dispute) => (d.evidences ?? []).filter((e) => e.source === "SUBMITTED_BY_SELLER").length;
  step(`replay: seller evidence entries before: ${count(before)}; request id ${requestId}`);
  for (const attempt of [1, 2]) {
    try {
      const r = await api.provideEvidence(before, submission, requestId);
      step(`replay: attempt ${attempt}: HTTP ${r.status}, debug id ${r.debugId}`);
    } catch (e) {
      if (!(e instanceof PayPalError)) throw e;
      step(`replay: attempt ${attempt}: HTTP ${e.status} ${e.errorName} ${e.issue ?? ""} debug id ${e.debugId}: ${e.message}`);
    }
  }
  await sleep(5000);
  const after = await api.get(disputeId).catch(() => null);
  step(after ? `replay: seller evidence entries after: ${count(after)}; ${describe(after)}` : "replay: could not read the dispute afterwards; run `show` to count the entries");
}

// ─── main ───────────────────────────────────────────────────

const phase = process.argv[2] ?? "all";
const replayFlag = process.argv.includes("--replay");
let state = load();
if (phase === "settle" || phase === "all") state = await settle();
if (phase === "file" || phase === "all") state = await fileDispute(state);
const decide = process.argv.includes("--customer-wins") ? "PayPal decides for the customer" : "PayPal decides for the shop";
if (phase === "answer" || phase === "all") await answer(state, { replay: replayFlag, decide });
if (phase === "replay") await replay(state.disputeId ?? process.argv[3]);
if (phase === "show") await logDispute(state.disputeId ?? process.argv[3], "PayPal");
step(`state: ${JSON.stringify(load())}`);
