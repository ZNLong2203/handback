import type { Cents } from "./money";

/**
 * The demo shop's rental items. Each item carries the accessory checklist
 * that staff photograph at check-out, and the shop's repair price list.
 * The AI may only point at a price-list id; amounts always come from here.
 */
export type PriceItem = {
  id: string;
  label: string;
  /** Which kind of finding this price can be attached to. */
  kind: "missing" | "damage" | "dirt";
  cents: Cents;
};

export type RentalItem = {
  id: string;
  name: string;
  category: string;
  dailyCents: Cents;
  depositCents: Cents;
  /** Everything that leaves the shop with the item. */
  kit: string[];
  /** How to frame the check-out and check-in photos. */
  shot: string;
  prices: PriceItem[];
};

const cleaning: PriceItem = { id: "cleaning", label: "Cleaning beyond normal use", kind: "dirt", cents: 1500 };

export const CATALOG: RentalItem[] = [
  {
    id: "camera-kit",
    name: "Mirrorless camera kit",
    category: "Cameras",
    dailyCents: 2900,
    depositCents: 30000,
    kit: ["camera body", "zoom lens", "front lens cap", "lens hood", "rear lens cap", "battery", "battery charger with cable", "neck strap", "SD card case"],
    shot: "Top-down flat-lay of the whole kit on the counter mat, every item separated.",
    prices: [
      { id: "missing-hood", label: "Replace lens hood", kind: "missing", cents: 3500 },
      { id: "missing-front-cap", label: "Replace front lens cap", kind: "missing", cents: 1200 },
      { id: "missing-rear-cap", label: "Replace rear lens cap", kind: "missing", cents: 1000 },
      { id: "missing-battery", label: "Replace battery", kind: "missing", cents: 5900 },
      { id: "missing-charger", label: "Replace battery charger", kind: "missing", cents: 3900 },
      { id: "missing-strap", label: "Replace neck strap", kind: "missing", cents: 2500 },
      { id: "missing-sd-case", label: "Replace SD card case", kind: "missing", cents: 800 },
      { id: "body-cosmetic", label: "Cosmetic repair, camera body", kind: "damage", cents: 6000 },
      { id: "lens-barrel", label: "Lens barrel repair", kind: "damage", cents: 12000 },
      cleaning,
    ],
  },
  {
    id: "camera-body",
    name: "Mirrorless camera with 24-70mm lens",
    category: "Cameras",
    dailyCents: 3900,
    depositCents: 35000,
    kit: ["camera body", "24-70mm lens"],
    shot: "Three-quarter front view from slightly above, top plate and grip visible.",
    prices: [
      { id: "top-plate", label: "Top plate refinish", kind: "damage", cents: 6000 },
      { id: "grip-rubber", label: "Replace grip rubber", kind: "damage", cents: 4500 },
      { id: "lens-barrel", label: "Lens barrel repair", kind: "damage", cents: 12000 },
      { id: "front-element", label: "Front element replacement", kind: "damage", cents: 18000 },
      { id: "missing-lens", label: "Replace 24-70mm lens", kind: "missing", cents: 120000 },
      cleaning,
    ],
  },
  {
    id: "tele-lens",
    name: "100-400mm telephoto lens",
    category: "Lenses",
    dailyCents: 3500,
    depositCents: 40000,
    kit: ["telephoto lens", "lens hood", "tripod collar foot"],
    shot: "Side view of the lens lying on the mat, hood attached.",
    prices: [
      { id: "barrel-dent", label: "Barrel dent and paint repair", kind: "damage", cents: 14000 },
      { id: "hood-crack", label: "Replace lens hood", kind: "damage", cents: 4500 },
      { id: "missing-hood", label: "Replace lens hood", kind: "missing", cents: 4500 },
      { id: "tripod-foot", label: "Tripod foot repair", kind: "damage", cents: 6000 },
      cleaning,
    ],
  },
  {
    id: "drone-kit",
    name: "Folding camera drone kit",
    category: "Drones",
    dailyCents: 4500,
    depositCents: 30000,
    kit: ["drone", "remote controller", "flight battery (2)", "spare propellers (4)", "charging hub with cable"],
    shot: "Top-down flat-lay, arms unfolded, batteries and propellers in a row.",
    prices: [
      { id: "missing-battery", label: "Replace flight battery", kind: "missing", cents: 8900 },
      { id: "missing-propeller", label: "Replace spare propeller", kind: "missing", cents: 700 },
      { id: "missing-controller", label: "Replace remote controller", kind: "missing", cents: 14900 },
      { id: "missing-hub", label: "Replace charging hub", kind: "missing", cents: 4900 },
      { id: "propeller-damage", label: "Replace damaged propeller", kind: "damage", cents: 1400 },
      { id: "arm-damage", label: "Arm repair", kind: "damage", cents: 9500 },
      cleaning,
    ],
  },
  {
    id: "action-cam-kit",
    name: "Action camera kit",
    category: "Cameras",
    dailyCents: 1900,
    depositCents: 12000,
    kit: ["action camera", "waterproof housing", "spare battery (2)", "mounts (3)", "selfie stick", "USB-C cable"],
    shot: "Top-down flat-lay, every item separated.",
    prices: [
      { id: "missing-housing", label: "Replace waterproof housing", kind: "missing", cents: 3500 },
      { id: "missing-battery", label: "Replace spare battery", kind: "missing", cents: 2500 },
      { id: "missing-mount", label: "Replace mount", kind: "missing", cents: 800 },
      { id: "missing-stick", label: "Replace selfie stick", kind: "missing", cents: 2000 },
      { id: "missing-cable", label: "Replace USB-C cable", kind: "missing", cents: 800 },
      { id: "camera-lens", label: "Action camera lens repair", kind: "damage", cents: 6000 },
      cleaning,
    ],
  },
  {
    id: "pa-speaker",
    name: "Portable PA speaker",
    category: "Audio",
    dailyCents: 2500,
    depositCents: 15000,
    kit: ["speaker"],
    shot: "Front view standing on the mat, grille and control panel visible.",
    prices: [
      { id: "grille", label: "Replace speaker grille", kind: "damage", cents: 5500 },
      { id: "handle", label: "Replace carry handle", kind: "damage", cents: 3000 },
      { id: "cabinet", label: "Cabinet scuff repair", kind: "damage", cents: 2500 },
      cleaning,
    ],
  },
  {
    id: "ebike",
    name: "City e-bike",
    category: "Bikes",
    dailyCents: 3500,
    depositCents: 30000,
    kit: ["e-bike", "battery"],
    shot: "Side view of the rear half: wheel, mudguard, rack, rear light, battery.",
    prices: [
      { id: "mudguard", label: "Replace rear mudguard", kind: "damage", cents: 4000 },
      { id: "rack", label: "Rack repair", kind: "damage", cents: 4500 },
      { id: "rear-light", label: "Replace rear light", kind: "damage", cents: 2500 },
      { id: "battery-damage", label: "Battery casing repair", kind: "damage", cents: 25000 },
      { id: "heavy-cleaning", label: "Heavy cleaning (mud)", kind: "dirt", cents: 2500 },
    ],
  },
  {
    id: "city-bike",
    name: "City bike",
    category: "Bikes",
    dailyCents: 1500,
    depositCents: 15000,
    kit: ["bicycle", "front light", "rear light", "cable lock", "phone holder"],
    shot: "Side view of the whole bike on its kickstand, with the front light, the phone holder on the handlebar, the cable lock on the frame and the rear light under the saddle in view.",
    prices: [
      { id: "missing-front-light", label: "Replace front light", kind: "missing", cents: 2000 },
      { id: "missing-rear-light", label: "Replace rear light", kind: "missing", cents: 1500 },
      { id: "missing-lock", label: "Replace cable lock", kind: "missing", cents: 1800 },
      { id: "missing-phone-holder", label: "Replace phone holder", kind: "missing", cents: 1200 },
      { id: "frame-scratch", label: "Frame paint touch-up", kind: "damage", cents: 2500 },
      { id: "mudguard", label: "Replace bent mudguard", kind: "damage", cents: 2000 },
      { id: "heavy-cleaning", label: "Heavy cleaning (mud)", kind: "dirt", cents: 1000 },
    ],
  },
  {
    id: "projector",
    name: "Portable projector",
    category: "Audio & video",
    dailyCents: 2900,
    depositCents: 20000,
    kit: ["projector", "remote control"],
    shot: "Front three-quarter view, lens visible, remote beside it.",
    prices: [
      { id: "lens-crack", label: "Replace projector lens", kind: "damage", cents: 16000 },
      { id: "missing-remote", label: "Replace remote control", kind: "missing", cents: 2500 },
      { id: "housing", label: "Housing crack repair", kind: "damage", cents: 7000 },
      cleaning,
    ],
  },
];

export function catalogItem(id: string): RentalItem {
  const item = CATALOG.find((i) => i.id === id);
  if (!item) throw new Error(`unknown rental item: ${id}`);
  return item;
}
