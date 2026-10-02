// The postgres.js driver is what runs on Render (DATABASE_URL set); the rest
// of the suite uses PGlite. The last test needs a real Postgres:
//   TEST_DATABASE_URL=postgres://postgres@localhost:5432/handback_test npx vitest run lib/db
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { jsonParam, postgresOptions } from "./client";

const JSON_OID = 114;
const JSONB_OID = 3802;

describe("jsonParam", () => {
  it("passes JSON text through and encodes anything else once", () => {
    expect(jsonParam('{"a":[1,2]}')).toBe('{"a":[1,2]}');
    expect(jsonParam({ a: [1, 2] })).toBe('{"a":[1,2]}');
    expect(jsonParam([])).toBe("[]");
  });
});

describe("postgres.js type wiring", () => {
  // postgres.js connects on the first query, so building a client here opens nothing.
  const local = "postgres://handback@localhost:5432/handback";

  it("sends json and jsonb parameters through jsonParam, where the default encodes JSON text again", () => {
    const { serializers } = postgres(local, postgresOptions(local)).options;
    for (const oid of [JSON_OID, JSONB_OID]) {
      expect(serializers[oid]('{"findings":[]}')).toBe('{"findings":[]}');
      expect(serializers[oid]({ findings: [] })).toBe('{"findings":[]}');
    }
    expect(postgres(local).options.serializers[JSONB_OID]('{"findings":[]}')).toBe('"{\\"findings\\":[]}"');
  });

  it("parses json and jsonb columns into values", () => {
    const { parsers } = postgres(local, postgresOptions(local)).options;
    for (const oid of [JSON_OID, JSONB_OID]) expect(parsers[oid]('{"a":[1,2]}')).toEqual({ a: [1, 2] });
  });
});

const url = process.env.TEST_DATABASE_URL;

describe.runIf(url)("postgres.js against a real Postgres", () => {
  it("stores jsonb parameters as JSON values, the way PGlite does", async () => {
    process.env.DATABASE_URL = url;
    const { getDb } = await import("./client");
    const db = await getDb();
    const id = `test-${Date.now()}`;
    await db.query("insert into webhook_events (id, event_type, verified, payload) values ($1, 'TEST', true, $2::jsonb)", [
      id,
      JSON.stringify({ findings: [{ id: "f1" }] }),
    ]);
    const [row] = await db.query<{ kind: string; payload: unknown }>(
      "select jsonb_typeof(payload) as kind, payload from webhook_events where id = $1",
      [id],
    );
    await db.query("delete from webhook_events where id = $1", [id]);
    expect(row).toEqual({ kind: "object", payload: { findings: [{ id: "f1" }] } });
  });
});
