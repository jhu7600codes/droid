// Messaging: MoVTE ("VMS", messages over VTE) and VoVTE calls between droid users with a vSIM. looks
// like kitkat's messaging app (its icon too). numbers come from the carriers' pages in the Browser
// (fastline.vte, omvte.net, bumble.line, transfer.line, line.carrier). calls are webrtc audio; the
// danen backend carries the signalling. the background part syncs, notifies and rings.
import type { SystemApp, ActivityContext, Activity } from '../../shell/types'
import { page, pageStack } from '../../shell/appkit'
import { h, pressable, dialog, toast } from '../../shell/ui'
import { img } from '../../shell/assets'
import { wm } from '../../shell/wm'
import { notifications } from '../../shell/notify'
import { signedIn, backendUrl } from '../../shell/danen-remote'
import { vte, vteHooks, startVte, carrier, carrierOfNumber, fmtNumber, dollars, digits, CARRIERS, type Sim, type Vms } from '../../shell/vte'
import { placeCall } from '../phone'
import './messenger.css'

const M = 'apps/mms'
const PKG = 'droid.messenger'
const when = (iso: string) => {
  const d = new Date(iso), now = new Date()
  return d.toDateString() === now.toDateString() ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}
const dot = (c: string) => h('span.ms-dot', { style: { background: carrier(c)?.color || '#999' } })
const avatar = (n: string) => {
  const name = vte.names[n]
  return name ? h('span.ms-avatar.ms-letter', { style: { background: carrierOfNumber(n)?.color || '#888' } }, name[0].toUpperCase()) : h('img.ms-avatar', { src: img(M, 'ic_contact_picture') })
}

function messenger(ctx: ActivityContext): Activity {
  const stack = pageStack(ctx.root)
  let offs: (() => void)[] = []

  // ---------- conversation list ----------
  stack.push((el) => {
    const p = page(el, { title: 'Messaging', icon: img(M, 'ic_launcher_smsmms'), theme: 'light' })
    p.root.classList.add('ms')
    p.menu([
      { title: 'New message', icon: img(M, 'ic_menu_msg_compose_holo_dark'), always: true, onclick: () => compose() },
      { title: 'Call', icon: img(M, 'ic_menu_call'), always: true, onclick: () => dial() },
      { title: 'My vSIMs', onclick: () => stack.push((e2, pop) => simsPage(e2, pop)) },
      { title: 'Recent calls', onclick: () => stack.push((e2, pop) => callsPage(e2, pop)) },
    ])
    const list = h('ul.h-list.ms-list')
    const empty = h('div.ms-empty')
    p.content.append(empty, list)
    const render = () => {
      list.innerHTML = ''; empty.innerHTML = ''
      if (!signedIn() || !backendUrl()) {
        empty.append(h('p', {}, 'MoVTE messages and VoVTE calls need a Danen account.'), pressable(h('button.h-btn', { onclick: () => wm.start({ action: 'danen-account' }) }, 'Sign in to Danen')))
        return
      }
      if (!vte.sims().length) {
        empty.append(h('p.ms-big', {}, 'No vSIM yet'), h('p', {}, 'Get a free vSIM from a VTE carrier. Their pages only open in droid\'s Browser:'))
        for (const c of CARRIERS) empty.append(pressable(h('button.h-btn-borderless.ms-carrier', { onclick: () => wm.start({ action: 'view', data: 'https://' + c.host + '/' }) }, dot(c.id), c.host)))
        return
      }
      const convs = vte.conversations()
      if (!convs.length) empty.append(h('p', {}, 'No conversations. Tap ✎ to send a VMS.'))
      for (const c of convs) {
        const li = pressable(h('li.h-item.ms-conv' + (c.unread ? '.unread' : ''), {},
          avatar(c.peer),
          h('div.lines', {},
            h('span.title', {}, vte.nameOf(c.peer), c.unread ? h('span.ms-count', {}, String(c.unread)) : null),
            h('span.summary', {}, (vte.mine(c.last.from_number) ? 'You: ' : '') + c.last.body)),
          h('div.ms-meta', {}, h('span', {}, c.last.pending ? 'Sending…' : c.last.failed ? 'Not sent' : when(c.last.created_at)), vte.sims().length > 1 ? dot(vte.sims().find((s) => s.number === c.mine)?.carrier || '') : null)))
        li.addEventListener('click', () => openThread(c.mine, c.peer))
        li.addEventListener('contextmenu', async (e) => {
          e.preventDefault()
          const r = await dialog({ title: vte.nameOf(c.peer), items: ['Call', 'Name this number', 'Delete conversation'] })
          if (r.index === 0) startCall(c.mine, c.peer)
          if (r.index === 1) nameNumber(c.peer)
          if (r.index === 2) vte.deleteThread(c.mine, c.peer)
        })
        list.append(li)
      }
    }
    render()
    const off = vte.on(render)
    vte.syncNow()
    return off
  })

  async function nameNumber(n: string) {
    const r = await dialog({ title: fmtNumber(n), kind: 'input', value: vte.names[n] || '', placeholder: 'Name' })
    if (r.button === 'ok') vte.setName(n, r.value || '')
  }
  const pickSim = async (title: string): Promise<Sim | null> => {
    const s = vte.sims()
    if (s.length <= 1) return s[0] || null
    const r = await dialog({ title, items: s.map((x) => `${carrier(x.carrier)?.name}  ·  ${fmtNumber(x.number)}`) })
    return r.index != null && r.index >= 0 ? s[r.index] : null
  }
  async function compose() {
    if (!vte.sims().length) return toast('Get a vSIM first')
    const r = await dialog({ title: 'New message', kind: 'input', placeholder: 'Number (10 digits)', ok: 'Next' })
    if (r.button !== 'ok') return
    const to = digits(r.value || '')
    if (to.length !== 10) return toast('VTE numbers have 10 digits')
    const sim = await pickSim('Send from')
    if (sim) openThread(sim.number, to)
  }
  async function dial() {
    if (!vte.sims().length) return toast('Get a vSIM first')
    const r = await dialog({ title: 'VoVTE call', kind: 'input', placeholder: 'Number (10 digits)', ok: 'Call' })
    if (r.button !== 'ok') return
    const to = digits(r.value || '')
    if (to.length !== 10) return toast('VTE numbers have 10 digits')
    const sim = await pickSim('Call from')
    if (sim) startCall(sim.number, to)
  }
  // calls are the Phone app's (kitkat's in-call screen)
  const startCall = (mine: string, peer: string) => { placeCall(peer, vte.sims().find((s) => s.number === mine)) }

  // ---------- one conversation ----------
  function openThread(mine: string, peer: string) {
    stack.push((el, pop) => {
      const p = page(el, { title: vte.nameOf(peer), up: pop, theme: 'light' })
      p.root.classList.add('ms')
      const sim = () => vte.sims().find((s) => s.number === mine)
      p.menu([
        { title: 'Call', icon: img(M, 'ic_menu_call'), always: true, onclick: () => startCall(mine, peer) },
        { title: 'Name this number', onclick: () => nameNumber(peer).then(() => p.title(vte.nameOf(peer))) },
        { title: 'Delete conversation', onclick: () => { vte.deleteThread(mine, peer); pop() } },
      ])
      const box = h('div.ms-thread')
      const from = h('div.ms-from')
      const input = h('textarea.ms-input', { placeholder: 'Type message', rows: 1, maxLength: 1000 }) as HTMLTextAreaElement
      const send = pressable(h('button.ms-send', { title: 'Send' }, h('img', { src: img(M, 'ic_send_holo_light') })))
      const counter = h('span.ms-counter')
      p.content.append(box, h('div.ms-compose', {}, from, h('div.ms-row', {}, input, h('div.ms-sendcol', {}, counter, send))))
      const render = () => {
        const s = sim()
        from.innerHTML = ''
        if (s) from.append(dot(s.carrier), `${carrier(s.carrier)?.name} · ${fmtNumber(s.number)} · ${s.vms_left > 0 ? s.vms_left + ' VMS left' : dollars(s.balance) + ' credit'}`)
        const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40
        box.innerHTML = ''
        let day = ''
        for (const m of vte.thread(mine, peer)) {
          const d = new Date(m.created_at).toDateString()
          if (d !== day) { day = d; box.append(h('div.ms-day', {}, new Date(m.created_at).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }))) }
          const out = m.from_number === mine
          box.append(h('div.ms-msg' + (out ? '.out' : '.in') + (m.failed ? '.failed' : ''), {},
            h('div.ms-body', {}, m.body),
            h('div.ms-time', {}, m.pending ? 'Sending…' : m.failed ? 'Not sent: ' + m.failed : when(m.created_at))))
        }
        if (atBottom || box.dataset.first !== '1') { box.scrollTop = box.scrollHeight; box.dataset.first = '1' }
        vte.markRead(mine, peer)
      }
      const go = async () => {
        const t = input.value.trim(), s = sim()
        if (!t || !s) return
        input.value = ''; counter.textContent = ''
        try { await vte.send(s, peer, t) } catch (e) { toast((e as Error).message) }
      }
      send.addEventListener('click', go)
      input.addEventListener('input', () => { counter.textContent = input.value.length > 800 ? String(1000 - input.value.length) : '' })
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); go() } })
      render()
      const off = vte.on(render)
      return () => off()
    })
  }

  // ---------- vSIMs ----------
  function simsPage(el: HTMLElement, pop: () => void) {
    const p = page(el, { title: 'My vSIMs', up: pop, theme: 'light' })
    p.root.classList.add('ms')
    const list = h('div.ms-sims')
    p.content.append(list)
    const render = () => {
      list.innerHTML = ''
      for (const s of vte.sims()) {
        const c = carrier(s.carrier)!, plan = c.plans.find((x) => x.id === s.plan)
        list.append(h('div.ms-sim', { style: { borderLeftColor: c.color } },
          h('div.ms-sim-name', {}, c.name), h('div.ms-sim-num', {}, fmtNumber(s.number)),
          h('div.ms-sim-row', {}, `${plan?.name || s.plan} · ${s.vms_left} VMS · ${s.minutes_left} min · ${dollars(s.balance)}`),
          h('div.ms-sim-row.t-2', {}, 'Renews ' + new Date(s.renews_at).toLocaleDateString())))
      }
      list.append(h('p.ms-hint', {}, 'More carriers: ' + CARRIERS.filter((c) => !vte.sims().some((s) => s.carrier === c.id)).map((c) => c.host).join(', ') + '. Open them in the Browser. Each carrier also has an app in the Danen Store.'))
    }
    render()
    vte.refreshSims().catch(() => {})
    return vte.on(render)
  }
  function callsPage(el: HTMLElement, pop: () => void) {
    const p = page(el, { title: 'Recent calls', up: pop, theme: 'light' })
    p.root.classList.add('ms')
    const list = h('ul.h-list')
    p.content.append(list)
    const render = () => {
      list.innerHTML = ''
      const cs = vte.calls()
      if (!cs.length) list.append(h('li.ms-empty', {}, 'No calls in the last day'))
      for (const c of cs) {
        const out = vte.mine(c.from_number), peer = out ? c.to_number : c.from_number
        const len = c.answered_at && c.ended_at ? Math.round((Date.parse(c.ended_at) - Date.parse(c.answered_at)) / 1000) : 0
        const li = pressable(h('li.h-item', {}, avatar(peer), h('div.lines', {}, h('span.title', {}, vte.nameOf(peer)),
          h('span.summary', {}, `${out ? '↗ Outgoing' : c.state === 'missed' ? '↙ Missed' : '↙ Incoming'} · ${c.state === 'ended' ? Math.floor(len / 60) + ':' + String(len % 60).padStart(2, '0') : c.state} · ${when(c.created_at)}`))))
        li.addEventListener('click', () => startCall(out ? c.from_number : c.to_number, peer))
        list.append(li)
      }
    }
    render()
    return vte.on(render)
  }

  // a notification or another app can open a conversation
  const fromIntent = (i: { extras?: Record<string, unknown> }) => { const e = i?.extras || {}; if (e.mine && e.peer) openThread(String(e.mine), String(e.peer)) }
  fromIntent(ctx.intent as any)
  return {
    back: () => stack.pop(),
    intent: (i) => fromIntent(i as any),
    destroy: () => offs.forEach((f) => f()),
  }
}

// ---------- background: sync, notifications, incoming calls, push ----------
async function service() {
  vteHooks({
    message(m: Vms) {
      const n = vte.nameOf(m.from_number)
      notifications.post({ id: 'vms-' + m.from_number, pkg: PKG, title: n, text: m.body, ticker: `${n}: ${m.body}`, icon: img(M, 'ic_launcher_smsmms'),
        onclick: () => { notifications.cancel(PKG, 'vms-' + m.from_number); wm.start({ package: PKG, action: 'main', extras: { mine: m.to_number, peer: m.from_number } }) } })
    },
    ringing(c) { wm.start({ package: 'droid.phone', activity: 'call', extras: { id: c.id, from: c.from_number } }) },
  })
  startVte()
  // offline delivery: web push for this app (once per device)
  if (signedIn() && backendUrl() && !localStorage.getItem('droid.vte.pushed')) {
    import('../../shell/push').then((p) => p.subscribe(PKG)).then((r) => { if (r) localStorage.setItem('droid.vte.pushed', '1') }).catch(() => {})
  }
}

const app: SystemApp = {
  manifest: {
    id: PKG, name: 'Messaging', version: '4.4', versioncode: 19, type: 'web', main: 'list',
    activities: { list: { label: 'Messaging', launcher: true, 'launch-mode': 'single-top' } }, system: true, supports: ['phone', 'tablet', 'desktop'],
  },
  icon: '',
  iconRef: [M, 'ic_launcher_smsmms'],
  activities: { list: messenger },
  service,
}
export default app
