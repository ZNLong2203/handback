import { createHash, timingSafeEqual } from "node:crypto";

const digest = (s: string) => createHash("sha256").update(s).digest();

/**
 * Whether a job request carries `Authorization: Bearer <CRON_SECRET>`.
 * Compared through SHA-256 digests in constant time, so the response time
 * says nothing about how much of a guess was right.
 */
export function bearerMatches(header: string | null, secret: string): boolean {
  return timingSafeEqual(digest(header ?? ""), digest(`Bearer ${secret}`));
}
