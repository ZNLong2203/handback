import "server-only";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

// One small interface over two drivers: postgres.js against a real Postgres
// when DATABASE_URL is set (Render), and PGlite, an in-process Postgres, for
// local runs and tests, so the app works with zero setup.

export interface Db {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  /** Runs fn in one transaction; the tx object has the same query method. */
  tx<T>(fn: (tx: Pick<Db, "query">) => Promise<T>): Promise<T>;
}

const SCHEMA = readFileSync(path.join(process.cwd(), "lib/db/schema.sql"), "utf8");

async function postgresDb(url: string): Promise<Db> {
  const { default: postgres } = await import("postgres");
  const sql = postgres(url, { max: 5, ssl: url.includes("localhost") ? false : "require", onnotice: () => {} });
  const query = async <T,>(text: string, params: unknown[] = []) =>
    (await sql.unsafe(text, params as never[])) as unknown as T[];
  return {
    query,
    tx: (fn) =>
      sql.begin((t) =>
        fn({ query: async <T,>(text: string, params: unknown[] = []) => (await t.unsafe(text, params as never[])) as unknown as T[] }),
      ) as never,
  };
}

async function pgliteDb(dataDir: string | undefined): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  if (dataDir) mkdirSync(dataDir, { recursive: true });
  const pg = await PGlite.create(dataDir);
  return {
    query: async <T,>(text: string, params: unknown[] = []) => (await pg.query<T>(text, params)).rows,
    tx: (fn) => pg.transaction((t) => fn({ query: async <T,>(text: string, params: unknown[] = []) => (await t.query<T>(text, params)).rows })),
  };
}

async function migrate(db: Db) {
  const statements = SCHEMA.split(/;\s*$/m)
    .map((s) => s.replace(/^--.*$/gm, "").trim())
    .filter(Boolean);
  await db.tx(async (tx) => {
    for (const text of statements) await tx.query(text);
  });
}

const globalForDb = globalThis as unknown as { handbackDb?: Promise<Db> };

/** The shared database, migrated on first use. `memory` gives a throwaway one for tests. */
export function getDb(options: { memory?: boolean } = {}): Promise<Db> {
  if (options.memory) return pgliteDb(undefined).then(async (db) => (await migrate(db), db));
  globalForDb.handbackDb ??= (async () => {
    const url = process.env.DATABASE_URL;
    // DATABASE_URL=memory gives a throwaway in-process database (tests, one-off demos).
    const db = url === "memory" ? await pgliteDb(undefined) : url ? await postgresDb(url) : await pgliteDb(path.join(process.cwd(), ".data", "pglite"));
    await migrate(db);
    return db;
  })().catch((err) => {
    globalForDb.handbackDb = undefined;
    throw err;
  });
  return globalForDb.handbackDb;
}
