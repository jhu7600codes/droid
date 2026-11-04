-- server-side settings (the web push key pair lives here; only the function's service role can read it)
create table if not exists config (key text primary key, value text not null);
alter table config enable row level security;
