// boots a real app on the real android framework in node (no browser: nothing is drawn, but the
// whole launch runs: bind, the activity's onCreate / onResume, the window, measure, layout, draw).
// usage: node tools/aosp/boot.mjs [app.apk] [seconds]   (after python3 tools/aosp/build.py)
import fs from 'node:fs'
import { VM } from '../../src/runtime/android/dalvik.ts'
import { registerJava } from '../../src/runtime/android/java.ts'
import { registerReflect } from '../../src/runtime/android/reflect.ts'
import { Vfs, registerJavaIo } from '../../src/runtime/android/javaio.ts'
import { registerCollections } from '../../src/runtime/android/collections.ts'
import { registerConcurrent } from '../../src/runtime/android/concurrent.ts'
import { parseDex } from '../../src/runtime/android/dex.ts'
import { registerAospNatives } from '../../src/runtime/android/aosp/natives.ts'
import { registerAospSystem } from '../../src/runtime/android/aosp/system.ts'
import { apks } from '../../src/runtime/android/aosp/res.ts'
import { listZip, readEntry } from '../../src/runtime/zip.ts'
import { Native } from '../../src/runtime/android/arm/native.ts'

const apkFile = process.argv[2] || new URL('../apk2dpk/test.apk', import.meta.url).pathname
const seconds = Number(process.argv[3] || 8)
const unzip = async (buf) => { const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length); const m = new Map(); for (const e of listZip(ab)) m.set(e.path, await readEntry(ab, e)); return m }

const vm = new VM()
registerJava(vm); registerCollections(vm); const vfs = new Vfs(); registerJavaIo(vm, vfs); registerReflect(vm); registerConcurrent(vm)
const { gfx } = registerAospNatives(vm, { vfs })
const fw = fs.readFileSync(new URL('./.cache/dex/classes.dex', import.meta.url))
vm.addDex(parseDex(new Uint8Array(fw.buffer, fw.byteOffset, fw.length)))
apks.set('/system/framework/framework-res.apk', await unzip(fs.readFileSync(new URL('./.cache/framework-res.apk', import.meta.url))))
const appBuf = fs.readFileSync(apkFile)
const app = await unzip(appBuf)
const apkPath = '/data/app/app-1.apk'
apks.set(apkPath, app)
vfs.write(apkPath, new Uint8Array(appBuf))
for (const [n, b] of app) if (/^classes\d*\.dex$/.test(n)) vm.addDex(parseDex(b))
// app native libraries (armeabi-v7a) run on droid's arm runtime
const SYSTEM_LIBS = new Set(['rs_jni', 'RS', 'media_jni', 'exif_jni', 'jnigraphics', 'android_runtime', 'android', 'webviewchromium', 'webviewchromium_loader', 'webcore', 'chromium_net', 'sqliteX', 'javacore', 'nativehelper', 'icu_jni', 'mtp', 'soundpool', 'camera2_jni'])
let native = null
vm.cls('Ljava/lang/System;').methods.get('loadLibrary(Ljava/lang/String;)V').native = (v, s, [name]) => {
  const file = 'lib' + name + '.so', b = app.get('lib/armeabi-v7a/' + file) ?? app.get('lib/armeabi/' + file)
  if (!b && SYSTEM_LIBS.has(name)) return // the framework's own libraries: their natives are droid's
  if (!b) throw vm.error('Ljava/lang/UnsatisfiedLinkError;', 'dlopen failed: library "' + file + '" not found')
  native ||= new Native(vm, vfs, 'app'); native.load(file, b)
}
vm.natives = (m, self, args) => { if (!native) throw vm.error('Ljava/lang/UnsatisfiedLinkError;', 'no native ' + m.cls.name + '->' + m.key); return native.call(m, self, args) }
let frames = 0
const sys = registerAospSystem(vm, gfx, {
  pkg: 'app', apkPath,
  screen: () => ({ w: 720, h: 1280, dpi: 320 }),
  present: (w, bmp, f) => { if (frames++ < 3 || process.env.FRAMES) console.log(`frame: window ${w} ${bmp.w}x${bmp.h} at ${f.join(',')}`) },
  event: (what, d) => console.log('host event:', what, d),
})
if (process.env.TRACE) for (const k of process.env.TRACE.split(',')) { const f = vm.dexNatives.get(k); if (f) vm.dexNatives.set(k, (v, s, a) => { console.log('trace', k.split('->')[1], a.map((x) => (typeof x === 'object' && x ? x.cls?.name ?? '[]' : String(x))).join(' ')); return f(v, s, a) }) }
if (process.env.JTRACE) { const re = new RegExp(process.env.JTRACE), from = process.env.JFROM && new RegExp(process.env.JFROM), max = Number(process.env.JMAX || 400); let n = 0, on = !from, skip = Number(process.env.JSKIP || 0); vm.onEnter = (m) => { const k = m.cls.name + '.' + m.name; if (!on && from.test(k) && skip-- <= 0) on = true; if (on && re.test(k) && n++ < max) console.log('call', k) } }
const boot = vm.findMethod(vm.cls('Ldroid/system/Boot;'), 'main([Ljava/lang/String;)V')
const t = vm.startThread('main', boot, null, [vm.newArray('[Ljava/lang/String;', 0)])
vm.main = t
const show = (o, depth = 0) => { if (!o || depth > 6) return ''; return `${o.cls.name}: ${o.f.message ?? ''}\n  at ${(o.f.jstack || []).slice(0, 8).join('\n  at ')}` + (o.f.cause && o.f.cause !== o ? '\ncaused by ' + show(o.f.cause, depth + 1) : '') }
t.onDone = (e) => { console.log('main thread ended:', e?.obj ? show(e.obj) : e) }
if (process.env.BACK) setTimeout(() => { console.log('-> back key'); sys.key(0, 4); sys.key(1, 4) }, Number(process.env.BACK) * 1000)
if (process.env.TAP) setTimeout(() => { const [x, y] = process.env.TAP.split(',').map(Number); console.log('-> tap', x, y); const t = performance.now(); sys.touch(0, x, y, t); sys.touch(1, x, y, t) }, 5000)
if (process.env.INSPECT) setTimeout(() => {
  const g = vm.callStatic('Landroid/view/WindowManagerGlobal;', 'getInstance()Landroid/view/WindowManagerGlobal;')
  for (const r of g.f.mRoots.f.a) { const ai = r.f.mAttachInfo, d = r.f.mDirty; console.log('root', { w: r.f.mWidth, h: r.f.mHeight, scale: ai.f.mApplicationScale, screenOn: ai.f.mScreenOn, valid: r.f.mSurface?.f.mNativeObject, dirty: [d.f.left, d.f.top, d.f.right, d.f.bottom], winFrame: [r.f.mWinFrame.f.left, r.f.mWinFrame.f.right], holder: r.f.mSurfaceHolder?.cls.name, hw: ai.f.mHardwareRenderer?.cls.name, anim: r.f.mIsAnimating, mView: r.f.mView?.cls.name, measured: r.f.mView?.f.mMeasuredWidth }) }
}, Number(process.env.INSPECT) * 1000)
setTimeout(() => { console.log(`after ${seconds}s: ${frames} frames | missing:`, [...vm.missing].slice(0, 40).join(' ')); process.exit(0) }, seconds * 1000)
