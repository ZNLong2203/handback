import { z } from "zod";
import { fromPayPalValue, type Cents } from "@/lib/money";
import type { MultipartPart } from "./multipart";
import type { PayPalMode } from "./config";

// The parts of Disputes v1 (api-m.paypal.com/v1/customer/disputes) that
// Handback reads and writes. Field names and enums come from PayPal's
// published OpenAPI document for Disputes v1.12; limits from
// developer.paypal.com/disputes/supported-file-sizes-types.

const Money = z.object({ currency_code: z.string(), value: z.string() });
export type PayPalMoney = z.infer<typeof Money>;

const Link = z.looseObject({ href: z.string(), rel: z.string(), method: z.string().optional() });

const Evidence = z.looseObject({
  evidence_type: z.string().optional(),
  source: z.string().optional(),
  date: z.string().optional(),
  notes: z.string().optional(),
  documents: z.array(z.looseObject({ name: z.string().optional() })).optional(),
  dispute_life_cycle_stage: z.string().optional(),
});

const Transaction = z.looseObject({
  buyer_transaction_id: z.string().optional(),
  seller_transaction_id: z.string().optional(),
  create_time: z.string().optional(),
  transaction_status: z.string().optional(),
  gross_amount: Money.optional(),
  invoice_number: z.string().optional(),
  custom: z.string().optional(),
});

export const DisputeSchema = z.looseObject({
  dispute_id: z.string(),
  create_time: z.string().optional(),
  update_time: z.string().optional(),
  disputed_transactions: z.array(Transaction).optional(),
  reason: z.string(),
  status: z.string(),
  dispute_state: z.string().optional(),
  dispute_amount: Money,
  dispute_outcome: z.looseObject({ outcome_code: z.string().optional(), outcome_reason: z.string().optional(), amount_refunded: Money.optional() }).optional(),
  adjudications: z.array(z.looseObject({ type: z.string().optional(), adjudication_time: z.string().optional(), reason: z.string().optional() })).optional(),
  /** The sandbox reported the disputed amount held from and released to the seller here (party "RECEIVER"). */
  fund_movements: z
    .array(z.looseObject({ party: z.string().optional(), amount: Money.optional(), initiated_time: z.string().optional(), type: z.string().optional(), reason: z.string().optional() }))
    .optional(),
  dispute_life_cycle_stage: z.string().optional(),
  dispute_channel: z.string().optional(),
  messages: z.array(z.looseObject({ posted_by: z.string().optional(), time_posted: z.string().optional(), content: z.string().optional() })).optional(),
  evidences: z.array(Evidence).optional(),
  seller_response_due_date: z.string().optional(),
  buyer_response_due_date: z.string().optional(),
  offer: z
    .looseObject({ buyer_requested_amount: Money.optional(), seller_offered_amount: Money.optional(), offer_type: z.string().optional() })
    .optional(),
  refund_details: z.looseObject({ allowed_refund_amount: Money.optional() }).optional(),
  allowed_response_options: z
    .looseObject({
      accept_claim: z.looseObject({ accept_claim_types: z.array(z.string()).optional() }).optional(),
      make_offer: z.looseObject({ offer_types: z.array(z.string()).optional() }).optional(),
    })
    .optional(),
  links: z.array(Link).optional(),
});
export type Dispute = z.infer<typeof DisputeSchema>;

/** List results are summaries: no evidences, no allowed_response_options. */
export const DisputeSummarySchema = z.looseObject({
  dispute_id: z.string(),
  create_time: z.string().optional(),
  update_time: z.string().optional(),
  reason: z.string().optional(),
  status: z.string().optional(),
  dispute_amount: Money.optional(),
  dispute_life_cycle_stage: z.string().optional(),
  seller_response_due_date: z.string().optional(),
  disputed_transactions: z.array(Transaction).optional(),
});
export type DisputeSummary = z.infer<typeof DisputeSummarySchema>;
export const DisputeListSchema = z.looseObject({ items: z.array(DisputeSummarySchema).optional() });

export const DISPUTE_ID = /^[A-Za-z0-9-]{1,255}$/;

// ─── What PayPal allows right now ───────────────────────────

const relName = (rel: string) => rel.toLowerCase().replace(/-/g, "_");

/** The HATEOAS link for an action, if PayPal offers it on this dispute right now. */
export function actionLink(d: Pick<Dispute, "links">, action: string) {
  return d.links?.find((l) => relName(l.rel) === action && (l.method ?? "POST").toUpperCase() === "POST");
}

export type DisputeActions = {
  provideEvidence: boolean;
  /** Allowed accept_claim_type values, or null when accepting is not offered. */
  acceptClaim: string[] | null;
  /** Allowed offer_type values, or null when an offer is not possible. */
  makeOffer: string[] | null;
  escalate: boolean;
  sendMessage: boolean;
  provideSupportingInfo: boolean;
  appeal: boolean;
  /** Sandbox only: stand-ins for what PayPal's own agents do. */
  requireEvidence: boolean;
  adjudicate: boolean;
};

/**
 * What the shop can do with this dispute now, read from the links PayPal
 * returned with it rather than guessed from the status: the actions change
 * with the stage, and PayPal's docs say a missing link means the action is
 * not available.
 */
export function availableActions(d: Dispute): DisputeActions {
  const has = (action: string) => Boolean(actionLink(d, action));
  return {
    provideEvidence: has("provide_evidence"),
    acceptClaim: has("accept_claim") ? (d.allowed_response_options?.accept_claim?.accept_claim_types ?? []) : null,
    makeOffer: has("make_offer") ? (d.allowed_response_options?.make_offer?.offer_types ?? []) : null,
    escalate: has("escalate"),
    sendMessage: has("send_message"),
    provideSupportingInfo: has("provide_supporting_info"),
    appeal: has("appeal"),
    requireEvidence: has("require_evidence"),
    adjudicate: has("adjudicate"),
  };
}

export class DisputeActionUnavailable extends Error {
  constructor(
    readonly action: string,
    readonly disputeStatus: string,
    readonly stage: string | undefined,
  ) {
    super(`PayPal does not offer "${action}" on this dispute while it is ${disputeStatus}${stage ? ` (${stage})` : ""}.`);
    this.name = "DisputeActionUnavailable";
  }
}

/**
 * How many times the shop has filed evidence with exactly these document
 * names. Compared before and after an unclear reply to tell whether PayPal
 * filed a submission: the sandbox runs a repeated PayPal-Request-Id again
 * instead of replaying its first answer, so a timeout followed by a retry
 * can end in a 422 although the first request was filed.
 */
export function sellerSubmissions(d: Pick<Dispute, "evidences">, fileNames: string[]): number {
  const want = [...fileNames].sort().join("\n");
  return (d.evidences ?? []).filter(
    (e) =>
      e.source === "SUBMITTED_BY_SELLER" &&
      (e.documents ?? [])
        .map((doc) => doc.name ?? "")
        .sort()
        .join("\n") === want,
  ).length;
}

/** Evidence types PayPal has asked the shop for, oldest request first. */
export function requestedEvidence(d: Dispute): string[] {
  const types = (d.evidences ?? []).filter((e) => e.source === "REQUESTED_FROM_SELLER" && e.evidence_type).map((e) => e.evidence_type!);
  return [...new Set(types)];
}

/**
 * Evidence types an in-store rental record honestly is, in PayPal's words:
 * an explanation of a price difference, documentation of damage, "in-store
 * receipt or online verification ... that the buyer picked up the item", a
 * receipt, purchase or order details, the merchant's response. Not here:
 * shipping labels, tracking, delivery signatures or refund ids, which a
 * counter rental does not have.
 */
const PACK_FITS = new Set([
  "PRICE_DIFFERENCE_REASON",
  "PROOF_OF_DAMAGE",
  "PROOF_OF_INSTORE_RECEIPT",
  "PROOF_OF_RECEIPT_COPY",
  "DETAILS_OF_PURCHASE",
  "ORDER_DETAILS",
  "MERCHANT_RESPONSE",
  "OTHER",
]);

/**
 * The evidence type to file the pack under: the first type PayPal asked for
 * that the pack really is, otherwise OTHER, which the schema allows with
 * notes and documents (and which PayPal's sandbox guide uses for internal
 * disputes).
 */
export function chooseEvidenceType(d: Dispute): string {
  return requestedEvidence(d).find((t) => PACK_FITS.has(t)) ?? "OTHER";
}

// ─── Evidence uploads ───────────────────────────────────────

export const EVIDENCE_TYPES = {
  "application/pdf": ["pdf"],
  "image/jpeg": ["jpg", "jpeg"],
  "image/png": ["png"],
  "image/gif": ["gif"],
} as const;
export type EvidenceContentType = keyof typeof EVIDENCE_TYPES;
/** "Less than 10 MB per file", "up to 50 MB per API call"; read as decimal megabytes to stay on the safe side. */
export const EVIDENCE_MAX_FILE_BYTES = 10_000_000;
export const EVIDENCE_MAX_TOTAL_BYTES = 50_000_000;
/** evidence.notes: maxLength 2000 in the schema. */
export const EVIDENCE_NOTES_MAX = 2000;
/** document.name pattern in the schema: letters, digits, - _ , and spaces, then one extension. */
const DOCUMENT_NAME = /^[A-Za-z0-9\-_,\s]+\.[A-Za-z]+$/;

export type EvidenceFile = { name: string; contentType: EvidenceContentType; bytes: Uint8Array };
export type EvidenceSubmission = { evidenceType: string; notes: string; files: EvidenceFile[] };

/** Field name for each uploaded file, as in PayPal's provide-evidence curl example (`-F 'file1=@NewDoc.pdf'`). */
export const fileField = (i: number) => `file${i + 1}`;

/**
 * Checks a submission against PayPal's documented limits and turns it into
 * the multipart parts: one "input" JSON part with the evidence, then the
 * files. Throws a RangeError naming the first problem.
 */
export function evidenceParts(s: EvidenceSubmission): MultipartPart[] {
  if (!/^[A-Z_]+$/.test(s.evidenceType)) throw new RangeError(`not an evidence type: ${s.evidenceType}`);
  const notes = s.notes.trim();
  if (!notes) throw new RangeError("evidence needs notes");
  if (notes.length > EVIDENCE_NOTES_MAX) throw new RangeError(`evidence notes are ${notes.length} characters; PayPal accepts ${EVIDENCE_NOTES_MAX}`);
  let total = 0;
  for (const f of s.files) {
    const allowed: readonly string[] | undefined = EVIDENCE_TYPES[f.contentType];
    const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
    if (!allowed) throw new RangeError(`PayPal does not accept ${f.contentType} files as evidence`);
    if (!DOCUMENT_NAME.test(f.name) || !allowed.includes(ext)) throw new RangeError(`"${f.name}" is not a file name PayPal accepts for ${f.contentType}`);
    if (f.bytes.byteLength === 0) throw new RangeError(`"${f.name}" is empty`);
    if (f.bytes.byteLength >= EVIDENCE_MAX_FILE_BYTES) throw new RangeError(`"${f.name}" is ${f.bytes.byteLength} bytes; each file must be under 10 MB`);
    total += f.bytes.byteLength;
  }
  if (total > EVIDENCE_MAX_TOTAL_BYTES) throw new RangeError(`the files add up to ${total} bytes; one submission can carry 50 MB`);
  return [
    { name: "input", json: { evidences: [{ evidence_type: s.evidenceType, notes }] } },
    ...s.files.map((f, i) => ({ name: fileField(i), filename: f.name, contentType: f.contentType, bytes: f.bytes })),
  ];
}

// ─── Reading amounts ────────────────────────────────────────

/** A USD amount in cents, or null for any other currency (Handback is USD only). */
export function usdCents(m: PayPalMoney | undefined): Cents | null {
  if (!m || m.currency_code !== "USD") return null;
  return fromPayPalValue(m.value);
}

// ─── The API, real or stand-in ──────────────────────────────

export type DisputeQuery = { disputedTransactionId?: string; updateTimeAfter?: string; pageSize?: number };
export type AcceptClaim = { note: string; type?: "REFUND" | "PARTIAL_REFUND"; refundCents?: Cents };
export type Offer = { note: string; type: "REFUND"; amountCents: Cents };
/**
 * What a successful action returned: PayPal's debug id is kept for the audit
 * log. `confirmedByRead` marks an action whose reply was lost or unclear and
 * that a fresh read of the dispute showed PayPal had carried out.
 */
export type ActionReceipt = { status: number; debugId: string | null; confirmedByRead?: true };

export interface DisputeApi {
  readonly mode: PayPalMode;
  get(disputeId: string): Promise<Dispute>;
  list(q: DisputeQuery): Promise<DisputeSummary[]>;
  provideEvidence(d: Dispute, s: EvidenceSubmission, requestId: string): Promise<ActionReceipt>;
  acceptClaim(d: Dispute, a: AcceptClaim, requestId: string): Promise<ActionReceipt>;
  makeOffer(d: Dispute, o: Offer, requestId: string): Promise<ActionReceipt>;
  escalate(d: Dispute, note: string, requestId: string): Promise<ActionReceipt>;
  /** Sandbox only. */
  requireEvidence(d: Dispute, action: "SELLER_EVIDENCE" | "BUYER_EVIDENCE", requestId: string): Promise<ActionReceipt>;
  /** Sandbox only. */
  adjudicate(d: Dispute, outcome: "SELLER_FAVOR" | "BUYER_FAVOR", requestId: string): Promise<ActionReceipt>;
}
