import { createHash } from "node:crypto";
import type { Db } from "@/lib/db/client";
import type { AuditEvent } from "./types";

type Query = Pick<Db, "query">;

/** JSON with object keys sorted, so a jsonb round trip (which reorders keys) hashes the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function digest(e: Omit<AuditEvent, "seq" | "hash">): string {
  return createHash("sha256")
    .update(canonicalJson({ rentalId: e.rentalId, at: e.at, actor: e.actor, type: e.type, data: e.data, prevHash: e.prevHash }))
    .digest("hex");
}

/**
 * Appends to the rental's audit log. Each entry's hash covers the previous
 * entry's hash, so a changed or deleted entry breaks every hash after it.
 * Tamper-evident, not tamper-proof: anyone with the database can rewrite the
 * whole chain, which is why the customer also gets the photo hashes.
 */
export async function appendEvent(
  db: Query,
  rentalId: string,
  actor: AuditEvent["actor"],
  type: string,
  data: Record<string, unknown> = {},
): Promise<AuditEvent> {
  const prev = await db.query<{ hash: string }>("select hash from events where rental_id = $1 order by seq desc limit 1", [rentalId]);
  const entry = { rentalId, at: new Date().toISOString(), actor, type, data, prevHash: prev[0]?.hash ?? null };
  const hash = digest(entry);
  const rows = await db.query<{ seq: string | number }>(
    "insert into events (rental_id, at, actor, type, data, prev_hash, hash) values ($1, $2, $3, $4, $5::jsonb, $6, $7) returning seq",
    [rentalId, entry.at, actor, type, JSON.stringify(data), entry.prevHash, hash],
  );
  return { seq: Number(rows[0].seq), ...entry, hash };
}

/** Recomputes the chain; returns the seq of the first broken entry, or null if intact. */
export function firstBrokenLink(events: AuditEvent[]): number | null {
  let prev: string | null = null;
  for (const e of events) {
    if (e.prevHash !== prev || digest(e) !== e.hash) return e.seq;
    prev = e.hash;
  }
  return null;
}
