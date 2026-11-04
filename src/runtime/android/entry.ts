// the android runtime inside a converted dpk's sandbox (built as runtime/android-runtime.js).
// reads the original apk files from apk/, runs the activity's dex code, loads armeabi-v7a libraries.
import { parseDex } from './dex.ts'
import { parseArsc } from './arsc.ts'
import { VM } from './dalvik.ts'
import { registerJava, jstr } from './java.ts'
import { registerAndroid } from './android.ts'
import { Vfs, registerJavaIo } from './javaio.ts'
import { registerReflect } from './reflect.ts'
import { Native } from './arm/native.ts'

declare const droid: any
interface Map_ { pkg: string; activities: Record<string, string>; libs: string[]; receivers?: { cls: string; actions: string[] }[]; services?: string[] }

// same renaming as convert.ts (dpk paths are lowercase)
const norm = (p: string) => p.toLowerCase().replace(/[^a-z0-9/._-]/g, '_')
async function bytes(path: string) { return new Uint8Array(await (await fetch(path)).arrayBuffer()) }

droid.on('create', async (saved: any) => {
  const root = document.getElementById('app')!
  try {
    const map: Map_ = await (await fetch('apk-map.json')).json()
    const info = droid.app.info()
    const cls = map.activities[info.activity]
    const files = new Map<string, Uint8Array>()
    const list: string[] = await (await fetch('apk-files.json')).json()
    await Promise.all(list.filter((p) => /^(res\/|resources\.arsc|classes\d*\.dex)/.test(p)).map(async (p) => files.set(p, await bytes('apk/' + norm(p)))))
    // preload prefs so SharedPreferences can be synchronous
    const prefs = new Map<string, any>()
    for (const k of await droid.prefs.keys()) if (k.startsWith('sp:')) prefs.set(k, await droid.prefs.get(k))
    const dev = await droid.device.info()
    const vm = new VM()
    registerJava(vm)
    const vfs = new Vfs()
    registerJavaIo(vm, vfs)
    registerReflect(vm)
    const env = {
      vfs,
      pkg: map.pkg, files, res: parseArsc(files.get('resources.arsc')!), root, droid, prefs,
      density: dev.density, landscape: dev.orientation === 'landscape', lang: (dev.locale || 'en').slice(0, 2),
      intent: info.intent || {}, self: info.activity,
      activityFor: (c: string) => Object.entries(map.activities).find(([, v]) => v === c)?.[0] || null,
    }
    const app = registerAndroid(vm, env)
    for (const [p, b] of files) if (/^classes\d*\.dex$/.test(p)) vm.addDex(parseDex(b))
    // native libraries load when java calls System.loadLibrary
    let native: Native | null = null
    vm.shims.get('Ljava/lang/System;')!.methods!['loadLibrary(Ljava/lang/String;)V'] = (v, s, [name]) => { throw new Error('loadLibrary before runtime start: ' + name) }
    const sys = vm.cls('Ljava/lang/System;')
    sys.methods.get('loadLibrary(Ljava/lang/String;)V')!.native = () => {}
    const parts = (map as any).original | 0
    if (parts) {
      const chunks = await Promise.all(Array.from({ length: parts }, (_, i) => bytes(`original/apk.${i}`)))
      const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
      let o = 0
      for (const c of chunks) { all.set(c, o); o += c.length }
      vfs.write(`/data/app/${map.pkg}-1.apk`, all)
    }
    const libBytes = new Map<string, Uint8Array>()
    for (const l of map.libs) libBytes.set(l.split('/').pop()!, await bytes('apk/' + norm(l)))
    sys.methods.get('loadLibrary(Ljava/lang/String;)V')!.native = (v, s, [name]) => {
      const file = `lib${name}.so`
      const b = libBytes.get(file)
      if (!b) throw vm.error('Ljava/lang/UnsatisfiedLinkError;', `dlopen failed: library "${file}" not found (only armeabi-v7a libraries run in Droid)`)
      native ||= new Native(vm, vfs)
      native.load(file, b)
    }
    vm.natives = (m, self, args) => {
      if (!native) throw vm.error('Ljava/lang/UnsatisfiedLinkError;', `no native library loaded for ${m.cls.name}->${m.key}`)
      return native.call(m, self, args)
    }
    // background host (alarms, receivers, services): no activity, jobs arrive as intents
    if (info.activity === '__bg') {
      droid.on('intent', (i: any) => { if (i?.action === 'background-job') { app.background(i.extras.job, (map as any).receivers || []); droid.background.idle() } })
      droid.background.idle()
      return
    }
    app.start(cls, saved?.bundle)
    const missing = [...vm.missing, ...((native as Native | null)?.missing || [])]
    if (missing.length) console.warn('droid android runtime: missing pieces', missing)
    droid.on('pause', () => { app.lifecycle('pause'); return { bundle: app.save() } })
    droid.on('resume', () => app.lifecycle('resume'))
    droid.on('stop', () => app.lifecycle('stop'))
    droid.on('destroy', () => app.lifecycle('destroy'))
    droid.on('back', () => { app.back(); return true })
    droid.on('menu', (e: any) => { if (e?.id != null) app.menu(e.id) })
    ;(window as any).__androidReport = () => ({ missing, dalvikSteps: vm.steps, armSteps: native?.cpu.steps || 0 })
  } catch (e: any) {
    root.innerHTML = ''
    const msg = e?.obj ? 'java exception' : String(e?.message || e)
    const where = e?.jstack || e?.obj?.f?.jstack || []
    console.error('android runtime failed: ' + String(e?.message || e) + (where.length ? ' | at ' + where.join(' < ') : ' | (no java stack)'))
    droid.dialog({ title: 'Unfortunately, the app has stopped.', message: msg + (e?.obj ? ': ' + jstr(new VM(), e.obj.f.message ?? '') : '') })
  }
})
