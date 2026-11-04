// danen play services (role: services): account screens, settings and app data sync,
// update checks for installed dpks, push for apps (spec section 19).
import type { SystemApp, ActivityContext, Activity } from '../../shell/types'
import { RESULT_OK } from '../../shell/types'
import { page } from '../../shell/appkit'
import { h, pressable, toast } from '../../shell/ui'
import { settings } from '../../shell/settings'
import { account } from '../../shell/danen'
import { installRemote, danenApi, backendUrl } from '../../shell/danen-remote'
import { notifications } from '../../shell/notify'
import { wm } from '../../shell/wm'
import * as store from '../../runtime/db'
import { listPackages } from '../../runtime/packages'
import { loadCatalog } from '../store/catalog'

const ID = 'droid.services'
// settings that follow you (not screen size or anything device specific)
const SYNCED = ['wallpaper', 'time.24h', 'locale', 'font.scale', 'owner.name', 'net.own', 'net.saved', 'net.regions', 'sound.touch']

async function syncNow(quiet = true) {
  const a = account.get()
  if (!a?.remote || !settings.get('danen.sync') || !backendUrl() || !navigator.onLine) return
  try {
    // pull, newest wins by our local "updated" stamps
    const remoteItems = (await danenApi.getSync()).items || {}
    const lastPush = (settings.get('danen.lastSync') as number) || 0
    if (remoteItems.settings && Date.parse(remoteItems.settings.updated) > lastPush) {
      for (const [k, v] of Object.entries(remoteItems.settings.value || {})) if (SYNCED.includes(k)) settings.set(k, v as any)
    }
    for (const [k, v] of Object.entries<any>(remoteItems)) {
      if (k.startsWith('app:') && Date.parse(v.updated) > lastPush) await store.put('kv', 'danen:' + k.slice(4), v.value)
    }
    // push
    const items: Record<string, unknown> = { settings: Object.fromEntries(SYNCED.map((k) => [k, settings.get(k)])) }
    for (const k of await store.keys('kv', 'danen:')) items['app:' + k.slice(6)] = await store.get('kv', k)
    await danenApi.putSync(items)
    settings.set('danen.lastSync', Date.now())
    if (!quiet) toast('Sync complete')
  } catch (e) {
    if (!quiet) toast('Sync failed: ' + (e as Error).message)
  }
}

async function checkUpdates() {
  if (settings.get('danen.updates') === false || !navigator.onLine) return
  const cat = await loadCatalog().catch(() => null)
  if (!cat) return
  const installed = await listPackages()
  const ups = installed.filter((p) => { const l = cat.apps.find((a) => a.id === p.manifest.id); return l && l.versioncode > p.manifest.versioncode })
  if (ups.length) notifications.post({ id: 'updates', pkg: ID, title: `${ups.length} app update${ups.length > 1 ? 's' : ''} available`, text: ups.map((u) => u.manifest.name).join(', '), icon: 'assets/brand/droid-d-icon.svg', onclick: () => wm.start({ action: 'store', extras: { page: 'updates' } }) })
  else notifications.cancel(ID, 'updates')
}

// sign in / create account screen (settings > add account)
function accountActivity(ctx: ActivityContext): Activity {
  const p = page(ctx.root, { title: 'Danen account', icon: 'assets/brand/droid-d-icon.svg', up: () => ctx.finish() })
  let mode: 'create' | 'signin' = 'signin'
  const body = h('div.svc')
  p.content.append(body)
  const draw = () => {
    body.innerHTML = ''
    const nick = h('input.h-edit', { placeholder: 'Nickname' }) as HTMLInputElement
    const user = h('input.h-edit', { placeholder: 'Username', autocapitalize: 'none', autocomplete: 'username' }) as HTMLInputElement
    const pass = h('input.h-edit', { placeholder: 'Password', type: 'password', autocomplete: mode === 'create' ? 'new-password' : 'current-password' }) as HTMLInputElement
    const err = h('div.svc-err')
    const go = pressable(h('button.h-btn', {}, mode === 'create' ? 'Create account' : 'Sign in'))
    go.addEventListener('click', async () => {
      err.textContent = ''
      try {
        if (mode === 'create') await account.create(nick.value.trim() || user.value.trim(), user.value.trim(), pass.value)
        else await account.signIn(user.value.trim(), pass.value)
        toast('Account added')
        syncNow()
        ctx.finish({ code: RESULT_OK })
      } catch (e) { err.textContent = (e as Error).message }
    })
    body.append(
      h('img.svc-logo', { src: 'assets/brand/droid-d-icon.svg' }),
      h('div.svc-title', {}, mode === 'create' ? 'Create a Danen account' : 'Sign in with your Danen account'),
      mode === 'create' ? nick : '', user, pass, err, go,
      pressable(h('button.h-btn-borderless.svc-switch', { onclick: () => { mode = mode === 'create' ? 'signin' : 'create'; draw() } }, mode === 'create' ? 'I already have an account' : 'Create a new account')),
      h('div.svc-fine', {}, backendUrl() ? 'Danen only stores a nickname, a username and a password hash. Never a google password.' : 'No Danen backend is set, so the account lives only on this device. Sync starts once a backend is set.'),
    )
  }
  draw()
  return {}
}

const app: SystemApp = {
  manifest: {
    id: ID, name: 'Danen Play services', version: '4.4', versioncode: 19, type: 'web', main: 'account',
    activities: { account: { label: 'Danen account' } }, role: 'services', system: true,
    'intent-filters': [{ activity: 'account', actions: ['danen-account'] }],
    permissions: ['system.notifications', 'system.apps', 'system.settings'],
  },
  icon: 'assets/brand/droid-d-icon.svg',
  activities: { account: accountActivity },
  service() {
    // ?danen=<url> sets the backend once (handy for self-hosters)
    const q = new URLSearchParams(location.search).get('danen')
    if (q && /^https:\/\//.test(q)) settings.set('danen.backend', q)
    installRemote()
    settings.on('danen.backend', installRemote)
    addEventListener('danen:sync-now', () => syncNow(false))
    let t = 0
    addEventListener('danen:dirty', () => { clearTimeout(t); t = window.setTimeout(() => syncNow(), 5000) })
    addEventListener('online', () => syncNow())
    setTimeout(() => { syncNow(); checkUpdates() }, 8000)
    setInterval(() => { syncNow(); checkUpdates() }, 6 * 3600 * 1000)
  },
}
export default app
