"use client";

import "./insights.css";
import type { AgAiHarnessSetup, AgDataSourcesDefinition, AgDefaultRegistry, AgReportState, AgStudioApi, AgStudioMode, AgWidgetFormParams, AgWidgetsConfig } from "ag-studio";
import { AgStudioAiModule } from "ag-studio";
import { AgStudio, AgStudioProvider, createWidgets } from "ag-studio-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { DepositFlowWidget as DepositFlowState, HoldClockWidget as HoldClockState, InsightsRegistry } from "@/lib/insights/registry";
import { initialReport, type PageId } from "@/lib/insights/report";
import type { StudioDataSpec } from "@/lib/insights/studio-data";
import { depositDeskDisplay, depositDeskHarness } from "./agent";
import DepositFlowWidget from "./deposit-flow-widget";
import HoldClockWidget from "./hold-clock-widget";
import { DARK_MODE, handbackTheme, LIGHT_MODE } from "./theme";

/**
 * AG Studio itself, loaded in the browser only (insights-board.tsx imports
 * this file with next/dynamic and ssr: false), so its code ships with this
 * page and no other.
 */

export type StudioProps = {
  spec: StudioDataSpec;
  month: string;
  licenseKey: string | null;
  ai: boolean;
  mode: AgStudioMode;
  dark: boolean;
  page: PageId;
  onPage: (page: PageId) => void;
  onReady?: (api: AgStudioApi) => void;
};

/** Turns the server's date strings into the Date objects Studio's date and datetime formats expect. */
export function hydrateSources(spec: StudioDataSpec): AgDataSourcesDefinition<InsightsRegistry> {
  return {
    description: spec.description,
    relationships: spec.relationships,
    sources: spec.sources.map((s) => {
      const dates = s.fields.filter((f) => f.format === "dateFormat" || f.format === "dateTimeFormat");
      const data = dates.length
        ? s.data.map((row) => {
            const out: Record<string, unknown> = { ...row };
            for (const f of dates) {
              const v = row[f.id];
              if (typeof v !== "string" || !v) continue;
              // A whole day is shown in local time on the day it names; a moment keeps its instant.
              out[f.id] = f.format === "dateFormat" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(Number(v.slice(0, 4)), Number(v.slice(5, 7)) - 1, Number(v.slice(8, 10))) : new Date(v);
            }
            return out;
          })
        : s.data;
      return { id: s.id, name: s.name, description: s.description, fields: s.fields as never, data: data as never };
    }),
  } as AgDataSourcesDefinition<InsightsRegistry>;
}

const widgetsFor = (defaults: AgWidgetsConfig<AgDefaultRegistry>) => {
  // Studio exports no shape builder, so the custom widgets reuse the value
  // widget's format shape: titles, subtitle, caption and appearance, which is
  // all they read. The AI needs a format shape to configure a widget.
  const valueShape = defaults.widgets.find((w) => w.id === "value")?.formatShape;
  return createWidgets<InsightsRegistry>({
    additionalTypes: [
      {
        id: "deposit-flow",
        label: "Where the deposits went",
        icon: { className: "hb-icon-flow" },
        dataMapping: {
          from: { type: "field", supportedRoles: ["category"], requires: { cardinality: "many" }, required: true, aiDescription: "Where money came from, e.g. flows.from." },
          to: { type: "field", supportedRoles: ["category"], requires: { cardinality: "many" }, required: true, aiDescription: "Where it went, e.g. flows.to." },
          value: { type: "field", supportedRoles: ["numeric"], requires: { per: "dataMapping.from", cardinality: "one" }, required: true, aiDescription: "Money on each flow, summed, e.g. flows.amount_usd." },
        },
        formatShape: valueShape as never,
        form: (params: AgWidgetFormParams<DepositFlowState>) =>
          params.createDefaults({
            dataMappingItems: [
              { key: "from", label: "From" },
              { key: "to", label: "To" },
              { key: "value", label: "Amount" },
            ],
            supportsCrossHighlight: true,
          }),
        comp: DepositFlowWidget,
        defaultSize: { width: 720, height: 420 },
        minSize: { width: 360, height: 240 },
        featureConfig: { crossFilter: { supportsHighlight: true } },
        ai: {
          label: "Where the deposits went (flow diagram)",
          description: "A Sankey-style flow of deposit money from the holds to released, captured, still held, refunded, disputed and kept, drawn from the flows table.",
          usage: "Use to show where deposit money ended up. Map from to flows.from, to to flows.to and value to flows.amount_usd with sum.",
        },
      },
      {
        id: "hold-clock",
        label: "Hold clock",
        icon: { className: "hb-icon-clock" },
        dataMapping: {
          hold: { type: "field", supportedRoles: ["category"], requires: { cardinality: "many" }, required: true, aiDescription: "One row per hold: holds.rental_id." },
          label: { type: "field", supportedRoles: ["category"], requires: { per: "dataMapping.hold", cardinality: "one" }, aiDescription: "Row label, e.g. holds.item." },
          heldAt: { type: "field", supportedRoles: ["temporal"], requires: { per: "dataMapping.hold", cardinality: "one" }, required: true, aiDescription: "holds.held_at" },
          renewalDue: { type: "field", supportedRoles: ["temporal"], requires: { per: "dataMapping.hold", cardinality: "one" }, required: true, aiDescription: "holds.renewal_due_at" },
          expiresAt: { type: "field", supportedRoles: ["temporal"], requires: { per: "dataMapping.hold", cardinality: "one" }, required: true, aiDescription: "holds.expires_at" },
          renewedAt: { type: "field", supportedRoles: ["temporal"], requires: { per: "dataMapping.hold", cardinality: "one" }, aiDescription: "holds.renewed_at" },
          attention: { type: "field", supportedRoles: ["category"], requires: { per: "dataMapping.hold", cardinality: "one" }, aiDescription: "holds.attention" },
          amount: { type: "field", supportedRoles: ["numeric"], requires: { per: "dataMapping.hold", cardinality: "one" }, aiDescription: "holds.amount_usd with sum." },
        },
        formatShape: valueShape as never,
        form: (params: AgWidgetFormParams<HoldClockState>) =>
          params.createDefaults({
            dataMappingItems: [
              { key: "hold", label: "Hold" },
              { key: "label", label: "Label" },
              { key: "heldAt", label: "Held at" },
              { key: "renewalDue", label: "Renewal due" },
              { key: "expiresAt", label: "Expires" },
              { key: "renewedAt", label: "Renewed at" },
              { key: "attention", label: "Needs attention" },
              { key: "amount", label: "Amount" },
            ],
            supportsCrossHighlight: true,
          }),
        comp: HoldClockWidget,
        defaultSize: { width: 900, height: 360 },
        minSize: { width: 420, height: 200 },
        featureConfig: { crossFilter: { supportsHighlight: true } },
        ai: {
          label: "Hold clock",
          description: "Each running PayPal deposit hold as a bar over its 29-day life, with the 72-hour honor period, the scheduled renewal, a renewal that happened, and the expiry.",
          usage: "Use to show which holds need attention. Map hold to holds.rental_id, label to holds.item, heldAt to holds.held_at, renewalDue to holds.renewal_due_at, expiresAt to holds.expires_at, renewedAt to holds.renewed_at, attention to holds.attention, amount to holds.amount_usd with sum.",
        },
      },
    ] as never,
    menu: [{ label: "Handback", widgetIds: ["deposit-flow", "hold-clock"] }, ...(defaults.menu as never[])],
  });
};

export default function InsightsStudio(props: StudioProps) {
  const { spec, month, licenseKey, ai, mode, dark, page, onPage, onReady } = props;
  const [api, setApi] = useState<AgStudioApi | null>(null);
  const [data] = useState(() => hydrateSources(spec));
  const [initialState] = useState<AgReportState<InsightsRegistry>>(() => initialReport({ month, aiPanel: ai }));
  const theme = useMemo(() => handbackTheme(), []);
  const widgets = useCallback((defaults: AgWidgetsConfig<AgDefaultRegistry>) => widgetsFor(defaults), []);
  const harness = useMemo<AgAiHarnessSetup | undefined>(() => (ai ? depositDeskHarness() : undefined), [ai]);
  const modules = useMemo(() => (ai ? [AgStudioAiModule] : []), [ai]);
  const panels = useMemo(() => ({ edit: { right: ai ? (["ai", "edit", "data", "filters"] as const) : (["edit", "data", "filters"] as const) }, view: { right: ["filters"] as const } }), [ai]);

  // Our page tabs drive Studio's selected page; a page change made inside Studio (or by the agent) drives the tabs.
  useEffect(() => {
    if (!api) return;
    const state = api.getState();
    if (state.selectedPageId !== page) api.setState({ ...state, selectedPageId: page });
  }, [api, page]);

  return (
    <div className="ag-theme-mode hb-insights h-full w-full" data-ag-theme-mode={dark ? DARK_MODE : LIGHT_MODE} data-hb-mode={dark ? "dark" : "light"}>
      <AgStudioProvider modules={modules} licenseKey={licenseKey ?? undefined}>
        <AgStudio<InsightsRegistry>
          style={{ height: "100%", width: "100%" }}
          data={data}
          initialState={initialState}
          widgets={widgets as never}
          theme={theme}
          loadThemeGoogleFonts={false}
          mode={mode}
          panels={panels as never}
          enableFilterEditingInViewMode
          ai={harness}
          aiToolDisplay={ai ? (depositDeskDisplay as never) : undefined}
          onApiReady={(e) => {
            setApi(e.api as AgStudioApi);
            onReady?.(e.api as AgStudioApi);
          }}
          onStateUpdated={(e) => {
            const id = (e.api as AgStudioApi).getState().selectedPageId as PageId;
            if (id && id !== page) onPage(id);
          }}
        />
      </AgStudioProvider>
    </div>
  );
}
