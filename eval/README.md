# Condition-check eval

How often would Handback propose a charge for damage that is really there, and how often would it propose one for damage that is not?

There are two labeled sets of check-out / check-in photo pairs. Both are scored the same way; they differ in where the photos come from.

## Data

### Synthetic set (`pairs.json`, `images/`)

36 pairs of the demo shop's eight rental items (`lib/catalog.ts`): 12 changed pairs with 14 changes in total, and 24 unchanged pairs.

- **Changed pairs.** A Gemini image model removed an accessory or added damage to the check-out photo (a missing lens hood, a torn grip, a snapped propeller, a cracked projector lens, a bent mudguard with mud, and so on). Code then shifted the light or the framing so the two photos look like two separate visits to the counter. Every edited pair was reviewed by eye and its labels corrected where the edit changed something else.
- **Unchanged pairs (hard negatives).** The same check-out photo with only a lighting change (a warm tint that also drains colour, which matters little on these mostly grey scenes), a 4–5° rotation and crop, or dust specks and a glare spot added in code. Nothing about the item changed, so any proposed charge is a false charge.

All base photos are AI-generated (`scripts/eval/make-pairs.ts`). That makes ground truth exact, but clean generated scenes are easier than real photos. The app's demo mode replays one saved run of this set.

### Real-photo set (`real/pairs.json`, `real/images/`)

55 pairs built on 11 real photographs from Wikimedia Commons under CC0, CC BY and CC BY-SA licenses: 22 changed pairs with 22 changes in total, and 33 unchanged pairs. Sources, authors and licenses are in [`real/CREDITS.md`](real/CREDITS.md); these images are not covered by the repository's MIT license. The photos and the changes asked of the image model are listed in `scripts/eval/real-photos.ts`.

- **Base photos.** Real photographs of gear like the demo shop rents: three camera bodies (one laid out as a kit), two telephoto lenses, a drone with its controller, an action camera with its housing, a portable speaker, a projector, and two bicycle rears. They have real lighting, reflections, texture, printed text and cluttered backgrounds (a wooden table, a railing with grass, paving), which the synthetic set lacks. Each pair is mapped to the catalog item whose kit list and price list fit it.
- **Changed pairs.** The same Gemini image model edited each photo (a scratch, a dent, a crack, a torn grille, mud, or a removed accessory). The model redraws the whole photo and often shifts or zooms it a little, so its edit is first lined up with the original (`scripts/eval/composite.ts`), and only a box around the requested change is pasted back with a soft edge. Everything outside that box is the original photograph. Code then made the light warmer and dimmer or turned the photo by 3°. Every pair was reviewed by eye. Five prompts the model ignored were rewritten and run again, and labels say what the edit actually shows where it differs from what was asked (a chipped, not shortened, tripod foot; a cracked, not bent, mudguard).
- **How much is drawn, and where it shows.** The pasted box (before its soft edge) covers 4% to 43% of the frame. In 3 pairs it covers more than a third (`dji-mini4__missing-controller` 43%, `ebike-rear__mud` 38%, `sony-action-cam__missing-housing` 37%), so that much of the check-in photo is the image model's drawing, not the photograph. The box's colour is matched to the original with one average shift per colour channel, measured in a ring just outside it. Where the image model redrew a plain background in a slightly different tone, that leaves a faint step along part of the box edge: about 10 to 15 levels (of 255) on plain background in `sony-action-cam__missing-housing`, `dji-mini4__missing-controller` and `sony-a7r-kit__missing-battery`, less in the others. The step shows where the edit is, so the model may find these changes more easily than in a real check-in photo, and the share of changes caught on this set may be optimistic. Unchanged pairs have no pasted box. A better colour match would change these photos and void every saved run of the set, including the prompt v1 runs the comparison below rests on, so the photos were left as they are.
- **Unchanged pairs.** A warmer, dimmer light that keeps the photo's colours, a 3° turn with the smallest crop that hides the corners, or dust specks and a glare spot, all in code.

What this set does not show: the damage itself is still drawn by an image model, sometimes over a large part of the frame and with a visible box edge, and the second photo is the first one shifted in code, not a second photo taken minutes later with a phone. Most base photos are well-lit product shots rather than counter photos taken by staff. A set of real before / after photos of real damage is still missing.

## Scoring

A real change counts as caught when a finding of a compatible kind names it and the policy (`lib/inspection/policy.ts`) turns it into a proposed charge. "False charge" means a proposed charge that matches no real change. Low-confidence findings, pre-existing marks and wear are never charged, so they never count as false charges.

With **2 looks**, two independent model calls run in parallel and a charge is proposed only when both point at the same kind of finding and the same price-list entry (`lib/inspection/consensus.ts`).

"Unchanged pairs with any finding" counts unchanged pairs where any look reported a change other than a mark already there at check-out, charged or not. An uncharged finding is not a false charge, but it still reaches staff and the customer as a note.

"Both looks agreed" means both looks reported the same kind of new damage, missing part or dirt at high confidence and pointed it at the same price-list entry, or both at none. That is the match consensus needs before it proposes a charge, so on an unchanged pair only a missing price-list entry keeps such a finding off the bill.

Requests that fail on the network (or get a 429 or 5xx) are sent again, up to twice; a reply that fails validation counts as an error. The first two-look run of the real set lost two requests to the network before this retry existed and was run again.

## Results

### Synthetic set

| Setup | Runs | Real changes proposed as a charge | Right price-list entry | Unchanged pairs charged | Unchanged pairs with any finding (charged or noted) | Extra charges on changed pairs | Errors | Worst p95 latency |
|---|---|---|---|---|---|---|---|---|
| gemini-3.8-flash, thinking low, 1 look, prompt v1 | 3 | 40/42 (95%) | 40/40 | 1/72 (1%) | 1/72 (1%) | 0 | 0 | 12.7 s |
| gemini-3.8-flash, thinking low, 2 looks, prompt v1 | 3 | 41/42 (98%) | 41/41 | 0/72 (0%) | 0/72 (0%) | 0 | 0 | 17.5 s |
| gemini-3.8-flash, thinking low, 2 looks, prompt v2 | 3 | 41/42 (98%) | 41/41 | 0/72 (0%) | 1/72 (1%) | 0 | 0 | 11.6 s |

### Real-photo set

| Setup | Runs | Real changes proposed as a charge | Right price-list entry | Unchanged pairs charged | Unchanged pairs with any finding (charged or noted) | Extra charges on changed pairs | Errors | Worst p95 latency |
|---|---|---|---|---|---|---|---|---|
| gemini-3.8-flash, thinking low, 1 look, prompt v1 | 3 | 66/66 (100%) | 66/66 | 0/99 (0%) | 6/99 (6%) | 0 | 0 | 9.7 s |
| gemini-3.8-flash, thinking low, 2 looks, prompt v1 | 3 | 63/66 (95%) | 63/63 | 0/99 (0%) | 6/99 (6%) | 0 | 0 | 13.1 s |
| gemini-3.8-flash, thinking low, 2 looks, prompt v2 | 3 | 63/66 (95%) | 63/63 | 0/99 (0%) | 6/99 (6%) | 0 | 0 | 10.0 s |

### What the real photos showed

- **Charges.** In every run on the real photos, with one look or two and with either prompt, no unchanged pair was charged and every charged change got the right price-list entry.
- **What two looks cost.** The one real change missed is the removed Sigma lens hood (`sigma-150-600__missing-hood`). Without it the lens ends in a front barrel almost as wide and just as black, and in every two-look run at least one look did not see the hood was gone, so consensus kept it off the bill. With one look it was charged in 3 of 3 runs. Two looks trade a little recall for safety, which is the trade the app makes.
- **Findings on unchanged items.** With prompt v1, two unchanged pairs drew high-confidence findings in almost every run. None was charged, because the second look disagreed or no price-list entry fit, but uncharged findings still reach staff and the customer as notes:
  - After a 3° turn of the Nikon photo the model said the "Z 6II" badge was now upside down. It is not: apart from the 3° turn and the crop, the two photos are the same pixels. In one two-look run one look also priced "inverted" lens and mode-dial markings at $120 + $60; the other look disagreed.
  - A glare spot over a textured or painted part was read as damage: the ribbed zoom ring of the Sony lens "worn smooth", and once the e-bike's seat tube "scuffed". The spot also lightens the background around it, which a person would take as a sign of light, not wear.

### Prompt v2: what changed and what did not

The prompt already told the model to ignore camera angle and glare. Prompt v2 (`lib/inspection/prompt.ts`) names the two cases above: printed text never turns around, and texture that only looks smooth where the light is brightest is glare. Both sets were run again with two looks; the Runs row says how often.

Real-photo set:

| Two looks | Prompt v1 | Prompt v2 |
|---|---|---|
| Runs | 3 | 3 |
| Real changes proposed as a charge | 63/66 | 63/66 |
| Unchanged pairs charged | 0/99 | 0/99 |
| Unchanged pairs with any finding (charged or noted) | 6/99 | 6/99 |
| Unchanged pairs where both looks agreed on a finding | 2/99 | 2/99 |
| Unchanged pairs where a look named a price-list entry | 1/99 | 0/99 |
| `ebike-rear__same-dust-glare`: runs with a finding | 1 of 3 | 3 of 3, both looks agreed in 2 |
| `nikon-z6ii__same-pose`: runs with a finding | 2 of 3, both looks agreed in 2 | 0 of 3 |
| `sony-100-400__same-dust-glare`: runs with a finding | 3 of 3 | 3 of 3 |

Synthetic set:

| Two looks | Prompt v1 | Prompt v2 |
|---|---|---|
| Runs | 3 | 3 |
| Real changes proposed as a charge | 41/42 | 41/42 |
| Unchanged pairs charged | 0/72 | 0/72 |
| Unchanged pairs with any finding (charged or noted) | 0/72 | 1/72 |
| Unchanged pairs where both looks agreed on a finding | 0/72 | 0/72 |
| Unchanged pairs where a look named a price-list entry | 0/72 | 1/72 |
| `pa-speaker__same-pose`: runs with a finding | 0 of 3 | 1 of 3 |

- **The text sentence worked.** The turned Nikon photo drew a finding in 2 of 3 prompt v1 runs and in 0 of 3 prompt v2 runs.
- **The glare sentence did not, and on the e-bike it made things worse.** The e-bike's glare pair drew a finding in 1 of 3 prompt v1 runs, and the two looks never agreed on it. With prompt v2 it drew one in 3 of 3 runs, and in 2 of them both looks reported new damage to the seat tube at high confidence: the agreement the app needs before it proposes a charge. It stayed off the bill only because the e-bike's price list (`lib/catalog.ts`) has no entry for the frame, so the app would show it to staff as a note they can price by hand. The Sony lens's glare pair drew a finding in 3 of 3 runs with prompt v1 and 3 of 3 with prompt v2.
- **The totals on the real set hardly moved.** Prompt v2 removed the Nikon findings and added e-bike ones. Unchanged pairs with any finding: 6/99 with prompt v1 and 6/99 with prompt v2. Where both looks agreed: 2/99 and 2/99, the Nikon then and the e-bike now. Where a look named a price-list entry: 1/99 and 0/99, the Nikon markings above.
- **Synthetic set.** Unchanged pairs with any finding went from 0/72 to 1/72: a grille dent one look priced on an unchanged speaker, which the other look did not see.

Prompt v2 is what the app now sends, because it removes the text mistake; the glare mistake is still open. The demo mode still replays a prompt v1 run of the synthetic set.

**Proposed fix for glare (not built yet).** Glare is a photo problem more than a wording problem, so the fix belongs before the model: `lib/photos.ts` already rejects blurry, dark and washed-out photos in code. A local check could compare the check-in photo with the check-out photo and flag a region where brightness rises while contrast and colour drop across both the item and its background, and ask staff to retake the photo away from the light before the condition check runs.

### What went wrong, pair by pair

Synthetic set:

- **gemini-3.8-flash, thinking low, 1 look, prompt v1** (3 runs):
  - `ebike-rear__bent-fender-mud`: damage: rear mudguard missed in 2 of 3 runs
  - `ebike-rear__same-light`: false charge: new_damage: rear light (high) in 1 of 3 runs
- **gemini-3.8-flash, thinking low, 2 looks, prompt v1** (3 runs):
  - `ebike-rear__bent-fender-mud`: damage: rear mudguard missed in 1 of 3 runs
- **gemini-3.8-flash, thinking low, 2 looks, prompt v2** (3 runs):
  - `ebike-rear__bent-fender-mud`: damage: rear mudguard noted but not charged in 1 of 3 runs
  - `pa-speaker__same-pose`: nothing changed, but a finding was noted (not charged) in 1 of 3 runs: new_damage "grille"

Real-photo set:

- **gemini-3.8-flash, thinking low, 1 look, prompt v1** (3 runs):
  - `nikon-z6ii__same-pose`: nothing changed, but a finding was noted (not charged) in 3 of 3 runs: new_damage "model badge", new_damage "camera body badge", new_damage "front body"
  - `sony-100-400__same-dust-glare`: nothing changed, but a finding was noted (not charged) in 3 of 3 runs: wear "zoom ring rubber grip", new_damage "telephoto lens", wear "zoom ring"
- **gemini-3.8-flash, thinking low, 2 looks, prompt v1** (3 runs):
  - `ebike-rear__same-dust-glare`: nothing changed, but a finding was noted (not charged) in 1 of 3 runs: new_damage "frame"
  - `nikon-z6ii__same-pose`: nothing changed, but both looks agreed on a finding (not charged) in 2 of 3 runs: new_damage "model badge", new_damage "camera body badge", new_damage "lens barrel", new_damage "mode dial", new_damage "camera body"
  - `sigma-150-600__missing-hood`: missing: lens hood noted but not charged in 3 of 3 runs
  - `sony-100-400__same-dust-glare`: nothing changed, but a finding was noted (not charged) in 3 of 3 runs: new_damage "zoom ring rubber grip", wear "rubber ring grip", wear "telephoto lens", wear "focus ring rubber", wear "rubber zoom ring"
- **gemini-3.8-flash, thinking low, 2 looks, prompt v2** (3 runs):
  - `ebike-rear__same-dust-glare`: nothing changed, but both looks agreed on a finding (not charged) in 2 of 3 runs; nothing changed, but a finding was noted (not charged) in 1 of 3 runs: new_damage "seat tube paint", new_damage "seat tube"
  - `sigma-150-600__missing-hood`: missing: lens hood missed in 2 of 3 runs; missing: lens hood noted but not charged in 1 of 3 runs
  - `sony-100-400__same-dust-glare`: nothing changed, but a finding was noted (not charged) in 3 of 3 runs: new_damage "telephoto lens", new_damage "zoom ring rubber grip", wear "telephoto lens"

Per-pair results and the model's raw replies are in `runs/` and `real/runs/`. Reproduce with `npm run eval:pairs -- --set real`, then `npm run eval -- --set real --passes 2 --tag r1`, then `npm run eval:summary` (leave out `--set real` for the synthetic set).
