import { describe, expect, it } from "vitest";
import { checkMessage, draftMessage, templateMessage, type MessageFacts } from "./messages";

const reassign: MessageFacts = {
  shopName: "Kestrel Rentals",
  customerName: "Priya Patel",
  itemName: "Portable projector",
  kind: "reassign",
  why: "repair",
  booked: { start: "2026-10-04", end: "2026-10-06" },
};
const reschedule: MessageFacts = { ...reassign, customerName: "Diego Alvarez", kind: "reschedule", booked: { start: "2026-10-07", end: "2026-10-09" }, offered: { start: "2026-10-08", end: "2026-10-10" } };

describe("customer messages", () => {
  it("every template passes its own checks", () => {
    for (const why of ["repair", "maintenance", "double-booked", "staff"] as const) {
      for (const f of [reassign, reschedule, { ...reschedule, kind: "call" as const, offered: undefined }]) {
        const facts = { ...f, why };
        expect(checkMessage(templateMessage(facts), facts), `${f.kind}/${why}`).toBeNull();
      }
    }
    expect(templateMessage(reschedule)).toBe(
      "Hi Diego, this is Kestrel Rentals. The Portable projector you booked for Oct 7–9 needs a repair, and no other one is free on those dates. The earliest we can offer is Oct 8–10. We will call you to check whether that works for you.",
    );
  });

  it("rejects a draft that invents a date, mentions money or a link, or promises a refund", () => {
    const good = "Hi Priya, the projector we set aside for Oct 4–6 needs a repair, so another one of the same model is waiting for you. Nothing else changes.";
    expect(checkMessage(good, reassign)).toBeNull();
    expect(checkMessage(good.replace("Oct 4–6", "Oct 5–6"), reassign)).toMatch(/date that is not part of the plan/);
    expect(checkMessage(`${good} We have taken $20 off.`, reassign)).toMatch(/money/);
    expect(checkMessage(`${good} We will refund the difference.`, reassign)).toMatch(/promises/);
    expect(checkMessage(`${good} Details at https://example.com.`, reassign)).toMatch(/link/);
    expect(checkMessage(good.replace("Hi Priya", "Hello there"), reassign)).toMatch(/name/);
    expect(checkMessage("Hi Priya, see you soon.", reassign)).toMatch(/length/);
    expect(
      checkMessage("Hi Diego, the projector for Oct 7–9 needs a repair and none other is free then. We will call you about other dates.", reschedule),
    ).toMatch(/offered dates/);
  });

  it("uses Gemini's wording only when it passes the checks, and the template otherwise", async () => {
    const good = "Hi Priya, the projector we set aside for Oct 4–6 needs a repair, so another one of the same model is ready for you. Nothing else changes.";
    expect(await draftMessage(reassign, async () => ({ message: good }))).toEqual({ text: good, source: "gemini" });
    expect(await draftMessage(reassign, async () => ({ message: `${good} Enjoy 10% off!` }))).toEqual({ text: templateMessage(reassign), source: "template" });
    expect(await draftMessage(reassign, async () => null)).toMatchObject({ source: "template" });
    expect(
      await draftMessage(reassign, async () => {
        throw new Error("network");
      }),
    ).toMatchObject({ source: "template" });
    expect(await draftMessage(reassign, null)).toEqual({ text: templateMessage(reassign), source: "template" });
  });
});
