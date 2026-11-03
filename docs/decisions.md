# decisions

## units: 1 css px = 1 dp
browsers already make 1 css px about 1/160 inch on phones, the same as a dp. so the shell is laid out
in px and they mean dp. the density bucket (mdpi..xxhdpi) only picks which images to load. fit mode
(a fixed preset scaled into the window) is a css transform on the screen element.

## holo look: generated css from aosp drawables
tools/import-aosp turns the kitkat selectors and 9-patches into one stylesheet per density.
android's "first matching state wins" is kept by putting all states inside :where() (same
specificity for every rule) and writing the items last to first.
9-patches with one stretch region per axis use css border-image. the 62 with several regions
use the canvas renderer in src/shell/ninepatch.ts.

## static assets are not bundled
assets/ is copied as-is into dist/ so the import manifest stays true and paths are stable.

## hosting
the build prompt says vercel in one place and github pages in another. going with github pages
(base './' so it also works anywhere else) until jhu says otherwise.

## sandbox: sandboxed srcdoc iframe + message bridge
every dpk activity is an `<iframe sandbox="allow-scripts ...">` without `allow-same-origin`, so the app gets an
opaque origin: no access to the shell, its storage or other apps. a strict csp blocks all network (connect-src is
only blob/data). the only way out is a MessagePort to the shell (src/runtime/bridge.ts), which checks every call
against the manifest and the user's grants. one origin per app was not possible: github pages gives one origin.
how files get in: the iframe starts as a tiny srcdoc with the sdk; the shell sends the package bytes, the sdk makes
blob urls inside the sandbox's own origin, rewrites the entry html (and css url(), relative module imports) and
writes the page with document.write. relative urls keep working through a fake base (https://dpk.invalid/<id>/),
an import map and patched fetch / xhr / src setters. the holo css and roboto load from the shell's /assets/
(allowed in the csp; github pages sends access-control-allow-origin: *).
it is behind one function (hostActivity), so a per-origin host can replace it later.
limits: camera, microphone and location inside the sandbox depend on the browser allowing them for an opaque
origin (chromium mostly does with the allow attribute). system apps (camera, gallery, ...) run in the shell, trusted.

## system apps run in the shell
system apps (launcher, systemui, settings, ...) use the same manifest format but are typescript modules running in
the shell's document: they need 60fps gestures and system permissions, and they ship with the shell image anyway.
installed dpks always run in the sandbox.

## render scale
the shell is dom, which the browser always renders at full resolution, so the render scale setting is handed to
apps through droid.device (canvas and webgl apps use it for their backing size).
