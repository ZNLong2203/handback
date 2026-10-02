import "server-only";
import { catalogItem } from "@/lib/catalog";
import { getDb } from "@/lib/db/client";
import { disputesFor } from "@/lib/disputes/repo";
import { firstBrokenLink } from "./audit";
import { openMandate } from "./mandate";
import { eventsFor, inspectionsFor, latestAssessment, rentalById, rentalByToken } from "./repo";
import { planSettlement } from "./settlement";

/** Everything a rental page shows, loaded in one place for the counter and the customer. */
export async function loadRentalView(by: { id: string } | { token: string }) {
  const db = await getDb();
  const rental = "id" in by ? await rentalById(db, by.id) : await rentalByToken(db, by.token);
  if (!rental) return null;
  const [inspections, assessment, events, disputes] = await Promise.all([
    inspectionsFor(db, rental.id),
    latestAssessment(db, rental.id),
    eventsFor(db, rental.id),
    disputesFor(db, rental.id),
  ]);
  const checkout = inspections.filter((i) => i.phase === "checkout").at(-1) ?? null;
  const checkin = inspections.filter((i) => i.phase === "checkin").at(-1) ?? null;
  const plan = assessment && rental.authorizedCents ? planSettlement(assessment.findings, rental.authorizedCents, Boolean(rental.vaultId)) : null;
  const opened = rental.mandateJson && rental.mandateSha256 ? openMandate(rental.mandateJson, rental.mandateSha256) : null;
  return {
    rental,
    item: catalogItem(rental.itemId),
    checkout,
    checkin,
    assessment,
    events,
    plan,
    mandate: opened ? { ...opened, json: rental.mandateJson!, sha256: rental.mandateSha256! } : null,
    chainIntact: firstBrokenLink(events) === null,
    /** The PayPal dispute the desk works on: the newest open one, else the newest. */
    dispute: disputes[0] ?? null,
  };
}

export type RentalView = NonNullable<Awaited<ReturnType<typeof loadRentalView>>>;
