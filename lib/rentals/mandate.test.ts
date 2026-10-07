import { describe, expect, it } from "vitest";
import type { RentalItem } from "@/lib/catalog";
import { buildMandate, mandateCancellation, mandateExpiry, mandateTerms, mandateViolations, openMandate, sealMandate, type DepositMandate, type MandateInput } from "./mandate";

// A fixed item, so the pinned hash below does not move when the demo catalog does.
const drone: RentalItem = {
  id: "drone-kit",
  name: "Folding camera drone kit",
  category: "Drones",
  dailyCents: 4500,
  depositCents: 30000,
  kit: ["drone", "remote controller", "flight battery (2)"],
  shot: "Top-down flat-lay.",
  prices: [
    { id: "missing-battery", label: "Replace flight battery", kind: "missing", cents: 8900 },
    { id: "propeller-damage", label: "Replace damaged propeller", kind: "damage", cents: 1400 },
  ],
};

const input: MandateInput = {
  rentalId: "R-TEST01",
  item: drone,
  shop: { name: "Kestrel Camera Rentals", city: "Austin, TX" },
  renter: { name: "Sam Rivera", email: "sam@example.com" },
  issuer: { party: "assistant", assistant: "Claude" },
  pickup: "2026-10-03",
  returnDate: "2026-10-05",
  days: 2,
  feeCents: 9000,
  createdAt: new Date("2026-10-02T12:00:00.000Z"),
};

/** Same object with every key order reversed, the way a jsonb round trip can reorder them. */
function reversed(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversed);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reversed(v)]));
  }
  return value;
}

describe("deposit mandate", () => {
  it("states the hold, the price list, who it was issued to and when it ends", () => {
    const m = buildMandate(input);
    expect(m).toMatchObject({
      rentalId: "R-TEST01",
      item: { id: "drone-kit", name: "Folding camera drone kit" },
      issuedTo: { party: "assistant", assistant: "Claude", actingFor: "Sam Rivera <sam@example.com>" },
      period: { pickup: "2026-10-03", return: "2026-10-05", days: 2 },
      feeCents: 9000,
      hold: { maxCents: 30000, starts: "at_pickup" },
      charges: { from: "price_list", onlyAfter: "shown_to_renter", questioned: "shop_decides" },
      expiresAt: "2026-11-01T00:00:00.000Z",
      createdAt: "2026-10-02T12:00:00.000Z",
    });
    expect(m.priceList).toEqual(drone.prices);
    expect(buildMandate({ ...input, issuer: { party: "renter" } }).issuedTo).toEqual({ party: "renter" });
  });

  it("ends with the 29-day life of a hold placed at pickup", () => {
    expect(mandateExpiry("2026-10-03")).toBe("2026-11-01T00:00:00.000Z");
    expect(mandateExpiry("2026-12-20")).toBe("2027-01-18T00:00:00.000Z");
  });

  it("hashes the same however its keys are ordered", () => {
    const a = sealMandate(buildMandate(input));
    const b = sealMandate(reversed(buildMandate(input)) as ReturnType<typeof buildMandate>);
    expect(b).toEqual(a);
    expect(sealMandate(JSON.parse(a.json))).toEqual(a);
  });

  it("keeps a stable hash for the same terms", () => {
    // Pinned: if this changes, stored mandates no longer verify. Bump `version` instead.
    expect(sealMandate(buildMandate(input)).sha256).toBe("5421facd22f49cb95452e5202c11fde1983ae35dfdfb77df06d2b93c9a8f05ac");
  });

  it("writes the cancellation terms into version 2, fixed to the pickup day", () => {
    const m = buildMandate(input);
    expect(m.version).toBe(2);
    expect(mandateCancellation(m)).toEqual({
      feeRefund: [
        { before: "2026-10-02T00:00:00.000Z", percent: 100 },
        { before: "2026-10-03T00:00:00.000Z", percent: 50 },
      ],
    });
    expect(mandateTerms(m).at(-1)).toBe(
      "If you cancel before Oct 2, 00:00 UTC, the whole rental fee ($90.00) is refunded; before Oct 3, 00:00 UTC, half the rental fee ($45.00); from then on, nothing.",
    );
  });

  it("still verifies a version 1 mandate issued before cancellation terms existed, byte for byte", () => {
    // The same booking as issued before version 2: no cancellation field. Its hash is the one pinned then.
    const v1: Record<string, unknown> = { ...buildMandate(input), version: 1 };
    delete v1.cancellation;
    const { json, sha256 } = sealMandate(v1 as unknown as DepositMandate);
    expect(sha256).toBe("5231c681c64edc9fa0a394faadc306c5e5ab3e6d4fb3a8d9086518f0c3887974");
    const opened = openMandate(json, sha256)!;
    expect(opened.intact).toBe(true);
    expect(mandateCancellation(opened.mandate)).toBeNull();
    expect(mandateTerms(opened.mandate).join(" ")).not.toContain("cancel");
  });

  it("detects a changed price, a changed hash and unreadable text", () => {
    const { json, sha256 } = sealMandate(buildMandate(input));
    expect(openMandate(json, sha256)).toMatchObject({ intact: true, mandate: { rentalId: "R-TEST01" } });
    const cheaper = json.replace('"cents":8900', '"cents":89');
    expect(cheaper).not.toBe(json);
    expect(openMandate(cheaper, sha256)?.intact).toBe(false);
    expect(openMandate(json, "0".repeat(64))?.intact).toBe(false);
    expect(openMandate(JSON.stringify(JSON.parse(json), null, 2), sha256)?.intact).toBe(false);
    expect(openMandate("{not json", sha256)).toBeNull();
    expect(openMandate('{"type":"something-else"}', sha256)).toBeNull();
  });

  it("explains itself in plain sentences with the real amounts", () => {
    const terms = mandateTerms(buildMandate(input)).join(" ");
    expect(terms).toContain("$90.00");
    expect(terms).toContain("up to $300.00");
    expect(terms).toContain("Nov 1");
  });
});

describe("mandateViolations", () => {
  const m = buildMandate(input);
  const now = new Date("2026-10-05T18:00:00.000Z");
  const battery = { priceId: "missing-battery", label: "Replace flight battery", cents: 8900, shownToRenter: true };

  it("allows a hold up to the limit and listed charges the renter has seen", () => {
    expect(mandateViolations(m, { at: now, holdCents: 30000 })).toEqual([]);
    expect(mandateViolations(m, { at: now, charges: [battery, { ...battery }] })).toEqual([]);
  });

  it("refuses a bigger hold, an unlisted or repriced charge, an unseen charge and anything after expiry", () => {
    expect(mandateViolations(m, { at: now, holdCents: 30001 })).toEqual(["A hold of $300.01 is more than the $300.00 the renter allowed."]);
    expect(mandateViolations(m, { at: now, charges: [{ ...battery, cents: 9900 }] })).toEqual([
      "Replace flight battery at $99.00 is not on the price list the renter agreed to.",
    ]);
    expect(mandateViolations(m, { at: now, charges: [{ ...battery, priceId: "gold-plating" }] })).toHaveLength(1);
    expect(mandateViolations(m, { at: now, charges: [{ ...battery, shownToRenter: false }] })).toEqual([
      "Replace flight battery has not been shown to the renter.",
    ]);
    expect(mandateViolations(m, { at: new Date("2026-11-01T00:00:00.000Z"), charges: [battery] })).toEqual([
      "The renter's mandate ended on Nov 1.",
    ]);
  });
});
