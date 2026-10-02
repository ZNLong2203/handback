import type { PriceItem } from "@/lib/catalog";

/**
 * How many days each repair keeps a unit off the schedule, by price-list id.
 * The same id means the same repair on every item (a "lens-barrel" job goes
 * to the same service shop whichever camera it came from). Missing parts are
 * the days it takes to get a replacement in.
 */
export const REPAIR_DAYS: Record<string, number> = {
  "missing-hood": 2,
  "missing-front-cap": 1,
  "missing-rear-cap": 1,
  "missing-battery": 2,
  "missing-charger": 2,
  "missing-strap": 1,
  "missing-sd-case": 1,
  "body-cosmetic": 3,
  "lens-barrel": 7,
  "top-plate": 4,
  "grip-rubber": 2,
  "front-element": 10,
  "missing-lens": 3,
  "barrel-dent": 5,
  "hood-crack": 2,
  "tripod-foot": 3,
  "missing-propeller": 1,
  "missing-controller": 3,
  "missing-hub": 2,
  "propeller-damage": 1,
  "arm-damage": 5,
  "missing-housing": 2,
  "missing-mount": 1,
  "missing-stick": 1,
  "missing-cable": 1,
  "camera-lens": 5,
  grille: 3,
  handle: 2,
  cabinet: 2,
  mudguard: 2,
  rack: 3,
  "rear-light": 1,
  "battery-damage": 7,
  "lens-crack": 6,
  "missing-remote": 2,
  housing: 4,
};

/** When a price-list entry has no row above: a part to order, or a repair to book. */
export const DEFAULT_REPAIR_DAYS: Record<PriceItem["kind"], number> = { missing: 2, damage: 3, dirt: 0 };

export function repairDays(price: PriceItem): number {
  return REPAIR_DAYS[price.id] ?? DEFAULT_REPAIR_DAYS[price.kind];
}
