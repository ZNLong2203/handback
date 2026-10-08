import sharp from "sharp";

/** The longest edge a stored photo keeps, in pixels. */
export const MAX_EDGE = 1600;

/**
 * The bytes the app stores for a photo, and so the bytes Gemini compares:
 * EXIF orientation applied and every other metadata block dropped (phone
 * photos carry GPS), at most 1600 px on the longest edge, JPEG quality 95
 * with colour kept at full resolution (4:4:4).
 *
 * Measured, not guessed (docs/ai-build-log.md, 2026-10-08): single looks at
 * the city bike sample found its small red rear light in 12 of 12 on the
 * original files, 0 of 6 at the old quality 85 (4:2:0, and 0 of 6 at 85 with
 * 4:4:4), 7 of 12 at 90 and 12 of 12 at 95 (both 4:4:4). Most photos arrive
 * already compressed, and a second encode at a similar quality loses detail a
 * small part depends on. Stored files are larger: about 200 KB instead of
 * 120 KB for a sample photo, and under 1 MB for a detailed 1600 px photo.
 * scripts/eval/run-eval.ts --app-encoding runs the eval through this function.
 */
export async function encodePhoto(input: Buffer): Promise<{ data: Buffer; width: number; height: number }> {
  const { data, info } = await sharp(input)
    .rotate()
    .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 95, chromaSubsampling: "4:4:4", mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}
