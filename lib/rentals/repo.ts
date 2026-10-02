import "server-only";
import type { Db } from "@/lib/db/client";
import type { Assessment, AuditEvent, Inspection, Rental } from "./types";

type Query = Pick<Db, "query">;
type Row = Record<string, unknown>;

const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : (v as string | null));
const day = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

function mapRow<T>(row: Row): T {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) out[camel(k)] = v instanceof Date ? v.toISOString() : v;
  return out as T;
}

function toRental(row: Row): Rental {
  const r = mapRow<Rental>(row);
  return { ...r, startDate: day(row.start_date), endDate: day(row.end_date) };
}

export async function rentalById(db: Query, id: string): Promise<Rental | null> {
  const rows = await db.query<Row>("select * from rentals where id = $1", [id]);
  return rows[0] ? toRental(rows[0]) : null;
}

export async function rentalByToken(db: Query, token: string): Promise<Rental | null> {
  const rows = await db.query<Row>("select * from rentals where token = $1", [token]);
  return rows[0] ? toRental(rows[0]) : null;
}

export async function rentalByOrder(db: Query, orderId: string): Promise<Rental | null> {
  const rows = await db.query<Row>("select * from rentals where booking_order_id = $1", [orderId]);
  return rows[0] ? toRental(rows[0]) : null;
}

export async function rentalByAuthorization(db: Query, authorizationId: string): Promise<Rental | null> {
  const rows = await db.query<Row>(
    "select * from rentals where authorization_id = $1 or parent_authorization_id = $1",
    [authorizationId],
  );
  return rows[0] ? toRental(rows[0]) : null;
}

export async function listRentals(db: Query): Promise<Rental[]> {
  const rows = await db.query<Row>("select * from rentals where status <> 'draft' order by updated_at desc limit 200");
  return rows.map(toRental);
}

/** Updates the given columns (snake_case keys) and bumps updated_at. */
export async function updateRental(db: Query, id: string, fields: Record<string, unknown>): Promise<void> {
  const keys = Object.keys(fields);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
  await db.query(`update rentals set ${sets}${keys.length ? ", " : ""}updated_at = now() where id = $1`, [id, ...keys.map((k) => fields[k])]);
}

export async function inspectionsFor(db: Query, rentalId: string): Promise<Inspection[]> {
  const rows = await db.query<Row>("select * from inspections where rental_id = $1 order by taken_at", [rentalId]);
  return rows.map((r) => ({ ...mapRow<Inspection>(r), takenAt: iso(r.taken_at)!, acknowledgedAt: iso(r.acknowledged_at) }));
}

export async function latestAssessment(db: Query, rentalId: string): Promise<Assessment | null> {
  const rows = await db.query<Row>("select * from assessments where rental_id = $1 order by created_at desc limit 1", [rentalId]);
  if (!rows[0]) return null;
  const { looks: _looks, ...rest } = rows[0];
  return mapRow<Assessment>(rest);
}

export async function eventsFor(db: Query, rentalId: string): Promise<AuditEvent[]> {
  const rows = await db.query<Row>("select * from events where rental_id = $1 order by seq", [rentalId]);
  return rows.map((r) => ({ ...mapRow<AuditEvent>(r), seq: Number(r.seq) }));
}
