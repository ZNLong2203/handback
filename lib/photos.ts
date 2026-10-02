import "server-only";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { getDb } from "@/lib/db/client";

export type PhotoQuality = {
  brightness: number;
  sharpness: number;
  /** Plain-language problems; empty when the photo is fine to compare. */
  problems: string[];
};

export type StoredPhoto = { sha256: string; width: number; height: number; quality: PhotoQuality };

const MAX_EDGE = 1600;

/**
 * Deterministic checks before any model sees the photo: a blurry or badly
 * exposed photo is rejected at the counter instead of letting the model guess.
 * Thresholds come from the sample photos: sharp ones score 170–1600 on the
 * Laplacian variance at 640 px, a heavily blurred one about 2.
 */
export async function measureQuality(bytes: Buffer): Promise<PhotoQuality> {
  const grey = await sharp(bytes).rotate().resize({ width: 640 }).greyscale().raw().toBuffer({ resolveWithObject: true });
  const brightness = (await sharp(grey.data, { raw: grey.info }).stats()).channels[0].mean;
  const lap = await sharp(grey.data, { raw: grey.info })
    .convolve({ width: 3, height: 3, kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0], offset: 128 })
    .raw()
    .toBuffer();
  let sum = 0;
  let sumSq = 0;
  for (const v of lap) {
    sum += v;
    sumSq += v * v;
  }
  const sharpness = sumSq / lap.length - (sum / lap.length) ** 2;
  const problems: string[] = [];
  if (sharpness < 40) problems.push("The photo is blurry. Hold the phone still and tap to focus.");
  if (brightness < 45) problems.push("The photo is too dark. Turn on the counter light.");
  if (brightness > 230) problems.push("The photo is washed out. Move away from the window or lamp.");
  return { brightness: Math.round(brightness), sharpness: Math.round(sharpness), problems };
}

/**
 * Normalises the image (EXIF orientation, at most 1600 px, JPEG) and stores
 * it under the SHA-256 of the stored bytes: the hash a customer acknowledges
 * always refers to exactly this image.
 */
export async function storePhoto(input: Buffer): Promise<StoredPhoto> {
  const { data, info } = await sharp(input)
    .rotate()
    .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  const sha256 = createHash("sha256").update(data).digest("hex");
  const db = await getDb();
  await db.query(
    "insert into photos (sha256, mime_type, bytes, width, height) values ($1, 'image/jpeg', $2, $3, $4) on conflict (sha256) do nothing",
    [sha256, data, info.width, info.height],
  );
  return { sha256, width: info.width, height: info.height, quality: await measureQuality(data) };
}

export async function loadPhoto(sha256: string): Promise<{ bytes: Buffer; mimeType: string } | null> {
  if (!/^[0-9a-f]{64}$/.test(sha256)) return null;
  const db = await getDb();
  const rows = await db.query<{ bytes: Uint8Array; mime_type: string }>("select bytes, mime_type from photos where sha256 = $1", [sha256]);
  if (!rows[0]) return null;
  return { bytes: Buffer.from(rows[0].bytes), mimeType: rows[0].mime_type };
}
