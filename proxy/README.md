# droid proxy

relays http(s) and websockets for droid (dpk spec section 18) so the browser and apps can reach sites that
block cross-origin requests or framing. self-host it anywhere that runs node 22 (a small vps, fly.io, render,
railway, a raspberry pi). serverless platforms that cap request time or buffer responses break streaming and
websockets, so use a normal long-running host.

```bash
cd proxy && npm i && npm start            # :8787
```

then in droid: settings > more > droid proxy, set the address and a token (`POST /register` gives one when
registration is open, or set your own with `DROID_TOKENS`).

## environment
| var | default | |
|---|---|---|
| `PORT` | 8787 | |
| `DATA_DIR` | ./data | token hashes are kept here |
| `DROID_TOKENS` | | comma separated tokens that always work |
| `REGISTRATION` | open | `closed` = only `DROID_TOKENS` |
| `ORIGINS` | * | shell origins allowed to call /fetch (cors), e.g. `https://you.github.io` |
| `ALLOW_HOSTS` | | optional host allowlist (`example.com,*.wikipedia.org`) |
| `ALLOW_PORTS` | 80,443 | |
| `RATE_PER_MINUTE` | 300 | per token |
| `BYTES_PER_DAY` | 2 GB | per token |
| `MAX_RESPONSE` | 100 MB | |
| `TIMEOUT_MS` | 60000 | |

## what it guarantees
- not an open relay: every request needs a token; rate, size and time limits per token
- no ssrf: loopback, private, link-local, cgnat, multicast and reserved addresses are refused, checked again on
  the address actually connected to (dns rebinding) and on every redirect; only ports 80 and 443 by default
- tls to the origin is always verified
- no logging of page content or request bodies (nothing is logged per request at all)
- cookies live in a jar per app (and per browser tab in page mode), never shared between apps

## limits
heavy js sites, drm video and sites that detect proxies may not work. the browser offers to open the page in a
real tab when that happens.
