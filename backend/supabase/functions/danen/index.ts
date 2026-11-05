// danen edge function (deno, supabase). routes:
//   POST /account/create   {username, nickname, password} -> {session, nickname}
//   POST /account/signin   {username, password}           -> {session, nickname}
//   POST /account/delete   (session)                       -> {}  removes the account and all its data
//   GET  /sync             (session)                       -> {items: {key: {value, updated}}}
//   PUT  /sync             (session) {items: {key: value}} -> {updated}
//   POST /push/subscribe   (session) {pkg, subscription}   -> {}
//   GET  /vapid                                            -> {key} public web push key
//   POST /push/send        (session) {pkg?, title, body}   -> {sent}  push to your own devices
//   POST /push/admin       (x-danen-push-secret) {username, pkg?, title, body} -> {sent}  server-side sends
//   GET  /store/apps                                       -> {apps}  community listings (live ones)
//   GET  /store/mine       (session)                       -> {apps}  yours, hidden ones too
//   POST /store/upload     (session) {id, versioncode, size, icon} -> {dpk, icon} signed upload urls
//   POST /store/publish    (session) {id, name, description, category, version, versioncode, size, sha256, permissions, converted, icon}
//   POST /store/unpublish  (session) {id}
//   POST /store/report     (session) {id, reason}          -> {}  5 reports hide a listing
// store files go straight from the browser to the public "droid-store" bucket with the signed urls;
// a package id belongs to whoever published it first (not the main store's ids, not droid.*), and
// updates need a higher versioncode. uploads nobody published are swept after an hour.
// the vapid key pair is generated on first use and kept in the config table (service role only).
// session = "authorization: Danen <token>". passwords: pbkdf2-sha256, 210k rounds, per-user salt.
import { createClient } from 'npm:@supabase/supabase-js@2'
import webpush from 'npm:web-push@3.6.7'

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } })
const ORIGINS = (Deno.env.get('DANEN_ORIGINS') || '*').split(',')
const enc = new TextEncoder()
const b64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b as ArrayBuffer)))
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('')
const sha = async (s: string) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)))

async function pbkdf2(password: string, salt: string) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
  return b64(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: 210000 }, key, 256))
}
function same(a: string, b: string) { // constant time compare
  if (a.length !== b.length) return false
  let r = 0
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return r === 0
}

// small per-ip limiter (per function instance)
const hits = new Map<string, { t: number; n: number }>()
function limited(ip: string, max: number) {
  const now = Date.now()
  const h = hits.get(ip)
  if (!h || now - h.t > 60000) { hits.set(ip, { t: now, n: 1 }); return false }
  return ++h.n > max
}

function cors(req: Request) {
  const o = req.headers.get('origin') || ''
  return {
    'access-control-allow-origin': ORIGINS.includes('*') ? '*' : ORIGINS.includes(o) ? o : ORIGINS[0],
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
    vary: 'origin',
  }
}
const json = (req: Request, body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...cors(req) } })

async function newSession(userId: string) {
  const token = b64(crypto.getRandomValues(new Uint8Array(32))).replace(/[+/=]/g, '')
  await db.from('sessions').insert({ token_hash: await sha(token), user_id: userId })
  return token
}
async function userOf(req: Request) {
  const m = (req.headers.get('authorization') || '').match(/^Danen (.+)$/)
  if (!m) return null
  const h = await sha(m[1])
  const { data } = await db.from('sessions').select('user_id').eq('token_hash', h).maybeSingle()
  if (!data) return null
  await db.from('sessions').update({ last_used: new Date().toISOString() }).eq('token_hash', h)
  return data.user_id as string
}

// ---------- web push ----------
let vapid: { publicKey: string; privateKey: string } | null = null
async function getVapid() {
  if (vapid) return vapid
  const { data } = await db.from('config').select('key, value').in('key', ['vapid_public', 'vapid_private'])
  const m = Object.fromEntries((data || []).map((r) => [r.key, r.value]))
  if (m.vapid_public && m.vapid_private) vapid = { publicKey: m.vapid_public, privateKey: m.vapid_private }
  else {
    const k = webpush.generateVAPIDKeys()
    // insert-only: if another instance won the race, read theirs instead
    await db.from('config').upsert([{ key: 'vapid_public', value: k.publicKey }, { key: 'vapid_private', value: k.privateKey }], { onConflict: 'key', ignoreDuplicates: true })
    vapid = null
    return getVapid()
  }
  webpush.setVapidDetails(Deno.env.get('DANEN_PUSH_CONTACT') || 'mailto:push@danen.invalid', vapid.publicKey, vapid.privateKey)
  return vapid
}
async function pushTo(userId: string, pkg: string | null, msg: { title: string; body: string; data?: unknown }) {
  await getVapid()
  let q = db.from('push_subs').select('pkg, endpoint, keys').eq('user_id', userId)
  if (pkg) q = q.eq('pkg', pkg)
  const { data } = await q
  let sent = 0
  for (const s of data || []) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, JSON.stringify({ ...msg, pkg: s.pkg }), { TTL: 86400 })
      sent++
    } catch (e) {
      // gone subscriptions are removed
      if ((e as any)?.statusCode === 404 || (e as any)?.statusCode === 410) await db.from('push_subs').delete().eq('user_id', userId).eq('endpoint', s.endpoint)
    }
  }
  return sent
}
// ---------- store ----------
const BUCKET = 'droid-store'
const MAX_DPK = 50 * 1024 * 1024
const CATS = ['tools', 'games', 'productivity', 'media', 'education', 'social', 'demo']
const ID_RE = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/
const publicUrl = (path: string) => `${Deno.env.get('SUPABASE_URL')}/storage/v1/object/public/${BUCKET}/${path}`
const listing = (r: any) => ({
  id: r.id, name: r.name, description: r.description, category: r.category, version: r.version, versioncode: r.versioncode,
  size: Number(r.size), sha256: r.sha256, permissions: r.permissions || [], author: r.nickname || 'someone', converted: r.converted,
  dpk: publicUrl(r.dpk_path), icon: r.icon_path ? publicUrl(r.icon_path) : '', screenshots: [], updated: r.updated_at, status: r.status, community: true,
})
const SELECT = 'id, owner, name, description, category, version, versioncode, size, sha256, permissions, dpk_path, icon_path, converted, status, updated_at'
// listings with their publishers' nicknames
async function withAuthors(rows: any[] | null) {
  const owners = [...new Set((rows || []).map((r) => r.owner))]
  const { data } = owners.length ? await db.from('users').select('id, nickname').in('id', owners) : { data: [] }
  const nick = new Map((data || []).map((u: any) => [u.id, u.nickname]))
  return (rows || []).map((r) => listing({ ...r, nickname: nick.get(r.owner) }))
}
async function storeFiles(id: string) {
  const { data } = await db.storage.from(BUCKET).list(id, { limit: 1000 })
  return (data || []).map((f: any) => ({ path: `${id}/${f.name}`, size: Number(f.metadata?.size ?? 0), created: Date.parse(f.created_at || '') || 0 }))
}
// package ids that are not up for grabs: the official catalog's (github pages) and droid's own
const CATALOG = Deno.env.get('DANEN_CATALOG') || 'https://jhu7600codes.github.io/droid/store/catalog.json'
let official: { at: number; ids: Set<string> } = { at: 0, ids: new Set() }
async function reserved(id: string) {
  if (id.startsWith('droid.')) return true
  if (Date.now() - official.at > 600000) {
    try { const c = await (await fetch(CATALOG)).json(); official = { at: Date.now(), ids: new Set((c.apps || []).map((a: any) => String(a.id))) } } catch { official.at = Date.now() - 540000 }
  }
  return official.ids.has(id)
}
// files no listing points to (abandoned uploads, leftovers), once they are an hour old
let lastSweep = 0
async function sweep() {
  if (Date.now() - lastSweep < 600000) return
  lastSweep = Date.now()
  const { data: dirs } = await db.storage.from(BUCKET).list('', { limit: 1000 })
  const ids = (dirs || []).map((d: any) => d.name)
  if (!ids.length) return
  const { data: rows } = await db.from('store_apps').select('dpk_path, icon_path').in('id', ids)
  const keep = new Set((rows || []).flatMap((r: any) => [r.dpk_path, r.icon_path]).filter(Boolean))
  const stale: string[] = []
  for (const id of ids) for (const f of await storeFiles(id)) if (!keep.has(f.path) && Date.now() - f.created > 3600000) stale.push(f.path)
  if (stale.length) await db.storage.from(BUCKET).remove(stale)
}

const clean = (m: any) => ({ title: String(m?.title || 'droid').slice(0, 120), body: String(m?.body || '').slice(0, 500), data: m?.data ?? null })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors(req) })
  const path = new URL(req.url).pathname.replace(/^.*\/danen/, '')
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0] || 'ip'
  try {
    if (path === '/vapid') return json(req, { key: (await getVapid()).publicKey })
    if (path === '/push/admin' && req.method === 'POST') {
      const secret = Deno.env.get('DANEN_PUSH_SECRET')
      if (!secret || !same(req.headers.get('x-danen-push-secret') || '', secret)) return json(req, { error: 'not allowed' }, 403)
      const b = await req.json()
      const { data: u } = await db.from('users').select('id').eq('username', String(b.username || '').toLowerCase()).maybeSingle()
      if (!u) return json(req, { error: 'no such user' }, 404)
      return json(req, { sent: await pushTo(u.id, b.pkg ? String(b.pkg) : null, clean(b)) })
    }

    if (path === '/account/create' && req.method === 'POST') {
      if (limited('c' + ip, 5)) return json(req, { error: 'slow down' }, 429)
      const { username, nickname, password } = await req.json()
      const u = String(username || '').toLowerCase()
      if (!/^[a-z0-9._-]{3,32}$/.test(u)) return json(req, { error: 'bad username' }, 400)
      if (typeof password !== 'string' || password.length < 8 || password.length > 200) return json(req, { error: 'password: at least 8 characters' }, 400)
      const salt = b64(crypto.getRandomValues(new Uint8Array(16)))
      const { data, error } = await db.from('users').insert({ username: u, nickname: String(nickname || u).slice(0, 40), pw_salt: salt, pw_hash: await pbkdf2(password, salt) }).select('id, nickname').single()
      if (error) return json(req, { error: error.code === '23505' ? 'that username is taken' : 'could not create account' }, 409)
      return json(req, { session: await newSession(data.id), nickname: data.nickname })
    }

    if (path === '/account/signin' && req.method === 'POST') {
      if (limited('s' + ip, 10)) return json(req, { error: 'slow down' }, 429)
      const { username, password } = await req.json()
      const { data } = await db.from('users').select('id, nickname, pw_salt, pw_hash').eq('username', String(username || '').toLowerCase()).maybeSingle()
      const hash = await pbkdf2(String(password || ''), data?.pw_salt || 'x')
      if (!data || !same(hash, data.pw_hash)) return json(req, { error: 'wrong username or password' }, 401)
      return json(req, { session: await newSession(data.id), nickname: data.nickname })
    }

    if (path === '/store/apps' && req.method === 'GET') {
      const { data, error } = await db.from('store_apps').select(SELECT).eq('status', 'live').order('updated_at', { ascending: false }).limit(1000)
      if (error) return json(req, { error: 'store unavailable' }, 500)
      return json(req, { apps: await withAuthors(data) })
    }

    const user = await userOf(req)
    if (!user) return json(req, { error: 'sign in again' }, 401)

    if (path === '/store/mine' && req.method === 'GET') {
      const { data } = await db.from('store_apps').select(SELECT).eq('owner', user).order('updated_at', { ascending: false })
      return json(req, { apps: await withAuthors(data) })
    }
    if (path === '/store/upload' && req.method === 'POST') {
      if (limited('u' + user, 10)) return json(req, { error: 'slow down' }, 429)
      const b = await req.json()
      const id = String(b.id || ''), vc = Number(b.versioncode) | 0, size = Number(b.size)
      if (!ID_RE.test(id) || id.length > 100) return json(req, { error: 'bad package id' }, 400)
      if (!(vc > 0)) return json(req, { error: 'bad versioncode' }, 400)
      if (!(size > 0) || size > MAX_DPK) return json(req, { error: 'the package must be under 50 MB' }, 413)
      if (await reserved(id)) return json(req, { error: 'that package id belongs to an app in the main store' }, 403)
      sweep().catch(() => {})
      const { data: cur } = await db.from('store_apps').select('owner, versioncode').eq('id', id).maybeSingle()
      if (cur && cur.owner !== user) return json(req, { error: 'someone else published that package id' }, 403)
      if (cur && vc <= cur.versioncode) return json(req, { error: `the store has versioncode ${cur.versioncode}: raise it to publish an update` }, 409)
      const dpk = await db.storage.from(BUCKET).createSignedUploadUrl(`${id}/${vc}.dpk`, { upsert: true })
      if (dpk.error) return json(req, { error: 'could not start the upload' }, 500)
      let icon = null
      if (b.icon) {
        const ext = String(b.icon).includes('svg') ? 'svg' : String(b.icon).includes('jpeg') ? 'jpg' : String(b.icon).includes('webp') ? 'webp' : 'png'
        const r = await db.storage.from(BUCKET).createSignedUploadUrl(`${id}/icon-${vc}.${ext}`, { upsert: true })
        if (!r.error) icon = { url: r.data.signedUrl, path: r.data.path }
      }
      return json(req, { dpk: { url: dpk.data.signedUrl, path: dpk.data.path }, icon })
    }
    if (path === '/store/publish' && req.method === 'POST') {
      const b = await req.json()
      const id = String(b.id || ''), vc = Number(b.versioncode) | 0
      if (!ID_RE.test(id)) return json(req, { error: 'bad package id' }, 400)
      if (await reserved(id)) return json(req, { error: 'that package id belongs to an app in the main store' }, 403)
      const { data: cur } = await db.from('store_apps').select('owner, versioncode').eq('id', id).maybeSingle()
      if (cur && cur.owner !== user) return json(req, { error: 'someone else published that package id' }, 403)
      if (cur && vc <= cur.versioncode) return json(req, { error: 'raise the versioncode to publish an update' }, 409)
      const files = await storeFiles(id)
      const dpk = files.find((f) => f.path === `${id}/${vc}.dpk`)
      if (!dpk) return json(req, { error: 'the package did not arrive' }, 400)
      if (dpk.size && dpk.size !== Number(b.size)) return json(req, { error: 'the package arrived with a different size' }, 400)
      if (!/^[0-9a-f]{64}$/.test(String(b.sha256))) return json(req, { error: 'bad hash' }, 400)
      const icon = files.find((f) => f.path.startsWith(`${id}/icon-${vc}.`))
      const row = {
        id, owner: user, name: String(b.name || id).slice(0, 50), description: String(b.description || '').slice(0, 4000),
        category: CATS.includes(b.category) ? b.category : 'tools', version: String(b.version || vc).slice(0, 40), versioncode: vc,
        size: Number(b.size), sha256: String(b.sha256), permissions: Array.isArray(b.permissions) ? b.permissions.slice(0, 50).map((x: unknown) => String(x).slice(0, 60)) : [],
        dpk_path: dpk.path, icon_path: icon?.path ?? null, converted: !!b.converted, updated_at: new Date().toISOString(),
      }
      const { error } = await db.from('store_apps').upsert(row)
      if (error) return json(req, { error: 'could not save the listing' }, 400)
      // older versions' files go away
      const old = files.filter((f) => f.path !== dpk.path && f.path !== icon?.path).map((f) => f.path)
      if (old.length) await db.storage.from(BUCKET).remove(old)
      return json(req, {})
    }
    if (path === '/store/unpublish' && req.method === 'POST') {
      const id = String((await req.json()).id || '')
      const { data: cur } = await db.from('store_apps').select('owner').eq('id', id).maybeSingle()
      if (!cur || cur.owner !== user) return json(req, { error: 'not yours' }, 403)
      const files = await storeFiles(id)
      if (files.length) await db.storage.from(BUCKET).remove(files.map((f) => f.path))
      await db.from('store_apps').delete().eq('id', id)
      return json(req, {})
    }
    if (path === '/store/report' && req.method === 'POST') {
      if (limited('r' + user, 10)) return json(req, { error: 'slow down' }, 429)
      const b = await req.json()
      const id = String(b.id || '')
      const { error } = await db.from('store_reports').insert({ app_id: id, user_id: user, reason: String(b.reason || '').slice(0, 500) })
      if (!error) {
        const { count } = await db.from('store_reports').select('*', { count: 'exact', head: true }).eq('app_id', id)
        await db.from('store_apps').update({ reports: count ?? 0, ...(count && count >= 5 ? { status: 'hidden' } : {}) }).eq('id', id)
      }
      return json(req, {})
    }

    if (path === '/account/delete' && req.method === 'POST') {
      // the store files of the account's apps go too (the rows cascade, the files would not)
      const { data: apps } = await db.from('store_apps').select('id').eq('owner', user)
      for (const a of apps || []) { const f = await storeFiles(a.id); if (f.length) await db.storage.from(BUCKET).remove(f.map((x) => x.path)) }
      await db.from('users').delete().eq('id', user)
      return json(req, {})
    }
    if (path === '/sync' && req.method === 'GET') {
      const { data } = await db.from('sync').select('key, value, updated_at').eq('user_id', user).limit(5000)
      return json(req, { items: Object.fromEntries((data || []).map((r) => [r.key, { value: r.value, updated: r.updated_at }])) })
    }
    if (path === '/sync' && req.method === 'PUT') {
      const text = await req.text()
      if (text.length > 5 * 1024 * 1024) return json(req, { error: 'too large' }, 413)
      const { items } = JSON.parse(text)
      const rows = Object.entries(items || {}).slice(0, 1000).map(([key, value]) => ({ user_id: user, key: key.slice(0, 200), value, updated_at: new Date().toISOString() }))
      if (rows.length) await db.from('sync').upsert(rows)
      return json(req, { updated: rows.length })
    }
    if (path === '/push/subscribe' && req.method === 'POST') {
      const { pkg, subscription } = await req.json()
      if (!subscription?.endpoint?.startsWith('https://')) return json(req, { error: 'bad subscription' }, 400)
      await db.from('push_subs').upsert({ user_id: user, pkg: String(pkg).slice(0, 100), endpoint: subscription.endpoint, keys: subscription.keys || {} })
      return json(req, {})
    }
    if (path === '/push/send' && req.method === 'POST') {
      if (limited('p' + user, 30)) return json(req, { error: 'slow down' }, 429)
      const b = await req.json()
      return json(req, { sent: await pushTo(user, b.pkg ? String(b.pkg) : null, clean(b)) })
    }
    return json(req, { error: 'not found' }, 404)
  } catch {
    return json(req, { error: 'server error' }, 500)
  }
})
