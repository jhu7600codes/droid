// starts a converted app on the real android 4.4 framework (Settings > Developer options >
// Real Android framework): framework.dex + framework-res.apk from the shell, the app's original
// files, droid's java system services (tools/aosp/system) and android's own ActivityThread.
// every window android draws is shown on a canvas; touches and the back key go back in.
import { VM } from '../dalvik.ts'
import { registerJava, jstr } from '../java.ts'
import { Vfs, registerJavaIo } from '../javaio.ts'
import { registerReflect } from '../reflect.ts'
import { registerConcurrent } from '../concurrent.ts'
import { registerCollections } from '../collections.ts'
import { parseDex } from '../dex.ts'
import { listZip, readEntry } from '../../zip.ts'
import { Native } from '../arm/native.ts'
import { registerAospNatives } from './natives.ts'
import { registerAospSystem } from './system.ts'
import { apks, device } from './res.ts'

// libraries the framework itself loads: their natives are droid's own
const SYSTEM_LIBS = new Set(['rs_jni', 'RS', 'media_jni', 'exif_jni', 'jnigraphics', 'android_runtime', 'android', 'webviewchromium', 'webviewchromium_loader', 'webcore', 'chromium_net', 'javacore', 'nativehelper', 'icu_jni', 'mtp', 'soundpool', 'camera2_jni'])

export async function startAosp(o: { droid: any; root: HTMLElement; pkg: string; files: Map<string, Uint8Array>; apk: Uint8Array | null; fw: { dex: ArrayBuffer; res: ArrayBuffer }; activity?: string }) {
  const { droid, root, files } = o
  const vm = new VM()
  const vfs = new Vfs()
  registerJava(vm); registerCollections(vm); registerJavaIo(vm, vfs); registerReflect(vm); registerConcurrent(vm)

  // the screen in device pixels; density from the display (2x -> xhdpi)
  const dpr = Math.max(1, Math.round((globalThis.devicePixelRatio || 1) * 2) / 2)
  const screen = () => ({ w: Math.max(1, Math.round(root.clientWidth * dpr)), h: Math.max(1, Math.round(root.clientHeight * dpr)), dpi: Math.round(160 * dpr) })
  const s0 = screen()
  Object.assign(device, { density: s0.dpi, widthDp: Math.round(s0.w / dpr), heightDp: Math.round(s0.h / dpr) })

  // pictures arriving after a frame was drawn: draw the windows again
  let redrawTimer = 0
  const redraw = () => {
    if (redrawTimer) return
    redrawTimer = setTimeout(() => {
      redrawTimer = 0
      try {
        const g = vm.callStatic('Landroid/view/WindowManagerGlobal;', 'getInstance()Landroid/view/WindowManagerGlobal;') as any
        for (const r of (g?.f.mRoots?.f.a ?? [])) vm.callVirtual(r, 'invalidate()V')
      } catch (e) { console.warn('redraw', e) }
    }, 30) as unknown as number
  }
  const { gfx } = registerAospNatives(vm, { vfs, redraw })

  const unzip = async (buf: ArrayBuffer) => { const m = new Map<string, Uint8Array>(); for (const e of listZip(buf)) m.set(e.path, await readEntry(buf, e)); return m }
  apks.set('/system/framework/framework-res.apk', await unzip(o.fw.res))
  const apkPath = `/data/app/${o.pkg}-1.apk`
  apks.set(apkPath, files)
  vfs.write(apkPath, o.apk ?? new Uint8Array([0x50, 0x4b]))
  vm.addDex(parseDex(new Uint8Array(o.fw.dex)))
  for (const [p, b] of files) if (/^classes\d*\.dex$/.test(p)) vm.addDex(parseDex(b))

  // the app's own native libraries run on droid's arm runtime
  let native: Native | null = null
  vm.cls('Ljava/lang/System;').methods.get('loadLibrary(Ljava/lang/String;)V')!.native = (v, s, [name]) => {
    const n = jstr(vm, name), file = `lib${n}.so`
    const b = files.get('lib/armeabi-v7a/' + file) ?? files.get('lib/armeabi/' + file)
    if (!b && SYSTEM_LIBS.has(n)) return
    if (!b) throw vm.error('Ljava/lang/UnsatisfiedLinkError;', `dlopen failed: library "${file}" not found (only armeabi-v7a libraries run in Droid)`)
    native ||= new Native(vm, vfs, o.pkg)
    native.load(file, b)
  }
  vm.natives = (m, self, args) => {
    if (!native) throw vm.error('Ljava/lang/UnsatisfiedLinkError;', `No implementation found for ${m.cls.name}->${m.key}`)
    return native.call(m, self, args)
  }

  // windows: a canvas each, at its frame
  root.innerHTML = ''
  root.style.cssText += ';position:relative;overflow:hidden;touch-action:none;background:#000'
  const shown = new Map<number, HTMLCanvasElement>()
  const sys = registerAospSystem(vm, gfx, {
    pkg: o.pkg, apkPath, launchActivity: o.activity, screen,
    present: (id, bmp, f) => {
      let c = shown.get(id)
      if (!c) { c = document.createElement('canvas'); c.style.cssText = 'position:absolute;pointer-events:none'; shown.set(id, c); root.append(c) }
      if (c.width !== bmp.w || c.height !== bmp.h) { c.width = bmp.w; c.height = bmp.h }
      Object.assign(c.style, { left: f[0] / dpr + 'px', top: f[1] / dpr + 'px', width: bmp.w / dpr + 'px', height: bmp.h / dpr + 'px' })
      const ctx = c.getContext('2d')!
      ctx.clearRect(0, 0, c.width, c.height)
      if (bmp.canvas) ctx.drawImage(bmp.canvas as CanvasImageSource, 0, 0)
    },
    windowGone: (id) => { shown.get(id)?.remove(); shown.delete(id) },
    event: (what) => { if (what === 'finished') droid.app.finish() },
  })
  droid.actionbar?.hide?.()

  // touches: device pixels, down time kept per gesture
  let downAt = 0, down = false
  const at = (e: PointerEvent) => { const r = root.getBoundingClientRect(); return [(e.clientX - r.left) * dpr, (e.clientY - r.top) * dpr] }
  root.addEventListener('pointerdown', (e) => { root.setPointerCapture?.(e.pointerId); down = true; downAt = performance.now(); const [x, y] = at(e); sys.touch(0, x, y, downAt) })
  root.addEventListener('pointermove', (e) => { if (!down) return; const [x, y] = at(e); sys.touch(2, x, y, downAt) })
  root.addEventListener('pointerup', (e) => { if (!down) return; down = false; const [x, y] = at(e); sys.touch(1, x, y, downAt) })
  root.addEventListener('pointercancel', (e) => { if (!down) return; down = false; const [x, y] = at(e); sys.touch(3, x, y, downAt) })
  droid.on('back', () => { sys.key(0, 4); sys.key(1, 4); return true })
  droid.on('menu', () => { sys.key(0, 82); sys.key(1, 82) })

  // android's main thread: droid's system services, then ActivityThread.main
  const boot = vm.findMethod(vm.cls('Ldroid/system/Boot;'), 'main([Ljava/lang/String;)V')!
  const t = vm.startThread('main', boot, null, [vm.newArray('[Ljava/lang/String;', 0)])
  vm.main = t
  t.onDone = (e: any) => {
    if (!e) return
    const o2 = e?.obj
    const msg = o2 ? `${o2.cls.name.slice(1, -1).replace(/\//g, '.')}: ${jstr(vm, o2.f.message ?? '')}` : String(e?.message || e)
    console.error('android main thread died:', msg, (o2?.f.jstack || []).join(' < '))
    droid.dialog({ title: 'Unfortunately, the app has stopped.', message: msg })
  }
  ;(window as any).__androidReport = () => ({ aosp: true, missing: [...vm.missing], dalvikSteps: vm.steps })
}
