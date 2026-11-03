# build droid, a web android 4.4 (kitkat) imitation

you are building droid for me (jhu). droid is a web app that looks and feels like android 4.4 kitkat (holo era), runs fully in the browser (including ios safari, installable as a pwa), and runs its own apps called dpk (droid package).

keep your replies short, i am on usage limits. work in milestones (section 6), commit after each one, and stop after each milestone with a 3-5 line summary. ask me before any big decision that is not covered here.

## 1. inputs you have

- `dpk-spec.md`: the source of truth for the dpk format and the system (draft 0.1). follow it. if something in it is wrong or impossible, tell me and propose a fix, do not silently change it.
- `droid-animations.zip`: the boot animation and logos
  - `danen-intro.html` is the real boot sequence: a pigeon scene, then the big d (the device brand), then "powered by droid" with the pigeon-in-the-d logo. port it into the shell as a boot screen component. keep the `danen:intro-done` event idea (the shell starts loading behind it and the intro ends when the system is ready).
  - `droid-boot.html` is an older simple version, keep it only as a fallback or ignore it
  - `droid-logo.svg` (pigeon) and `droid-d-icon.svg` (d with pigeon) are the logos

## 2. assets: original aosp android 4.4

use the original android 4.4 assets, with icons, so droid looks 1:1 like kitkat.

- source: aosp, tag `android-4.4.4_r2` (kitkat). the aosp mirror on github is fine (`aosp-mirror/platform_frameworks_base` and the other `platform_*` repos). clone shallow: `git clone --depth 1 --branch android-4.4.4_r2 <repo>`
- what to pull: the framework resources (holo and kitkat drawables, 9-patches, layouts, styles, themes, colors, dimens, strings, sounds if any) from `frameworks/base` (`core/res/res`), systemui from `frameworks/base/packages/systemui`, and the stock apps and their icons from the `platform/packages/apps/*` repos (launcher, settings, deskclock, calculator, gallery, camera, contacts, email, music, browser and so on, whatever exists and is apache licensed in that tag), the keyboard from `packages/inputmethods/latinime`, aosp wallpapers from `packages/wallpapers/*`, and roboto fonts
- license: aosp is apache 2.0. keep the apache 2.0 license text and any NOTICE files in the repo, keep per-file attribution where the source has it, and add a legal / open source licenses screen to droid settings that lists them
- do not use: google proprietary apps and assets (play store, gmail, chrome, maps, google search bar and logo, any gms stuff), the android robot logo and mascot, the stock "android" boot animation and wordmark. anything you are not sure is apache licensed: leave it out and list it for me
- rebrand: user visible text that says android should say droid (about phone, build info, etc). use the pigeon logo and the boot animation i gave you for droid's own branding. danen is droid's version of google: the big d on the boot screen is danen. danen play services (account, sync, update checks, push for apps) and the danen store (the app store for dpks) are part of this release, see section 3
- build step: write an import script (node or python) that clones the tag, picks the needed resources, converts them for the web and writes them to `assets/aosp/` with a manifest of what came from where. do not commit the whole aosp clone
  - 9-patch pngs (`.9.png`): write a renderer (canvas or css border-image) so buttons, panels and the notification shade stretch correctly
  - xml drawables (selector, layer-list, shape, animation-list, vector-ish stuff): convert to css and svg
  - ship all the density buckets that exist (mdpi, hdpi, xhdpi, xxhdpi) and pick the bucket from the detected screen density (spec section 20)
  - fonts: roboto, ship as woff2

## 3. what to build (dpk 0.1, which ships as droid 4.4)

implement everything in `dpk-spec.md`, including section 10 (arm runtime and apk conversion, built last, see milestone 8):

- the shell kernel: window manager, dpk runtime, sdk bridge. everything the user sees is a system dpk with a role (spec section 14): launcher, systemui (status bar, notification shade, quick settings, nav bar, lockscreen), settings, wallpaper, keyboard, browser, networks
- dpk format: zip container, manifest validation, `web` and `wasm` types, lifecycle and back stack, intents, permissions with holo dialogs, per-app sandbox plus the sdk bridge, install, update and uninstall
- the js sdk (`droid.*`) with the surface listed in the spec section 9, plus a small docs page and 2-3 example dpks (hello world, a notes app, a wasm c demo)
- fake networks: dr-nt (wifi) and vte (mobile data), regions, the setup step where every user adds their own network, and the fallback to vte when outside the area (spec section 15). location from browser geolocation with a manual "pretend i am here" fallback, never sent anywhere
- danen account: the setup wizard has an account step. it works fully local first (a profile stored on the device) and can optionally sync to the danen backend. it must never ask for a real google password or look like a google login
- danen play services (spec section 19): the `services` role app plus the `droid.danen.*` sdk (account, sync, push through web push, update checks for installed dpks)
- danen store (spec section 19): the `store` role app to browse, search, install and update dpks, plus a publish flow done on github: developers send a pull request with their dpk and listing to the store catalog repo, a github action validates it (manifest, size, permissions, integrity hashes), a maintainer merges, and the action rebuilds the catalog and deploys it to github pages. no store server needed. the store shows the requested permissions before install
- proxy layer (spec section 18): a small node server in `proxy/` plus the client side in the sdk. it must not be an open relay (auth token, rate limits, block private ips, no content logging). self-hostable, url set in settings. design it so it can run on a small vps, serverless platforms limit streaming
- browser app: the aosp kitkat browser rebuilt as a dpk with the browser role, as 1:1 as possible (ui, icons, menus, tabs), loading pages through the proxy. if a page cannot be proxied, offer to open it in a real tab
- desktop mode: phone, tablet and desktop modes with freeform windows (spec section 17)
- screen resizing and 3 button navigation (spec section 20): automatic screen detection, the resolution and display size settings, live resize and rotate, and the kitkat nav bar (back, home, recents, down chevron when the keyboard is open, optional menu button, immersive mode), all inside the shell with the aosp systemui assets
- the setup wizard on first boot (spec section 22), then lockscreen, then home. make it look and flow like the kitkat setup wizard, with a danen account sign in and create account step, built from holo assets and original code. aosp has no real kitkat setup wizard (the real one is google's closed source), so do not copy google's text or graphics, and the account screens say danen and never accept google credentials. collect as little data as possible
- camera and gallery apps (spec section 23): the aosp kitkat camera2 and gallery2 rebuilt as dpks, real camera through getUserMedia, photos and videos saved to shared storage, gallery with albums, viewer, share and pick
- the wizard has an offline download step and a "your own network" step (spec sections 21 and 15)

dpk 0.1 and droid 4.4 are the same first release, so apk conversion is part of it. droid's version number copies the android version it imitates (droid 4.4 = android 4.4, api level 19), so use 4.4 everywhere: about phone, build info, `droid.device`, the pwa manifest. it is the biggest piece, so do it after everything else works. keep the runtime layer swappable so an interpreter first and a wasm-generating dynarec later can plug in without changing the format.

## 4. technical choices

- typescript, vite, static build, deploy on vercel. no heavy ui framework for the shell (plain dom or a tiny lib), the look must be the aosp holo assets, not a component library
- pwa and offline: manifest, installable on ios home screen, and offline-first from the start (spec section 21): a versioned service worker precache, a "download everything" step in the setup wizard and in settings > storage (essential and full, with size estimate, progress, pause and resume), persistent storage, ota-style background updates, and graceful offline behaviour for the proxy, browser and store. set up the service worker in milestone 2 and extend it as new parts land
- storage: indexeddb for installed dpks and app data
- sandbox: pick one (sandboxed iframes with a postmessage bridge is my guess), document why in `docs/decisions.md`, and keep it behind an interface
- screen size is never fixed: auto-detect the viewport, density and orientation and build the screen from them (spec section 20). 480x800 hdpi is only the default preset and the design reference. everything in dp and sp. test in chromium (playwright) at several sizes and orientations, and make sure nothing breaks in safari (no features that safari lacks)
- hosting: everything static (shell, aosp assets, system apps, store catalog, dpk files, docs) is hosted on github pages. mind that pages is static only, the repo must be public on a free plan, a project site lives under `/repo-name/` unless there is a custom domain (so use relative urls and a correct service worker scope and manifest `start_url`), single files are limited to about 100 mb, the whole site to about 1 gb, and bandwidth is soft limited. use github actions to build and deploy
- i do not want to run my own vps. danen accounts and sync need a small managed backend called from the static site (propose the cheapest free tier, my guess is supabase), and the proxy needs a real server (propose an edge platform that supports streaming and websockets, or a free-tier app host). neither can run on github pages. tell me the limits and what would break first, then wait for my answer before building them
- performance: 60fps animations for the shade, launcher paging and transitions. keep the shell small

## 5. repo layout

```
dpk-spec.md
docs/            decisions.md, sdk.md
tools/           import-aosp, pack-dpk
proxy/           the droid proxy server
backend/         danen accounts and sync backend (migrations, functions)
store/           danen store catalog (listings and dpk files), validated by github actions
assets/aosp/     generated, with the manifest
src/shell/       kernel, window manager, bridge
src/system/      system dpks (launcher, systemui, settings, ...)
src/sdk/         droid.* client library
examples/        example dpks
```

license the repo gpl-free permissive (mit for my code, apache 2.0 for aosp parts). keep a `NOTICE` file.

## 6. milestones

1. asset import pipeline, holo theme css, 9-patch renderer, a test page showing buttons, lists, dialogs, switches, action bar
2. shell kernel, automatic screen detection and the resolution setting, boot animation, setup wizard, lockscreen, launcher, systemui (status bar, 3 button nav bar, shade, quick settings)
3. dpk runtime: parser, install, lifecycle, sdk bridge, permissions, intents, example apps, `pack-dpk` tool
4. settings app, camera and gallery, and the networks role (dr-nt, vte, regions, setup network)
5. proxy server, and the browser app on top of it
6. danen play services and the danen store (client apps first, then the backend after you tell me the hosting plan)
7. desktop mode and tablet mode
8. arm runtime and apk conversion (spec section 10): the in-browser armv7 runtime (interpreter first), the dex runtime with the framework shim, the apk to dpk converter, tested on a simple old 32-bit apk. before starting, tell me your plan and your estimate of how big it is
9. polish: sounds, animations, wallpapers, about and licenses screen, docs, the offline download screen and system update screen, test everything with the network off

after each milestone: run it in a headless browser, take screenshots, and compare against kitkat look. if something looks off, fix it before moving on.

## 7. rules

- no real google login or lookalike, no google branding, no android robot
- android code only ever runs through droid's own arm and dex runtimes, inside the sandbox
- never commit secrets or tokens
- keep the code simple and readable, i will read and edit it
