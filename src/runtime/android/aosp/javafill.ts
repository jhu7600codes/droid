// java.* pieces the real framework uses that droid's java shims did not have yet
import { JObject, JArray, type VM, type NativeFn } from '../dalvik.ts'
import { jstr } from '../java.ts'

export function registerJavaFill(vm: VM) {
  const def = (name: string, sup: string | undefined, methods: Record<string, NativeFn>, statics: Record<string, any> = {}) => {
    const old = vm.shims.get(name)
    vm.shim(name, { super: old ? old.super : sup, interfaces: old?.interfaces, methods: { ...(old?.methods || {}), ...methods }, statics: { ...(old?.statics || {}), ...statics } })
  }
  const text = (x: any) => (x == null ? '' : jstr(vm, x))
  const ENV: Record<string, string> = {
    ANDROID_ROOT: '/system', ANDROID_DATA: '/data', EXTERNAL_STORAGE: '/sdcard', ANDROID_STORAGE: '/storage',
    EMULATED_STORAGE_SOURCE: '', EMULATED_STORAGE_TARGET: '', MEDIA_STORAGE: '/data/media', ASEC_MOUNTPOINT: '/mnt/asec',
    SECONDARY_STORAGE: '', DOWNLOAD_CACHE: '/cache', ANDROID_ASSETS: '/system/app', BOOTCLASSPATH: '', PATH: '/system/bin',
  }
  def('Ljava/lang/System;', 'Ljava/lang/Object;', {
    'getenv(Ljava/lang/String;)Ljava/lang/String;': (v, s, [k]) => ENV[text(k)] ?? null,
    'getenv()Ljava/util/Map;': () => { const m = vm.newObject('Ljava/util/HashMap;'); for (const [k, x] of Object.entries(ENV)) vm.callVirtual(m, 'put(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;', [k, x]); return m },
  })
  const noop: NativeFn = () => {}
  def('Ljava/security/Provider;', 'Ljava/util/Properties;', {
    '<init>(Ljava/lang/String;DLjava/lang/String;)V': (v, s, [n, ver, info]) => { s.f.name = n; s.f.version = ver; s.f.info = info },
    'getName()Ljava/lang/String;': (v, s) => s.f.name, 'getVersion()D': (v, s) => s.f.version, 'getInfo()Ljava/lang/String;': (v, s) => s.f.info,
    'put(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;': () => null,
  })
  const providers: any[] = []
  def('Ljava/security/Security;', 'Ljava/lang/Object;', {
    'addProvider(Ljava/security/Provider;)I': (v, s, [p]) => { providers.push(p); return providers.length },
    'insertProviderAt(Ljava/security/Provider;I)I': (v, s, [p]) => { providers.push(p); return providers.length },
    'removeProvider(Ljava/lang/String;)V': noop,
    'getProvider(Ljava/lang/String;)Ljava/security/Provider;': (v, s, [n]) => providers.find((p) => p.f.name === text(n)) ?? null,
    'getProviders()[Ljava/security/Provider;': () => { const a = vm.newArray('[Ljava/security/Provider;', providers.length); providers.forEach((p, i) => (a.data[i] = p)); return a },
    'getProperty(Ljava/lang/String;)Ljava/lang/String;': () => null, 'setProperty(Ljava/lang/String;Ljava/lang/String;)V': noop,
  })
  const runtime = { r: null as any }
  def('Ljava/lang/Runtime;', 'Ljava/lang/Object;', {
    'getRuntime()Ljava/lang/Runtime;': () => (runtime.r ??= vm.newObject('Ljava/lang/Runtime;')),
    'availableProcessors()I': () => Math.max(1, Math.min(8, (globalThis as any).navigator?.hardwareConcurrency ?? 4)),
    'maxMemory()J': () => 256n << 20n, 'totalMemory()J': () => 128n << 20n, 'freeMemory()J': () => 64n << 20n,
    'gc()V': noop, 'runFinalization()V': noop, 'addShutdownHook(Ljava/lang/Thread;)V': noop, 'removeShutdownHook(Ljava/lang/Thread;)Z': () => 1,
    'exit(I)V': noop, 'halt(I)V': noop,
    'loadLibrary(Ljava/lang/String;)V': (v, s, [n]) => vm.callStatic('Ljava/lang/System;', 'loadLibrary(Ljava/lang/String;)V', [n]),
  })
  // Object.clone: a shallow copy (arrays and plain objects)
  def('Ljava/lang/Object;', undefined, {
    'clone()Ljava/lang/Object;': (v, s) => {
      if (s instanceof JArray) return new JArray(s.cls, (s.data as any).slice())
      const o = new JObject((s as JObject).cls); Object.assign(o.f, (s as JObject).f); return o
    },
  })
  const props = new Map<string, string>(Object.entries({ 'line.separator': '\n', 'java.vm.version': '1.6.0', 'java.vm.name': 'Dalvik', 'os.arch': 'armv7l', 'os.name': 'Linux', 'os.version': '3.4.0', 'http.agent': 'Dalvik/1.6.0 (Linux; U; Android 4.4.4; Droid Build/KTU84Q)', 'file.separator': '/', 'path.separator': ':', 'user.dir': '/', 'user.home': '', 'java.io.tmpdir': '/data/local/tmp', 'file.encoding': 'UTF-8', 'java.vendor': 'The Android Project', 'java.version': '0', 'java.specification.version': '0.9', 'java.boot.class.path': '' }))
  def('Ljava/lang/System;', 'Ljava/lang/Object;', {
    'setProperty(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;': (v, s, [k, x]) => { const old = props.get(text(k)) ?? null; props.set(text(k), text(x)); return old },
    'getProperty(Ljava/lang/String;)Ljava/lang/String;': (v, s, [k]) => props.get(text(k)) ?? null,
    'getProperty(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;': (v, s, [k, d]) => props.get(text(k)) ?? d,
    'clearProperty(Ljava/lang/String;)Ljava/lang/String;': (v, s, [k]) => { const old = props.get(text(k)) ?? null; props.delete(text(k)); return old },
    'lineSeparator()Ljava/lang/String;': () => '\n',
    'mapLibraryName(Ljava/lang/String;)Ljava/lang/String;': (v, s, [n]) => 'lib' + text(n) + '.so',
  })
  def('Ljava/lang/AssertionError;', 'Ljava/lang/Error;', { '<init>()V': noop, '<init>(Ljava/lang/Object;)V': (v, s, [m]) => { s.f.message = text(m) } })
  def('Ljava/io/FileDescriptor;', 'Ljava/lang/Object;', { '<init>()V': (v, s) => { s.f.descriptor = -1 }, 'valid()Z': (v, s) => (s.f.descriptor !== -1 ? 1 : 0), 'sync()V': noop }, { in: null, out: null, err: null })
  // proxies: none (droid's own proxy sits under the network layer)
  const noProxy = { p: null as any }
  def('Ljava/net/Proxy;', 'Ljava/lang/Object;', {
    '<init>(Ljava/net/Proxy$Type;Ljava/net/SocketAddress;)V': (v, s, [t, a]) => { s.f.type = t; s.f.address = a },
    'type()Ljava/net/Proxy$Type;': (v, s) => s.f.type ?? null, 'address()Ljava/net/SocketAddress;': (v, s) => s.f.address ?? null,
  })
  def('Ljava/net/Proxy$Type;', 'Ljava/lang/Enum;', {})
  def('Ljava/net/ProxySelector;', 'Ljava/lang/Object;', {
    '<init>()V': noop,
    'getDefault()Ljava/net/ProxySelector;': () => (noProxy.p ??= vm.newObject('Ljava/net/ProxySelector;')),
    'setDefault(Ljava/net/ProxySelector;)V': (v, s, [p]) => { noProxy.p = p },
    'select(Ljava/net/URI;)Ljava/util/List;': () => { const l = vm.newObject('Ljava/util/ArrayList;'); vm.callVirtual(l, 'add(Ljava/lang/Object;)Z', [vm.cls('Ljava/net/Proxy;').staticValues.NO_PROXY]); return l },
    'connectFailed(Ljava/net/URI;Ljava/net/SocketAddress;Ljava/io/IOException;)V': noop,
  })
  vm.cls('Ljava/net/Proxy;').staticValues.NO_PROXY = new JObject(vm.cls('Ljava/net/Proxy;'))
  def('Ljava/lang/Class;', 'Ljava/lang/Object;', { 'asSubclass(Ljava/lang/Class;)Ljava/lang/Class;': (v, s) => s })
  def('Ljava/lang/Double;', 'Ljava/lang/Number;', { 'isInfinite(D)Z': (v, s, [x]) => (x === Infinity || x === -Infinity ? 1 : 0) })
  // java.lang.Enum (name and ordinal kept beside the enum's own fields)
  def('Ljava/lang/AutoCloseable;', 'Ljava/lang/Object;', {})
  def('Ljava/lang/Enum;', 'Ljava/lang/Object;', {
    '<init>(Ljava/lang/String;I)V': (v, s, [n, o]) => { s.f.$name = n; s.f.$ordinal = o },
    'name()Ljava/lang/String;': (v, s) => s.f.$name, 'ordinal()I': (v, s) => s.f.$ordinal,
    'toString()Ljava/lang/String;': (v, s) => s.f.$name,
    'hashCode()I': (v, s) => s.f.$ordinal * 31 + 7,
    'equals(Ljava/lang/Object;)Z': (v, s, [o]) => (o === s ? 1 : 0),
    'compareTo(Ljava/lang/Enum;)I': (v, s, [o]) => s.f.$ordinal - o.f.$ordinal,
    'compareTo(Ljava/lang/Object;)I': (v, s, [o]) => s.f.$ordinal - o.f.$ordinal,
    'getDeclaringClass()Ljava/lang/Class;': (v, s) => { let c = s.cls; while (c.super && c.super.name !== 'Ljava/lang/Enum;') c = c.super; return vm.classObject(c) },
    'valueOf(Ljava/lang/Class;Ljava/lang/String;)Ljava/lang/Enum;': (v, s, [cls, n]) => {
      const c = cls.f.of, vals = vm.callStatic(c.name, `values()[${c.name}`) as JArray
      const hit = [...(vals.data as any[])].find((x) => x.f.$name === text(n))
      if (!hit) throw vm.error('Ljava/lang/IllegalArgumentException;', `${text(n)} is not a constant in ${c.name}`)
      return hit
    },
  })
  // java.lang.Character extras (only the ones the core shims do not have)
  const ch = (c: number) => String.fromCodePoint(c)
  const charFns: Record<string, NativeFn> = {
    'getDirectionality(C)B': (v, s, [c]) => dir(c), 'getDirectionality(I)B': (v, s, [c]) => dir(c),
    'isLetter(C)Z': (v, s, [c]) => (/\p{L}/u.test(ch(c)) ? 1 : 0), 'isLetter(I)Z': (v, s, [c]) => (/\p{L}/u.test(ch(c)) ? 1 : 0),
    'isDigit(C)Z': (v, s, [c]) => (/\p{Nd}/u.test(ch(c)) ? 1 : 0), 'isDigit(I)Z': (v, s, [c]) => (/\p{Nd}/u.test(ch(c)) ? 1 : 0),
    'isLetterOrDigit(C)Z': (v, s, [c]) => (/[\p{L}\p{Nd}]/u.test(ch(c)) ? 1 : 0), 'isLetterOrDigit(I)Z': (v, s, [c]) => (/[\p{L}\p{Nd}]/u.test(ch(c)) ? 1 : 0),
    'isWhitespace(C)Z': (v, s, [c]) => (/[\t\n\u000b\f\r\u001c-\u001f ]|[\p{Zs}\p{Zl}\p{Zp}]/u.test(ch(c)) && c !== 0xa0 && c !== 0x2007 && c !== 0x202f ? 1 : 0),
    'isWhitespace(I)Z': (v, s, [c]) => (/[\t\n\u000b\f\r\u001c-\u001f ]|[\p{Zs}\p{Zl}\p{Zp}]/u.test(ch(c)) && c !== 0xa0 ? 1 : 0),
    'isSpaceChar(C)Z': (v, s, [c]) => (/[\p{Zs}\p{Zl}\p{Zp}]/u.test(ch(c)) ? 1 : 0),
    'isUpperCase(C)Z': (v, s, [c]) => (/\p{Lu}/u.test(ch(c)) ? 1 : 0), 'isLowerCase(C)Z': (v, s, [c]) => (/\p{Ll}/u.test(ch(c)) ? 1 : 0),
    'isUpperCase(I)Z': (v, s, [c]) => (/\p{Lu}/u.test(ch(c)) ? 1 : 0), 'isLowerCase(I)Z': (v, s, [c]) => (/\p{Ll}/u.test(ch(c)) ? 1 : 0),
    'isTitleCase(C)Z': (v, s, [c]) => (/\p{Lt}/u.test(ch(c)) ? 1 : 0),
    'toUpperCase(C)C': (v, s, [c]) => { const u = ch(c).toUpperCase(); return u.length === 1 ? u.charCodeAt(0) : c },
    'toLowerCase(C)C': (v, s, [c]) => { const u = ch(c).toLowerCase(); return u.length === 1 ? u.charCodeAt(0) : c },
    'toUpperCase(I)I': (v, s, [c]) => ch(c).toUpperCase().codePointAt(0) ?? c, 'toLowerCase(I)I': (v, s, [c]) => ch(c).toLowerCase().codePointAt(0) ?? c,
    'isISOControl(C)Z': (v, s, [c]) => (c <= 0x1f || (c >= 0x7f && c <= 0x9f) ? 1 : 0),
    'isHighSurrogate(C)Z': (v, s, [c]) => (c >= 0xd800 && c <= 0xdbff ? 1 : 0), 'isLowSurrogate(C)Z': (v, s, [c]) => (c >= 0xdc00 && c <= 0xdfff ? 1 : 0),
    'isSurrogate(C)Z': (v, s, [c]) => (c >= 0xd800 && c <= 0xdfff ? 1 : 0),
    'isSurrogatePair(CC)Z': (v, s, [a, b]) => (a >= 0xd800 && a <= 0xdbff && b >= 0xdc00 && b <= 0xdfff ? 1 : 0),
    'toCodePoint(CC)I': (v, s, [a, b]) => ((a - 0xd800) << 10) + (b - 0xdc00) + 0x10000,
    'charCount(I)I': (v, s, [c]) => (c >= 0x10000 ? 2 : 1),
    'isSupplementaryCodePoint(I)Z': (v, s, [c]) => (c >= 0x10000 && c <= 0x10ffff ? 1 : 0),
    'isValidCodePoint(I)Z': (v, s, [c]) => (c >= 0 && c <= 0x10ffff ? 1 : 0),
    'isDefined(C)Z': () => 1, 'isDefined(I)Z': () => 1,
    'isIdentifierIgnorable(C)Z': (v, s, [c]) => ((c >= 0 && c <= 8) || (c >= 0xe && c <= 0x1b) || (c >= 0x7f && c <= 0x9f) ? 1 : 0),
    'isJavaIdentifierStart(C)Z': (v, s, [c]) => (/[\p{L}$_]/u.test(ch(c)) ? 1 : 0), 'isJavaIdentifierPart(C)Z': (v, s, [c]) => (/[\p{L}\p{Nd}$_]/u.test(ch(c)) ? 1 : 0),
    'getType(C)I': (v, s, [c]) => gtype(c), 'getType(I)I': (v, s, [c]) => gtype(c),
    'digit(CI)I': (v, s, [c, r]) => { const d = parseInt(ch(c), r); return isNaN(d) ? -1 : d }, 'digit(II)I': (v, s, [c, r]) => { const d = parseInt(ch(c), r); return isNaN(d) ? -1 : d },
    'getNumericValue(C)I': (v, s, [c]) => { const d = parseInt(ch(c), 36); return isNaN(d) ? -1 : d },
    'forDigit(II)C': (v, s, [d, r]) => (d < 0 || d >= r ? 0 : d.toString(r).charCodeAt(0)),
    'reverseBytes(C)C': (v, s, [c]) => ((c & 0xff) << 8) | ((c >> 8) & 0xff),
  }
  const old = vm.shims.get('Ljava/lang/Character;')?.methods || {}
  def('Ljava/lang/Character;', 'Ljava/lang/Object;', Object.fromEntries(Object.entries(charFns).filter(([k]) => !(k in old))))
  // number box extras (only what the core shims lack)
  const only = (cls: string, fns: Record<string, NativeFn>) => { const old = vm.shims.get(cls)?.methods || {}; def(cls, 'Ljava/lang/Number;', Object.fromEntries(Object.entries(fns).filter(([k]) => !(k in old)))) }
  only('Ljava/lang/Float;', {
    'isNaN(F)Z': (v, s, [x]) => (Number.isNaN(x) ? 1 : 0), 'isInfinite(F)Z': (v, s, [x]) => (x === Infinity || x === -Infinity ? 1 : 0),
    'isNaN()Z': (v, s) => (Number.isNaN(s.f.value) ? 1 : 0), 'isInfinite()Z': (v, s) => (Math.abs(s.f.value) === Infinity ? 1 : 0),
    'compare(FF)I': (v, s, [a, b]) => (a < b ? -1 : a > b ? 1 : 0), 'max(FF)F': (v, s, [a, b]) => Math.max(a, b), 'min(FF)F': (v, s, [a, b]) => Math.min(a, b),
    'isFinite(F)Z': (v, s, [x]) => (Number.isFinite(x) ? 1 : 0), 'sum(FF)F': (v, s, [a, b]) => Math.fround(a + b),
  })
  only('Ljava/lang/Double;', {
    'isNaN(D)Z': (v, s, [x]) => (Number.isNaN(x) ? 1 : 0), 'isNaN()Z': (v, s) => (Number.isNaN(s.f.value) ? 1 : 0),
    'compare(DD)I': (v, s, [a, b]) => (a < b ? -1 : a > b ? 1 : 0), 'max(DD)D': (v, s, [a, b]) => Math.max(a, b), 'min(DD)D': (v, s, [a, b]) => Math.min(a, b),
    'isFinite(D)Z': (v, s, [x]) => (Number.isFinite(x) ? 1 : 0),
  })
  only('Ljava/lang/Integer;', {
    'compare(II)I': (v, s, [a, b]) => (a < b ? -1 : a > b ? 1 : 0), 'signum(I)I': (v, s, [x]) => Math.sign(x),
    'bitCount(I)I': (v, s, [x]) => { let n = 0; x >>>= 0; while (x) { n += x & 1; x >>>= 1 } return n },
    'highestOneBit(I)I': (v, s, [x]) => (x === 0 ? 0 : (1 << (31 - Math.clz32(x))) | 0), 'lowestOneBit(I)I': (v, s, [x]) => x & -x,
    'numberOfLeadingZeros(I)I': (v, s, [x]) => Math.clz32(x), 'numberOfTrailingZeros(I)I': (v, s, [x]) => (x === 0 ? 32 : 31 - Math.clz32(x & -x)),
    'reverse(I)I': (v, s, [x]) => { let r = 0; for (let i = 0; i < 32; i++) { r = (r << 1) | (x & 1); x >>>= 1 } return r | 0 },
    'reverseBytes(I)I': (v, s, [x]) => (((x & 0xff) << 24) | ((x & 0xff00) << 8) | ((x >>> 8) & 0xff00) | (x >>> 24)) | 0,
    'rotateLeft(II)I': (v, s, [x, d]) => ((x << d) | (x >>> (32 - d))) | 0, 'rotateRight(II)I': (v, s, [x, d]) => ((x >>> d) | (x << (32 - d))) | 0,
    'max(II)I': (v, s, [a, b]) => Math.max(a, b), 'min(II)I': (v, s, [a, b]) => Math.min(a, b), 'sum(II)I': (v, s, [a, b]) => (a + b) | 0,
  })
  only('Ljava/lang/Long;', {
    'compare(JJ)I': (v, s, [a, b]) => (a < b ? -1 : a > b ? 1 : 0), 'signum(J)I': (v, s, [x]) => (x > 0n ? 1 : x < 0n ? -1 : 0),
    'numberOfLeadingZeros(J)I': (v, s, [x]) => { const u = BigInt.asUintN(64, x); return u === 0n ? 64 : 64 - u.toString(2).length },
    'numberOfTrailingZeros(J)I': (v, s, [x]) => { let u = BigInt.asUintN(64, x); if (u === 0n) return 64; let n = 0; while (!(u & 1n)) { u >>= 1n; n++ } return n },
    'bitCount(J)I': (v, s, [x]) => [...BigInt.asUintN(64, x).toString(2)].filter((c) => c === '1').length,
    'max(JJ)J': (v, s, [a, b]) => (a > b ? a : b), 'min(JJ)J': (v, s, [a, b]) => (a < b ? a : b),
  })
}

// unicode bidi classes, enough for android's text direction checks
const dir = (c: number) => {
  if (c >= 0x590 && c <= 0x5ff) return 1 // R (hebrew)
  if ((c >= 0x600 && c <= 0x6ff && !(c >= 0x660 && c <= 0x669)) || (c >= 0x750 && c <= 0x77f) || (c >= 0xfb50 && c <= 0xfdff) || (c >= 0xfe70 && c <= 0xfeff)) return 2 // AL
  if (c >= 0x30 && c <= 0x39) return 3 // EN
  if (c >= 0x660 && c <= 0x669) return 6 // AN
  if (c === 0x2b || c === 0x2d) return 4 // ES
  if (c === 0x23 || c === 0x24 || c === 0x25) return 5 // ET
  if (c === 0x2c || c === 0x2e || c === 0x2f || c === 0x3a) return 7 // CS
  if (c === 0x0a || c === 0x0d || c === 0x1c || c === 0x1d || c === 0x1e || c === 0x85 || c === 0x2029) return 10 // B
  if (c === 0x09 || c === 0x0b || c === 0x1f) return 11 // S
  if (c === 0x20 || c === 0x0c || c === 0x2028 || (c >= 0x2000 && c <= 0x200a)) return 12 // WS
  if ((c >= 0x300 && c <= 0x36f) || (c >= 0x200b && c <= 0x200d)) return 8 // NSM
  if (/\p{L}/u.test(String.fromCodePoint(c))) return 0 // L
  return 13 // ON
}
// java.lang.Character.getType categories
const gtype = (c: number) => {
  const t = String.fromCodePoint(c)
  const cats: [RegExp, number][] = [[/\p{Lu}/u, 1], [/\p{Ll}/u, 2], [/\p{Lt}/u, 3], [/\p{Lm}/u, 4], [/\p{Lo}/u, 5], [/\p{Mn}/u, 6], [/\p{Me}/u, 7], [/\p{Mc}/u, 8], [/\p{Nd}/u, 9], [/\p{Nl}/u, 10], [/\p{No}/u, 11], [/\p{Zs}/u, 12], [/\p{Zl}/u, 13], [/\p{Zp}/u, 14], [/\p{Cc}/u, 15], [/\p{Cf}/u, 16], [/\p{Co}/u, 18], [/\p{Cs}/u, 19], [/\p{Pd}/u, 20], [/\p{Ps}/u, 21], [/\p{Pe}/u, 22], [/\p{Pc}/u, 23], [/\p{Po}/u, 24], [/\p{Sm}/u, 25], [/\p{Sc}/u, 26], [/\p{Sk}/u, 27], [/\p{So}/u, 28], [/\p{Pi}/u, 29], [/\p{Pf}/u, 30]]
  for (const [re, n] of cats) if (re.test(t)) return n
  return 0
}
