import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { RentalItem } from "@/lib/catalog";
import { samplePair, type SampleSet } from "@/lib/samples";
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

/**
 * The recorded runs whose replies demo mode replays for the bundled sample
 * photos, one per sample set (lib/samples.ts): a prompt v1 run of the
 * synthetic eval set, and a prompt v2 run of the demo-only samples.
 */
const REPLAY_RUNS: Record<SampleSet, string> = {
  eval: "eval/runs/gemini-3.8-flash-low-x2-r1.json",
  "eval/samples": "eval/samples/runs/gemini-3.8-flash-low-x2-r1.json",
};

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

async function replay(checkoutSample: string | null, checkinSample: string | null): Promise<ModelOutput[] | null> {
  if (!checkoutSample || !checkinSample) return null;
  if (checkoutSample === checkinSample) {
    const clean: ModelOutput = { photos_usable: true, photo_issue: null, same_item: true, findings: [], summary: "No changes between check-out and check-in." };
    return [clean, clean];
  }
  const pair = samplePair(checkoutSample, checkinSample);
  if (!pair) return null;
  const run = JSON.parse(await readFile(path.join(process.cwd(), REPLAY_RUNS[pair.set]), "utf8")) as RecordedRun;
  const outputs = run.results.find((r) => r.id === pair.id)?.outputs;
  return outputs && outputs.length === 2 ? outputs : null;
}
