import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { align, IDENTITY, mismatch, pasteBack, type Box, type Gray, type Similarity } from "./composite";

/** A smooth, non-repeating pattern, so every shift looks different. */
const pattern = (x: number, y: number) =>
  128 + 50 * Math.sin(x / 7) * Math.cos(y / 11) + 40 * Math.sin((x + 2 * y) / 13) + 30 * Math.cos((3 * x - y) / 17);

/** The pattern as an image model might return it after moving everything by `t`. */
function drawn(width: number, height: number, t: Similarity, scale = 1): Gray {
  const data = new Float32Array(width * height);
  const cx = width / 2;
  const cy = height / 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const ox = cx + t.scale * (x - cx) + t.dx * width;
      const oy = cy + t.scale * (y - cy) + t.dy * height;
      data[y * width + x] = pattern(ox * scale, oy * scale);
    }
  }
  return { data, width, height };
}

const BOX: Box = [300, 300, 600, 600];

describe("align", () => {
  it("finds the shift and zoom an image model added to its redrawing", () => {
    const moved: Similarity = { scale: 1.08, dx: 0.045, dy: -0.07 };
    const levels = [4, 2, 1].map((k) => ({ original: drawn(400 / k, 300 / k, IDENTITY, k), edit: drawn(400 / k, 300 / k, moved, k) }));
    const { transform, before, after } = align(levels, BOX);
    expect(transform.scale).toBeCloseTo(1.08, 2);
    expect(transform.dx).toBeCloseTo(0.045, 2);
    expect(transform.dy).toBeCloseTo(-0.07, 2);
    expect(after).toBeLessThan(before / 5);
  });

  it("leaves an edit that already lines up where it is", () => {
    const levels = [4, 2, 1].map((k) => ({ original: drawn(400 / k, 300 / k, IDENTITY, k), edit: drawn(400 / k, 300 / k, IDENTITY, k) }));
    expect(align(levels, BOX).transform).toEqual(IDENTITY);
  });

  it("ignores a brightness change when comparing", () => {
    const original = drawn(80, 60, IDENTITY);
    const darker = { ...original, data: original.data.map((v) => v - 20) };
    expect(mismatch(original, darker, new Uint8Array(80 * 60), IDENTITY)).toBeCloseTo(0, 5);
  });
});

describe("pasteBack", () => {
  const W = 320;
  const H = 240;
  const rgb = (paint: (x: number, y: number) => [number, number, number]) => {
    const out = Buffer.alloc(W * H * 3);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) out.set(paint(x, y), (y * W + x) * 3);
    return sharp(out, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
  };
  const grey = (x: number, y: number): [number, number, number] => {
    const v = Math.round(pattern(x, y));
    return [v, v, v];
  };

  it("keeps the original pixels outside the box and lines the edit up inside it", async () => {
    const before = await rgb(grey);
    // The model's redrawing: everything 8 px to the right, and a red mark at
    // what is (100..120, 90..110) in the original.
    const edited = await rgb((x, y) => (x >= 108 && x < 128 && y >= 90 && y < 110 ? [220, 30, 30] : grey(x - 8, y)));
    const { image, transform } = await pasteBack(before, edited, [300, 250, 550, 450]);
    expect(transform.dx * W).toBeCloseTo(-8, 0);

    const { data } = await sharp(image).raw().toBuffer({ resolveWithObject: true });
    const original = await sharp(before).raw().toBuffer();
    const px = (buf: Buffer, x: number, y: number) => [...buf.subarray((y * W + x) * 3, (y * W + x) * 3 + 3)];
    expect(px(data, 110, 100)[0]).toBeGreaterThan(180);
    expect(px(data, 110, 100)[1]).toBeLessThan(80);
    for (const [x, y] of [[10, 10], [300, 200], [200, 40]]) expect(px(data, x, y)).toEqual(px(original, x, y));
  });
});
