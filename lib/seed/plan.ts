import type { RentalStatus } from "@/lib/rentals/types";

/**
 * A lived-in counter for a fresh deployment: a handful of rentals, each
 * walked through the real rental service to a different step. The seed
 * converges instead of replaying: it finds each scenario's rental by the
 * customer's email and runs only the steps still missing, so running it
 * twice changes nothing and an interrupted run picks up where it stopped.
 */

/** Where a scenario should end up. */
export type SeedTarget = "booked" | "out" | "inspecting" | "customer_review" | "settled";

export type SeedScenario = {
  name: string;
  /** example.com addresses (RFC 2606) identify the seed's rentals. */
  email: string;
  itemId: string;
  /** Pickup date as days from today, and rental length. */
  startsInDays: number;
  days: number;
  /** Bundled sample photo for the return, from eval/images. */
  returnSample: string | null;
  target: SeedTarget;
  /**
   * The unit the rental should sit on, for plans that draw a schedule
   * (lib/schedule/seed.ts). It is booked there when that unit is free as the
   * timeline draws it, else on the first unit that is, and not at all when
   * none is; the check runs before PayPal is called.
   */
  unit?: string;
};

export const SCENARIOS: SeedScenario[] = [
  { name: "Sam Rivera", email: "sam.rivera@example.com", itemId: "drone-kit", startsInDays: 2, days: 3, returnSample: null, target: "booked" },
  { name: "Priya Nair", email: "priya.nair@example.com", itemId: "tele-lens", startsInDays: 0, days: 4, returnSample: null, target: "out" },
  {
    name: "Maya Chen",
    email: "maya.chen@example.com",
    itemId: "camera-kit",
    startsInDays: 0,
    days: 3,
    returnSample: "camera-kit/after__missing-hood",
    target: "inspecting",
  },
  {
    name: "Jordan Lee",
    email: "jordan.lee@example.com",
    itemId: "projector",
    startsInDays: 0,
    days: 2,
    returnSample: "projector/after__missing-remote",
    target: "customer_review",
  },
  {
    name: "Alex Kim",
    email: "alex.kim@example.com",
    itemId: "action-cam-kit",
    startsInDays: 0,
    days: 2,
    returnSample: "action-cam-kit/after__same-light",
    target: "settled",
  },
  {
    name: "Dana Okafor",
    email: "dana.okafor@example.com",
    itemId: "pa-speaker",
    startsInDays: 0,
    days: 1,
    returnSample: "pa-speaker/after__grille-dent",
    target: "settled",
  },
];

export type SeedStep =
  | "book"
  | "pay"
  | "pickup-photo"
  | "hold"
  | "acknowledge"
  | "return-photo"
  | "inspect"
  | "send"
  | "answer"
  | "settle";

/** What the seed needs to know about a scenario's rental; status null means none exists yet. */
export type SeedState = {
  status: RentalStatus | null;
  pickupPhoto: boolean;
  acknowledged: boolean;
  returnPhoto: boolean;
  /** Kept charges the customer has not answered yet. */
  awaitingCustomer: number;
};

const RANK: Partial<Record<RentalStatus, number>> = { draft: 0, booked: 1, out: 2, inspecting: 3, customer_review: 4, responded: 5, settled: 6 };

/**
 * The next step toward the scenario's target, or null when there is nothing
 * left to do: the target is reached, the rental went further on its own, or
 * the AI found nothing to send. Settling a return with nothing kept releases
 * the whole deposit; with kept charges the customer accepts them first.
 */
export function nextSeedStep(s: SeedState, target: SeedTarget): SeedStep | null {
  if (s.status === null) return "book";
  const rank = RANK[s.status];
  if (rank === undefined || rank > RANK[target]!) return null;
  switch (s.status) {
    case "draft":
      return "pay";
    case "booked":
      if (target === "booked") return null;
      return s.pickupPhoto ? "hold" : "pickup-photo";
    case "out":
      if (!s.acknowledged) return "acknowledge";
      if (target === "out") return null;
      return s.returnPhoto ? "inspect" : "return-photo";
    case "inspecting":
      if (target === "inspecting") return null;
      if (s.awaitingCustomer > 0) return "send";
      return target === "settled" ? "settle" : null;
    case "customer_review":
      return target === "customer_review" ? null : "answer";
    case "responded":
      return "settle";
    default:
      return null;
  }
}
