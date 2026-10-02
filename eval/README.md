# Condition-check eval

How often would Handback propose a charge for damage that is really there, and how often would it propose one for damage that is not?

## Data

`pairs.json` lists 36 labeled check-out / check-in photo pairs of the demo shop's eight rental items (`lib/catalog.ts`):

- **Changed pairs.** A Gemini image model removed an accessory or added damage to the check-out photo (a missing lens hood, a torn grip, a snapped propeller, a cracked projector lens, a bent mudguard with mud, and so on). Code then shifted the light or the framing so the two photos look like two separate visits to the counter. Every edited pair was reviewed by eye and its labels corrected where the edit changed something else.
- **Unchanged pairs (hard negatives).** The same check-out photo with only a lighting change, a 4–5° rotation and crop, or dust specks and a glare spot added in code. Nothing about the item changed, so any proposed charge is a false charge.

All base photos are AI-generated (`scripts/eval/make-pairs.ts`). That makes ground truth exact but is easier than real counter photos; a real-photo set is the next step.

## Scoring

A real change counts as caught when a finding of a compatible kind names it and the policy (`lib/inspection/policy.ts`) turns it into a proposed charge. "False charge" means a proposed charge that matches no real change. Low-confidence findings, pre-existing marks and wear are never charged and are not counted against the model.

With **2 looks**, two independent model calls run in parallel and a charge is proposed only when both point at the same kind of finding and the same price-list entry (`lib/inspection/consensus.ts`).

## Results

| Setup | Runs | Real changes proposed as a charge | Right price-list entry | Unchanged pairs charged | Extra charges on changed pairs | Worst p95 latency |
|---|---|---|---|---|---|---|
| gemini-3.8-flash, thinking low, 1 look | 3 | 40/42 (95%) | 40/40 | 1/72 (1%) | 0 | 12.7 s |
| gemini-3.8-flash, thinking low, 2 looks | 3 | 41/42 (98%) | 41/41 | 0/72 (0%) | 0 | 17.5 s |

Per-pair results and the model's raw replies are in `runs/`. Reproduce with `npm run eval:pairs`, then `npm run eval -- --passes 2 --tag r1`, then `npm run eval:summary`.
