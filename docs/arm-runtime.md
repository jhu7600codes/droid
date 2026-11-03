# milestone 8 plan: arm runtime and apk conversion (spec section 10)

status: planned, waiting for jhu's go (see "needs a decision").

## pieces
1. apk reader (ts): zip, binary xml (AndroidManifest.xml, res/layout/*.xml), resources.arsc (strings,
   layouts, drawables per density), classes.dex
2. converter: apk -> dpk (`type: converted`, `runtime: dex | arm | both`, `converted-from`, `legacy-menu: true`,
   `shim: droid-framework@0.1`). the original apk files go in `apk/`, the runtime bundle in `runtime/`.
   runs as a cli (`tools/apk2dpk`) and inside the package installer (open an .apk, it converts, then installs)
3. dex runtime: a dalvik bytecode interpreter in ts, running inside the app's sandbox iframe
   (all ~220 opcodes, wide values as bigint, exceptions with try/catch tables, class init, virtual dispatch)
4. framework shim (the part that grows forever): java.lang / java.util basics, android.app.Activity lifecycle
   mapped to droid events, Bundle, Context, Toast, Log, SharedPreferences -> droid.prefs, layouts inflated
   from binary xml into holo dom widgets (TextView, Button, EditText, ImageView, LinearLayout,
   FrameLayout, RelativeLayout subset, ListView with ArrayAdapter), onClick, options menu -> legacy menu button,
   AsyncTask/Handler on the js event loop, java.net / HttpURLConnection -> droid.net
5. arm runtime: elf32 loader for .so (relocations, symbols, init arrays), armv7 interpreter (arm and thumb-2
   integer instructions first, vfp after), syscalls and a small libc (malloc, string, stdio to the console),
   liblog, jni (JNIEnv table, local and global refs, RegisterNatives, JNI_OnLoad), gles -> webgl later
6. the runtime layer is one interface (`load`, `call`, `step`), so a wasm-generating dynarec can replace the
   interpreter later without changing the manifest

## size estimate
| part | lines (ts) | |
|---|---|---|
| apk reader + converter | 1.5k | done in days |
| dex interpreter | 1.5k | done in days |
| framework shim for simple apps | 2-3k | a "hello + buttons + lists" apk |
| arm interpreter + elf + jni + libc | 3-4k | integer code, simple native libs |
| vfp/neon, gles->webgl, audio, engine games | 10k+ | months, this is where it gets hard |

honest expectation: a simple old java apk (and one with a small jni lib) runs at the end of this milestone.
real games built on engines (cocos2d-x, unity) need gles, audio, threads and vfp: that is follow-up work.

## needs a decision
to test on a real apk i need to build one: javac is here, but making classes.dex and the binary resources
needs google's d8 and aapt2 (from dl.google.com maven) or a public android.jar. downloading and running those
was blocked in this session. options:
1. allow downloading d8 / aapt2 / android.jar for the test build only (nothing from them ships in droid)
2. i hand-write a tiny dex and binary-xml encoder for the test app (slower, but no google tools)
3. test against an old open source apk from f-droid instead (also a download)
