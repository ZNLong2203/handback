/**
 * Writes eval/README.md and eval/headline.json from every saved run of both
 * eval sets (see summary.ts for what is computed and what is written by hand).
 *   npm run eval:summary
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { headline, loadSets, readme, resultsTable, ROOT, SETS } from "./summary";

const sets = await loadSets();
await writeFile(path.join(ROOT, "eval/README.md"), readme(sets));
await writeFile(path.join(ROOT, "eval/headline.json"), `${JSON.stringify(headline(sets), null, 2)}\n`);
for (const s of SETS) console.log(`${s.title}\n${resultsTable(sets[s.id].runs)}\n`);
