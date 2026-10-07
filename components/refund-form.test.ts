// The refund form filled in from the deposit desk's draft: the amount, the
// charge and the reason are in place, it says where they came from, and it
// still waits for a person. Without a draft, or with one for a charge that
// cannot be refunded, it starts empty.
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/actions", () => ({ refundAction: vi.fn() }));
const { RefundForm } = await import("./refund-form");

const captures = [
  { captureId: "CAP-1", label: "the charge from the deposit", capturedCents: 5500, leftCents: 5500 },
  { captureId: "CAP-2", label: "the charge above the deposit", capturedCents: 2000, leftCents: 0 },
];
const render = (draft: { captureId: string; cents: number; reason: string } | null) =>
  renderToString(createElement(RefundForm, { rentalId: "R-AAAAAA", captures, seq: 1, firstName: "Olivia", draft }));

describe("RefundForm", () => {
  it("fills in a draft and says nothing has been sent", () => {
    const html = render({ captureId: "CAP-1", cents: 1500, reason: "The dent is cosmetic." });
    expect(html).toContain('value="15.00"');
    expect(html).toContain('value="The dent is cosmetic."');
    expect(html).toMatch(/Filled in from a draft by the dashboard(&#x27;|')s deposit desk\. Nothing has been sent/);
    expect(html).toContain("Refund $15.00");
  });

  it("starts empty without a draft, or with one for a charge it cannot refund", () => {
    for (const html of [render(null), render({ captureId: "CAP-2", cents: 500, reason: "x" })]) {
      expect(html).not.toContain("Filled in from a draft");
      expect(html).not.toContain('value="5.00"');
    }
  });
});
