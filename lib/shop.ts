/** The demo shop. One shop per deployment keeps the hackathon build simple. */
export const SHOP = {
  name: "Kestrel Camera Rentals",
  city: "Austin, TX",
  /** Longest rental we accept: the deposit hold must settle inside PayPal's 29-day window. */
  maxRentalDays: 21,
} as const;

/** The public URL: APP_URL when set (a custom domain), else the onrender.com URL Render provides. */
export function appUrl(): string {
  return (process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || "http://localhost:3000").replace(/\/$/, "");
}
