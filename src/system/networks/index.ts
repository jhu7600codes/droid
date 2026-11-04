// networks (role: networks): the DR-Nt list (the wi-fi page), VTE data settings, regions,
// your own network and the "pretend i am here" picker (spec section 15).
import type { SystemApp, ActivityContext, Activity } from '../../shell/types'
import { page, prefs, pageStack, ic, type Pref } from '../../shell/appkit'
import { dialog, toast } from '../../shell/ui'
import { settings } from '../../shell/settings'
import { REGIONS, scan, state, allNetworks, signalAt, location, ownNetwork, refreshLocation, type NetDef, type Region } from '../../shell/net'

const S = 'apps/settings'
const CITIES: [string, number, number][] = [
  ['Moscow', 55.7558, 37.6173], ['Zelenograd', 55.991, 37.214], ['Saint Petersburg', 59.934, 30.335], ['Kazan', 55.796, 49.106],
  ['Novosibirsk', 55.03, 82.92], ['Berlin', 52.52, 13.405], ['London', 51.507, -0.128], ['New York', 40.713, -74.006], ['Tokyo', 35.68, 139.69],
]
const saved = () => new Set((settings.get('net.saved') as string[]) || [])
const setSaved = (s: Set<string>) => settings.set('net.saved', [...s])
type Build = (el: HTMLElement, pop: () => void) => (() => void) | void

function networks(ctx: ActivityContext): Activity {
  const stack = pageStack(ctx.root)
  const open = (b: Build) => stack.push(b)
  const fin = () => ctx.finish()

  const wifi: Build = (el, pop) => {
    const p = page(el, { title: 'Wi-Fi', icon: ic(S, 'ic_settings_wireless'), up: stack.depth() > 1 ? pop : fin })
    p.menu([
      { title: 'Scan', icon: ic(S, 'ic_menu_refresh_holo_dark'), always: true, onclick: () => { refreshLocation(); r.render(); toast('Scanning…') } },
      { title: 'Add network', icon: ic(S, 'ic_menu_add_dark'), always: true, onclick: addNetwork },
      { title: 'Your network', onclick: () => open(yourNet) },
      { title: 'Regions', onclick: () => open(regions) },
      { title: 'Pretend location', onclick: () => open(pretend) },
    ])
    const r = prefs(p.content, () => {
      if (!settings.get('wifi.on')) return [
        { type: 'switch', title: 'Off', key: 'wifi.on' },
        { type: 'item', title: 'To see available networks, turn Wi-Fi on.', disabled: true },
      ]
      const st = state()
      const s = saved()
      const near = scan()
      const out: Pref[] = [{ type: 'switch', title: 'On', key: 'wifi.on' }]
      if (!location()) out.push({ type: 'item', title: 'Where are you?', summary: 'Droid does not know your location. Turn on location or pick a pretend location.', onclick: () => open(pretend) })
      for (const n of near) {
        const connected = st.kind === 'drnt' && st.name === n.name
        out.push({ type: 'item', title: n.name, icon: ic(S, `ic_wifi_signal_${Math.max(1, n.level)}_dark`),
          summary: connected ? 'Connected' : s.has(n.id) ? 'Saved' : 'Open (DR-Nt)',
          onclick: () => tapNet(n, connected) })
      }
      if (!near.length) out.push({ type: 'item', title: 'No DR-Nt networks in range', summary: 'Mobile data (VTE) is used when you are outside your network', disabled: true })
      return out
    })
    const tapNet = async (n: NetDef, connected: boolean) => {
      if (connected || saved().has(n.id)) {
        const d = await dialog({ title: n.name, message: `Signal strength: ${['', 'Poor', 'Fair', 'Good', 'Excellent'][signalAt(n, location())]}\nSecurity: none (DR-Nt is pretend)`, neutral: 'Forget', ok: 'Done' })
        if (d.button === 'neutral') { const s = saved(); s.delete(n.id); setSaved(s) }
      } else {
        const s = saved(); s.add(n.id); setSaved(s)
        toast(`Connected to ${n.name}`)
      }
      r.render()
    }
    return r.dispose
  }

  async function addNetwork() {
    const name = await dialog({ title: 'Add network', kind: 'input', placeholder: 'Network name (SSID)' })
    if (name.button !== 'ok' || !name.value?.trim()) return
    const at = location()
    if (!at) { toast('Set a pretend location first'); return }
    const rad = await dialog({ title: 'Range', kind: 'single', items: ['100 m', '500 m', '2 km', '10 km'], checked: 1, ok: 'Add', cancel: 'Cancel' })
    if (rad.button === 'cancel') return
    const radius = [100, 500, 2000, 10000][rad.index ?? 1]
    const mine = ((settings.get('net.regions') as Region[]) || []).find((x) => x.id === 'mine') || { id: 'mine', name: 'Added by you', networks: [] }
    const n: NetDef = { id: 'u-' + Date.now().toString(36), name: name.value.trim(), kind: 'drnt', area: { lat: at.lat, lon: at.lon, radius } }
    mine.networks = [...(mine.networks || []), n]
    settings.set('net.regions', [...((settings.get('net.regions') as Region[]) || []).filter((x) => x.id !== 'mine'), mine])
    const s = saved(); s.add(n.id); setSaved(s)
    toast(`Added ${n.name} here`)
  }

  const yourNet: Build = (el, pop) => {
    const p = page(el, { title: 'Your network', icon: ic(S, 'ic_settings_wireless'), up: pop })
    const r = prefs(p.content, () => {
      const own = ownNetwork()
      return [
        { type: 'item', title: 'Name', summary: own?.name || 'Not set up', onclick: async () => {
          const d = await dialog({ title: 'Network name', kind: 'input', value: own?.name || '' })
          if (d.button === 'ok' && d.value) save({ name: d.value })
        } },
        { type: 'item', title: 'Center', summary: own ? `${own.area.lat.toFixed(4)}, ${own.area.lon.toFixed(4)}` : 'Not set', onclick: async () => {
          const at = location()
          const d = await dialog({ title: 'Center', kind: 'input', value: own ? `${own.area.lat}, ${own.area.lon}` : at ? `${at.lat}, ${at.lon}` : '', placeholder: 'latitude, longitude', neutral: at ? 'Use my location' : undefined })
          if (d.button === 'neutral' && at) save({ lat: at.lat, lon: at.lon })
          const m = d.value?.match(/(-?[\d.]+)\s*[, ]\s*(-?[\d.]+)/)
          if (d.button === 'ok' && m) save({ lat: +m[1], lon: +m[2] })
        } },
        { type: 'slider', title: 'Radius', min: 100, max: 20000, step: 100, get: () => own?.area.radius || 1000, set: (v) => save({ radius: v }), label: (v) => (v / 1000).toFixed(1) + ' km' },
        { type: 'item', title: 'Outside your network, Droid uses VTE mobile data.', disabled: true },
      ]
    })
    const save = (x: { name?: string; lat?: number; lon?: number; radius?: number }) => {
      const at = location()
      const own = ownNetwork() || { id: 'own', name: 'my-net', kind: 'drnt', area: { lat: at?.lat || 0, lon: at?.lon || 0, radius: 1000 } }
      const n: NetDef = { ...own, name: x.name ?? own.name, area: { lat: x.lat ?? own.area.lat, lon: x.lon ?? own.area.lon, radius: x.radius ?? own.area.radius } }
      settings.set('net.own', n)
      const s = saved(); s.add('own'); setSaved(s)
    }
    return r.dispose
  }

  const regions: Build = (el, pop) => {
    const p = page(el, { title: 'Regions', up: pop })
    const all = [...REGIONS, ...((settings.get('net.regions') as Region[]) || [])]
    const rows: Pref[] = []
    const walk = (r: Region, depth: number) => {
      if (depth === 0) rows.push({ type: 'header', title: r.name })
      else rows.push({ type: 'item', title: r.name, summary: `${r.networks?.length || 0} networks` })
      for (const n of r.networks || []) rows.push({ type: 'item', title: '   ' + n.name, summary: `${(n.area.radius / 1000).toFixed(1)} km around ${n.area.lat.toFixed(3)}, ${n.area.lon.toFixed(3)}`, onclick: () => { settings.set('location.pretend', { lat: n.area.lat, lon: n.area.lon }); toast(`Pretending to be at ${n.name}`) } })
      r.children?.forEach((c) => walk(c, depth + 1))
    }
    all.forEach((r) => walk(r, 0))
    return prefs(p.content, () => rows).dispose
  }

  const pretend: Build = (el, pop) => {
    const p = page(el, { title: 'Pretend location', up: stack.depth() > 1 ? pop : fin })
    const r = prefs(p.content, () => {
      const at = location()
      return [
        { type: 'item', title: 'Current', summary: at ? `${at.lat.toFixed(4)}, ${at.lon.toFixed(4)}` : 'Unknown' },
        { type: 'item', title: 'Use my real location', summary: 'Asks the browser, stays on this device', onclick: () => {
          settings.set('location.on', true)
          navigator.geolocation?.getCurrentPosition((pos) => { settings.set('location.pretend', undefined as any); settings.set('location.last', { lat: pos.coords.latitude, lon: pos.coords.longitude }); toast('Using your location') }, () => toast('Location denied'))
        } },
        { type: 'item', title: 'Type coordinates', onclick: async () => {
          const d = await dialog({ title: 'Pretend I am here', kind: 'input', placeholder: 'latitude, longitude' })
          const m = d.value?.match(/(-?[\d.]+)\s*[, ]\s*(-?[\d.]+)/)
          if (d.button === 'ok' && m) settings.set('location.pretend', { lat: +m[1], lon: +m[2] })
        } },
        ...(ownNetwork() ? [{ type: 'item', title: 'At home', summary: ownNetwork()!.name, onclick: () => settings.set('location.pretend', { lat: ownNetwork()!.area.lat, lon: ownNetwork()!.area.lon }) } as Pref] : []),
        { type: 'header', title: 'Places' },
        ...CITIES.map(([n, lat, lon]): Pref => ({ type: 'item', title: n, summary: `${lat}, ${lon}`, onclick: () => settings.set('location.pretend', { lat, lon }) })),
      ]
    })
    return r.dispose
  }

  const data: Build = (el, pop) => {
    const p = page(el, { title: 'Data usage', icon: ic(S, 'ic_settings_data_usage'), up: stack.depth() > 1 ? pop : fin })
    const r = prefs(p.content, () => {
      const used = (settings.get('vte.used') as number) || 0
      const limit = (settings.get('vte.limit') as number) || 0
      return [
        { type: 'switch', title: 'Mobile data (VTE)', key: 'data.on' },
        { type: 'item', title: 'Data used', summary: `${(used / 1048576).toFixed(1)} MB this cycle${limit ? ` of ${limit} MB` : ''}` },
        { type: 'list', title: 'Set mobile data limit', options: [['0', 'No limit'], ['100', '100 MB'], ['500', '500 MB'], ['2000', '2 GB']], get: () => String(limit), set: (v) => settings.set('vte.limit', +v) },
        { type: 'check', title: 'Slow network', key: 'vte.slow', summary: 'Pretend VTE is a weak 3G connection (apps get slower responses)' },
        { type: 'item', title: 'Reset counter', onclick: () => settings.set('vte.used', 0) },
        { type: 'item', title: 'VTE is pretend. Real data is whatever this device uses.', disabled: true },
      ]
    })
    return r.dispose
  }

  const pg = (ctx.intent.extras?.page as string) || 'wifi'
  open({ wifi, data, pretend, regions, your: yourNet }[pg] || wifi)
  return { back: () => stack.pop() }
}

const app: SystemApp = {
  manifest: {
    id: 'droid.networks', name: 'Networks', version: '4.4', versioncode: 19, type: 'web', main: 'main',
    activities: { main: { label: 'Wi-Fi' } }, role: 'networks', system: true,
    'intent-filters': [{ activity: 'main', actions: ['networks'] }],
    permissions: ['system.networks'],
  },
  icon: '',
  iconRef: ['apps/settings', 'ic_settings_wireless'],
  activities: { main: networks },
}
export default app
