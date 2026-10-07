import { describe, expect, it } from "vitest";
import { cancellationRefund, cancellationTerms, policySentences, termsSentences, termsSummary } from "./cancellation";

describe("cancellation policy", () => {
  const terms = cancellationTerms("2026-10-10");
  const at = (iso: string) => new Date(iso);

  it("fixes the shop's policy to a booking's pickup day, in UTC", () => {
    expect(terms).toEqual({
      feeRefund: [
        { before: "2026-10-09T00:00:00.000Z", percent: 100 },
        { before: "2026-10-10T00:00:00.000Z", percent: 50 },
      ],
    });
    // Tiers are ordered by notice, whatever order the policy lists them in.
    expect(cancellationTerms("2026-10-10", { feeRefund: [{ hoursBefore: 0, percent: 50 }, { hoursBefore: 24, percent: 100 }] })).toEqual(terms);
  });

  it("refunds the whole fee at least 24 hours before the pickup day, half after that, nothing from the pickup day on", () => {
    expect(cancellationRefund(8700, terms, at("2026-10-01T09:00:00Z"))).toEqual({ percent: 100, refundCents: 8700, until: "2026-10-09T00:00:00.000Z" });
    expect(cancellationRefund(8700, terms, at("2026-10-08T23:59:59.999Z"))).toMatchObject({ percent: 100, refundCents: 8700 });
    expect(cancellationRefund(8700, terms, at("2026-10-09T00:00:00Z"))).toEqual({ percent: 50, refundCents: 4350, until: "2026-10-10T00:00:00.000Z" });
    expect(cancellationRefund(8700, terms, at("2026-10-09T23:59:59.999Z"))).toMatchObject({ percent: 50, refundCents: 4350 });
    expect(cancellationRefund(8700, terms, at("2026-10-10T00:00:00Z"))).toEqual({ percent: 0, refundCents: 0, until: null });
    expect(cancellationRefund(8700, terms, at("2026-10-12T15:00:00Z"))).toMatchObject({ refundCents: 0 });
  });

  it("works in whole cents, rounding a half cent down", () => {
    expect(cancellationRefund(4501, terms, at("2026-10-09T12:00:00Z")).refundCents).toBe(2250);
    expect(cancellationRefund(1, terms, at("2026-10-09T12:00:00Z")).refundCents).toBe(0);
    expect(cancellationRefund(0, terms, at("2026-10-01T00:00:00Z")).refundCents).toBe(0);
    for (const fee of [1, 99, 2900, 8701, 63_000]) {
      for (const now of ["2026-10-01T00:00:00Z", "2026-10-09T06:00:00Z", "2026-10-10T06:00:00Z"]) {
        const { refundCents } = cancellationRefund(fee, terms, at(now));
        expect(Number.isSafeInteger(refundCents) && refundCents >= 0 && refundCents <= fee).toBe(true);
      }
    }
  });

  it("says the same in words, with dates and amounts once the booking has them", () => {
    expect(policySentences().join(" ")).toMatch(/at least 24 hours before the pickup day starts \(00:00 UTC\) and you get back the whole rental fee.*later, but before the pickup day starts and you get back half the rental fee.*From the pickup day on, the fee is not refunded/);
    expect(termsSentences(terms, 9000)).toEqual([
      "If you cancel before Oct 9, 00:00 UTC, you get back the whole rental fee ($90.00).",
      "If you cancel before Oct 10, 00:00 UTC, you get back half the rental fee ($45.00).",
      "From Oct 10, 00:00 UTC, the pickup day, and once you have the item, the rental fee is not refunded.",
    ]);
    expect(termsSummary(terms, 9000)).toBe(
      "If you cancel before Oct 9, 00:00 UTC, the whole rental fee ($90.00) is refunded; before Oct 10, 00:00 UTC, half the rental fee ($45.00); from then on, nothing.",
    );
    expect(termsSentences(cancellationTerms("2026-10-10", { feeRefund: [{ hoursBefore: 6, percent: 30 }] }))[0]).toBe(
      "If you cancel before Oct 9, 18:00 UTC, you get back 30% of the rental fee.",
    );
  });
});
