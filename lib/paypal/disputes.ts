import "server-only";
import { toPayPalValue } from "@/lib/money";
import { paypalConfig } from "./config";
import {
  actionLink,
  DISPUTE_ID,
  DisputeActionUnavailable,
  DisputeListSchema,
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
import { paypalRequest } from "./rest";

/**
 * Disputes v1 over REST (the Server SDK has no Disputes controller). Every
 * action follows the HATEOAS link PayPal returned with the dispute: if the
 * link is missing the action is refused here, before any request is made,
 * and a link is only followed to PayPal's own API host.
 */
export class PayPalDisputeApi implements DisputeApi {
  constructor(readonly mode: "sandbox" | "live") {}

  async get(disputeId: string): Promise<Dispute> {
    if (!DISPUTE_ID.test(disputeId)) throw new RangeError(`not a dispute id: ${disputeId}`);
    const { data, debugId } = await paypalRequest<unknown>("GET", `/v1/customer/disputes/${disputeId}`);
    return parse(DisputeSchema, data, debugId);
  }

  async list(q: DisputeQuery): Promise<DisputeSummary[]> {
    const params = new URLSearchParams();
    if (q.disputedTransactionId) params.set("disputed_transaction_id", q.disputedTransactionId);
    if (q.updateTimeAfter) params.set("update_time_after", q.updateTimeAfter);
    params.set("page_size", String(Math.min(50, Math.max(1, q.pageSize ?? 20))));
    const { data, debugId } = await paypalRequest<unknown>("GET", `/v1/customer/disputes?${params}`);
    return parse(DisputeListSchema, data, debugId).items ?? [];
  }

  /** multipart/form-data: the "input" JSON part, then the files. */
  async provideEvidence(d: Dispute, s: EvidenceSubmission, requestId: string): Promise<ActionReceipt> {
    const parts = evidenceParts(s);
    return receipt(await paypalRequest("POST", this.path(d, "provide_evidence"), { multipart: parts, requestId }));
  }

  async acceptClaim(d: Dispute, a: AcceptClaim, requestId: string): Promise<ActionReceipt> {
    const path = this.path(d, "accept_claim");
    const allowed = d.allowed_response_options?.accept_claim?.accept_claim_types ?? [];
    if (a.type && allowed.length > 0 && !allowed.includes(a.type)) throw new DisputeActionUnavailable(`accept_claim ${a.type}`, d.status, d.dispute_life_cycle_stage);
    if (a.type === "PARTIAL_REFUND" && !a.refundCents) throw new RangeError("a partial refund needs an amount");
    const body = {
      note: a.note.slice(0, 2000),
      ...(a.type ? { accept_claim_type: a.type } : {}),
      ...(a.type === "PARTIAL_REFUND" ? { refund_amount: money(d, a.refundCents!) } : {}),
    };
    return receipt(await paypalRequest("POST", path, { body, requestId }));
  }

  async makeOffer(d: Dispute, o: Offer, requestId: string): Promise<ActionReceipt> {
    const path = this.path(d, "make_offer");
    const allowed = d.allowed_response_options?.make_offer?.offer_types ?? [];
    if (allowed.length > 0 && !allowed.includes(o.type)) throw new DisputeActionUnavailable(`make_offer ${o.type}`, d.status, d.dispute_life_cycle_stage);
    const body = { note: o.note.slice(0, 2000), offer_type: o.type, offer_amount: money(d, o.amountCents) };
    return receipt(await paypalRequest("POST", path, { body, requestId }));
  }

  async escalate(d: Dispute, note: string, requestId: string): Promise<ActionReceipt> {
    return receipt(await paypalRequest("POST", this.path(d, "escalate"), { body: { note: note.slice(0, 2000) }, requestId }));
  }

  async requireEvidence(d: Dispute, action: "SELLER_EVIDENCE" | "BUYER_EVIDENCE", requestId: string): Promise<ActionReceipt> {
    this.sandboxOnly("require-evidence");
    return receipt(await paypalRequest("POST", this.path(d, "require_evidence"), { body: { action }, requestId }));
  }

  async adjudicate(d: Dispute, outcome: "SELLER_FAVOR" | "BUYER_FAVOR", requestId: string): Promise<ActionReceipt> {
    this.sandboxOnly("adjudicate");
    return receipt(await paypalRequest("POST", this.path(d, "adjudicate"), { body: { adjudication_outcome: outcome }, requestId }));
  }

  private sandboxOnly(action: string) {
    if (this.mode !== "sandbox") throw new Error(`${action} exists only in the PayPal sandbox`);
  }

  /** The path of an action's HATEOAS link, refusing missing links and foreign hosts. */
  private path(d: Dispute, action: string): string {
    const link = actionLink(d, action);
    if (!link) throw new DisputeActionUnavailable(action, d.status, d.dispute_life_cycle_stage);
    const base = new URL(paypalConfig().apiBase);
    const url = new URL(link.href, base);
    if (url.origin !== base.origin) throw new Error(`refusing to follow the ${action} link to ${url.origin}`);
    return `${url.pathname}${url.search}`;
  }
}

function money(d: Dispute, cents: number) {
  if (d.dispute_amount.currency_code !== "USD") throw new RangeError(`Handback only handles USD; this dispute is in ${d.dispute_amount.currency_code}`);
  return { currency_code: "USD", value: toPayPalValue(cents) };
}

function receipt(res: { status: number; debugId: string | null }): ActionReceipt {
  return { status: res.status, debugId: res.debugId };
}

function parse<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { message: string } } }, data: unknown, debugId: string | null): T {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  throw new PayPalError(200, "UNEXPECTED_RESPONSE", undefined, debugId ?? undefined, `PayPal returned a dispute Handback cannot read: ${result.error.message.slice(0, 300)}`);
}
