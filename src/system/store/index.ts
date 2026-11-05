// danen store (role: store): browse, search, install, update and uninstall dpks from the catalog.
// installs are checked twice: the whole file against the catalog's sha-256, then every file against the
// manifest's integrity map (parseDpk). permissions are shown before installing.
import type { SystemApp, ActivityContext, Activity } from '../../shell/types'
import { page, pageStack } from '../../shell/appkit'
import { h, pressable, dialog, toast, progress } from '../../shell/ui'
import { storeApi, signedIn } from '../../shell/danen-remote'
import { listZip } from '../../runtime/zip'
import { kernel } from '../../shell/kernel'
import { wm } from '../../shell/wm'
import { img } from '../../shell/assets'
import { pickPackage } from '../../runtime'
import { parseDpk, install, getPackage } from '../../runtime/packages'
import { sha256 } from '../../runtime/manifest'
import { permissionText } from '../../runtime/bridge'
import { loadCatalog, abs, type Catalog, type Listing } from './catalog'
import './store.css'

const REPO = 'https://github.com/jhu7600codes/droid'
const CATS: Record<string, string> = { tools: 'Tools', games: 'Games', productivity: 'Productivity', media: 'Media', education: 'Education', social: 'Social', demo: 'Demos' }
const fmt = (n: number) => (n > 1 << 20 ? (n / (1 << 20)).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB')

function storeApp(ctx: ActivityContext): Activity {
  const stack = pageStack(ctx.root)
  let cat: Catalog | null = null

  const iconOf = (l: Listing) => (l.icon ? abs(cat!, l.icon) : 'assets/brand/default-app-icon.svg')

  async function state(l: Listing) {
    const p = await getPackage(l.id)
    if (!p) return 'install'
    return p.manifest.versioncode < l.versioncode ? 'update' : 'installed'
  }

  function card(l: Listing) {
    const c = pressable(h('div.st-card', {}, h('img', { src: iconOf(l) }), h('div.st-name', {}, l.name), h('div.st-author', {}, l.author)))
    c.addEventListener('click', () => stack.push((el, pop) => listing(el, pop, l)))
    return c
  }

  const home = (el: HTMLElement) => {
    const p = page(el, { title: 'Danen Store', icon: 'assets/brand/droid-d-icon.svg' })
    p.menu([
      { title: 'Install from file', icon: img('framework', 'ic_menu_upload'), always: true, onclick: () => pickPackage() },
      { title: 'Search', icon: img('framework', 'ic_menu_search_holo_dark'), always: true, onclick: () => search() },
      { title: 'My apps', onclick: () => stack.push((e2, pop) => myApps(e2, pop)) },
      { title: 'Publish an app', onclick: () => stack.push((e2, pop) => publish(e2, pop)) },
      { title: 'My published apps', onclick: () => stack.push((e2, pop) => published(e2, pop)) },
      { title: 'Refresh', onclick: () => refresh(true) },
    ])
    const tabs = h('div.h-tabs.st-tabs')
    const body = h('div.st-body')
    p.content.append(tabs, body)
    let tab: 'featured' | 'community' | 'categories' | 'updates' = (ctx.intent.extras?.page as any) === 'updates' ? 'updates' : 'featured'
    let gen = 0
    const draw = async () => {
      const my = ++gen
      tabs.innerHTML = ''
      for (const [k, label] of [['featured', 'Featured'], ['community', 'Community'], ['categories', 'Categories'], ['updates', 'Updates']] as const) {
        tabs.append(pressable(h('span.h-tab' + (tab === k ? '.selected' : ''), { onclick: () => { tab = k; draw() } }, label)))
      }
      body.innerHTML = ''
      if (!cat) { body.append(h('div.st-msg', {}, navigator.onLine ? 'Loading…' : 'You are offline and the store has not been opened before.')); return }
      if (tab === 'featured') {
        body.append(h('div.st-banner', {}, h('img', { src: 'assets/brand/droid-logo.svg' }), h('div', {}, h('div.st-banner-t', {}, 'Apps for Droid'), h('div.st-banner-s', {}, 'Every app here is a DPK checked by the Danen store action.'))))
        const grid = h('div.st-grid')
        cat.apps.filter((l) => !l.community).forEach((l) => grid.append(card(l)))
        body.append(grid)
      }
      if (tab === 'community') {
        body.append(h('div.st-banner.st-community', {}, h('div', {}, h('div.st-banner-t', {}, 'Community apps'), h('div.st-banner-s', {}, 'Published from Droid with a Danen account. Not reviewed: they still only get the permissions you allow.')),
          pressable(h('button.h-btn.st-primary', { onclick: () => stack.push((e2, pop) => publish(e2, pop)) }, 'Publish'))))
        const apps = cat.apps.filter((l) => l.community)
        if (!apps.length) body.append(h('div.st-msg', {}, 'Nothing here yet. Be the first to publish an app.'))
        const grid = h('div.st-grid')
        apps.forEach((l) => grid.append(card(l)))
        body.append(grid)
      }
      if (tab === 'categories') {
        const ul = h('ul.h-list')
        for (const [k, label] of Object.entries(CATS)) {
          const n = cat.apps.filter((a) => a.category === k).length
          if (!n) continue
          ul.append(pressable(h('li.h-item.small', { onclick: () => stack.push((e2, pop) => list(e2, pop, label, cat!.apps.filter((a) => a.category === k))) }, h('div.lines', {}, h('span.title', {}, label), h('span.summary', {}, `${n} apps`)))), h('li.h-divider'))
        }
        body.append(ul)
      }
      if (tab === 'updates') {
        const ups: Listing[] = []
        for (const l of cat.apps) if ((await state(l)) === 'update') ups.push(l)
        if (my !== gen) return
        if (!ups.length) body.append(h('div.st-msg', {}, 'All your apps are up to date.'))
        else {
          body.append(pressable(h('button.h-btn.st-updall', { onclick: async () => { for (const l of ups) await doInstall(l, true); draw() } }, `Update all (${ups.length})`)))
          const grid = h('div.st-grid')
          ups.forEach((l) => grid.append(card(l)))
          body.append(grid)
        }
      }
    }
    const refresh = async (fresh = false) => {
      try { cat = await loadCatalog(fresh) } catch { if (fresh) toast('Can\'t reach the store') }
      draw()
    }
    draw()
    refresh()
    const off = kernel.onAppsChanged(draw)
    return () => off()
  }

  const list = (el: HTMLElement, pop: () => void, title: string, apps: Listing[]) => {
    const p = page(el, { title, icon: 'assets/brand/droid-d-icon.svg', up: pop })
    const grid = h('div.st-grid')
    if (!apps.length) p.content.append(h('div.st-msg', {}, 'Nothing found'))
    apps.forEach((l) => grid.append(card(l)))
    p.content.append(grid)
  }

  const myApps = (el: HTMLElement, pop: () => void) => {
    const mine = cat ? cat.apps.filter((a) => kernel.get(a.id)) : []
    list(el, pop, 'My apps', mine)
  }

  async function search() {
    const r = await dialog({ title: 'Search the store', kind: 'input', placeholder: 'App name', ok: 'Search' })
    if (r.button !== 'ok' || !cat) return
    const q = (r.value || '').toLowerCase()
    stack.push((el, pop) => list(el, pop, `"${r.value}"`, cat!.apps.filter((a) => (a.name + ' ' + a.description + ' ' + a.author + ' ' + a.id).toLowerCase().includes(q))))
  }

  async function doInstall(l: Listing, quiet = false) {
    if (!quiet) {
      const perms = l.permissions.length ? l.permissions.map((x) => '• ' + permissionText(x)).join('\n') : 'It does not require any special access.'
      const r = await dialog({ title: l.name, message: `${l.name} needs access to:\n${perms}`, cancel: 'Cancel', ok: 'Accept' })
      if (r.button !== 'ok') return false
    }
    const n = { cancel: false }
    try {
      toast(`Downloading ${l.name}…`)
      const buf = await (await fetch(abs(cat!, l.dpk))).arrayBuffer()
      if ((await sha256(new Uint8Array(buf))) !== l.sha256) throw new Error('the download does not match the store\'s hash')
      const p = await parseDpk(buf)
      if (p.manifest.id !== l.id) throw new Error('package id does not match the listing')
      if (n.cancel) return false
      await install(p, { source: 'store' })
      toast(`${l.name} installed`)
      return true
    } catch (e) {
      dialog({ title: 'Can\'t install', message: (e as Error).message })
      return false
    }
  }

  const listing = (el: HTMLElement, pop: () => void, l: Listing) => {
    const p = page(el, { title: l.name, icon: 'assets/brand/droid-d-icon.svg', up: pop })
    const btns = h('div.st-btns')
    const head = h('div.st-head', {}, h('img', { src: iconOf(l) }), h('div', {}, h('div.st-h-name', {}, l.name), h('div.st-h-author', {}, l.author), h('div.st-h-meta', {}, `${CATS[l.category] || l.category} · ${fmt(l.size)}`)))
    let gen = 0
    const draw = async () => {
      const my = ++gen
      const s = await state(l)
      if (my !== gen) return // a newer draw started while we waited
      btns.innerHTML = ''
      const installed = s !== 'install'
      if (installed) btns.append(pressable(h('button.h-btn', { onclick: () => wm.start({ action: 'uninstall', data: 'package:' + l.id }) }, 'Uninstall')))
      if (s === 'update') btns.append(pressable(h('button.h-btn.st-primary', { onclick: async () => { await doInstall(l); draw() } }, 'Update')))
      if (installed) btns.append(pressable(h('button.h-btn.st-primary', { onclick: () => wm.start({ package: l.id, action: 'main' }) }, 'Open')))
      else btns.append(pressable(h('button.h-btn.st-primary', { onclick: async () => { await doInstall(l); draw() } }, 'Install')))
    }
    draw()
    const off = kernel.onAppsChanged(draw)
    const shots = h('div.st-shots')
    l.screenshots.forEach((s) => shots.append(h('img', { src: abs(cat!, s) })))
    const report = `${REPO}/issues/new?title=${encodeURIComponent('report: ' + l.id)}&body=${encodeURIComponent(`app: ${l.id} ${l.version}\n\nwhat is wrong:\n`)}`
    // community apps are reported to danen (5 reports take a listing down)
    const reportCommunity = async () => {
      if (!signedIn()) { const r = await dialog({ title: 'Report this app', message: 'Sign in with your Danen account to report apps.', cancel: 'Cancel', ok: 'Sign in' }); if (r.button === 'ok') wm.start({ action: 'danen-account' }); return }
      const r = await dialog({ title: 'Report ' + l.name, kind: 'input', placeholder: 'What is wrong with it?', ok: 'Report' })
      if (r.button !== 'ok') return
      try { await storeApi.report(l.id, r.value || ''); toast('Thanks, the report was sent') } catch (e) { toast((e as Error).message) }
    }
    p.content.append(head, btns, l.community ? h('div.st-note', {}, `A community app${l.converted ? ' (converted from an Android APK)' : ''}, published by ${l.author}. Not reviewed by Danen.`) : '', l.screenshots.length ? shots : '',
      h('div.h-section', {}, 'Description'), h('div.st-desc', {}, l.description),
      h('div.h-section', {}, 'Permissions'), h('div.st-desc', {}, l.permissions.length ? l.permissions.map(permissionText).join(', ') : 'None'),
      h('div.h-section', {}, 'Additional information'),
      h('div.st-desc', {}, `Version ${l.version} · updated ${String(l.updated).slice(0, 10)} · ${l.id}`),
      pressable(h('button.h-btn-borderless.st-report', { onclick: () => (l.community ? reportCommunity() : wm.start({ action: 'view', data: report })) }, 'Report this app')))
    return () => off()
  }

  // ---------- publishing to the community side (danen account, no github) ----------
  const needSignIn = (el: HTMLElement) => {
    el.append(h('div.st-msg', {}, 'Publishing needs a Danen account.'), h('div.st-center', {}, pressable(h('button.h-btn.st-primary', { onclick: () => wm.start({ action: 'danen-account' }) }, 'Sign in to Danen'))))
  }
  const publish = (el: HTMLElement, pop: () => void) => {
    const p = page(el, { title: 'Publish an app', icon: 'assets/brand/droid-d-icon.svg', up: pop })
    if (!signedIn()) { needSignIn(p.content); return }
    const form = h('div.st-form')
    p.content.append(h('div.st-desc', {}, 'Pick an app (.dpk, or an Android .apk: it is converted to a DPK first). It goes to the Community tab right away. Up to 50 MB. To update it later, publish a version with a higher version code.'),
      h('div.st-center', {}, pressable(h('button.h-btn.st-primary', { onclick: () => choose() }, 'Choose a package'))), form)
    const choose = () => {
      const i = h('input', { type: 'file', style: { display: 'none' } }) as HTMLInputElement
      i.addEventListener('change', () => { const f = i.files?.[0]; i.remove(); if (f) prepare(f) })
      document.body.append(i); i.click()
    }
    const prepare = async (f: File) => {
      let buf = await f.arrayBuffer(), converted = false
      try {
        const entries = listZip(buf)
        if (entries.some((e) => e.path === 'AndroidManifest.xml') && !entries.some((e) => e.path === 'manifest.json')) {
          const stop = progress('Converting the APK…')
          try {
            const { convertApk } = await import('../../runtime/android/convert')
            const runtime = await (await fetch('runtime/android-runtime.js')).text()
            const r = await convertApk(buf, runtime)
            buf = r.dpk.buffer.slice(r.dpk.byteOffset, r.dpk.byteOffset + r.dpk.length) as ArrayBuffer
            converted = true
          } finally { stop() }
        }
      } catch (e) { dialog({ title: 'Can\'t publish', message: `That is not an app package. ${(e as Error).message}` }); return }
      let parsed
      try { parsed = await parseDpk(buf) } catch (e) { dialog({ title: 'Can\'t publish', message: (e as Error).message }); return }
      const m = parsed.manifest
      if (buf.byteLength > 50 * 1024 * 1024) { dialog({ title: 'Too big', message: `The package is ${fmt(buf.byteLength)}; the community store takes up to 50 MB.` }); return }
      const iconBytes = m.icon ? parsed.files.get(m.icon) : null
      const iconType = m.icon ? (m.icon.endsWith('.svg') ? 'image/svg+xml' : m.icon.endsWith('.jpg') || m.icon.endsWith('.jpeg') ? 'image/jpeg' : m.icon.endsWith('.webp') ? 'image/webp' : 'image/png') : null
      form.innerHTML = ''
      const name = h('input.h-edit', { value: m.name || m.id, maxlength: '50' }) as HTMLInputElement
      const desc = h('textarea.h-edit.st-textarea', { placeholder: 'What does it do?', maxlength: '4000', rows: '4' }) as HTMLTextAreaElement
      const catSel = h('select.h-edit') as HTMLSelectElement
      for (const [k, label] of Object.entries(CATS)) catSel.append(h('option', { value: k }, label))
      catSel.value = (m as any).category && CATS[(m as any).category] ? (m as any).category : m.type === 'converted' ? 'games' : 'tools'
      form.append(
        h('div.st-head', {}, h('img', { src: iconBytes ? URL.createObjectURL(new Blob([iconBytes as BlobPart], { type: iconType! })) : 'assets/brand/default-app-icon.svg' }),
          h('div', {}, h('div.st-h-name', {}, m.name || m.id), h('div.st-h-meta', {}, `${m.id} · version ${m.version} (${m.versioncode}) · ${fmt(buf.byteLength)}${converted ? ' · from an APK' : ''}`))),
        h('div.h-section', {}, 'Name'), name, h('div.h-section', {}, 'Category'), catSel, h('div.h-section', {}, 'Description'), desc,
        h('div.st-center', {}, pressable(h('button.h-btn.st-primary', { onclick: () => send() }, 'Publish'))))
      const send = async () => {
        const stop = progress(`Uploading ${fmt(buf.byteLength)}…`)
        try {
          const bytes = new Uint8Array(buf)
          const sha = await sha256(bytes)
          const up = await storeApi.upload({ id: m.id, versioncode: m.versioncode, size: bytes.length, icon: iconBytes ? iconType : null })
          await storeApi.put(up.dpk.url, new Blob([bytes as BlobPart]), 'application/x-dpk')
          if (up.icon && iconBytes) await storeApi.put(up.icon.url, new Blob([iconBytes as BlobPart], { type: iconType! }), iconType!)
          await storeApi.publish({ id: m.id, name: name.value.trim() || m.name, description: desc.value.trim(), category: catSel.value, version: m.version, versioncode: m.versioncode, size: bytes.length, sha256: sha, permissions: (m.permissions || []).map((x: any) => (typeof x === 'string' ? x : x.name)), converted, icon: !!up.icon })
          stop()
          toast(`${name.value.trim() || m.name} is published`)
          try { cat = await loadCatalog(true) } catch { /* shows next time */ }
          pop()
        } catch (e) { stop(); dialog({ title: 'Can\'t publish', message: (e as Error).message }) }
      }
    }
  }
  const published = (el: HTMLElement, pop: () => void) => {
    const p = page(el, { title: 'My published apps', icon: 'assets/brand/droid-d-icon.svg', up: pop })
    if (!signedIn()) { needSignIn(p.content); return }
    const body = h('div')
    p.content.append(body)
    const draw = async () => {
      body.innerHTML = ''
      body.append(h('div.st-msg', {}, 'Loading…'))
      let apps: Listing[] = []
      try { apps = (await storeApi.mine()).apps } catch (e) { body.innerHTML = ''; body.append(h('div.st-msg', {}, (e as Error).message)); return }
      body.innerHTML = ''
      if (!apps.length) { body.append(h('div.st-msg', {}, 'You have not published anything yet.')); return }
      const ul = h('ul.h-list')
      for (const a of apps) {
        ul.append(h('li.h-item', {}, h('img.st-li-icon', { src: a.icon || 'assets/brand/default-app-icon.svg' }),
          h('div.lines', {}, h('span.title', {}, a.name), h('span.summary', {}, `${a.version} (${a.versioncode}) · ${(a as any).status === 'hidden' ? 'taken down after reports' : 'live'}`)),
          pressable(h('button.h-btn-borderless', { onclick: async () => {
            const r = await dialog({ title: 'Unpublish ' + a.name + '?', message: 'It leaves the store. People who installed it keep it.', cancel: 'Cancel', ok: 'Unpublish' })
            if (r.button !== 'ok') return
            try { await storeApi.unpublish(a.id); toast('Unpublished'); try { cat = await loadCatalog(true) } catch { /* later */ } draw() } catch (e) { toast((e as Error).message) }
          } }, 'Unpublish'))), h('li.h-divider'))
      }
      body.append(ul)
    }
    draw()
  }

  stack.push((el) => home(el))
  return { back: () => stack.pop() }
}

const app: SystemApp = {
  manifest: {
    id: 'droid.store', name: 'Danen Store', version: '4.4', versioncode: 19, type: 'web', main: 'store',
    activities: { store: { label: 'Danen Store', launcher: true, 'launch-mode': 'single-top' } }, role: 'store', system: true,
    'intent-filters': [{ activity: 'store', actions: ['store'] }],
    permissions: ['network', 'system.apps'],
  },
  icon: 'assets/brand/droid-d-icon.svg',
  activities: { store: storeApp },
}
export default app
