// the sdk bridge, shell side. every call from an app lands here and is checked against the
// permissions the app declared and the user granted (spec sections 7, 8, 9).
import type { ActivityContext, Intent } from '../shell/types'
import { kernel } from '../shell/kernel'
import { wm } from '../shell/wm'
import { toast, dialog, progress, type DialogOptions } from '../shell/ui'
import { notifications } from '../shell/notify'
import { settings } from '../shell/settings'
import { screenEl } from '../shell/layers'
import { state as netState } from '../shell/net'
import { DpkError, permName, LIMITS } from './manifest'
import * as store from './db'
import { getPackage, setGrant, mimeOf } from './packages'
import { proxiedFetch } from './netclient'
import type { Host } from './host'

const PERM_TEXT: Record<string, string> = {
  network: 'connect to the internet',
  storage: 'read and write shared storage',
  notifications: 'post notifications',
  vibrate: 'control vibration',
  clipboard: 'read the clipboard',
  camera: 'take pictures and videos',
  microphone: 'record audio',
  location: 'access your location',
  fullscreen: 'hide the status and navigation bars',
  'background-audio': 'play audio in the background',
  danen: 'use your Danen account',
}
export const permissionText = (p: string) => PERM_TEXT[p] || p

const err = (code: string, msg?: string) => new DpkError(code, msg || code)

// framework.dex and framework-res.apk (built by tools/aosp/build.py), fetched once per page
let aosp: Promise<{ dex: ArrayBuffer; res: ArrayBuffer } | null> | null = null
const aospFiles = () => (aosp ||= Promise.all(['runtime/aosp/framework.dex', 'runtime/aosp/framework-res.apk'].map((u) => fetch(u).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(u)))))).then(([dex, res]) => ({ dex, res })).catch(() => { aosp = null; return null }))

// asks once per app and permission, remembers the answer (holo dialog)
export async function ensure(pkg: string, perm: string) {
  const app = kernel.get(pkg)
  const declared = (app?.manifest.permissions || []).map(permName)
  if (!declared.includes(perm)) throw err('denied', `${perm} is not in the manifest`)
  const rec = await getPackage(pkg)
  const g = rec?.grants[perm]
  // internet is a normal permission on android: declared means granted, no question
  if (g === 'granted' || perm === 'network') return
  if (g === 'denied') throw err('denied', `${perm} was denied`)
  const r = await dialog({
    title: app!.manifest.name,
    message: `Allow ${app!.manifest.name} to ${permissionText(perm)}?`,
    cancel: 'Deny', ok: 'Allow', cancelable: false,
  })
  await setGrant(pkg, perm, r.button === 'ok' ? 'granted' : 'denied')
  if (r.button !== 'ok') throw err('denied', `${perm} was denied`)
}

// "network" can carry a hosts list (spec section 18)
function allowedHost(pkg: string, url: string) {
  const p = kernel.get(pkg)?.manifest.permissions?.find((x) => permName(x) === 'network')
  const hosts = typeof p === 'object' ? p.hosts : undefined
  if (!hosts?.length) return true
  const host = new URL(url).hostname
  return hosts.some((hh) => hh === host || (hh.startsWith('*.') && host.endsWith(hh.slice(1))))
}

const cleanPath = (p: string) => {
  p = String(p || '').replace(/^\/+/, '')
  if (p.split('/').some((s) => s === '..' || s === '.')) throw err('invalid', 'bad path')
  return p
}

export function makeBridge(pkg: string, ctx: ActivityContext, host: Host) {
  const sockets = new Map<number, WebSocket>()
  let sockId = 1
  let wake: any = null
  const scopeKey = async (scope: string, path: string) => {
    if (scope === 'shared') { await ensure(pkg, 'storage'); return `shared:${cleanPath(path)}` }
    if (scope === 'package') return `app:${pkg}:${cleanPath(path)}`
    return `pkg:${pkg}:${cleanPath(path)}`
  }
  const deviceInfo = () => {
    const w = (ctx.root.clientWidth || 0), hgt = (ctx.root.clientHeight || 0)
    const dpi = Math.round((window.devicePixelRatio || 1) * 160)
    return {
      width: w, height: hgt, widthPx: Math.round(w * dpi / 160), heightPx: Math.round(hgt * dpi / 160),
      density: dpi / 160, dpi, bucket: document.documentElement.dataset.density,
      orientation: screenEl.dataset.orientation, mode: screenEl.dataset.form, api: 19, release: '4.4',
      locale: settings.get('locale'), renderScale: settings.get('screen.renderScale'),
    }
  }

  const api: Record<string, (...a: any[]) => unknown> = {
    'app.finish': (code?: number, data?: unknown) => ctx.finish(code != null ? { code, data } : undefined),
    'intent.start': (i: Intent) => { checkExtras(i); ctx.start(i) },
    'intent.startforresult': (i: Intent) => { checkExtras(i); return ctx.startForResult(i) },
    'intent.setresult': (code: number, data?: unknown) => ctx.setResult({ code, data }),
    // a link to another html file of the package opens the activity with that entry
    'intent.startpath': (path: string) => {
      const m = kernel.get(pkg)!.manifest
      const act = Object.entries(m.activities).find(([, a]) => a.entry === path)
      if (!act) throw err('notfound', path)
      ctx.start({ package: pkg, activity: act[0] })
    },
    'ui.toast': (text: string, d: 'short' | 'long') => toast(String(text).slice(0, 500), d),
    'ui.dialog': (o: DialogOptions) => dialog({ ...o, body: undefined, theme: kernel.get(pkg)?.manifest.theme === 'holo-light' ? 'light' : 'dark' }),
    'ui.actionbar': (o: { title?: string; menu?: any[]; visible?: boolean }) => {
      if (o.title != null) host.actionbar.title(String(o.title))
      if (o.menu) host.actionbar.menu(o.menu.map((x) => ({ id: String(x.id), title: String(x.title), icon: x.icon, always: !!x.always })))
      if (o.visible != null) host.actionbar.visible(!!o.visible)
    },
    'ui.progress': (() => { let close: (() => void) | null = null; return (show: boolean, text?: string) => { close?.(); close = show ? progress(text || 'Loading…') : null } })(),

    'prefs.get': (k: string) => store.get('kv', `${pkg}:${k}`),
    'prefs.set': (k: string, v: unknown) => {
      if (JSON.stringify(v ?? null).length > 1024 * 1024) throw err('toolarge')
      return store.put('kv', `${pkg}:${k}`, v)
    },
    'prefs.remove': (k: string) => store.del('kv', `${pkg}:${k}`),
    'prefs.keys': async () => (await store.keys('kv', `${pkg}:`)).map((k) => k.slice(pkg.length + 1)),

    'files.read': async (path: string, scope: string, as: 'text' | 'bytes' | 'url') => {
      const b = await store.get<Blob>('files', await scopeKey(scope, path))
      if (!b) throw err('notfound', path)
      if (as === 'bytes') return new Uint8Array(await b.arrayBuffer())
      if (as === 'url') return 'data:' + b.type + ';base64,' + btoa(String.fromCharCode(...new Uint8Array(await b.arrayBuffer())))
      return b.text()
    },
    'files.write': async (path: string, data: unknown, scope: string, type?: string) => {
      if (scope === 'package') throw err('denied', 'package files are read only')
      const blob = data instanceof Blob ? data : new Blob([data as BlobPart], { type: type || mimeOf(path) })
      if (blob.size > LIMITS.file) throw err('toolarge')
      await store.put('files', await scopeKey(scope, path), blob)
    },
    'files.list': async (dir: string, scope: string) => {
      const prefix = await scopeKey(scope, dir ? dir.replace(/\/?$/, '/') : '')
      return (await store.keys('files', prefix)).map((k) => k.slice(prefix.length))
    },
    'files.delete': async (path: string, scope: string) => {
      if (scope === 'package') throw err('denied')
      await store.del('files', await scopeKey(scope, path))
    },

    'system.vibrate': async (p: number | number[]) => { await ensure(pkg, 'vibrate'); navigator.vibrate?.(p) },
    'system.clipboard.read': async () => { await ensure(pkg, 'clipboard'); return navigator.clipboard?.readText().catch(() => { throw err('unsupported') }) },
    'system.clipboard.write': async (t: string) => { await navigator.clipboard?.writeText(t).catch(() => { throw err('unsupported') }) },
    'system.notify': async (n: { id?: string; title: string; text?: string; ticker?: string; ongoing?: boolean; progress?: number; activity?: string; extras?: Record<string, unknown> }) => {
      await ensure(pkg, 'notifications')
      const app = kernel.get(pkg)!
      // tapping opens the app, or one of its own activities with extras (android PendingIntent)
      const act = n.activity && app.manifest.activities[n.activity] ? n.activity : undefined
      if (n.extras && JSON.stringify(n.extras).length > LIMITS.extras) throw err('toolarge')
      notifications.post({ id: String(n.id ?? 'default'), pkg, title: String(n.title).slice(0, 200), text: n.text ? String(n.text).slice(0, 1000) : undefined, ticker: n.ticker ? String(n.ticker).slice(0, 300) : undefined, icon: app.icon, ongoing: !!n.ongoing, progress: n.progress,
        onclick: () => wm.start(act ? { package: pkg, action: 'notification', activity: act, extras: n.extras } : { package: pkg, action: 'main' }) })
    },
    // background work (alarms, broadcasts, services): handled by runtime/background.ts
    'bg.alarm.set': async (a: any) => (await import('./background')).setAlarm(pkg, a),
    'bg.alarm.cancel': async (id: string) => (await import('./background')).cancelAlarm(pkg, String(id)),
    'bg.run': async (job: any) => (await import('./background')).runInBackground(pkg, job),
    'bg.idle': async () => (await import('./background')).idle(pkg),
    'system.cancel': (id: string) => notifications.cancel(pkg, String(id ?? 'default')),
    'system.orientation': (o: string) => { if (['portrait', 'landscape', 'any'].includes(o)) (kernel.get(pkg)!.manifest.orientation = o as any); host.send('configchange', deviceInfo()) },
    'system.keepawake': async (on: boolean) => {
      if (on && !wake) wake = await (navigator as any).wakeLock?.request('screen').catch(() => null)
      if (!on && wake) { wake.release(); wake = null }
    },
    'ui.statusbar': (visible: boolean) => { host.iframe.closest('.window')?.classList.toggle('no-statusbar', !visible); wm.bars() },
    'system.fullscreen': async (on: boolean) => { await ensure(pkg, 'fullscreen'); screenEl.classList.toggle('immersive', on) },
    'device.info': deviceInfo,
    // the real android framework for converted apps (developer option), null when it is off
    'runtime.aosp': async () => (settings.get('android.aosp') ? aospFiles() : null),

    'net.state': () => netState(),
    'net.fetch': async (url: string, init: { method: string; headers: Record<string, string>; body?: ArrayBuffer | string }) => {
      await ensure(pkg, 'network')
      if (!/^https?:/i.test(url)) throw err('invalid', 'only http and https')
      if (!allowedHost(pkg, url)) throw err('denied', 'host not allowed by the manifest')
      if (!navigator.onLine) throw err('offline')
      const r = await proxiedFetch(pkg, url, init)
      const body = await r.arrayBuffer()
      const headers: Record<string, string> = {}
      r.headers.forEach((v, k) => (headers[k] = v))
      return { status: r.status, statusText: r.statusText, headers, body }
    },
    'net.ws.open': async (url: string, protocols: string[]) => {
      await ensure(pkg, 'network')
      if (!/^wss?:/i.test(url)) throw err('invalid', 'only ws and wss')
      if (!allowedHost(pkg, url.replace(/^ws/, 'http'))) throw err('denied')
      const id = sockId++
      const ws = new WebSocket(url, protocols)
      ws.binaryType = 'arraybuffer'
      ws.onopen = () => host.send('ws', { id, type: 'open' })
      ws.onmessage = (e) => host.send('ws', { id, type: 'message', data: e.data })
      ws.onclose = (e) => { host.send('ws', { id, type: 'close', code: e.code, reason: e.reason }); sockets.delete(id) }
      ws.onerror = () => host.send('ws', { id, type: 'error' })
      sockets.set(id, ws)
      return id
    },
    'net.ws.send': (id: number, d: unknown) => sockets.get(id)?.send(d as any),
    'net.ws.close': (id: number, c?: number, r?: string) => sockets.get(id)?.close(c, r),

    // danen play services (milestone 6 wires the backend; local account works now)
    'danen.account': async () => {
      await ensure(pkg, 'danen')
      const a = settings.get('danen.account') as any
      return a ? { nickname: a.nickname, username: a.username } : null
    },
    'danen.sync.get': async (k: string) => { await ensure(pkg, 'danen'); return store.get('kv', `danen:${pkg}:${k}`) },
    'danen.sync.set': async (k: string, v: unknown) => { await ensure(pkg, 'danen'); await store.put('kv', `danen:${pkg}:${k}`, v); window.dispatchEvent(new CustomEvent('danen:dirty', { detail: pkg })) },
    // push to your own devices, for this app (e.g. a reminder that also reaches your other devices)
    'danen.push.send': async (title: string, body?: string, data?: unknown) => {
      await ensure(pkg, 'danen'); await ensure(pkg, 'notifications')
      const { danenApi } = await import('../shell/danen-remote')
      return danenApi.push(pkg, String(title), String(body ?? ''), data)
    },
    'danen.push.subscribe': async () => { await ensure(pkg, 'danen'); await ensure(pkg, 'notifications'); return (await import('../shell/push')).subscribe(pkg) },
  }

  function checkExtras(i: Intent) {
    if (i.extras && JSON.stringify(i.extras).length > LIMITS.extras) throw err('toolarge', 'extras are bigger than 256 kb')
  }

  const call = async (name: string, args: unknown[]) => {
    const fn = api[name]
    if (!fn) throw err('unsupported', name)
    return fn(...args)
  }
  call.dispose = () => { sockets.forEach((s) => s.close()); wake?.release?.() }
  call.deviceInfo = deviceInfo
  return call
}
