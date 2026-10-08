# Condition-check eval: gemini-3.8-flash, thinking low, 2 independent looks that must agree

55 labeled photo pairs built on real photographs: 22 with real changes (22 changes in total) and 33 unchanged pairs that only differ in light, pose, dust or glare.

Each photo was re-encoded the way the app stores an uploaded one (`lib/photo-encoding.ts`) before the model saw it.

| Metric | Result |
|---|---|
| Real changes noticed (any confidence) | 22/22 (100%) |
| Real changes proposed as a charge | 21/22 (95%) |
| ...with the right price-list entry | 21/21 |
| Unchanged pairs that would have been charged | 0/33 (0%) |
| Extra charges on changed pairs | 0 |
| Errors / replies repaired / requests retried after a network error | 0 / 0 / 0 |
| Latency p50 / p95 | 9.9 s / 22.2 s |
| Tokens per pair (in / out) | 5779 / 471 |

## Per pair

| Pair | Caught | False charges | Notes | Proposed |
|---|---|---|---|---|
| bike-rack__bent-mudguard | damage: rear mudguard ✔ | — | 0 | $40.00 |
| bike-rack__broken-reflector | damage: rear reflector ✔ | — | 0 | $25.00 |
| bike-rack__same-dust-glare | — | — | 0 | $0.00 |
| bike-rack__same-light | — | — | 0 | $0.00 |
| bike-rack__same-pose | — | — | 0 | $0.00 |
| dji-mini4__broken-propeller | damage: drone propeller ✔ | — | 0 | $14.00 |
| dji-mini4__missing-controller | missing: remote controller ✔ | — | 0 | $149.00 |
| dji-mini4__same-dust-glare | — | — | 0 | $0.00 |
| dji-mini4__same-light | — | — | 0 | $0.00 |
| dji-mini4__same-pose | — | — | 0 | $0.00 |
| ebike-rear__cracked-battery | damage: battery casing ✔ | — | 0 | $250.00 |
| ebike-rear__mud | dirt: rear mudguard and wheel ✔ | — | 0 | $25.00 |
| ebike-rear__same-dust-glare | — | — | 1 | $0.00 |
| ebike-rear__same-light | — | — | 0 | $0.00 |
| ebike-rear__same-pose | — | — | 0 | $0.00 |
| jbl-boombox__cracked-handle | damage: carry handle ✔ | — | 0 | $30.00 |
| jbl-boombox__same-dust-glare | — | — | 0 | $0.00 |
| jbl-boombox__same-light | — | — | 0 | $0.00 |
| jbl-boombox__same-pose | — | — | 0 | $0.00 |
| jbl-boombox__torn-grille | damage: speaker grille ✔ | — | 0 | $55.00 |
| lg-projector__cracked-housing | damage: projector housing ✔ | — | 0 | $70.00 |
| lg-projector__cracked-lens | damage: projector lens ✔ | — | 0 | $160.00 |
| lg-projector__same-dust-glare | — | — | 0 | $0.00 |
| lg-projector__same-light | — | — | 0 | $0.00 |
| lg-projector__same-pose | — | — | 0 | $0.00 |
| lumix-s5ii__barrel-dent | damage: lens barrel ✔ | — | 0 | $120.00 |
| lumix-s5ii__same-dust-glare | — | — | 0 | $0.00 |
| lumix-s5ii__same-light | — | — | 0 | $0.00 |
| lumix-s5ii__same-pose | — | — | 0 | $0.00 |
| lumix-s5ii__torn-grip | damage: handgrip rubber ✔ | — | 0 | $45.00 |
| nikon-z6ii__cracked-front-element | damage: front lens element ✔ | — | 0 | $180.00 |
| nikon-z6ii__same-dust-glare | — | — | 0 | $0.00 |
| nikon-z6ii__same-light | — | — | 0 | $0.00 |
| nikon-z6ii__same-pose | — | — | 0 | $0.00 |
| nikon-z6ii__top-scratch | damage: camera top plate ✔ | — | 0 | $60.00 |
| sigma-150-600__broken-foot | damage: tripod foot ✔ | — | 0 | $60.00 |
| sigma-150-600__missing-hood | missing: lens hood noted only | — | 1 | $0.00 |
| sigma-150-600__same-dust-glare | — | — | 0 | $0.00 |
| sigma-150-600__same-light | — | — | 0 | $0.00 |
| sigma-150-600__same-pose | — | — | 0 | $0.00 |
| sony-100-400__barrel-dent | damage: lens barrel ✔ | — | 0 | $140.00 |
| sony-100-400__cracked-hood | damage: lens hood ✔ | — | 0 | $45.00 |
| sony-100-400__same-dust-glare | — | — | 0 | $0.00 |
| sony-100-400__same-light | — | — | 0 | $0.00 |
| sony-100-400__same-pose | — | — | 0 | $0.00 |
| sony-a7r-kit__missing-battery | missing: battery ✔ | — | 0 | $59.00 |
| sony-a7r-kit__missing-strap | missing: neck strap ✔ | — | 0 | $25.00 |
| sony-a7r-kit__same-dust-glare | — | — | 0 | $0.00 |
| sony-a7r-kit__same-light | — | — | 0 | $0.00 |
| sony-a7r-kit__same-pose | — | — | 0 | $0.00 |
| sony-action-cam__cracked-lens | damage: camera lens ✔ | — | 0 | $60.00 |
| sony-action-cam__missing-housing | missing: waterproof housing ✔ | — | 0 | $35.00 |
| sony-action-cam__same-dust-glare | — | — | 0 | $0.00 |
| sony-action-cam__same-light | — | — | 0 | $0.00 |
| sony-action-cam__same-pose | — | — | 0 | $0.00 |
