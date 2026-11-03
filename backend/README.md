# danen backend

accounts, sync and push subscriptions for droid (spec section 19), on supabase's free tier. nothing here is
deployed automatically.

```bash
supabase link --project-ref <your project>
supabase db push                        # creates the tables (migrations/)
supabase functions deploy danen         # verify_jwt is off in config.toml, the function checks danen sessions
supabase secrets set DANEN_ORIGINS=https://<you>.github.io VAPID_PUBLIC_KEY=<key>
```

then in droid set `danen.backend` to `https://<project>.supabase.co/functions/v1/danen`
(settings > accounts, or the `?danen=` url parameter once).

what is stored: username, nickname, a pbkdf2 password hash, sessions (hashed), synced settings and app data
(only if sync is on), push subscriptions. no email, no real name, no birthdate, no phone number, no tracking.
the public anon key can't read or write any table (rls on, no policies); only the function does, with the
service role key, which never leaves supabase.
