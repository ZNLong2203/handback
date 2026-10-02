import { z } from "zod";

/** [ymin, xmin, ymax, xmax] on a 0–1000 grid, Gemini's box convention. */
export type Box = [number, number, number, number];

export const FINDING_KINDS = ["missing", "new_damage", "dirt", "pre_existing", "wear"] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

const BoxSchema = z.array(z.number()).length(4).describe("[ymin, xmin, ymax, xmax] on a 0-1000 grid");

/** What the model must return. It never states a price, only a price-list id. */
export const ModelOutputSchema = z.object({
  photos_usable: z.boolean().describe("false if either photo is too blurry, dark, or does not show the item"),
  photo_issue: z.string().nullable().describe("why the photos are unusable, otherwise null"),
  same_item: z.boolean().describe("both photos show the same rental item or kit"),
  findings: z
    .array(
      z.object({
        kind: z.enum(FINDING_KINDS),
        item: z.string().describe("the accessory from the kit list, or the part of the item"),
        description: z.string().describe("one plain sentence a customer would understand"),
        evidence: z.string().describe("what in the photos shows this is a real change and not light, angle, glare or dust"),
        box_before: BoxSchema.nullable().describe("where it is (or was) in the check-out photo, or null"),
        box_after: BoxSchema.nullable().describe("where it is in the check-in photo, or null if the item is missing"),
        confidence: z.enum(["high", "medium", "low"]),
        price_item_id: z.string().nullable().describe("id from the shop's price list that fits this finding, or null"),
      }),
    )
    .max(10),
  summary: z.string().describe("one sentence for staff"),
});
export type ModelOutput = z.infer<typeof ModelOutputSchema>;

export function jsonSchemaFor(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

const clamp = (n: number) => Math.min(1000, Math.max(0, Math.round(n)));

/** Clamp to the grid and put the corners the right way round; drop boxes with no area. */
export function normaliseBox(raw: number[] | null | undefined): Box | null {
  if (!raw || raw.length !== 4 || raw.some((n) => !Number.isFinite(n))) return null;
  let [ymin, xmin, ymax, xmax] = raw.map(clamp);
  if (ymin > ymax) [ymin, ymax] = [ymax, ymin];
  if (xmin > xmax) [xmin, xmax] = [xmax, xmin];
  if (ymax - ymin < 2 || xmax - xmin < 2) return null;
  return [ymin, xmin, ymax, xmax];
}
