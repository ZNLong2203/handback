import "server-only";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export type SampleOption = { key: string; label: string; hint?: string };

/**
 * Where the bundled AI-generated sample photos live: the synthetic eval set,
 * and demo-only samples kept out of the eval so its published numbers stay
 * as measured (scripts/eval/sample-photos.ts). Each holds pairs.json and
 * images/<scene>/; a sample key is "<scene>/<file name without .jpg>".
 */
export const SAMPLE_SETS = ["eval", "eval/samples"] as const;
export type SampleSet = (typeof SAMPLE_SETS)[number];

const KEY = /^[a-z0-9-]+\/[a-z0-9_-]+$/;

/** Eval scenes are photos of these catalog items. */
const SCENE: Record<string, string> = { ebike: "ebike-rear" };

const SAME: Record<string, string> = {
  "same-light": "Back as it left, warmer light",
  "same-pose": "Back as it left, shot at an angle",
  "same-dust-glare": "Back as it left, dust and glare",
};

type Pair = { id: string; before: string; after: string; truth: { changed: boolean; changes: { detail: string }[] } };
type PairsFile = { pairs: Pair[] };

let pairs: (Pair & { set: SampleSet })[] | undefined;
function loadPairs() {
  pairs ??= SAMPLE_SETS.flatMap((set) =>
    (JSON.parse(readFileSync(path.join(process.cwd(), set, "pairs.json"), "utf8")) as PairsFile).pairs.map((p) => ({ ...p, set })),
  );
  return pairs;
}

/** The photo file behind a sample key such as "camera-kit/before", or null when there is none. */
export function sampleFile(key: string): string | null {
  if (!KEY.test(key)) return null;
  for (const set of SAMPLE_SETS) {
    const file = path.join(process.cwd(), set, "images", `${key}.jpg`);
    if (existsSync(file)) return file;
  }
  return null;
}

/** The labeled pair made of these two sample photos, and the set it belongs to. */
export function samplePair(checkoutKey: string, checkinKey: string): { set: SampleSet; id: string } | null {
  const pair = loadPairs().find((p) => p.before === `images/${checkoutKey}.jpg` && p.after === `images/${checkinKey}.jpg`);
  return pair ? { set: pair.set, id: pair.id } : null;
}

/** The bundled AI-generated photos a person can use instead of a camera when trying the demo. */
export function samplesFor(itemId: string, phase: "checkout" | "checkin"): SampleOption[] {
  const scene = SCENE[itemId] ?? itemId;
  if (phase === "checkout") return [{ key: `${scene}/before`, label: "Pickup photo", hint: "As it leaves the shop" }];
  return loadPairs()
    .filter((p) => p.before === `images/${scene}/before.jpg`)
    .map((p) => {
      const variant = p.after.replace(`images/${scene}/after__`, "").replace(".jpg", "");
      const label = SAME[variant] ?? p.truth.changes.map((c) => c.detail).join(", ");
      return { key: p.after.replace(/^images\//, "").replace(/\.jpg$/, ""), label: label.charAt(0).toUpperCase() + label.slice(1), hint: p.truth.changed ? "Something changed" : "Nothing changed" };
    })
    .sort((a, b) => (a.hint === b.hint ? 0 : a.hint === "Nothing changed" ? -1 : 1));
}
