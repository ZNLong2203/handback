import "server-only";
import { catalogItem } from "@/lib/catalog";
import { getDb } from "@/lib/db/client";
import { publish } from "@/lib/live";
import { formatUsd, type Cents } from "@/lib/money";
import { disputeApi } from "@/lib/paypal";
import { DemoDisputeApi } from "@/lib/paypal/demo-disputes";
import {
  availableActions,
  chooseEvidenceType,
  DisputeActionUnavailable,
  DisputeSchema,
  requestedEvidence,
  usdCents,
  type ActionReceipt,
  type Dispute,
  type DisputeActions,
  type EvidenceFile,
} from "@/lib/paypal/dispute-model";
import type { PayPalMode } from "@/lib/paypal/config";
import { loadPhoto } from "@/lib/photos";
import { appendEvent } from "@/lib/rentals/audit";
import { eventsFor, inspectionsFor, latestAssessment } from "@/lib/rentals/repo";
import { mustRental, paypalStep } from "@/lib/rentals/service";
import { isCharged } from "@/lib/rentals/settlement";
import { UserError, type Rental } from "@/lib/rentals/types";
import type { RentalView } from "@/lib/rentals/view";
import { SHOP } from "@/lib/shop";
import { factsSha, packFileName, paypalNotes, renderEvidencePdf, sha256Hex, type PackPhotos } from "./evidence";
import { buildEvidenceFacts, type EvidenceFacts, type EvidenceSource } from "./facts";
import { writeNarrative, type Narrative } from "./narrative";
import { recommend, type Recommendation } from "./recommend";
import { recordDispute, type RecordResult } from "./record";
import { claimAction, disputesFor, finishAction, insertPack, latestPack, packByFacts, type StoredDispute, type StoredPack } from "./repo";

// ─── Reading PayPal ─────────────────────────────────────────

async function currentDispute(rentalId: string): Promise<{ rental: Rental; stored: StoredDispute }> {
  const rental = await mustRental(rentalId);
  const [stored] = await disputesFor(await getDb(), rentalId);
  if (!stored) throw new UserError("There is no PayPal dispute on this rental.");
  return { rental, stored };
}

/** Reads the dispute from PayPal and stores what changed. */
async function pull(rentalId: string, disputeId: string): Promise<Dispute> {
  const d = await paypalStep(rentalId, "read the dispute", () => disputeApi().get(disputeId));
  const db = await getDb();
  const result: RecordResult = await db.tx((tx) => recordDispute(tx, rentalId, d, "paypal"));
  if (result !== "unchanged" && result !== "stale") publish(rentalId, `dispute.${result}`);
  return d;
}

export async function refreshDispute(rentalId: string): Promise<void> {
  const { stored } = await currentDispute(rentalId);
  await pull(rentalId, stored.id);
}

/**
 * Asks PayPal for disputes on any of the rental's captures. Webhooks bring
 * new disputes on their own; this is the fallback, and what a shop without
 * a public webhook URL uses. The sandbox listed a new dispute by its
 * capture id about four minutes after the buyer filed it.
 */
export async function findDisputes(rentalId: string): Promise<number> {
  const rental = await mustRental(rentalId);
  const captures = [rental.feeCaptureId, rental.settlementCaptureId, rental.extraCaptureId].filter((c): c is string => Boolean(c));
  if (captures.length === 0) throw new UserError("Nothing was captured on PayPal for this rental, so there is nothing to dispute.");
  const api = disputeApi();
  const ids = new Set<string>();
  for (const captureId of captures) {
    const items = await paypalStep(rentalId, "look for disputes", () => api.list({ disputedTransactionId: captureId }));
    for (const item of items) ids.add(item.dispute_id);
  }
  let found = 0;
  for (const id of ids) {
    const d = await paypalStep(rentalId, "read the dispute", () => api.get(id));
    // Only disputes on this rental's own captures belong to it.
    if (!d.disputed_transactions?.some((t) => t.seller_transaction_id && captures.includes(t.seller_transaction_id))) continue;
    const db = await getDb();
    const result = await db.tx((tx) => recordDispute(tx, rentalId, d, "paypal"));
    if (result !== "unchanged" && result !== "stale") publish(rentalId, `dispute.${result}`);
    found += 1;
  }
  return found;
}

// ─── The evidence pack ──────────────────────────────────────

async function sourceFor(rental: Rental, stored: StoredDispute): Promise<EvidenceSource> {
  const db = await getDb();
  const [inspections, assessment, events] = await Promise.all([inspectionsFor(db, rental.id), latestAssessment(db, rental.id), eventsFor(db, rental.id)]);
  return {
    shop: SHOP,
    rental,
    itemName: catalogItem(rental.itemId).name,
    checkout: inspections.filter((i) => i.phase === "checkout").at(-1) ?? null,
    checkin: inspections.filter((i) => i.phase === "checkin").at(-1) ?? null,
    assessment,
    events,
    dispute: disputeFacts(stored),
  };
}

const disputeFacts = (s: StoredDispute): EvidenceFacts["dispute"] => ({ id: s.id, reason: s.reason, amountCents: s.amountCents, transactionId: s.transactionId, openedAt: s.openedAt });

/** A photo's bytes, refusing any whose content no longer matches the hash on record. */
async function verifiedPhoto(sha: string | undefined): Promise<Uint8Array | null> {
  if (!sha) return null;
  const photo = await loadPhoto(sha);
  if (!photo) throw new UserError("A photo on record is missing from storage, so the evidence pack cannot be built.");
  const bytes = new Uint8Array(photo.bytes);
  if (sha256Hex(bytes) !== sha) throw new UserError("A stored photo no longer matches the SHA-256 recorded when it was taken. The pack was not built.");
  return bytes;
}

export type PreparedPack = { sha256: string; bytes: Uint8Array; facts: EvidenceFacts; narrative: Narrative; photos: PackPhotos };

/**
 * Builds the pack from the record as it is now. The same facts reuse the
 * summary written the first time, so they render to the same bytes and the
 * same SHA-256; the pack is stored under that hash.
 */
async function buildPack(rental: Rental, stored: StoredDispute): Promise<PreparedPack> {
  const facts = buildEvidenceFacts(await sourceFor(rental, stored));
  const photos = { pickup: await verifiedPhoto(facts.pickup?.sha256), returned: await verifiedPhoto(facts.returned?.sha256) };
  const db = await getDb();
  const fsha = factsSha(facts);
  const narrative = (await packByFacts(db, fsha))?.narrative ?? (await writeNarrative(facts));
  const bytes = await renderEvidencePdf(facts, narrative, photos);
  const sha256 = sha256Hex(bytes);
  await insertPack(db, { sha256, rentalId: rental.id, disputeId: stored.id, factsSha: fsha, facts, narrative }, bytes);
  return { sha256, bytes, facts, narrative, photos };
}

export async function prepareEvidence(rentalId: string): Promise<string> {
  const { rental, stored } = await currentDispute(rentalId);
  const pack = await buildPack(rental, stored);
  publish(rentalId, "dispute.pack");
  return pack.sha256;
}

// ─── Acting on the dispute ──────────────────────────────────

function notOffered(what: string, d: Dispute): string {
  return `PayPal does not offer to ${what} on this dispute right now (it is ${d.status.toLowerCase().replace(/_/g, " ")}). The panel shows what PayPal allows.`;
}

/**
 * One guarded PayPal action: claimed in dispute_actions first, so a double
 * tap cannot send it twice (the Disputes API does not deduplicate on
 * PayPal-Request-Id), then sent, then marked done or failed.
 */
async function guarded(rentalId: string, d: Dispute, action: string, round: string, step: string, send: (requestId: string) => Promise<ActionReceipt>): Promise<ActionReceipt> {
  const db = await getDb();
  const requestId = `dispute-${action}:${d.dispute_id}:${round}`.slice(0, 108);
  if (!(await claimAction(db, d.dispute_id, action, round, requestId))) throw new UserError("That was already sent to PayPal for this dispute.");
  try {
    const receipt = await paypalStep(rentalId, step, () => send(requestId));
    await finishAction(db, d.dispute_id, action, round, "done", receipt.debugId);
    return receipt;
  } catch (err) {
    await finishAction(db, d.dispute_id, action, round, "failed", null);
    if (err instanceof DisputeActionUnavailable) throw new UserError(notOffered(step, d));
    if (err instanceof RangeError) throw new UserError(`The evidence could not be sent: ${err.message}.`);
    throw err;
  }
}

/** After an action, read the dispute a few times until PayPal shows the change. */
async function followUp(rentalId: string, before: Dispute): Promise<void> {
  const wait = disputeApi().mode === "demo" ? 0 : 2500;
  for (let i = 0; i < 4; i++) {
    const d = await pull(rentalId, before.dispute_id).catch(() => null);
    if (!d || d.status !== before.status) return;
    await new Promise((r) => setTimeout(r, wait));
  }
}

/**
 * Files the evidence pack with PayPal: the one-page PDF plus the two
 * original photos, under the evidence type PayPal asked for when the pack
 * really is that, otherwise OTHER.
 */
export async function submitEvidence(rentalId: string): Promise<string> {
  const { rental, stored } = await currentDispute(rentalId);
  const d = await pull(rentalId, stored.id);
  if (!availableActions(d).provideEvidence) throw new UserError(notOffered("send evidence", d));
  const pack = await buildPack(rental, stored);
  const evidenceType = chooseEvidenceType(d);
  const files: EvidenceFile[] = [{ name: packFileName(pack.facts), contentType: "application/pdf", bytes: pack.bytes }];
  if (pack.photos.pickup) files.push({ name: `${rental.id}-pickup.jpg`, contentType: "image/jpeg", bytes: pack.photos.pickup });
  if (pack.photos.returned) files.push({ name: `${rental.id}-return.jpg`, contentType: "image/jpeg", bytes: pack.photos.returned });
  // Each request for evidence gets a new due date, so it identifies the round.
  const round = d.seller_response_due_date ?? d.update_time ?? "first";
  const receipt = await guarded(rentalId, d, "evidence", round, "send the evidence", (requestId) =>
    disputeApi().provideEvidence(d, { evidenceType, notes: paypalNotes(pack.facts, pack.narrative, pack.sha256), files }, requestId),
  );
  await appendEvent(await getDb(), rentalId, "staff", "dispute.evidence_sent", {
    disputeId: d.dispute_id,
    sha256: pack.sha256,
    evidenceType,
    files: files.map((f) => f.name),
    summary: pack.narrative.source,
    debugId: receipt.debugId,
  });
  publish(rentalId, "dispute.evidence_sent");
  await followUp(rentalId, d);
  return pack.sha256;
}

/** Accepts liability: PayPal refunds the disputed amount to the customer and closes the case. */
export async function acceptClaim(rentalId: string): Promise<void> {
  const { rental, stored } = await currentDispute(rentalId);
  const d = await pull(rentalId, stored.id);
  const types = availableActions(d).acceptClaim;
  if (!types) throw new UserError(notOffered("accept the claim", d));
  if (types.length > 0 && !types.includes("REFUND")) throw new UserError("PayPal only offers a partial or return-based acceptance here; settle it in PayPal's Resolution Center.");
  const amount = usdCents(d.dispute_amount);
  const note = `${SHOP.name} accepts the claim on rental ${rental.id}${amount !== null ? ` and agrees to refund ${formatUsd(amount)}` : ""}.`;
  const receipt = await guarded(rentalId, d, "accept", "once", "accept the claim", (requestId) => disputeApi().acceptClaim(d, { note, type: "REFUND" }, requestId));
  await appendEvent(await getDb(), rentalId, "staff", "dispute.claim_accepted", { disputeId: d.dispute_id, refundCents: amount, debugId: receipt.debugId });
  publish(rentalId, "dispute.claim_accepted");
  await followUp(rentalId, d);
}

/** Offers a refund of part of the disputed amount; PayPal shows it to the customer. */
export async function makeOffer(rentalId: string, cents: Cents): Promise<void> {
  const { rental, stored } = await currentDispute(rentalId);
  const d = await pull(rentalId, stored.id);
  if (!availableActions(d).makeOffer?.includes("REFUND")) throw new UserError(notOffered("make an offer", d));
  const disputed = usdCents(d.dispute_amount) ?? 0;
  if (!Number.isSafeInteger(cents) || cents <= 0 || cents >= disputed) throw new UserError(`An offer must be more than $0.00 and less than the ${formatUsd(disputed)} in dispute.`);
  const note = `${SHOP.name} offers to refund ${formatUsd(cents)} on rental ${rental.id}: the part the customer questioned at the counter.`;
  const receipt = await guarded(rentalId, d, "offer", String(cents), "make an offer", (requestId) => disputeApi().makeOffer(d, { note, type: "REFUND", amountCents: cents }, requestId));
  await appendEvent(await getDb(), rentalId, "staff", "dispute.offer_made", { disputeId: d.dispute_id, offerCents: cents, debugId: receipt.debugId });
  publish(rentalId, "dispute.offer_made");
  await followUp(rentalId, d);
}

// ─── Sandbox and demo controls ──────────────────────────────

function sandboxOnly() {
  if (disputeApi().mode === "live") throw new UserError("PayPal only offers this in its sandbox; in live, PayPal's own agents decide.");
}

/** Sandbox only: PayPal's test system asks the shop for evidence (require-evidence). */
export async function sandboxRequireEvidence(rentalId: string): Promise<void> {
  sandboxOnly();
  const { stored } = await currentDispute(rentalId);
  const d = await pull(rentalId, stored.id);
  if (!availableActions(d).requireEvidence) throw new UserError(notOffered("ask for evidence", d));
  const receipt = await guarded(rentalId, d, "require-evidence", d.update_time ?? "first", "ask for evidence", (requestId) => disputeApi().requireEvidence(d, "SELLER_EVIDENCE", requestId));
  await appendEvent(await getDb(), rentalId, "staff", "dispute.sandbox_evidence_requested", { disputeId: d.dispute_id, debugId: receipt.debugId });
  publish(rentalId, "dispute.sandbox");
  await followUp(rentalId, d);
}

/** Sandbox only: PayPal's test system decides the case (adjudicate). */
export async function sandboxDecide(rentalId: string, outcome: "SELLER_FAVOR" | "BUYER_FAVOR"): Promise<void> {
  sandboxOnly();
  const { stored } = await currentDispute(rentalId);
  const d = await pull(rentalId, stored.id);
  if (!availableActions(d).adjudicate) throw new UserError(notOffered("decide the case", d));
  const receipt = await guarded(rentalId, d, "adjudicate", "once", "decide the case", (requestId) => disputeApi().adjudicate(d, outcome, requestId));
  await appendEvent(await getDb(), rentalId, "staff", "dispute.sandbox_decided", { disputeId: d.dispute_id, outcome, debugId: receipt.debugId });
  publish(rentalId, "dispute.sandbox");
  await followUp(rentalId, d);
}

/**
 * Demo mode only: the customer files a billing claim, as the sandbox buyer
 * did on 2026-10-02 ("charged the wrong amount", saying $15.00 was right).
 */
export async function demoOpenDispute(rentalId: string): Promise<void> {
  const api = disputeApi();
  if (!(api instanceof DemoDisputeApi)) throw new UserError("Outside demo mode, the customer opens a dispute in PayPal itself.");
  const rental = await mustRental(rentalId);
  if (rental.status !== "settled") throw new UserError("Only a settled rental can be disputed.");
  if ((await disputesFor(await getDb(), rentalId)).length > 0) throw new UserError("This rental already has a dispute.");
  const damage = Boolean(rental.settlementCaptureId && rental.capturedCents);
  const captureId = damage ? rental.settlementCaptureId! : rental.feeCaptureId;
  const cents = damage ? rental.capturedCents! : rental.feeCents;
  if (!captureId) throw new UserError("Nothing was captured on PayPal for this rental.");
  const d = await api.open({
    sellerTransactionId: captureId,
    transactionCents: cents,
    disputedCents: cents > 1500 ? cents - 1500 : cents,
    reason: "INCORRECT_AMOUNT",
    note: "I returned the kit complete. I should not have been charged this much.",
    custom: rental.id,
    invoiceNumber: damage ? `${rental.id}-damage` : `${rental.id}-fee`,
  });
  const db = await getDb();
  await db.tx((tx) => recordDispute(tx, rentalId, d, "demo"));
  publish(rentalId, "dispute.opened");
}

// ─── What the counter's panel shows ─────────────────────────

export type DisputeDesk = {
  dispute: StoredDispute;
  /** PayPal's last full view, when the stored object is complete. */
  paypal: Dispute | null;
  actions: DisputeActions;
  requested: string[];
  recommendation: Recommendation;
  pack: (StoredPack & { current: boolean }) | null;
  sent: { sha256: string; at: string; evidenceType: string; files: string[] }[];
  /** The disputed amount PayPal held from the shop's balance, if PayPal reported it. */
  hold: { cents: Cents; placedAt: string | null; releasedAt: string | null } | null;
  mode: PayPalMode;
};

export async function loadDisputeDesk(view: RentalView): Promise<DisputeDesk | null> {
  const { rental } = view;
  const db = await getDb();
  const [stored] = await disputesFor(db, rental.id);
  if (!stored) return null;
  const parsed = DisputeSchema.safeParse(stored.paypal);
  const paypal = parsed.success ? parsed.data : null;
  const actions = paypal
    ? availableActions(paypal)
    : { provideEvidence: false, acceptClaim: null, makeOffer: null, escalate: false, sendMessage: false, provideSupportingInfo: false, appeal: false, requireEvidence: false, adjudicate: false };

  const charged = (view.assessment?.findings ?? []).filter(isCharged);
  const sum = (fs: typeof charged) => fs.reduce((s, f) => s + (f.price?.cents ?? 0), 0);
  const tx = stored.transactionId;
  const disputedCapture = tx && tx === rental.settlementCaptureId ? "settlement" : tx && tx === rental.feeCaptureId ? "fee" : tx && tx === rental.extraCaptureId ? "extra" : "unknown";
  const knownCents = disputedCapture === "settlement" ? rental.capturedCents : disputedCapture === "fee" ? rental.feeCents : disputedCapture === "extra" ? rental.extraCents : null;
  const recommendation = recommend({
    status: stored.status,
    stage: stored.stage,
    reason: stored.reason,
    disputedCents: stored.amountCents ?? 0,
    transactionCents: usdCents(paypal?.disputed_transactions?.[0]?.gross_amount) ?? knownCents ?? stored.amountCents ?? 0,
    actions,
    record: {
      pickupPhoto: Boolean(view.checkout),
      pickupConfirmed: Boolean(view.checkout?.acknowledgedAt),
      returnPhoto: Boolean(view.checkin),
      chainIntact: view.chainIntact,
      disputedCapture,
      acceptedCents: sum(charged.filter((f) => f.customer === "accept")),
      upheldCents: sum(charged.filter((f) => f.customer === "contest")),
    },
  });

  const latest = await latestPack(db, rental.id, stored.id);
  const nowFacts = buildEvidenceFacts({
    shop: SHOP,
    rental,
    itemName: view.item.name,
    checkout: view.checkout,
    checkin: view.checkin,
    assessment: view.assessment,
    events: view.events,
    dispute: disputeFacts(stored),
  });
  const sent = view.events
    .filter((e) => e.type === "dispute.evidence_sent" && e.data.disputeId === stored.id)
    .map((e) => ({ sha256: String(e.data.sha256), at: e.at, evidenceType: String(e.data.evidenceType), files: (e.data.files as string[]) ?? [] }));
  const moves = paypal?.fund_movements ?? [];
  const placed = moves.find((m) => m.reason === "HOLD_PLACED");
  const released = moves.find((m) => m.reason === "HOLD_RELEASED");
  return {
    dispute: stored,
    paypal,
    actions,
    requested: paypal ? requestedEvidence(paypal) : [],
    recommendation,
    pack: latest ? { ...latest, current: latest.factsSha === factsSha(nowFacts) } : null,
    sent,
    hold: placed?.amount ? { cents: usdCents(placed.amount) ?? 0, placedAt: placed.initiated_time ?? null, releasedAt: released?.initiated_time ?? null } : null,
    mode: disputeApi().mode,
  };
}
