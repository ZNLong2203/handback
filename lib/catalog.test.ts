import { describe, expect, it } from "vitest";

process.env.DATABASE_URL = "memory";

const { CATALOG, catalogItem } = await import("./catalog");
const { getDb } = await import("./db/client");
const { listUnits } = await import("./schedule/repo");
const { REPAIR_DAYS } = await import("./schedule/repair-days");

describe("catalog", () => {
  it("gives every item a unique id and every price a unique id, a whole number of cents and a kind", () => {
    expect(new Set(CATALOG.map((i) => i.id)).size).toBe(CATALOG.length);
    for (const item of CATALOG) {
      const ids = item.prices.map((p) => p.id);
      expect(new Set(ids).size, item.id).toBe(ids.length);
      for (const p of item.prices) {
        expect(Number.isInteger(p.cents) && p.cents > 0, `${item.id}/${p.id}`).toBe(true);
        // The policy charges a missing-* entry once per missing piece, and anything else once per return.
        expect(p.id.startsWith("missing-"), `${item.id}/${p.id}`).toBe(p.kind === "missing");
      }
    }
  });

  it("says how long every repair or replacement keeps a unit off the schedule", () => {
    for (const item of CATALOG) {
      for (const p of item.prices.filter((p) => p.kind !== "dirt")) expect(REPAIR_DAYS[p.id], `${item.id}/${p.id}`).toBeGreaterThan(0);
    }
  });

  it("rents a city bike with its lights, cable lock and phone holder on the repair list", () => {
    const bike = catalogItem("city-bike");
    expect(bike).toMatchObject({ name: "City bike", category: "Bikes", dailyCents: 1500, depositCents: 15000 });
    expect(bike.kit).toEqual(["bicycle", "front light", "rear light", "cable lock", "phone holder"]);
    const byKind = (kind: string) => bike.prices.filter((p) => p.kind === kind).map((p) => p.id);
    expect(byKind("missing")).toEqual(["missing-front-light", "missing-rear-light", "missing-lock", "missing-phone-holder"]);
    expect(byKind("damage")).toEqual(["frame-scratch", "mudguard"]);
    expect(byKind("dirt")).toEqual(["heavy-cleaning"]);
    // Nothing on the list costs more than the deposit holds.
    expect(Math.max(...bike.prices.map((p) => p.cents))).toBeLessThan(bike.depositCents);
  });

  it("stocks three city bikes for bookings and the schedule", async () => {
    const units = (await listUnits(await getDb())).filter((u) => u.itemId === "city-bike");
    expect(units.map((u) => [u.id, u.label])).toEqual([
      ["city-bike-a", "City bike A"],
      ["city-bike-b", "City bike B"],
      ["city-bike-c", "City bike C"],
    ]);
  });
});
