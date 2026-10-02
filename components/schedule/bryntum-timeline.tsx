"use client";

import "@bryntum/scheduler/fontawesome/css/fontawesome.css";
import "@bryntum/scheduler/fontawesome/css/solid.css";
import "@bryntum/scheduler/scheduler.css";
import "@bryntum/scheduler/svalbard-light.css";
import "./schedule.css";

import { StringHelper, type DomConfig, type EventModel, type Model, type ResourceModel, type ResourceTimeRangeStore, type Scheduler } from "@bryntum/scheduler";
import { BryntumScheduler } from "@bryntum/scheduler-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef } from "react";
import { moveRentalAction } from "@/app/shop/schedule/actions";
import { addDaysIso, shortDate } from "@/lib/dates";
import { formatUsd } from "@/lib/money";
import type { ScheduleEvent, ScheduleView } from "@/lib/schedule/view";

// The Bryntum Scheduler: one row per physical unit, grouped by item. It is
// loaded only in the browser (see schedule-board.tsx). Data comes from the
// server as plain arrays; the React wrapper syncs them into Bryntum's stores
// on every refresh, so a bar that changes unit glides to its new row.

export type TimelineProps = {
  view: ScheduleView;
  /** A rental, ghost or block id to bring into view and outline. */
  focus: string | null;
  onPick: (proposalId: string | null, rentalId: string | null) => void;
  onNotice: (notice: { tone: "ok" | "error"; text: string }) => void;
};

const get = <T,>(record: Model, field: string) => record.get(field) as T;
const range = (start: string, end: string) => (start === end ? shortDate(start) : `${shortDate(start)}–${shortDate(end)}`);
const holds = (record: Model) => ["booked", "held"].includes(get<string>(record, "money"));

const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const monthDay = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
/** Whole dollars when there are no cents: bars are narrow. */
const usd = (cents: number) => (cents % 100 === 0 ? `$${(cents / 100).toLocaleString("en-US")}` : formatUsd(cents));

/** Day columns with the weekday, today marked; the week's dates above. */
function preset(today: string) {
  return {
    base: "dayAndWeek",
    tickWidth: 60,
    displayDateFormat: "MMM D",
    headers: [
      { unit: "week", renderer: (start: Date, end: Date) => `${monthDay(start)} – ${monthDay(new Date(end.getTime() - 1))}` },
      {
        unit: "day",
        renderer: (start: Date, _end: Date, cfg: { headerCellCls?: string }) => {
          if (localDay(start) === today) cfg.headerCellCls = "hb-today-cell";
          return `${start.toLocaleDateString("en-US", { weekday: "short" })} ${start.getDate()}`;
        },
      },
    ],
  };
}

function eventLine(record: EventModel): string {
  if (get<boolean>(record, "ghost")) return get<string>(record, "ghostNote");
  const money = get<ScheduleEvent["money"]>(record, "money");
  const held = get<number | null>(record, "heldCents");
  if (money === "booked") return `${usd(get<number>(record, "depositCents"))} at pickup`;
  if (money === "held" || money === "review") return held ? `${usd(held)} held` : "held";
  if (money === "disputed") return "dispute";
  const kept = get<number>(record, "keptCents");
  return kept > 0 ? `kept ${usd(kept)}` : "released";
}

function tooltip(record: EventModel): DomConfig {
  const row = (label: string, value: string, cls?: string): DomConfig => ({
    class: "hb-tip-row",
    children: [{ tag: "span", text: label }, { tag: "span", class: cls, text: value }],
  });
  const start = get<string>(record, "start");
  const end = get<string>(record, "end");
  if (get<boolean>(record, "ghost")) {
    return {
      class: "hb-tip-body",
      children: [
        { class: "hb-tip-title", text: `Suggested: ${get<string>(record, "name")}` },
        { class: "hb-tip-sub", text: `${get<string>(record, "unitLabel")} · ${range(start, end)}` },
        { text: get<string>(record, "ghostNote") },
        { class: "hb-tip-hint", text: "Nothing moves until someone approves it in the panel." },
      ],
    };
  }
  const money = get<ScheduleEvent["money"]>(record, "money");
  const conflict = get<string | null>(record, "conflict");
  const held = get<number | null>(record, "heldCents");
  const kept = get<number>(record, "keptCents");
  const released = get<number>(record, "releasedCents");
  const children: (DomConfig | null)[] = [
    { class: "hb-tip-title", text: get<string>(record, "name") },
    { class: "hb-tip-sub", text: `${get<string>(record, "itemName")} · ${get<string>(record, "unitLabel")}` },
    row("Dates", range(start, end)),
    row("Status", get<string>(record, "statusLabel")),
    row("Rental fee", `${formatUsd(get<number>(record, "feeCents"))} paid`),
    money === "booked" ? row("Deposit", `${formatUsd(get<number>(record, "depositCents"))} at pickup`) : null,
    held && money !== "booked" && money !== "settled" ? row("Held on PayPal", formatUsd(held), "hb-tip-held") : null,
    money === "settled" || money === "disputed" ? row("Kept for repairs", formatUsd(kept), "hb-tip-kept") : null,
    money === "settled" || money === "disputed" ? row("Released", formatUsd(released), "hb-tip-released") : null,
    conflict ? { class: "hb-tip-warn", text: conflict } : null,
    get<boolean>(record, "draggable") ? { class: "hb-tip-hint", text: `Drag up or down to another ${get<string>(record, "itemName")}. Double-click to open.` } : { class: "hb-tip-hint", text: "Double-click to open the rental." },
  ];
  return { class: "hb-tip-body", children: children.filter(Boolean) as DomConfig[] };
}

export default function BryntumTimeline({ view, focus, onPick, onNotice }: TimelineProps) {
  const router = useRouter();
  const ref = useRef<BryntumScheduler>(null);
  const scheduler = () => ref.current?.instance as Scheduler | undefined;

  // The agent's pending suggestions are drawn on the timeline too: a dashed
  // bar where the booking would go, linked to it by a dashed arrow.
  const { events, dependencies, ranges } = useMemo(() => {
    const labels = new Map(view.resources.map((r) => [r.id, r.name]));
    const ghosts = view.pending
      .filter((p) => (p.kind === "reassign" || p.kind === "reschedule") && p.rentalId && p.toUnitId && p.targetStart && p.targetEnd)
      .map((p) => ({
        id: `ghost:${p.id}`,
        resourceId: p.toUnitId!,
        name: p.customerName ?? "Booking",
        startDate: p.targetStart!,
        endDate: addDaysIso(p.targetEnd!, 1),
        start: p.targetStart!,
        end: p.targetEnd!,
        unitLabel: labels.get(p.toUnitId!) ?? "",
        ghost: true,
        ghostNote: p.kind === "reassign" ? `Agent: move here from ${p.fromUnit}` : `Agent: earliest free dates · call ${p.customerName?.split(" ")[0]} first`,
        proposalId: p.id,
        rentalId: p.rentalId,
        draggable: false,
        resizable: false,
        cls: `hb-ev hb-ev-ghost${p.needsCall ? " hb-ev-call" : ""}`,
      }));
    const deps = ghosts
      .filter((g) => view.events.some((e) => e.id === g.rentalId))
      .map((g) => ({ id: `dep:${g.proposalId}`, from: g.rentalId!, to: g.id, type: g.start === view.events.find((e) => e.id === g.rentalId)?.start ? 0 : 2, cls: "hb-dep" }));
    const blockGhosts = view.pending
      .filter((p) => p.kind === "block" && p.toUnitId && p.targetStart && p.targetEnd)
      .map((p) => ({
        id: `ghostblock:${p.id}`,
        resourceId: p.toUnitId!,
        name: "Proposed block",
        startDate: p.targetStart!,
        endDate: addDaysIso(p.targetEnd!, 1),
        cls: "hb-block hb-block-ghost",
      }));
    return { events: [...view.events, ...ghosts], dependencies: deps, ranges: [...view.blocks, ...blockGhosts] };
  }, [view]);

  const resources = useMemo(() => view.resources.map((r) => ({ ...r })), [view.resources]);

  /**
   * The same rules the server applies, checked in the browser so the drag
   * shows red before the drop. The server still decides: a drop it refuses
   * snaps back.
   */
  const checkDrop = (record: EventModel, target: ResourceModel): { valid: boolean; message: string } => {
    const s = scheduler();
    if (get<string>(target, "itemId") !== get<string>(record, "itemId")) return { valid: false, message: `Only another ${get<string>(record, "itemName")} can take it` };
    if (target.id === record.resourceId) return { valid: true, message: "Stays on this unit" };
    const { startDate, endDate } = record as EventModel & { startDate: Date; endDate: Date };
    const busy = s?.eventStore.query((m: Model) => {
      const other = m as EventModel;
      return other !== record && other.resourceId === target.id && holds(other) && (other.startDate as Date) < endDate && (other.endDate as Date) > startDate;
    });
    if (busy?.length) return { valid: false, message: `${target.name} is booked by ${get<string>(busy[0], "name")} then` };
    const blocked = (s?.resourceTimeRangeStore as ResourceTimeRangeStore | undefined)?.query(
      (r: Model) => get<string>(r, "resourceId") === target.id && get<Date>(r, "startDate") < endDate && get<Date>(r, "endDate") > startDate,
    );
    if (blocked?.length) return { valid: false, message: `${target.name} is in repair or blocked then` };
    return { valid: true, message: `Move to ${target.name}` };
  };
  const timeRanges = useMemo(() => [{ id: "today", name: "Today", startDate: view.today, endDate: addDaysIso(view.today, 1), cls: "hb-today" }], [view.today]);
  const viewPreset = useMemo(() => preset(view.today), [view.today]);

  // Bring the focused bar into view and outline it.
  useEffect(() => {
    const s = scheduler();
    if (!s || !focus) return;
    const record = s.eventStore.getById(focus) as EventModel | undefined;
    if (record) void s.scrollEventIntoView(record, { animate: true, block: "center", highlight: true });
    for (const el of s.element.querySelectorAll(".b-sch-event-wrap.hb-focus")) el.classList.remove("hb-focus");
    s.element.querySelector(`.b-sch-event-wrap[data-event-id="${CSS.escape(focus)}"]`)?.classList.add("hb-focus");
  }, [focus, events]);

  return (
    <BryntumScheduler
      ref={ref}
      cls="hb-scheduler"
      height={640}
      startDate={view.window.start}
      endDate={view.window.end}
      visibleDate={{ date: new Date(`${addDaysIso(view.today, -2)}T00:00:00`), block: "start" }}
      viewPreset={viewPreset}
      rowHeight={50}
      barMargin={8}
      eventStyle={null}
      zoomOnMouseWheel={false}
      zoomOnTimeAxisDoubleClick={false}
      columns={[
        {
          text: "Unit",
          field: "name",
          width: 172,
          sortable: false,
          renderer: ({ record }: { record: Model }) => ({
            class: `hb-unit hb-unit-${get<string>(record, "status")}`,
            children: [
              { class: "hb-unit-name", text: get<string>(record, "name") },
              {
                class: "hb-unit-note",
                text:
                  get<string>(record, "status") === "shelf"
                    ? "on the shelf"
                    : `${get<string>(record, "status") === "out" ? "out" : get<string>(record, "status") === "repair" ? "in repair" : "blocked"} ${get<string | null>(record, "statusNote") ?? ""}`.trim(),
              },
            ],
          }),
        },
      ]}
      resources={resources}
      events={events}
      resourceTimeRanges={ranges}
      timeRanges={timeRanges}
      dependencies={dependencies}
      groupFeature={{
        field: "itemOrder",
        headerHeight: 44,
        renderer: ({ groupRecords, isFirstColumn }) =>
          isFirstColumn
            ? {
                class: "hb-group",
                title: get<string>(groupRecords[0], "itemName"),
                children: [
                  { class: "hb-group-name", text: get<string>(groupRecords[0], "itemShort") },
                  { class: "hb-group-meta", text: `${groupRecords.length} units · ${usd(get<number>(groupRecords[0], "dailyCents"))} a day` },
                ],
              }
            : "",
      }}
      resourceTimeRangesFeature
      stickyEventsFeature
      timeRangesFeature={{ showHeaderElements: false }}
      dependenciesFeature={{ allowCreate: false, enableDelete: false, showTooltip: false, radius: 6, highlightDependenciesOnEventHover: true }}
      eventDragFeature={{
        constrainDragToTimeSlot: true,
        showTooltip: true,
        validatorFn: ({ eventRecords, newResource }) => checkDrop(eventRecords[0], newResource),
        // The dates cannot change in a drag, so the tip names the booking, its real dates and the outcome.
        tooltipTemplate: ({ eventRecord, newResource }) => {
          const { valid, message } = checkDrop(eventRecord, newResource);
          return `<div class="hb-drag-tip ${valid ? "" : "hb-drag-tip-bad"}"><strong>${StringHelper.encodeHtml(eventRecord.name)}</strong> · ${range(get<string>(eventRecord, "start"), get<string>(eventRecord, "end"))}<br>${StringHelper.encodeHtml(message)}</div>`;
        },
      }}
      eventResizeFeature={false}
      eventEditFeature={false}
      eventDragCreateFeature={false}
      eventDragSelectFeature={false}
      eventCopyPasteFeature={false}
      scheduleMenuFeature={false}
      timeAxisHeaderMenuFeature={false}
      headerMenuFeature={false}
      cellMenuFeature={false}
      cellEditFeature={false}
      sortFeature={false}
      stripeFeature
      columnLinesFeature
      eventMenuFeature={{
        items: {
          editEvent: false,
          deleteEvent: false,
          unassignEvent: false,
          copyEvent: false,
          cutEvent: false,
          splitEvent: false,
          openRental: {
            text: "Open the rental",
            icon: "fa fa-arrow-up-right-from-square",
            weight: 100,
            onItem: ({ eventRecord }) => {
              if (!eventRecord) return;
              const id = get<boolean>(eventRecord, "ghost") ? get<string>(eventRecord, "rentalId") : String(eventRecord.id);
              router.push(`/shop/rentals/${id}`);
            },
          },
        },
      }}
      eventTooltipFeature={{ cls: "hb-tip", hoverDelay: 250, template: ({ eventRecord }) => tooltip(eventRecord) }}
      eventRenderer={({ eventRecord }) => [
        { tag: "span", class: "hb-ev-name", text: get<string>(eventRecord, "name") },
        { tag: "span", class: "hb-ev-meta", text: eventLine(eventRecord) },
        get<string | null>(eventRecord, "conflict") ? { tag: "i", class: "hb-ev-flag fa fa-triangle-exclamation", "aria-hidden": "true" } : null,
      ].filter(Boolean) as DomConfig[]}
      onEventClick={({ eventRecord }) => {
        const ghost = get<boolean>(eventRecord, "ghost");
        onPick(ghost ? get<string>(eventRecord, "proposalId") : get<string | null>(eventRecord, "proposalId"), ghost ? get<string>(eventRecord, "rentalId") : String(eventRecord.id));
      }}
      onEventDblClick={({ eventRecord }) => {
        const id = get<boolean>(eventRecord, "ghost") ? get<string>(eventRecord, "rentalId") : String(eventRecord.id);
        router.push(`/shop/rentals/${id}`);
      }}
      onBeforeEventDropFinalize={({ context }) => {
        if (context.newResource.id === context.resourceRecord.id) return;
        // Wait for the server: it runs the real checks and the bar snaps back if they fail.
        context.async = true;
        moveRentalAction(String(context.eventRecord.id), String(context.newResource.id)).then(
          (res) => {
            context.finalize(res.ok);
            onNotice(res.ok ? { tone: "ok", text: `${context.eventRecord.name} moved to ${context.newResource.name}.` } : { tone: "error", text: res.error });
          },
          () => {
            context.finalize(false);
            onNotice({ tone: "error", text: "The server did not answer, so the booking stayed where it was." });
          },
        );
      }}
    />
  );
}
