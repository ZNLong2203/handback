// The dashboard's simple view reads the same data sources the page hands AG
// Studio. These are hand-made sources for the conversions; model.test.ts
// checks the KPIs and tables against rentals walked through the service.
import { describe, expect, it } from "vitest";
import { simpleViewData, utcMoment } from "./simple-view";
import type { StudioDataSpec } from "./studio-data";

const spec = (sources: Record<string, Record<string, string | number | boolean | null>[]>): StudioDataSpec => ({
  description: "",
  relationships: [],
  sources: Object.entries(sources).map(([id, data]) => ({ id, name: id, description: "", fields: [], data })),
});

describe("simpleViewData", () => {
  it("draws the flows with money on them", () => {
    const { flows } = simpleViewData(
      spec({
        flows: [
          { rental_id: "R-1", from: "Deposits held", to: "Released to renters", amount_usd: 265, amount_cents: 26500 },
          { rental_id: "R-1", from: "Deposits held", to: "Captured for repairs", amount_usd: 35, amount_cents: 3500 },
          { rental_id: "R-2", from: "Deposits held", to: "Captured for repairs", amount_usd: 0, amount_cents: 0 },
        ],
      }),
    );
    expect(flows).toEqual([
      { from: "Deposits held", to: "Released to renters", value: 265 },
      { from: "Deposits held", to: "Captured for repairs", value: 35 },
    ]);
  });

  it("puts each running hold on the clock, soonest expiry first, and skips a row without its times", () => {
    const { holds } = simpleViewData(
      spec({
        holds: [
          { rental_id: "R-LATE", item: "City bike", held_at: "2026-10-10T09:00:00.000Z", renewal_due_at: "2026-10-13T09:00:00.000Z", expires_at: "2026-11-08T09:00:00.000Z", renewed_at: null, attention: null, amount_usd: 150 },
          { rental_id: "R-SOON", item: "Portable projector", held_at: "2026-09-20T09:00:00.000Z", renewal_due_at: null, expires_at: "2026-10-19T09:00:00.000Z", renewed_at: "2026-09-24T09:00:00.000Z", attention: "Expires in 3 days.", amount_usd: 200 },
          { rental_id: "R-BAD", item: "Drone", held_at: "", renewal_due_at: null, expires_at: "2026-10-19T09:00:00.000Z", renewed_at: null, attention: null, amount_usd: 300 },
        ],
      }),
    );
    expect(holds).toEqual([
      {
        id: "R-SOON",
        label: "Portable projector",
        heldAt: Date.parse("2026-09-20T09:00:00.000Z"),
        renewalDue: null,
        expiresAt: Date.parse("2026-10-19T09:00:00.000Z"),
        renewedAt: Date.parse("2026-09-24T09:00:00.000Z"),
        attention: "Expires in 3 days.",
        amount: 200,
      },
      {
        id: "R-LATE",
        label: "City bike",
        heldAt: Date.parse("2026-10-10T09:00:00.000Z"),
        renewalDue: Date.parse("2026-10-13T09:00:00.000Z"),
        expiresAt: Date.parse("2026-11-08T09:00:00.000Z"),
        renewedAt: null,
        attention: null,
        amount: 150,
      },
    ]);
  });

  it("lists the ledger newest first, in cents, with the rental's item", () => {
    const { ledger } = simpleViewData(
      spec({
        rentals: [{ rental_id: "R-1", item: "Camera kit" }],
        ledger: [
          { movement_id: "m1", rental_id: "R-1", at: "2026-10-01T10:00:00.000Z", kind: "Rental fee captured", paypal_id: "CAP-1", related_paypal_id: "ORDER-1", amount_cents: 8700, shop_net_cents: 8700, status: "COMPLETED" },
          { movement_id: "m2", rental_id: "R-1", at: "2026-10-04T10:00:00.000Z", kind: "Refund after settling", paypal_id: "REF-1", related_paypal_id: "CAP-2", amount_cents: 1000, shop_net_cents: -1000, status: "COMPLETED" },
          { movement_id: "m3", rental_id: "R-9", at: "2026-10-02T10:00:00.000Z", kind: "Deposit held", paypal_id: null, related_paypal_id: null, amount_cents: 30000, shop_net_cents: 0, status: null },
        ],
      }),
    );
    expect(ledger.map((l) => [l.id, l.item, l.amountCents, l.netCents])).toEqual([
      ["m2", "Camera kit", 1000, -1000],
      ["m3", null, 30000, 0],
      ["m1", "Camera kit", 8700, 8700],
    ]);
    expect(ledger[1]).toMatchObject({ paypalId: null, relatedPaypalId: null, status: null });
  });

  it("is empty for a shop with no history yet", () => {
    expect(simpleViewData(spec({}))).toEqual({ flows: [], holds: [], ledger: [] });
  });

  it("writes times in UTC, the same on the server and in any browser", () => {
    expect(utcMoment("2026-10-14T09:05:00.000Z")).toBe("Oct 14, 09:05 UTC");
    expect(utcMoment("not a time")).toBe("not a time");
  });
});
