import type { AgReportState, AgWidgetFieldReference } from "ag-studio";
import type { InsightsRegistry } from "./registry";

/**
 * The dashboard as it opens: four pages built in code (AG Studio's report
 * state is one JSON object). People can rearrange or add widgets in edit
 * mode, or ask the agent to; nothing is saved between visits.
 */

export const PAGES = [
  { id: "overview", label: "Overview" },
  { id: "losses", label: "Losses" },
  { id: "ledger", label: "Ledger" },
  { id: "holds", label: "Holds" },
] as const;

export type PageId = (typeof PAGES)[number]["id"];

/** Money colours shared with the rest of Handback, as the CSS variables insights.css sets for the light and dark modes. */
export const MONEY = { held: "var(--hb-held)", released: "var(--hb-released)", charged: "var(--hb-charged)", brand: "var(--hb-brand)", ink: "var(--hb-ink)", muted: "var(--hb-muted)" } as const;

const f = (id: string, aggregation?: AgWidgetFieldReference["aggregation"]): AgWidgetFieldReference => (aggregation ? { id, aggregation } : { id });
const title = (text: string, subtitle?: string) => ({
  title: { enabled: true, text },
  ...(subtitle ? { subtitle: { enabled: true, text: subtitle } } : {}),
});

function kpi(field: AgWidgetFieldReference, text: string, color: string, subtitle?: string) {
  return {
    type: "value" as const,
    dataMapping: { value: [field] },
    format: { ...title(text, subtitle), style: { color, textScaling: { enabled: true } } },
  };
}

const at = (xTrack: number, yTrack: number, xSpan: number, ySpan: number) => ({ xTrack, yTrack, xSpan, ySpan });

export function initialReport(opts: { month: string; aiPanel: boolean }): AgReportState<InsightsRegistry> {
  return {
    selectedPageId: "overview",
    panels: { filters: { collapsed: true }, ai: { collapsed: !opts.aiPanel }, edit: { collapsed: true }, data: { collapsed: true } },
    pages: [
      {
        id: "overview",
        widgets: {
          "kpi-held": kpi(f("holds.amount_usd", "sum"), "Held on PayPal now", MONEY.held, "Reserved, not taken"),
          "kpi-kept": kpi(f("rentals.kept_usd", "sum"), "Kept this month", MONEY.charged, `Settled in ${opts.month}, after refunds`),
          "kpi-released": kpi(f("rentals.released_usd", "sum"), "Released to renters", MONEY.released, "Given back by PayPal at settlement"),
          "kpi-refunded": kpi(f("rentals.refunded_usd", "sum"), "Refunded", MONEY.released, "After settling, and cancelled fees"),
          "kpi-disputes": kpi(f("rentals.open_disputes", "sum"), "Open PayPal disputes", MONEY.ink, "Answered from the record"),
          flow: {
            type: "deposit-flow",
            dataMapping: { from: [f("flows.from")], to: [f("flows.to")], value: [f("flows.amount_usd", "sum")] },
            format: title("Where the deposits went", "Click a band or a box to filter the page"),
          },
          "kpi-photographed": kpi(f("rentals.pickup_photographed", "avg"), "Pickups photographed", MONEY.brand, "No photo, no hold: the counter refuses"),
          "kpi-median": kpi(f("summary.median_minutes_return_to_settled", "sum"), "Minutes, return photo to release", MONEY.released, "Median over settled rentals"),
          "text-before": {
            type: "text",
            dataMapping: {},
            format: {
              style: {
                text: "Before: the bike shop we interviewed photographs 30–40% of pickups and absorbs 2–5 million VND (about $75–190) a month in repairs it cannot prove. Those are the owner's estimates for one shop.",
                verticalAlign: "center",
                textAlign: "left",
                typography: { fontSize: 13 },
                color: MONEY.muted,
              },
            },
          },
          clock: {
            type: "hold-clock",
            dataMapping: {
              hold: [f("holds.rental_id")],
              label: [f("holds.item")],
              heldAt: [f("holds.held_at")],
              renewalDue: [f("holds.renewal_due_at")],
              expiresAt: [f("holds.expires_at")],
              renewedAt: [f("holds.renewed_at")],
              attention: [f("holds.attention")],
              amount: [f("holds.amount_usd", "sum")],
            },
            format: title("Hold clock", "Each running hold over PayPal's 29 days: 72-hour honor period, renewal, expiry"),
          },
        },
        widgetLayout: {
          "kpi-held": at(0, 0, 5, 7),
          "kpi-kept": at(5, 0, 5, 7),
          "kpi-released": at(10, 0, 5, 7),
          "kpi-refunded": at(15, 0, 5, 7),
          "kpi-disputes": at(20, 0, 4, 7),
          flow: at(0, 7, 16, 22),
          "kpi-photographed": at(16, 7, 8, 7),
          "text-before": at(16, 14, 8, 8),
          "kpi-median": at(16, 22, 8, 7),
          clock: at(0, 29, 24, 20),
        },
        filter: {
          widget: { "kpi-kept": [{ field: f("rentals.settled_month"), model: { operator: "isIn", value: [opts.month] } }] },
        },
      },
      {
        id: "losses",
        widgets: {
          "kept-by-item": {
            type: "bar-chart-grouped",
            dataMapping: { categoryKey: [f("rentals.item")], valueKey: [f("rentals.kept_usd", "sum")] },
            sort: [{ field: f("rentals.kept_usd", "sum"), direction: "desc" }],
            format: title("Kept by item", "After refunds and disputes"),
          },
          "kept-by-entry": {
            type: "bar-chart-grouped",
            dataMapping: { categoryKey: [f("findings.price_entry")], valueKey: [f("findings.charged_usd", "sum")] },
            sort: [{ field: f("findings.charged_usd", "sum"), direction: "desc" }],
            format: title("Charged by price-list entry", "Before any later refund"),
          },
          outcomes: {
            type: "donut-chart",
            dataMapping: { categoryKey: [f("findings.final_outcome")], valueKey: [f("findings.finding_id", "count")] },
            format: title("What happened to each finding", "Accepted, questioned, waived or a note"),
          },
          answers: {
            type: "column-chart-grouped",
            dataMapping: { categoryKey: [f("findings.renter_answer")], valueKey: [f("findings.proposed_usd", "sum")] },
            format: title("Proposed charges by the renter's answer", "Dollars proposed from the price list"),
          },
          "findings-grid": {
            type: "grid",
            dataMapping: {
              cols: [
                f("findings.rental_id"),
                f("findings.item"),
                f("findings.found"),
                f("findings.kind"),
                f("findings.price_entry"),
                f("findings.proposed_usd", "sum"),
                f("findings.staff_decision"),
                f("findings.renter_answer"),
                f("findings.final_outcome"),
                f("findings.charged_usd", "sum"),
              ],
            },
            format: title("Every finding"),
          },
        },
        filter: {
          widget: { "kept-by-entry": [{ field: f("findings.charged_usd"), model: { operator: "greaterThan", value: 0 } }] },
        },
        widgetLayout: {
          "kept-by-item": at(0, 0, 12, 18),
          "kept-by-entry": at(12, 0, 12, 18),
          outcomes: at(0, 18, 10, 18),
          answers: at(10, 18, 14, 18),
          "findings-grid": at(0, 36, 24, 20),
        },
      },
      {
        id: "ledger",
        widgets: {
          "kind-filter": { type: "list-filter", dataMapping: { value: [f("ledger.kind")] }, format: title("Movement") },
          "net-to-shop": kpi(f("ledger.shop_net_usd", "sum"), "Net to the shop", MONEY.brand, "Taken minus given back, for the rows shown"),
          movements: kpi(f("ledger.movement_id", "count"), "PayPal movements", MONEY.ink, "Rows in the ledger below"),
          "ledger-grid": {
            type: "grid",
            dataMapping: {
              cols: [
                f("ledger.at"),
                f("ledger.rental_id"),
                f("rentals.item"),
                f("ledger.kind"),
                f("ledger.paypal_id"),
                f("ledger.related_paypal_id"),
                f("ledger.amount_usd", "sum"),
                f("ledger.amount_cents", "sum"),
                f("ledger.shop_net_usd", "sum"),
                f("ledger.status"),
              ],
            },
            sort: [{ field: f("ledger.at"), direction: "desc" }],
            format: title("Every PayPal movement", "Export the rows as CSV from the grid's toolbar"),
          },
        },
        widgetLayout: {
          "kind-filter": at(0, 0, 8, 12),
          "net-to-shop": at(8, 0, 8, 12),
          movements: at(16, 0, 8, 12),
          "ledger-grid": at(0, 12, 24, 30),
        },
      },
      {
        id: "holds",
        widgets: {
          "clock-holds": {
            type: "hold-clock",
            dataMapping: {
              hold: [f("holds.rental_id")],
              label: [f("holds.item")],
              heldAt: [f("holds.held_at")],
              renewalDue: [f("holds.renewal_due_at")],
              expiresAt: [f("holds.expires_at")],
              renewedAt: [f("holds.renewed_at")],
              attention: [f("holds.attention")],
              amount: [f("holds.amount_usd", "sum")],
            },
            format: title("Hold clock"),
          },
          "attention-count": kpi(f("summary.holds_needing_attention", "sum"), "Holds needing a person", MONEY.charged, "Expiring, overdue, missed renewal, or ready to settle"),
          "held-by-state": {
            type: "pie-chart",
            dataMapping: { categoryKey: [f("holds.state")], valueKey: [f("holds.amount_usd", "sum")] },
            format: title("Held, by where the hold is"),
          },
          "holds-grid": {
            type: "grid",
            dataMapping: {
              cols: [
                f("holds.rental_id"),
                f("holds.item"),
                f("holds.renter"),
                f("holds.state"),
                f("holds.amount_usd", "sum"),
                f("holds.held_at"),
                f("holds.renewal_due_at"),
                f("holds.expires_at"),
                f("holds.attention"),
                f("holds.authorization_id"),
              ],
            },
            format: title("Running holds"),
          },
        },
        widgetLayout: {
          "clock-holds": at(0, 0, 16, 24),
          "attention-count": at(16, 0, 8, 8),
          "held-by-state": at(16, 8, 8, 16),
          "holds-grid": at(0, 24, 24, 18),
        },
      },
    ],
  } as AgReportState<InsightsRegistry>;
}
