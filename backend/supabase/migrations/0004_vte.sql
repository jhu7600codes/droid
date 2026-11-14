-- vte: droid's pretend mobile network. carriers hand out free vSIMs with a number; MoVTE (messages over
-- vte, "VMS") and VoVTE calls run between droid users through the danen edge function. money is D$, a
-- fake currency nobody can earn: every vSIM starts with a carrier's welcome credit, plans are free and
-- renew on their own, credit only pays for what goes past a plan.
-- like the rest of danen: rls on, no policies, only the edge function (service role) reads and writes.

create table if not exists vsims (
  user_id uuid not null references users(id) on delete cascade,
  carrier text not null check (carrier in ('fastline', 'omvte', 'bumble', 'transfer', 'line')),
  number text not null unique check (number ~ '^[0-9]{10}$'),
  plan text not null,
  balance integer not null default 0 check (balance >= 0), -- D$ cents
  vms_left integer not null default 0,
  minutes_left integer not null default 0,
  renews_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (user_id, carrier)
);
create index if not exists vsims_number on vsims(number);

-- messages: kept 30 days
create table if not exists vms (
  id bigserial primary key,
  from_number text not null,
  to_number text not null,
  body text not null check (char_length(body) between 1 and 1000),
  created_at timestamptz not null default now()
);
create index if not exists vms_to on vms(to_number, id);
create index if not exists vms_from on vms(from_number, id);

-- calls: webrtc signalling (offer / answer / ice) and the call log
create table if not exists vcalls (
  id uuid primary key default gen_random_uuid(),
  from_number text not null,
  to_number text not null,
  state text not null default 'ringing' check (state in ('ringing', 'active', 'ended', 'declined', 'missed', 'busy')),
  offer jsonb,
  answer jsonb,
  caller_ice jsonb not null default '[]',
  callee_ice jsonb not null default '[]',
  created_at timestamptz not null default now(),
  answered_at timestamptz,
  ended_at timestamptz
);
create index if not exists vcalls_to on vcalls(to_number, created_at);
create index if not exists vcalls_from on vcalls(from_number, created_at);

alter table vsims enable row level security;
alter table vms enable row level security;
alter table vcalls enable row level security;
