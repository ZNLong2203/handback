// Shared test data: a settled, disputed rental as the evidence pack sees it.
import { readFileSync } from "node:fs";
import path from "node:path";
import { sha256Hex } from "./evidence";
import type { EvidenceFacts } from "./facts";

const photo = (p: string) => new Uint8Array(readFileSync(path.join(process.cwd(), "eval/images", p)));
export const pickup = photo("camera-kit/before.jpg");
export const returned = photo("camera-kit/after__missing-hood.jpg");

export const sampleFacts: EvidenceFacts = {
  version: 1,
  asOf: "2026-10-05T16:42:10.123Z",
  shop: "Kestrel Rentals, Austin, TX",
  rental: { id: "R-7KQ2MX", item: "Mirrorless camera kit", customer: "Maya Chen", startDate: "2026-10-02", endDate: "2026-10-05", days: 3 },
  dispute: { id: "PP-R-CHU-10190215", reason: "INCORRECT_AMOUNT", amountCents: 2000, transactionId: "8JN17439E0980024P", openedAt: "2026-10-05T16:40:28.346Z" },
  paypal: {
    bookingOrderId: "0HL96236BY116954N",
    feeCaptureId: "88W11018NV496100U",
    authorizationId: "00T82573RL225500P",
    previousAuthorizationId: null,
    settlementCaptureId: "8JN17439E0980024P",
    extraCaptureId: null,
  },
  money: { feeCents: 8700, heldCents: 30000, capturedCents: 3500, releasedCents: 26500, extraCents: 0, settledAt: "2026-10-05T15:10:00.000Z" },
  pickup: { sha256: sha256Hex(pickup), takenAt: "2026-10-02T14:00:05.000Z", acknowledgedAt: "2026-10-02T14:02:41.000Z" },
  returned: { sha256: sha256Hex(returned), takenAt: "2026-10-05T14:55:00.000Z" },
  inspection: { source: "live", model: "gemini-3.8-flash", comparedAt: "2026-10-05T14:56:12.000Z", sentAt: "2026-10-05T14:58:00.000Z", answeredAt: "2026-10-05T15:05:30.000Z" },
  findings: [
    {
      n: 1,
      kind: "missing",
      item: "lens hood",
      description: "The lens hood next to the lens at pickup is not in the return photo.",
      boxBefore: [180, 560, 330, 720],
      boxAfter: [180, 560, 330, 720],
      price: { label: "Replace lens hood", cents: 3500 },
      proposed: true,
      staff: "keep",
      customer: "accept",
      customerNote: null,
      resolution: null,
      charged: true,
    },
    {
      n: 2,
      kind: "pre_existing",
      item: "camera body",
      description: "A small scuff on the grip, visible in both photos.",
      boxBefore: [420, 200, 500, 300],
      boxAfter: [420, 200, 500, 300],
      price: null,
      proposed: false,
      staff: "waive",
      customer: null,
      customerNote: null,
      resolution: null,
      charged: false,
    },
  ],
  audit: { entries: 14, headHash: "9f2c4e1a7b3d5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff", intact: true, brokenAtSeq: null },
};

