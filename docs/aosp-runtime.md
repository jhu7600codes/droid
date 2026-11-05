# the real android framework in droid

droid's android runtime used to imitate android.view / android.widget with html elements. that can
never look or behave like android, so the runtime now runs the real android 4.4.4 framework code
(aosp, apache 2.0), compiled to dex, inside droid's dalvik interpreter.

## stage 1: building it (done)

`python3 tools/aosp/build.py` fetches the kitkat sources from android.googlesource.com, builds
android's resources (holo themes, layouts, drawables) with aapt2 and compiles the framework with
javac + d8 into `framework.dex` (about 4100 classes, 6.4 MB) and `framework-res.apk` (4 MB).
`npm run build` runs it on ci (the pages deploy), or locally with AOSP=1; the outputs are never committed.

- java.* stays droid's own (the runtime's js shims), so libcore's java.* is left out
- `overlay/` holds droid's replacements for system-side classes (no key store, no openssl, the vm)
- `patches.py` holds the few source fixes; `build.py` rewrites libcore's own java.* additions
  (`Arrays.checkOffsetAndCount`, `FileDescriptor.getInt$` ...) to `droid.Compat`
- no google branding: branded drawables are replaced by a blank image, like tools/import-aosp

## stage 2: running it

the framework's natives on the web platform: Canvas / Paint / Path / Bitmap on a 2d canvas, text
measuring and drawing, AssetManager on droid's arsc parser (framework-res plus the app), a ViewRoot
that runs measure / layout / draw on each animation frame, input events, Looper / MessageQueue on
droid's green threads, and an ActivityThread that starts activities the android way.

## stage 3: speed

a dalvik jit: hot methods compiled to javascript functions, like the arm jit (no jspi, ever).
