// more of java.lang / java.util / java.io that android's own framework code calls: a real seeded
// Random, Character code points, binary searches, PrintStream on any stream, small number parsers.
import { VM, JObject, JavaThrow, type NativeFn } from './dalvik.ts'
import { jstr } from './java.ts'

export function registerJavaExtra(vm: VM) {
  const OBJ = 'Ljava/lang/Object;'
  const def = (name: string, sup: string, methods: Record<string, NativeFn>, extra: { interfaces?: string[] } = {}) => {
    const old = vm.shims.get(name)
    vm.shim(name, { super: old?.super ?? sup, interfaces: old?.interfaces ?? extra.interfaces, methods: { ...(old?.methods || {}), ...methods }, statics: old?.statics })
  }
  const text = (x: any) => (x == null ? 'null' : jstr(vm, x))
  const noop: NativeFn = () => {}
  const nfe = (s: any) => vm.error('Ljava/lang/NumberFormatException;', `Invalid int: "${s}"`)

  // ---------- java.util.Random: the same 48-bit generator as java, so seeded games repeat ----------
  // the seed is two 24-bit halves (exact in doubles)
  const M_HI = 0x5de, M_LO = 0xece66d, T24 = 0x1000000
  const setSeed = (s: JObject, seed: bigint) => {
    const x = (BigInt.asUintN(64, seed) ^ 0x5deece66dn) & 0xffffffffffffn
    s.f.hi = Number(x >> 24n); s.f.lo = Number(x & 0xffffffn); s.f.haveG = false
  }
  const next = (s: JObject, bits: number) => {
    if (s.f.hi === undefined) setSeed(s, BigInt(Math.floor(Math.random() * 2 ** 48)))
    const p = s.f.lo * M_LO + 0xb
    const lo = p % T24, carry = Math.floor(p / T24)
    const hi = (s.f.hi * M_LO + s.f.lo * M_HI + carry) % T24
    s.f.hi = hi; s.f.lo = lo
    return Math.floor((hi * T24 + lo) / 2 ** (48 - bits)) | 0
  }
  const nextInt = (s: JObject, n: number) => {
    if (n <= 0) throw vm.error('Ljava/lang/IllegalArgumentException;', 'n <= 0: ' + n)
    if ((n & -n) === n) return Number((BigInt(n) * BigInt(next(s, 31))) >> 31n)
    let bits: number, val: number
    do { bits = next(s, 31); val = bits % n } while (bits - val + (n - 1) > 0x7fffffff)
    return val
  }
  def('Ljava/util/Random;', OBJ, {
    '<init>()V': (v, s) => setSeed(s, BigInt(Math.floor(Math.random() * 2 ** 48))),
    '<init>(J)V': (v, s, [seed]) => setSeed(s, BigInt(seed)),
    'setSeed(J)V': (v, s, [seed]) => setSeed(s, BigInt(seed)),
    'next(I)I': (v, s, [b]) => next(s, b),
    'nextInt()I': (v, s) => next(s, 32),
    'nextInt(I)I': (v, s, [n]) => nextInt(s, n),
    'nextLong()J': (v, s) => BigInt.asIntN(64, (BigInt(next(s, 32)) << 32n) + BigInt(next(s, 32))),
    'nextBoolean()Z': (v, s) => (next(s, 1) !== 0 ? 1 : 0),
    'nextFloat()F': (v, s) => Math.fround(next(s, 24) / T24),
    'nextDouble()D': (v, s) => ((next(s, 26) >>> 0) * 2 ** 27 + (next(s, 27) >>> 0)) * 2 ** -53,
    'nextGaussian()D': (v, s) => {
      if (s.f.haveG) { s.f.haveG = false; return s.f.g }
      let a: number, b: number, q: number
      do { a = 2 * (((next(s, 26) >>> 0) * 2 ** 27 + (next(s, 27) >>> 0)) * 2 ** -53) - 1; b = 2 * (((next(s, 26) >>> 0) * 2 ** 27 + (next(s, 27) >>> 0)) * 2 ** -53) - 1; q = a * a + b * b } while (q >= 1 || q === 0)
      const m = Math.sqrt(-2 * Math.log(q) / q)
      s.f.g = b * m; s.f.haveG = true
      return a * m
    },
    'nextBytes([B)V': (v, s, [arr]) => { for (let i = 0; i < arr.data.length;) for (let r = next(s, 32), k = Math.min(arr.data.length - i, 4); k-- > 0; r >>= 8) arr.data[i++] = (r << 24) >> 24 },
  })

  // ---------- Character code points ----------
  const cpAt = (get: (i: number) => number, len: number, i: number) => {
    const c = get(i)
    if (c >= 0xd800 && c < 0xdc00 && i + 1 < len) { const d = get(i + 1); if (d >= 0xdc00 && d < 0xe000) return ((c - 0xd800) << 10) + (d - 0xdc00) + 0x10000 }
    return c
  }
  const cpBefore = (get: (i: number) => number, i: number) => {
    const d = get(i - 1)
    if (d >= 0xdc00 && d < 0xe000 && i >= 2) { const c = get(i - 2); if (c >= 0xd800 && c < 0xdc00) return ((c - 0xd800) << 10) + (d - 0xdc00) + 0x10000 }
    return d
  }
  const seq = (x: any) => { const t = jstr(vm, x); return (i: number) => { if (i < 0 || i >= t.length) throw vm.error('Ljava/lang/StringIndexOutOfBoundsException;', 'index ' + i); return t.charCodeAt(i) } }
  const arr = (a: any) => (i: number) => { if (i < 0 || i >= a.data.length) throw vm.error('Ljava/lang/ArrayIndexOutOfBoundsException;', 'index ' + i); return a.data[i] }
  def('Ljava/lang/Character;', OBJ, {
    'codePointAt(Ljava/lang/CharSequence;I)I': (v, s, [x, i]) => cpAt(seq(x), jstr(vm, x).length, i),
    'codePointAt([CI)I': (v, s, [a, i]) => cpAt(arr(a), a.data.length, i),
    'codePointAt([CII)I': (v, s, [a, i, lim]) => cpAt(arr(a), lim, i),
    'codePointBefore(Ljava/lang/CharSequence;I)I': (v, s, [x, i]) => cpBefore(seq(x), i),
    'codePointBefore([CI)I': (v, s, [a, i]) => cpBefore(arr(a), i),
    'codePointCount(Ljava/lang/CharSequence;II)I': (v, s, [x, b, e]) => [...jstr(vm, x).slice(b, e)].length,
    'codePointCount([CII)I': (v, s, [a, o, n]) => [...String.fromCharCode(...a.data.subarray(o, o + n))].length,
    'toChars(I)[C': (v, s, [c]) => { const t = String.fromCodePoint(c), r = vm.newArray('[C', t.length); for (let i = 0; i < t.length; i++) r.data[i] = t.charCodeAt(i); return r },
    'toChars(I[CI)I': (v, s, [c, dst, at]) => { const t = String.fromCodePoint(c); for (let i = 0; i < t.length; i++) dst.data[at + i] = t.charCodeAt(i); return t.length },
    'charCount(I)I': (v, s, [c]) => (c >= 0x10000 ? 2 : 1),
    'isSupplementaryCodePoint(I)Z': (v, s, [c]) => (c >= 0x10000 && c <= 0x10ffff ? 1 : 0),
    'isValidCodePoint(I)Z': (v, s, [c]) => (c >= 0 && c <= 0x10ffff ? 1 : 0),
    'toCodePoint(CC)I': (v, s, [h, l]) => ((h - 0xd800) << 10) + (l - 0xdc00) + 0x10000,
  })

  // ---------- small parsers and boxes ----------
  const parseInt = (x: any, radix: number, min: number, max: number) => {
    const t = x == null ? '' : String(x)
    if (!/^[+-]?[0-9a-zA-Z]+$/.test(t)) throw nfe(t)
    const n = Number.parseInt(t, radix)
    if (!Number.isFinite(n) || n < min || n > max || [...t.replace(/^[+-]/, '')].some((c) => Number.isNaN(Number.parseInt(c, radix)))) throw nfe(t)
    return n
  }
  def('Ljava/lang/Byte;', 'Ljava/lang/Number;', {
    'parseByte(Ljava/lang/String;)B': (v, s, [x]) => parseInt(x, 10, -128, 127),
    'parseByte(Ljava/lang/String;I)B': (v, s, [x, r]) => parseInt(x, r, -128, 127),
  })
  def('Ljava/lang/Short;', 'Ljava/lang/Number;', {
    'parseShort(Ljava/lang/String;)S': (v, s, [x]) => parseInt(x, 10, -32768, 32767),
    'parseShort(Ljava/lang/String;I)S': (v, s, [x, r]) => parseInt(x, r, -32768, 32767),
  })
  const parseFloat = (x: any) => { const t = String(x ?? '').trim(); const n = Number(t.replace(/[fFdD]$/, '')); if (t === '' || (Number.isNaN(n) && !/^[+-]?NaN$/.test(t))) throw vm.error('Ljava/lang/NumberFormatException;', `Invalid float: "${t}"`); return n }
  def('Ljava/lang/Double;', 'Ljava/lang/Number;', { '<init>(Ljava/lang/String;)V': (v, s, [x]) => { s.f.value = parseFloat(x) } })
  def('Ljava/lang/Float;', 'Ljava/lang/Number;', { '<init>(Ljava/lang/String;)V': (v, s, [x]) => { s.f.value = Math.fround(parseFloat(x)) } })
  def('Ljava/lang/Math;', OBJ, {
    'rint(D)D': (v, s, [x]) => { const f = Math.floor(x), d = x - f; return d > 0.5 ? f + 1 : d < 0.5 ? f : (f % 2 === 0 ? f : f + 1) },
  })
  Object.assign(vm.shims.get(OBJ)!.methods!, { 'finalize()V': noop }) // (object has no super)

  // ---------- binary searches ----------
  const bsearch = (n0: number, n1: number, cmp: (i: number) => number) => {
    let lo = n0, hi = n1 - 1
    while (lo <= hi) { const mid = (lo + hi) >>> 1, c = cmp(mid); if (c < 0) lo = mid + 1; else if (c > 0) hi = mid - 1; else return mid }
    return -(lo + 1)
  }
  const num = (a: any, b: any) => (a < b ? -1 : a > b ? 1 : 0)
  const objCmp = (c: any) => (a: any, b: any) => (c ? vm.callVirtual(c, 'compare(Ljava/lang/Object;Ljava/lang/Object;)I', [a, b]) : vm.callVirtual(a, 'compareTo(Ljava/lang/Object;)I', [b])) as number
  const A: Record<string, NativeFn> = {}
  for (const t of ['B', 'C', 'S', 'I', 'J', 'F', 'D']) {
    A[`binarySearch([${t}${t})I`] = (v, s, [a, k]) => bsearch(0, a.data.length, (i) => num(a.data[i], k))
    A[`binarySearch([${t}II${t})I`] = (v, s, [a, from, to, k]) => bsearch(from, to, (i) => num(a.data[i], k))
  }
  A['binarySearch([Ljava/lang/Object;Ljava/lang/Object;)I'] = (v, s, [a, k]) => bsearch(0, a.data.length, (i) => objCmp(null)(a.data[i], k))
  A['binarySearch([Ljava/lang/Object;IILjava/lang/Object;)I'] = (v, s, [a, f, t, k]) => bsearch(f, t, (i) => objCmp(null)(a.data[i], k))
  A['binarySearch([Ljava/lang/Object;Ljava/lang/Object;Ljava/util/Comparator;)I'] = (v, s, [a, k, c]) => bsearch(0, a.data.length, (i) => objCmp(c)(a.data[i], k))
  A['binarySearch([Ljava/lang/Object;IILjava/lang/Object;Ljava/util/Comparator;)I'] = (v, s, [a, f, t, k, c]) => bsearch(f, t, (i) => objCmp(c)(a.data[i], k))
  def('Ljava/util/Arrays;', OBJ, A)
  const listGet = (l: any, i: number) => vm.callVirtual(l, 'get(I)Ljava/lang/Object;', [i])
  const listSize = (l: any) => vm.callVirtual(l, 'size()I', []) as number
  def('Ljava/util/Collections;', OBJ, {
    'binarySearch(Ljava/util/List;Ljava/lang/Object;)I': (v, s, [l, k]) => bsearch(0, listSize(l), (i) => objCmp(null)(listGet(l, i), k)),
    'binarySearch(Ljava/util/List;Ljava/lang/Object;Ljava/util/Comparator;)I': (v, s, [l, k, c]) => bsearch(0, listSize(l), (i) => objCmp(c)(listGet(l, i), k)),
  })

  // ---------- PrintStream over any OutputStream (System.out stays the log) ----------
  const enc = new TextEncoder()
  const ps = (s: JObject, t: string) => {
    if (!s.f.out) { vm.log(t.replace(/\n$/, '')); return }
    const b = enc.encode(t), a = vm.newArray('[B', b.length); (a.data as Int8Array).set(new Int8Array(b.buffer, b.byteOffset, b.length))
    try { vm.callVirtual(s.f.out, 'write([BII)V', [a, 0, b.length]) } catch (e) { if (e instanceof JavaThrow) s.f.error = true; else throw e }
  }
  const P: Record<string, NativeFn> = {
    '<init>(Ljava/io/OutputStream;)V': (v, s, [o]) => { s.f.out = o },
    '<init>(Ljava/io/OutputStream;Z)V': (v, s, [o]) => { s.f.out = o },
    '<init>(Ljava/io/OutputStream;ZLjava/lang/String;)V': (v, s, [o]) => { s.f.out = o },
    'checkError()Z': (v, s) => (s.f.error ? 1 : 0),
    'close()V': (v, s) => { if (s.f.out) vm.callVirtual(s.f.out, 'close()V', []) },
    'flush()V': (v, s) => { if (s.f.out) vm.callVirtual(s.f.out, 'flush()V', []) },
    'write(I)V': (v, s, [b]) => { if (s.f.out) vm.callVirtual(s.f.out, 'write(I)V', [b]) },
    'write([BII)V': (v, s, [a, o, n]) => { if (s.f.out) vm.callVirtual(s.f.out, 'write([BII)V', [a, o, n]) },
  }
  for (const [t, f] of [['Ljava/lang/String;', (x: any) => text(x)], ['Ljava/lang/Object;', (x: any) => text(x)], ['I', String], ['J', String], ['Z', (x: any) => (x ? 'true' : 'false')], ['C', (x: number) => String.fromCharCode(x)],
    ['F', (x: number) => jstr(vm, vm.callStatic('Ljava/lang/String;', 'valueOf(F)Ljava/lang/String;', [x]))], ['D', (x: number) => jstr(vm, vm.callStatic('Ljava/lang/String;', 'valueOf(D)Ljava/lang/String;', [x]))],
    ['[C', (a: any) => String.fromCharCode(...a.data)]] as [string, (x: any) => string][]) {
    P[`print(${t})V`] = (v, s, [x]) => ps(s, f(x))
    P[`println(${t})V`] = (v, s, [x]) => ps(s, f(x) + '\n')
  }
  P['println()V'] = (v, s) => ps(s, '\n')
  P['printf(Ljava/lang/String;[Ljava/lang/Object;)Ljava/io/PrintStream;'] = (v, s, [f, a]) => { ps(s, jstr(vm, vm.callStatic('Ljava/lang/String;', 'format(Ljava/lang/String;[Ljava/lang/Object;)Ljava/lang/String;', [f, a]))); return s }
  P['format(Ljava/lang/String;[Ljava/lang/Object;)Ljava/io/PrintStream;'] = P['printf(Ljava/lang/String;[Ljava/lang/Object;)Ljava/io/PrintStream;']
  P['append(C)Ljava/io/PrintStream;'] = (v, s, [c]) => { ps(s, String.fromCharCode(c)); return s }
  P['append(Ljava/lang/CharSequence;)Ljava/io/PrintStream;'] = (v, s, [x]) => { ps(s, text(x)); return s }
  def('Ljava/io/PrintStream;', 'Ljava/io/OutputStream;', P)
  def('Ljava/lang/System;', OBJ, {
    'setOut(Ljava/io/PrintStream;)V': (v, s, [p]) => { vm.cls('Ljava/lang/System;').staticValues.out = p },
    'setErr(Ljava/io/PrintStream;)V': (v, s, [p]) => { vm.cls('Ljava/lang/System;').staticValues.err = p },
    'setIn(Ljava/io/InputStream;)V': (v, s, [p]) => { vm.cls('Ljava/lang/System;').staticValues.in = p },
  })

  // ---------- odds and ends ----------
  def('Ljava/io/ByteArrayOutputStream;', 'Ljava/io/OutputStream;', {
    'writeTo(Ljava/io/OutputStream;)V': (v, s, [o]) => { const b: Uint8Array = s.f.buf, a = vm.newArray('[B', b.length); (a.data as Int8Array).set(new Int8Array(b.buffer, b.byteOffset, b.length)); vm.callVirtual(o, 'write([BII)V', [a, 0, b.length]) },
  })
  def('Ljava/io/Writer;', OBJ, { 'append(C)Ljava/io/Writer;': (v, s, [c]) => { vm.callVirtual(s, 'write(I)V', [c]); return s } })
  def('Ljava/lang/Class;', OBJ, {
    'getResourceAsStream(Ljava/lang/String;)Ljava/io/InputStream;': () => null,
    'isMemberClass()Z': (v, s) => (/\$[^$\d][^$]*;$/.test(s.f.name ?? s.f.cls?.name ?? '') ? 1 : 0),
  })
  def('Ljava/util/concurrent/ConcurrentHashMap;', 'Ljava/util/AbstractMap;', { '<init>(IFI)V': (v, s) => vm.shims.get('Ljava/util/concurrent/ConcurrentHashMap;')!.methods!['<init>()V'](vm, s, []) })
  def('Ljava/util/concurrent/FutureTask;', OBJ, { 'set(Ljava/lang/Object;)V': (v, s, [x]) => { s.f.value = x; s.f.done = true; s.f.onDone?.(s) } })
  def('Ljava/util/Locale;', OBJ, {
    'getDisplayCountry(Ljava/util/Locale;)Ljava/lang/String;': (v, s) => vm.callVirtual(s, 'getDisplayCountry()Ljava/lang/String;', []),
    'getDisplayName(Ljava/util/Locale;)Ljava/lang/String;': (v, s) => vm.callVirtual(s, 'getDisplayName()Ljava/lang/String;', []),
  })
  def('Ljava/util/TimeZone;', OBJ, { 'getDisplayName(ZI)Ljava/lang/String;': (v, s) => vm.callVirtual(s, 'getDisplayName()Ljava/lang/String;', []) })
}
