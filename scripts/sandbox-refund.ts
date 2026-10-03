/**
 * Refunds part of a settled sandbox rental through the app's own refund code
 * (refundCharge in lib/rentals/refunds.ts), on the app's database, then checks
 * what PayPal says:
 *   1. the refund, as the counter's button makes it;
 *   2. the same form sent again: the app answers from its record, no PayPal call;
 *   3. the same refund request sent to PayPal directly with the same
 *      PayPal-Request-Id, to see whether PayPal answers with the first refund;
 *   4. GET the refund and the capture back.
 * With PGlite (no DATABASE_URL), stop the dev server first: one process at a time.
 *   npx tsx --conditions=react-server --env-file-if-exists=.env.local scripts/sandbox-refund.ts <rental id> <amount> "<reason>"
 */
import { getDb } from "@/lib/db/client";
import { parseUsdInput } from "@/lib/money";
import { depositGateway } from "@/lib/paypal";
import { paypalRequest } from "@/lib/paypal/rest";
import { nextRefundSeq, refundCharge, refundRequestId, refundsFor } from "@/lib/rentals/refunds";
import { rentalById } from "@/lib/rentals/repo";

const [rentalId, amount, reason] = process.argv.slice(2);
const cents = parseUsdInput(amount ?? "");
if (!rentalId || cents === null || !reason) throw new Error('Usage: scripts/sandbox-refund.ts <rental id> <amount> "<reason>"');
const gateway = depositGateway();
if (gateway.mode !== "sandbox") throw new Error(`PayPal is in ${gateway.mode} mode; this script only runs against the sandbox.`);

const db = await getDb();
const rental = await rentalById(db, rentalId);
if (!rental?.settlementCaptureId) throw new Error(`${rentalId} has no settlement capture`);
const captureId = rental.settlementCaptureId;
const seq = nextRefundSeq(await refundsFor(db, rentalId));
const form = { captureId, cents, reason, seq };
const log = (label: string, value: unknown) => console.log(`\n${label}\n${JSON.stringify(value, null, 2)}`);

log("rental", { rentalId, status: rental.status, captureId, capturedCents: rental.capturedCents, refundNumber: seq, requestId: refundRequestId(rentalId, seq) });

const first = await refundCharge(rentalId, form);
log("1. refundCharge", first);

const again = await refundCharge(rentalId, form);
log("2. the same form again (answered from the app's record)", { refundId: again.refundId, sameRefund: again.refundId === first.refundId });

const replay = await gateway.refund(
  { captureId, amountCents: cents, noteToPayer: reason, invoiceId: `${rentalId}-refund-${seq}` },
  refundRequestId(rentalId, seq),
);
log("3. PayPal, same PayPal-Request-Id", { ...replay, sameRefund: replay.refundId === first.refundId });

const refund = await paypalRequest<Record<string, unknown>>("GET", `/v2/payments/refunds/${first.refundId}`);
log("4a. GET /v2/payments/refunds/{id}", { debugId: refund.debugId, id: refund.data.id, status: refund.data.status, amount: refund.data.amount, note_to_payer: refund.data.note_to_payer, invoice_id: refund.data.invoice_id });
const capture = await paypalRequest<Record<string, unknown>>("GET", `/v2/payments/captures/${captureId}`);
log("4b. GET /v2/payments/captures/{id}", { debugId: capture.debugId, id: capture.data.id, status: capture.data.status, amount: capture.data.amount });

const v = await refundsFor(db, rentalId);
log("refunds recorded for the rental", v.map((r) => ({ seq: r.seq, state: r.state, refundId: r.refundId, amountCents: r.amountCents, paypalStatus: r.paypalStatus })));
const events = await db.query<{ type: string; data: unknown }>("select type, data from events where rental_id = $1 and type like 'refund.%' order by seq", [rentalId]);
log("audit entries", events);
process.exit(0);
