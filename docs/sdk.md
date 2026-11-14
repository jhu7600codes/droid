# droid sdk (dpk spec 2.0, droid 4.4, api 19)

a dpk is a zip with `manifest.json` at the root. hello world is two files:

```json
{ "id": "com.you.hello", "name": "Hello", "version": "1.0", "versioncode": 1, "type": "web",
  "main": "main", "activities": { "main": { "entry": "index.html", "launcher": true } } }
```

```html
<button class="h-btn" onclick="droid.toast('hi')">Say hi</button>
```

pack it: `npm run pack-dpk -- path/to/folder out.dpk --integrity`, then drop the .dpk on droid
(or open `?install=<url>`). the package installer shows the permissions and installs it.

## the page
- your html runs in a sandboxed iframe with its own origin. relative urls (img, css, fetch, es module imports)
  point into your package. `droid.asset(path)` gives a url for a package file.
- the holo css is loaded for you: `h-btn`, `h-check`, `h-radio`, `h-switch`, `h-edit`, `h-list` / `h-item`,
  `h-progress`, `h-spin`, `t-large` ... (see holo-test.html). theme comes from the manifest (`holo-dark` / `holo-light`).
- no network unless you ask for `network`, and then only through `droid.net` (a plain `fetch` to another host
  is routed there too).
- dynamic `import(someVariable)` of package files is not supported, static and literal imports are.

## events: `droid.on(name, fn)`
`create(saved)`, `start`, `resume`, `pause` (return a json state, max 64 kb, you get it back in `create`),
`stop`, `destroy`, `back` (return true if you handled it), `menu({id})`, `intent(i)`, `result`, `configchange(device)`,
`ws` (bridge websockets).

## api (everything returns a promise)
| call | notes |
|---|---|
| `droid.app.info()` | `{id, name, version, versioncode, activity, intent}` |
| `droid.app.finish(code?, data?)` | close this activity |
| `droid.intent.start(i)` / `startforresult(i)` / `setresult(code, data)` / `current()` | `i = {action, package, activity, data, type, extras}`; `droid.intent.OK = -1`, `CANCELED = 0` |
| `droid.toast(text, 'short'|'long')` | |
| `droid.dialog({title, message, items, kind, ok, cancel, neutral, value})` | kinds: alert, confirm, list, single, multi, input. resolves `{button, index, checked, value}` |
| `droid.actionbar.set({title, menu, visible})`, `.title(t)`, `.menu([{id, title, icon?, always?}])` | menu taps arrive as the `menu` event |
| `droid.progress(show, text)` | progress dialog |
| `droid.prefs.get/set/remove/keys` | private key-value store, wiped on uninstall |
| `droid.files.read(path, {scope, as})`, `write(path, data, {scope})`, `list(dir)`, `delete(path)` | scope: `private` (default), `shared` (needs `storage`), `package` (read only). `as`: text, bytes, url |
| `droid.system.vibrate(ms)` | `vibrate` |
| `droid.system.clipboard.read()` / `.write(text)` | read needs `clipboard` |
| `droid.system.notify({id, title, text, ongoing, progress})`, `cancel(id)` | `notifications` |
| `droid.system.orientation(o)`, `keepawake(on)`, `fullscreen(on)`, `exit()` | fullscreen needs `fullscreen` |
| `droid.device.info()` | size in dp and px, density, bucket, orientation, mode, api 19, locale |
| `droid.net.fetch(url, init)`, `droid.net.websocket(url)`, `state()`, `isonline()` | `network`, optional `hosts` list |
| `droid.danen.account()`, `.sync.get/set`, `.push.subscribe()`, `.push.send(title, body)` | `danen` (push also `notifications`); send reaches the user's own devices that subscribed for this app |
| `droid.vte.carriers()`, `.sims()`, `.plan(carrier, plan)`, `.usage(carrier)`, `.open('messaging' | carrier)` | `vte`: the user's VTE vSIMs (number, D$ credit, VMS and VoVTE minutes left, plan); for carrier apps |
| `droid.ime.show({kind, enter, multiline, autocap, force})`, `.text(before)`, `.hide()` | droid's keyboard for fields an app draws itself; keys arrive as `ime` events |
| `droid.wasm.instantiate(path, imports)` | see below |

errors have a `code`: `denied`, `notfound`, `invalid`, `toolarge`, `unsupported`, `offline`.

## permissions
`network`, `storage`, `notifications`, `vibrate`, `clipboard`, `camera`, `microphone`, `location`, `fullscreen`,
`background-audio`, `danen`, `vte`. list them in the manifest; droid asks the user on first use and remembers.
`network` can be `{ "name": "network", "hosts": ["api.example.com", "*.example.org"] }`.

## wasm (c and friends)
`type: "wasm"` apps have a small html/js loader and a module (`"wasm": {"module": "demo.wasm"}`).
`droid.wasm.instantiate('demo.wasm')` provides these imports in `env` (strings are pointer + length, utf-8):

| import | |
|---|---|
| `droid_log(ptr, len)` | console |
| `droid_toast(ptr, len)` | toast |
| `droid_title(ptr, len)` | action bar title |
| `droid_vibrate(ms)` | |
| `droid_prefs_set(kptr, klen, vptr, vlen)` | |
| `droid_now()` | ms since epoch (f64) |
| `droid_random()` | 0..1 |
| `droid_width()`, `droid_height()` | view size in css px |

build without a libc: `clang --target=wasm32 -O2 -nostdlib -Wl,--no-entry -Wl,--export-dynamic -Wl,--allow-undefined -o demo.wasm demo.c`.
see examples/wasmdemo.
