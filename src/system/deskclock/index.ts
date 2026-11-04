// clock, after the kitkat aosp deskclock: tabs for alarm, clock, timer and stopwatch.
// alarms ring while droid is open (a browser can't wake a closed page): notification + aosp alarm sound.
import type { SystemApp, ActivityContext, Activity } from '../../shell/types'
import { h, pressable, dialog, toast } from '../../shell/ui'
import { img } from '../../shell/assets'
import { settings } from '../../shell/settings'
import { notifications } from '../../shell/notify'
import { wm } from '../../shell/wm'
import './deskclock.css'

const D = 'apps/deskclock'
const ID = 'droid.deskclock'
interface Alarm { id: number; h: number; m: number; on: boolean; label: string; last?: string }
const KEY = 'droid.deskclock.alarms'
const alarms = (): Alarm[] => { try { return JSON.parse(localStorage.getItem(KEY) || '[]') } catch { return [] } }
const saveAlarms = (a: Alarm[]) => { try { localStorage.setItem(KEY, JSON.stringify(a)) } catch { /* full */ } }
const two = (n: number) => String(n).padStart(2, '0')
const fmt = (h: number, m: number) => (settings.get('time.24h') ? `${two(h)}:${two(m)}` : `${h % 12 || 12}:${two(m)} ${h < 12 ? 'AM' : 'PM'}`)

let ringing: HTMLAudioElement | null = null
function ring(title: string) {
  ringing?.pause()
  ringing = new Audio('assets/aosp/sounds/alarms/Cesium.ogg')
  ringing.loop = true
  ringing.play().catch(() => {})
  navigator.vibrate?.([400, 200, 400, 200, 400])
  notifications.post({ id: 'ring', pkg: ID, title, text: 'Tap to dismiss', icon: img(D, 'ic_alarm_small'), onclick: stopRing })
  dialog({ title, message: new Date().toLocaleTimeString(), ok: 'Dismiss', cancelable: false }).then(stopRing)
}
function stopRing() { ringing?.pause(); ringing = null; notifications.cancel(ID, 'ring') }

// checks alarms every 15 s while droid runs
function alarmService() {
  setInterval(() => {
    const now = new Date()
    const stamp = now.toDateString() + now.getHours() + ':' + now.getMinutes()
    const list = alarms()
    let changed = false
    for (const a of list) if (a.on && a.h === now.getHours() && a.m === now.getMinutes() && a.last !== stamp) { a.last = stamp; changed = true; ring(a.label || 'Alarm') }
    if (changed) saveAlarms(list)
    const next = list.filter((a) => a.on)
    if (next.length) notifications.post({ id: 'next', pkg: ID, title: 'Alarm set', text: next.map((a) => fmt(a.h, a.m)).join(', '), icon: img(D, 'ic_alarm_small'), ongoing: true, silent: true, onclick: () => wm.start({ package: ID, action: 'main' }) })
    else notifications.cancel(ID, 'next')
  }, 15000)
}

function clock(ctx: ActivityContext): Activity {
  const tabs = h('div.dc-tabs')
  const body = h('div.dc-body')
  ctx.root.append(h('div.app.app-dark.dc', {}, tabs, body))
  let tab = 'clock'
  let timers: number[] = []
  const clear = () => { timers.forEach(clearInterval); timers = [] }
  const pages: Record<string, () => void> = {
    alarm() {
      const list = h('div.dc-alarms')
      const draw = () => {
        list.innerHTML = ''
        const all = alarms()
        if (!all.length) list.append(h('div.dc-empty', {}, 'No alarms'))
        for (const a of all) {
          const sw = h('label.h-switch', {}, h('input', { type: 'checkbox', checked: a.on, onchange: (e: Event) => { a.on = (e.target as HTMLInputElement).checked; saveAlarms(all); toast(a.on ? `Alarm set for ${fmt(a.h, a.m)}` : 'Alarm off') } }), h('span.track', {}, h('span.thumb')))
          const row = h('div.dc-alarm' + (a.on ? '.on' : ''), {}, h('div', {}, h('div.dc-atime', {}, fmt(a.h, a.m)), h('div.dc-alabel', {}, a.label || 'Alarm')), sw,
            pressable(h('img.dc-del', { src: img(D, 'ic_delete_normal'), onclick: () => { saveAlarms(all.filter((x) => x !== a)); draw() } })))
          list.append(row)
        }
      }
      const add = pressable(h('div.dc-add', {}, h('img', { src: img(D, 'ic_clock_add_alarm') })))
      add.addEventListener('click', async () => {
        const now = new Date()
        const r = await dialog({ title: 'Set alarm', kind: 'input', value: `${two(now.getHours())}:${two((now.getMinutes() + 1) % 60)}`, placeholder: 'HH:MM (24 hour)' })
        const m = r.value?.match(/^(\d{1,2}):(\d{2})$/)
        if (r.button !== 'ok' || !m || +m[1] > 23 || +m[2] > 59) return
        const all = alarms()
        all.push({ id: Date.now(), h: +m[1], m: +m[2], on: true, label: 'Alarm' })
        saveAlarms(all)
        toast(`Alarm set for ${fmt(+m[1], +m[2])}`)
        draw()
      })
      draw()
      body.append(list, add, h('div.dc-note', {}, 'Alarms ring while Droid is open in the browser.'))
    },
    clock() {
      const t = h('div.dc-big')
      const s = h('span.dc-sec')
      const d = h('div.dc-date')
      const tick = () => {
        const n = new Date()
        t.textContent = settings.get('time.24h') ? `${two(n.getHours())}:${two(n.getMinutes())}` : `${n.getHours() % 12 || 12}:${two(n.getMinutes())}`
        s.textContent = settings.get('time.24h') ? '' : n.getHours() < 12 ? 'AM' : 'PM'
        d.textContent = n.toLocaleDateString(settings.get('locale') || 'en', { weekday: 'short', month: 'short', day: 'numeric' }).toUpperCase()
      }
      tick()
      timers.push(window.setInterval(tick, 1000))
      const next = alarms().filter((a) => a.on)
      body.append(h('div.dc-clock', {}, h('div', {}, t, s), d, next.length ? h('div.dc-next', {}, h('img', { src: img(D, 'ic_alarm_small') }), next.map((a) => fmt(a.h, a.m)).join('  ')) : ''))
    },
    timer() {
      let left = 0, running = false, end = 0
      const disp = h('div.dc-big.dc-mono', {}, '00:00')
      const draw = () => { const v = Math.max(0, running ? end - Date.now() : left); disp.textContent = `${two(Math.floor(v / 60000))}:${two(Math.floor(v / 1000) % 60)}` }
      const set = h('div.dc-row', {}, ...[1, 3, 5, 10].map((m) => pressable(h('button.h-btn-borderless', { onclick: () => { if (!running) { left += m * 60000; draw() } } }, `+${m}m`))))
      const go = pressable(h('img.dc-ctl', { src: img(D, 'ic_start_normal') }))
      const reset = pressable(h('img.dc-ctl', { src: img(D, 'ic_reset_normal'), onclick: () => { running = false; left = 0; draw(); go.setAttribute('src', img(D, 'ic_start_normal')) } }))
      go.addEventListener('click', () => {
        if (running) { left = end - Date.now(); running = false; go.setAttribute('src', img(D, 'ic_start_normal')) }
        else if (left > 0) { end = Date.now() + left; running = true; go.setAttribute('src', img(D, 'ic_stop_normal')) }
      })
      timers.push(window.setInterval(() => { draw(); if (running && Date.now() >= end) { running = false; left = 0; ring('Time\'s up') } }, 250))
      body.append(h('div.dc-clock', {}, disp, set, h('div.dc-row', {}, reset, go)))
    },
    stopwatch() {
      let acc = 0, start = 0, running = false
      const laps: number[] = []
      const disp = h('div.dc-big.dc-mono', {}, '00:00.00')
      const lapList = h('div.dc-laps')
      const el = () => acc + (running ? Date.now() - start : 0)
      const f = (ms: number) => `${two(Math.floor(ms / 60000))}:${two(Math.floor(ms / 1000) % 60)}.${two(Math.floor(ms / 10) % 100)}`
      const draw = () => (disp.textContent = f(el()))
      const go = pressable(h('img.dc-ctl', { src: img(D, 'ic_start_normal') }))
      const lap = pressable(h('img.dc-ctl', { src: img(D, 'ic_lap_normal'), onclick: () => {
        if (running) { laps.unshift(el()); lapList.innerHTML = laps.map((l, i) => `<div><span># ${laps.length - i}</span><span>${f(l)}</span></div>`).join('') }
        else { acc = 0; laps.length = 0; lapList.innerHTML = ''; draw() }
      } }))
      go.addEventListener('click', () => {
        if (running) { acc += Date.now() - start; running = false } else { start = Date.now(); running = true }
        go.setAttribute('src', img(D, running ? 'ic_stop_normal' : 'ic_start_normal'))
        lap.setAttribute('src', img(D, running ? 'ic_lap_normal' : 'ic_reset_normal'))
      })
      timers.push(window.setInterval(() => running && draw(), 47))
      body.append(h('div.dc-clock', {}, disp, h('div.dc-row', {}, lap, go), lapList))
    },
  }
  const show = (t: string) => {
    tab = t
    clear()
    body.innerHTML = ''
    tabs.innerHTML = ''
    for (const [k, icon] of [['alarm', 'ic_alarm_normal'], ['clock', 'ic_tab_clock'], ['timer', 'ic_tab_timer'], ['stopwatch', 'ic_tab_stopwatch']]) {
      tabs.append(pressable(h('div.dc-tab' + (k === tab ? '.selected' : ''), { onclick: () => show(k) }, h('img', { src: img(D, k === tab && k !== 'alarm' ? icon + '_activated' : icon) }))))
    }
    pages[t]()
  }
  show('clock')
  return { destroy: clear, configchange: () => show(tab) }
}

const app: SystemApp = {
  manifest: {
    id: ID, name: 'Clock', version: '4.4', versioncode: 19, type: 'web', main: 'main',
    activities: { main: { label: 'Clock', launcher: true } }, system: true, supports: ['phone', 'tablet', 'desktop'],
    permissions: ['notifications', 'vibrate'],
  },
  icon: '',
  iconRef: ['apps/deskclock', 'ic_launcher_alarmclock'],
  activities: { main: clock },
  service: alarmService,
}
export default app
