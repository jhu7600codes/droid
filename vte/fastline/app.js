// shared by the five VTE carrier apps: reads this carrier's vSIM through droid.vte and fills the page.
// each app's index.html sets window.CARRIER and its own layout (data-v attributes get the values).
const C = window.CARRIER
const $ = (s) => document.querySelector(s)
const fmt = (n) => (n.length === 10 ? `${n.slice(0, 3)} ${n.slice(3, 6)} ${n.slice(6)}` : n)
const dollars = (c) => 'D$' + (c / 100).toFixed(2)
const set = (k, v) => document.querySelectorAll(`[data-v="${k}"]`).forEach((el) => (el.textContent = v))
let carrier = null, sim = null

async function load() {
  document.body.dataset.state = 'loading'
  try {
    const cs = await droid.vte.carriers()
    carrier = cs.find((c) => c.id === C) || null
    const sims = await droid.vte.sims()
    sim = sims.find((s) => s.carrier === C) || null
  } catch (e) {
    document.body.dataset.state = 'error'
    set('error', e.code === 'denied' ? 'This app needs to see your vSIM. Allow it in Settings > Apps.' : e.message || 'Could not reach VTE')
    return
  }
  render()
}
function render() {
  if (!sim) { document.body.dataset.state = 'nosim'; set('host', carrier?.host || ''); return }
  document.body.dataset.state = 'ok'
  const plan = carrier.plans.find((p) => p.id === sim.plan) || carrier.plans[0]
  const days = Math.max(0, Math.ceil((Date.parse(sim.renews_at) - Date.now()) / 86400000))
  set('number', fmt(sim.number))
  set('balance', dollars(sim.balance))
  set('plan', plan.name)
  set('vms', sim.vms_left.toLocaleString()); set('vms-total', plan.vms.toLocaleString())
  set('min', String(sim.minutes_left)); set('min-total', String(plan.minutes))
  set('renews', days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`)
  set('renew-date', new Date(sim.renews_at).toLocaleDateString())
  set('since', new Date(sim.created_at).toLocaleDateString())
  set('vms-price', dollars(carrier.vmsPrice)); set('min-price', dollars(carrier.minutePrice))
  const vf = plan.vms ? sim.vms_left / plan.vms : 0, mf = plan.minutes ? sim.minutes_left / plan.minutes : 0
  document.documentElement.style.setProperty('--vms', vf); document.documentElement.style.setProperty('--min', mf)
  document.querySelectorAll('[data-meter]').forEach((el) => { el.style.setProperty('--f', el.dataset.meter === 'vms' ? vf : mf) })
  // plans: the current one and a switch to the others (all free)
  const box = $('#plans')
  if (box) {
    box.innerHTML = ''
    for (const p of carrier.plans) {
      const d = document.createElement('div'); d.className = 'plan' + (p.id === sim.plan ? ' cur' : '')
      d.innerHTML = `<b></b><span>${p.vms.toLocaleString()} VMS · ${p.minutes} min · ${p.days} days</span>`
      d.querySelector('b').textContent = p.name
      const btn = document.createElement('button'); btn.textContent = p.id === sim.plan ? 'Current plan' : 'Switch (free)'; btn.disabled = p.id === sim.plan
      btn.onclick = async () => {
        const r = await droid.dialog({ title: 'Switch to ' + p.name + '?', message: 'Your allowance starts again with the new plan. Plans are free.', ok: 'Switch', cancel: 'Cancel' })
        if (r.button !== 'ok') return
        try { sim = await droid.vte.plan(C, p.id); droid.toast('Now on ' + p.name); render() } catch (e) { droid.toast(e.message) }
      }
      d.append(btn); box.append(d)
    }
  }
  droid.vte.usage(C).then((u) => {
    if (!u) return
    set('sent-today', String(u.sentToday))
    const list = $('#calls')
    if (!list) return
    list.innerHTML = ''
    if (!u.calls.length) { list.innerHTML = '<li class="none">No calls in the last day</li>'; return }
    for (const c of u.calls.slice(0, 8)) {
      const li = document.createElement('li')
      const len = c.seconds ? `${Math.floor(c.seconds / 60)}:${String(c.seconds % 60).padStart(2, '0')}` : c.state
      li.textContent = `${c.out ? '↗' : '↙'} ${new Date(c.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · ${len}`
      list.append(li)
    }
  }).catch(() => {})
}
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-act]')
  if (!a) return
  if (a.dataset.act === 'messaging') droid.vte.open('messaging')
  if (a.dataset.act === 'get') droid.vte.open(C)
  if (a.dataset.act === 'retry') load()
})
droid.actionbar.menu([{ id: 'refresh', title: 'Refresh' }, { id: 'site', title: 'Carrier website' }]).catch(() => {})
droid.on('menu', ({ id }) => (id === 'refresh' ? load() : droid.vte.open(C)))
droid.on('resume', load)
load()
