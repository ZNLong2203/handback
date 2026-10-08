import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { encodePhoto, MAX_EDGE } from "./photo-encoding";
import { measureQuality } from "./photos";

const BIKE = "eval/samples/images/city-bike/after__missing-holder-rear-light.jpg";

describe("encodePhoto", () => {
  it("keeps colour at full resolution, so a small red part is not halved before the model sees it", async () => {
    const { data, width, height } = await encodePhoto(readFileSync(BIKE));
    const meta = await sharp(data).metadata();
    expect(meta).toMatchObject({ format: "jpeg", chromaSubsampling: "4:4:4", width: 1280, height: 956 });
    expect({ width, height }).toEqual({ width: 1280, height: 956 });
  });

  it("turns the photo upright by its EXIF orientation, caps the longest edge and drops the metadata", async () => {
    const phone = await sharp({ create: { width: 3200, height: 2000, channels: 3, background: "#808080" } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const { data, width, height } = await encodePhoto(phone);
    expect({ width, height }).toEqual({ width: 1000, height: MAX_EDGE });
    const meta = await sharp(data).metadata();
    expect(meta.orientation).toBeUndefined();
    expect(meta.exif).toBeUndefined();
  });

  it("does not enlarge a small photo", async () => {
    const small = await sharp({ create: { width: 640, height: 480, channels: 3, background: "#808080" } }).png().toBuffer();
    expect(await encodePhoto(small)).toMatchObject({ width: 640, height: 480 });
  });
});

describe("photo checks on the stored bytes", () => {
  // Every photo the demo's sample picker offers (lib/samples.ts) goes through encodePhoto and these checks.
  const samples = ["eval/images", "eval/samples/images"].flatMap((root) =>
    readdirSync(root).flatMap((scene) => readdirSync(path.join(root, scene)).map((f) => path.join(root, scene, f))),
  );

  it("accepts every bundled sample photo", async () => {
    expect(samples.length).toBeGreaterThan(40);
    for (const file of samples) {
      const quality = await measureQuality((await encodePhoto(readFileSync(file))).data);
      expect({ file, problems: quality.problems }).toEqual({ file, problems: [] });
    }
  });

  it("still rejects a blurred photo", async () => {
    const blurred = await sharp(readFileSync(BIKE)).blur(12).jpeg().toBuffer();
    expect((await measureQuality((await encodePhoto(blurred)).data)).problems).toContain("The photo is blurry. Hold the phone still and tap to focus.");
  });
});
