# Condition-check eval: gemini-3.8-flash, thinking low, 2 independent looks that must agree

5 labeled AI-generated demo sample pairs (not part of the published eval): 3 with real changes (4 changes in total) and 2 unchanged pairs that only differ in light, pose, dust or glare.

| Metric | Result |
|---|---|
| Real changes noticed (any confidence) | 4/4 (100%) |
| Real changes proposed as a charge | 4/4 (100%) |
| ...with the right price-list entry | 4/4 |
| Unchanged pairs that would have been charged | 0/2 (0%) |
| Extra charges on changed pairs | 0 |
| Errors / replies repaired / requests retried after a network error | 0 / 0 / 0 |
| Latency p50 / p95 | 4.3 s / 6.5 s |
| Tokens per pair (in / out) | 5794 / 940 |

## Per pair

| Pair | Caught | False charges | Notes | Proposed |
|---|---|---|---|---|
| city-bike__frame-scratch | damage: frame ✔ | — | 0 | $25.00 |
| city-bike__missing-holder | missing: phone holder ✔ | — | 0 | $12.00 |
| city-bike__missing-holder-rear-light | missing: phone holder ✔; missing: rear light ✔ | — | 0 | $27.00 |
| city-bike__same-light | — | — | 0 | $0.00 |
| city-bike__same-pose | — | — | 0 | $0.00 |
