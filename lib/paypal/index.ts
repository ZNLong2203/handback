import "server-only";
import { paypalConfig } from "./config";
import { DemoDepositGateway } from "./demo-gateway";
import type { DepositGateway } from "./gateway";
import { PayPalDepositGateway } from "./paypal-gateway";

const globalForGateway = globalThis as unknown as { depositGateway?: DepositGateway };

/** The real PayPal gateway, or the in-memory one in demo mode. One per process. */
export function depositGateway(): DepositGateway {
  if (globalForGateway.depositGateway) return globalForGateway.depositGateway;
  const { mode } = paypalConfig();
  const gateway = mode === "demo" ? new DemoDepositGateway() : new PayPalDepositGateway(mode);
  globalForGateway.depositGateway = gateway;
  return gateway;
}

export type { DepositGateway } from "./gateway";
export { PayPalError } from "./errors";
