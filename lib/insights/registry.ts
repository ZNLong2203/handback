import type { AgBaseRegistry, AgBaseWidgetDefinition, AgDefaultWidgetDefinition, AgWidgetFieldReference } from "ag-studio";
import type { AgWidgetDataFormat } from "ag-studio";

/** The two custom widgets' state, for AG Studio's registry typing. Types only. */

export type CustomFormat = AgWidgetDataFormat<unknown>;

export interface DepositFlowWidget {
  type: "deposit-flow";
  dataMapping: {
    from: AgWidgetFieldReference[];
    to: AgWidgetFieldReference[];
    value: AgWidgetFieldReference[];
  };
  format?: CustomFormat;
}

export interface HoldClockWidget {
  type: "hold-clock";
  dataMapping: {
    hold: AgWidgetFieldReference[];
    label?: AgWidgetFieldReference[];
    heldAt: AgWidgetFieldReference[];
    renewalDue: AgWidgetFieldReference[];
    expiresAt: AgWidgetFieldReference[];
    renewedAt?: AgWidgetFieldReference[];
    attention?: AgWidgetFieldReference[];
    amount?: AgWidgetFieldReference[];
  };
  format?: CustomFormat;
}

export interface InsightsRegistry extends AgBaseRegistry {
  widgets: readonly (AgDefaultWidgetDefinition | AgBaseWidgetDefinition<"deposit-flow", DepositFlowWidget> | AgBaseWidgetDefinition<"hold-clock", HoldClockWidget>)[];
}
