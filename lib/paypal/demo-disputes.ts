import { fromPayPalValue, toPayPalValue, type Cents } from "@/lib/money";
import {
  actionLink,
  DisputeActionUnavailable,
  DisputeSchema,
  evidenceParts,
  type AcceptClaim,
  type ActionReceipt,
  type Dispute,
  type DisputeApi,
  type DisputeQuery,
  type DisputeSummary,
  type EvidenceSubmission,
  type Offer,
} from "./dispute-model";
import { PayPalError } from "./errors";

const DAY_MS = 86_400_000;
const BASE = "https://api-m.sandbox.paypal.com/v1/customer/disputes";

export type DemoDisputeState = { seq: number; disputes: Record<string, Dispute> };

export interface DemoDisputeStore {
  load(): Promise<DemoDisputeState | null>;
  save(state: DemoDisputeState): Promise<void>;
}

/** 23:59:59 Pacific on the day `days` from now, which is how the sandbox set due dates. */
function dueIn(now: Date, days: number): string {
  const d = new Date(now.getTime() + days * DAY_MS);
  return `${new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString().slice(0, 10)}T06:59:59.000Z`;
}

const link = (id: string, rel: string, method = "POST") => ({ href: rel === "self" ? `${BASE}/${id}` : `${BASE}/${id}/${rel.replace(/_/g, "-")}`, rel, method });

export type DemoOpen = {
  sellerTransactionId: string;
  transactionCents: Cents;
  disputedCents: Cents;
  reason: "INCORRECT_AMOUNT" | "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED";
  note: string;
  custom: string | null;
  invoiceNumber: string | null;
};

/**
 * A stand-in for the Disputes API in demo mode. Its transitions copy what
 * the sandbox did with a billing claim on 2026-10-02
 * (docs/paypal-sandbox-notes.md): the claim asks the seller for evidence,
 * evidence moves it to UNDER_REVIEW, require-evidence asks again, and
 * adjudicate resolves it. The sandbox took minutes between steps; the
 * stand-in moves at once. Like the real API, it refuses any action whose
 * link it did not offer.
 */
export class DemoDisputeApi implements DisputeApi {
  readonly mode = "demo" as const;
  private state: DemoDisputeState = { seq: 0, disputes: {} };
  private loaded: Promise<void> | undefined;

  /**
   * `moneyBack` is told when a decision for the buyer returns money on a
   * capture, so the demo gateway lowers what is left to refund on it, as
   * PayPal does.
   */
  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly store: DemoDisputeStore = { load: async () => null, save: async () => {} },
    private readonly moneyBack: (captureId: string, cents: Cents) => Promise<void> = async () => {},
  ) {}

  private async ready() {
    this.loaded ??= this.store.load().then((s) => {
      if (s) this.state = s;
    });
    await this.loaded;
  }

  /** Applies a change; a field patched to undefined is removed, as PayPal leaves it out of the JSON. */
  private async change(d: Dispute, patch: Partial<Dispute>): Promise<ActionReceipt> {
    const merged: Record<string, unknown> = { ...this.state.disputes[d.dispute_id], ...patch, update_time: this.now().toISOString() };
    for (const [k, v] of Object.entries(patch)) if (v === undefined) delete merged[k];
    const next = DisputeSchema.parse(merged);
    this.state.disputes[d.dispute_id] = next;
    await this.store.save(this.state);
    return { status: 200, debugId: `demo-${next.update_time}` };
  }

  private current(d: Dispute, action: string): Dispute {
    const stored = this.state.disputes[d.dispute_id];
    if (!stored) throw new PayPalError(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID", "demo-not-found", "Dispute not found.");
    if (!actionLink(stored, action)) throw new DisputeActionUnavailable(action, stored.status, stored.dispute_life_cycle_stage);
    return stored;
  }

  /** Demo only: the customer files a billing claim in PayPal's Resolution Center. */
  async open(o: DemoOpen): Promise<Dispute> {
    await this.ready();
    this.state.seq += 1;
    const id = `PP-D-DEMO-${String(this.state.seq).padStart(4, "0")}`;
    const at = this.now().toISOString();
    const money = (c: Cents) => ({ currency_code: "USD", value: toPayPalValue(c) });
    const dispute = DisputeSchema.parse({
      dispute_id: id,
      create_time: at,
      update_time: at,
      disputed_transactions: [
        {
          buyer_transaction_id: `DEMOBUYER${String(this.state.seq).padStart(8, "0")}`,
          seller_transaction_id: o.sellerTransactionId,
          create_time: at,
          transaction_status: "COMPLETED",
          gross_amount: money(o.transactionCents),
          ...(o.invoiceNumber ? { invoice_number: o.invoiceNumber } : {}),
          ...(o.custom ? { custom: o.custom } : {}),
        },
      ],
      reason: o.reason,
      status: "WAITING_FOR_SELLER_RESPONSE",
      dispute_state: "REQUIRED_ACTION",
      dispute_amount: money(o.disputedCents),
      dispute_life_cycle_stage: "CHARGEBACK",
      dispute_channel: "INTERNAL",
      evidences: [
        { evidence_type: "CREATE", notes: o.note, source: "SUBMITTED_BY_BUYER", date: at, dispute_life_cycle_stage: "CHARGEBACK" },
        { evidence_type: "PROOF_OF_REFUND", source: "REQUESTED_FROM_SELLER", date: at },
        { evidence_type: "OTHER", source: "REQUESTED_FROM_SELLER", date: at },
      ],
      seller_response_due_date: dueIn(this.now(), 10),
      // The sandbox held the disputed amount from the seller about 3.5 minutes after filing.
      fund_movements: [{ party: "RECEIVER", amount: money(o.disputedCents), initiated_time: at, type: "DEBIT", reason: "HOLD_PLACED" }],
      offer: { buyer_requested_amount: money(o.disputedCents) },
      refund_details: { allowed_refund_amount: money(o.disputedCents) },
      allowed_response_options: { accept_claim: { accept_claim_types: ["REFUND"] } },
      links: [link(id, "self", "GET"), link(id, "provide_evidence"), link(id, "accept_claim")],
    });
    this.state.disputes[id] = dispute;
    await this.store.save(this.state);
    return dispute;
  }

  async get(disputeId: string): Promise<Dispute> {
    await this.ready();
    const d = this.state.disputes[disputeId];
    if (!d) throw new PayPalError(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID", "demo-not-found", "Dispute not found.");
    return structuredClone(d);
  }

  async list(q: DisputeQuery): Promise<DisputeSummary[]> {
    await this.ready();
    return Object.values(this.state.disputes)
      .filter((d) => !q.disputedTransactionId || d.disputed_transactions?.some((t) => t.seller_transaction_id === q.disputedTransactionId))
      .filter((d) => !q.updateTimeAfter || (d.update_time ?? "") > q.updateTimeAfter)
      .map((d) => structuredClone(d));
  }

  async provideEvidence(d: Dispute, s: EvidenceSubmission, requestId: string): Promise<ActionReceipt> {
    void requestId;
    await this.ready();
    const cur = this.current(d, "provide_evidence");
    evidenceParts(s); // the same checks as a real upload
    const at = this.now().toISOString();
    return this.change(cur, {
      status: "UNDER_REVIEW",
      dispute_state: "UNDER_PAYPAL_REVIEW",
      seller_response_due_date: undefined,
      evidences: [
        ...(cur.evidences ?? []).filter((e) => e.source !== "REQUESTED_FROM_SELLER"),
        { evidence_type: s.evidenceType, notes: s.notes.trim(), source: "SUBMITTED_BY_SELLER", date: at, documents: s.files.map((f) => ({ name: f.name })), dispute_life_cycle_stage: cur.dispute_life_cycle_stage },
      ],
      links: [link(cur.dispute_id, "self", "GET"), link(cur.dispute_id, "provide_supporting_info"), link(cur.dispute_id, "adjudicate"), link(cur.dispute_id, "require_evidence"), link(cur.dispute_id, "accept_claim")],
    });
  }

  async acceptClaim(d: Dispute, a: AcceptClaim, requestId: string): Promise<ActionReceipt> {
    void requestId;
    await this.ready();
    const cur = this.current(d, "accept_claim");
    const refunded = a.type === "PARTIAL_REFUND" && a.refundCents ? toPayPalValue(a.refundCents) : cur.dispute_amount.value;
    // Not seen in the sandbox yet: only the refund is recorded, no fee.
    return this.resolve(cur, "RESOLVED_BUYER_FAVOUR", refunded, null);
  }

  async makeOffer(d: Dispute, o: Offer, requestId: string): Promise<ActionReceipt> {
    void requestId;
    await this.ready();
    const cur = this.current(d, "make_offer");
    return this.change(cur, {
      status: "WAITING_FOR_BUYER_RESPONSE",
      dispute_state: "REQUIRED_OTHER_PARTY_ACTION",
      offer: { ...cur.offer, seller_offered_amount: { currency_code: "USD", value: toPayPalValue(o.amountCents) }, offer_type: o.type },
      links: [link(cur.dispute_id, "self", "GET")],
    });
  }

  async escalate(d: Dispute, note: string, requestId: string): Promise<ActionReceipt> {
    void note;
    void requestId;
    await this.ready();
    const cur = this.current(d, "escalate");
    return this.change(cur, {
      status: "UNDER_REVIEW",
      dispute_state: "UNDER_PAYPAL_REVIEW",
      dispute_life_cycle_stage: "CHARGEBACK",
      links: [link(cur.dispute_id, "self", "GET"), link(cur.dispute_id, "provide_supporting_info"), link(cur.dispute_id, "adjudicate"), link(cur.dispute_id, "require_evidence")],
    });
  }

  async requireEvidence(d: Dispute, action: "SELLER_EVIDENCE" | "BUYER_EVIDENCE", requestId: string): Promise<ActionReceipt> {
    void requestId;
    await this.ready();
    const cur = this.current(d, "require_evidence");
    const at = this.now().toISOString();
    if (action === "BUYER_EVIDENCE") {
      return this.change(cur, { status: "WAITING_FOR_BUYER_RESPONSE", dispute_state: "REQUIRED_OTHER_PARTY_ACTION", links: [link(cur.dispute_id, "self", "GET")] });
    }
    return this.change(cur, {
      status: "WAITING_FOR_SELLER_RESPONSE",
      dispute_state: "REQUIRED_ACTION",
      seller_response_due_date: dueIn(this.now(), 3),
      evidences: [
        ...(cur.evidences ?? []),
        ...["PROOF_OF_FULFILLMENT", "PROOF_OF_REFUND", "PROOF_OF_DELIVERY_SIGNATURE"].map((t) => ({ evidence_type: t, source: "REQUESTED_FROM_SELLER", date: at })),
      ],
      links: [link(cur.dispute_id, "self", "GET"), link(cur.dispute_id, "accept_claim"), link(cur.dispute_id, "provide_evidence")],
    });
  }

  async adjudicate(d: Dispute, outcome: "SELLER_FAVOR" | "BUYER_FAVOR", requestId: string): Promise<ActionReceipt> {
    void requestId;
    await this.ready();
    const cur = this.current(d, "adjudicate");
    // As the sandbox decided on 2026-10-02: for the seller the hold is released (adjudication
    // DENY_BUYER); for the buyer the seller pays the disputed amount and the $15.00 Standard
    // dispute fee (RECOVER_FROM_SELLER).
    return outcome === "SELLER_FAVOR"
      ? this.resolve(cur, "RESOLVED_SELLER_FAVOUR", null, null, "DENY_BUYER")
      : this.resolve(cur, "RESOLVED_BUYER_FAVOUR", cur.dispute_amount.value, "15.00", "RECOVER_FROM_SELLER");
  }

  private async resolve(cur: Dispute, outcome: string, refunded: string | null, fee: string | null, adjudication: string | null = null): Promise<ActionReceipt> {
    const at = this.now().toISOString();
    const captureId = cur.disputed_transactions?.[0]?.seller_transaction_id;
    if (refunded && captureId) await this.moneyBack(captureId, fromPayPalValue(refunded));
    const usd = (value: string) => ({ currency_code: "USD", value });
    const held = (cur.fund_movements ?? []).find((m) => m.reason === "HOLD_PLACED");
    const moves = refunded
      ? [
          { party: "SELLER", amount: usd(refunded), initiated_time: at, type: "DEBIT", reason: "DISPUTE_SETTLEMENT" },
          ...(fee ? [{ party: "SELLER", amount: usd(fee), initiated_time: at, type: "DEBIT", reason: "DISPUTE_FEE" }] : []),
          { party: "BUYER", amount: usd(refunded), initiated_time: at, type: "CREDIT", reason: "DISPUTE_SETTLEMENT" },
        ]
      : held
        ? [{ party: "RECEIVER", amount: held.amount, initiated_time: at, type: "CREDIT", reason: "HOLD_RELEASED" }]
        : [];
    return this.change(cur, {
      status: "RESOLVED",
      dispute_state: "RESOLVED",
      seller_response_due_date: undefined,
      dispute_outcome: { outcome_code: outcome, ...(refunded ? { amount_refunded: usd(refunded) } : {}) },
      ...(adjudication ? { adjudications: [...(cur.adjudications ?? []), { type: adjudication, adjudication_time: at, dispute_life_cycle_stage: cur.dispute_life_cycle_stage }] } : {}),
      fund_movements: [...(cur.fund_movements ?? []), ...moves],
      links: [link(cur.dispute_id, "self", "GET")],
    });
  }
}
