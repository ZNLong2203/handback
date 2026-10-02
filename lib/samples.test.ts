// The AI-generated sample photos the counter offers instead of a camera, and
// the recorded Gemini replies demo mode replays for them.
import { describe, expect, it } from "vitest";

process.env.DEMO_MODE = "true";

const { CATALOG, catalogItem } = await import("./catalog");
const { inspectReturn } = await import("./inspection/run");
const { sampleFile, samplePair, samplesFor } = await import("./samples");

const photo = (sample: string) => ({ bytes: Buffer.alloc(0), sample });

describe("sample photos", () => {
  it("offers every catalog item a pickup photo and return photos that exist and replay recorded replies", async () => {
    for (const item of CATALOG) {
      const pickup = samplesFor(item.id, "checkout");
      expect(pickup, item.id).toHaveLength(1);
      expect(sampleFile(pickup[0].key), pickup[0].key).not.toBeNull();
      const returns = samplesFor(item.id, "checkin");
      expect(returns.length, item.id).toBeGreaterThanOrEqual(3);
      for (const r of returns) {
        expect(sampleFile(r.key), r.key).not.toBeNull();
        expect(samplePair(pickup[0].key, r.key), r.key).not.toBeNull();
        const run = await inspectReturn(photo(pickup[0].key), photo(r.key), item, "Test shop");
        expect(run.source, r.key).toBe("replay");
      }
    }
  });

  it("only serves files inside the sample folders", () => {
    expect(sampleFile("camera-kit/before")).toMatch(/eval\/images\/camera-kit\/before\.jpg$/);
    expect(sampleFile("city-bike/before")).toMatch(/eval\/samples\/images\/city-bike\/before\.jpg$/);
    for (const key of ["camera-kit/missing", "../package", "camera-kit/../../package", "eval/images/camera-kit/before", "Camera-kit/before"]) {
      expect(sampleFile(key), key).toBeNull();
    }
  });

  it("labels the city bike returns from the demo-only set, unchanged ones first", () => {
    expect(samplesFor("city-bike", "checkout")).toEqual([{ key: "city-bike/before", label: "Pickup photo", hint: "As it leaves the shop" }]);
    expect(samplesFor("city-bike", "checkin")).toEqual([
      { key: "city-bike/after__same-light", label: "Back as it left, warmer light", hint: "Nothing changed" },
      { key: "city-bike/after__same-pose", label: "Back as it left, shot at an angle", hint: "Nothing changed" },
      { key: "city-bike/after__frame-scratch", label: "Scratches to bare metal on the frame", hint: "Something changed" },
      { key: "city-bike/after__missing-holder", label: "Phone holder removed", hint: "Something changed" },
      { key: "city-bike/after__missing-holder-rear-light", label: "Phone holder removed, rear light removed", hint: "Something changed" },
    ]);
  });

  it("replays both looks for the city bike: two missing accessories, a scratch, and nothing on an unchanged bike", async () => {
    const bike = catalogItem("city-bike");
    const charges = async (after: string) => {
      const { assessment } = await inspectReturn(photo("city-bike/before"), photo(`city-bike/${after}`), bike, "Test shop");
      return assessment.findings.filter((f) => f.decision !== "note").map((f) => [f.price?.id, f.price?.cents]);
    };
    expect(await charges("after__missing-holder-rear-light")).toEqual([
      ["missing-phone-holder", 1200],
      ["missing-rear-light", 1500],
    ]);
    expect(await charges("after__missing-holder")).toEqual([["missing-phone-holder", 1200]]);
    expect(await charges("after__frame-scratch")).toEqual([["frame-scratch", 2500]]);
    expect(await charges("after__same-light")).toEqual([]);
    expect(await charges("after__same-pose")).toEqual([]);
  });
});
