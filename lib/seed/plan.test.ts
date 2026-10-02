import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CATALOG } from "@/lib/catalog";
import { nextSeedStep, SCENARIOS, type SeedState, type SeedStep, type SeedTarget } from "./plan";

const fresh: SeedState = { status: null, pickupPhoto: false, acknowledged: false, returnPhoto: false, awaitingCustomer: 0 };

/** What each step does to the state, the way the rental service would. */
function apply(s: SeedState, step: SeedStep, chargesFound: number): SeedState {
  switch (step) {
    case "book":
      return { ...s, status: "draft" };
    case "pay":
      return { ...s, status: "booked" };
    case "pickup-photo":
      return { ...s, pickupPhoto: true };
    case "hold":
      return { ...s, status: "out" };
    case "acknowledge":
      return { ...s, acknowledged: true };
    case "return-photo":
      return { ...s, returnPhoto: true };
    case "inspect":
      return { ...s, status: "inspecting", awaitingCustomer: chargesFound };
    case "send":
      return { ...s, status: "customer_review" };
    case "answer":
      return { ...s, status: "responded", awaitingCustomer: 0 };
    case "settle":
      return { ...s, status: "settled" };
  }
}

function walk(target: SeedTarget, chargesFound = 1, from = fresh): SeedStep[] {
  const steps: SeedStep[] = [];
  let s = from;
  for (let step = nextSeedStep(s, target); step; step = nextSeedStep(s, target)) {
    steps.push(step);
    s = apply(s, step, chargesFound);
    if (steps.length > 20) throw new Error("no end in sight");
  }
  return steps;
}

describe("nextSeedStep", () => {
  it("walks the real rental steps to each target", () => {
    expect(walk("booked")).toEqual(["book", "pay"]);
    expect(walk("out")).toEqual(["book", "pay", "pickup-photo", "hold", "acknowledge"]);
    expect(walk("inspecting")).toEqual(["book", "pay", "pickup-photo", "hold", "acknowledge", "return-photo", "inspect"]);
    expect(walk("customer_review").slice(-2)).toEqual(["inspect", "send"]);
    expect(walk("settled").slice(-4)).toEqual(["inspect", "send", "answer", "settle"]);
  });

  it("settles a clean return straight away, and stops when there is nothing to send", () => {
    expect(walk("settled", 0).slice(-2)).toEqual(["inspect", "settle"]);
    expect(walk("customer_review", 0).at(-1)).toBe("inspect");
  });

  it("resumes an interrupted rental and leaves finished or diverted ones alone", () => {
    expect(walk("out", 1, { ...fresh, status: "draft" })).toEqual(["pay", "pickup-photo", "hold", "acknowledge"]);
    expect(walk("out", 1, { ...fresh, status: "booked", pickupPhoto: true })).toEqual(["hold", "acknowledge"]);
    expect(nextSeedStep({ ...fresh, status: "settled" }, "settled")).toBeNull();
    expect(nextSeedStep({ ...fresh, status: "settled" }, "out")).toBeNull();
    expect(nextSeedStep({ ...fresh, status: "disputed" }, "settled")).toBeNull();
    expect(nextSeedStep({ ...fresh, status: "cancelled" }, "booked")).toBeNull();
  });
});

describe("SCENARIOS", () => {
  it("covers every step of the counter with unique example.com customers", () => {
    expect(new Set(SCENARIOS.map((s) => s.email)).size).toBe(SCENARIOS.length);
    expect(SCENARIOS.every((s) => s.email.endsWith("@example.com"))).toBe(true);
    expect(new Set(SCENARIOS.map((s) => s.target))).toEqual(new Set(["booked", "out", "inspecting", "customer_review", "settled"]));
  });

  it("uses catalog items and bundled return photos that exist", () => {
    for (const s of SCENARIOS) {
      expect(CATALOG.some((i) => i.id === s.itemId)).toBe(true);
      if (s.returnSample) {
        expect(s.returnSample.startsWith(`${s.itemId}/`)).toBe(true);
        expect(existsSync(`eval/images/${s.returnSample}.jpg`)).toBe(true);
      }
    }
  });
});
