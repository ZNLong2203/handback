// Unit assignment at booking time, in demo mode with an in-memory database.
import { beforeAll, describe, expect, it } from "vitest";

process.env.DEMO_MODE = "true";
process.env.DATABASE_URL = "memory";
delete process.env.PAYPAL_CLIENT_ID;

const { getDb } = await import("@/lib/db/client");
const { addDaysIso, todayIso } = await import("@/lib/dates");
const repo = await import("@/lib/rentals/repo");
const svc = await import("@/lib/rentals/service");

const T = (n: number) => addDaysIso(todayIso(), n);
const rental = async (id: string) => (await repo.rentalById(await getDb(), id))!;

async function book(itemId: string, name: string, from: number, to: number) {
  return svc.startBooking({ itemId, name, email: `${name.split(" ")[0].toLowerCase()}@example.com`, startDate: T(from), endDate: T(to) });
}

beforeAll(async () => {
  await getDb();
});

describe("units at booking time", () => {
  it("seeds two or three units for every catalog item", async () => {
    const { CATALOG } = await import("@/lib/catalog");
    const units = await (await import("./repo")).listUnits(await getDb());
    for (const item of CATALOG) {
      const mine = units.filter((u) => u.itemId === item.id);
      expect(mine.length).toBeGreaterThanOrEqual(2);
      expect(mine.length).toBeLessThanOrEqual(3);
    }
    expect(units.every((u) => CATALOG.some((i) => i.id === u.itemId))).toBe(true);
  });

  it("gives each booking the first free unit, and refuses with the earliest dates once all are taken", async () => {
    const a = await book("projector", "Ana Silva", 1, 3);
    await svc.confirmBooking(a.orderId);
    const b = await book("projector", "Bo Lind", 2, 4);
    await svc.confirmBooking(b.orderId);
    expect((await rental(a.rentalId)).unitId).toBe("projector-a");
    expect((await rental(b.rentalId)).unitId).toBe("projector-b");

    await expect(book("projector", "Cy Young", 3, 4)).rejects.toThrow(/Every Portable projector is booked for .*The earliest free dates for a rental this long are/);
    // Nothing is left behind for the refused booking.
    const left = await (await getDb()).query("select id from rentals where customer_name = 'Cy Young'");
    expect(left).toHaveLength(0);

    // The return day counts: the next booking on projector A can start the day after.
    const c = await book("projector", "Cy Young", 4, 5);
    expect((await rental(c.rentalId)).unitId).toBe("projector-a");
  });

  it("checks the unit again before the fee is captured, and stops before any money moves when none is left", async () => {
    const db = await getDb();
    const slow = await book("drone-kit", "Slow Payer", 10, 11);
    expect((await rental(slow.rentalId)).unitId).toBe("drone-kit-a");
    // The customer sat in PayPal past the draft's hold; someone else books drone A meanwhile.
    await db.query("update rentals set created_at = now() - interval '40 minutes' where id = $1", [slow.rentalId]);
    const quick = await book("drone-kit", "Quick Payer", 10, 11);
    expect((await rental(quick.rentalId)).unitId).toBe("drone-kit-a");
    await svc.confirmBooking(quick.orderId);

    await svc.confirmBooking(slow.orderId);
    expect(await rental(slow.rentalId)).toMatchObject({ status: "booked", unitId: "drone-kit-b" });

    const late = await book("drone-kit", "Late Payer", 12, 13);
    await db.query("update rentals set created_at = now() - interval '40 minutes' where id = $1", [late.rentalId]);
    await svc.confirmBooking((await book("drone-kit", "Other One", 12, 13)).orderId);
    await svc.confirmBooking((await book("drone-kit", "Other Two", 12, 13)).orderId);
    await expect(svc.confirmBooking(late.orderId)).rejects.toThrow(/Nothing was charged/);
    expect(await rental(late.rentalId)).toMatchObject({ status: "draft", feeCaptureId: null });
  });
});
