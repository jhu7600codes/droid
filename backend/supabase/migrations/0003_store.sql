-- danen store, community side: apps published from droid with a danen account (spec section 19).
-- files live in the public bucket "droid-store" (<package id>/<versioncode>.dpk, <package id>/icon).
-- only the edge function (service role) writes; everyone may read the bucket. the table has rls on
-- with no policies, like the rest: the function serves the listing.

create table if not exists store_apps (
  id text primary key check (id ~ '^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$' and char_length(id) <= 100),
  owner uuid not null references users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 50),
  description text not null default '' check (char_length(description) <= 4000),
  category text not null default 'tools' check (category in ('tools', 'games', 'productivity', 'media', 'education', 'social', 'demo')),
  version text not null check (char_length(version) <= 40),
  versioncode integer not null check (versioncode > 0),
  size bigint not null check (size > 0),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  permissions jsonb not null default '[]',
  dpk_path text not null,
  icon_path text,
  converted boolean not null default false, -- made from an android apk
  status text not null default 'live' check (status in ('live', 'hidden')),
  reports integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists store_apps_owner on store_apps(owner);
alter table store_apps enable row level security;

-- who reported what (one report per account per app)
create table if not exists store_reports (
  app_id text not null references store_apps(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  reason text not null check (char_length(reason) <= 500),
  created_at timestamptz not null default now(),
  primary key (app_id, user_id)
);
alter table store_reports enable row level security;

insert into storage.buckets (id, name, public, file_size_limit)
values ('droid-store', 'droid-store', true, 52428800)
on conflict (id) do update set public = true, file_size_limit = 52428800;
