import "server-only";
import { readFileSync } from "node:fs";
import path from "node:path";

export type SampleOption = { key: string; label: string; hint?: string };

/** Eval scenes are photos of these catalog items. */
const SCENE: Record<string, string> = { ebike: "ebike-rear" };

const SAME: Record<string, string> = {
  "same-light": "Back as it left, warmer light",
  "same-pose": "Back as it left, shot at an angle",
  "same-dust-glare": "Back as it left, dust and glare",
};

type PairsFile = { pairs: { id: string; before: string; after: string; truth: { changed: boolean; changes: { detail: string }[] } }[] };

let pairs: PairsFile["pairs"] | undefined;
function loadPairs() {
  pairs ??= (JSON.parse(readFileSync(path.join(process.cwd(), "eval", "pairs.json"), "utf8")) as PairsFile).pairs;
  return pairs;
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
