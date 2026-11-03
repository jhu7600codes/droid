// fake networks (spec section 15): DR-Nt (the fake wi-fi) and vte (the fake mobile data).
// cosmetic only: real connectivity is whatever the browser has. location never leaves the device.
import { settings } from './settings'

export interface Area { lat: number; lon: number; radius: number } // radius in meters
export interface NetDef { id: string; name: string; kind: 'drnt' | 'vte'; area: Area; signal?: 'linear' | 'steep' }
export interface Region { id: string; name: string; children?: Region[]; networks?: NetDef[] }
export interface NetState { kind: 'drnt' | 'vte' | 'none'; name: string; signal: number } // signal 0..4

// shipped regions. users can add more (settings key net.regions)
export const REGIONS: Region[] = [
  {
    id: 'russia', name: 'Russia', children: [
      { id: 'moscow-oblast', name: 'Moscow Oblast', networks: [
        { id: 'jhfi', name: 'jhfi', kind: 'drnt', area: { lat: 55.7558, lon: 37.6173, radius: 3000 } },
        { id: 'dr-moscow-center', name: 'DR-Nt Moscow Center', kind: 'drnt', area: { lat: 55.752, lon: 37.62, radius: 1500 } },
        { id: 'dr-zelenograd', name: 'DR-Nt Zelenograd', kind: 'drnt', area: { lat: 55.991, lon: 37.214, radius: 2500 } },
      ] },
      { id: 'saint-petersburg', name: 'Saint Petersburg', networks: [
        { id: 'dr-nevsky', name: 'DR-Nt Nevsky', kind: 'drnt', area: { lat: 59.934, lon: 30.335, radius: 2000 } },
      ] },
    ],
  },
  {
    id: 'world', name: 'Everywhere else', networks: [
      { id: 'dr-open', name: 'DR-Nt Open', kind: 'drnt', area: { lat: 0, lon: 0, radius: 0 } },
    ],
  },
]
// vte covers everywhere (like a carrier)
export const VTE: NetDef = { id: 'vte', name: 'VTE', kind: 'vte', area: { lat: 0, lon: 0, radius: Infinity } }

export function allNetworks(): NetDef[] {
  const out: NetDef[] = []
  const walk = (r: Region) => { r.networks?.forEach((n) => out.push(n)); r.children?.forEach(walk) }
  ;[...REGIONS, ...((settings.get('net.regions') as Region[]) || [])].forEach(walk)
  const own = ownNetwork()
  if (own) out.push(own)
  return out
}
export const ownNetwork = () => (settings.get('net.own') as NetDef | undefined) || null

// haversine distance in meters
export function distance(a: { lat: number; lon: number }, b: { lat: number; lon: number }) {
  const R = 6371000, rad = Math.PI / 180
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(x))
}

// 0..4 bars, strength falls off from the center
export function signalAt(n: NetDef, at: { lat: number; lon: number } | null) {
  if (n.area.radius === Infinity) return 4
  if (!at || !n.area.radius) return 0
  const d = distance(at, n.area)
  if (d > n.area.radius) return 0
  const f = 1 - d / n.area.radius
  const s = n.signal === 'steep' ? f * f : f
  return Math.max(1, Math.ceil(s * 4))
}

// where the device is: the manual "pretend i am here" spot, else the last browser position
export function location(): { lat: number; lon: number } | null {
  return (settings.get('location.pretend') as any) || (settings.get('location.last') as any) || null
}

// networks you could join right now, strongest first
export function scan(): (NetDef & { level: number })[] {
  const at = location()
  return allNetworks().filter((n) => n.kind === 'drnt').map((n) => ({ ...n, level: signalAt(n, at) })).filter((n) => n.level > 0).sort((a, b) => b.level - a.level)
}

// the state rule from the spec
export function state(): NetState {
  if (settings.get('airplane')) return { kind: 'none', name: '', signal: 0 }
  const saved = (settings.get('net.saved') as string[]) || []
  if (settings.get('wifi.on')) {
    const pick = scan().find((n) => saved.includes(n.id))
    if (pick) return { kind: 'drnt', name: pick.name, signal: pick.level }
  }
  const own = ownNetwork()
  const at = location()
  const outsideOwn = !own || !at || signalAt(own, at) === 0
  if (settings.get('data.on') && outsideOwn) return { kind: 'vte', name: VTE.name, signal: 4 }
  return { kind: 'none', name: '', signal: 0 }
}

// asks the browser for a position (only when location is on); keeps it on the device
export function refreshLocation() {
  if (!settings.get('location.on') || !navigator.geolocation) return
  navigator.geolocation.getCurrentPosition(
    (p) => settings.set('location.last', { lat: p.coords.latitude, lon: p.coords.longitude }),
    () => { /* denied: the pretend picker is the fallback */ },
    { maximumAge: 600000, timeout: 10000 },
  )
}

// fires fn when the network state changes (spec: 'network' event)
export function onNetwork(fn: (s: NetState) => void) {
  let last = JSON.stringify(state())
  return settings.on('*', () => {
    const s = state()
    const j = JSON.stringify(s)
    if (j !== last) { last = j; fn(s) }
  })
}
