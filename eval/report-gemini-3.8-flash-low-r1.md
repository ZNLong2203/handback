# Condition-check eval: gemini-3.8-flash, thinking low, 1 independent look

36 labeled photo pairs: 12 with real changes (14 changes in total) and 24 unchanged pairs that only differ in light, pose, dust or glare.

| Metric | Result |
|---|---|
| Real changes noticed (any confidence) | 14/14 (100%) |
| Real changes proposed as a charge | 14/14 (100%) |
| ...with the right price-list entry | 14/14 |
| Unchanged pairs that would have been charged | 1/24 (4%) |
| Extra charges on changed pairs | 0 |
| Errors / replies repaired | 0 / 0 |
| Latency p50 / p95 | 4.6 s / 9.8 s |
| Tokens per pair (in / out) | 2788 / 351 |

## Per pair

| Pair | Caught | False charges | Notes | Proposed |
|---|---|---|---|---|
| action-cam-kit__missing-housing | missing: waterproof housing ✔ | — | 0 | $35.00 |
| action-cam-kit__same-dust-glare | — | — | 0 | $0.00 |
| action-cam-kit__same-light | — | — | 0 | $0.00 |
| action-cam-kit__same-pose | — | — | 0 | $0.00 |
| camera-body__grip-scuff | damage: handgrip rubber ✔ | — | 0 | $45.00 |
| camera-body__same-dust-glare | — | — | 0 | $0.00 |
| camera-body__same-light | — | — | 0 | $0.00 |
| camera-body__same-pose | — | — | 0 | $0.00 |
| camera-body__top-scratch | damage: camera top plate ✔ | — | 0 | $60.00 |
| camera-kit__missing-battery-charger | missing: battery ✔; missing: charger ✔ | — | 0 | $98.00 |
| camera-kit__missing-hood | missing: lens hood ✔ | — | 0 | $35.00 |
| camera-kit__same-dust-glare | — | — | 0 | $0.00 |
| camera-kit__same-light | — | — | 0 | $0.00 |
| camera-kit__same-pose | — | — | 0 | $0.00 |
| drone-kit__broken-propeller | damage: drone propeller ✔ | — | 0 | $14.00 |
| drone-kit__missing-battery | missing: flight battery ✔ | — | 0 | $89.00 |
| drone-kit__same-dust-glare | — | — | 0 | $0.00 |
| drone-kit__same-light | — | — | 0 | $0.00 |
| drone-kit__same-pose | — | — | 0 | $0.00 |
| ebike-rear__bent-fender-mud | damage: rear mudguard ✔; dirt: rear rack ✔ | — | 0 | $65.00 |
| ebike-rear__same-dust-glare | — | — | 0 | $0.00 |
| ebike-rear__same-light | — | new_damage: rear light (high) | 0 | $25.00 |
| ebike-rear__same-pose | — | — | 0 | $0.00 |
| pa-speaker__grille-dent | damage: speaker grille ✔ | — | 0 | $55.00 |
| pa-speaker__same-dust-glare | — | — | 0 | $0.00 |
| pa-speaker__same-light | — | — | 0 | $0.00 |
| pa-speaker__same-pose | — | — | 0 | $0.00 |
| projector__cracked-lens | damage: projector lens ✔ | — | 0 | $160.00 |
| projector__missing-remote | missing: remote control ✔ | — | 0 | $25.00 |
| projector__same-dust-glare | — | — | 0 | $0.00 |
| projector__same-light | — | — | 0 | $0.00 |
| projector__same-pose | — | — | 0 | $0.00 |
| tele-lens__dent | damage: lens barrel ✔ | — | 0 | $140.00 |
| tele-lens__same-dust-glare | — | — | 0 | $0.00 |
| tele-lens__same-light | — | — | 0 | $0.00 |
| tele-lens__same-pose | — | — | 1 | $0.00 |
