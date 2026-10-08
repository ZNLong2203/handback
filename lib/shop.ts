/** The demo shop. One shop per deployment keeps the hackathon build simple. */
export const SHOP = {
  name: "Kestrel Rentals",
  city: "Austin, TX",
  /** Longest rental we accept: the deposit hold must settle inside PayPal's 29-day window. */
  maxRentalDays: 21,
  /**
   * How far ahead a pickup can be booked. PayPal refunds a capture only
   * within 180 days of it, and a cancellation refunds the fee captured at
   * booking, so every refund the cancellation policy promises stays inside
   * that window, with room for a booking moved later on the schedule.
   */
  maxDaysAhead: 120,
} as const;

/**
 * What the renter gets back of the rental fee when they cancel a paid
 * booking before pickup. Dates are whole days in UTC, so the pickup day
 * starts at 00:00 UTC on the pickup date. A tier applies when the renter
 * cancels at least `hoursBefore` hours before that moment; the first tier
 * that fits counts, and from the pickup day on nothing is refunded. No
 * deposit is held before pickup, so there is none to give back. New bookings
 * write these tiers into their deposit mandate as dates
 * (lib/rentals/cancellation.ts), so a later change here does not reach them.
 */
export const CANCELLATION_POLICY = {
  feeRefund: [
    { hoursBefore: 24, percent: 100 },
    { hoursBefore: 0, percent: 50 },
  ],
} as const;

export type CancellationPolicy = { feeRefund: readonly { hoursBefore: number; percent: number }[] };

/** The public URL: APP_URL when set (a custom domain), else the onrender.com URL Render provides. */
export function appUrl(): string {
  return (process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || "http://localhost:3000").replace(/\/$/, "");
}
