import { describe, expect, it } from "vitest";
import { catalogItem } from "@/lib/catalog";
import { mergeLooks } from "./consensus";
import { assess } from "./policy";
import type { ModelOutput } from "./schema";

const kit = catalogItem("camera-kit");

type F = ModelOutput["findings"][number];
const finding = (over: Partial<F>): F => ({
  kind: "missing",
  item: "lens hood",
  description: "The lens hood is not in the check-in photo.",
  evidence: "Its place on the mat is empty.",
  box_before: [400, 20, 600, 120],
  box_after: null,
  confidence: "high",
  price_item_id: "missing-hood",
  ...over,
});
const output = (findings: F[], over: Partial<ModelOutput> = {}): ModelOutput => ({
  photos_usable: true,
  photo_issue: null,
  same_item: true,
  findings,
  summary: "test",
  ...over,
});

describe("assess", () => {
  it("prices findings from the shop's list, never from the model", () => {
    const a = assess(output([finding({})]), kit);
    expect(a.findings[0].decision).toBe("propose");
    expect(a.proposedCents).toBe(3500);
  });

  it("never charges low-confidence, pre-existing or wear findings", () => {
    const a = assess(
      output([
        finding({ confidence: "low" }),
        finding({ kind: "pre_existing", item: "camera body", price_item_id: null }),
        finding({ kind: "wear", item: "neck strap", price_item_id: null }),
      ]),
      kit,
    );
    expect(a.findings.map((f) => f.decision)).toEqual(["note", "note", "note"]);
    expect(a.proposedCents).toBe(0);
  });

  it("refuses a price id that is not in the list or does not fit the kind", () => {
    const a = assess(
      output([finding({ price_item_id: "made-up" }), finding({ kind: "new_damage", item: "camera body", price_item_id: "missing-battery" })]),
      kit,
    );
    expect(a.findings.every((f) => f.decision === "note")).toBe(true);
  });

  it("asks a person to check medium-confidence findings", () => {
    expect(assess(output([finding({ confidence: "medium" })]), kit).findings[0].decision).toBe("check");
  });

  it("charges nothing when the photos cannot be compared", () => {
    const a = assess(output([finding({})], { photos_usable: false, photo_issue: "Too dark" }), kit);
    expect(a).toMatchObject({ usable: false, issue: "Too dark", proposedCents: 0, findings: [] });
  });

  it("flags the part of a proposal the deposit cannot cover", () => {
    const tele = catalogItem("tele-lens");
    const big = Array.from({ length: 3 }, () => finding({ kind: "new_damage", item: "barrel", price_item_id: "barrel-dent" }));
    const a = assess(output([...big, finding({ kind: "new_damage", item: "hood", price_item_id: "hood-crack" })]), tele);
    // The same repair is charged once.
    expect(a.proposedCents).toBe(14000 + 4500);
    expect(a.overDepositCents).toBe(0);
  });
});

describe("mergeLooks", () => {
  it("proposes only charges both looks agree on", () => {
    const a = assess(output([finding({}), finding({ kind: "new_damage", item: "camera body", price_item_id: "body-cosmetic" })]), kit);
    const b = assess(output([finding({})]), kit);
    const merged = mergeLooks(a, b, kit.depositCents);
    const charged = merged.findings.filter((f) => f.decision !== "note");
    expect(charged.map((f) => f.price?.id)).toEqual(["missing-hood"]);
    expect(merged.findings.find((f) => f.price?.id === "body-cosmetic")?.decision).toBe("note");
    expect(merged.proposedCents).toBe(3500);
  });

  it("takes the less certain of the two looks", () => {
    const a = assess(output([finding({ confidence: "high" })]), kit);
    const b = assess(output([finding({ confidence: "medium" })]), kit);
    expect(mergeLooks(a, b, kit.depositCents).findings[0].decision).toBe("check");
  });

  it("charges nothing if either look could not use the photos", () => {
    const a = assess(output([finding({})]), kit);
    const b = assess(output([], { photos_usable: false, photo_issue: "Blurry" }), kit);
    expect(mergeLooks(a, b, kit.depositCents)).toMatchObject({ usable: false, proposedCents: 0 });
  });
});
