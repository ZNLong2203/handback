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

-- State of the in-memory PayPal stand-in, so demo mode survives restarts.
create table if not exists demo_paypal (
  k text primary key,
  state jsonb not null
)
