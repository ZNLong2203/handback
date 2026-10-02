import { describe, expect, it } from "vitest";
import type { RentalItem } from "@/lib/catalog";
import { buildMandate, mandateExpiry, mandateTerms, mandateViolations, openMandate, sealMandate, type MandateInput } from "./mandate";

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
    expect(sealMandate(buildMandate(input)).sha256).toBe("5231c681c64edc9fa0a394faadc306c5e5ab3e6d4fb3a8d9086518f0c3887974");
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
