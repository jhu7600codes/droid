// Phone: kitkat's dialer and in-call screen (InCallUI) for VoVTE calls between droid users with a vSIM.
// the dialer: recent calls and a dialpad. the call screen: the caller banner over the photo, the
// provider strip, the red end-call bar and the button row (dialpad, speaker, mute, hold, add call);
// an incoming call shows the glow ring (drag to answer, decline or reply with a VMS).
// audio is webrtc; the danen backend carries the signalling (see shell/vte.ts).
import type { SystemApp, ActivityContext, Activity } from '../../shell/types'
import { h, pressable, dialog, toast } from '../../shell/ui'
import { img } from '../../shell/assets'
import { wm } from '../../shell/wm'
import { notifications } from '../../shell/notify'
import { signedIn, backendUrl } from '../../shell/danen-remote'
import { vte, carrier, carrierOfNumber, fmtNumber, digits, type Sim } from '../../shell/vte'
import './phone.css'

const D = 'apps/dialer', I = 'apps/incallui'
const PKG = 'droid.phone'
const LETTERS = ['', '', 'ABC', 'DEF', 'GHI', 'JKL', 'MNO', 'PQRS', 'TUV', 'WXYZ']
const when = (iso: string) => {
  const d = new Date(iso), now = new Date()
  return d.toDateString() === now.toDateString() ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

// which vSIM places a call: the only one, or the user picks
async function pickSim(): Promise<Sim | null> {
  const s = vte.sims()
  if (s.length <= 1) return s[0] || null
  const r = await dialog({ title: 'Call with', items: s.map((x) => `${carrier(x.carrier)?.name}  ·  ${fmtNumber(x.number)}`) })
  return r.index != null && r.index >= 0 ? s[r.index] : null
}
export async function placeCall(to: string, from?: Sim) {
  if (!signedIn() || !backendUrl()) { toast('Sign in to Danen to make VoVTE calls'); return }
  if (!vte.sims().length) { toast('Get a vSIM first: fastline.vte, omvte.net, bumble.line, transfer.line or line.carrier in the Browser'); return }
  const n = digits(to)
  if (n.length !== 10) { toast('VTE numbers have 10 digits'); return }
  const sim = from || (await pickSim())
  if (sim) wm.start({ package: PKG, activity: 'call', extras: { carrier: sim.carrier, to: n } })
}

// ---------- the dialer ----------
function dialer(ctx: ActivityContext): Activity {
  const typed = h('input.ph-digits', { readonly: true, placeholder: '' }) as HTMLInputElement
  const del = pressable(h('span.ph-del', {}, h('img', { src: img(D, 'ic_dial_action_delete') })))
  const keys = h('div.ph-keys')
  for (const k of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#']) {
    const n = k === '*' || k === '#' ? -1 : Number(k)
    const key = pressable(h('div.ph-key', {}, h('span.ph-num', {}, k), h('span.ph-let', {}, n > 1 ? LETTERS[n] : k === '0' ? '+' : '')))
    key.addEventListener('click', () => { typed.value += k; sync() })
    if (k === '0') key.addEventListener('contextmenu', (e) => { e.preventDefault(); typed.value += '+'; sync() })
    keys.append(key)
  }
  const callBtn = pressable(h('div.ph-call', {}, h('img', { src: img(D, 'ic_dial_action_call') })))
  const pad = h('div.ph-pad', {}, h('div.ph-field', {}, typed, del), keys, h('div.ph-callbar', {}, callBtn))
  const recents = h('ul.h-list.ph-recents')
  const empty = h('div.ph-empty')
  const tabs = h('div.ph-tabs', {}, h('span.on', {}, 'Recents'))
  const padBtn = pressable(h('span.ph-tool', { title: 'Dialpad' }, h('img', { src: img(D, 'ic_menu_dialpad_dk') })))
  const bottom = h('div.ph-bottom', {}, padBtn)
  const root = h('div.app.app-light.holo-light.ph', {}, tabs, empty, recents, pad, bottom)
  ctx.root.append(root)
  const showPad = (on: boolean) => { root.classList.toggle('pad-on', on) }
  padBtn.addEventListener('click', () => showPad(true))
  const sync = () => { del.classList.toggle('on', !!typed.value) }
  del.addEventListener('click', () => { typed.value = typed.value.slice(0, -1); sync() })
  del.addEventListener('contextmenu', (e) => { e.preventDefault(); typed.value = ''; sync() })
  callBtn.addEventListener('click', () => {
    // an empty dialpad calls back the last number, like kitkat
    if (!typed.value) { const last = vte.calls()[0]; if (last) { typed.value = fmtNumber(vte.mine(last.from_number) ? last.to_number : last.from_number).replace(/ /g, ''); sync() } return }
    placeCall(typed.value)
  })
  const onKey = (e: KeyboardEvent) => {
    if (!root.classList.contains('pad-on')) return
    if (/^[0-9*#]$/.test(e.key)) { typed.value += e.key; sync() }
    if (e.key === 'Backspace') { typed.value = typed.value.slice(0, -1); sync() }
    if (e.key === 'Enter') callBtn.click()
  }
  const render = () => {
    recents.innerHTML = ''; empty.innerHTML = ''
    if (!signedIn() || !backendUrl()) { empty.append(h('p', {}, 'VoVTE calls need a Danen account.'), pressable(h('button.h-btn', { onclick: () => wm.start({ action: 'danen-account' }) }, 'Sign in to Danen'))); return }
    if (!vte.sims().length) { empty.append(h('p', {}, 'No vSIM yet. Get a free one from a VTE carrier in the Browser: fastline.vte, omvte.net, bumble.line, transfer.line or line.carrier.')); return }
    const cs = vte.calls()
    if (!cs.length) { empty.append(h('p', {}, 'No recent calls. Tap the dialpad to call a VTE number.')); return }
    for (const c of cs) {
      const out = vte.mine(c.from_number), peer = out ? c.to_number : c.from_number
      const kind = out ? 'outgoing' : c.state === 'missed' || c.state === 'declined' ? 'missed' : 'incoming'
      const li = pressable(h('li.h-item.ph-row', {},
        h('img.ph-avatar', { src: img(I, 'picture_unknown') }),
        h('div.lines', {}, h('span.title', {}, vte.nameOf(peer)), h('span.summary', {}, h('img.ph-kind', { src: img(D, `ic_call_${kind}_holo_dark`) }), `${fmtNumber(peer)} · ${when(c.created_at)}`)),
        h('span.ph-callback', {}, h('img', { src: img(D, 'ic_phone_dk') }))))
      li.querySelector('.ph-callback')!.addEventListener('click', (e) => { e.stopPropagation(); placeCall(peer, vte.sims().find((s) => s.number === (out ? c.from_number : c.to_number))) })
      li.addEventListener('click', () => { typed.value = peer; sync(); showPad(true) })
      recents.append(li)
    }
  }
  render()
  const off = vte.on(render)
  vte.syncNow()
  const fromIntent = (i: { data?: string }) => { const n = (i?.data || '').replace(/^tel:/, ''); if (n) { typed.value = digits(n); sync(); showPad(true) } }
  fromIntent(ctx.intent)
  return {
    resume: () => addEventListener('keydown', onKey),
    pause: () => { removeEventListener('keydown', onKey); return undefined },
    back: () => { if (root.classList.contains('pad-on')) { showPad(false); return true } return false },
    intent: (i) => fromIntent(i),
    destroy: () => off(),
  }
}

// ---------- the in-call screen (InCallUI) ----------
const ICE = [{ urls: 'stun:stun.cloudflare.com:3478' }]
function inCall(ctx: ActivityContext): Activity {
  const e = (ctx.intent.extras || {}) as Record<string, string>
  const incoming = !!e.id && !e.to
  let id = e.id || '', peer = e.to || e.from || '', carrierId = e.carrier || ''
  let pc: RTCPeerConnection | null = null, mic: MediaStream | null = null, poll = 0, ticker = 0, ring: (() => void) | null = null
  let state = incoming ? 'incoming' : 'dialing', answeredAt = 0, closed = false, held = false, speaker = false, muted = false
  const audio = h('audio', { autoplay: true }) as HTMLAudioElement

  const name = h('div.icu-name'), number = h('div.icu-number'), elapsed = h('div.icu-elapsed')
  const provider = h('span.icu-provider'), stateLabel = h('span.icu-state')
  const banner = h('div.icu-banner', {}, h('div.icu-who', {}, name, number), elapsed)
  const strip = h('div.icu-strip', {}, provider, stateLabel)
  const photo = h('div.icu-photo', { style: { backgroundImage: `url(${img(I, 'picture_unknown')})` } })
  const btn = (icon: string, title: string, on: () => void) => { const b = pressable(h('button.icu-btn', { title }, h('img', { src: img(I, icon) }))); b.addEventListener('click', on); return b }
  const dialpadBtn = btn('ic_dialpad_holo_dark', 'Dialpad', () => { root.classList.toggle('pad-on'); dialpadBtn.classList.toggle('on', root.classList.contains('pad-on')) })
  const speakerBtn = btn('ic_sound_holo_dark', 'Speaker', () => { speaker = !speaker; audio.volume = speaker ? 1 : 0.6; speakerBtn.classList.toggle('on', speaker); (speakerBtn.firstChild as HTMLImageElement).src = img(I, speaker ? 'ic_sound_speakerphone_holo_dark' : 'ic_sound_holo_dark') })
  const muteBtn = btn('ic_mute_holo_dark', 'Mute', () => { muted = !muted; mic?.getAudioTracks().forEach((t) => (t.enabled = !muted && !held)); muteBtn.classList.toggle('on', muted) })
  const holdBtn = btn('ic_hold_pause_holo_dark', 'Hold', () => { held = !held; mic?.getAudioTracks().forEach((t) => (t.enabled = !muted && !held)); audio.muted = held; holdBtn.classList.toggle('on', held); show() })
  const addBtn = btn('ic_add_contact_holo_dark', 'Add call', () => toast('VoVTE has one call at a time'))
  addBtn.classList.add('off')
  const sep = () => h('span.icu-sep')
  const row = h('div.icu-row', {}, dialpadBtn, sep(), speakerBtn, sep(), muteBtn, sep(), holdBtn, sep(), addBtn)
  const end = pressable(h('button.icu-end', { title: 'End' }, h('img', { src: img(I, 'ic_in_call_phone_hangup') })))
  end.addEventListener('click', () => hangup())
  // the in-call dialpad sends dtmf tones into the call
  const dtmf = h('div.icu-dtmf')
  const dtmfShown = h('div.icu-dtmf-digits')
  for (const k of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#']) {
    const nm = k === '*' ? 'star' : k === '#' ? 'pound' : k === '0' ? '0_no_plus' : k === '1' ? '1_no_vm' : k
    const key = pressable(h('div.icu-dkey', {}, h('img', { src: img(I, `dial_num_${nm}_wht`), alt: k })))
    key.addEventListener('click', () => { dtmfShown.textContent += k; const s = pc?.getSenders().find((x) => x.dtmf)?.dtmf; try { s?.insertDTMF(k, 120, 60) } catch { /* not connected yet */ } })
    dtmf.append(key)
  }
  const controls = h('div.icu-controls', {}, end, row)
  // incoming: the glow ring
  const glow = glowpad({ answer: () => answer(), decline: () => hangup(), text: () => replyText() })
  const root = h('div.app.icu', {}, photo, h('div.icu-top', {}, banner, strip), h('div.icu-padwrap', {}, dtmfShown, dtmf), controls, glow.el, audio)
  ctx.root.append(root)

  const show = () => {
    name.textContent = vte.nameOf(peer)
    number.textContent = vte.names[peer] ? fmtNumber(peer) : ''
    const c = carrier(carrierId) || carrierOfNumber(peer)
    provider.textContent = 'VoVTE' + (c ? ' via ' + c.name : '')
    const secs = answeredAt ? Math.floor((Date.now() - answeredAt) / 1000) : 0
    elapsed.textContent = state === 'active' ? `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}` : ''
    stateLabel.textContent = held && state === 'active' ? 'On hold' : ({ dialing: 'Dialing', incoming: 'Incoming call', connecting: 'Connecting', active: '', ended: 'Call ended', declined: 'Call declined', missed: 'No answer', busy: 'Busy', failed: 'Call failed' } as Record<string, string>)[state] ?? state
    root.dataset.state = state
    const live = ['dialing', 'connecting', 'active'].includes(state)
    for (const b of [dialpadBtn, muteBtn, holdBtn, speakerBtn]) b.toggleAttribute('disabled', !live || (b === holdBtn && state !== 'active'))
    end.toggleAttribute('disabled', !live)
  }
  const iceDone = (p: RTCPeerConnection) => new Promise<void>((ok) => {
    if (p.iceGatheringState === 'complete') return ok()
    const t = setTimeout(ok, 2500)
    p.addEventListener('icegatheringstatechange', () => { if (p.iceGatheringState === 'complete') { clearTimeout(t); ok() } })
  })
  const fail = (m: string) => { toast(m); state = 'failed'; cleanup(); show() }
  async function media() {
    mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
    pc = new RTCPeerConnection({ iceServers: ICE })
    for (const t of mic.getTracks()) pc.addTrack(t, mic)
    pc.ontrack = (ev) => { audio.srcObject = ev.streams[0]; audio.volume = 0.6; audio.play().catch(() => {}) }
    pc.onconnectionstatechange = () => {
      if (pc?.connectionState === 'connected' && state !== 'active') { state = 'active'; answeredAt = answeredAt || Date.now(); show() }
      if (pc?.connectionState === 'failed') fail('The call could not connect (the networks in between may block it)')
    }
  }
  async function dial() {
    try {
      await media()
      const offer = await pc!.createOffer(); await pc!.setLocalDescription(offer); await iceDone(pc!)
      const r = await vte.callStart(carrierId, peer, pc!.localDescription!.toJSON())
      id = r.call.id
      if (r.call.state === 'busy') { state = 'busy'; cleanup(); return show() }
      ring = tone('back')
      watch()
    } catch (er) { fail((er as Error).message || 'Microphone not allowed') }
  }
  async function answer() {
    ring?.(); ring = null
    state = 'connecting'; show()
    try {
      const r = await vte.callGet(id)
      if (r.call.state !== 'ringing' || !r.call.offer) { state = r.call.state; cleanup(); return show() }
      carrierId = carrierOfNumber(r.call.to_number)?.id || carrierId
      await media()
      await pc!.setRemoteDescription(r.call.offer)
      const ans = await pc!.createAnswer(); await pc!.setLocalDescription(ans); await iceDone(pc!)
      await vte.callAnswer(id, pc!.localDescription!.toJSON())
      answeredAt = Date.now()
      watch()
    } catch (er) { fail((er as Error).message || 'Microphone not allowed') }
  }
  async function replyText() {
    const r = await dialog({ title: 'Quick response', items: ["Can't talk now. What's up?", "I'll call you right back.", "I'll call you later.", "Can't talk now. Call me later?", 'Custom message…'] })
    if (r.index == null || r.index < 0) return
    hangup()
    const mine = vte.sims().find((s) => s.carrier === carrierId) || vte.sims()[0]
    if (r.index === 4) { wm.start({ package: 'droid.messenger', action: 'main', extras: { mine: mine?.number, peer } }); return }
    const msg = ["Can't talk now. What's up?", "I'll call you right back.", "I'll call you later.", "Can't talk now. Call me later?"][r.index]
    if (mine) vte.send(mine, peer, msg).then(() => toast('Message sent')).catch((er) => toast((er as Error).message))
  }
  function watch() {
    clearInterval(poll)
    poll = window.setInterval(async () => {
      try {
        const r = await vte.callGet(id)
        if (r.call.answer && pc && !pc.currentRemoteDescription) { ring?.(); ring = null; state = 'connecting'; answeredAt = Date.now(); await pc.setRemoteDescription(r.call.answer); show() }
        if (['ended', 'declined', 'missed', 'busy'].includes(r.call.state)) { state = r.call.state; cleanup(); show() }
      } catch { /* keep trying */ }
    }, 1000)
  }
  function cleanup() {
    if (closed) return
    closed = true
    clearInterval(poll); clearInterval(ticker); ring?.(); ring = null
    pc?.close(); mic?.getTracks().forEach((t) => t.stop())
    notifications.cancel(PKG, 'call')
    setTimeout(() => { if (!document.hidden) ctx.finish() }, 2000)
  }
  async function hangup() {
    if (id) vte.callEnd(id).catch(() => {})
    state = state === 'incoming' ? 'declined' : 'ended'
    cleanup(); show()
  }
  ticker = window.setInterval(() => { if (state === 'active') show() }, 1000)
  if (incoming) {
    vte.callGet(id).then((r) => { peer = r.call.from_number; carrierId = carrierOfNumber(r.call.to_number)?.id || ''; show() }).catch(() => {})
    ring = tone('ring')
    watch()
  } else dial()
  show()
  notifications.post({ id: 'call', pkg: PKG, title: incoming ? 'Incoming call' : 'Current call', text: vte.nameOf(peer), icon: img(I, 'stat_sys_phone_call'), ongoing: true, silent: true, onclick: () => wm.start({ package: PKG, activity: 'call' }) })
  return { back: () => { if (root.classList.contains('pad-on')) { root.classList.remove('pad-on'); dialpadBtn.classList.remove('on'); return true } return true }, destroy: () => { if (!closed) hangup() } }
}

// kitkat's incoming-call glow ring: drag the handle onto answer (right), decline (left) or text (up)
function glowpad(on: { answer: () => void; decline: () => void; text: () => void }) {
  const handle = h('img.gp-handle', { src: img(I, 'ic_in_call_touch_handle_normal'), draggable: false }) as HTMLImageElement
  const target = (cls: string, icon: string) => h('img.gp-target.' + cls, { src: img(I, icon), draggable: false }) as HTMLImageElement
  const answer = target('answer', 'ic_lockscreen_answer_normal'), decline = target('decline', 'ic_lockscreen_decline_normal'), text = h('div.gp-target.text', {}, h('img', { src: img(I, 'ic_text_holo_dark'), draggable: false }))
  const ring = h('div.gp-ring')
  const el = h('div.gp', {}, ring, answer, decline, text, handle)
  let down: { x: number; y: number } | null = null, hit: string | null = null
  const R = () => ring.getBoundingClientRect().width / 2
  handle.addEventListener('pointerdown', (ev) => { ev.preventDefault(); handle.setPointerCapture(ev.pointerId); down = { x: ev.clientX, y: ev.clientY }; el.classList.add('dragging'); handle.src = img(I, 'ic_lockscreen_handle_pressed') })
  handle.addEventListener('pointermove', (ev) => {
    if (!down) return
    let dx = ev.clientX - down.x, dy = ev.clientY - down.y
    const r = R(), d = Math.hypot(dx, dy)
    if (d > r) { dx *= r / d; dy *= r / d }
    handle.style.transform = `translate(${dx}px, ${dy}px)`
    // snapped onto a target when close to it on the ring
    const near = (tx: number, ty: number) => Math.hypot(dx - tx * r, dy - ty * r) < r * 0.4
    hit = near(1, 0) ? 'answer' : near(-1, 0) ? 'decline' : near(0, -1) ? 'text' : null
    answer.src = img(I, hit === 'answer' ? 'ic_lockscreen_answer_activated' : 'ic_lockscreen_answer_normal')
    decline.src = img(I, hit === 'decline' ? 'ic_lockscreen_decline_activated' : 'ic_lockscreen_decline_normal')
    text.classList.toggle('on', hit === 'text')
  })
  const up = () => {
    if (!down) return
    down = null; el.classList.remove('dragging'); handle.style.transform = ''; handle.src = img(I, 'ic_in_call_touch_handle_normal')
    const h2 = hit; hit = null
    answer.src = img(I, 'ic_lockscreen_answer_normal'); decline.src = img(I, 'ic_lockscreen_decline_normal'); text.classList.remove('on')
    if (h2 === 'answer') on.answer(); if (h2 === 'decline') on.decline(); if (h2 === 'text') on.text()
  }
  handle.addEventListener('pointerup', up); handle.addEventListener('pointercancel', up)
  // keys too: enter answers, escape declines
  addEventListener('keydown', (ev) => { if (!el.isConnected || el.offsetParent === null) return; if (ev.key === 'Enter') on.answer(); if (ev.key === 'Escape') on.decline() })
  return { el }
}

// ring tones from web audio: 'ring' for incoming, 'back' (ringback) while dialing. returns stop()
function tone(kind: 'ring' | 'back') {
  const C = (window as any).AudioContext || (window as any).webkitAudioContext
  if (!C) return () => {}
  const a: AudioContext = new C(), g = a.createGain()
  g.connect(a.destination); g.gain.value = 0
  const o1 = a.createOscillator(), o2 = a.createOscillator()
  o1.frequency.value = kind === 'ring' ? 480 : 440; o2.frequency.value = kind === 'ring' ? 620 : 480
  o1.connect(g); o2.connect(g); o1.start(); o2.start()
  const vol = kind === 'ring' ? 0.12 : 0.05
  let live = true
  const beat = () => { if (!live) return; const t = a.currentTime; g.gain.setValueAtTime(vol, t); g.gain.setValueAtTime(0, t + (kind === 'ring' ? 1.2 : 2)); if (kind === 'ring') navigator.vibrate?.([800, 400]) }
  beat()
  const iv = setInterval(beat, kind === 'ring' ? 2000 : 4000)
  return () => { live = false; clearInterval(iv); try { o1.stop(); o2.stop(); a.close() } catch { /* gone */ } }
}

const app: SystemApp = {
  manifest: {
    id: PKG, name: 'Phone', version: '4.4', versioncode: 19, type: 'web', main: 'dialer',
    activities: { dialer: { label: 'Phone', launcher: true, 'launch-mode': 'single-top' }, call: { label: 'Call', 'launch-mode': 'single-top' } },
    'intent-filters': [{ activity: 'dialer', actions: ['dial', 'call'], schemes: ['tel'] }],
    system: true, supports: ['phone', 'tablet', 'desktop'],
  },
  icon: '',
  iconRef: [D, 'ic_launcher_phone'],
  activities: { dialer, call: inCall },
}
export default app
