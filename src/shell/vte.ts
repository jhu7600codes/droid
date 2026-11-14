// VTE in the shell: carriers and vSIMs, MoVTE messages ("VMS") and VoVTE calls, all through the danen
// backend (backend/supabase/functions/danen, /vte/*). messages are kept on this device too (local
// storage) so the messenger opens instantly and offline. a background loop syncs while signed in:
// new messages become notifications, a ringing call opens the in-call screen.
import { settings } from './settings'
import { backendUrl, signedIn } from './danen-remote'

export interface Carrier { id: string; name: string; host: string; prefix: string; color: string; tagline: string; welcome: number; vmsPrice: number; minutePrice: number; plans: { id: string; name: string; vms: number; minutes: number; days: number }[] }
export interface Sim { carrier: string; number: string; plan: string; balance: number; vms_left: number; minutes_left: number; renews_at: string; created_at: string }
export interface Vms { id: number; from_number: string; to_number: string; body: string; created_at: string; pending?: boolean; failed?: string }
export interface CallRow { id: string; from_number: string; to_number: string; state: string; created_at: string; answered_at?: string | null; ended_at?: string | null }

// the same five as the backend, so pages and icons work before (or without) the first fetch
export const CARRIERS: Carrier[] = [
  { id: 'fastline', name: 'Fastline', host: 'fastline.vte', prefix: '701', color: '#ff6d00', tagline: 'Fast lines. Zero cost.', welcome: 4000, vmsPrice: 5, minutePrice: 20, plans: [{ id: 'lite', name: 'Fast Lite', vms: 200, minutes: 30, days: 7 }, { id: 'turbo', name: 'Turbo', vms: 1000, minutes: 120, days: 30 }] },
  { id: 'omvte', name: 'OMVTE', host: 'omvte.net', prefix: '702', color: '#7c4dff', tagline: 'Talk more, mind less.', welcome: 6000, vmsPrice: 4, minutePrice: 15, plans: [{ id: 'basic', name: 'Om Basic', vms: 300, minutes: 60, days: 30 }, { id: 'calm', name: 'Om Calm', vms: 5000, minutes: 600, days: 30 }] },
  { id: 'bumble', name: 'Bumble Line', host: 'bumble.line', prefix: '703', color: '#ffc107', tagline: 'Buzzing everywhere VTE goes.', welcome: 2500, vmsPrice: 3, minutePrice: 10, plans: [{ id: 'buzz', name: 'Buzz', vms: 150, minutes: 45, days: 14 }, { id: 'hive', name: 'Hive', vms: 500, minutes: 200, days: 30 }] },
  { id: 'transfer', name: 'Transfer', host: 'transfer.line', prefix: '704', color: '#00bfa5', tagline: 'Everything gets through.', welcome: 5000, vmsPrice: 5, minutePrice: 15, plans: [{ id: 'relay', name: 'Relay', vms: 250, minutes: 90, days: 30 }, { id: 'express', name: 'Express', vms: 800, minutes: 300, days: 30 }] },
  { id: 'line', name: 'Line Carrier', host: 'line.carrier', prefix: '705', color: '#2979ff', tagline: 'The line that is always there.', welcome: 10000, vmsPrice: 6, minutePrice: 25, plans: [{ id: 'standard', name: 'Standard', vms: 400, minutes: 120, days: 30 }, { id: 'plus', name: 'Standard Plus', vms: 1500, minutes: 400, days: 30 }] },
]
export const carrier = (id: string) => CARRIERS.find((c) => c.id === id)
export const carrierByHost = (host: string) => CARRIERS.find((c) => c.host === host.toLowerCase().replace(/^www\./, ''))
export const carrierOfNumber = (n: string) => CARRIERS.find((c) => n.startsWith(c.prefix))
export const fmtNumber = (n: string) => (n.length === 10 ? `${n.slice(0, 3)} ${n.slice(3, 6)} ${n.slice(6)}` : n)
export const dollars = (cents: number) => 'D$' + (cents / 100).toFixed(2)
export const digits = (s: string) => s.replace(/\D/g, '')

async function call<T = any>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const url = backendUrl()
  if (!url) throw new Error('No Danen backend set')
  const session = settings.get('danen.session') as string | undefined
  if (!session) throw new Error('Sign in to your Danen account first')
  let r: Response
  try { r = await fetch(url + path, { method, headers: { 'content-type': 'application/json', authorization: 'Danen ' + session }, body: body ? JSON.stringify(body) : undefined }) }
  catch { throw new Error('VTE is not reachable. Check your connection.') }
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw Object.assign(new Error(data.error || 'VTE is not reachable'), { status: r.status })
  return data
}

// ---------- local store ----------
const LS = 'droid.vte.'
const load = <T>(k: string, d: T): T => { try { const v = localStorage.getItem(LS + k); return v ? JSON.parse(v) : d } catch { return d } }
const save = (k: string, v: unknown) => { try { localStorage.setItem(LS + k, JSON.stringify(v)) } catch { /* full: keep going in memory */ } }
let sims: Sim[] = load('sims', [])
let msgs: Vms[] = load('msgs', [])
let calls: CallRow[] = load('calls', [])
let after = load('after', 0)
const names: Record<string, string> = load('names', {})
const read: Record<string, number> = load('read', {}) // conversation key -> last read message id
const subs = new Set<() => void>()
const changed = () => { save('sims', sims); save('msgs', msgs.slice(-3000)); save('calls', calls.slice(0, 200)); save('after', after); subs.forEach((f) => f()) }

// a conversation is between one of my numbers and a peer
export const convKey = (mine: string, peer: string) => mine + ':' + peer

export const vte = {
  on(f: () => void) { subs.add(f); return () => { subs.delete(f) } },
  ready: () => signedIn(),
  sims: () => sims,
  mine: (n: string) => sims.some((s) => s.number === n),
  names, nameOf: (n: string) => names[n] || fmtNumber(n),
  setName(n: string, name: string) { if (name.trim()) names[n] = name.trim().slice(0, 40); else delete names[n]; save('names', names); subs.forEach((f) => f()) },
  async refreshSims() { sims = (await call<{ sims: Sim[] }>('/vte/sims')).sims; changed(); return sims },
  async getSim(carrierId: string) { const { sim } = await call<{ sim: Sim }>('/vte/sim', 'POST', { carrier: carrierId }); await vte.refreshSims().catch(() => {}); if (!sims.some((s) => s.carrier === carrierId)) sims.push(sim); changed(); start(); return sim },
  async dropSim(carrierId: string) { await call('/vte/sim/drop', 'POST', { carrier: carrierId }); sims = sims.filter((s) => s.carrier !== carrierId); changed() },
  async setPlan(carrierId: string, plan: string) { const { sim } = await call<{ sim: Sim }>('/vte/plan', 'POST', { carrier: carrierId, plan }); sims = sims.map((s) => (s.carrier === carrierId ? sim : s)); changed(); return sim },

  // conversations: newest first, with the last message and unread count
  conversations() {
    const by = new Map<string, { key: string; mine: string; peer: string; last: Vms; unread: number }>()
    for (const m of msgs) {
      const out = vte.mine(m.from_number)
      const mine = out ? m.from_number : m.to_number, peer = out ? m.to_number : m.from_number
      const key = convKey(mine, peer)
      const c = by.get(key) || { key, mine, peer, last: m, unread: 0 }
      c.last = m
      if (!out && m.id > (read[key] || 0)) c.unread++
      by.set(key, c)
    }
    return [...by.values()].sort((a, b) => b.last.id - a.last.id)
  },
  thread: (mine: string, peer: string) => msgs.filter((m) => (m.from_number === mine && m.to_number === peer) || (m.from_number === peer && m.to_number === mine)),
  markRead(mine: string, peer: string) {
    const last = vte.thread(mine, peer).filter((m) => m.id > 0).pop()
    if (last && (read[convKey(mine, peer)] || 0) < last.id) { read[convKey(mine, peer)] = last.id; save('read', read); subs.forEach((f) => f()) }
  },
  unread: () => vte.conversations().reduce((n, c) => n + c.unread, 0),
  deleteThread(mine: string, peer: string) { msgs = msgs.filter((m) => !((m.from_number === mine && m.to_number === peer) || (m.from_number === peer && m.to_number === mine))); changed() },

  async send(from: Sim, to: string, body: string) {
    const temp: Vms = { id: -Date.now(), from_number: from.number, to_number: digits(to), body, created_at: new Date().toISOString(), pending: true }
    msgs.push(temp); changed()
    try {
      const r = await call<{ vms: Vms; sim: Sim }>('/vte/vms/send', 'POST', { carrier: from.carrier, to: digits(to), body })
      msgs = msgs.filter((m) => m !== temp)
      if (!msgs.some((m) => m.id === r.vms.id)) msgs.push(r.vms)
      sims = sims.map((s) => (s.carrier === from.carrier ? r.sim : s))
      read[convKey(from.number, digits(to))] = Math.max(read[convKey(from.number, digits(to))] || 0, r.vms.id); save('read', read)
      changed()
    } catch (e) { temp.pending = undefined; temp.failed = (e as Error).message; changed(); throw e }
  },
  calls: () => calls,
  // calls: signalling through the backend (offer, answer and ice inside the sdp: no trickle)
  callStart: (carrierId: string, to: string, offer: RTCSessionDescriptionInit) => call<{ call: CallRow }>('/vte/call', 'POST', { carrier: carrierId, to: digits(to), offer }),
  callGet: (id: string) => call<{ call: CallRow & { side: string; offer: RTCSessionDescriptionInit | null; answer: RTCSessionDescriptionInit | null } }>('/vte/call?id=' + encodeURIComponent(id)),
  callAnswer: (id: string, answer: RTCSessionDescriptionInit) => call('/vte/call/answer', 'POST', { id, answer }),
  callEnd: (id: string) => call('/vte/call/end', 'POST', { id }).then(() => vte.syncNow()),
  async carriers(): Promise<Carrier[]> {
    try { const url = backendUrl(); if (url) { const r = await (await fetch(url + '/vte/carriers')).json(); if (r.carriers?.length) return r.carriers } } catch { /* the built-in list */ }
    return CARRIERS
  },
  syncNow: () => tick(true),
}

// ---------- background sync ----------
let timer = 0, running = false, busy = false
const seenRinging = new Set<string>()
let hooks: { message?: (m: Vms) => void; ringing?: (c: CallRow) => void } = {}
export function vteHooks(h: typeof hooks) { hooks = h }

async function tick(force = false) {
  if (busy || !signedIn() || !backendUrl()) return
  if (!force && !sims.length) return
  busy = true
  try {
    if (!sims.length || Math.random() < 0.05) await vte.refreshSims().catch(() => {})
    if (!sims.length) return
    const first = after === 0
    const r = await call<{ vms: Vms[]; calls: CallRow[] }>('/vte/sync?after=' + after)
    let news = false
    for (const m of r.vms) {
      if (msgs.some((x) => x.id === m.id)) continue
      msgs.push(m); news = true
      after = Math.max(after, m.id)
      // the very first sync only fills the history; later ones notify
      if (!first && !vte.mine(m.from_number)) hooks.message?.(m)
    }
    after = Math.max(after, ...r.vms.map((m) => m.id), 0)
    calls = r.calls
    for (const c of r.calls) if (c.state === 'ringing' && vte.mine(c.to_number) && !seenRinging.has(c.id)) { seenRinging.add(c.id); hooks.ringing?.(c) }
    msgs.sort((a, b) => (a.id > 0 && b.id > 0 ? a.id - b.id : 0))
    if (news || r.calls.length) changed()
  } catch { /* offline or signed out: next time */ }
  finally { busy = false }
}
function start() {
  if (running) return
  running = true
  const loop = () => { tick(); timer = window.setTimeout(loop, document.hidden ? 20000 : 4000) }
  loop()
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { clearTimeout(timer); loop() } })
}
export function startVte() { if (signedIn() && backendUrl()) { start(); vte.refreshSims().catch(() => {}) } }
