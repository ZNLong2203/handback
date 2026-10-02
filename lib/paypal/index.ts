import "server-only";
import { getDb } from "@/lib/db/client";
import { paypalConfig } from "./config";
import { DemoDisputeApi, type DemoDisputeState, type DemoDisputeStore } from "./demo-disputes";
import { DemoDepositGateway, type DemoState, type DemoStore } from "./demo-gateway";
import type { DisputeApi } from "./dispute-model";
import { PayPalDisputeApi } from "./disputes";
import type { DepositGateway } from "./gateway";
import { PayPalDepositGateway } from "./paypal-gateway";

const globalForGateway = globalThis as unknown as { depositGateway?: DepositGateway; disputeApi?: DisputeApi };

/** Keeps the demo stand-in's state in the database so demo mode survives restarts. */
const dbStore: DemoStore = {
  async load() {
    const db = await getDb();
    const rows = await db.query<{ state: DemoState }>("select state from demo_paypal where k = 'gateway'");
    return rows[0]?.state ?? null;
  },
  async save(state) {
    const db = await getDb();
    await db.query(
      "insert into demo_paypal (k, state) values ('gateway', $1::jsonb) on conflict (k) do update set state = excluded.state",
      [JSON.stringify(state)],
    );
  },
};

/** The real PayPal gateway, or the stand-in in demo mode. One per process. */
export function depositGateway(): DepositGateway {
  if (globalForGateway.depositGateway) return globalForGateway.depositGateway;
  const { mode } = paypalConfig();
  const gateway = mode === "demo" ? new DemoDepositGateway(() => new Date(), dbStore) : new PayPalDepositGateway(mode);
  globalForGateway.depositGateway = gateway;
  return gateway;
}

const disputeStore: DemoDisputeStore = {
  async load() {
    const db = await getDb();
    const rows = await db.query<{ state: DemoDisputeState }>("select state from demo_paypal where k = 'disputes'");
    return rows[0]?.state ?? null;
  },
  async save(state) {
    const db = await getDb();
    await db.query(
      "insert into demo_paypal (k, state) values ('disputes', $1::jsonb) on conflict (k) do update set state = excluded.state",
      [JSON.stringify(state)],
    );
  },
};

/** The Disputes API, or its stand-in in demo mode. One per process. */
export function disputeApi(): DisputeApi {
  if (globalForGateway.disputeApi) return globalForGateway.disputeApi;
  const { mode } = paypalConfig();
  const api = mode === "demo" ? new DemoDisputeApi(() => new Date(), disputeStore) : new PayPalDisputeApi(mode);
  globalForGateway.disputeApi = api;
  return api;
}

export type { DepositGateway } from "./gateway";
export { PayPalError } from "./errors";
