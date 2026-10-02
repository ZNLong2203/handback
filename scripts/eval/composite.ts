/**
 * Lays one area of an image model's edit over the original photo, for the
 * real-photo eval set. Image models redraw the whole picture when asked for
 * one change, and often shift or zoom it by a few percent. Pasting a box of
 * that redrawing straight back would leave a seam where the box's edge no
 * longer meets the original (a doubled edge, a jump in a lens barrel), which
 * the condition check could fairly report as damage. So the edit is first
 * lined up with the original on everything outside the box.
 */
import sharp from "sharp";

/** [ymin, xmin, ymax, xmax] on a 0-1000 grid, the same convention as the app's boxes. */
export type Box = [number, number, number, number];

/** A single-channel image, values 0-255. */
export type Gray = { data: Float32Array; width: number; height: number };

/**
 * Maps edit coordinates onto the original: original = centre + scale * (edit - centre) + (dx, dy),
 * with dx and dy as fractions of the width and height so one transform fits every resolution.
 */
export type Similarity = { scale: number; dx: number; dy: number };

export const IDENTITY: Similarity = { scale: 1, dx: 0, dy: 0 };

/** Where pixel (x, y) of the original comes from in the edit. */
function source(t: Similarity, x: number, y: number, width: number, height: number) {
  const cx = width / 2;
  const cy = height / 2;
  return [cx + (x - cx - t.dx * width) / t.scale, cy + (y - cy - t.dy * height) / t.scale];
}

function bilinear(img: Gray, x: number, y: number) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  if (x0 < 0 || y0 < 0 || x0 + 1 >= img.width || y0 + 1 >= img.height) return Number.NaN;
  const fx = x - x0;
  const fy = y - y0;
  const i = y0 * img.width + x0;
  const d = img.data;
  return (d[i] * (1 - fx) + d[i + 1] * fx) * (1 - fy) + (d[i + img.width] * (1 - fx) + d[i + img.width + 1] * fx) * fy;
}

/**
 * How badly the edit, moved by `t`, disagrees with the original where
 * `ignore` is 0: the mean absolute difference after removing the average
 * brightness difference, so a darker or warmer redraw still lines up.
 */
export function mismatch(original: Gray, edit: Gray, ignore: Uint8Array, t: Similarity, step = 1) {
  const diffs = new Float32Array(Math.ceil(original.width / step) * Math.ceil(original.height / step));
  let n = 0;
  let sum = 0;
  for (let y = 0; y < original.height; y += step) {
    for (let x = 0; x < original.width; x += step) {
      const p = y * original.width + x;
      if (ignore[p]) continue;
      const [sx, sy] = source(t, x, y, original.width, original.height);
      const v = bilinear(edit, sx, sy);
      if (Number.isNaN(v)) continue;
      diffs[n++] = original.data[p] - v;
      sum += original.data[p] - v;
    }
  }
  // Too little overlap left to judge by: never prefer such a move.
  if (n < diffs.length / 4) return Number.POSITIVE_INFINITY;
  const mean = sum / n;
  let spread = 0;
  for (let i = 0; i < n; i++) spread += Math.abs(diffs[i] - mean);
  return spread / n;
}

function range(from: number, to: number, step: number) {
  const out: number[] = [];
  for (let v = from; v <= to + step / 2; v += step) out.push(v);
  return out;
}

/** Searches every scale and shift on a grid around `start` and keeps the best. */
function search(original: Gray, edit: Gray, ignore: Uint8Array, start: Similarity, scales: number[], shifts: number[], step: number) {
  let best = { t: start, score: mismatch(original, edit, ignore, start, step) };
  for (const ds of scales) {
    for (const sx of shifts) {
      for (const sy of shifts) {
        const t = { scale: start.scale + ds, dx: start.dx + sx / original.width, dy: start.dy + sy / original.height };
        const score = mismatch(original, edit, ignore, t, step);
        if (score < best.score) best = { t, score };
      }
    }
  }
  return best;
}

/** Marks the box plus a margin, which the alignment must not use: that is where the edit is meant to differ. */
export function boxMask(width: number, height: number, box: Box, margin: number) {
  const mask = new Uint8Array(width * height);
  const [y0, x0, y1, x1] = [box[0] / 1000 - margin, box[1] / 1000 - margin, box[2] / 1000 + margin, box[3] / 1000 + margin];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (x >= x0 * width && x <= x1 * width && y >= y0 * height && y <= y1 * height) mask[y * width + x] = 1;
    }
  }
  return mask;
}

/** One size of the original and the edit; `align` works from the smallest size up. */
export type Level = { original: Gray; edit: Gray };

/**
 * The shift (up to 10% each way) and zoom (up to 12%) that best line the
 * edit up with the original outside `box`: every combination on the smallest
 * copies, then finer and finer steps around the best match on larger ones.
 */
export function align(levels: Level[], box: Box) {
  let best = { t: IDENTITY, score: Number.POSITIVE_INFINITY };
  let scaleStep = 0.02;
  levels.forEach((level, i) => {
    const { width, height } = level.original;
    const ignore = boxMask(width, height, box, 0.04);
    const scales = i === 0 ? range(-0.12, 0.12, scaleStep) : range(-scaleStep, scaleStep, scaleStep / 4);
    if (i > 0) scaleStep /= 4;
    const reach = i === 0 ? Math.round(width * 0.1) : Math.ceil(width / levels[i - 1].original.width) + 1;
    best = search(level.original, level.edit, ignore, best.t, scales, range(-reach, reach, 1), width > 400 ? 2 : 1);
  });
  const finest = levels[levels.length - 1];
  const ignore = boxMask(finest.original.width, finest.original.height, box, 0.04);
  return { transform: best.t, before: mismatch(finest.original, finest.edit, ignore, IDENTITY, 2), after: best.score };
}

async function gray(input: Buffer, width: number, height: number): Promise<Gray> {
  const data = await sharp(input).resize(width, height, { fit: "fill" }).removeAlpha().greyscale().raw().toBuffer();
  return { data: Float32Array.from(data), width, height };
}

/**
 * Takes only `region` from the image model's edit, lined up with the original,
 * and lays it over the original photo with a soft edge, so the rest of the
 * check-in photo is the real photograph. The edit's colour is matched to the
 * original just around the region so the seam does not show. Also reports
 * how the edit had to be moved and how much it changed inside the region.
 */
export async function pasteBack(before: Buffer, edited: Buffer, region: Box) {
  const { data: base, info } = await sharp(before).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H } = info;
  const levels = await Promise.all(
    [100, 200, 640].map(async (w) => {
      const h = Math.round((H / W) * w);
      return { original: await gray(before, w, h), edit: await gray(edited, w, h) };
    }),
  );
  const fit = align(levels, region);

  const editRgb = await sharp(edited).resize(W, H, { fit: "fill" }).removeAlpha().raw().toBuffer();
  const channels = [0, 1, 2].map((c) => ({ data: Float32Array.from({ length: W * H }, (_, p) => editRgb[p * 3 + c]), width: W, height: H }));
  const edit = new Float32Array(W * H * 3).fill(Number.NaN);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const [sx, sy] = source(fit.transform, x, y, W, H);
      for (let c = 0; c < 3; c++) edit[(y * W + x) * 3 + c] = bilinear(channels[c], sx, sy);
    }
  }

  const [y0, x0, y1, x1] = [(region[0] * H) / 1000, (region[1] * W) / 1000, (region[2] * H) / 1000, (region[3] * W) / 1000];
  const feather = Math.max(4, Math.round(Math.min(W, H) * 0.02));
  const ring = feather * 3;
  const distance = (x: number, y: number) => Math.hypot(Math.max(x0 - x, 0, x - x1), Math.max(y0 - y, 0, y - y1));

  const sums = [0, 0, 0];
  let ringPixels = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = distance(x, y);
      const p = y * W + x;
      if (d <= feather || d > ring || Number.isNaN(edit[p * 3])) continue;
      for (let c = 0; c < 3; c++) sums[c] += base[p * 3 + c] - edit[p * 3 + c];
      ringPixels++;
    }
  }
  const offset = sums.map((s) => Math.max(-25, Math.min(25, ringPixels ? s / ringPixels : 0)));

  const out = Buffer.from(base);
  let inside = 0;
  let insidePixels = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = y * W + x;
      const d = distance(x, y);
      if (d >= feather || Number.isNaN(edit[p * 3])) continue;
      const alpha = d === 0 ? 1 : 0.5 * (1 + Math.cos((Math.PI * d) / feather));
      for (let c = 0; c < 3; c++) {
        const i = p * 3 + c;
        const e = Math.max(0, Math.min(255, edit[i] + offset[c]));
        if (d === 0) inside += Math.abs(e - base[i]) / 3;
        out[i] = Math.round(base[i] * (1 - alpha) + e * alpha);
      }
      if (d === 0) insidePixels++;
    }
  }
  return {
    image: await sharp(out, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer(),
    transform: fit.transform,
    /** Mean grey-level mismatch outside the region before and after lining the edit up. */
    misfit: { before: fit.before, after: fit.after },
    inside: inside / Math.max(1, insidePixels),
  };
}
