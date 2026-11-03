-- danen backend (spec section 19): accounts, sessions, sync, push subscriptions.
-- collects as little as possible: nickname, username, password hash. no email, no real name, no tracking.
-- only the edge function (service role) touches these tables: rls is on with no policies, so the
-- public anon key can read or write nothing.

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  username text not null unique check (username ~ '^[a-z0-9._-]{3,32}$'),
  nickname text not null check (char_length(nickname) between 1 and 40),
  pw_salt text not null,
  pw_hash text not null,
  created_at timestamptz not null default now()
);

create table if not exists sessions (
  token_hash text primary key,
  user_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  last_used timestamptz not null default now()
);
create index if not exists sessions_user on sessions(user_id);

-- settings and app data, one row per key ("settings", "app:<package>:<key>")
create table if not exists sync (
  user_id uuid not null references users(id) on delete cascade,
  key text not null check (char_length(key) <= 200),
  value jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

create table if not exists push_subs (
  user_id uuid not null references users(id) on delete cascade,
  pkg text not null,
  endpoint text not null,
  keys jsonb not null,
  created_at timestamptz not null default now(),
  primary key (user_id, pkg, endpoint)
);

alter table users enable row level security;
alter table sessions enable row level security;
alter table sync enable row level security;
alter table push_subs enable row level security;

-- housekeeping: sessions unused for 90 days go away
create or replace function prune_sessions() returns void language sql as $$
  delete from sessions where last_used < now() - interval '90 days';
$$;
