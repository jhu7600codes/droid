// browser (role: browser), rebuilt after the aosp kitkat browser: title bar with the url field,
// stop / refresh, tabs, overflow menu, thin progress bar, tab switcher, bookmarks / history / saved pages,
// incognito tabs, find on page, desktop site. pages load through the droid proxy (spec section 16/18);
// without a proxy it frames the site directly and offers a real tab when the site refuses.
import type { SystemApp, ActivityContext, Activity } from '../../shell/types'
import { h, pressable, dialog, toast } from '../../shell/ui'
import { img } from '../../shell/assets'
import { settings } from '../../shell/settings'
import { proxyConfig, ensureProxyToken } from '../../runtime/netclient'
import './browser.css'

const B = 'apps/browser'
const KEY = 'droid.browser'
interface Entry { url: string; title: string; time: number }
interface Tab { id: number; url: string; title: string; icon: string; back: string[]; fwd: string[]; frame: HTMLIFrameElement; sid?: string; incognito: boolean; loading: boolean; error?: string; desktop: boolean }

const store = {
  get<T>(k: string, d: T): T { try { return JSON.parse(localStorage.getItem(`${KEY}.${k}`) || 'null') ?? d } catch { return d } },
  set(k: string, v: unknown) { try { localStorage.setItem(`${KEY}.${k}`, JSON.stringify(v)) } catch { /* full */ } },
}
// public searxng instances, tried in turn when one fails
export const SEARX = ['https://www.isci.si/', 'https://search.lumy.live/', 'https://search.pereira.is/']
// duckduckgo is the default for now (it asks for a human check once). startpage blocks the proxy;
// qwant, dogpile and swisscows are app-style sites that need the proxy's service worker.
export const ENGINES = [
  { id: 'duckduckgo', label: 'DuckDuckGo' },
  { id: 'startpage', label: 'Startpage (blocks the proxy for now)' },
  { id: 'qwant', label: 'Qwant (needs the next proxy update)' },
  { id: 'dogpile', label: 'Dogpile, aggregator (needs the next proxy update)' },
  { id: 'swisscows', label: 'Swisscows (needs the next proxy update)' },
  { id: 'bing', label: 'Bing' },
  { id: 'searxng', label: 'SearXNG, public instances (often refuse proxies)' },
  { id: 'custom', label: 'Custom SearXNG instance' },
]
const searxBase = () => {
  if (settings.get('browser.engine') === 'custom' && settings.get('browser.searx')) return String(settings.get('browser.searx')).replace(/\/?$/, '/')
  return SEARX[(settings.get('browser.searx.i') as number) % SEARX.length || 0]
}
export const SEARCH = (q: string) => {
  const e = settings.get('browser.engine') || 'duckduckgo'
  if (e === 'startpage') return 'https://www.startpage.com/sp/search?query=' + encodeURIComponent(q)
  if (e === 'dogpile') return 'https://www.dogpile.com/serp?q=' + encodeURIComponent(q)
  if (e === 'qwant') return 'https://www.qwant.com/?q=' + encodeURIComponent(q)
  if (e === 'swisscows') return 'https://swisscows.com/en/web?query=' + encodeURIComponent(q)
  if (e === 'duckduckgo') return 'https://duckduckgo.com/?q=' + encodeURIComponent(q)
  if (e === 'searxng' || e === 'custom') return searxBase() + 'search?q=' + encodeURIComponent(q)
  return 'https://www.bing.com/search?q=' + encodeURIComponent(q)
}
const isSearx = (u: string) => SEARX.some((b) => u.startsWith(b))
const HOME = 'droid:home'

export function normalize(input: string) {
  const s = input.trim()
  if (!s) return HOME
  if (/^(https?:)\/\//i.test(s) || s.startsWith('droid:')) return s
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(s) && !s.includes(' ')) return 'https://' + s
  return SEARCH(s)
}

function browser(ctx: ActivityContext): Activity {
  const tabs: Tab[] = []
  let cur: Tab | null = null
  let nextId = 1

  // title bar
  const favicon = h('img.br-fav', { src: img(B, 'ic_web_holo_dark') }) as HTMLImageElement
  const url = h('input.br-url', { placeholder: 'Search or type URL', autocapitalize: 'none', autocomplete: 'off', spellcheck: false, enterkeyhint: 'go' }) as HTMLInputElement
  const stopReload = pressable(h('span.br-btn', {}, h('img', { src: img(B, 'ic_refresh_holo_dark') })))
  const tabsBtn = pressable(h('span.br-btn.br-tabs', {}, h('img', { src: img(B, 'ic_windows_holo_dark') }), h('span.br-count', {}, '1')))
  const menuBtn = pressable(h('span.br-btn', {}, h('img', { src: img(B, 'ic_menu_overflow') })))
  const progress = h('div.br-progress')
  const bar = h('div.br-bar', {}, favicon, url, stopReload, tabsBtn, menuBtn)
  const pages = h('div.br-pages')
  const hint = h('div.br-hint')
  const findBar = h('div.br-find')
  const root = h('div.app.app-dark.br', {}, bar, progress, findBar, hint, pages)
  ctx.root.append(root)

  const bookmarks = (): Entry[] => store.get('bookmarks', [{ url: 'https://en.wikipedia.org/', title: 'Wikipedia', time: 0 }, { url: 'https://github.com/', title: 'GitHub', time: 0 }])
  const history = (): Entry[] => store.get('history', [])
  const saveTabs = () => store.set('tabs', tabs.filter((t) => !t.incognito).map((t) => ({ url: t.url, title: t.title })))

  // ---------- loading ----------
  async function session(t: Tab) {
    await ensureProxyToken()
    const p = proxyConfig()
    if (!p) return null
    if (t.sid) return t.sid
    const r = await fetch(p.url + '/session', { method: 'POST', headers: { 'x-droid-token': p.token }, body: JSON.stringify({ app: 'droid.browser', tab: String(t.id) + (t.incognito ? '-i' : '') }) })
    if (!r.ok) throw new Error(r.status === 401 ? 'The Droid proxy refused the token. Check Settings > More > Droid proxy.' : 'The Droid proxy is not working.')
    t.sid = (await r.json()).sid
    return t.sid
  }

  async function load(t: Tab, target: string, push = true) {
    if (push && t.url && t.url !== target) { t.back.push(t.url); t.fwd = [] }
    t.url = target
    t.error = undefined
    t.title = target
    if (t === cur) showUrl()
    if (target === HOME) return homePage(t)
    if (!navigator.onLine) return errorPage(t, 'You are offline.')
    setLoading(t, true)
    const p = proxyConfig()
    try {
      if (p) {
        const sid = await session(t)
        const u = new URL(target)
        t.frame.removeAttribute('srcdoc')
        t.frame.src = `${p.url}/p/${sid}/${u.protocol.slice(0, -1)}/${u.host}${u.pathname}${u.search}${u.hash}`
        hint.classList.remove('on')
      } else {
        t.frame.removeAttribute('srcdoc')
        t.frame.src = target
        // no proxy: we can't tell if the site refused to be framed, so say how to get out
        hint.innerHTML = ''
        hint.append(h('span', {}, 'Page blank? This site may refuse to show inside Droid.'), pressable(h('button.h-btn-borderless', { onclick: () => realTab(t.url) }, 'Open in real tab')))
        hint.classList.add('on')
        setTimeout(() => setLoading(t, false), 4000)
      }
    } catch (e) { errorPage(t, (e as Error).message) }
    if (!t.incognito) {
      const hs = history().filter((x) => x.url !== target)
      hs.unshift({ url: target, title: target, time: Date.now() })
      store.set('history', hs.slice(0, 500))
    }
    saveTabs()
  }

  function setLoading(t: Tab, on: boolean) {
    t.loading = on
    if (t !== cur) return
    progress.classList.toggle('on', on)
    stopReload.querySelector('img')!.src = img(B, on ? 'ic_stop_holo_dark' : 'ic_refresh_holo_dark')
  }

  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)
  function errorPage(t: Tab, reason: string) {
    // a public searxng instance is down or refusing: move on to the next one
    if (isSearx(t.url) && !t.url.includes('&droid-retry=' + (SEARX.length - 1))) {
      const n = Number(t.url.match(/&droid-retry=(\d+)/)?.[1] || 0) + 1
      const i = SEARX.findIndex((b) => t.url.startsWith(b))
      settings.set('browser.searx.i', (i + 1) % SEARX.length)
      const q = new URL(t.url).searchParams.get('q') || ''
      load(t, SEARX[(i + 1) % SEARX.length] + 'search?q=' + encodeURIComponent(q) + '&droid-retry=' + n, false)
      return
    }
    setLoading(t, false)
    t.error = reason
    t.title = 'Webpage not available'
    t.frame.removeAttribute('src')
    t.frame.srcdoc = `<!doctype html><meta name=viewport content="width=device-width"><body style="font-family:Roboto,sans-serif;margin:24px;color:#222;background:#fff">
      <h2 style="font-weight:normal">Webpage not available</h2>
      <p>The webpage at <b>${esc(t.url)}</b> might be temporarily down or it may have moved permanently to a new web address.</p>
      <p style="color:#666">${esc(reason)}</p>
      <p style="color:#666">Suggestions:<br>• Make sure you have a data connection<br>• Reload this webpage later<br>• Check the address you entered<br>• Open it in a real browser tab</p></body>`
    if (t === cur) showUrl()
    hint.innerHTML = ''
    hint.append(h('span', {}, 'This page can\'t be shown in Droid.'), pressable(h('button.h-btn-borderless', { onclick: () => realTab(t.url) }, 'Open in real tab')))
    hint.classList.add('on')
  }

  function homePage(t: Tab) {
    setLoading(t, false)
    t.title = 'New tab'
    t.frame.removeAttribute('src')
    const most = [...bookmarks(), ...history()].filter((x, i, a) => a.findIndex((y) => y.url === x.url) === i).slice(0, 9)
    t.frame.srcdoc = `<!doctype html><meta name=viewport content="width=device-width"><body style="font-family:Roboto,sans-serif;margin:0;background:#f3f3f3;color:#222">
      <div style="padding:16px 16px 4px;font-size:14px;font-weight:bold;color:#0099cc;text-transform:uppercase;border-bottom:1px solid #ccc;margin:0 8px">Most visited</div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;padding:12px">${most.map((m) => `<a href="#" data-u="${esc(m.url)}" style="background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.3);padding:12px 8px;font-size:12px;color:#333;text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block;height:64px">${esc(m.title || m.url)}<br><span style="color:#999">${esc(new URL(m.url).hostname)}</span></a>`).join('')}</div>
      <script>document.addEventListener('click',function(e){var a=e.target.closest('a');if(a){e.preventDefault();parent.postMessage({droid:'go',url:a.dataset.u},'*')}})</script></body>`
    if (t === cur) showUrl()
  }

  function realTab(u: string) { window.open(u, '_blank', 'noopener') }

  // ---------- tabs ----------
  function newTab(target = HOME, incognito = false, show = true) {
    const frame = document.createElement('iframe')
    frame.className = 'br-frame'
    // the page runs on the proxy's origin (or its own when direct), never the shell's
    frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-same-origin allow-popups allow-modals allow-downloads')
    frame.setAttribute('allow', 'fullscreen; autoplay; clipboard-write')
    frame.setAttribute('referrerpolicy', 'no-referrer')
    const t: Tab = { id: nextId++, url: '', title: '', icon: '', back: [], fwd: [], frame, incognito, loading: false, desktop: false }
    frame.addEventListener('load', () => { if (t.loading && !proxyConfig()) setLoading(t, false) })
    pages.append(frame)
    tabs.push(t)
    if (show) select(t)
    load(t, target, false)
    tabsBtn.querySelector('.br-count')!.textContent = String(tabs.length)
    return t
  }
  function select(t: Tab) {
    cur = t
    tabs.forEach((x) => x.frame.classList.toggle('on', x === t))
    root.classList.toggle('incognito', t.incognito)
    setLoading(t, t.loading)
    hint.classList.toggle('on', !!t.error)
    showUrl()
  }
  function closeTab(t: Tab) {
    const i = tabs.indexOf(t)
    tabs.splice(i, 1)
    t.frame.remove()
    if (!tabs.length) newTab()
    else if (t === cur) select(tabs[Math.max(0, i - 1)])
    tabsBtn.querySelector('.br-count')!.textContent = String(tabs.length)
    saveTabs()
  }
  function showUrl() {
    if (!cur) return
    if (document.activeElement !== url) url.value = cur.url === HOME ? '' : cur.url
    favicon.src = cur.icon || img(B, cur.incognito ? 'ic_incognito_holo_dark' : cur.url.startsWith('https:') ? 'ic_secure_holo_dark' : 'ic_web_holo_dark')
    ctx.setTitle(cur.title || 'Browser')
  }

  // messages from pages (the proxy shim and our own home page)
  const onMsg = (e: MessageEvent) => {
    const t = tabs.find((x) => x.frame.contentWindow === e.source)
    const d = e.data
    if (!t || !d || typeof d !== 'object') return
    if (d.droid === 'page') {
      if (d.url && d.url !== t.url) { if (t.url) t.back.push(t.url); t.fwd = []; t.url = d.url }
      t.title = d.title || t.url
      t.icon = d.icon || ''
      if (!t.incognito) { const hs = history(); if (hs[0]?.url === t.url) { hs[0].title = t.title; store.set('history', hs) } }
      if (t === cur) showUrl()
      saveTabs()
    }
    if (d.droid === 'loading') setLoading(t, true)
    if (d.droid === 'loaded') setLoading(t, false)
    if (d.droid === 'error') errorPage(t, d.reason || '')
    if (d.droid === 'open' && d.url) newTab(d.url, t.incognito)
    if (d.droid === 'download' && typeof d.url === 'string' && /^https?:/.test(d.url)) {
      import('./download').then((m) => m.download(d.url, typeof d.name === 'string' ? d.name : ''))
      // the frame went to the file itself: back to the page that linked it
      if (d.back) { if (t.back.length) load(t, t.back.pop()!, false); else setLoading(t, false) }
    }
    if (d.droid === 'go' && d.url) load(t, d.url)
  }
  addEventListener('message', onMsg)

  // ---------- ui ----------
  url.addEventListener('focus', () => { url.select(); root.classList.add('editing'); document.documentElement.classList.add('ime-open') })
  url.addEventListener('blur', () => { root.classList.remove('editing'); document.documentElement.classList.remove('ime-open'); showUrl() })
  url.addEventListener('keydown', (e) => { if (e.key === 'Enter' && cur) { load(cur, normalize(url.value)); url.blur() } })
  stopReload.addEventListener('click', () => {
    if (!cur) return
    if (cur.loading) { cur.frame.src = 'about:blank'; setLoading(cur, false) }
    else load(cur, cur.url, false)
  })
  tabsBtn.addEventListener('click', () => switcher())
  menuBtn.addEventListener('click', () => menu())

  function menu() {
    if (!cur) return
    const t = cur
    const bm = bookmarks().some((b) => b.url === t.url)
    const items: [string, () => void][] = [
      ['Refresh', () => load(t, t.url, false)],
      ['Forward', () => { const n = t.fwd.pop(); if (n) { t.back.push(t.url); load(t, n, false) } }],
      ['New tab', () => newTab()],
      ['New incognito tab', () => newTab(HOME, true)],
      [bm ? 'Remove bookmark' : 'Save to bookmarks', () => {
        const list = bookmarks().filter((b) => b.url !== t.url)
        if (!bm) list.unshift({ url: t.url, title: t.title, time: Date.now() })
        store.set('bookmarks', list)
        toast(bm ? 'Bookmark removed' : 'Saved to bookmarks')
      }],
      ['Bookmarks / History', () => library()],
      ['Share page', () => ctx.start({ action: 'send', type: 'text/plain', extras: { text: t.url, subject: t.title } })],
      ['Find on page', () => find()],
      [(t.desktop ? '✓︎ ' : '') + 'Request desktop site', () => { t.desktop = !t.desktop; load(t, t.url.replace('://m.', '://'), false) }],
      ['Open in real tab', () => realTab(t.url)],
      ['Settings', () => browserSettings()],
    ]
    const m = h('div.h-menu.ab-menu.br-menu')
    const scrim = h('div.ab-menu-scrim', { onclick: (e: Event) => e.target === scrim && close() }, m)
    const close = () => { scrim.remove(); document.removeEventListener('droid:back', bk, true) }
    const bk = (e: Event) => { e.preventDefault(); e.stopImmediatePropagation(); close() }
    for (const [label, fn] of items) m.append(pressable(h('span', { onclick: () => { close(); fn() } }, label)))
    root.append(scrim)
    document.addEventListener('droid:back', bk, true)
  }

  function find() {
    findBar.innerHTML = ''
    const q = h('input.h-edit', { placeholder: 'Find on page' }) as HTMLInputElement
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter') cur?.frame.contentWindow?.postMessage({ cmd: 'find', q: q.value }, '*') })
    findBar.append(q, pressable(h('button.h-btn-borderless', { onclick: () => findBar.classList.remove('on') }, 'Done')))
    findBar.classList.add('on')
    q.focus()
  }

  function switcher() {
    const v = h('div.br-switcher')
    const close = () => { v.remove(); document.removeEventListener('droid:back', bk, true) }
    const bk = (e: Event) => { e.preventDefault(); e.stopImmediatePropagation(); close() }
    const list = h('div.br-cards')
    for (const t of tabs) {
      const card = pressable(h('div.br-card' + (t === cur ? '.cur' : '') + (t.incognito ? '.inc' : ''), {},
        h('img', { src: t.icon || img(B, t.incognito ? 'ic_incognito_holo_dark' : 'ic_web_holo_dark') }),
        h('div.br-card-t', {}, h('div', {}, t.title || 'New tab'), h('div.br-card-u', {}, t.url === HOME ? '' : t.url)),
        pressable(h('img.br-x', { src: img(B, 'ic_tab_close'), onclick: (e: Event) => { e.stopPropagation(); closeTab(t); close(); if (tabs.length) switcher() } }))))
      card.addEventListener('click', () => { select(t); close() })
      list.append(card)
    }
    v.append(h('div.br-sw-bar', {},
      pressable(h('span.br-btn', { onclick: () => { close(); newTab(HOME, true) } }, h('img', { src: img(B, 'ic_new_incognito_holo_dark') }))),
      h('span', { style: { flex: '1' } }),
      pressable(h('span.br-btn', { onclick: () => { close(); newTab() } }, h('img', { src: img(B, 'ic_new_window_holo_dark') })))), list)
    root.append(v)
    document.addEventListener('droid:back', bk, true)
  }

  function library() {
    const v = h('div.br-lib.holo-dark')
    const close = () => { v.remove(); document.removeEventListener('droid:back', bk, true) }
    const bk = (e: Event) => { e.preventDefault(); e.stopImmediatePropagation(); close() }
    const tabsRow = h('div.h-tabs')
    const body = h('div.br-lib-body')
    const show = (which: 'bookmarks' | 'history') => {
      tabsRow.querySelectorAll('.h-tab').forEach((x, i) => x.classList.toggle('selected', (i === 0) === (which === 'bookmarks')))
      body.innerHTML = ''
      const ul = h('ul.h-list')
      const list = which === 'bookmarks' ? bookmarks() : history()
      if (!list.length) ul.append(h('li.br-empty', {}, which === 'bookmarks' ? 'No bookmarks' : 'No history'))
      for (const e of list) {
        const li = pressable(h('li.h-item.small', {}, h('img', { src: img(B, which === 'bookmarks' ? 'ic_bookmark_on_holo_dark' : 'ic_history_holo_dark'), style: { width: '32px' } }), h('div.lines', {}, h('span.title', {}, e.title || e.url), h('span.summary', {}, e.url))))
        li.addEventListener('click', () => { close(); if (cur) load(cur, e.url) })
        li.addEventListener('contextmenu', async (ev) => {
          ev.preventDefault()
          const r = await dialog({ title: e.title, items: ['Open in new tab', 'Delete'] })
          if (r.index === 0) { close(); newTab(e.url) }
          if (r.index === 1) { store.set(which, list.filter((x) => x !== e)); show(which) }
        })
        ul.append(li, h('li.h-divider'))
      }
      if (which === 'history' && list.length) ul.append(pressable(h('li.h-item.small', { onclick: () => { store.set('history', []); show('history') } }, h('div.lines', {}, h('span.title', { style: { color: '#33b5e5' } }, 'Clear history')))))
      body.append(ul)
    }
    tabsRow.append(pressable(h('span.h-tab', { onclick: () => show('bookmarks') }, 'Bookmarks')), pressable(h('span.h-tab', { onclick: () => show('history') }, 'History')))
    v.append(h('div.h-actionbar', {}, pressable(h('span.h-ab-item.h-ab-home', { onclick: close }, h('i.h-ab-up'), h('img', { src: img(B, 'ic_bookmarks_history_holo_dark') }), h('span.h-ab-title', {}, 'Bookmarks')))), tabsRow, body)
    root.append(v)
    document.addEventListener('droid:back', bk, true)
    show('bookmarks')
  }

  async function browserSettings() {
    const r = await dialog({ title: 'Settings', items: ['Search engine', 'Clear history', 'Clear cookies (new proxy sessions)', 'Droid proxy settings'] })
    if (r.index === 0) {
      const cur = Math.max(0, ENGINES.findIndex((e) => e.id === (settings.get('browser.engine') || 'duckduckgo')))
      const e = await dialog({ title: 'Search engine', kind: 'single', items: ENGINES.map((x) => x.label), checked: cur })
      if (e.button !== 'item' || e.index == null) return
      if (ENGINES[e.index].id === 'custom') {
        const v = await dialog({ title: 'SearXNG instance', kind: 'input', value: String(settings.get('browser.searx') || 'https://'), placeholder: 'https://searx.example/', ok: 'OK', cancel: 'Cancel' })
        if (v.button !== 'ok' || !/^https:\/\/[^/]+/.test(v.value || '')) return
        settings.set('browser.searx', v.value)
      }
      settings.set('browser.engine', ENGINES[e.index].id)
      toast(ENGINES[e.index].label)
      return
    }
    r.index = (r.index ?? 0) - 1
    if (r.index === 0) { store.set('history', []); toast('History cleared') }
    if (r.index === 1) { tabs.forEach((t) => (t.sid = undefined)); toast('Cookies cleared') }
    if (r.index === 2) ctx.start({ action: 'settings', extras: { page: 'more' } })
  }

  // restore tabs, then the url from the intent
  const saved = store.get<{ url: string }[]>('tabs', [])
  const want = ctx.intent.data && /^https?:/.test(ctx.intent.data) ? ctx.intent.data : null
  if (saved.length && !want) saved.forEach((s, i) => newTab(s.url, false, i === saved.length - 1))
  else newTab(want || HOME)

  return {
    back() {
      if (findBar.classList.contains('on')) { findBar.classList.remove('on'); return true }
      if (cur && cur.back.length) { const prev = cur.back.pop()!; cur.fwd.push(cur.url); load(cur, prev, false); return true }
      return false
    },
    intent(i) { if (i.data && /^https?:/.test(i.data)) newTab(i.data) },
    destroy() { removeEventListener('message', onMsg) },
    menu,
  }
}

const app: SystemApp = {
  manifest: {
    id: 'droid.browser', name: 'Browser', version: '4.4', versioncode: 19, type: 'web', main: 'browser',
    activities: { browser: { label: 'Browser', launcher: true, 'launch-mode': 'single-top' } }, role: 'browser', system: true,
    'intent-filters': [{ activity: 'browser', actions: ['view'], schemes: ['http', 'https'] }],
    permissions: ['network'], 'legacy-menu': false,
  },
  icon: '',
  iconRef: ['apps/browser', 'ic_launcher_browser'],
  activities: { browser },
}
export default app
