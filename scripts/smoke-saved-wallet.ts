// Holds a deposit and charges an overage on a saved sandbox wallet through the
// real gateway (merchant-initiated, with stored_credential), then settles.
// Needs a vault id from scripts/spike-vault.ts (private/spike-vault.json).
// Run: npx tsx --conditions=react-server --env-file-if-exists=.env.local scripts/smoke-saved-wallet.ts
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { paypalConfig } from "@/lib/paypal/config";
import { PayPalDepositGateway } from "@/lib/paypal/paypal-gateway";

const cfg = paypalConfig();
if (cfg.mode === "demo") throw new Error("Needs sandbox credentials");
const { vaultId } = JSON.parse(readFileSync("private/spike-vault.json", "utf8")) as { vaultId: string };
const gw = new PayPalDepositGateway(cfg.mode);
const rentalId = `R-SMOKE-${Date.now().toString(36).toUpperCase()}`;

const hold = await gw.holdWithSavedWallet({ vaultId, rentalId, amountCents: 30000, description: "Refundable damage deposit" }, `hold-${randomUUID()}`);
console.log("hold", hold.status, hold.authorizationId, hold.amountCents, hold.expiresAt);
const settled = await gw.settle({ authorizationId: hold.authorizationId, amountCents: 3500, authorizedCents: hold.amountCents, invoiceId: `${rentalId}-damage`, noteToPayer: "Lens hood not returned" }, `settle-${randomUUID()}`);
console.log("settle", settled);
const extra = await gw.chargeSavedWallet({ vaultId, rentalId, amountCents: 2500, description: "Repair above the deposit" }, `extra-${randomUUID()}`);
console.log("extra", extra);
