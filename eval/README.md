# Condition-check eval

How often would Handback propose a charge for damage that is really there, and how often would it propose one for damage that is not?

There are two labeled sets of check-out / check-in photo pairs. Both are scored the same way; they differ in where the photos come from.

## Data

### Synthetic set (`pairs.json`, `images/`)

36 pairs of the demo shop's eight rental items (`lib/catalog.ts`): 12 changed pairs with 14 changes in total, and 24 unchanged pairs.

- **Changed pairs.** A Gemini image model removed an accessory or added damage to the check-out photo (a missing lens hood, a torn grip, a snapped propeller, a cracked projector lens, a bent mudguard with mud, and so on). Code then shifted the light or the framing so the two photos look like two separate visits to the counter. Every edited pair was reviewed by eye and its labels corrected where the edit changed something else.
- **Unchanged pairs (hard negatives).** The same check-out photo with only a lighting change, a 4–5° rotation and crop, or dust specks and a glare spot added in code. Nothing about the item changed, so any proposed charge is a false charge.

All base photos are AI-generated (`scripts/eval/make-pairs.ts`). That makes ground truth exact, but clean generated scenes are easier than real photos. The app's demo mode replays one saved run of this set.

### Real-photo set (`real/pairs.json`, `real/images/`)

55 pairs built on 11 real photographs from Wikimedia Commons under CC0, CC BY and CC BY-SA licenses: 22 changed pairs with 22 changes in total, and 33 unchanged pairs. Sources, authors and licenses are in [`real/CREDITS.md`](real/CREDITS.md); the photos and the changes asked of the image model are listed in `scripts/eval/real-photos.ts`.

- **Base photos.** Real photographs of gear like the demo shop rents: three camera bodies (one laid out as a kit), two telephoto lenses, a drone with its controller, an action camera with its housing, a portable speaker, a projector, and two bicycle rears. They have real lighting, reflections, texture, printed text and cluttered backgrounds (a wooden table, a railing with grass, paving), which the synthetic set lacks. Each pair is mapped to the catalog item whose kit list and price list fit it.
- **Changed pairs.** The same Gemini image model edited each photo (a scratch, a dent, a crack, a torn grille, mud, or a removed accessory), but only a box around the requested change was pasted back onto the original photo with a soft edge. Everything outside that box is the original photograph. Code then shifted the light or turned the photo by 3°. Every pair was reviewed by eye; labels say what the edit actually shows.
- **Unchanged pairs.** As in the synthetic set: a lighting change, a 3° turn with the smallest crop that hides the corners, or dust and glare, all in code.

What this set does not show: the damage itself is still drawn by an image model, and the second photo is the first one shifted in code, not a second photo taken minutes later with a phone. Most base photos are well-lit product shots rather than counter photos taken by staff. A set of real before / after photos of real damage is still missing.

## Scoring

A real change counts as caught when a finding of a compatible kind names it and the policy (`lib/inspection/policy.ts`) turns it into a proposed charge. "False charge" means a proposed charge that matches no real change. Low-confidence findings, pre-existing marks and wear are never charged and are not counted against the model.

With **2 looks**, two independent model calls run in parallel and a charge is proposed only when both point at the same kind of finding and the same price-list entry (`lib/inspection/consensus.ts`).

## Results

### Synthetic set

| Setup | Runs | Real changes proposed as a charge | Right price-list entry | Unchanged pairs charged | Unchanged pairs with any finding (charged or noted) | Extra charges on changed pairs | Errors | Worst p95 latency |
|---|---|---|---|---|---|---|---|---|
| gemini-3.8-flash, thinking low, 1 look, prompt v1 | 3 | 40/42 (95%) | 40/40 | 1/72 (1%) | 1/72 (1%) | 0 | 0 | 12.7 s |
| gemini-3.8-flash, thinking low, 2 looks, prompt v1 | 3 | 41/42 (98%) | 41/41 | 0/72 (0%) | 0/72 (0%) | 0 | 0 | 17.5 s |

### Real-photo set

| Setup | Runs | Real changes proposed as a charge | Right price-list entry | Unchanged pairs charged | Unchanged pairs with any finding (charged or noted) | Extra charges on changed pairs | Errors | Worst p95 latency |
|---|---|---|---|---|---|---|---|---|
| gemini-3.8-flash, thinking low, 1 look, prompt v1 | 3 | 66/66 (100%) | 66/66 | 0/99 (0%) | 6/99 (6%) | 0 | 0 | 9.7 s |
| gemini-3.8-flash, thinking low, 2 looks, prompt v1 | 3 | 63/66 (95%) | 63/63 | 0/99 (0%) | 6/99 (6%) | 0 | 0 | 13.1 s |

### What went wrong, pair by pair

Synthetic set:

- **gemini-3.8-flash, thinking low, 1 look, prompt v1** (3 runs):
  - `ebike-rear__bent-fender-mud`: damage: rear mudguard missed in 2 of 3 runs
  - `ebike-rear__same-light`: false charge: new_damage: rear light (high) in 1 of 3 runs
- **gemini-3.8-flash, thinking low, 2 looks, prompt v1** (3 runs):
  - `ebike-rear__bent-fender-mud`: damage: rear mudguard missed in 1 of 3 runs

Real-photo set:

- **gemini-3.8-flash, thinking low, 1 look, prompt v1** (3 runs):
  - `nikon-z6ii__same-pose`: nothing changed, but a finding was noted (not charged) in 3 of 3 runs: new_damage "model badge", new_damage "camera body badge", new_damage "front body"
  - `sony-100-400__same-dust-glare`: nothing changed, but a finding was noted (not charged) in 3 of 3 runs: wear "zoom ring rubber grip", new_damage "telephoto lens", wear "zoom ring"
- **gemini-3.8-flash, thinking low, 2 looks, prompt v1** (3 runs):
  - `ebike-rear__same-dust-glare`: nothing changed, but a finding was noted (not charged) in 1 of 3 runs: new_damage "frame"
  - `nikon-z6ii__same-pose`: nothing changed, but a finding was noted (not charged) in 2 of 3 runs: new_damage "model badge", new_damage "camera body badge", new_damage "lens barrel", new_damage "mode dial", new_damage "camera body"
  - `sigma-150-600__missing-hood`: missing: lens hood noted but not charged in 3 of 3 runs
  - `sony-100-400__same-dust-glare`: nothing changed, but a finding was noted (not charged) in 3 of 3 runs: new_damage "zoom ring rubber grip", wear "rubber ring grip", wear "telephoto lens", wear "focus ring rubber", wear "rubber zoom ring"

Per-pair results and the model's raw replies are in `runs/` and `real/runs/`. Reproduce with `npm run eval:pairs -- --set real`, then `npm run eval -- --set real --passes 2 --tag r1`, then `npm run eval:summary` (leave out `--set real` for the synthetic set).
