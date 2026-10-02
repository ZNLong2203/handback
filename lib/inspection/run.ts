import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { RentalItem } from "@/lib/catalog";
import { compareCondition, DEFAULT_VISION_MODEL } from "./compare";
import { mergeLooks } from "./consensus";
import { assess, type Assessment } from "./policy";
import type { ModelOutput } from "./schema";

export type InspectionRun = {
  assessment: Assessment;
  looks: ModelOutput[];
  model: string;
  source: "live" | "replay" | "unavailable";
  ms: number;
};

/** The recorded run whose replies demo mode replays for the bundled sample photos. */
const REPLAY_RUN = "eval/runs/gemini-3.8-flash-low-x2-r1.json";

type Photo = { bytes: Buffer; sample: string | null };

export function aiConfigured(): boolean {
  return Boolean(process.env.GEMINI_API_KEY) && process.env.DEMO_MODE !== "true";
}

/**
 * Two independent looks at the check-out and check-in photos, then the
 * deterministic policy and the agreement rule. Without an API key, the
 * bundled sample photos replay recorded Gemini replies from the eval, so the
 * whole flow still works for anyone who clones the repo.
 */
export async function inspectReturn(checkout: Photo, checkin: Photo, item: RentalItem, shopName: string): Promise<InspectionRun> {
  const started = Date.now();
  if (aiConfigured()) {
    const input = {
      before: { base64: checkout.bytes.toString("base64"), mimeType: "image/jpeg" },
      after: { base64: checkin.bytes.toString("base64"), mimeType: "image/jpeg" },
      item,
      shopName,
    };
    const looks = await Promise.all([compareCondition(input), compareCondition(input)]);
    const [a, b] = looks.map((l) => assess(l.output, item));
    return {
      assessment: mergeLooks(a, b, item.depositCents),
      looks: looks.map((l) => l.output),
      model: looks[0].model,
      source: "live",
      ms: Date.now() - started,
    };
  }

  const replayed = await replay(checkout.sample, checkin.sample);
  if (replayed) {
    const [a, b] = replayed.map((o) => assess(o, item));
    return { assessment: mergeLooks(a, b, item.depositCents), looks: replayed, model: DEFAULT_VISION_MODEL, source: "replay", ms: Date.now() - started };
  }

  return {
    assessment: {
      usable: false,
      issue: "AI comparison is turned off in this deployment, and these are not bundled sample photos. Compare the photos by eye.",
      findings: [],
      proposedCents: 0,
      overDepositCents: 0,
      summary: "",
    },
    looks: [],
    model: "none",
    source: "unavailable",
    ms: Date.now() - started,
  };
}

type RecordedRun = { results: { id: string; outputs?: ModelOutput[] }[] };
type PairsFile = { pairs: { id: string; before: string; after: string }[] };

async function replay(checkoutSample: string | null, checkinSample: string | null): Promise<ModelOutput[] | null> {
  if (!checkoutSample || !checkinSample) return null;
  if (checkoutSample === checkinSample) {
    const clean: ModelOutput = { photos_usable: true, photo_issue: null, same_item: true, findings: [], summary: "No changes between check-out and check-in." };
    return [clean, clean];
  }
  const root = process.cwd();
  const [pairs, run] = await Promise.all([
    readFile(path.join(root, "eval/pairs.json"), "utf8").then((t) => JSON.parse(t) as PairsFile),
    readFile(path.join(root, REPLAY_RUN), "utf8").then((t) => JSON.parse(t) as RecordedRun),
  ]);
  const pair = pairs.pairs.find((p) => p.before === `images/${checkoutSample}.jpg` && p.after === `images/${checkinSample}.jpg`);
  const outputs = pair && run.results.find((r) => r.id === pair.id)?.outputs;
  return outputs && outputs.length === 2 ? outputs : null;
}
