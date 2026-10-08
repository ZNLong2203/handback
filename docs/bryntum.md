# The schedule (Bryntum Scheduler)

The counter has a second page, **Schedule** (`/shop/schedule`), next to the rentals list. It shows every physical unit the shop owns on a timeline, and it keeps that timeline workable when gear comes back broken: an agent takes the damaged unit out for its repair and suggests a fix for each booking the repair gets in the way of. Staff approve or turn down each suggestion with one click. Nothing on the schedule moves without a person.

![The schedule after a damaged return: Projector A is in repair, the agent suggests moving Priya to Projector B and offering Diego later dates](images/schedule-proposals.png)

## What is on the page

- **One row per unit, grouped by item.** The shop has two or three of each catalog item ("Camera kit A, B, C"). Each group header shows how many units there are and the daily price. The unit column says where the unit is today: on the shelf, out (and when it is due back), or in repair (and until when).
- **Bars coloured by where the money is.** Booked with the fee paid (indigo), deposit held on PayPal (amber), back and in review (hatched amber and coral), settled (green), disputed (coral). The bar says the amount that matters at that stage: "$300 at pickup", "$300 held", "kept $160", "released". The tooltip adds the customer, the item and unit, the dates, the fee, and what was held, kept and released.
- **Repair and maintenance blocks** are drawn as hatched ranges across the unit's row (Bryntum resource time ranges), labelled with the repair, for example "In repair · Replace projector lens".
- **The agent's suggestions are drawn on the timeline too**: a dashed bar where the booking would go, joined to the booking by a dashed arrow (Bryntum dependencies). Pointing at a suggestion in the panel scrolls the timeline to where it would go and outlines it.
- **A panel of suggestions** beside the timeline, each with what caused it, what it would do, a short message for the customer (copy it into an email, a text or the call; Handback does not send it), and the approve and turn-down buttons.
- **A command box** ("Tell the schedule") for typed requests such as "move Maya's drone booking to the other unit" or "block Projector B for 2 days for a lens clean".
- **Drag and drop** of a booking to another unit of the same item.
- **Live refresh.** The page listens on the same server-sent-event channel as the counter, so a settlement, an approval in another tab or a customer's answer redraws the timeline without a reload.

## Units and availability

`lib/db/schema.sql` adds a `units` table, seeded with 19 units for the 8 catalog items (`insert ... on conflict do nothing`), and a `unit_id` column on `rentals` (`alter table ... add column if not exists`). Every statement is idempotent, like the rest of the schema.

- **At booking** (`startBooking`), the new booking is given the first unit of its item that is free for every day of the stay (`lib/schedule/assign.ts`). The item's units are locked (`select ... for update`) while choosing, so two customers cannot both get the last one. If no unit is free, the draft is removed before any PayPal order exists and the customer sees, for example: "Every Portable projector is booked for Oct 5–8. The earliest free dates for a rental this long are Oct 10–13."
- **Just before the fee is captured** (`confirmBooking`), the unit is checked again. An unpaid draft only holds its unit for 30 minutes, so if someone else booked it while the customer was in PayPal, the booking moves to another free unit, or stops with "Nothing was charged".
- **At pickup** (`lib/schedule/handover.ts`), the rental page names the unit to give the customer ("Hand over Projector B"), and the rentals list shows it on each row. If that unit is blocked on any day of the rental, or another customer still has it and is overdue, both pages say so and point to the schedule, so a booking nobody has moved yet is not handed the unit that is in repair. It is a warning; the counter still decides.
- **What counts as busy** (`lib/schedule/spans.ts`): a paid booking or a rental that is out holds its unit from pickup through return; so does a disputed rental until its item is back (PayPal can open a dispute on the booking fee while the customer still has the item, and the status alone does not say where the item is); a repair or maintenance block holds it for its days; when booking, a slot the agent has set aside for a pending fix also counts, so the fix cannot be sold out from under the booking it is for. A rental that is back holds nothing; if it came back damaged, its repair block takes over.

## The agent that drives the schedule

`lib/schedule/agent.ts` runs after every settlement, after every change made on the schedule, and each time the schedule opens. Each run looks at the whole schedule and is safe to repeat. It does four things, all deterministic:

1. **Gives older rentals a unit** if they were booked before units existed.
2. **Blocks a unit for repair.** When a rental is settled (or disputed) with a charged finding of kind `new_damage` or `missing`, the unit is blocked from the settlement day for the longest repair among those findings. Repair days come from the price-list entry (`lib/schedule/repair-days.ts`: a cracked projector lens is 6 days, a missing lens hood 2), with a default of 3 days for damage and 2 for a missing part. One repair block per return, enforced by a unique index. The block is written to the rental's audit trail ("Unit taken off the schedule for the repair").
3. **Retires suggestions that no longer apply**: the booking moved or started, the clash is gone, the target unit or dates are no longer free, or (for a call) the planner below would now find a fix, counting slots set aside for other pending suggestions as taken. They show as "Out of date" under "Recently decided". A run that finds nothing new changes nothing, which matters because the schedule page runs the agent each time it renders.
4. **Suggests a fix for every future booking that now clashes** with a block on its unit:
   - another unit of the same item that is free for the same dates, units in shelf order (**reassign**); otherwise
   - the earliest later dates, up to 60 days on, when some unit of the item is free for a stay of the same length (**reschedule**), flagged **Call first** because the customer has to agree; otherwise
   - a **call** to rebook or cancel.

   A slot suggested for one booking counts as taken for the next one in the same run, so two suggestions never point at the same unit and days. A suggestion that was turned down is not made again for the same clash.

Each suggestion is a row in `schedule_proposals` and an audit event on the rental ("Schedule agent suggested a change").

### Where Gemini comes in

Gemini never decides where a booking goes. It has two small jobs, both on the server with prompts the server builds:

- **Wording the customer message.** The planner's facts (customer first name, item, booked dates, offered dates, why) go to Gemini with a JSON schema; the reply must match the schema and then pass `checkMessage` in `lib/schedule/messages.ts`: the right length, addressed by name, no links or email addresses, no money, no refunds, discounts or credits, and no date that is not part of the plan. Anything that fails keeps the template. Without a key, and always in demo mode, the template is used. The rewording runs after the response (`after()`), so it never slows a click.
- **Reading a typed command** (below).

`npx tsx --conditions=react-server --env-file-if-exists=.env.local scripts/schedule-ai-smoke.ts` sends the app's own prompts to the real API once: a reschedule message for Diego (worded by Gemini, passed the checks) and two commands, each answered with exactly one valid tool call (`reassign_booking` for Maya's drone booking to `drone-kit-b`; `block_unit` for Projector B, tomorrow and the day after, "lens clean").

## Typed commands

`lib/schedule/commands.ts`. The browser sends only the typed words. The server builds a prompt listing today's date, the units and the bookings waiting for pickup, by id, with the typed words fenced off and marked as data rather than instructions. Gemini is forced (function-calling mode `ANY`) to answer with exactly one of three tools:

| Tool | What it does |
|---|---|
| `reassign_booking` | move one booking that is waiting for pickup to another unit of the same item, same dates |
| `block_unit` | take one unit out of service for some days, for a repair or maintenance |
| `ask_staff` | ask one short question back when the request is unclear or matches more than one booking |

The arguments are checked against the same zod schemas, then go through the same rules as a drag (below). A request that passes becomes one pending suggestion marked **Typed**; the command box shows what it was read as, with **Confirm** and **Cancel**. A request that fails says why, and nothing changes: "Projector B is not a Folding camera drone kit. A booking can only move to another unit of the same item."

Without a Gemini key, and in demo mode, a small parser handles the common shapes ("move Maya's drone booking to the other unit", "block Projector B for 2 days from Friday for a lens clean") and asks back otherwise.

## How every change is checked

All changes go through `lib/schedule/service.ts`, whoever asked: a drag, an approved suggestion or a confirmed command. Inside one transaction that locks the item's units:

- the target is another unit of **the same item**;
- the booking is still **waiting for pickup** (a rental that is out, back or settled cannot move);
- it does **not start in the past**;
- a move keeps the **same length**;
- **nothing else is on the target unit on any of those days**: no paid booking, no rental that is out, no repair or maintenance block. The error names it: "Drone kit A is booked by Alex Kim on Sep 30–Oct 3."

A suggestion is also re-checked for staleness at approval; if the world has changed it is marked out of date, the agent looks again, and the person is told why.

On the timeline, only bookings waiting for pickup can be dragged at all, and Bryntum's drag validator applies the same-item and clash rules to what is on screen, so a drop that would fail turns red and says why before the mouse is released. That is only a preview: the drop waits for the server (`context.async` in `beforeEventDropFinalize`), and the bar snaps back if the server says no.

Every applied change writes a hash-chained audit event on the rental, with where it went from and to and how it was asked for ("drone-kit-b → drone-kit-a · dragged on the schedule"), and publishes a live event so every open counter page redraws.

## How Bryntum is used

- **Packages.** `@bryntum/scheduler` is installed as an npm alias of `@bryntum/scheduler-trial@7.3.7`, with `@bryntum/scheduler-react@7.3.7`, as Bryntum's README describes; both are pinned so the wrapper always matches the core. Moving to a licensed package later only changes the alias in `package.json`.
- **Client only.** `components/schedule/schedule-board.tsx` loads the timeline with `next/dynamic` and `ssr: false`; the server renders the page, the panel and a loading placeholder. The four stylesheets Bryntum requires (structural CSS, one theme, Font Awesome core and solid) are imported by that client component only.
- **Data.** The server sends plain arrays (`lib/schedule/view.ts`): resources, events, resource time ranges, time ranges and dependencies. The React wrapper syncs them into Bryntum's stores on every refresh, so a bar that changes unit moves to its new row instead of the whole chart redrawing. Dates are whole days with both ends included in the app; Bryntum's end dates are exclusive, so one day is added to every end when the data is shaped for the timeline.
- **Features on:** `group` (rows by item, in catalog order), `eventDrag` with a `validatorFn` and a custom tooltip, `eventTooltip`, `resourceTimeRanges` (blocks), `timeRanges` (today), `dependencies` (suggestion arrows, read-only), `stickyEvents`, `stripe`, `columnLines`, and `eventMenu` cut down to "Open the rental".
- **Features off:** resizing, editing, drag-create, copy and paste, the schedule, header and cell menus, cell editing, sorting and zooming. A rental's dates come from the customer and PayPal, so the timeline lets people move bookings between units and nothing else.
- **Theme.** Svalbard light, with its CSS variables pointed at Handback's tokens (`components/schedule/schedule.css`): Geist and Bricolage Grotesque, the card and paper colours, indigo for bookings, amber for held deposits, green for settled, coral for disputes and repairs. Event colours use `eventStyle: null` and classes, so they follow the same tokens as the rest of the counter.

### Why not Bryntum's own AI feature

The 7.3.7 trial includes Bryntum's `AI` feature for the Scheduler (`aiFeature`): a chat panel whose agent can filter, sort and select, and add, update or delete records, through an LLM plugin (`GooglePlugin` among them) that posts to a `promptUrl` on our server, with optional confirmation before adds, updates and removals, undo, and custom tools. It is a good fit for staff exploring the schedule in their own words.

It is not used here, for two reasons:

1. **The change has to happen on the server.** Bryntum's agent edits the records in the browser's stores; a moved booking would then have to be caught as a store change and replayed on the server. Here the server owns the rules, the audit trail and the live updates, and a change only exists once the server has checked it. A suggestion that does not pass is never shown as a change.
2. **The model should see as little as possible and do one thing.** Our command prompt carries only unit and booking ids, names and dates, and the model can only pick one of three tools; its answer is a suggestion that still needs a click. Bryntum's agent is built for open-ended conversation over the loaded data.

If the shop later wants a "show me every drone booking next week" style of search, the AI feature's filter and select tools would fit that well, alongside this design.

## Licensing

Handback's own code is MIT. Bryntum Scheduler is commercial software: the trial package's `package.json` says `"license": "Commercial"`, and Bryntum's README says trial bundles "are not minified and contain a watermark". The trial runs for 45 days, counted per browser (the trial build keeps its start date in that browser's `localStorage`, under `b-scheduler-trial-start`). This repository does not contain any Bryntum code; npm downloads the trial when the project is installed. Anyone running Handback beyond evaluation needs their own Bryntum licence.

The watermark, a faint "Bryntum Trial Version" pattern behind the rows, is left visible: the schedule's row colours are see-through so it shows, and the page says what it is.

## Demo data

In demo mode, the first time the schedule opens it books two weeks of rentals (`lib/schedule/seed.ts`), once per database. Each one goes through the real service calls: booking, the PayPal stand-in, pickup photos, the deposit hold, return photos, inspection, the customer's answer and settlement. Rentals already under way are booked from today and then moved back, since a real booking cannot start in the past. Jordan's projector is due back today, and Priya's and Diego's bookings sit on the same unit later in the week, so a damaged return can be shown live: settle Jordan's rental with "Cracked lens glass" and the schedule shows Projector A in repair, a suggestion to move Priya to Projector B, and a call-first offer of later dates for Diego.

That seed only runs in demo mode, because it books through the PayPal stand-in and moves rentals back in time. A copy on the PayPal sandbox gets a version of it with real sandbox payments instead (`SANDBOX_SEED_PLAN`, `seedSandboxSchedule`), booked by the nightly demo reset and by `npm run seed:demo` with `SEED_VAULT_ID` set, right after the counter seed: sixteen rentals from today on, each fee charged to the saved wallet, and a deposit held only for the two that are out. Nothing is moved back. Jordan's projector is out and due back today, on Projector B this time, because the counter seed's own projector came back today and is drawn on Projector A; Priya's and Diego's bookings follow on Projector B and Hannah's is on Projector A. Settle Jordan's rental with "Cracked lens glass" and the schedule shows Projector B in repair, a suggestion to move Priya to Projector A, and a call-first offer of later dates for Diego. Before any PayPal call, each plan is placed on its planned unit if that is free as the timeline draws it, or else on another unit that is, so no seeded bar is drawn over another one, whichever seed ran first. [docs/deploy.md](deploy.md#the-schedule-and-the-dashboard-in-the-sandbox) counts the PayPal calls.

On a shared demo the units fill up: every paid booking keeps its unit until its return day (an unpaid one for 30 minutes), and every damaged return blocks one for the repair. So each item's booking page starts the form on the first dates some unit is free for its default three-day stay (`firstFreeStay` in `lib/schedule/assign.ts`, the same search the refusal message uses) and says so when that is not today: "No mirrorless camera kit is free for 3 days from today, so the dates below start on the first free ones, Oct 5–8." Pickup can be done on any day, so a later booking still runs through the whole walkthrough. The dates are a starting point; the booking is checked again when it is made.

## Tests

- Unit tests (`npm test`): `lib/schedule/spans.test.ts` (overlaps, the unit search and the earliest-date search), `assign.test.ts` (unit assignment, refusing a booking when every unit is taken, the re-check before capture, the first free dates the booking form starts on, a unit kept for a customer who opened a PayPal dispute while they still have it), `agent.test.ts` (the seeded layout, repair blocks and repair days, reassign and call-first proposals, holding a suggested slot against new bookings, approving, turning down, a suggestion that went out of date, drag checks on the server, typed commands through the parser and through a fake Gemini tool call), `handover.test.ts` (the unit named at pickup, and the warnings for a blocked unit and for a customer who is overdue with it, disputed or not), `agent-rerun.test.ts` (a call-first suggestion is not retired and made again on every run when the only free slot is promised to another booking's fix), `messages.test.ts` (the message checks, and Gemini's wording used only when it passes them), `commands.test.ts` (the parser, the tool schemas, and the prompt marking the typed words as data), `seed-sandbox.test.ts` (the sandbox seed against the PayPal stand-in posing as the sandbox: every plan on its unit with and without the counter seed, nothing drawn twice on a unit on one day, the repair story and the command box's example on that layout, every PayPal call counted, recorded Gemini replies with a key set, a second run that calls PayPal no more, the nightly reset's voids and reseeding, and refusing demo mode, live PayPal and a missing wallet).
- End to end (`e2e/schedule.spec.ts`, demo mode): the schedule opens with the seeded fortnight; Jordan's projector comes back with a cracked lens and the customer accepts on a phone; after settling, the schedule shows the repair and two suggestions; one click moves Priya's bar to Projector B and the move is on her audit trail; her rental page then says to hand over Projector B, and Diego's, still on Projector A, warns that it is in repair. A typed command naming the wrong item is refused and the right one is applied only after Confirm. A drag onto a unit that is busy turns red and changes nothing; one that fits is checked by the server and stays. Four visitors in a row book a camera kit from its page: the fourth form starts on later dates, and every booking goes through.

## Screenshots

- `docs/images/schedule-overview.png`: the seeded schedule in demo mode
- `docs/images/schedule-proposals.png`: after the damaged return
- `docs/images/schedule-command.png`: a typed command read without AI, waiting for Confirm
- `docs/images/schedule-drag-refused.png`: a drag onto a busy unit, refused before the drop

## What building it taught us

- **Bryntum ignores the pointer on bars while the timeline scrolls** (`.b-grid-body-container.b-scrolling .b-sch-event-wrap { pointer-events: none }`), and it scrolls to today just after it loads. The first end-to-end drag pressed during that scroll and nothing happened. The test now waits until the bar itself is under the pointer, then rests, presses and moves in small steps, as a hand would.
- **The first theme hid the trial watermark.** Opaque row colours covered the pattern Bryntum draws behind the rows. The rows are now see-through, so it shows.
- **Clicking a bar used to recentre the timeline** under the pointer, so the second click of a double-click landed on a different bar. The timeline now only scrolls when the bar is off screen.
- **The tool declarations needed a real call.** The unit tests use a fake interpreter, so `scripts/schedule-ai-smoke.ts` was written to confirm that the real Gemini API accepts the declarations generated from the zod schemas and answers with one valid call.

## Known limits

- One process: the live channel is in-process, like the rest of the counter.
- Dates are whole days in UTC, as everywhere else in Handback.
- The agent plans around repair blocks; it does not plan staff time or deliveries.
- A drag can take a slot the agent had set aside for a pending suggestion; that suggestion then goes out of date and the agent looks again on the next run.
