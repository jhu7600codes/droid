# dpk spec (droid package) - draft 0.1

this is the spec only: what a dpk is and how it behaves. the actual file format parser, the shell, the sdk code and the packer tool are implementation work and not covered here.

## 1. what a dpk is

a dpk is a single installable app for droid (the web android 4.4 imitation). it is android-like on purpose: it has a manifest, activities, intents, permissions and a lifecycle. it is not an apk, but an old apk can be converted into one (section 10).

there are four kinds of dpk:

- **web**: html, css and js. the common case.
- **wasm**: a small js loader plus a c (or any language compiled to wasm) module. for games and heavy stuff.
- **arm**: 32-bit arm native code (armeabi-v7a) run by droid's in-browser arm runtime, with android pieces faked around it. see section 10.
- **converted**: produced from an old apk by the converter (java side plus any native libs). see section 10.

any of these can also be a **system app** (section 14): the launcher, system ui, wallpaper and settings are all dpks too.

## 2. goals and non-goals

goals:
- easy to write by hand, a hello world is two files
- feels like android 4.4: activities, back stack, intents, toasts, dialogs
- safe: apps cannot touch the shell, other apps, or the real device without a permission
- works offline once installed
- the whole system is made of dpks, so even system ui and the launcher can be replaced
- old 32-bit apks can be converted and run (section 10)
- everything runs in a browser (wasm, webgl, web audio), no native install

non-goals for v0.1:
- google play services, real google accounts
- a store or any central signing authority
- real connectivity features: the fake networks (section 15) are cosmetic

## 3. package container

- a dpk is a zip archive with the extension `.dpk` and mime type `application/x-dpk`
- paths inside are lowercase, forward slashes, no `..`, no absolute paths
- required: `manifest.json` at the root
- everything else is app content (html, js, wasm, images, audio, data)
- max sizes (shell enforces): 64 mb total, 20 mb per file, 5000 files

## 4. manifest.json

required fields:

| key | meaning |
|---|---|
| `id` | reverse-dns style package id, lowercase, e.g. `com.jhu.notes`. unique per app |
| `name` | display name |
| `version` | human version string, e.g. `1.0.3` |
| `versioncode` | integer, must grow with every release |
| `type` | `web`, `wasm`, `arm` or `converted` (see section 10) |
| `main` | name of the main activity (see `activities`) |
| `activities` | map of activity name to its entry file and options |

optional fields:

| key | meaning |
|---|---|
| `icon` | path to a png, 96x96 recommended |
| `minapi` | lowest droid api level the app needs, default 1. droid api 19 matches android 4.4 |
| `permissions` | list of permission names (section 7) |
| `orientation` | `portrait`, `landscape`, or `any` (default) |
| `theme` | `holo-dark` (default) or `holo-light`, controls the action bar and dialogs the shell draws |
| `intent-filters` | which intents the app can handle (section 6) |
| `wasm` | for `type: wasm`: path to the module and its memory hints |
| `role` | system role this app fills (section 14), only honored for system apps |
| `system` | `true` for apps shipped in the shell image (section 14) |
| `supports` | list of form factors: `phone`, `tablet`, `desktop` (section 17). default `phone` |
| `resizable` | `true` if windows can be resized in desktop mode. default `false` |
| `author`, `description`, `homepage` | free text |
| `converted-from` | only for converted apps: original apk package name and version |

an activity entry looks like:
- `entry`: html file for that activity
- `label`: title shown in the action bar
- `launcher`: true if it appears in the app drawer
- `launch-mode`: `standard` or `single-top`

unknown keys must be ignored so the format can grow.

## 5. lifecycle and back stack

each activity moves through these states, delivered as events to the app:

`create` -> `start` -> `resume` -> (running) -> `pause` -> `stop` -> `destroy`

rules:
- `pause` fires when the activity loses focus (another activity opens, shade pulled down)
- `stop` fires when it is no longer visible
- apps in the background may be killed by the shell at any time after `stop`, so state must be saved on `pause`
- `destroy` is not guaranteed after a kill, same as real android
- the shell keeps a back stack of activities. the back button pops it. at the root, back goes home
- home button moves the whole task to the background (activities get `pause` then `stop`)
- state can be handed over with a small saved-state blob (json, 64 kb max) on `pause`, given back on `create`

## 6. intents

an intent is a message asking some activity to do something.

- **explicit**: names the target package and activity
- **implicit**: names an action (`view`, `send`, `pick`, `main`) plus optional data and mime type, and the shell picks a handler from `intent-filters`
- if several apps match, the shell shows a chooser dialog
- extras are a json object, 256 kb max
- an activity can be started "for result" and then returns a result code and json data
- the shell itself handles some actions (open settings, pick a file, take a photo) so apps can ask for them

## 7. permissions

an app must list a permission in the manifest to use the matching feature. the shell asks the user on first use (holo-style dialog), and the choice is stored per app.

initial permission set:
- `network`: fetch and websocket to the outside
- `storage`: shared storage area outside the app's private folder
- `notifications`: post to the notification shade
- `vibrate`
- `clipboard`
- `camera`, `microphone`, `location`: map to the real browser prompts, asked lazily
- `fullscreen`
- `background-audio`

an app with no permissions can still run offline using its own private storage.

## 8. sandbox and storage

- every app runs isolated from the shell and from other apps (own origin or sandboxed frame, shell's choice)
- the only way out is the droid sdk bridge, a message channel between the app and the shell
- every bridge call is checked against the app's granted permissions
- private storage: per-package key-value store plus a per-package virtual file folder, wiped on uninstall
- shared storage: one common virtual folder for apps with the `storage` permission
- network is blocked by default (no outbound requests) unless `network` is granted

## 9. the droid sdk (js api, surface only)

the shell injects a global `droid` object. this lists what it must offer, not how it is built.

- **app**: package info, own version, open another activity, finish the current one
- **events**: `droid.on(name, fn)` for `create`, `start`, `resume`, `pause`, `stop`, `destroy`, `back`, `menu`, `intent`, `result`
- **intent**: `start(intent)`, `startforresult(intent)`, `setresult(code, data)`
- **ui helpers**: `toast(text, duration)`, `dialog(options)` (alert, confirm, list, input), `actionbar` settings (title, menu items), `progress`
- **storage**: `prefs` (key-value), `files` (read, write, list, delete in the virtual folders)
- **system**: `vibrate`, `clipboard`, `notify`, `orientation`, `keepawake`, `exit`
- **device**: screen size (px and dp), density, orientation, api level (`19`), locale (see section 20)
- **net**: `fetch` and `websocket` wrappers that respect the `network` permission and go through the droid proxy (section 18) when the browser would block a direct request

all async calls return promises. errors use a small fixed set of codes: `denied`, `notfound`, `invalid`, `toolarge`, `unsupported`, `offline`.

for `wasm` apps the same calls are exposed to the module through a documented import table, so c code can call them without writing js glue.

## 10. arm runtime and apk conversion

this section is part of the first release (droid 4.4 ships with dpk spec 0.1, conversion included. droid versions copy the android version they imitate, so droid 4.4 imitates android 4.4). it is built last because it is the biggest piece. the runtime layer is swappable, so the interpreter can later get a wasm-generating dynarec without changing the format:

- `type: converted` and `converted-from` are reserved in the manifest
- converted apps use the same lifecycle, intents and permissions as native dpks
- target inputs are old apks only: 32-bit (armeabi-v7a), java, no kotlin
- the goal is full conversion, including apks with native libraries (engine-based games)
- `type: arm` manifest block: `abi` (`armeabi-v7a`), `libs` (list of .so files), `main` (native entry or jni class)
- `type: converted` manifest block: `runtime` is `dex` (java only), `arm` (native only) or `both`
- the arm runtime is user-mode emulation, not a full android boot: it runs the app's arm code and provides the android parts around it in the browser (c library and syscalls, jni, opengl es mapped to webgl, audio, touch, files)
- the dex runtime runs the app's java bytecode in wasm, with the framework shim below providing the android classes
- performance targets are a later concern, the spec only requires that the runtime can be swapped (interpreter first, wasm-generating dynarec later) without changing the manifest
- a converted app may rely on a bundled "framework shim" that maps old android calls to the droid sdk. the shim is versioned and declared in the manifest as `shim: <name>@<version>`

## 11. install, update, uninstall

- install: user opens a `.dpk`, the shell validates the manifest and size limits, shows the requested permissions, then unpacks into the app store
- same `id` and a higher `versioncode` = update, keeps private storage
- same `id` and a lower or equal `versioncode` = rejected, unless the user confirms a downgrade
- uninstall wipes private storage and removes the icon
- v0.1 has no signing. an optional `integrity` map of file path to sha-256 hash in the manifest lets the shell verify contents. real signing is future work

## 12. versioning of this spec

- the spec has a version (`dpk-spec 0.1`). manifests may declare `dpk` (spec version they target)
- the shell must refuse a manifest whose major spec version is higher than it supports
- minor versions only add optional things

## 13. open questions (for the implementer to decide or ask)

- sandbox mechanism: sandboxed iframe with a message bridge vs one origin per app
- how wasm threads and shared memory are handled on ios safari
- format of the saved-state blob if apps want binary
- do we want a debug mode that loads an unpacked folder instead of a zip
- app drawer and shortcut behaviour for apps with several launcher activities

## 14. system apps and roles

the shell itself is a small kernel: window manager, dpk runtime, sdk bridge, nothing visible. everything the user sees is a system app, a dpk with `system: true`.

- system apps ship inside the shell image and cannot be installed or updated by the user in v0.1
- a system app declares a `role`; the shell starts and wires up the app that holds each role
- roles: `launcher` (home screen and app drawer), `systemui` (status bar, notification shade, quick settings, navigation bar, lockscreen), `settings`, `wallpaper`, `ime` (keyboard), `browser`, `networks` (section 15), `store` and `services` (section 19)
- extra permissions only system apps may request: `system.statusbar`, `system.notifications`, `system.wallpaper`, `system.settings`, `system.windows`, `system.networks`, `system.apps` (list and launch installed apps)
- replacing a role is allowed: the user can pick another app that declares the same role
- the look is holo (android 4.4 era). use assets from aosp (apache 2.0) or original ones. no proprietary google apps, logos or branding
- stock system apps to ship: launcher, systemui, settings, wallpaper (static and live), keyboard, browser, plus small ones like clock, calculator, gallery, file manager

## 15. fake networks (dr-nt and vte)

droid has its own pretend connectivity layer shown in the status bar and settings. it is cosmetic: real connectivity is whatever the browser has.

- network kinds: `drnt` (the fake wi-fi, shown with the wi-fi icon) and `vte` (the fake mobile data, shown like lte)
- a network definition has: `id`, `name`, `kind`, `area`, `signal` (how strength falls off)
- an `area` is a center point (latitude and longitude) plus a radius, or a named region
- regions are hierarchical, e.g. country, then region, then networks. example: `moscow-oblast` lists `jhfi` and others. the shell ships a region list and users can add more
- setup step: every user creates their own network (name, center, radius). this is "your network"
- state rule: if the device is inside the area of a `drnt` network it can connect to it. if the device is outside the area of the user's own network, the connection falls back to `vte`. if no network applies, state is `none`
- `vte` can simulate slower speed, a data counter and an on/off toggle (like mobile data)
- location comes from the browser geolocation (needs the shell to ask) or a manual "pretend i am here" picker as a fallback. location stays on the device
- apps see it through `droid.net.state()` returning `{kind, name, signal}` and a `network` event when it changes
- the `networks` role app draws the wifi list and the data settings

## 16. browser

the browser is a system app with `role: browser`. it handles `view` intents for http and https urls.

- tabs, bookmarks, history and downloads live in the app's private storage
- the stock browser is the aosp kitkat browser app, rebuilt as a dpk with its original ui, menus and icons as closely as possible (aosp, apache 2.0)
- real web limit: many sites refuse to be shown inside another page. the browser loads pages through the droid proxy (section 18), and if a page cannot be proxied it offers to open it in a real browser tab
- the browser is an ordinary dpk, so it can be replaced or forked

## 17. desktop mode

droid has three display modes: `phone` (one 4.4-style screen, scaled to fit, default), `tablet` (bigger single screen), and `desktop` (freeform windows with a taskbar, like desktop mode on a pc).

- the shell picks a mode from the browser window size and the user can force one in settings
- in `desktop` mode apps run in windows. only apps with `resizable: true` can be resized, others get a fixed window
- apps get a `configchange` event with the new size, density and mode, and `droid.device` reports the same
- apps that do not list `desktop` in `supports` run inside a phone-sized window
- system apps (launcher, systemui) must adapt: in desktop mode systemui becomes the taskbar and the launcher becomes a start-like menu
- open questions: window snapping, multi-monitor via several browser tabs, how the keyboard and mouse map to d-pad and touch for old apps

## 18. proxy layer

why: browsers block cross-origin requests (cors), refuse to be framed (x-frame-options, csp frame-ancestors) and have no raw sockets. droid apps, converted apps and the browser need the real internet, so droid ships a proxy.

the droid proxy is a small server that anyone can self-host. the shell has a setting for its url. endpoints:

- `fetch`: http and https relay. keeps method, headers and body, streams the response, supports range requests (needed for video)
- `ws`: websocket relay
- `page`: for the browser app. fetches a page, rewrites urls in html, css and js so subresources go back through the proxy, strips the headers that block framing, and keeps a cookie jar per app and per tab
- `tcp` (optional, later): raw tcp over a websocket, for converted apps that open sockets

how apps use it:
- apps never talk to the proxy directly. `droid.net.fetch` and `droid.net.websocket` choose direct or proxied themselves
- the `network` permission can carry a `hosts` list to limit where an app may connect. the shell enforces it
- converted apps (section 10): the framework shim maps the java http and socket classes onto the same calls

security (required, the proxy must not be an open relay):
- every install gets an auth token, requests without it are refused
- rate limits and size and time caps per token
- block loopback, private and link-local addresses and non-http ports unless allowed (no ssrf)
- no logging of page content or request bodies
- tls to the origin is always verified
- cookies are isolated per app and never shared between apps
- optional host allowlist for people who self-host

limits to be honest about: heavy js sites, drm video and sites that detect proxies may not work. the browser falls back to opening a real tab.

open questions: where to host the default instance (a small vps, since serverless platforms limit streaming and request time, or an edge platform that supports streaming and websockets), rewriting on the server vs a service worker in the browser, how to handle websocket-heavy sites.

## 19. danen play services and the danen store

danen is droid's version of google: the brand behind droid's services. the big d on the boot screen is danen.

danen play services (`services` role):
- danen account: a local profile that works with no network, and can optionally be synced to the danen backend. never a real google account, never a lookalike of a google login
- optional sync of settings and app data
- update checks for installed dpks
- push notifications for apps through web push
- sdk surface `droid.danen.*` (account, sync, push). apps need the `danen` permission

danen store (`store` role):
- browse, search, install, update and uninstall dpks
- a listing has: id, name, icon, screenshots, description, version, size, author, requested permissions
- the catalog comes from the backend, dpk files from static storage, and the store verifies the `integrity` hashes from the manifest before install
- publishing is done on github: a developer sends a pull request with their dpk and listing to the danen store catalog repo. a github action checks the manifest, size, permissions and integrity hashes, and a maintainer reviews and merges it. the action then rebuilds the catalog and redeploys it to github pages. so the store needs no server and the review queue is the pull request list
- every listing has a report button (opens a pre-filled github issue), and listings can be taken down by removing them from the repo
- no paid apps and no developer signing keys in 0.1 (hashes only)

hosting: everything static is on github pages: the shell, aosp assets, system apps, the store catalog and dpk files, and the docs. github pages is static only, so danen accounts and sync need a small managed backend that the static site calls (auth, database), and the proxy (section 18) needs a real server somewhere else. neither can run on github pages. no vps run by the author is the goal, so both should use free-tier managed services.

open questions: which backend, developer signing keys later, how to handle ratings and spam, paid apps later.

## 20. screen size, density and 3 button navigation

there is no fixed resolution. 480x800 is only the default preset and the design reference.

automatic screen detection:
- the shell reads the browser viewport, device pixel ratio, orientation and safe-area insets (notches) and builds the screen from them: size in px and dp, a density bucket (ldpi 120, mdpi 160, hdpi 240, xhdpi 320, xxhdpi 480, using android's rules), and an orientation
- everything in the shell is laid out in dp and sp, and assets are picked by density bucket
- resize, rotate and browser zoom are handled live with no reboot. changes are debounced and apps get a `configchange` event (spec section 17) with the new size, density and orientation

resolution setting (settings > display):
- `auto` (default): use the detected screen
- presets: 480x800 hdpi, 720x1280 xhdpi, 1080x1920 xxhdpi, a tablet preset, and custom width, height and dpi
- a display size slider that changes density only, like android's
- `render scale` option: render at a lower internal resolution and scale up, for slow devices
- `fit` mode (fixed resolution scaled into the window with black bars) and `native` mode (the screen is the whole viewport). `auto` picks `native` on phones

apps and orientation:
- apps see the size of the content area (the screen minus status bar and nav bar) through `droid.device`
- if an app locks `orientation` and the device is the other way round, the shell rotates the app's view with css. browsers cannot always lock the real orientation

3 button navigation (the kitkat navigation bar, part of the `systemui` role):
- three buttons: back, home, recents, taken from aosp systemui
- height 48 dp. on phones it is at the bottom in portrait and on the right side in landscape, on tablets always at the bottom. the status bar is 25 dp. both are subtracted from the area apps get
- back pops the back stack (section 5). home goes to the launcher. recents opens the recent apps overview (holo thumbnails, swipe to dismiss)
- when the keyboard is open the back icon turns into the down chevron, like on kitkat
- apps with `legacy-menu: true` in the manifest (mostly converted apps) get a fourth menu button
- immersive mode: `droid.system.fullscreen` hides the status bar and nav bar, and a swipe from the edge brings them back
- keyboard shortcuts: escape or alt+left is back, and in desktop mode the nav bar becomes taskbar buttons (section 17)

## 21. offline mode

droid is offline-first. after the first load, everything needed runs with no network.

what gets downloaded:
- the shell, all system apps, the aosp assets, fonts, the boot animation and the sample dpks
- every installed dpk and its data (indexeddb)
- a cached copy of the danen store catalog, for browsing offline

how:
- a service worker with a versioned precache. the setup wizard and settings > storage > offline have a "download everything" action with an `essential` option (shell and system apps) and a `full` option (also wallpapers, sounds and featured apps), a size estimate, a progress bar, and pause and resume. it warns before downloading a lot over a metered connection when the browser can tell
- updates download in the background and apply on the next boot, shown in settings > about phone > system update like an ota update
- the shell asks the browser for persistent storage and shows used and free space in settings > storage, with clear cache and clear data per app
- on ios, browsers may evict stored data for sites that are not used for a while. an app installed to the home screen is more reliable, so the setup wizard suggests installing it

what works offline:
- the whole system, installed dpks, loading a `.dpk` file from disk, the fake networks (they are cosmetic) and the manual location picker

what needs the network:
- the proxy (section 18), so the browser shows a kitkat style "webpage not available" page, `droid.net` calls fail with the `offline` error, installing from the store unless the dpk is already cached, danen sync and push
- the sdk has `droid.net.isonline()` and `online` and `offline` events so apps can adapt

dpk apps should also work offline when they can: the packaging tool warns about apps that load code or assets from outside the package.

## 22. setup wizard

the first boot runs a setup wizard that looks like the kitkat one, built from holo assets and original code. the real kitkat setup wizard is google's closed source app, so it is recreated by look and flow, with danen branding, and never copies google's text or graphics.

steps, in order:
1. welcome and language (list picker, like kitkat)
2. network: pick a dr-nt network from the detected region, or skip (section 15)
3. create or sign in to a danen account, or skip with "not now" (below)
4. date and time
5. danen services: sync and location checkboxes, off by default where it matters (section 19)
6. your own network: create your home network (section 15)
7. owner name or nickname
8. offline download: essential or full, with progress (section 21), and a suggestion to install to the home screen
9. all done, then the launcher

every step has next and skip, and the wizard can be run again from settings.

danen account:
- sign in and create account screens that look like a kitkat sign in, but say danen everywhere, and never use google logos or text
- the account is stored on the managed backend (section 19). it only ever accepts danen credentials. it must never ask for or accept a google password
- collect as little as possible: a nickname, a username and a password, or a passkey. no real name, no birthdate, no phone number, no tracking, and a plain privacy page linked from the screen
- "not now" gives a fully working local profile, and an account can be added later in settings
- the sign in flow must work with the backend down (it falls back to local)

## 23. camera and gallery

camera and gallery are stock system apps (section 14), rebuilt from the aosp kitkat apps (`packages/apps/Camera2` and `packages/apps/Gallery2`, apache 2.0) with their original ui and icons as closely as possible.

camera:
- uses the real device camera through the browser (`getUserMedia`), so it needs the `camera` permission, and `microphone` for video
- photo and video modes, front and back camera switch, flash toggle where the browser supports it (torch), tap to focus where supported, shutter sound
- photos are saved as jpeg and videos as webm or mp4 (whatever the browser can record) into shared storage under `dcim/camera/`
- handles the `capture` intent (the shell's "take a photo" action, section 6) and returns the image to the calling app
- if there is no camera or the user says no, it shows a kitkat style "can't connect to the camera" dialog

gallery:
- shows albums from shared storage (camera, downloads, screenshots and any folder with images or videos)
- full screen viewer with swipe, pinch zoom, delete, share (a `send` intent) and set as wallpaper
- plays videos
- handles `view` and `pick` intents for images and videos
- everything stays on the device, nothing is uploaded
