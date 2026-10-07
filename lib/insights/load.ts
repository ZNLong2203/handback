import "server-only";
import { getDb, type Db } from "@/lib/db/client";
import type { Dispute } from "@/lib/paypal/dispute-model";
import { toRental } from "@/lib/rentals/repo";
import type { ReviewedFinding } from "@/lib/rentals/types";
import { buildInsights, type AssessmentRecord, type DisputeRecord, type InsightsData, type PhotoRecord, type RefundRecord } from "./model";

type Query = Pick<Db, "query">;
type Row = Record<string, unknown>;

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : String(v));

/**
 * Reads what the dashboard needs, in six queries, and builds its tables.
 * Columns only: nothing here reads email addresses, payer addresses or the
 * renter's link token, so they cannot reach the dashboard by accident.
 */
export async function loadInsights(now = new Date(), db?: Query): Promise<InsightsData> {
  const q = db ?? (await getDb());
  const [rentalRows, refundRows, disputeRows, assessmentRows, photoRows, unitRows] = await Promise.all([
    q.query<Row>(
      `select id, item_id, customer_name, start_date, end_date, days, fee_cents, deposit_cents, status, booking_order_id, fee_capture_id, vault_id,
              authorization_id, parent_authorization_id, authorized_cents, authorized_at, authorization_expires_at, settlement_capture_id, captured_cents,
              released_cents, extra_capture_id, extra_cents, settled_at, dispute_id, created_at, updated_at, cancelled_at, cancelled_by, cancel_refund_cents,
              hold_requested_at, capture_requested_at, unit_id
       from rentals where status <> 'draft' order by created_at`,
    ),
    q.query<Row>("select id, rental_id, seq, capture_id, amount_cents, state, refund_id, paypal_status, source, created_at from refunds order by created_at"),
    q.query<Row>("select id, rental_id, transaction_id, reason, status, outcome, amount_cents, refunded_cents, opened_at, paypal from disputes"),
    q.query<Row>(
      `select distinct on (rental_id) rental_id, status, findings, created_at from assessments order by rental_id, created_at desc`,
    ),
    q.query<Row>("select rental_id, phase, taken_at from inspections"),
    q.query<Row>("select id, label from units"),
  ]);

  // toRental fills every column it is given; the private ones (email, token, payer email) are not selected.
  const rentals = rentalRows.map((r) =>
    toRental({ ...r, token: "", customer_email: "", payer_email: null, approve_url: null, mandate_json: null, mandate_sha256: null, status_token: null, cancel_reason: null }),
  );
  const refunds: RefundRecord[] = refundRows.map((r) => ({
    id: String(r.id),
    rentalId: String(r.rental_id),
    seq: r.seq === null || r.seq === undefined ? null : Number(r.seq),
    captureId: String(r.capture_id),
    amountCents: Number(r.amount_cents),
    state: r.state as RefundRecord["state"],
    refundId: (r.refund_id as string | null) ?? null,
    paypalStatus: (r.paypal_status as string | null) ?? null,
    source: r.source as RefundRecord["source"],
    createdAt: iso(r.created_at)!,
  }));
  const disputes: DisputeRecord[] = disputeRows.map((d) => ({
    id: String(d.id),
    rentalId: String(d.rental_id),
    transactionId: (d.transaction_id as string | null) ?? null,
    reason: String(d.reason),
    status: String(d.status),
    outcome: (d.outcome as string | null) ?? null,
    amountCents: d.amount_cents === null ? null : Number(d.amount_cents),
    refundedCents: d.refunded_cents === null ? null : Number(d.refunded_cents),
    openedAt: iso(d.opened_at),
    fundMovements: ((d.paypal as Partial<Dispute> | null)?.fund_movements ?? []) as Dispute["fund_movements"],
  }));
  const assessments: AssessmentRecord[] = assessmentRows.map((a) => ({
    rentalId: String(a.rental_id),
    status: String(a.status),
    findings: (a.findings ?? []) as ReviewedFinding[],
    createdAt: iso(a.created_at)!,
  }));
  const photos: PhotoRecord[] = photoRows.map((p) => ({ rentalId: String(p.rental_id), phase: p.phase as PhotoRecord["phase"], takenAt: iso(p.taken_at)! }));
  const units = Object.fromEntries(unitRows.map((u) => [String(u.id), String(u.label)]));
  return buildInsights({ now, rentals, refunds, disputes, assessments, photos, units });
}
