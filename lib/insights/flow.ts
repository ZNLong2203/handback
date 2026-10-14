/**
 * The nodes of "Where the deposits went", by name. A module of its own so
 * the browser's simple view (components/insights/simple-view.tsx) can draw
 * the flow without loading the dashboard's model.
 */
export const FLOW = {
  held: "Deposits held",
  above: "Charged above the deposit",
  released: "Released to renters",
  kept: "Captured for repairs",
  stillHeld: "Still held",
  refunded: "Refunded later",
  disputed: "Returned in a dispute",
  openDispute: "In an open dispute",
  keptForGood: "Kept by the shop",
} as const;
