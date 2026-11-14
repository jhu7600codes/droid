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
//   GET  /vte/carriers                                     -> {carriers}  the five carriers, their plans and prices
//   GET  /vte/sims          (session)                      -> {sims}  your vSIMs (plans renew here when due)
//   POST /vte/sim           (session) {carrier}            -> {sim}   a free vSIM with a new number
//   POST /vte/sim/drop      (session) {carrier}            -> {}      gives the vSIM (and its number) back
//   POST /vte/plan          (session) {carrier, plan}      -> {sim}   change plan (plans are free)
//   POST /vte/vms/send      (session) {carrier, to, body}  -> {vms, sim}  plan first, then D$ credit
//   GET  /vte/sync?after=id (session)                      -> {vms, calls}  new messages and calls for your numbers
//   POST /vte/call          (session) {carrier, to, offer} -> {call}  rings the other side (VoVTE)
//   GET  /vte/call?id       (session)                      -> {call}  state, answer and ice of a call you are in
//   POST /vte/call/answer   (session) {id, answer}         -> {}
//   POST /vte/call/ice      (session) {id, candidates}     -> {}
//   POST /vte/call/end      (session) {id, state?}         -> {sim?}  minutes are charged to the caller
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

// ---------- vte: carriers, vSIMs, VMS and VoVTE ----------
// prices in D$ cents. plans are free and renew every `days`; credit pays for what goes past a plan.
const CARRIERS: Record<string, { name: string; host: string; prefix: string; color: string; tagline: string; welcome: number; vmsPrice: number; minutePrice: number; plans: { id: string; name: string; vms: number; minutes: number; days: number }[] }> = {
  fastline: { name: 'Fastline', host: 'fastline.vte', prefix: '701', color: '#ff6d00', tagline: 'Fast lines. Zero cost.', welcome: 4000, vmsPrice: 5, minutePrice: 20,
    plans: [{ id: 'lite', name: 'Fast Lite', vms: 200, minutes: 30, days: 7 }, { id: 'turbo', name: 'Turbo', vms: 1000, minutes: 120, days: 30 }] },
  omvte: { name: 'OMVTE', host: 'omvte.net', prefix: '702', color: '#7c4dff', tagline: 'Talk more, mind less.', welcome: 6000, vmsPrice: 4, minutePrice: 15,
    plans: [{ id: 'basic', name: 'Om Basic', vms: 300, minutes: 60, days: 30 }, { id: 'calm', name: 'Om Calm', vms: 5000, minutes: 600, days: 30 }] },
  bumble: { name: 'Bumble Line', host: 'bumble.line', prefix: '703', color: '#ffc107', tagline: 'Buzzing everywhere VTE goes.', welcome: 2500, vmsPrice: 3, minutePrice: 10,
    plans: [{ id: 'buzz', name: 'Buzz', vms: 150, minutes: 45, days: 14 }, { id: 'hive', name: 'Hive', vms: 500, minutes: 200, days: 30 }] },
  transfer: { name: 'Transfer', host: 'transfer.line', prefix: '704', color: '#00bfa5', tagline: 'Everything gets through.', welcome: 5000, vmsPrice: 5, minutePrice: 15,
    plans: [{ id: 'relay', name: 'Relay', vms: 250, minutes: 90, days: 30 }, { id: 'express', name: 'Express', vms: 800, minutes: 300, days: 30 }] },
  line: { name: 'Line Carrier', host: 'line.carrier', prefix: '705', color: '#2979ff', tagline: 'The line that is always there.', welcome: 10000, vmsPrice: 6, minutePrice: 25,
    plans: [{ id: 'standard', name: 'Standard', vms: 400, minutes: 120, days: 30 }, { id: 'plus', name: 'Standard Plus', vms: 1500, minutes: 400, days: 30 }] },
}
const planOf = (carrier: string, id: string) => CARRIERS[carrier]?.plans.find((p) => p.id === id)
const renewAt = (days: number) => new Date(Date.now() + days * 86400000).toISOString()
const simOut = (s: any) => ({ carrier: s.carrier, number: s.number, plan: s.plan, balance: s.balance, vms_left: s.vms_left, minutes_left: s.minutes_left, renews_at: s.renews_at, created_at: s.created_at })
// a plan whose period ran out starts again (unused allowance does not carry over)
async function freshen(s: any) {
  if (Date.parse(s.renews_at) > Date.now()) return s
  const p = planOf(s.carrier, s.plan)
  if (!p) return s
  const up = { vms_left: p.vms, minutes_left: p.minutes, renews_at: renewAt(p.days) }
  await db.from('vsims').update(up).eq('user_id', s.user_id).eq('carrier', s.carrier)
  return { ...s, ...up }
}
async function simsOf(user: string) {
  const { data } = await db.from('vsims').select('*').eq('user_id', user)
  return Promise.all((data || []).map(freshen))
}
async function mySim(user: string, carrier: string) {
  const { data } = await db.from('vsims').select('*').eq('user_id', user).eq('carrier', String(carrier)).maybeSingle()
  return data ? freshen(data) : null
}
const digits = (n: unknown) => String(n || '').replace(/\D/g, '')
async function ownerOf(number: string) {
  const { data } = await db.from('vsims').select('user_id, carrier').eq('number', number).maybeSingle()
  return data as { user_id: string; carrier: string } | null
}
const fmtNumber = (n: string) => `${n.slice(0, 3)} ${n.slice(3, 6)} ${n.slice(6)}`

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

    if (path === '/vte/carriers') return json(req, { carriers: Object.entries(CARRIERS).map(([id, c]) => ({ id, ...c })) })

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
    // ---------- vte ----------
    if (path === '/vte/sims' && req.method === 'GET') return json(req, { sims: (await simsOf(user)).map(simOut) })
    if (path === '/vte/sim' && req.method === 'POST') {
      if (limited('v' + user, 10)) return json(req, { error: 'slow down' }, 429)
      const { carrier } = await req.json()
      const c = CARRIERS[String(carrier)]
      if (!c) return json(req, { error: 'no such carrier' }, 400)
      const have = await mySim(user, carrier)
      if (have) return json(req, { sim: simOut(have) })
      const p = c.plans[0]
      for (let i = 0; i < 20; i++) {
        const number = c.prefix + String(Math.floor(Math.random() * 1e7)).padStart(7, '0')
        const { data, error } = await db.from('vsims').insert({ user_id: user, carrier, number, plan: p.id, balance: c.welcome, vms_left: p.vms, minutes_left: p.minutes, renews_at: renewAt(p.days) }).select('*').single()
        if (!error) return json(req, { sim: simOut(data) })
        if (error.code !== '23505') break
      }
      return json(req, { error: 'could not get a number, try again' }, 500)
    }
    if (path === '/vte/sim/drop' && req.method === 'POST') {
      const { carrier } = await req.json()
      await db.from('vsims').delete().eq('user_id', user).eq('carrier', String(carrier))
      return json(req, {})
    }
    if (path === '/vte/plan' && req.method === 'POST') {
      const { carrier, plan } = await req.json()
      const s = await mySim(user, carrier), p = planOf(String(carrier), String(plan))
      if (!s || !p) return json(req, { error: 'no such plan' }, 400)
      if (s.plan === p.id) return json(req, { sim: simOut(s) })
      const up = { plan: p.id, vms_left: p.vms, minutes_left: p.minutes, renews_at: renewAt(p.days) }
      await db.from('vsims').update(up).eq('user_id', user).eq('carrier', s.carrier)
      return json(req, { sim: simOut({ ...s, ...up }) })
    }
    if (path === '/vte/vms/send' && req.method === 'POST') {
      if (limited('m' + user, 60)) return json(req, { error: 'slow down' }, 429)
      const b = await req.json()
      const s = await mySim(user, b.carrier)
      if (!s) return json(req, { error: 'no vSIM from that carrier' }, 400)
      const to = digits(b.to), body = String(b.body || '').slice(0, 1000)
      if (!body.trim()) return json(req, { error: 'empty message' }, 400)
      const peer = await ownerOf(to)
      if (!peer) return json(req, { error: 'the number you texted is not in service' }, 404)
      const price = CARRIERS[s.carrier].vmsPrice
      let up: any
      if (s.vms_left > 0) up = { vms_left: s.vms_left - 1 }
      else if (s.balance >= price) up = { balance: s.balance - price }
      else return json(req, { error: 'no VMS left on your plan and not enough D$ credit' }, 402)
      await db.from('vsims').update(up).eq('user_id', user).eq('carrier', s.carrier)
      const { data: m } = await db.from('vms').insert({ from_number: s.number, to_number: to, body }).select('*').single()
      pushTo(peer.user_id, 'droid.messenger', { title: fmtNumber(s.number), body: body.slice(0, 200), data: { vms: m.id } }).catch(() => {})
      return json(req, { vms: m, sim: simOut({ ...s, ...up }) })
    }
    if (path === '/vte/sync' && req.method === 'GET') {
      const after = Number(new URL(req.url).searchParams.get('after')) || 0
      // messages are kept 30 days, calls 7 (now and then, whoever syncs sweeps)
      if (Math.random() < 0.01) { await db.from('vms').delete().lt('created_at', new Date(Date.now() - 30 * 86400000).toISOString()); await db.from('vcalls').delete().lt('created_at', new Date(Date.now() - 7 * 86400000).toISOString()) }
      const nums = (await simsOf(user)).map((x) => x.number)
      if (!nums.length) return json(req, { vms: [], calls: [] })
      const list = nums.map((n) => `"${n}"`).join(',')
      const { data: vms } = await db.from('vms').select('*').gt('id', after).or(`to_number.in.(${list}),from_number.in.(${list})`).order('id').limit(500)
      // ringing calls to you, and the log of the last day
      const since = new Date(Date.now() - 86400000).toISOString()
      const { data: calls } = await db.from('vcalls').select('id, from_number, to_number, state, created_at, answered_at, ended_at').gt('created_at', since).or(`to_number.in.(${list}),from_number.in.(${list})`).order('created_at', { ascending: false }).limit(100)
      // calls nobody picked up in 45 seconds are missed
      for (const c of calls || []) if (c.state === 'ringing' && Date.now() - Date.parse(c.created_at) > 45000) { c.state = 'missed'; await db.from('vcalls').update({ state: 'missed', ended_at: new Date().toISOString() }).eq('id', c.id).eq('state', 'ringing') }
      return json(req, { vms: vms || [], calls: calls || [] })
    }
    if (path === '/vte/call' && req.method === 'POST') {
      if (limited('k' + user, 20)) return json(req, { error: 'slow down' }, 429)
      const b = await req.json()
      const s = await mySim(user, b.carrier)
      if (!s) return json(req, { error: 'no vSIM from that carrier' }, 400)
      if (s.minutes_left <= 0 && s.balance < CARRIERS[s.carrier].minutePrice) return json(req, { error: 'no VoVTE minutes left on your plan and not enough D$ credit' }, 402)
      const to = digits(b.to), peer = await ownerOf(to)
      if (!peer) return json(req, { error: 'the number you called is not in service' }, 404)
      if (to === s.number) return json(req, { error: 'you cannot call yourself' }, 400)
      const { data: busy } = await db.from('vcalls').select('id').in('state', ['ringing', 'active']).or(`to_number.eq.${to},from_number.eq.${to}`).gt('created_at', new Date(Date.now() - 3600000).toISOString()).limit(1)
      const { data: c } = await db.from('vcalls').insert({ from_number: s.number, to_number: to, offer: b.offer ?? null, state: busy?.length ? 'busy' : 'ringing' }).select('id, from_number, to_number, state, created_at').single()
      if (c.state === 'ringing') pushTo(peer.user_id, 'droid.messenger', { title: 'Incoming VoVTE call', body: fmtNumber(s.number), data: { call: c.id } }).catch(() => {})
      return json(req, { call: c })
    }
    // the caller or the callee of a call (by their numbers)
    const callFor = async (id: string) => {
      const { data: c } = await db.from('vcalls').select('*').eq('id', id).maybeSingle()
      if (!c) return null
      const nums = (await simsOf(user)).map((x) => x.number)
      const side = nums.includes(c.from_number) ? 'caller' : nums.includes(c.to_number) ? 'callee' : null
      return side ? { c, side } : null
    }
    if (path === '/vte/call' && req.method === 'GET') {
      const r = await callFor(String(new URL(req.url).searchParams.get('id') || ''))
      if (!r) return json(req, { error: 'no such call' }, 404)
      const { c, side } = r
      if (c.state === 'ringing' && Date.now() - Date.parse(c.created_at) > 45000) { c.state = 'missed'; await db.from('vcalls').update({ state: 'missed', ended_at: new Date().toISOString() }).eq('id', c.id) }
      return json(req, { call: { id: c.id, from_number: c.from_number, to_number: c.to_number, state: c.state, side, offer: side === 'callee' ? c.offer : null, answer: side === 'caller' ? c.answer : null, ice: side === 'caller' ? c.callee_ice : c.caller_ice } })
    }
    if (path === '/vte/call/answer' && req.method === 'POST') {
      const b = await req.json()
      const r = await callFor(String(b.id))
      if (!r || r.side !== 'callee' || r.c.state !== 'ringing') return json(req, { error: 'the call is gone' }, 409)
      await db.from('vcalls').update({ answer: b.answer ?? null, state: 'active', answered_at: new Date().toISOString() }).eq('id', r.c.id)
      return json(req, {})
    }
    if (path === '/vte/call/ice' && req.method === 'POST') {
      const b = await req.json()
      const r = await callFor(String(b.id))
      if (!r) return json(req, { error: 'no such call' }, 404)
      const col = r.side === 'caller' ? 'caller_ice' : 'callee_ice'
      const list = [...(r.c[col] || []), ...(Array.isArray(b.candidates) ? b.candidates : [])].slice(-60)
      await db.from('vcalls').update({ [col]: list }).eq('id', r.c.id)
      return json(req, {})
    }
    if (path === '/vte/call/end' && req.method === 'POST') {
      const b = await req.json()
      const r = await callFor(String(b.id))
      if (!r) return json(req, { error: 'no such call' }, 404)
      const { c, side } = r
      if (c.state === 'ended' || c.state === 'declined' || c.state === 'missed') return json(req, {})
      const state = c.state === 'ringing' ? (side === 'callee' ? 'declined' : 'missed') : 'ended'
      await db.from('vcalls').update({ state, ended_at: new Date().toISOString() }).eq('id', c.id)
      // the caller pays: plan minutes first, then credit (whole minutes, rounded up)
      if (state === 'ended' && c.answered_at) {
        const mins = Math.max(1, Math.ceil((Date.now() - Date.parse(c.answered_at)) / 60000))
        const { data: sim } = await db.from('vsims').select('*').eq('number', c.from_number).maybeSingle()
        if (sim) {
          const fromPlan = Math.min(sim.minutes_left, mins), rest = mins - fromPlan
          const price = CARRIERS[sim.carrier].minutePrice
          await db.from('vsims').update({ minutes_left: sim.minutes_left - fromPlan, balance: Math.max(0, sim.balance - rest * price) }).eq('number', c.from_number)
        }
      }
      return json(req, {})
    }

    return json(req, { error: 'not found' }, 404)
  } catch {
    return json(req, { error: 'server error' }, 500)
  }
})
