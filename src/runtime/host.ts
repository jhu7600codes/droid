// hosts one activity of an installed dpk: the holo action bar the shell draws, and the app's
// sandboxed iframe (see docs/decisions.md, "sandbox"). talks to the app over a MessagePort.
import type { Activity, ActivityContext } from '../shell/types'
import { kernel } from '../shell/kernel'
import { appStyles } from '../shell/density'
import { h, pressable } from '../shell/ui'
import { screenEl } from '../shell/layers'
import * as store from './db'
import { getPackage, mimeOf } from './packages'
import { makeBridge } from './bridge'
import { ime, imeEnabled, type ImeTarget } from '../shell/ime'
import sdkSource from '../sdk/droid.js?raw'

const CSP = (shell: string) => [
  "default-src 'none'",
  "script-src blob: 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'",
  `style-src blob: data: 'unsafe-inline' ${shell}`,
  `img-src blob: data: ${shell}`,
  `font-src blob: data: ${shell}`,
  'media-src blob: data:',
  'connect-src blob: data:',
  'worker-src blob:',
  "frame-src 'none'",
  "form-action 'none'",
].join('; ')

export interface Host {
  send(ev: string, data?: unknown): void
  ask(ev: string, data?: unknown, timeout?: number): Promise<unknown>
  actionbar: { title(t: string): void; menu(items: MenuItem[]): void; visible(v: boolean): void }
  iframe: HTMLIFrameElement
}
export interface MenuItem { id: string; title: string; icon?: string; always?: boolean }

let runtimeCache: Promise<ArrayBuffer | null> | null = null
const currentRuntime = () => (runtimeCache ||= fetch('runtime/android-runtime.js').then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null))

export function hostActivity(pkg: string, ctx: ActivityContext): Activity {
  const app = kernel.get(pkg)!
  const m = app.manifest
  // '__bg' is the hidden background host (receivers, services, alarms): same page as the main activity
  const decl = m.activities[ctx.name] || m.activities[m.main]
  const dark = m.theme !== 'holo-light'
  const theme = dark ? 'holo-dark' : 'holo-light'

  // action bar
  const title = h('span.h-ab-title', {}, decl.label || m.name)
  const iconEl = h('img', { src: app.icon })
  const home = h('span.h-ab-item.h-ab-home', {}, iconEl, title)
  const actions = h('span.ab-actions', { style: { display: 'flex', height: '100%' } })
  const bar = h('div.h-actionbar', {}, home, h('span', { style: { flex: '1' } }), actions)
  const frame = document.createElement('iframe')
  // allow-scripts without allow-same-origin: the app gets an opaque origin, it cannot reach the shell
  frame.setAttribute('sandbox', 'allow-scripts allow-modals allow-downloads allow-pointer-lock')
  frame.setAttribute('allow', 'camera *; microphone *; geolocation *; fullscreen *; autoplay *; gamepad *; clipboard-write *')
  frame.className = 'dpk-frame'
  const wrap = h(`div.dpk.${theme}`, {}, bar, frame)
  ctx.root.append(wrap)

  let port: MessagePort | null = null
  let replyId = 1
  const replies = new Map<number, (v: unknown) => void>()
  let menuItems: MenuItem[] = []
  const queue: unknown[] = []
  let ready = false

  const post = (msg: unknown) => (ready && port ? port.postMessage(msg) : queue.push(msg))
  const host: Host = {
    iframe: frame,
    send: (ev, data) => post({ ev, data }),
    ask: (ev, data, timeout = 400) => new Promise((ok) => {
      const id = replyId++
      replies.set(id, ok)
      post({ ev, data, reply: id })
      setTimeout(() => { if (replies.delete(id)) ok(undefined) }, timeout)
    }),
    actionbar: {
      title: (t) => { title.textContent = t; ctx.setTitle(t) },
      visible: (v) => (bar.style.display = v ? '' : 'none'),
      menu: (items) => {
        menuItems = items
        actions.innerHTML = ''
        const shown = items.filter((i) => i.always && i.icon).slice(0, 2)
        for (const it of shown) {
          const b = pressable(h('span.h-ab-item', { title: it.title }, h('img', { src: it.icon })))
          b.addEventListener('click', () => host.send('menu', { id: it.id }))
          actions.append(b)
        }
        if (items.length > shown.length) {
          const o = pressable(h('span.h-ab-item', {}, h('i.h-ab-overflow')))
          o.addEventListener('click', () => overflow())
          actions.append(o)
        }
      },
    },
  }
  function overflow() {
    const items = menuItems.filter((i) => !(i.always && i.icon))
    const menu = h('div.h-menu.ab-menu')
    const close = () => { scrim.remove(); document.removeEventListener('droid:back', back, true) }
    const back = (e: Event) => { e.preventDefault(); e.stopImmediatePropagation(); close() }
    for (const it of items) {
      const row = pressable(h('span', {}, it.title))
      row.addEventListener('click', () => { close(); host.send('menu', { id: it.id }) })
      menu.append(row)
    }
    const scrim = h('div.ab-menu-scrim', { onclick: (e: Event) => { if (e.target === scrim) close() } }, menu)
    wrap.append(scrim)
    document.addEventListener('droid:back', back, true)
  }

  const bridge = makeBridge(pkg, ctx, host)

  async function boot() {
    const rec = await getPackage(pkg)
    if (!rec) return
    const files: Record<string, { bytes: ArrayBuffer; type: string }> = {}
    const transfer: ArrayBuffer[] = []
    for (const p of rec.files) {
      const blob = await store.get<Blob>('files', `app:${pkg}:${p}`)
      if (!blob) continue
      const bytes = await blob.arrayBuffer()
      files[p] = { bytes, type: blob.type || mimeOf(p) }
      transfer.push(bytes)
    }
    // converted apks always run the shell's current android runtime, so runtime fixes reach apps
    // that were converted before them (no reinstall needed)
    if (m.type === 'converted' && files['runtime/android-runtime.js']) {
      const fresh = await currentRuntime()
      if (fresh) { files['runtime/android-runtime.js'] = { bytes: fresh.slice(0), type: 'text/javascript' }; transfer.push(files['runtime/android-runtime.js'].bytes) }
    }
    let imeTarget: ImeTarget | null = null
    let imeBefore = ''
    const shellAssets = new URL('assets/', document.baseURI).href
    const ch = new MessageChannel()
    port = ch.port1
    port.onmessage = async (e) => {
      const msg = e.data
      if (msg.ready) { ready = true; queue.splice(0).forEach((q) => port!.postMessage(q)); return }
      if (msg.reply) { replies.get(msg.reply)?.(msg.value); replies.delete(msg.reply); return }
      // droid keyboard for the app's text fields: keys go back as "ime" events
      if (msg.call === 'ime.show' || msg.call === 'ime.hide') {
        if (msg.call === 'ime.hide') { if (imeTarget) ime.close(imeTarget); imeTarget = null }
        else if (imeEnabled()) {
          const o = msg.args?.[0] || {}
          imeTarget = { kind: o.kind || 'text', enter: o.enter || 'enter', multiline: !!o.multiline, autocap: !!o.autocap, key: (k) => host.send('ime', k), before: () => imeBefore }
          ime.open(imeTarget)
        }
        port!.postMessage({ id: msg.id, value: imeEnabled() })
        return
      }
      if (msg.call === 'ime.text') { imeBefore = String(msg.args?.[0] ?? ''); ime.changed(); port!.postMessage({ id: msg.id, value: null }); return }
      if (msg.call) {
        try { port!.postMessage({ id: msg.id, value: await bridge(msg.call, msg.args || []) }) }
        catch (err) {
          const code = (err as any)?.code || 'invalid'
          port!.postMessage({ id: msg.id, error: { code, message: (err as Error)?.message || String(err) } })
        }
      }
    }
    const bucket = document.documentElement.dataset.density as any
    const info = { id: pkg, name: m.name, version: m.version, versioncode: m.versioncode, activity: ctx.name, intent: ctx.intent }
    frame.contentWindow!.postMessage({
      type: 'droid:boot', entry: decl.entry, files, info, theme, saved: savedState,
      csp: CSP(shellAssets), links: appStyles(bucket), ime: imeEnabled(),
    }, '*', [ch.port2, ...transfer])
  }
  // the bootstrap page: csp + the sdk, which waits for the boot message
  frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP(new URL('assets/', document.baseURI).href)}"><script>${sdkSource.replace(/<\/script/gi, '<\\/script')}</script></head><body style="background:${dark ? '#000' : '#f3f3f3'}"></body></html>`
  frame.addEventListener('load', () => { if (!port) boot() }, { once: true })

  let savedState: unknown = null
  try { savedState = JSON.parse(sessionStorage.getItem(`droid.saved.${pkg}.${ctx.name}`) || 'null') } catch { /* none */ }

  const landscape = () => screenEl.dataset.orientation === 'landscape'
  const applyOrientation = () => {
    // locked orientation the other way round: rotate the app's view with css (spec section 20)
    const want = m.orientation
    const rotate = (want === 'portrait' && landscape()) || (want === 'landscape' && !landscape())
    if (rotate) {
      const w = ctx.root.clientWidth, hh = ctx.root.clientHeight
      wrap.style.cssText = `inset:auto;left:0;top:0;width:${hh}px;height:${w}px;transform:translateX(${w}px) rotate(90deg);transform-origin:0 0`
    } else wrap.style.cssText = ''
  }
  requestAnimationFrame(applyOrientation)

  return {
    start: () => host.send('start'),
    resume: () => host.send('resume'),
    pause() {
      // the app may hand back a saved state (json, 64 kb max)
      host.ask('pause').then((v) => {
        if (v == null) return
        const s = JSON.stringify(v)
        if (s.length <= 64 * 1024) { savedState = v; try { sessionStorage.setItem(`droid.saved.${pkg}.${ctx.name}`, s) } catch { /* full */ } }
      })
      return undefined
    },
    stop: () => host.send('stop'),
    destroy() { host.send('destroy'); bridge.dispose?.(); try { sessionStorage.removeItem(`droid.saved.${pkg}.${ctx.name}`) } catch { /* ignore */ } },
    back() {
      host.ask('back', undefined, 300).then((handled) => { if (!handled) ctx.finish() })
      return true
    },
    menu() { if (menuItems.length) overflow(); else host.send('menu', { id: null }) },
    intent: (i) => host.send('intent', i),
    result: (id, r) => host.send('result', { id, ...r }),
    configchange() { applyOrientation(); host.send('configchange', bridge.deviceInfo()) },
  }
}

