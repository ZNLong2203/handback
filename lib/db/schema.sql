-- Idempotent schema, applied on startup. Money is integer cents.

create table if not exists rentals (
  id text primary key,
  -- Unguessable token in the customer's private link (/r/<token>).
  token text not null unique,
  item_id text not null,
  customer_name text not null,
  customer_email text not null,
  start_date date not null,
  end_date date not null,
  days integer not null,
  fee_cents integer not null,
  deposit_cents integer not null,
  status text not null,
  booking_order_id text,
  fee_capture_id text,
  vault_id text,
  payer_email text,
  authorization_id text,
  parent_authorization_id text,
  authorized_cents integer,
  authorized_at timestamptz,
  authorization_expires_at timestamptz,
  settlement_capture_id text,
  captured_cents integer,
  released_cents integer,
  extra_capture_id text,
  extra_cents integer,
  settled_at timestamptz,
  dispute_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists rentals_status on rentals (status);
create index if not exists rentals_booking_order on rentals (booking_order_id);
create index if not exists rentals_authorization on rentals (authorization_id);

-- PayPal's payer-action link for the booking order, for renters who approve
-- by redirect (an assistant hands them the link) instead of the in-page button.
alter table rentals add column if not exists approve_url text;
-- The deposit mandate (lib/rentals/mandate.ts) as the exact canonical JSON
-- that was hashed, and its SHA-256, so the stored text can be re-verified.
alter table rentals add column if not exists mandate_json text;
alter table rentals add column if not exists mandate_sha256 text;
-- Unguessable token an assistant that booked uses to read the rental's status
-- (get_rental_status). Unlike `token`, it cannot act on the rental.
alter table rentals add column if not exists status_token text;
create unique index if not exists rentals_status_token on rentals (status_token);
-- Cancelling before pickup (lib/rentals/cancel.ts): when, by whom (renter or
-- staff), the reason the renter sees, and the part of the fee refunded. A
-- booking PayPal declined is cancelled too, but has no cancelled_at.
alter table rentals add column if not exists cancelled_at timestamptz;
alter table rentals add column if not exists cancelled_by text;
alter table rentals add column if not exists cancel_reason text;
alter table rentals add column if not exists cancel_refund_cents integer;
-- Set under the row lock just before the deposit hold is sent to PayPal, so a
-- cancellation racing the pickup cannot slip in while PayPal answers. Cleared
-- when PayPal definitely refuses the hold.
alter table rentals add column if not exists hold_requested_at timestamptz;

-- Content-addressed photo store: the key is the SHA-256 of the bytes, so the
-- hash a customer acknowledged always points at exactly the same image.
create table if not exists photos (
  sha256 text primary key,
  mime_type text not null,
  bytes bytea not null,
  width integer,
  height integer,
  created_at timestamptz not null default now()
);

create table if not exists inspections (
  id text primary key,
  rental_id text not null references rentals (id),
  phase text not null,
  photo_sha text not null references photos (sha256),
  quality jsonb not null default '{}',
  -- Which bundled sample photo this is, if any (e.g. "camera-kit/before").
  sample text,
  taken_at timestamptz not null default now(),
  acknowledged_at timestamptz
);

create index if not exists inspections_rental on inspections (rental_id, phase);

create table if not exists assessments (
  id text primary key,
  rental_id text not null references rentals (id),
  checkout_sha text not null,
  checkin_sha text not null,
  model text not null,
  source text not null,
  usable boolean not null,
  issue text,
  summary text not null default '',
  looks jsonb not null,
  findings jsonb not null,
  proposed_cents integer not null,
  status text not null,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  responded_at timestamptz
);

create index if not exists assessments_rental on assessments (rental_id, created_at);

-- Append-only audit log. Each row's hash covers the previous row's hash for
-- the same rental, so editing history breaks the chain.
create table if not exists events (
  seq bigserial primary key,
  rental_id text not null,
  at timestamptz not null default now(),
  actor text not null,
  type text not null,
  data jsonb not null default '{}',
  prev_hash text,
  hash text not null
);

create index if not exists events_rental on events (rental_id, seq);

create table if not exists webhook_events (
  id text primary key,
  event_type text not null,
  resource_id text,
  verified boolean not null,
  payload jsonb not null,
  received_at timestamptz not null default now()
);

-- PayPal disputes on a rental's captures, as PayPal last described them
-- (a GET or a webhook). `paypal` keeps the whole object for audit; the
-- columns are what pages and queries need.
create table if not exists disputes (
  id text primary key,
  rental_id text not null references rentals (id),
  transaction_id text,
  reason text not null,
  status text not null,
  stage text,
  amount_cents integer,
  seller_response_due_at timestamptz,
  outcome text,
  refunded_cents integer,
  paypal jsonb not null,
  paypal_update_time timestamptz,
  opened_at timestamptz,
  synced_at timestamptz not null default now()
);

create index if not exists disputes_rental on disputes (rental_id);

-- Evidence packs, content-addressed like photos: the key is the SHA-256 of
-- the PDF, and the same facts always render to the same bytes.
create table if not exists evidence_packs (
  sha256 text primary key,
  rental_id text not null references rentals (id),
  dispute_id text,
  facts_sha text not null,
  facts jsonb not null,
  narrative jsonb not null,
  bytes bytea not null,
  created_at timestamptz not null default now()
);

create index if not exists evidence_packs_rental on evidence_packs (rental_id, created_at);
create index if not exists evidence_packs_facts on evidence_packs (facts_sha);

-- One row per dispute action and PayPal request round. The Disputes API
-- does not deduplicate on PayPal-Request-Id: in the sandbox a repeated id
-- was run again against the new state and refused with a 422, not answered
-- with the first reply. So a double tap is stopped here instead.
create table if not exists dispute_actions (
  dispute_id text not null,
  action text not null,
  round text not null,
  request_id text not null,
  state text not null,
  debug_id text,
  created_at timestamptz not null default now(),
  primary key (dispute_id, action, round)
);

-- Refunds of what a settlement took (lib/rentals/refunds.ts). The counter
-- claims a numbered row before calling PayPal with PayPal-Request-Id
-- refund:<rental id>:<seq>, so submitting the same form twice reuses the id
-- and PayPal answers with the first refund. state: requested (sent, no answer
-- recorded), done (PayPal returned refund_id) or refused. A refund PayPal
-- reported by webhook that the counter did not make has no seq.
create table if not exists refunds (
  id text primary key,
  rental_id text not null references rentals (id),
  seq integer,
  capture_id text not null,
  amount_cents integer not null,
  reason text,
  state text not null,
  refund_id text,
  paypal_status text,
  source text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists refunds_rental_seq on refunds (rental_id, seq);
create unique index if not exists refunds_refund_id on refunds (refund_id);

-- State of the in-memory PayPal stand-in, so demo mode survives restarts.
create table if not exists demo_paypal (
  k text primary key,
  state jsonb not null
);

-- One row per day of the nightly demo reset (lib/demo-reset/reset.ts), so a
-- second call on the same day does nothing. A day starts at DEMO_RESET_HOUR.
-- The reset never empties this table.
create table if not exists demo_resets (
  day date primary key,
  status text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  summary jsonb,
  error text
);

-- ─── Schedule ────────────────────────────────────────────────

-- The shop stocks each catalog item as two or three physical units. Every
-- booking is assigned to one unit, so two customers can never be promised
-- the same camera for the same days.
create table if not exists units (
  id text primary key,
  item_id text not null,
  label text not null,
  position integer not null
);

insert into units (id, item_id, label, position) values
  ('camera-kit-a', 'camera-kit', 'Camera kit A', 1),
  ('camera-kit-b', 'camera-kit', 'Camera kit B', 2),
  ('camera-kit-c', 'camera-kit', 'Camera kit C', 3),
  ('camera-body-a', 'camera-body', 'Camera body A', 1),
  ('camera-body-b', 'camera-body', 'Camera body B', 2),
  ('tele-lens-a', 'tele-lens', 'Telephoto A', 1),
  ('tele-lens-b', 'tele-lens', 'Telephoto B', 2),
  ('drone-kit-a', 'drone-kit', 'Drone kit A', 1),
  ('drone-kit-b', 'drone-kit', 'Drone kit B', 2),
  ('action-cam-kit-a', 'action-cam-kit', 'Action cam A', 1),
  ('action-cam-kit-b', 'action-cam-kit', 'Action cam B', 2),
  ('action-cam-kit-c', 'action-cam-kit', 'Action cam C', 3),
  ('pa-speaker-a', 'pa-speaker', 'PA speaker A', 1),
  ('pa-speaker-b', 'pa-speaker', 'PA speaker B', 2),
  ('ebike-a', 'ebike', 'E-bike A', 1),
  ('ebike-b', 'ebike', 'E-bike B', 2),
  ('ebike-c', 'ebike', 'E-bike C', 3),
  ('projector-a', 'projector', 'Projector A', 1),
  ('projector-b', 'projector', 'Projector B', 2),
  ('city-bike-a', 'city-bike', 'City bike A', 1),
  ('city-bike-b', 'city-bike', 'City bike B', 2),
  ('city-bike-c', 'city-bike', 'City bike C', 3)
on conflict (id) do nothing;

alter table rentals add column if not exists unit_id text references units (id);

create index if not exists rentals_unit on rentals (unit_id, start_date);

-- Days a unit cannot be rented: a repair after a damaged return, or
-- maintenance staff planned. Both dates are inclusive.
create table if not exists blocks (
  id text primary key,
  unit_id text not null references units (id),
  start_date date not null,
  end_date date not null,
  kind text not null,
  reason text not null,
  -- The return that caused a repair block.
  rental_id text references rentals (id),
  created_by text not null,
  created_at timestamptz not null default now()
);

create unique index if not exists blocks_one_repair_per_return on blocks (rental_id) where kind = 'repair';

create index if not exists blocks_unit on blocks (unit_id, start_date);

-- Changes the schedule agent or a typed command suggests. Nothing on the
-- schedule changes until a person approves one.
create table if not exists schedule_proposals (
  id text primary key,
  kind text not null,
  status text not null,
  origin text not null,
  rental_id text references rentals (id),
  -- What made the agent look: "block:<id>" or "rental:<id>".
  cause text,
  block_id text references blocks (id),
  from_unit_id text references units (id),
  to_unit_id text references units (id),
  start_date date,
  end_date date,
  -- For a block: repair or maintenance, and why.
  block_kind text,
  reason text,
  needs_call boolean not null default false,
  summary text not null,
  message text,
  message_source text,
  command text,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decision_note text
);

create unique index if not exists proposals_one_pending_per_conflict on schedule_proposals (rental_id, cause) where status = 'pending';

create index if not exists proposals_status on schedule_proposals (status, created_at);

-- Demo data that has been loaded once, so it is never loaded twice.
create table if not exists demo_seeds (
  name text primary key,
  seeded_at timestamptz not null default now()
)
