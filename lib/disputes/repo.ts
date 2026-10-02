import "server-only";
import type { Db } from "@/lib/db/client";
import type { Dispute } from "@/lib/paypal/dispute-model";
import type { EvidenceFacts } from "./facts";
import type { Narrative } from "./narrative";

type Query = Pick<Db, "query">;
type Row = Record<string, unknown>;

export type StoredDispute = {
  id: string;
  rentalId: string;
  transactionId: string | null;
  reason: string;
  status: string;
  stage: string | null;
  amountCents: number | null;
  sellerResponseDueAt: string | null;
  outcome: string | null;
  refundedCents: number | null;
  /** The last dispute object PayPal returned, or the webhook resource. */
  paypal: Partial<Dispute> & { dispute_id: string };
  paypalUpdateTime: string | null;
  openedAt: string | null;
  syncedAt: string;
};

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : ((v as string | null) ?? null));
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

function toDispute(r: Row): StoredDispute {
  return {
    id: String(r.id),
    rentalId: String(r.rental_id),
    transactionId: (r.transaction_id as string | null) ?? null,
    reason: String(r.reason),
    status: String(r.status),
    stage: (r.stage as string | null) ?? null,
    amountCents: num(r.amount_cents),
    sellerResponseDueAt: iso(r.seller_response_due_at),
    outcome: (r.outcome as string | null) ?? null,
    refundedCents: num(r.refunded_cents),
    paypal: r.paypal as StoredDispute["paypal"],
    paypalUpdateTime: iso(r.paypal_update_time),
    openedAt: iso(r.opened_at),
    syncedAt: iso(r.synced_at)!,
  };
}

export async function disputeById(db: Query, id: string): Promise<StoredDispute | null> {
  const rows = await db.query<Row>("select * from disputes where id = $1", [id]);
  return rows[0] ? toDispute(rows[0]) : null;
}

/** The rental's disputes, newest first. */
export async function disputesFor(db: Query, rentalId: string): Promise<StoredDispute[]> {
  const rows = await db.query<Row>("select * from disputes where rental_id = $1 order by opened_at desc nulls last, id", [rentalId]);
  return rows.map(toDispute);
}

export async function saveDispute(db: Query, d: Omit<StoredDispute, "syncedAt">): Promise<void> {
  await db.query(
    `insert into disputes (id, rental_id, transaction_id, reason, status, stage, amount_cents, seller_response_due_at, outcome, refunded_cents, paypal, paypal_update_time, opened_at, synced_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, now())
     on conflict (id) do update set transaction_id = excluded.transaction_id, reason = excluded.reason, status = excluded.status, stage = excluded.stage,
       amount_cents = excluded.amount_cents, seller_response_due_at = excluded.seller_response_due_at, outcome = excluded.outcome,
       refunded_cents = excluded.refunded_cents, paypal = excluded.paypal, paypal_update_time = excluded.paypal_update_time,
       opened_at = coalesce(disputes.opened_at, excluded.opened_at), synced_at = now()`,
    [
      d.id,
      d.rentalId,
      d.transactionId,
      d.reason,
      d.status,
      d.stage,
      d.amountCents,
      d.sellerResponseDueAt,
      d.outcome,
      d.refundedCents,
      JSON.stringify(d.paypal),
      d.paypalUpdateTime,
      d.openedAt,
    ],
  );
}

export async function rentalIdForDispute(db: Query, disputeId: string): Promise<string | null> {
  const rows = await db.query<{ rental_id: string }>(
    "select rental_id from disputes where id = $1 union select id as rental_id from rentals where dispute_id = $1 limit 1",
    [disputeId],
  );
  return rows[0]?.rental_id ?? null;
}

// ─── Evidence packs ─────────────────────────────────────────

export type StoredPack = {
  sha256: string;
  rentalId: string;
  disputeId: string | null;
  factsSha: string;
  facts: EvidenceFacts;
  narrative: Narrative;
  createdAt: string;
};

function toPack(r: Row): StoredPack {
  return {
    sha256: String(r.sha256),
    rentalId: String(r.rental_id),
    disputeId: (r.dispute_id as string | null) ?? null,
    factsSha: String(r.facts_sha),
    facts: r.facts as EvidenceFacts,
    narrative: r.narrative as Narrative,
    createdAt: iso(r.created_at)!,
  };
}

const PACK_COLUMNS = "sha256, rental_id, dispute_id, facts_sha, facts, narrative, created_at";

export async function packByFacts(db: Query, factsSha: string): Promise<StoredPack | null> {
  const rows = await db.query<Row>(`select ${PACK_COLUMNS} from evidence_packs where facts_sha = $1 order by created_at limit 1`, [factsSha]);
  return rows[0] ? toPack(rows[0]) : null;
}

export async function latestPack(db: Query, rentalId: string, disputeId: string): Promise<StoredPack | null> {
  const rows = await db.query<Row>(`select ${PACK_COLUMNS} from evidence_packs where rental_id = $1 and dispute_id = $2 order by created_at desc limit 1`, [
    rentalId,
    disputeId,
  ]);
  return rows[0] ? toPack(rows[0]) : null;
}

export async function insertPack(db: Query, p: Omit<StoredPack, "createdAt">, bytes: Uint8Array): Promise<void> {
  await db.query(
    `insert into evidence_packs (sha256, rental_id, dispute_id, facts_sha, facts, narrative, bytes) values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)
     on conflict (sha256) do nothing`,
    [p.sha256, p.rentalId, p.disputeId, p.factsSha, JSON.stringify(p.facts), JSON.stringify(p.narrative), Buffer.from(bytes)],
  );
}

export async function packBytes(db: Query, sha256: string): Promise<{ bytes: Buffer; rentalId: string } | null> {
  if (!/^[0-9a-f]{64}$/.test(sha256)) return null;
  const rows = await db.query<{ bytes: Uint8Array; rental_id: string }>("select bytes, rental_id from evidence_packs where sha256 = $1", [sha256]);
  return rows[0] ? { bytes: Buffer.from(rows[0].bytes), rentalId: rows[0].rental_id } : null;
}

// ─── The double-submit guard ────────────────────────────────

/**
 * Claims one dispute action for one PayPal request round. Returns false when
 * the same action is already in flight or done for that round; a failed or
 * abandoned attempt (pending for over two minutes) can be claimed again.
 */
export async function claimAction(db: Query, disputeId: string, action: string, round: string, requestId: string): Promise<boolean> {
  const rows = await db.query<{ state: string }>(
    `insert into dispute_actions (dispute_id, action, round, request_id, state) values ($1, $2, $3, $4, 'pending')
     on conflict (dispute_id, action, round) do update set state = 'pending', request_id = excluded.request_id, created_at = now(), debug_id = null
       where dispute_actions.state = 'failed' or (dispute_actions.state = 'pending' and dispute_actions.created_at < now() - interval '2 minutes')
     returning state`,
    [disputeId, action, round, requestId],
  );
  return rows.length === 1;
}

export async function finishAction(db: Query, disputeId: string, action: string, round: string, state: "done" | "failed", debugId: string | null): Promise<void> {
  await db.query("update dispute_actions set state = $4, debug_id = $5 where dispute_id = $1 and action = $2 and round = $3", [disputeId, action, round, state, debugId]);
}
