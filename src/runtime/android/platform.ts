// still more of the java / android library, for the plugins games and apps bundle: org.json, weak
// references, charsets, data streams, gzip and crc32, hmac (javax.crypto.Mac), key stores and trust
// managers (empty, the sandbox has no network), apache http (offline), java.net.URI, BigDecimal,
// Html.fromHtml, MimeTypeMap, Observable, Timestamp and a few small ones.
import { VM, JObject, JArray, type NativeFn } from './dalvik.ts'
import { jstr, box, unbox } from './java.ts'
import { Inflater } from './inflate.ts'
import { DIGESTS } from './javamore.ts'

const OBJ = 'Ljava/lang/Object;'

// ---------- crc32 ----------
const CRC = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c } return t })()
export const crc32 = (b: Uint8Array, crc = 0) => { let c = ~crc; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return ~c >>> 0 }

// gunzip / zlib-inflate a whole buffer
export function gunzip(b: Uint8Array): Uint8Array {
  let p = 0
  if (b[0] === 0x1f && b[1] === 0x8b) {
    const flg = b[3]; p = 10
    if (flg & 4) p += 2 + (b[p] | (b[p + 1] << 8))
    if (flg & 8) { while (b[p++]); }
    if (flg & 16) { while (b[p++]); }
    if (flg & 2) p += 2
  } else if ((b[0] & 0x0f) === 8 && ((b[0] << 8) | b[1]) % 31 === 0) p = 2
  const inf = new Inflater()
  inf.push(b.subarray(p))
  const parts: Uint8Array[] = []
  let total = 0
  for (;;) {
    const done = inf.run(1 << 16)
    const t = inf.take(1 << 30)
    if (t.length) { parts.push(t.slice()); total += t.length }
    if (done || inf.done) break
    if (!t.length) break
  }
  const out = new Uint8Array(total); let o = 0
  for (const x of parts) { out.set(x, o); o += x.length }
  return out
}
// gzip with stored (uncompressed) deflate blocks: valid, just not small
export function gzipStored(b: Uint8Array): Uint8Array {
  const blocks = Math.max(1, Math.ceil(b.length / 65535))
  const out = new Uint8Array(10 + b.length + blocks * 5 + 8)
  out.set([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 255])
  let o = 10
  for (let i = 0; i < blocks; i++) {
    const part = b.subarray(i * 65535, (i + 1) * 65535)
    out[o++] = i === blocks - 1 ? 1 : 0
    out[o++] = part.length & 255; out[o++] = part.length >> 8; out[o++] = ~part.length & 255; out[o++] = (~part.length >> 8) & 255
    out.set(part, o); o += part.length
  }
  const dv = new DataView(out.buffer)
  dv.setUint32(o, crc32(b), true); dv.setUint32(o + 4, b.length, true)
  return out
}
const hmac = (alg: string, key: Uint8Array, msg: Uint8Array) => {
  const d = DIGESTS[alg], block = 64
  let k = key.length > block ? d.fn(key) : key
  const kk = new Uint8Array(block); kk.set(k)
  const ip = kk.map((x) => x ^ 0x36), op = kk.map((x) => x ^ 0x5c)
  const inner = new Uint8Array(block + msg.length); inner.set(ip); inner.set(msg, block)
  const ih = d.fn(inner)
  const outer = new Uint8Array(block + ih.length); outer.set(op); outer.set(ih, block)
  k = d.fn(outer)
  return k
}

export function registerPlatform(vm: VM) {
  const def = (name: string, sup: string, methods: Record<string, NativeFn>, extra: { interfaces?: string[]; statics?: Record<string, any> } = {}) => {
    const old = vm.shims.get(name)
    vm.shim(name, { super: old?.super ?? sup, interfaces: [...(old?.interfaces || []), ...(extra.interfaces || [])], methods: { ...(old?.methods || {}), ...methods }, statics: { ...(old?.statics || {}), ...(extra.statics || {}) } })
  }
  const obj = (cls: string, f: Record<string, any> = {}) => { const o = new JObject(vm.cls(cls)); Object.assign(o.f, f); return o }
  const noop: NativeFn = () => {}
  const text = (x: any) => (x == null ? '' : jstr(vm, x))
  const ex = (cls: string, msg: string) => vm.error(cls, msg)
  const bytesOf = (a: JArray) => new Uint8Array((a.data as Int8Array).buffer, (a.data as Int8Array).byteOffset, a.data.length)
  const byteArray = (u: Uint8Array) => { const r = vm.newArray('[B', u.length); (r.data as Int8Array).set(new Int8Array(u.buffer, u.byteOffset, u.length)); return r }
  const strArray = (l: string[]) => { const a = vm.newArray('[Ljava/lang/String;', l.length); l.forEach((x, i) => (a.data[i] = x)); return a }
  const exClass = (name: string, sup = 'Ljava/lang/Exception;') => def(name, sup, { '<init>()V': noop, '<init>(Ljava/lang/String;)V': (v, s, [m]) => { s.f.message = m }, '<init>(Ljava/lang/String;Ljava/lang/Throwable;)V': (v, s, [m, c]) => { s.f.message = m; s.f.cause = c }, '<init>(Ljava/lang/Throwable;)V': (v, s, [c]) => { s.f.cause = c; s.f.message = c?.f.message ?? null } })
  const toStr = (x: any): string => (x == null ? 'null' : typeof x === 'string' ? x : text(vm.callVirtual(x, 'toString()Ljava/lang/String;')))
  const list = (items: any[]) => { const l = vm.newObject('Ljava/util/ArrayList;'); for (const x of items) vm.callVirtual(l, 'add(Ljava/lang/Object;)Z', [x]); return l }

  // ---------- org.json ----------
  const JO = 'Lorg/json/JSONObject;', JA = 'Lorg/json/JSONArray;'
  exClass('Lorg/json/JSONException;')
  const NULL = obj(OBJ, { jsonNull: true })
  const isNull = (x: any) => x == null || x === NULL
  const jsonErr = (m: string) => ex('Lorg/json/JSONException;', m)
  // js value from JSON.parse -> java
  const fromJs = (x: any): any => {
    if (x === null) return NULL
    if (typeof x === 'string') return x
    if (typeof x === 'boolean') return box(vm, 'Ljava/lang/Boolean;', x ? 1 : 0)
    if (typeof x === 'number') return Number.isInteger(x) ? (x >= -2147483648 && x <= 2147483647 ? box(vm, 'Ljava/lang/Integer;', x) : box(vm, 'Ljava/lang/Long;', BigInt(x))) : box(vm, 'Ljava/lang/Double;', x)
    if (Array.isArray(x)) return obj(JA, { a: x.map(fromJs) })
    const m = new Map<string, any>()
    for (const [k, v] of Object.entries(x)) m.set(k, fromJs(v))
    return obj(JO, { m })
  }
  // parse, keeping big integers exact
  const parse = (src: string) => {
    const s = src.trim()
    try { return JSON.parse(s.replace(/([:\[,]\s*)(-?\d{16,})(?=\s*[,\]}])/g, '$1"\uE000$2"'), (k, v) => (typeof v === 'string' && v.startsWith('\uE000') ? { __big: v.slice(1) } : v)) }
    catch { throw jsonErr(`Value ${s.slice(0, 40)} cannot be converted`) }
  }
  const fromParsed = (x: any): any => {
    if (x && typeof x === 'object' && !Array.isArray(x) && '__big' in x) return box(vm, 'Ljava/lang/Long;', BigInt(x.__big))
    if (Array.isArray(x)) return obj(JA, { a: x.map(fromParsed) })
    if (x && typeof x === 'object') { const m = new Map<string, any>(); for (const [k, v] of Object.entries(x)) m.set(k, fromParsed(v)); return obj(JO, { m }) }
    return fromJs(x)
  }
  const quote = (s: string) => JSON.stringify(s).replace(/\//g, '\\/')
  const ser = (x: any, ind = 0, depth = 0): string => {
    const nl = ind ? '\n' + ' '.repeat(ind * (depth + 1)) : '', end = ind ? '\n' + ' '.repeat(ind * depth) : ''
    if (isNull(x)) return 'null'
    if (typeof x === 'string') return quote(x)
    if (typeof x === 'number') return String(x)
    if (x instanceof JObject) {
      if (x.cls.name === JO) return '{' + [...x.f.m].map(([k, v]) => nl + quote(k) + (ind ? ': ' : ':') + ser(v, ind, depth + 1)).join(',') + (x.f.m.size ? end : '') + '}'
      if (x.cls.name === JA) return '[' + x.f.a.map((v: any) => nl + ser(v, ind, depth + 1)).join(',') + (x.f.a.length ? end : '') + ']'
      if ('value' in x.f) { const v = x.f.value; if (x.cls.name === 'Ljava/lang/Boolean;') return v ? 'true' : 'false'; if (x.cls.name === 'Ljava/lang/Character;') return quote(String.fromCharCode(v)); return typeof v === 'number' && !Number.isFinite(v) ? 'null' : String(v) }
      if (vm.instanceOf(x, vm.cls('Ljava/util/Map;'))) return ser(wrap(x), ind, depth)
      if (vm.instanceOf(x, vm.cls('Ljava/util/Collection;'))) return ser(wrap(x), ind, depth)
    }
    return quote(toStr(x))
  }
  // a java value put into json: maps and collections become objects / arrays
  const wrap = (x: any): any => {
    if (x instanceof JObject && x.cls.name !== JO && x.cls.name !== JA && !('value' in x.f) && x !== NULL) {
      if (vm.instanceOf(x, vm.cls('Ljava/util/Map;'))) {
        const m = new Map<string, any>()
        const ks = vm.callVirtual(vm.callVirtual(x, 'keySet()Ljava/util/Set;'), 'toArray()[Ljava/lang/Object;') as JArray
        for (const k of ks.data as any[]) m.set(toStr(k), wrap(vm.callVirtual(x, 'get(Ljava/lang/Object;)Ljava/lang/Object;', [k])))
        return obj(JO, { m })
      }
      if (vm.instanceOf(x, vm.cls('Ljava/util/Collection;'))) return obj(JA, { a: [...(vm.callVirtual(x, 'toArray()[Ljava/lang/Object;') as JArray).data as any[]].map(wrap) })
    }
    if (x instanceof JArray) return obj(JA, { a: [...(x.data as any[])].map((v) => (typeof v === 'number' ? box(vm, 'Ljava/lang/Integer;', v) : wrap(v))) })
    return x ?? NULL
  }
  // conversions for getters
  const num = (x: any): number | null => { if (isNull(x)) return null; const v = unbox(x); if (typeof v === 'number') return v; if (typeof v === 'bigint') return Number(v); if (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) return Number(v); return null }
  const asBool = (x: any): number | null => { const v = unbox(x); if (x instanceof JObject && x.cls.name === 'Ljava/lang/Boolean;') return v ? 1 : 0; if (typeof v === 'string') { if (v.toLowerCase() === 'true') return 1; if (v.toLowerCase() === 'false') return 0 } return null }
  const asStr = (x: any): string => (typeof x === 'string' ? x : x instanceof JObject && (x.cls.name === JO || x.cls.name === JA) ? ser(x) : x instanceof JObject && 'value' in x.f ? ser(x) : toStr(x))
  const asLong = (x: any): bigint | null => { const v = unbox(x); if (typeof v === 'bigint') return v; const n = num(x); return n == null ? null : BigInt(Math.trunc(n)) }
  type Get = (s: JObject, k: any) => any
  const getters = (key: string, get: Get, missing: (k: any) => never) => {
    const need = (s: JObject, k: any) => { const x = get(s, k); if (x === undefined) missing(k); return x }
    const fail = (k: any, t: string): never => { throw jsonErr(`Value at ${k} cannot be converted to ${t}`) }
    return {
      [`get(${key})Ljava/lang/Object;`]: (v, s, [k]) => { const x = need(s, k); if (x === NULL) return x; return x },
      [`opt(${key})Ljava/lang/Object;`]: (v, s, [k]) => get(s, k) ?? null,
      [`getString(${key})Ljava/lang/String;`]: (v, s, [k]) => { const x = need(s, k); if (x === NULL) fail(k, 'String'); return asStr(x) },
      [`optString(${key})Ljava/lang/String;`]: (v, s, [k]) => { const x = get(s, k); return isNull(x) ? '' : asStr(x) },
      [`optString(${key}Ljava/lang/String;)Ljava/lang/String;`]: (v, s, [k, d]) => { const x = get(s, k); return isNull(x) ? d : asStr(x) },
      [`getInt(${key})I`]: (v, s, [k]) => { const n = num(need(s, k)); if (n == null) fail(k, 'int'); return Math.trunc(n!) | 0 },
      [`optInt(${key})I`]: (v, s, [k]) => { const n = num(get(s, k)); return n == null ? 0 : Math.trunc(n) | 0 },
      [`optInt(${key}I)I`]: (v, s, [k, d]) => { const n = num(get(s, k)); return n == null ? d : Math.trunc(n) | 0 },
      [`getLong(${key})J`]: (v, s, [k]) => { const n = asLong(need(s, k)); if (n == null) fail(k, 'long'); return BigInt.asIntN(64, n!) },
      [`optLong(${key})J`]: (v, s, [k]) => BigInt.asIntN(64, asLong(get(s, k)) ?? 0n),
      [`optLong(${key}J)J`]: (v, s, [k, d]) => { const n = asLong(get(s, k)); return n == null ? d : BigInt.asIntN(64, n) },
      [`getDouble(${key})D`]: (v, s, [k]) => { const n = num(need(s, k)); if (n == null) fail(k, 'double'); return n },
      [`optDouble(${key})D`]: (v, s, [k]) => num(get(s, k)) ?? NaN,
      [`optDouble(${key}D)D`]: (v, s, [k, d]) => num(get(s, k)) ?? d,
      [`getBoolean(${key})Z`]: (v, s, [k]) => { const b = asBool(need(s, k)); if (b == null) fail(k, 'boolean'); return b },
      [`optBoolean(${key})Z`]: (v, s, [k]) => asBool(get(s, k)) ?? 0,
      [`optBoolean(${key}Z)Z`]: (v, s, [k, d]) => asBool(get(s, k)) ?? d,
      [`getJSONObject(${key})Lorg/json/JSONObject;`]: (v, s, [k]) => { const x = need(s, k); if (!(x instanceof JObject && x.cls.name === JO)) fail(k, 'JSONObject'); return x },
      [`optJSONObject(${key})Lorg/json/JSONObject;`]: (v, s, [k]) => { const x = get(s, k); return x instanceof JObject && x.cls.name === JO ? x : null },
      [`getJSONArray(${key})Lorg/json/JSONArray;`]: (v, s, [k]) => { const x = need(s, k); if (!(x instanceof JObject && x.cls.name === JA)) fail(k, 'JSONArray'); return x },
      [`optJSONArray(${key})Lorg/json/JSONArray;`]: (v, s, [k]) => { const x = get(s, k); return x instanceof JObject && x.cls.name === JA ? x : null },
      [`isNull(${key})Z`]: (v, s, [k]) => (isNull(get(s, k)) ? 1 : 0),
    } as Record<string, NativeFn>
  }
  const initFrom = (s: JObject, src: string) => { const x = fromParsed(parse(src)); if (!(x instanceof JObject && x.cls.name === s.cls.name)) throw jsonErr(`Value ${src.slice(0, 40)} cannot be converted to ${s.cls.name === JO ? 'JSONObject' : 'JSONArray'}`); Object.assign(s.f, x.f) }
  def(JO, OBJ, {
    '<init>()V': (v, s) => { s.f.m = new Map() },
    '<init>(Ljava/lang/String;)V': (v, s, [src]) => initFrom(s, text(src)),
    '<init>(Lorg/json/JSONTokener;)V': (v, s, [t]) => initFrom(s, t.f.src.slice(t.f.pos)),
    '<init>(Ljava/util/Map;)V': (v, s, [m]) => { s.f.m = m ? wrap(m).f.m : new Map() },
    '<init>(Lorg/json/JSONObject;[Ljava/lang/String;)V': (v, s, [o, names]) => { s.f.m = new Map(); for (const n of names.data) if (o.f.m.has(n)) s.f.m.set(n, o.f.m.get(n)) },
    ...getters('Ljava/lang/String;', (s, k) => s.f.m.get(k), (k) => { throw jsonErr(`No value for ${k}`) }),
    'put(Ljava/lang/String;Ljava/lang/Object;)Lorg/json/JSONObject;': (v, s, [k, x]) => { if (k == null) throw jsonErr('Names must be non-null'); if (x == null) s.f.m.delete(k); else s.f.m.set(k, wrap(x)); return s },
    'put(Ljava/lang/String;I)Lorg/json/JSONObject;': (v, s, [k, x]) => { s.f.m.set(k, box(vm, 'Ljava/lang/Integer;', x)); return s },
    'put(Ljava/lang/String;J)Lorg/json/JSONObject;': (v, s, [k, x]) => { s.f.m.set(k, box(vm, 'Ljava/lang/Long;', x)); return s },
    'put(Ljava/lang/String;D)Lorg/json/JSONObject;': (v, s, [k, x]) => { if (!Number.isFinite(x)) throw jsonErr('Forbidden numeric value: ' + x); s.f.m.set(k, box(vm, 'Ljava/lang/Double;', x)); return s },
    'put(Ljava/lang/String;Z)Lorg/json/JSONObject;': (v, s, [k, x]) => { s.f.m.set(k, box(vm, 'Ljava/lang/Boolean;', x)); return s },
    'putOpt(Ljava/lang/String;Ljava/lang/Object;)Lorg/json/JSONObject;': (v, s, [k, x]) => { if (k != null && x != null) s.f.m.set(k, wrap(x)); return s },
    'accumulate(Ljava/lang/String;Ljava/lang/Object;)Lorg/json/JSONObject;': (v, s, [k, x]) => { const c = s.f.m.get(k); if (c === undefined) s.f.m.set(k, wrap(x)); else if (c.cls?.name === JA) c.f.a.push(wrap(x)); else s.f.m.set(k, obj(JA, { a: [c, wrap(x)] })); return s },
    'has(Ljava/lang/String;)Z': (v, s, [k]) => (s.f.m.has(k) ? 1 : 0),
    'remove(Ljava/lang/String;)Ljava/lang/Object;': (v, s, [k]) => { const x = s.f.m.get(k); s.f.m.delete(k); return x ?? null },
    'length()I': (v, s) => s.f.m.size,
    'keys()Ljava/util/Iterator;': (v, s) => vm.callVirtual(list([...s.f.m.keys()]), 'iterator()Ljava/util/Iterator;'),
    'keySet()Ljava/util/Set;': (v, s) => { const st = vm.newObject('Ljava/util/LinkedHashSet;'); for (const k of s.f.m.keys()) vm.callVirtual(st, 'add(Ljava/lang/Object;)Z', [k]); return st },
    'names()Lorg/json/JSONArray;': (v, s) => (s.f.m.size ? obj(JA, { a: [...s.f.m.keys()] }) : null),
    'toString()Ljava/lang/String;': (v, s) => ser(s),
    'toString(I)Ljava/lang/String;': (v, s, [n]) => ser(s, n),
    'quote(Ljava/lang/String;)Ljava/lang/String;': (v, s, [x]) => (x == null ? '""' : quote(x)),
    'numberToString(Ljava/lang/Number;)Ljava/lang/String;': (v, s, [x]) => ser(x),
    'wrap(Ljava/lang/Object;)Ljava/lang/Object;': (v, s, [x]) => wrap(x),
  }, { statics: { NULL } })
  def(JA, OBJ, {
    '<init>()V': (v, s) => { s.f.a = [] },
    '<init>(Ljava/lang/String;)V': (v, s, [src]) => initFrom(s, text(src)),
    '<init>(Lorg/json/JSONTokener;)V': (v, s, [t]) => initFrom(s, t.f.src.slice(t.f.pos)),
    '<init>(Ljava/util/Collection;)V': (v, s, [c]) => { s.f.a = c ? wrap(c).f.a : [] },
    '<init>(Ljava/lang/Object;)V': (v, s, [c]) => { s.f.a = wrap(c)?.f?.a ?? [] },
    ...getters('I', (s, i) => (i >= 0 && i < s.f.a.length ? s.f.a[i] : undefined), (i) => { throw jsonErr(`Index ${i} out of range`) }),
    'length()I': (v, s) => s.f.a.length,
    'put(Ljava/lang/Object;)Lorg/json/JSONArray;': (v, s, [x]) => { s.f.a.push(wrap(x)); return s },
    'put(I)Lorg/json/JSONArray;': (v, s, [x]) => { s.f.a.push(box(vm, 'Ljava/lang/Integer;', x)); return s },
    'put(J)Lorg/json/JSONArray;': (v, s, [x]) => { s.f.a.push(box(vm, 'Ljava/lang/Long;', x)); return s },
    'put(D)Lorg/json/JSONArray;': (v, s, [x]) => { s.f.a.push(box(vm, 'Ljava/lang/Double;', x)); return s },
    'put(Z)Lorg/json/JSONArray;': (v, s, [x]) => { s.f.a.push(box(vm, 'Ljava/lang/Boolean;', x)); return s },
    'put(ILjava/lang/Object;)Lorg/json/JSONArray;': (v, s, [i, x]) => { while (s.f.a.length < i) s.f.a.push(NULL); s.f.a[i] = wrap(x); return s },
    'put(II)Lorg/json/JSONArray;': (v, s, [i, x]) => { while (s.f.a.length < i) s.f.a.push(NULL); s.f.a[i] = box(vm, 'Ljava/lang/Integer;', x); return s },
    'remove(I)Ljava/lang/Object;': (v, s, [i]) => (i >= 0 && i < s.f.a.length ? s.f.a.splice(i, 1)[0] : null),
    'join(Ljava/lang/String;)Ljava/lang/String;': (v, s, [sep]) => s.f.a.map((x: any) => ser(x)).join(sep),
    'toString()Ljava/lang/String;': (v, s) => ser(s),
    'toString(I)Ljava/lang/String;': (v, s, [n]) => ser(s, n),
    'equals(Ljava/lang/Object;)Z': (v, s, [o]) => (o?.cls?.name === JA && ser(o) === ser(s) ? 1 : 0),
  })
  def('Lorg/json/JSONTokener;', OBJ, {
    '<init>(Ljava/lang/String;)V': (v, s, [src]) => { s.f.src = text(src); s.f.pos = 0 },
    'nextValue()Ljava/lang/Object;': (v, s) => {
      const rest = s.f.src.slice(s.f.pos).trimStart()
      // a whole value: take the longest prefix that parses (objects / arrays end at their bracket)
      const val = parse(rest)
      s.f.pos = s.f.src.length
      return fromParsed(val)
    },
    'more()Z': (v, s) => (s.f.pos < s.f.src.length ? 1 : 0),
    'next()C': (v, s) => (s.f.pos < s.f.src.length ? s.f.src.charCodeAt(s.f.pos++) : 0),
    'back()V': (v, s) => { if (s.f.pos > 0) s.f.pos-- },
    'nextClean()C': (v, s) => { while (s.f.pos < s.f.src.length && /\s/.test(s.f.src[s.f.pos])) s.f.pos++; return s.f.pos < s.f.src.length ? s.f.src.charCodeAt(s.f.pos++) : 0 },
    'skipPast(Ljava/lang/String;)V': (v, s, [x]) => { const i = s.f.src.indexOf(x, s.f.pos); s.f.pos = i < 0 ? s.f.src.length : i + x.length },
  })
  def('Lorg/json/JSONStringer;', OBJ, {
    '<init>()V': (v, s) => { s.f.stack = [] as any[]; s.f.root = null; s.f.key = null },
    'object()Lorg/json/JSONStringer;': (v, s) => { const o = obj(JO, { m: new Map() }); addTo(s, o); s.f.stack.push(o); return s },
    'array()Lorg/json/JSONStringer;': (v, s) => { const o = obj(JA, { a: [] }); addTo(s, o); s.f.stack.push(o); return s },
    'endObject()Lorg/json/JSONStringer;': (v, s) => { s.f.stack.pop(); return s },
    'endArray()Lorg/json/JSONStringer;': (v, s) => { s.f.stack.pop(); return s },
    'key(Ljava/lang/String;)Lorg/json/JSONStringer;': (v, s, [k]) => { s.f.key = k; return s },
    'value(Ljava/lang/Object;)Lorg/json/JSONStringer;': (v, s, [x]) => { addTo(s, wrap(x)); return s },
    'value(J)Lorg/json/JSONStringer;': (v, s, [x]) => { addTo(s, box(vm, 'Ljava/lang/Long;', x)); return s },
    'value(D)Lorg/json/JSONStringer;': (v, s, [x]) => { addTo(s, box(vm, 'Ljava/lang/Double;', x)); return s },
    'value(Z)Lorg/json/JSONStringer;': (v, s, [x]) => { addTo(s, box(vm, 'Ljava/lang/Boolean;', x)); return s },
    'toString()Ljava/lang/String;': (v, s) => (s.f.root ? ser(s.f.root) : null),
  })
  const addTo = (s: JObject, x: any) => {
    const top = s.f.stack[s.f.stack.length - 1]
    if (!top) s.f.root = x
    else if (top.cls.name === JO) top.f.m.set(s.f.key, x)
    else top.f.a.push(x)
  }

  // ---------- references ----------
  for (const r of ['Ljava/lang/ref/Reference;', 'Ljava/lang/ref/WeakReference;', 'Ljava/lang/ref/SoftReference;', 'Ljava/lang/ref/PhantomReference;'])
    def(r, r === 'Ljava/lang/ref/Reference;' ? OBJ : 'Ljava/lang/ref/Reference;', {
      '<init>(Ljava/lang/Object;)V': (v, s, [x]) => { s.f.ref = x },
      '<init>(Ljava/lang/Object;Ljava/lang/ref/ReferenceQueue;)V': (v, s, [x]) => { s.f.ref = x },
      'get()Ljava/lang/Object;': (v, s) => s.f.ref ?? null, 'clear()V': (v, s) => { s.f.ref = null }, 'enqueue()Z': () => 0, 'isEnqueued()Z': () => 0,
    })
  def('Ljava/lang/ref/ReferenceQueue;', OBJ, { '<init>()V': noop, 'poll()Ljava/lang/ref/Reference;': () => null, 'remove()Ljava/lang/ref/Reference;': () => null, 'remove(J)Ljava/lang/ref/Reference;': () => null })

  // ---------- charsets ----------
  const CS = 'Ljava/nio/charset/Charset;'
  const canon = (n: string) => { const x = n.toUpperCase().replace(/_/g, '-'); return x === 'UTF8' ? 'UTF-8' : x === 'LATIN1' || x === 'ISO8859-1' ? 'ISO-8859-1' : x }
  const known = new Set(['UTF-8', 'US-ASCII', 'ISO-8859-1', 'UTF-16', 'UTF-16BE', 'UTF-16LE'])
  const charset = (n: string) => obj(CS, { name: canon(n) })
  def(CS, OBJ, {
    'forName(Ljava/lang/String;)Ljava/nio/charset/Charset;': (v, s, [n]) => { if (!known.has(canon(text(n)))) throw ex('Ljava/nio/charset/UnsupportedCharsetException;', text(n)); return charset(text(n)) },
    'isSupported(Ljava/lang/String;)Z': (v, s, [n]) => (known.has(canon(text(n))) ? 1 : 0),
    'defaultCharset()Ljava/nio/charset/Charset;': () => charset('UTF-8'),
    'name()Ljava/lang/String;': (v, s) => s.f.name, 'displayName()Ljava/lang/String;': (v, s) => s.f.name, 'toString()Ljava/lang/String;': (v, s) => s.f.name,
    'equals(Ljava/lang/Object;)Z': (v, s, [o]) => (o?.f?.name === s.f.name ? 1 : 0), 'hashCode()I': (v, s) => s.f.name.length,
    'encode(Ljava/lang/String;)Ljava/nio/ByteBuffer;': (v, s, [x]) => vm.callStatic('Ljava/nio/ByteBuffer;', 'wrap([B)Ljava/nio/ByteBuffer;', [vm.callVirtual(x, 'getBytes(Ljava/lang/String;)[B', [s.f.name])]),
    'newEncoder()Ljava/nio/charset/CharsetEncoder;': (v, s) => obj('Ljava/nio/charset/CharsetEncoder;', { cs: s }),
    'newDecoder()Ljava/nio/charset/CharsetDecoder;': (v, s) => obj('Ljava/nio/charset/CharsetDecoder;', { cs: s }),
  })
  exClass('Ljava/nio/charset/UnsupportedCharsetException;', 'Ljava/lang/IllegalArgumentException;')
  exClass('Ljava/nio/charset/IllegalCharsetNameException;', 'Ljava/lang/IllegalArgumentException;')
  def('Ljava/nio/charset/StandardCharsets;', OBJ, {}, { statics: { UTF_8: charset('UTF-8'), US_ASCII: charset('US-ASCII'), ISO_8859_1: charset('ISO-8859-1'), UTF_16: charset('UTF-16'), UTF_16BE: charset('UTF-16BE'), UTF_16LE: charset('UTF-16LE') } })
  def('Ljava/lang/String;', OBJ, {
    'getBytes(Ljava/nio/charset/Charset;)[B': (v, s, [c]) => vm.callVirtual(s, 'getBytes(Ljava/lang/String;)[B', [c?.f.name ?? 'UTF-8']),
    '<init>([BLjava/nio/charset/Charset;)V': noop,
  })

  // ---------- data streams ----------
  const pull = (s: JObject, n: number): Uint8Array => {
    const src = s.f.in
    const out = new Uint8Array(n)
    for (let i = 0; i < n; i++) { const b = vm.callVirtual(src, 'read()I') as number; if (b < 0) throw ex('Ljava/io/EOFException;', 'EOF'); out[i] = b }
    return out
  }
  const dv = (u: Uint8Array) => new DataView(u.buffer, u.byteOffset, u.length)
  exClass('Ljava/io/EOFException;', 'Ljava/io/IOException;')
  const delegateIn: Record<string, NativeFn> = {
    'read()I': (v, s) => vm.callVirtual(s.f.in, 'read()I'),
    'read([B)I': (v, s, [a]) => vm.callVirtual(s.f.in, 'read([BII)I', [a, 0, a.data.length]),
    'read([BII)I': (v, s, [a, o, n]) => vm.callVirtual(s.f.in, 'read([BII)I', [a, o, n]),
    'available()I': (v, s) => vm.callVirtual(s.f.in, 'available()I'),
    'skip(J)J': (v, s, [n]) => vm.callVirtual(s.f.in, 'skip(J)J', [n]),
    'close()V': (v, s) => { vm.callVirtual(s.f.in, 'close()V') },
    'mark(I)V': (v, s, [n]) => { vm.callVirtual(s.f.in, 'mark(I)V', [n]) }, 'reset()V': (v, s) => { vm.callVirtual(s.f.in, 'reset()V') }, 'markSupported()Z': (v, s) => vm.callVirtual(s.f.in, 'markSupported()Z'),
  }
  def('Ljava/io/FilterInputStream;', 'Ljava/io/InputStream;', { '<init>(Ljava/io/InputStream;)V': (v, s, [i]) => { s.f.in = i }, ...delegateIn })
  def('Ljava/io/DataInputStream;', 'Ljava/io/FilterInputStream;', {
    '<init>(Ljava/io/InputStream;)V': (v, s, [i]) => { s.f.in = i }, ...delegateIn,
    'readFully([B)V': (v, s, [a]) => { bytesOf(a).set(pull(s, a.data.length)) },
    'readFully([BII)V': (v, s, [a, o, n]) => { bytesOf(a).set(pull(s, n), o) },
    'readByte()B': (v, s) => dv(pull(s, 1)).getInt8(0), 'readUnsignedByte()I': (v, s) => pull(s, 1)[0],
    'readBoolean()Z': (v, s) => (pull(s, 1)[0] ? 1 : 0),
    'readShort()S': (v, s) => dv(pull(s, 2)).getInt16(0), 'readUnsignedShort()I': (v, s) => dv(pull(s, 2)).getUint16(0), 'readChar()C': (v, s) => dv(pull(s, 2)).getUint16(0),
    'readInt()I': (v, s) => dv(pull(s, 4)).getInt32(0), 'readLong()J': (v, s) => dv(pull(s, 8)).getBigInt64(0),
    'readFloat()F': (v, s) => dv(pull(s, 4)).getFloat32(0), 'readDouble()D': (v, s) => dv(pull(s, 8)).getFloat64(0),
    'readUTF()Ljava/lang/String;': (v, s) => { const n = dv(pull(s, 2)).getUint16(0); return new TextDecoder().decode(pull(s, n)) },
    'readLine()Ljava/lang/String;': (v, s) => { let out = '', b; while ((b = vm.callVirtual(s.f.in, 'read()I') as number) >= 0 && b !== 10) if (b !== 13) out += String.fromCharCode(b); return b < 0 && !out ? null : out },
    'skipBytes(I)I': (v, s, [n]) => Number(vm.callVirtual(s.f.in, 'skip(J)J', [BigInt(n)])),
  })
  const put = (s: JObject, u: Uint8Array) => { s.f.written = (s.f.written ?? 0) + u.length; vm.callVirtual(s.f.out, 'write([BII)V', [byteArray(u), 0, u.length]) }
  const bytes = (n: number, f: (d: DataView) => void) => { const u = new Uint8Array(n); f(dv(u)); return u }
  const delegateOut: Record<string, NativeFn> = {
    'write(I)V': (v, s, [b]) => put(s, Uint8Array.of(b & 255)),
    'write([B)V': (v, s, [a]) => put(s, bytesOf(a).slice()),
    'write([BII)V': (v, s, [a, o, n]) => put(s, bytesOf(a).slice(o, o + n)),
    'flush()V': (v, s) => { vm.callVirtual(s.f.out, 'flush()V') }, 'close()V': (v, s) => { vm.callVirtual(s.f.out, 'close()V') },
  }
  def('Ljava/io/FilterOutputStream;', 'Ljava/io/OutputStream;', { '<init>(Ljava/io/OutputStream;)V': (v, s, [o]) => { s.f.out = o }, ...delegateOut })
  def('Ljava/io/DataOutputStream;', 'Ljava/io/FilterOutputStream;', {
    '<init>(Ljava/io/OutputStream;)V': (v, s, [o]) => { s.f.out = o }, ...delegateOut,
    'writeByte(I)V': (v, s, [x]) => put(s, Uint8Array.of(x & 255)), 'writeBoolean(Z)V': (v, s, [x]) => put(s, Uint8Array.of(x ? 1 : 0)),
    'writeShort(I)V': (v, s, [x]) => put(s, bytes(2, (d) => d.setInt16(0, x))), 'writeChar(I)V': (v, s, [x]) => put(s, bytes(2, (d) => d.setUint16(0, x))),
    'writeInt(I)V': (v, s, [x]) => put(s, bytes(4, (d) => d.setInt32(0, x))), 'writeLong(J)V': (v, s, [x]) => put(s, bytes(8, (d) => d.setBigInt64(0, BigInt.asIntN(64, BigInt(x))))),
    'writeFloat(F)V': (v, s, [x]) => put(s, bytes(4, (d) => d.setFloat32(0, x))), 'writeDouble(D)V': (v, s, [x]) => put(s, bytes(8, (d) => d.setFloat64(0, x))),
    'writeUTF(Ljava/lang/String;)V': (v, s, [x]) => { const u = new TextEncoder().encode(text(x)); put(s, bytes(2, (d) => d.setUint16(0, u.length))); put(s, u) },
    'writeBytes(Ljava/lang/String;)V': (v, s, [x]) => put(s, Uint8Array.from(text(x), (c) => c.charCodeAt(0) & 255)),
    'writeChars(Ljava/lang/String;)V': (v, s, [x]) => { const t = text(x); put(s, bytes(t.length * 2, (d) => { for (let i = 0; i < t.length; i++) d.setUint16(i * 2, t.charCodeAt(i)) })) },
    'size()I': (v, s) => s.f.written ?? 0,
  })

  // ---------- gzip, crc32, adler32 ----------
  const drainAll = (i: JObject): Uint8Array => {
    if (i?.f?.buf instanceof Uint8Array) return i.f.buf.subarray(i.f.pos)
    const parts: number[] = []
    const a = vm.newArray('[B', 8192)
    for (;;) { const n = vm.callVirtual(i, 'read([BII)I', [a, 0, 8192]) as number; if (n <= 0) break; for (let k = 0; k < n; k++) parts.push((a.data as Int8Array)[k] & 255) }
    return Uint8Array.from(parts)
  }
  const gzIn: NativeFn = (v, s, [i]) => { s.f.buf = gunzip(drainAll(i)); s.f.pos = 0 }
  def('Ljava/util/zip/InflaterInputStream;', 'Ljava/io/InputStream;', { '<init>(Ljava/io/InputStream;)V': gzIn, '<init>(Ljava/io/InputStream;Ljava/util/zip/Inflater;)V': gzIn, '<init>(Ljava/io/InputStream;Ljava/util/zip/Inflater;I)V': gzIn })
  def('Ljava/util/zip/GZIPInputStream;', 'Ljava/util/zip/InflaterInputStream;', { '<init>(Ljava/io/InputStream;)V': gzIn, '<init>(Ljava/io/InputStream;I)V': gzIn })
  const gzOut: NativeFn = (v, s, [o]) => { s.f.dest = o; s.f.parts = [] }
  const gzFinish = (s: JObject) => {
    if (s.f.finished) return
    s.f.finished = true
    const total = s.f.parts.reduce((n: number, p: Uint8Array) => n + p.length, 0), all = new Uint8Array(total); let k = 0
    for (const p of s.f.parts) { all.set(p, k); k += p.length }
    const z = gzipStored(all)
    vm.callVirtual(s.f.dest, 'write([BII)V', [byteArray(z), 0, z.length])
  }
  def('Ljava/util/zip/GZIPOutputStream;', 'Ljava/io/OutputStream;', {
    '<init>(Ljava/io/OutputStream;)V': gzOut, '<init>(Ljava/io/OutputStream;I)V': gzOut,
    'write(I)V': (v, s, [b]) => { s.f.parts.push(Uint8Array.of(b & 255)) },
    'write([B)V': (v, s, [a]) => { s.f.parts.push(bytesOf(a).slice()) },
    'write([BII)V': (v, s, [a, o, n]) => { s.f.parts.push(bytesOf(a).slice(o, o + n)) },
    'finish()V': (v, s) => gzFinish(s), 'flush()V': noop,
    'close()V': (v, s) => { gzFinish(s); vm.callVirtual(s.f.dest, 'close()V') },
  })
  def('Ljava/util/zip/CRC32;', OBJ, {
    '<init>()V': (v, s) => { s.f.c = 0 },
    'update(I)V': (v, s, [b]) => { s.f.c = crc32(Uint8Array.of(b & 255), s.f.c) },
    'update([B)V': (v, s, [a]) => { s.f.c = crc32(bytesOf(a), s.f.c) },
    'update([BII)V': (v, s, [a, o, n]) => { s.f.c = crc32(bytesOf(a).subarray(o, o + n), s.f.c) },
    'getValue()J': (v, s) => BigInt(s.f.c >>> 0), 'reset()V': (v, s) => { s.f.c = 0 },
  }, { interfaces: ['Ljava/util/zip/Checksum;'] })
  const adler = (b: Uint8Array, a0: number) => { let a = a0 & 0xffff, c = a0 >>> 16; for (const x of b) { a = (a + x) % 65521; c = (c + a) % 65521 } return ((c << 16) | a) >>> 0 }
  def('Ljava/util/zip/Adler32;', OBJ, {
    '<init>()V': (v, s) => { s.f.c = 1 },
    'update(I)V': (v, s, [b]) => { s.f.c = adler(Uint8Array.of(b & 255), s.f.c) },
    'update([B)V': (v, s, [a]) => { s.f.c = adler(bytesOf(a), s.f.c) },
    'update([BII)V': (v, s, [a, o, n]) => { s.f.c = adler(bytesOf(a).subarray(o, o + n), s.f.c) },
    'getValue()J': (v, s) => BigInt(s.f.c >>> 0), 'reset()V': (v, s) => { s.f.c = 1 },
  }, { interfaces: ['Ljava/util/zip/Checksum;'] })

  // ---------- crypto: hmac, keys; key stores and trust managers are empty ----------
  const algOf = (n: string) => n.toUpperCase().replace(/^HMAC/, '').replace('SHA1', 'SHA-1').replace('SHA256', 'SHA-256').replace('MD5', 'MD5')
  exClass('Ljava/security/GeneralSecurityException;')
  for (const n of ['NoSuchAlgorithmException', 'InvalidKeyException', 'KeyStoreException', 'SignatureException', 'UnrecoverableKeyException', 'KeyManagementException']) exClass(`Ljava/security/${n};`, 'Ljava/security/GeneralSecurityException;')
  exClass('Ljava/security/spec/InvalidKeySpecException;', 'Ljava/security/GeneralSecurityException;')
  for (const n of ['NoSuchPaddingException', 'IllegalBlockSizeException', 'BadPaddingException']) exClass(`Ljavax/crypto/${n};`, 'Ljava/security/GeneralSecurityException;')
  exClass('Ljava/security/cert/CertificateException;', 'Ljava/security/GeneralSecurityException;')
  def('Ljavax/crypto/spec/SecretKeySpec;', OBJ, {
    '<init>([BLjava/lang/String;)V': (v, s, [a, alg]) => { s.f.key = bytesOf(a).slice(); s.f.alg = text(alg) },
    '<init>([BIILjava/lang/String;)V': (v, s, [a, o, n, alg]) => { s.f.key = bytesOf(a).slice(o, o + n); s.f.alg = text(alg) },
    'getEncoded()[B': (v, s) => byteArray(s.f.key), 'getAlgorithm()Ljava/lang/String;': (v, s) => s.f.alg, 'getFormat()Ljava/lang/String;': () => 'RAW',
  }, { interfaces: ['Ljavax/crypto/SecretKey;', 'Ljava/security/Key;'] })
  def('Ljavax/crypto/spec/IvParameterSpec;', OBJ, { '<init>([B)V': (v, s, [a]) => { s.f.iv = bytesOf(a).slice() }, 'getIV()[B': (v, s) => byteArray(s.f.iv) })
  def('Ljavax/crypto/Mac;', OBJ, {
    'getInstance(Ljava/lang/String;)Ljavax/crypto/Mac;': (v, s, [n]) => { const a = algOf(text(n)); if (!DIGESTS[a]) throw ex('Ljava/security/NoSuchAlgorithmException;', text(n)); return obj('Ljavax/crypto/Mac;', { alg: a, name: text(n), parts: [] }) },
    'init(Ljava/security/Key;)V': (v, s, [k]) => { s.f.key = k?.f.key ?? new Uint8Array(); s.f.parts = [] },
    'update(B)V': (v, s, [b]) => { s.f.parts.push(Uint8Array.of(b & 255)) },
    'update([B)V': (v, s, [a]) => { s.f.parts.push(bytesOf(a).slice()) },
    'update([BII)V': (v, s, [a, o, n]) => { s.f.parts.push(bytesOf(a).slice(o, o + n)) },
    'doFinal()[B': (v, s) => macFinal(s), 'doFinal([B)[B': (v, s, [a]) => { s.f.parts.push(bytesOf(a).slice()); return macFinal(s) },
    'getMacLength()I': (v, s) => DIGESTS[s.f.alg].len, 'getAlgorithm()Ljava/lang/String;': (v, s) => s.f.name, 'reset()V': (v, s) => { s.f.parts = [] },
  })
  const macFinal = (s: JObject) => {
    const total = s.f.parts.reduce((n: number, p: Uint8Array) => n + p.length, 0), all = new Uint8Array(total); let k = 0
    for (const p of s.f.parts) { all.set(p, k); k += p.length }
    s.f.parts = []
    return byteArray(hmac(s.f.alg, s.f.key, all))
  }
  // ciphers need real keys and are mostly for licence checks / receipts: say the transform is missing
  def('Ljavax/crypto/Cipher;', OBJ, {
    'getInstance(Ljava/lang/String;)Ljavax/crypto/Cipher;': (v, s, [n]) => { throw ex('Ljava/security/NoSuchAlgorithmException;', `Cipher ${text(n)} implementation not found`) },
    'getInstance(Ljava/lang/String;Ljava/lang/String;)Ljavax/crypto/Cipher;': (v, s, [n]) => { throw ex('Ljava/security/NoSuchAlgorithmException;', `Cipher ${text(n)} implementation not found`) },
  }, { statics: { ENCRYPT_MODE: 1, DECRYPT_MODE: 2, WRAP_MODE: 3, UNWRAP_MODE: 4 } })
  def('Ljavax/crypto/SecretKeyFactory;', OBJ, { 'getInstance(Ljava/lang/String;)Ljavax/crypto/SecretKeyFactory;': (v, s, [n]) => { throw ex('Ljava/security/NoSuchAlgorithmException;', `SecretKeyFactory ${text(n)} implementation not found`) } })
  def('Ljavax/crypto/spec/PBEKeySpec;', OBJ, { '<init>([C[BII)V': noop, '<init>([C)V': noop })
  def('Ljava/security/spec/X509EncodedKeySpec;', OBJ, { '<init>([B)V': (v, s, [a]) => { s.f.key = bytesOf(a).slice() }, 'getEncoded()[B': (v, s) => byteArray(s.f.key) })
  def('Ljava/security/KeyFactory;', OBJ, {
    'getInstance(Ljava/lang/String;)Ljava/security/KeyFactory;': (v, s, [n]) => obj('Ljava/security/KeyFactory;', { alg: text(n) }),
    'generatePublic(Ljava/security/spec/KeySpec;)Ljava/security/PublicKey;': (v, s, [spec]) => obj('Ljava/security/PublicKey;', { key: spec?.f.key, alg: s.f.alg }),
  })
  def('Ljava/security/PublicKey;', OBJ, { 'getEncoded()[B': (v, s) => byteArray(s.f.key ?? new Uint8Array()), 'getAlgorithm()Ljava/lang/String;': (v, s) => s.f.alg ?? 'RSA' })
  // signatures (in-app purchase receipts): nothing here can verify them, so they do not verify
  def('Ljava/security/Signature;', OBJ, {
    'getInstance(Ljava/lang/String;)Ljava/security/Signature;': (v, s, [n]) => obj('Ljava/security/Signature;', { alg: text(n) }),
    'initVerify(Ljava/security/PublicKey;)V': noop, 'initSign(Ljava/security/PrivateKey;)V': noop,
    'update([B)V': noop, 'update([BII)V': noop, 'update(B)V': noop,
    'verify([B)Z': () => 0, 'sign()[B': () => byteArray(new Uint8Array(0)),
  })
  def('Ljava/security/KeyStore;', OBJ, {
    'getDefaultType()Ljava/lang/String;': () => 'BKS',
    'getInstance(Ljava/lang/String;)Ljava/security/KeyStore;': (v, s, [n]) => obj('Ljava/security/KeyStore;', { type: text(n), entries: new Map() }),
    'load(Ljava/io/InputStream;[C)V': noop, 'load(Ljava/security/KeyStore$LoadStoreParameter;)V': noop,
    'getType()Ljava/lang/String;': (v, s) => s.f.type,
    'setCertificateEntry(Ljava/lang/String;Ljava/security/cert/Certificate;)V': (v, s, [a, c]) => { s.f.entries.set(text(a), c) },
    'getCertificate(Ljava/lang/String;)Ljava/security/cert/Certificate;': (v, s, [a]) => s.f.entries.get(text(a)) ?? null,
    'containsAlias(Ljava/lang/String;)Z': (v, s, [a]) => (s.f.entries.has(text(a)) ? 1 : 0),
    'aliases()Ljava/util/Enumeration;': (v, s) => vm.callStatic('Ljava/util/Collections;', 'enumeration(Ljava/util/Collection;)Ljava/util/Enumeration;', [list([...s.f.entries.keys()])]),
    'size()I': (v, s) => s.f.entries.size, 'deleteEntry(Ljava/lang/String;)V': (v, s, [a]) => { s.f.entries.delete(text(a)) },
  })
  def('Ljava/security/cert/CertificateFactory;', OBJ, {
    'getInstance(Ljava/lang/String;)Ljava/security/cert/CertificateFactory;': () => obj('Ljava/security/cert/CertificateFactory;'),
    'generateCertificate(Ljava/io/InputStream;)Ljava/security/cert/Certificate;': () => obj('Ljava/security/cert/X509Certificate;'),
  })
  def('Ljava/security/cert/Certificate;', OBJ, { 'getEncoded()[B': () => byteArray(new Uint8Array(0)), 'getPublicKey()Ljava/security/PublicKey;': () => obj('Ljava/security/PublicKey;') })
  def('Ljava/security/cert/X509Certificate;', 'Ljava/security/cert/Certificate;', { 'checkValidity()V': noop, 'getSubjectDN()Ljava/security/Principal;': () => null, 'getIssuerDN()Ljava/security/Principal;': () => null })
  const factory = (cls: string, extra: Record<string, NativeFn>) => def(cls, OBJ, {
    [`getInstance(Ljava/lang/String;)${cls}`]: () => obj(cls),
    [`getDefaultAlgorithm()Ljava/lang/String;`]: () => 'PKIX',
    ...extra,
  })
  factory('Ljavax/net/ssl/TrustManagerFactory;', {
    'init(Ljava/security/KeyStore;)V': noop,
    'getTrustManagers()[Ljavax/net/ssl/TrustManager;': () => { const a = vm.newArray('[Ljavax/net/ssl/TrustManager;', 1); a.data[0] = obj('Ljavax/net/ssl/X509TrustManager;'); return a },
  })
  factory('Ljavax/net/ssl/KeyManagerFactory;', {
    'init(Ljava/security/KeyStore;[C)V': noop,
    'getKeyManagers()[Ljavax/net/ssl/KeyManager;': () => vm.newArray('[Ljavax/net/ssl/KeyManager;', 0),
  })
  def('Ljavax/net/ssl/X509TrustManager;', OBJ, {
    'checkServerTrusted([Ljava/security/cert/X509Certificate;Ljava/lang/String;)V': noop,
    'checkClientTrusted([Ljava/security/cert/X509Certificate;Ljava/lang/String;)V': noop,
    'getAcceptedIssuers()[Ljava/security/cert/X509Certificate;': () => vm.newArray('[Ljava/security/cert/X509Certificate;', 0),
  }, { interfaces: ['Ljavax/net/ssl/TrustManager;'] })

  // ---------- sockets and apache http: no network in the sandbox ----------
  const offline = (host = '') => ex('Ljava/net/UnknownHostException;', `Unable to resolve host "${host}": No address associated with hostname`)
  def('Ljava/net/Socket;', OBJ, {
    '<init>()V': noop,
    '<init>(Ljava/lang/String;I)V': (v, s, [h]) => { throw offline(text(h)) },
    '<init>(Ljava/net/InetAddress;I)V': () => { throw offline() },
    'connect(Ljava/net/SocketAddress;)V': () => { throw offline() }, 'connect(Ljava/net/SocketAddress;I)V': () => { throw offline() },
    'close()V': noop, 'isConnected()Z': () => 0, 'isClosed()Z': () => 1,
    'getInputStream()Ljava/io/InputStream;': () => { throw ex('Ljava/net/SocketException;', 'Socket is not connected') },
    'getOutputStream()Ljava/io/OutputStream;': () => { throw ex('Ljava/net/SocketException;', 'Socket is not connected') },
    'setSoTimeout(I)V': noop, 'setTcpNoDelay(Z)V': noop, 'setKeepAlive(Z)V': noop,
  })
  exClass('Ljava/net/SocketException;', 'Ljava/io/IOException;')
  exClass('Ljava/net/SocketTimeoutException;', 'Ljava/io/InterruptedIOException;')
  exClass('Ljava/io/InterruptedIOException;', 'Ljava/io/IOException;')
  def('Ljava/net/InetSocketAddress;', 'Ljava/net/SocketAddress;', {
    '<init>(Ljava/lang/String;I)V': (v, s, [h, p]) => { s.f.host = text(h); s.f.port = p },
    '<init>(I)V': (v, s, [p]) => { s.f.host = '0.0.0.0'; s.f.port = p },
    'getHostName()Ljava/lang/String;': (v, s) => s.f.host, 'getPort()I': (v, s) => s.f.port,
  })
  def('Ljava/net/SocketAddress;', OBJ, {})
  def('Ljavax/net/ssl/SSLSocketFactory;', 'Ljavax/net/SocketFactory;', {
    'createSocket()Ljava/net/Socket;': () => obj('Ljava/net/Socket;'),
    'createSocket(Ljava/net/Socket;Ljava/lang/String;IZ)Ljava/net/Socket;': (v, s, [, h]) => { throw offline(text(h)) },
    'createSocket(Ljava/lang/String;I)Ljava/net/Socket;': (v, s, [h]) => { throw offline(text(h)) },
  })
  def('Ljava/net/NetworkInterface;', OBJ, {
    'getNetworkInterfaces()Ljava/util/Enumeration;': () => vm.callStatic('Ljava/util/Collections;', 'enumeration(Ljava/util/Collection;)Ljava/util/Enumeration;', [list([])]),
    'getByName(Ljava/lang/String;)Ljava/net/NetworkInterface;': () => null,
  })
  const AH = 'Lorg/apache/http/'
  const holder = (cls: string, sup = OBJ, m: Record<string, NativeFn> = {}) => def(cls, sup, { '<init>()V': noop, ...m })
  holder(AH + 'params/BasicHttpParams;', OBJ, { 'setParameter(Ljava/lang/String;Ljava/lang/Object;)Lorg/apache/http/params/HttpParams;': (v, s) => s, 'setIntParameter(Ljava/lang/String;I)Lorg/apache/http/params/HttpParams;': (v, s) => s, 'setBooleanParameter(Ljava/lang/String;Z)Lorg/apache/http/params/HttpParams;': (v, s) => s, 'getParameter(Ljava/lang/String;)Ljava/lang/Object;': () => null })
  def(AH + 'params/HttpConnectionParams;', OBJ, {
    'setConnectionTimeout(Lorg/apache/http/params/HttpParams;I)V': noop, 'setSoTimeout(Lorg/apache/http/params/HttpParams;I)V': noop, 'setSocketBufferSize(Lorg/apache/http/params/HttpParams;I)V': noop,
    'setStaleCheckingEnabled(Lorg/apache/http/params/HttpParams;Z)V': noop, 'setTcpNoDelay(Lorg/apache/http/params/HttpParams;Z)V': noop,
  })
  def(AH + 'params/HttpProtocolParams;', OBJ, {
    'setVersion(Lorg/apache/http/params/HttpParams;Lorg/apache/http/ProtocolVersion;)V': noop, 'setContentCharset(Lorg/apache/http/params/HttpParams;Ljava/lang/String;)V': noop,
    'setUserAgent(Lorg/apache/http/params/HttpParams;Ljava/lang/String;)V': noop, 'setUseExpectContinue(Lorg/apache/http/params/HttpParams;Z)V': noop,
  })
  def(AH + 'conn/params/ConnManagerParams;', OBJ, { 'setMaxTotalConnections(Lorg/apache/http/params/HttpParams;I)V': noop, 'setTimeout(Lorg/apache/http/params/HttpParams;J)V': noop })
  def(AH + 'client/params/HttpClientParams;', OBJ, { 'setRedirecting(Lorg/apache/http/params/HttpParams;Z)V': noop })
  def(AH + 'HttpVersion;', OBJ, {}, { statics: { HTTP_1_1: obj(AH + 'HttpVersion;'), HTTP_1_0: obj(AH + 'HttpVersion;') } })
  holder(AH + 'conn/scheme/SchemeRegistry;', OBJ, { 'register(Lorg/apache/http/conn/scheme/Scheme;)Lorg/apache/http/conn/scheme/Scheme;': (v, s, [x]) => x })
  def(AH + 'conn/scheme/Scheme;', OBJ, { '<init>(Ljava/lang/String;Lorg/apache/http/conn/scheme/SocketFactory;I)V': noop })
  def(AH + 'conn/scheme/PlainSocketFactory;', OBJ, { 'getSocketFactory()Lorg/apache/http/conn/scheme/PlainSocketFactory;': () => obj(AH + 'conn/scheme/PlainSocketFactory;') }, { interfaces: [AH + 'conn/scheme/SocketFactory;'] })
  def(AH + 'conn/ssl/SSLSocketFactory;', OBJ, {
    'getSocketFactory()Lorg/apache/http/conn/ssl/SSLSocketFactory;': () => obj(AH + 'conn/ssl/SSLSocketFactory;'),
    '<init>(Ljava/security/KeyStore;)V': noop, 'setHostnameVerifier(Lorg/apache/http/conn/ssl/X509HostnameVerifier;)V': noop,
  }, { interfaces: [AH + 'conn/scheme/SocketFactory;'], statics: { ALLOW_ALL_HOSTNAME_VERIFIER: null, STRICT_HOSTNAME_VERIFIER: null, BROWSER_COMPATIBLE_HOSTNAME_VERIFIER: null } })
  def(AH + 'impl/conn/tsccm/ThreadSafeClientConnManager;', OBJ, { '<init>(Lorg/apache/http/params/HttpParams;Lorg/apache/http/conn/scheme/SchemeRegistry;)V': noop, 'shutdown()V': noop })
  def(AH + 'impl/conn/SingleClientConnManager;', OBJ, { '<init>(Lorg/apache/http/params/HttpParams;Lorg/apache/http/conn/scheme/SchemeRegistry;)V': noop, 'shutdown()V': noop })
  const hostOf = (req: JObject | null) => { try { return new URL(String(req?.f.uri ?? '')).hostname } catch { return '' } }
  const client: Record<string, NativeFn> = {
    '<init>()V': noop,
    '<init>(Lorg/apache/http/params/HttpParams;)V': noop,
    '<init>(Lorg/apache/http/conn/ClientConnectionManager;Lorg/apache/http/params/HttpParams;)V': noop,
    'execute(Lorg/apache/http/client/methods/HttpUriRequest;)Lorg/apache/http/HttpResponse;': (v, s, [r]) => { throw offline(hostOf(r)) },
    'execute(Lorg/apache/http/client/methods/HttpUriRequest;Lorg/apache/http/protocol/HttpContext;)Lorg/apache/http/HttpResponse;': (v, s, [r]) => { throw offline(hostOf(r)) },
    'execute(Lorg/apache/http/client/methods/HttpUriRequest;Lorg/apache/http/client/ResponseHandler;)Ljava/lang/Object;': (v, s, [r]) => { throw offline(hostOf(r)) },
    'getParams()Lorg/apache/http/params/HttpParams;': () => obj(AH + 'params/BasicHttpParams;'),
    'getConnectionManager()Lorg/apache/http/conn/ClientConnectionManager;': () => obj(AH + 'impl/conn/SingleClientConnManager;'),
    'getCredentialsProvider()Lorg/apache/http/client/CredentialsProvider;': () => obj(AH + 'impl/client/BasicCredentialsProvider;'),
    'setCredentialsProvider(Lorg/apache/http/client/CredentialsProvider;)V': noop, 'setParams(Lorg/apache/http/params/HttpParams;)V': noop,
    'addRequestInterceptor(Lorg/apache/http/HttpRequestInterceptor;)V': noop, 'addResponseInterceptor(Lorg/apache/http/HttpResponseInterceptor;)V': noop,
    'setHttpRequestRetryHandler(Lorg/apache/http/client/HttpRequestRetryHandler;)V': noop, 'setRedirectHandler(Lorg/apache/http/client/RedirectHandler;)V': noop,
    'close()V': noop,
  }
  def(AH + 'impl/client/AbstractHttpClient;', OBJ, client, { interfaces: [AH + 'client/HttpClient;'] })
  def(AH + 'impl/client/DefaultHttpClient;', AH + 'impl/client/AbstractHttpClient;', client)
  def('Landroid/net/http/AndroidHttpClient;', OBJ, { 'newInstance(Ljava/lang/String;)Landroid/net/http/AndroidHttpClient;': () => obj('Landroid/net/http/AndroidHttpClient;'), 'newInstance(Ljava/lang/String;Landroid/content/Context;)Landroid/net/http/AndroidHttpClient;': () => obj('Landroid/net/http/AndroidHttpClient;'), ...client })
  const req: Record<string, NativeFn> = {
    '<init>()V': noop,
    '<init>(Ljava/lang/String;)V': (v, s, [u]) => { s.f.uri = text(u) },
    '<init>(Ljava/net/URI;)V': (v, s, [u]) => { s.f.uri = u?.f.s ?? '' },
    'setURI(Ljava/net/URI;)V': (v, s, [u]) => { s.f.uri = u?.f.s ?? '' },
    'getURI()Ljava/net/URI;': (v, s) => obj('Ljava/net/URI;', { s: s.f.uri }),
    'addHeader(Ljava/lang/String;Ljava/lang/String;)V': noop, 'setHeader(Ljava/lang/String;Ljava/lang/String;)V': noop, 'addHeader(Lorg/apache/http/Header;)V': noop, 'setHeader(Lorg/apache/http/Header;)V': noop,
    'setEntity(Lorg/apache/http/HttpEntity;)V': noop, 'setParams(Lorg/apache/http/params/HttpParams;)V': noop, 'getParams()Lorg/apache/http/params/HttpParams;': () => obj(AH + 'params/BasicHttpParams;'),
    'abort()V': noop, 'getMethod()Ljava/lang/String;': (v, s) => s.cls.name.match(/Http(\w+);$/)?.[1].toUpperCase() ?? 'GET',
  }
  def(AH + 'client/methods/HttpRequestBase;', OBJ, req, { interfaces: [AH + 'client/methods/HttpUriRequest;'] })
  def(AH + 'client/methods/HttpEntityEnclosingRequestBase;', AH + 'client/methods/HttpRequestBase;', req)
  for (const m of ['HttpGet', 'HttpDelete', 'HttpHead']) def(`${AH}client/methods/${m};`, AH + 'client/methods/HttpRequestBase;', req)
  for (const m of ['HttpPost', 'HttpPut']) def(`${AH}client/methods/${m};`, AH + 'client/methods/HttpEntityEnclosingRequestBase;', req)
  const entity = (cls: string, init: Record<string, NativeFn>) => def(cls, AH + 'entity/AbstractHttpEntity;', { ...init, 'setContentType(Ljava/lang/String;)V': noop, 'setContentEncoding(Ljava/lang/String;)V': noop, 'setChunked(Z)V': noop, 'getContentLength()J': (v, s) => BigInt(s.f.body?.length ?? 0), 'getContent()Ljava/io/InputStream;': (v, s) => vm.newObject('Ljava/io/ByteArrayInputStream;', '<init>([B)V', [byteArray(s.f.body ?? new Uint8Array())]) })
  def(AH + 'entity/AbstractHttpEntity;', OBJ, {}, { interfaces: [AH + 'HttpEntity;'] })
  entity(AH + 'entity/StringEntity;', { '<init>(Ljava/lang/String;)V': (v, s, [t]) => { s.f.body = new TextEncoder().encode(text(t)) }, '<init>(Ljava/lang/String;Ljava/lang/String;)V': (v, s, [t]) => { s.f.body = new TextEncoder().encode(text(t)) } })
  entity(AH + 'entity/ByteArrayEntity;', { '<init>([B)V': (v, s, [a]) => { s.f.body = bytesOf(a).slice() } })
  entity(AH + 'entity/InputStreamEntity;', { '<init>(Ljava/io/InputStream;J)V': noop })
  entity(AH + 'client/entity/UrlEncodedFormEntity;', {
    '<init>(Ljava/util/List;)V': (v, s, [l]) => { s.f.body = new TextEncoder().encode(form(l)) },
    '<init>(Ljava/util/List;Ljava/lang/String;)V': (v, s, [l]) => { s.f.body = new TextEncoder().encode(form(l)) },
  })
  const form = (l: JObject) => [...(vm.callVirtual(l, 'toArray()[Ljava/lang/Object;') as JArray).data as any[]].map((p) => encodeURIComponent(p.f.name) + '=' + encodeURIComponent(p.f.value ?? '')).join('&')
  def(AH + 'message/BasicNameValuePair;', OBJ, {
    '<init>(Ljava/lang/String;Ljava/lang/String;)V': (v, s, [n, x]) => { s.f.name = n; s.f.value = x },
    'getName()Ljava/lang/String;': (v, s) => s.f.name, 'getValue()Ljava/lang/String;': (v, s) => s.f.value ?? null,
    'toString()Ljava/lang/String;': (v, s) => `${s.f.name}=${s.f.value ?? ''}`,
  }, { interfaces: [AH + 'NameValuePair;'] })
  def(AH + 'message/BasicHeader;', OBJ, {
    '<init>(Ljava/lang/String;Ljava/lang/String;)V': (v, s, [n, x]) => { s.f.name = n; s.f.value = x },
    'getName()Ljava/lang/String;': (v, s) => s.f.name, 'getValue()Ljava/lang/String;': (v, s) => s.f.value ?? null,
  }, { interfaces: [AH + 'Header;'] })
  def(AH + 'client/utils/URLEncodedUtils;', OBJ, {
    'format(Ljava/util/List;Ljava/lang/String;)Ljava/lang/String;': (v, s, [l]) => form(l),
    'parse(Ljava/net/URI;Ljava/lang/String;)Ljava/util/List;': (v, s, [u]) => { const q = String(u?.f.s ?? '').split('?')[1] ?? ''; return list(q ? q.split('&').map((kv) => { const [k, x = ''] = kv.split('='); return obj(AH + 'message/BasicNameValuePair;', { name: decodeURIComponent(k), value: decodeURIComponent(x) }) }) : []) },
  })
  def(AH + 'util/EntityUtils;', OBJ, {
    'toString(Lorg/apache/http/HttpEntity;)Ljava/lang/String;': (v, s, [e]) => new TextDecoder().decode(e?.f.body ?? new Uint8Array()),
    'toString(Lorg/apache/http/HttpEntity;Ljava/lang/String;)Ljava/lang/String;': (v, s, [e]) => new TextDecoder().decode(e?.f.body ?? new Uint8Array()),
    'toByteArray(Lorg/apache/http/HttpEntity;)[B': (v, s, [e]) => byteArray(e?.f.body ?? new Uint8Array()),
    'consume(Lorg/apache/http/HttpEntity;)V': noop,
  })
  holder(AH + 'impl/client/BasicCredentialsProvider;', OBJ, { 'setCredentials(Lorg/apache/http/auth/AuthScope;Lorg/apache/http/auth/Credentials;)V': noop })
  def(AH + 'auth/UsernamePasswordCredentials;', OBJ, { '<init>(Ljava/lang/String;Ljava/lang/String;)V': noop, '<init>(Ljava/lang/String;)V': noop })
  def(AH + 'auth/AuthScope;', OBJ, { '<init>(Ljava/lang/String;I)V': noop }, { statics: { ANY: null, ANY_HOST: null, ANY_PORT: -1 } })
  holder(AH + 'impl/auth/BasicScheme;', OBJ, { 'authenticate(Lorg/apache/http/auth/Credentials;Lorg/apache/http/HttpRequest;)Lorg/apache/http/Header;': () => obj(AH + 'message/BasicHeader;', { name: 'Authorization', value: '' }) })
  exClass(AH + 'client/ClientProtocolException;', 'Ljava/io/IOException;')
  exClass(AH + 'conn/ConnectTimeoutException;', 'Ljava/io/InterruptedIOException;')

  // ---------- java.net.URI ----------
  const URI = 'Ljava/net/URI;'
  const up = (s: JObject): URL | null => { try { return new URL(String(s.f.s)) } catch { return null } }
  def(URI, OBJ, {
    '<init>(Ljava/lang/String;)V': (v, s, [x]) => { if (x == null) throw ex('Ljava/lang/NullPointerException;', 'uri'); if (/\s/.test(text(x))) throw ex('Ljava/net/URISyntaxException;', 'Illegal character in ' + text(x)); s.f.s = text(x) },
    '<init>(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;ILjava/lang/String;Ljava/lang/String;Ljava/lang/String;)V': (v, s, [sc, ui, h, p, path, q, fr]) => { s.f.s = `${sc ? text(sc) + ':' : ''}${h ? '//' + (ui ? text(ui) + '@' : '') + text(h) + (p >= 0 ? ':' + p : '') : ''}${path ? encodeURI(text(path)) : ''}${q ? '?' + encodeURI(text(q)) : ''}${fr ? '#' + encodeURI(text(fr)) : ''}` },
    '<init>(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V': (v, s, [sc, h, path, fr]) => { s.f.s = `${text(sc)}://${text(h)}${path ? encodeURI(text(path)) : ''}${fr ? '#' + encodeURI(text(fr)) : ''}` },
    'create(Ljava/lang/String;)Ljava/net/URI;': (v, s, [x]) => obj(URI, { s: text(x) }),
    'getScheme()Ljava/lang/String;': (v, s) => String(s.f.s).match(/^([a-zA-Z][\w+.-]*):/)?.[1] ?? null,
    'getHost()Ljava/lang/String;': (v, s) => up(s)?.hostname || null, 'getPort()I': (v, s) => Number(up(s)?.port || -1),
    'getPath()Ljava/lang/String;': (v, s) => { const p = up(s); return p ? decodeURIComponent(p.pathname) : String(s.f.s).split(/[?#]/)[0] },
    'getRawPath()Ljava/lang/String;': (v, s) => up(s)?.pathname ?? String(s.f.s).split(/[?#]/)[0],
    'getQuery()Ljava/lang/String;': (v, s) => { const q = up(s)?.search; return q ? decodeURIComponent(q.slice(1)) : null },
    'getRawQuery()Ljava/lang/String;': (v, s) => { const q = up(s)?.search; return q ? q.slice(1) : null },
    'getFragment()Ljava/lang/String;': (v, s) => { const q = up(s)?.hash; return q ? decodeURIComponent(q.slice(1)) : null },
    'getAuthority()Ljava/lang/String;': (v, s) => up(s)?.host || null, 'getUserInfo()Ljava/lang/String;': (v, s) => up(s)?.username || null,
    'isAbsolute()Z': (v, s) => (/^[a-zA-Z][\w+.-]*:/.test(String(s.f.s)) ? 1 : 0),
    'resolve(Ljava/lang/String;)Ljava/net/URI;': (v, s, [x]) => { try { return obj(URI, { s: new URL(text(x), String(s.f.s)).href }) } catch { return obj(URI, { s: text(x) }) } },
    'resolve(Ljava/net/URI;)Ljava/net/URI;': (v, s, [x]) => { try { return obj(URI, { s: new URL(String(x.f.s), String(s.f.s)).href }) } catch { return x } },
    'normalize()Ljava/net/URI;': (v, s) => s,
    'toString()Ljava/lang/String;': (v, s) => String(s.f.s), 'toASCIIString()Ljava/lang/String;': (v, s) => encodeURI(decodeURI(String(s.f.s))),
    'toURL()Ljava/net/URL;': (v, s) => vm.newObject('Ljava/net/URL;', '<init>(Ljava/lang/String;)V', [String(s.f.s)]),
    'equals(Ljava/lang/Object;)Z': (v, s, [o]) => (o?.f?.s === s.f.s ? 1 : 0), 'hashCode()I': (v, s) => String(s.f.s).length,
  })
  exClass('Ljava/net/URISyntaxException;')

  // ---------- small ones ----------
  def('Ljava/math/BigDecimal;', 'Ljava/lang/Number;', {
    '<init>(Ljava/lang/String;)V': (v, s, [x]) => { s.f.v = Number(text(x)); s.f.str = text(x) },
    '<init>(D)V': (v, s, [x]) => { s.f.v = x }, '<init>(I)V': (v, s, [x]) => { s.f.v = x }, '<init>(J)V': (v, s, [x]) => { s.f.v = Number(x) },
    'valueOf(D)Ljava/math/BigDecimal;': (v, s, [x]) => obj('Ljava/math/BigDecimal;', { v: x }),
    'valueOf(J)Ljava/math/BigDecimal;': (v, s, [x]) => obj('Ljava/math/BigDecimal;', { v: Number(x) }),
    'doubleValue()D': (v, s) => s.f.v, 'floatValue()F': (v, s) => Math.fround(s.f.v), 'intValue()I': (v, s) => Math.trunc(s.f.v) | 0, 'longValue()J': (v, s) => BigInt(Math.trunc(s.f.v)),
    'add(Ljava/math/BigDecimal;)Ljava/math/BigDecimal;': (v, s, [o]) => obj('Ljava/math/BigDecimal;', { v: s.f.v + o.f.v }),
    'subtract(Ljava/math/BigDecimal;)Ljava/math/BigDecimal;': (v, s, [o]) => obj('Ljava/math/BigDecimal;', { v: s.f.v - o.f.v }),
    'multiply(Ljava/math/BigDecimal;)Ljava/math/BigDecimal;': (v, s, [o]) => obj('Ljava/math/BigDecimal;', { v: s.f.v * o.f.v }),
    'divide(Ljava/math/BigDecimal;)Ljava/math/BigDecimal;': (v, s, [o]) => obj('Ljava/math/BigDecimal;', { v: s.f.v / o.f.v }),
    'setScale(II)Ljava/math/BigDecimal;': (v, s, [n]) => obj('Ljava/math/BigDecimal;', { v: Math.round(s.f.v * 10 ** n) / 10 ** n, scale: n }),
    'compareTo(Ljava/math/BigDecimal;)I': (v, s, [o]) => Math.sign(s.f.v - o.f.v),
    'toString()Ljava/lang/String;': (v, s) => s.f.str ?? (s.f.scale != null ? s.f.v.toFixed(s.f.scale) : String(s.f.v)),
    'toPlainString()Ljava/lang/String;': (v, s) => s.f.str ?? (s.f.scale != null ? s.f.v.toFixed(s.f.scale) : String(s.f.v)),
  })
  const stripHtml = (h: string) => { const d = new DOMParser().parseFromString(h.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n'), 'text/html'); return (d.body.textContent || '').replace(/\n+$/, '') }
  def('Landroid/text/Html;', OBJ, {
    'fromHtml(Ljava/lang/String;)Landroid/text/Spanned;': (v, s, [h]) => stripHtml(text(h)),
    'fromHtml(Ljava/lang/String;I)Landroid/text/Spanned;': (v, s, [h]) => stripHtml(text(h)),
    'fromHtml(Ljava/lang/String;Landroid/text/Html$ImageGetter;Landroid/text/Html$TagHandler;)Landroid/text/Spanned;': (v, s, [h]) => stripHtml(text(h)),
    'toHtml(Landroid/text/Spanned;)Ljava/lang/String;': (v, s, [x]) => text(x).replace(/&/g, '&amp;').replace(/</g, '&lt;'),
    'escapeHtml(Ljava/lang/CharSequence;)Ljava/lang/String;': (v, s, [x]) => text(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
  })
  const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', mp4: 'video/mp4', webm: 'video/webm', '3gp': 'video/3gpp', mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/x-wav', m4a: 'audio/mp4', txt: 'text/plain', html: 'text/html', htm: 'text/html', json: 'application/json', xml: 'text/xml', pdf: 'application/pdf', zip: 'application/zip', apk: 'application/vnd.android.package-archive' }
  def('Landroid/webkit/MimeTypeMap;', OBJ, {
    'getSingleton()Landroid/webkit/MimeTypeMap;': () => obj('Landroid/webkit/MimeTypeMap;'),
    'getFileExtensionFromUrl(Ljava/lang/String;)Ljava/lang/String;': (v, s, [u]) => { const m = text(u).split(/[?#]/)[0].match(/\.([\w]+)$/); return m ? m[1].toLowerCase() : '' },
    'getMimeTypeFromExtension(Ljava/lang/String;)Ljava/lang/String;': (v, s, [e]) => MIME[text(e).toLowerCase()] ?? null,
    'getExtensionFromMimeType(Ljava/lang/String;)Ljava/lang/String;': (v, s, [m]) => Object.entries(MIME).find(([, x]) => x === text(m))?.[0] ?? null,
    'hasExtension(Ljava/lang/String;)Z': (v, s, [e]) => (text(e).toLowerCase() in MIME ? 1 : 0),
    'hasMimeType(Ljava/lang/String;)Z': (v, s, [m]) => (Object.values(MIME).includes(text(m)) ? 1 : 0),
  })
  def('Ljava/util/Observable;', OBJ, {
    '<init>()V': (v, s) => { s.f.obs = []; s.f.changed = false },
    'addObserver(Ljava/util/Observer;)V': (v, s, [o]) => { if (!s.f.obs.includes(o)) s.f.obs.push(o) },
    'deleteObserver(Ljava/util/Observer;)V': (v, s, [o]) => { s.f.obs = s.f.obs.filter((x: any) => x !== o) },
    'deleteObservers()V': (v, s) => { s.f.obs = [] }, 'countObservers()I': (v, s) => s.f.obs.length,
    'setChanged()V': (v, s) => { s.f.changed = true }, 'clearChanged()V': (v, s) => { s.f.changed = false }, 'hasChanged()Z': (v, s) => (s.f.changed ? 1 : 0),
    'notifyObservers()V': (v, s) => vm.callVirtual(s, 'notifyObservers(Ljava/lang/Object;)V', [null]),
    'notifyObservers(Ljava/lang/Object;)V': (v, s, [a]) => { if (!s.f.changed) return; s.f.changed = false; for (const o of [...s.f.obs].reverse()) vm.callVirtual(o, 'update(Ljava/util/Observable;Ljava/lang/Object;)V', [s, a]) },
  })
  def('Ljava/sql/Timestamp;', 'Ljava/util/Date;', {
    '<init>(J)V': (v, s, [t]) => { s.f.t = Number(t) },
    'getTime()J': (v, s) => BigInt(s.f.t), 'toString()Ljava/lang/String;': (v, s) => new Date(s.f.t).toISOString().replace('T', ' ').replace('Z', ''),
    'valueOf(Ljava/lang/String;)Ljava/sql/Timestamp;': (v, s, [x]) => obj('Ljava/sql/Timestamp;', { t: Date.parse(text(x).replace(' ', 'T')) || 0 }),
  })
  def('Landroid/text/TextUtils$SimpleStringSplitter;', OBJ, {
    '<init>(C)V': (v, s, [c]) => { s.f.sep = String.fromCharCode(c); s.f.parts = []; s.f.i = 0 },
    'setString(Ljava/lang/String;)V': (v, s, [x]) => { s.f.parts = text(x) ? text(x).split(s.f.sep) : []; s.f.i = 0 },
    'hasNext()Z': (v, s) => (s.f.i < s.f.parts.length ? 1 : 0), 'next()Ljava/lang/String;': (v, s) => s.f.parts[s.f.i++],
    'iterator()Ljava/util/Iterator;': (v, s) => vm.callVirtual(list(s.f.parts.slice(s.f.i)), 'iterator()Ljava/util/Iterator;'),
  }, { interfaces: ['Ljava/util/Iterator;', 'Ljava/lang/Iterable;'] })
  def('Landroid/media/MediaScannerConnection;', OBJ, {
    '<init>(Landroid/content/Context;Landroid/media/MediaScannerConnection$MediaScannerConnectionClient;)V': noop,
    'connect()V': noop, 'disconnect()V': noop, 'scanFile(Ljava/lang/String;Ljava/lang/String;)V': noop, 'isConnected()Z': () => 1,
    'scanFile(Landroid/content/Context;[Ljava/lang/String;[Ljava/lang/String;Landroid/media/MediaScannerConnection$OnScanCompletedListener;)V': noop,
  })
  def('Landroid/os/Binder;', OBJ, { '<init>()V': noop, 'getCallingUid()I': () => 10000, 'getCallingPid()I': () => 1, 'clearCallingIdentity()J': () => 0n, 'restoreCallingIdentity(J)V': noop })
  void strArray
}
