// settings (role: settings), laid out like kitkat: wireless & networks, device, personal, accounts, system.
// wi-fi and data pages belong to the networks role app and are opened through it.
import type { SystemApp, ActivityContext, Activity } from '../../shell/types'
import { page, prefs, pageStack, ic, type Pref } from '../../shell/appkit'
import { h, dialog, toast, pressable } from '../../shell/ui'
import { settings } from '../../shell/settings'
import { kernel } from '../../shell/kernel'
import { wm } from '../../shell/wm'
import { PRESETS } from '../../shell/screen'
import { offline } from '../../shell/offline'
import { account } from '../../shell/danen'
import { state as netState } from '../../shell/net'
import { listPackages, getPackage, setGrant, uninstall } from '../../runtime/packages'
import { permName } from '../../runtime/manifest'
import { permissionText } from '../../runtime/bridge'
import { openDpk } from '../../runtime'
import * as store from '../../runtime/db'
import { applyUpdate } from '../../shell/sw-client'
import { sound as sfx } from '../../shell/sound'
import { licensesPage } from './licenses'
import './settings.css'

const S = 'apps/settings'
const fmtBytes = (n: number) => (n > 1 << 30 ? (n / (1 << 30)).toFixed(2) + ' GB' : n > 1 << 20 ? (n / (1 << 20)).toFixed(1) + ' MB' : (n / 1024).toFixed(0) + ' KB')
type Build = (parent: HTMLElement, pop: () => void, arg?: any) => (() => void) | void

function settingsApp(ctx: ActivityContext): Activity {
  ctx.root.classList.add('settings-root')
  const stack = pageStack(ctx.root)
  const open = (b: Build, arg?: any) => stack.push((el, pop) => b(el, pop, arg))
  const sub = (title: string, list: () => Pref[], icon = ic(S, 'ic_settings_home')): Build => (el, pop) => {
    const p = page(el, { title, icon, up: pop })
    return prefs(p.content, list).dispose
  }

  // ---------- pages ----------
  const wifi = () => wm.start({ action: 'networks', extras: { page: 'wifi' } }, undefined)
  const data = () => wm.start({ action: 'networks', extras: { page: 'data' } }, undefined)

  const more = sub('More…', () => [
    { type: 'switch', title: 'Airplane mode', key: 'airplane' },
    { type: 'header', title: 'droid proxy' },
    { type: 'item', title: 'Proxy address', summary: () => (settings.get('proxy.url') as string) || 'Not set', onclick: async () => {
      const r = await dialog({ title: 'droid proxy', kind: 'input', value: settings.get('proxy.url') as string, placeholder: 'https://proxy.example.com' })
      if (r.button === 'ok') settings.set('proxy.url', (r.value || '').trim())
    } },
    { type: 'item', title: 'Proxy token', summary: () => (settings.get('proxy.token') ? 'Set' : 'Not set'), onclick: async () => {
      const r = await dialog({ title: 'Proxy token', kind: 'input', placeholder: 'token from your proxy', value: '' })
      if (r.button === 'ok') settings.set('proxy.token', (r.value || '').trim())
    } },
    { type: 'item', title: 'About the proxy', summary: 'Used by the browser and by apps when a site refuses a direct request. You can host your own (proxy/ in the source).' },
  ])

  const bluetooth = sub('Bluetooth', () => [
    { type: 'switch', title: 'Bluetooth', key: 'bt.on' },
    { type: 'item', title: 'droid', summary: () => (settings.get('bt.on') ? 'Visible to nearby devices (pretend)' : 'Turn on Bluetooth to see devices') },
  ])

  const sound = sub('Sound', () => [
    { type: 'slider', title: 'Volume', min: 0, max: 1, step: 0.05, get: () => (settings.get('sound.volume') as number) ?? 0.8, set: (v) => settings.set('sound.volume', v), label: (v) => Math.round(v * 100) + '%' },
    { type: 'list', title: 'Default notification sound', options: ['Tejat', 'Tethys', 'Hojus', 'Deneb', 'Polaris', 'Capella', 'Altair', 'Antares'].map((n) => [n, n] as [string, string]), get: () => (settings.get('sound.notification') as string) || 'Tejat', set: (v) => { settings.set('sound.notification', v); sfx.play('notifications/' + v) } },
    { type: 'header', title: 'System' },
    { type: 'check', title: 'Touch sounds', key: 'sound.touch' },
    { type: 'check', title: 'Screen lock sound', key: 'sound.lock' },
    { type: 'check', title: 'Vibrate on touch', key: 'haptic' },
  ])

  const display = sub('Display', () => [
    { type: 'slider', title: 'Brightness', min: 0.3, max: 1, step: 0.05, get: () => settings.get('brightness'), set: (v) => settings.set('brightness', v), label: (v) => Math.round(v * 100) + '%' },
    { type: 'item', title: 'Wallpaper', onclick: () => wm.start({ action: 'set-wallpaper' }) },
    { type: 'check', title: 'Auto-rotate screen', get: () => !settings.get('rotation.lock'), set: (v) => settings.set('rotation.lock', !v) },
    { type: 'list', title: 'Font size', options: [['0.85', 'Small'], ['1', 'Normal'], ['1.15', 'Large'], ['1.3', 'Huge']], get: () => String(settings.get('font.scale')), set: (v) => settings.set('font.scale', +v) },
    { type: 'list', title: 'Display size', options: [['0.85', 'Small'], ['1', 'Default'], ['1.15', 'Large'], ['1.3', 'Largest']], get: () => String(settings.get('screen.scale')), set: (v) => settings.set('screen.scale', +v), summary: () => 'Makes everything bigger or smaller (changes density)' },
    { type: 'header', title: 'Screen' },
    { type: 'list', title: 'Resolution', options: [['auto', 'Auto (this screen)'], ...Object.entries(PRESETS).map(([k, p]) => [k, p.label] as [string, string]), ['custom', 'Custom…']],
      get: () => (settings.get('screen.mode') === 'auto' ? 'auto' : settings.get('screen.mode') === 'custom' ? 'custom' : settings.get('screen.preset')),
      set: async (v) => {
        if (v === 'auto') return settings.set('screen.mode', 'auto')
        if (v === 'custom') {
          const c = settings.get('screen.custom')
          const r = await dialog({ title: 'Custom resolution', kind: 'input', value: `${c.w}x${c.h}@${c.dpi}`, placeholder: 'width x height @ dpi' })
          const m = r.value?.match(/(\d+)\s*x\s*(\d+)\s*@\s*(\d+)/)
          if (r.button === 'ok' && m) { settings.set('screen.custom', { w: +m[1], h: +m[2], dpi: +m[3] }); settings.set('screen.mode', 'custom') }
          return
        }
        settings.set('screen.preset', v)
        settings.set('screen.mode', 'preset')
      } },
    { type: 'list', title: 'Scaling', options: [['auto', 'Auto'], ['fit', 'Fit (black bars)'], ['native', 'Native (whole window)']], key: 'screen.fit' },
    { type: 'list', title: 'Render scale', options: [['1', 'Full'], ['0.75', '75%'], ['0.5', '50% (slow devices)']], get: () => String(settings.get('screen.renderScale')), set: (v) => settings.set('screen.renderScale', +v) },
    { type: 'list', title: 'Display mode', options: [['auto', 'Auto'], ['phone', 'Phone'], ['tablet', 'Tablet'], ['desktop', 'Desktop']], key: 'screen.form' },
  ], ic(S, 'ic_settings_display'))

  const storage: Build = (el, pop) => {
    const p = page(el, { title: 'Storage', icon: ic(S, 'ic_settings_storage'), up: pop })
    let info = { used: 0, quota: 0, persisted: false }
    let sizes: { id: string; name: string; size: number }[] = []
    let est = { essential: 0, full: 0 }
    const r = prefs(p.content, () => [
      { type: 'header', title: 'Device storage' },
      { type: 'item', title: 'Used', summary: `${fmtBytes(info.used)} of ${fmtBytes(info.quota)}` },
      { type: 'item', title: 'Kept safe', summary: info.persisted ? 'The browser will not delete droid\'s data' : 'The browser may clear droid\'s data when space is low' },
      { type: 'header', title: 'Offline' },
      { type: 'item', title: 'Download essential', summary: `System and its apps, about ${fmtBytes(est.essential)}`, onclick: () => dl('essential') },
      { type: 'item', title: 'Download full', summary: `Also wallpapers, sounds and featured apps, about ${fmtBytes(est.full)}`, onclick: () => dl('full') },
      { type: 'item', title: 'Clear offline cache', onclick: async () => { await offline.clear(); toast('Cache cleared') } },
      { type: 'header', title: 'Apps' },
      ...sizes.map((s): Pref => ({ type: 'item', title: s.name, summary: fmtBytes(s.size), onclick: () => open(appInfo, s.id) })),
    ])
    const dl = async (kind: 'essential' | 'full') => {
      const bar = h('span.bar', { style: { width: '0%' } })
      const status = h('div', {}, 'Starting…')
      const body = h('div', {}, h('span.h-progress', {}, bar), status)
      const d = dialog({ title: 'Downloading', body, cancel: 'Pause', ok: 'Hide' })
      d.then((x) => { if (x.button === 'cancel') offline.pause() })
      await offline.download(kind, (n, t) => { bar.style.width = (n / t) * 100 + '%'; status.textContent = `${n} of ${t} files` })
      status.textContent = 'Done'
    }
    ;(async () => {
      info = await offline.usage()
      est = { essential: (await offline.estimate('essential')).bytes, full: (await offline.estimate('full')).bytes }
      sizes = (await listPackages()).map((x) => ({ id: x.manifest.id, name: x.manifest.name, size: x.size }))
      r.render()
    })()
    return r.dispose
  }

  const battery = sub('Battery', () => [
    { type: 'item', title: 'Battery', summary: 'Shown from this device\'s real battery when the browser tells droid' },
    { type: 'check', title: 'Battery saver', key: 'battery.saver', summary: 'Turns off animations' },
  ], ic(S, 'ic_settings_battery'))

  const apps: Build = (el, pop) => {
    const p = page(el, { title: 'Apps', icon: ic(S, 'ic_settings_applications'), up: pop })
    p.menu([{ title: 'Install from file…', onclick: () => pickDpk() }, { title: 'Default apps', onclick: () => open(roles) }])
    const r = prefs(p.content, () => {
      const all = [...kernel.apps.values()].filter((a) => a.icon || !a.system).sort((a, b) => a.manifest.name.localeCompare(b.manifest.name))
      return [
        { type: 'header', title: 'Downloaded' },
        ...all.filter((a) => !a.system).map((a): Pref => ({ type: 'item', title: a.manifest.name, summary: a.manifest.version, icon: a.icon, onclick: () => open(appInfo, a.manifest.id) })),
        { type: 'header', title: 'System' },
        ...all.filter((a) => a.system).map((a): Pref => ({ type: 'item', title: a.manifest.name, summary: a.manifest.version, icon: a.icon, onclick: () => open(appInfo, a.manifest.id) })),
      ]
    })
    const off = kernel.onAppsChanged(r.render)
    return () => { r.dispose(); off() }
  }
  const pickDpk = () => {
    const i = h('input', { type: 'file', accept: '.dpk,application/x-dpk', style: { display: 'none' } }) as HTMLInputElement
    i.addEventListener('change', () => { if (i.files?.[0]) openDpk(i.files[0]) })
    document.body.append(i)
    i.click()
    setTimeout(() => i.remove(), 60000)
  }

  const appInfo: Build = (el, pop, id: string) => {
    const app = kernel.get(id)
    if (!app) { pop(); return }
    const p = page(el, { title: 'App info', icon: ic(S, 'ic_settings_applications'), up: pop })
    let rec: any = null
    let dataSize = 0
    const head = h('div.app-head', {}, h('img', { src: app.icon || 'assets/brand/default-app-icon.svg' }), h('div', {}, h('div.t-large', {}, app.manifest.name), h('div.t-small.t-2', {}, 'version ' + app.manifest.version)))
    p.content.append(head)
    const btns = h('div.app-btns', {},
      pressable(h('button.h-btn', { onclick: () => { for (const t of [...wm.tasks]) if (t.pkg === id) wm.removeTask(t); toast('Stopped') } }, 'Force stop')),
      pressable(h('button.h-btn', { disabled: app.system, onclick: () => wm.start({ action: 'uninstall', data: 'package:' + id }) }, 'Uninstall')))
    p.content.append(btns)
    const r = prefs(p.content, () => [
      { type: 'header', title: 'Storage' },
      { type: 'item', title: 'App', summary: rec ? fmtBytes(rec.size) : 'Built in' },
      { type: 'item', title: 'Data', summary: fmtBytes(dataSize) },
      { type: 'item', title: 'Clear data', disabled: app.system, onclick: async () => {
        const d = await dialog({ title: 'Delete app data?', message: 'All this app\'s data will be deleted permanently, including files, settings and accounts.', cancel: 'Cancel', ok: 'OK' })
        if (d.button !== 'ok') return
        await store.delPrefix('files', `pkg:${id}:`)
        await store.delPrefix('kv', `${id}:`)
        dataSize = 0
        r.render()
      } },
      { type: 'header', title: 'Permissions' },
      ...((app.manifest.permissions || []).map(permName).map((pm): Pref => ({
        type: 'check', title: permissionText(pm), summary: pm,
        get: () => rec?.grants?.[pm] === 'granted',
        set: async (v) => { await setGrant(id, pm, v ? 'granted' : 'denied'); rec = await getPackage(id); r.render() },
      }))),
      ...(app.manifest.permissions?.length ? [] : [{ type: 'item', title: 'No permissions', summary: 'This app does not require any special access.' } as Pref]),
      { type: 'header', title: 'Package' },
      { type: 'item', title: 'Package id', summary: id },
      { type: 'item', title: 'Type', summary: app.manifest.type + (app.system ? ' · system app' : '') },
      ...(app.manifest.description ? [{ type: 'item', title: 'About', summary: app.manifest.description } as Pref] : []),
    ])
    ;(async () => {
      rec = await getPackage(id)
      for (const k of await store.keys('files', `pkg:${id}:`)) dataSize += (await store.get<Blob>('files', k))?.size || 0
      r.render()
    })()
    return r.dispose
  }

  const roles: Build = sub('Default apps', () => {
    const out: Pref[] = []
    for (const role of ['launcher', 'browser', 'store', 'wallpaper', 'ime']) {
      const opts = [...kernel.apps.values()].filter((a) => a.manifest.role === role)
      if (!opts.length) continue
      out.push({ type: 'list', title: role[0].toUpperCase() + role.slice(1), options: opts.map((a) => [a.manifest.id, a.manifest.name]), get: () => kernel.role(role)?.manifest.id || '', set: (v) => { kernel.setRole(role, v); if (role === 'launcher') toast('Restart droid to switch launcher') } })
    }
    return out
  })

  const location: Build = sub('Location', () => {
    const at = settings.get('location.pretend') as any
    return [
      { type: 'switch', title: 'Location', key: 'location.on', summary: 'Use this browser\'s location for DR-Nt networks' },
      { type: 'header', title: 'Pretend I am here' },
      { type: 'item', title: 'Pretend location', summary: at ? `${at.lat.toFixed(4)}, ${at.lon.toFixed(4)}` : 'Not set', onclick: async () => {
        const r = await dialog({ title: 'Pretend location', kind: 'input', value: at ? `${at.lat}, ${at.lon}` : '', placeholder: 'latitude, longitude' })
        const m = r.value?.match(/(-?[\d.]+)\s*[, ]\s*(-?[\d.]+)/)
        if (r.button === 'ok') settings.set('location.pretend', m ? { lat: +m[1], lon: +m[2] } : undefined as any)
      } },
      { type: 'item', title: 'Use the network map', summary: 'Pick a place in Wi-Fi > menu > Pretend location', onclick: () => wm.start({ action: 'networks', extras: { page: 'pretend' } }) },
      { type: 'item', title: 'Your location never leaves this device.', disabled: true },
    ]
  }, ic(S, 'ic_settings_location'))

  const security: Build = sub('Security', () => [
    { type: 'header', title: 'Screen security' },
    { type: 'list', title: 'Screen lock', options: [['none', 'None'], ['slide', 'Slide'], ['pin', 'PIN']], get: () => settings.get('lock.type'), set: async (v) => {
      if (v === 'pin') {
        const r = await dialog({ title: 'Choose your PIN', kind: 'input', placeholder: 'at least 4 digits' })
        if (r.button !== 'ok' || !/^\d{4,16}$/.test(r.value || '')) { toast('PIN must be 4 to 16 digits'); return }
        settings.set('lock.pin', r.value!)
      }
      settings.set('lock.type', v as any)
    } },
    { type: 'item', title: 'Owner info', summary: () => (settings.get('owner.name') as string) || 'None', onclick: async () => {
      const r = await dialog({ title: 'Owner info', kind: 'input', value: settings.get('owner.name') as string })
      if (r.button === 'ok') settings.set('owner.name', r.value || '')
    } },
    { type: 'header', title: 'Device administration' },
    { type: 'item', title: 'Unknown sources', summary: 'droid always lets you install .dpk files from anywhere' },
  ], ic(S, 'ic_settings_security'))

  const language: Build = sub('Language & input', () => [
    { type: 'list', title: 'Language', options: [['en', 'English (United States)'], ['ru', 'Русский'], ['de', 'Deutsch'], ['es', 'Español'], ['fr', 'Français'], ['uk', 'Українська'], ['pl', 'Polski'], ['ja', '日本語'], ['zh', '中文']], key: 'locale' },
    { type: 'header', title: 'Keyboard & input methods' },
    { type: 'item', title: 'Default', summary: 'Keyboard of this device (droid keyboard comes with an update)' },
  ], ic(S, 'ic_settings_language'))

  const backup: Build = sub('Backup & reset', () => [
    { type: 'check', title: 'Back up my data', key: 'danen.sync', summary: 'Back up settings and app data to your danen account' },
    { type: 'header', title: 'Personal data' },
    { type: 'item', title: 'Factory data reset', summary: 'Erases all data on droid', onclick: async () => {
      const r = await dialog({ title: 'Factory data reset', message: 'This will erase all data: your danen account on this device, settings, installed apps and their data, photos and files.', cancel: 'Cancel', ok: 'Erase everything' })
      if (r.button !== 'ok') return
      settings.reset()
      try { localStorage.clear() } catch { /* ignore */ }
      indexedDB.deleteDatabase('droid')
      for (const k of await caches.keys()) await caches.delete(k)
      window.location.reload()
    } },
  ], ic(S, 'ic_settings_backup'))

  const accountPage: Build = (el, pop) => {
    const p = page(el, { title: 'Danen account', icon: 'assets/brand/droid-d-icon.svg', up: pop })
    const r = prefs(p.content, () => {
      const a = account.get()
      const backend: Pref = { type: 'item', title: 'danen backend', summary: () => (settings.get('danen.backend') as string) || 'Not set (accounts stay on this device)', onclick: async () => {
        const d = await dialog({ title: 'danen backend', kind: 'input', value: (settings.get('danen.backend') as string) || '', placeholder: 'https://<project>.supabase.co/functions/v1/danen' })
        if (d.button === 'ok') settings.set('danen.backend', (d.value || '').trim())
      } }
      if (!a) return [
        { type: 'item', title: 'Add a danen account', summary: 'Sign in or create one', onclick: () => wm.start({ action: 'danen-account' }) },
        backend,
      ]
      return [
        { type: 'item', title: a.nickname, summary: a.username + (a.remote ? '' : ' · only on this device') },
        { type: 'check', title: 'Sync settings and app data', key: 'danen.sync' },
        { type: 'item', title: 'Sync now', summary: () => { const t = settings.get('danen.lastSync') as number; return t ? 'Last synced ' + new Date(t).toLocaleString() : 'Never synced' }, onclick: () => window.dispatchEvent(new Event('danen:sync-now')) },
        { type: 'check', title: 'Check for app updates', get: () => settings.get('danen.updates') !== false, set: (v) => settings.set('danen.updates', v) },
        backend,
        { type: 'item', title: 'Remove account', onclick: async () => {
          const d = await dialog({ title: 'Remove account?', message: 'Removing this account deletes it from this device. It stays on the danen backend if it was synced.', cancel: 'Cancel', ok: 'Remove' })
          if (d.button === 'ok') { account.signOut(); r.render() }
        } },
      ]
    })
    return r.dispose
  }

  const dateTime: Build = sub('Date & time', () => [
    { type: 'item', title: 'Automatic date & time', summary: 'Uses this device\'s time' },
    { type: 'item', title: 'Time zone', summary: Intl.DateTimeFormat().resolvedOptions().timeZone },
    { type: 'check', title: 'Use 24-hour format', key: 'time.24h' },
  ], ic(S, 'ic_settings_date_time'))

  const accessibility: Build = sub('Accessibility', () => [
    { type: 'check', title: 'Large text', get: () => settings.get('font.scale') >= 1.3, set: (v) => settings.set('font.scale', v ? 1.3 : 1) },
    { type: 'check', title: 'Remove animations', key: 'battery.saver' },
  ], ic(S, 'ic_settings_accessibility'))

  const about: Build = (el, pop) => {
    const p = page(el, { title: 'About phone', icon: ic(S, 'ic_settings_about'), up: pop })
    let ver = '…'
    fetch('version.json').then((r) => r.json()).then((v) => { ver = v.version; r.render() }).catch(() => {})
    let taps = 0
    const r = prefs(p.content, () => [
      { type: 'item', title: 'System updates', summary: settings.get('ota.ready') ? 'An update is ready. Tap to restart and install.' : 'Updates download in the background', onclick: () => open(update) },
      { type: 'item', title: 'Status', summary: () => { const s = netState(); return `Network: ${s.kind === 'none' ? 'none' : s.name} · ${navigator.onLine ? 'online' : 'offline'}` } },
      { type: 'item', title: 'Legal information', summary: 'Open source licenses', onclick: () => open(licensesPage) },
      { type: 'item', title: 'Model number', summary: 'droid (by danen)' },
      { type: 'item', title: 'droid version', summary: '4.4', onclick: () => { if (++taps >= 7) { taps = 0; toast('droid 4.4 · pigeon mode') } } },
      { type: 'item', title: 'API level', summary: '19' },
      { type: 'item', title: 'dpk spec', summary: '0.1' },
      { type: 'item', title: 'Kernel version', summary: 'danen shell, running in ' + (navigator.userAgent.match(/(Firefox|Chrome|Safari)\/[\d.]+/)?.[0] || 'a browser') },
      { type: 'item', title: 'Build number', summary: () => `KTU84Q.droid.${ver}` },
    ])
    return r.dispose
  }

  // ---------- main list ----------
  const main: Build = (el) => {
    const p = page(el, { title: 'Settings', icon: ic(S, 'ic_launcher_settings') })
    const r = prefs(p.content, () => [
      { type: 'header', title: 'Wireless & networks' },
      { type: 'switch', title: 'Wi-Fi', icon: ic(S, 'ic_settings_wireless'), key: 'wifi.on', onclick: wifi, summary: () => (netState().kind === 'drnt' ? netState().name : '') },
      { type: 'switch', title: 'Bluetooth', icon: ic(S, 'ic_settings_bluetooth2'), key: 'bt.on', onclick: () => open(bluetooth) },
      { type: 'item', title: 'Data usage', icon: ic(S, 'ic_settings_data_usage'), onclick: data },
      { type: 'item', title: 'More…', onclick: () => open(more) },
      { type: 'header', title: 'Device' },
      { type: 'item', title: 'Sound', icon: ic(S, 'ic_settings_sound'), onclick: () => open(sound) },
      { type: 'item', title: 'Display', icon: ic(S, 'ic_settings_display'), onclick: () => open(display) },
      { type: 'item', title: 'Storage', icon: ic(S, 'ic_settings_storage'), onclick: () => open(storage) },
      { type: 'item', title: 'Battery', icon: ic(S, 'ic_settings_battery'), onclick: () => open(battery) },
      { type: 'item', title: 'Apps', icon: ic(S, 'ic_settings_applications'), onclick: () => open(apps) },
      { type: 'header', title: 'Personal' },
      { type: 'item', title: 'Location', icon: ic(S, 'ic_settings_location'), onclick: () => open(location) },
      { type: 'item', title: 'Security', icon: ic(S, 'ic_settings_security'), onclick: () => open(security) },
      { type: 'item', title: 'Language & input', icon: ic(S, 'ic_settings_language'), onclick: () => open(language) },
      { type: 'item', title: 'Backup & reset', icon: ic(S, 'ic_settings_backup'), onclick: () => open(backup) },
      { type: 'header', title: 'Accounts' },
      { type: 'item', title: account.get() ? 'Danen' : 'Add account', icon: 'assets/brand/droid-d-icon.svg', onclick: () => open(accountPage) },
      { type: 'header', title: 'System' },
      { type: 'item', title: 'Date & time', icon: ic(S, 'ic_settings_date_time'), onclick: () => open(dateTime) },
      { type: 'item', title: 'Accessibility', icon: ic(S, 'ic_settings_accessibility'), onclick: () => open(accessibility) },
      { type: 'item', title: 'Setup wizard', summary: 'Run the first-boot setup again', icon: ic(S, 'ic_settings_home'), onclick: () => wm.start({ action: 'setup' }) },
      { type: 'item', title: 'About phone', icon: ic(S, 'ic_settings_about'), onclick: () => open(about) },
    ])
    return r.dispose
  }

  // system updates (ota style): a new version downloads in the background and installs on the next boot
  const update: Build = (el, pop) => {
    const p = page(el, { title: 'System updates', icon: ic(S, 'ic_settings_about'), up: stack.depth() > 1 ? pop : () => ctx.finish() })
    const box = h('div.upd')
    p.content.append(box)
    const draw = async () => {
      box.innerHTML = ''
      const mine = await fetch('version.json').then((r) => r.json()).catch(() => null)
      box.append(h('img.upd-logo', { src: 'assets/brand/droid-logo.svg' }), h('div.upd-ver', {}, 'droid 4.4'), h('div.upd-sub', {}, mine ? `build ${mine.version}` : ''))
      if (settings.get('ota.ready')) {
        box.append(h('div.upd-msg', {}, 'A system update has been downloaded. droid will restart to install it.'), pressable(h('button.h-btn', { onclick: () => applyUpdate() }, 'Restart & install')))
        return
      }
      const status = h('div.upd-msg', {}, navigator.onLine ? 'Checking for updates…' : 'You are offline. Updates are checked when you are online.')
      box.append(status)
      if (!navigator.onLine) return
      const reg = await navigator.serviceWorker?.getRegistration().catch(() => undefined)
      await reg?.update().catch(() => {})
      setTimeout(() => {
        if (settings.get('ota.ready')) draw()
        else status.textContent = reg?.installing ? 'Downloading an update in the background…' : 'Your system is up to date.'
      }, 1500)
    }
    draw()
    return settings.on('ota.ready', () => draw())
  }

  const pages: Record<string, Build> = { update, main, display, storage, battery, apps, location, security, language, backup, account: accountPage, users: accountPage, about, more, bluetooth, sound, datetime: dateTime }
  const want = (ctx.intent.action === 'system-update' ? 'update' : ctx.intent.extras?.page) as string | undefined
  open(main)
  if (want === 'app' && ctx.intent.extras?.pkg) open(appInfo, ctx.intent.extras.pkg)
  else if (want === 'wifi') wifi()
  else if (want === 'data') data()
  else if (want && pages[want]) open(pages[want])
  return {
    back: () => stack.pop(),
    intent(i) { const pg = i.extras?.page as string; if (pg && pages[pg]) open(pages[pg]) },
  }
}

const app: SystemApp = {
  manifest: {
    id: 'droid.settings', name: 'Settings', version: '4.4', versioncode: 19, type: 'web', main: 'main',
    activities: { main: { label: 'Settings', launcher: true, 'launch-mode': 'single-top' } }, role: 'settings', system: true,
    'intent-filters': [{ activity: 'main', actions: ['settings', 'system-update'] }],
    permissions: ['system.settings', 'system.apps', 'system.networks', 'system.wallpaper'],
  },
  icon: '',
  iconRef: ['apps/settings', 'ic_launcher_settings'],
  activities: { main: settingsApp },
}
export default app
