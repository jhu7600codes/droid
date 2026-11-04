// setup wizard (spec section 22). recreated by look and flow, with original text and danen branding.
// steps: welcome/language, network, danen account, date and time, danen services, your own network,
// owner name, offline download, done.
import type { SystemApp, ActivityContext, Activity } from '../../shell/types'
import { h, pressable, dialog, toast } from '../../shell/ui'
import { settings } from '../../shell/settings'
import { brand } from '../../shell/assets'
import { REGIONS, scan, type Region, type NetDef, refreshLocation } from '../../shell/net'
import { account } from '../../shell/danen'
import { offline } from '../../shell/offline'
import './wizard.css'

const LANGS: [string, string][] = [
  ['en', 'English (United States)'], ['ru', 'Русский'], ['de', 'Deutsch'], ['es', 'Español'], ['fr', 'Français'],
  ['it', 'Italiano'], ['pt', 'Português'], ['uk', 'Українська'], ['pl', 'Polski'], ['tr', 'Türkçe'], ['ja', '日本語'], ['zh', '中文'],
]

type Step = { title: string; render: (body: HTMLElement, next: () => void) => void | (() => boolean | Promise<boolean>); noNav?: boolean; skip?: boolean }

function wizard(ctx: ActivityContext): Activity {
  const root = h('div.wiz')
  ctx.root.append(root)
  let i = 0
  let check: (() => boolean | Promise<boolean>) | void

  const steps: Step[] = [
    {
      title: 'Welcome', noNav: true,
      render(body, next) {
        const cur = LANGS.find((l) => l[0] === settings.get('locale')) || LANGS[0]
        const lang = pressable(h('div.wiz-lang', {}, h('span', {}, cur[1]), h('span.wiz-caret', {}, '▾')))
        lang.addEventListener('click', async () => {
          const r = await dialog({ title: 'Language', kind: 'list', items: LANGS.map((l) => l[1]) })
          if (r.button === 'item') { settings.set('locale', LANGS[r.index!][0]); lang.firstChild!.textContent = LANGS[r.index!][1] }
        })
        const start = pressable(h('div.wiz-start', {}, h('span', {}, 'Start'), h('span.wiz-arrow', {}, '▶')))
        start.addEventListener('click', next)
        body.append(h('img.wiz-logo', { src: brand('droid-d-icon') }), h('div.wiz-hello', {}, 'Welcome'), h('div.wiz-sub', {}, 'Droid 4.4 by Danen'), lang, h('div', { style: { flex: '1' } }), start)
      },
    },
    {
      title: 'Select a DR-Nt network', skip: true,
      render(body) {
        const regs: { r: Region; path: string }[] = []
        const walk = (r: Region, p: string) => { if (r.networks) regs.push({ r, path: p + r.name }); r.children?.forEach((c) => walk(c, p + r.name + ' › ')) }
        REGIONS.forEach((r) => walk(r, ''))
        let reg = regs.find((x) => x.r.id === settings.get('net.region')) || regs[0]
        const regBtn = pressable(h('div.h-spinner.wiz-region', {}, reg.path))
        const list = h('ul.h-list')
        const near = scan()
        const draw = () => {
          list.innerHTML = ''
          const nets: NetDef[] = [...near.filter((n) => !reg.r.networks!.some((x) => x.id === n.id)), ...reg.r.networks!]
          for (const n of nets) {
            const saved = ((settings.get('net.saved') as string[]) || []).includes(n.id)
            const li = pressable(h('li.h-item', {}, h('div.lines', {}, h('span.title', {}, n.name), h('span.summary', {}, saved ? 'Saved' : near.some((x) => x.id === n.id) ? 'In range' : 'Out of range'))))
            li.addEventListener('click', () => {
              const s = new Set((settings.get('net.saved') as string[]) || [])
              s.add(n.id)
              settings.set('net.saved', [...s])
              toast(`Saved ${n.name}`)
              draw()
            })
            list.append(li, h('li.h-divider'))
          }
        }
        regBtn.addEventListener('click', async () => {
          const r = await dialog({ title: 'Region', kind: 'list', items: regs.map((x) => x.path) })
          if (r.button === 'item') { reg = regs[r.index!]; settings.set('net.region', reg.r.id); regBtn.textContent = reg.path; draw() }
        })
        draw()
        body.append(h('div.wiz-text', {}, 'DR-Nt networks are Droid\'s pretend wi-fi. They show up in the status bar when you are inside their area. Your real connection is not changed.'), regBtn, list)
      },
    },
    {
      title: 'Danen account', skip: true,
      render(body, next) {
        let mode: 'choose' | 'create' | 'signin' = 'choose'
        const draw = () => {
          body.innerHTML = ''
          if (mode === 'choose') {
            body.append(
              h('div.wiz-text', {}, 'A Danen account keeps your Droid settings and apps in sync. It is optional: Droid works fully without one.'),
              h('div.wiz-choices', {},
                pressable(h('button.h-btn', { onclick: () => { mode = 'create'; draw() } }, 'Create a Danen account')),
                pressable(h('button.h-btn', { onclick: () => { mode = 'signin'; draw() } }, 'Sign in')),
                pressable(h('button.h-btn-borderless.wiz-notnow', { onclick: next }, 'Not now'))),
              h('div.wiz-fine', {}, 'Danen never asks for a google password. Only a nickname, a username and a password are stored. ', h('a.wiz-link', { onclick: () => privacy() }, 'Privacy')),
            )
            return
          }
          const nick = h('input.h-edit', { placeholder: 'Nickname' }) as HTMLInputElement
          const user = h('input.h-edit', { placeholder: 'Username', autocapitalize: 'none', autocomplete: 'username' }) as HTMLInputElement
          const pass = h('input.h-edit', { placeholder: 'Password', type: 'password', autocomplete: mode === 'create' ? 'new-password' : 'current-password' }) as HTMLInputElement
          const err = h('div.wiz-err')
          const go = pressable(h('button.h-btn', {}, mode === 'create' ? 'Create' : 'Sign in'))
          go.addEventListener('click', async () => {
            err.textContent = ''
            try {
              if (mode === 'create') await account.create(nick.value.trim() || user.value.trim(), user.value.trim(), pass.value)
              else await account.signIn(user.value.trim(), pass.value)
              toast(mode === 'create' ? 'Account created' : 'Signed in')
              next()
            } catch (e) { err.textContent = (e as Error).message }
          })
          body.append(h('div.wiz-text', {}, mode === 'create' ? 'Create a Danen account' : 'Sign in with your Danen account'),
            mode === 'create' ? nick : '', user, pass, err, h('div.wiz-row', {}, pressable(h('button.h-btn-borderless', { onclick: () => { mode = 'choose'; draw() } }, 'Back')), go))
        }
        draw()
      },
    },
    {
      title: 'Date & time', skip: true,
      render(body) {
        const now = h('div.wiz-big')
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
        const tick = () => (now.textContent = new Date().toLocaleString(settings.get('locale') || 'en', { dateStyle: 'medium', timeStyle: 'short', hour12: !settings.get('time.24h') }))
        tick()
        const t = setInterval(tick, 5000)
        body.addEventListener('wiz:leave', () => clearInterval(t))
        const sw = h('label.h-switch', {}, h('input', { type: 'checkbox', checked: settings.get('time.24h'), onchange: (e: Event) => { settings.set('time.24h', (e.target as HTMLInputElement).checked); tick() } }), h('span.track', {}, h('span.thumb', {}, '')))
        body.append(h('div.wiz-text', {}, 'Droid uses the time of this device.'), now,
          h('ul.h-list', {}, h('li.h-item', {}, h('div.lines', {}, h('span.title', {}, 'Time zone'), h('span.summary', {}, tz))), h('li.h-divider'),
            h('li.h-item', {}, h('div.lines', {}, h('span.title', {}, 'Use 24-hour format')), sw)))
      },
    },
    {
      title: 'Danen services', skip: true,
      render(body) {
        const row = (key: string, title: string, text: string) => {
          const c = h('input.h-check', { type: 'checkbox', checked: !!settings.get(key), onchange: (e: Event) => { settings.set(key, (e.target as HTMLInputElement).checked); if (key === 'location.on') refreshLocation() } })
          return h('li.h-item', {}, h('div.lines', {}, h('span.title', {}, title), h('span.summary', { style: { whiteSpace: 'normal' } }, text)), c)
        }
        body.append(h('ul.h-list', {},
          row('danen.sync', 'Back up and sync', 'Keep settings and app data in your Danen account. Needs an account.'), h('li.h-divider'),
          row('location.on', 'Location', 'Lets Droid use this browser\'s location for DR-Nt networks. Your location never leaves this device.'), h('li.h-divider'),
          row('danen.updates', 'App updates', 'Check the Danen store for updates to installed apps.')))
      },
    },
    {
      title: 'Your network', skip: true,
      render(body) {
        const own = (settings.get('net.own') as NetDef | undefined) || null
        const name = h('input.h-edit', { placeholder: 'Network name', value: own?.name || ((settings.get('owner.name') as string) || 'home') + '-net' }) as HTMLInputElement
        const lat = h('input.h-edit', { placeholder: 'Latitude', inputmode: 'decimal', value: own?.area.lat ?? '' }) as HTMLInputElement
        const lon = h('input.h-edit', { placeholder: 'Longitude', inputmode: 'decimal', value: own?.area.lon ?? '' }) as HTMLInputElement
        const radius = h('input', { type: 'range', min: '100', max: '20000', step: '100', value: String(own?.area.radius || 1000), class: 'wiz-range' }) as HTMLInputElement
        const rlabel = h('div.wiz-fine')
        const upd = () => (rlabel.textContent = `Radius: ${(+radius.value / 1000).toFixed(1)} km`)
        radius.addEventListener('input', upd)
        upd()
        const here = pressable(h('button.h-btn', {}, 'Use my location'))
        here.addEventListener('click', () => {
          if (!navigator.geolocation) return toast('Location is not available')
          navigator.geolocation.getCurrentPosition((p) => { lat.value = p.coords.latitude.toFixed(5); lon.value = p.coords.longitude.toFixed(5) }, () => toast('Location denied, type it in instead'))
        })
        body.append(h('div.wiz-text', {}, 'Create your own DR-Nt network. When you are outside it, Droid falls back to VTE mobile data.'), name, h('div.wiz-row', {}, lat, lon), here, radius, rlabel)
        return () => {
          if (!lat.value || !lon.value) return true // optional
          const def: NetDef = { id: 'own', name: name.value || 'my-net', kind: 'drnt', area: { lat: +lat.value, lon: +lon.value, radius: +radius.value } }
          settings.set('net.own', def)
          // you are at home while setting it up: pretend location defaults to its center
          if (!settings.get('location.pretend')) settings.set('location.pretend', { lat: def.area.lat, lon: def.area.lon })
          const s = new Set((settings.get('net.saved') as string[]) || [])
          s.add('own')
          settings.set('net.saved', [...s])
          return true
        }
      },
    },
    {
      title: 'This phone belongs to…', skip: true,
      render(body) {
        const n = h('input.h-edit', { placeholder: 'Name or nickname', value: settings.get('owner.name') || '' }) as HTMLInputElement
        body.append(h('div.wiz-text', {}, 'Shown on the lockscreen and in quick settings.'), n)
        return () => { settings.set('owner.name', n.value.trim()); return true }
      },
    },
    {
      title: 'Offline', skip: true,
      render(body) {
        let pick: 'essential' | 'full' = 'essential'
        const opt = (k: 'essential' | 'full', t: string, s: string) => h('li.h-item', { onclick: () => { pick = k; body.querySelectorAll<HTMLInputElement>('.h-radio').forEach((r) => (r.checked = r.value === k)); est() } },
          h('input.h-radio', { type: 'radio', name: 'off', value: k, checked: k === pick }), h('div.lines', {}, h('span.title', {}, t), h('span.summary', { style: { whiteSpace: 'normal' } }, s)))
        const size = h('div.wiz-fine')
        const bar = h('span.bar', { style: { width: '0%' } })
        const prog = h('span.h-progress', { style: { display: 'none' } }, bar)
        const status = h('div.wiz-fine')
        const est = async () => { const s = await offline.estimate(pick); size.textContent = `About ${(s.bytes / 1048576).toFixed(0)} MB, ${s.files} files` }
        est()
        const btn = pressable(h('button.h-btn', {}, 'Download'))
        let running = false
        btn.addEventListener('click', async () => {
          if (running) { offline.pause(); running = false; btn.textContent = 'Resume'; return }
          if (await offline.metered()) {
            const r = await dialog({ title: 'Metered connection', message: 'You may be on mobile data. Download anyway?', cancel: 'Cancel', ok: 'Download' })
            if (r.button !== 'ok') return
          }
          running = true
          btn.textContent = 'Pause'
          prog.style.display = 'block'
          await offline.download(pick, (done, total) => { bar.style.width = `${(done / total) * 100}%`; status.textContent = `${done} of ${total}` })
          if (running) { status.textContent = 'Done. Droid works offline now.'; btn.textContent = 'Downloaded'; running = false }
        })
        const ios = /iphone|ipad|ipod/i.test(navigator.userAgent)
        body.append(h('div.wiz-text', {}, 'Download Droid so it works with no network.'),
          h('ul.h-list', {}, opt('essential', 'Essential', 'The system and its apps.'), h('li.h-divider'), opt('full', 'Full', 'Also wallpapers, sounds and featured apps.')),
          size, btn, prog, status,
          h('div.wiz-fine', {}, ios ? 'Tip: tap Share, then "Add to Home Screen". Browsers may delete data of sites that are not on the home screen.' : 'Tip: install Droid from the browser menu ("Install app" or "Add to Home screen") so it is kept safe.'))
      },
    },
    {
      title: 'All done', noNav: true,
      render(body) {
        const fin = pressable(h('div.wiz-start', {}, h('span', {}, 'Finish'), h('span.wiz-arrow', {}, '▶')))
        fin.addEventListener('click', () => { settings.set('setup.done', true); ctx.finish() })
        body.append(h('img.wiz-logo', { src: brand('droid-logo') }), h('div.wiz-hello', {}, 'You\'re all set'), h('div.wiz-sub', {}, settings.get('owner.name') ? `Enjoy Droid, ${settings.get('owner.name')}.` : 'Enjoy Droid.'), h('div', { style: { flex: '1' } }), fin)
      },
    },
  ]

  function privacy() {
    dialog({ title: 'Privacy', message: 'Without an account nothing leaves this device. With a Danen account only your nickname, your username, a password hash and (if you turn on sync) your settings and app data are stored on the Danen backend. No real name, no birthdate, no phone number, no tracking, no ads.' })
  }

  function show(n: number, dir = 1) {
    root.querySelector('.wiz-body')?.dispatchEvent(new Event('wiz:leave'))
    i = n
    const s = steps[i]
    root.innerHTML = ''
    const body = h('div.wiz-body' + (s.noNav ? '.wiz-center' : ''))
    if (!s.noNav) root.append(h('div.wiz-head', {}, h('div.wiz-title', {}, s.title)), h('div.wiz-line'))
    root.append(body)
    body.style.animation = `${dir > 0 ? 'wiz-in' : 'wiz-back'} .25s ease-out`
    check = s.render(body, () => go(1))
    if (!s.noNav) {
      const back = pressable(h('div.wiz-nav-btn', {}, h('span.wiz-arrow', {}, '◀'), h('span', {}, 'Back')))
      const nxt = pressable(h('div.wiz-nav-btn.next', {}, h('span', {}, s.skip ? 'Next' : 'Next'), h('span.wiz-arrow', {}, '▶')))
      back.addEventListener('click', () => go(-1))
      nxt.addEventListener('click', () => go(1))
      const skip = s.skip ? pressable(h('div.wiz-nav-btn.skip', { onclick: () => show(Math.min(steps.length - 1, i + 1)) }, 'Skip')) : h('div')
      root.append(h('div.wiz-nav', {}, back, skip, nxt))
    }
  }
  async function go(d: number) {
    if (d > 0 && check && !(await check())) return
    const n = i + d
    if (n < 0 || n >= steps.length) return
    show(n, d)
  }
  show(0)
  return {
    back() { if (i > 0) go(-1); return true }, // the wizard can't be backed out of
  }
}

const app: SystemApp = {
  manifest: {
    id: 'droid.setupwizard', name: 'Setup Wizard', version: '4.4', versioncode: 19, type: 'web', main: 'wizard',
    activities: { wizard: { label: 'Setup' } }, role: 'setupwizard', system: true, theme: 'holo-dark',
    'intent-filters': [{ activity: 'wizard', actions: ['setup'] }],
    permissions: ['system.settings', 'system.networks'],
  },
  icon: '',
  activities: { wizard },
}
export default app
