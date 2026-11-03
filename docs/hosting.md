# hosting plan (proposal, nothing is deployed yet)

github pages hosts everything static: the shell, aosp assets, system apps, sample dpks, the store catalog and dpk
files, docs. two things can't live there: the danen backend (accounts, sync, push) and the proxy.
free tiers change often, so check the numbers before picking.

## danen backend: supabase (free tier)
- postgres + auth + edge functions + row level security, called straight from the static site
- the code is in backend/ (sql migrations, edge functions), the shell only talks to it when settings has its url
- what breaks first: a free project pauses after about a week without traffic (sync then falls back to local until
  someone restores it from the dashboard), then the database size (around 500 mb) and monthly egress
- fine for: accounts, settings and app data sync, update checks, push subscriptions
- alternative: cloudflare workers + d1 (no pausing, request based limits)

## droid proxy: a long-running node host
the proxy needs streaming, websockets and requests longer than a few seconds, so classic serverless
(vercel functions, netlify) is a bad fit.
- render free web service or koyeb free instance: run proxy/ as is (Dockerfile included)
  - what breaks first: the free instance sleeps when idle, so the first page after a pause takes 30-60 s; bandwidth caps
- cloudflare workers: streaming and websockets work, html rewriting fits HTMLRewriter, but the free cpu limit per
  request is small, so big pages can fail; it would need a port of proxy/ (no node http server there)
- a small vps would be the most reliable, but the goal is no vps

## recommendation
supabase for the backend, render (or koyeb) free for the proxy now, and if the cold starts get annoying, move the
proxy to cloudflare workers.
