// framework shim, part 1: java.lang and java.util basics, written in js on top of the vm.
// keys are "name(params)return", exactly like dex method keys.
import { VM, JObject, JArray, JavaThrow, type NativeFn } from './dalvik.ts'

const OBJ = 'Ljava/lang/Object;'
export const jstr = (vm: VM, v: any): string => {
  if (v == null) return 'null'
  if (typeof v === 'string') return v
  if (typeof v === 'bigint') return v.toString()
  if (typeof v === 'number') return String(v)
  const r = vm.callVirtual(v, 'toString()Ljava/lang/String;')
  return r == null ? 'null' : String(r)
}
// java's float/double to string: 1.0 not 1, NaN, Infinity
export const jnum = (x: number) => (Number.isInteger(x) && Math.abs(x) < 1e7 ? x.toFixed(1) : isNaN(x) ? 'NaN' : !isFinite(x) ? (x > 0 ? 'Infinity' : '-Infinity') : String(x).replace(/e\+?/, 'E'))
const jchar = (c: number) => String.fromCharCode(c)
const hash = (s: string) => { let h = 0; for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0; return h }
let idHash = 1
const identity = new WeakMap<object, number>()
export const identityHash = (o: object) => { let h = identity.get(o); if (!h) identity.set(o, (h = (idHash++ * 2654435761) | 0)); return h }

// java String.format, the common parts: %d %s %f %.Nf %x %c %b %% %n
export function jformat(vm: VM, fmt: string, args: any[]) {
  let i = 0
  return fmt.replace(/%(-?)(0?)(\d*)(?:\.(\d+))?([dsfxXcbne%])/g, (m, left, zero, width, prec, conv) => {
    if (conv === '%') return '%'
    if (conv === 'n') return '\n'
    const a = args[i++]
    let s: string
    switch (conv) {
      case 'd': s = typeof a === 'object' && a ? jstr(vm, a) : String(a); break
      case 'f': s = Number(unbox(a)).toFixed(prec ? +prec : 6); break
      case 'e': s = Number(unbox(a)).toExponential(prec ? +prec : 6); break
      case 'x': case 'X': s = (typeof a === 'bigint' ? BigInt.asUintN(64, a) : (Number(unbox(a)) >>> 0)).toString(16); if (conv === 'X') s = s.toUpperCase(); break
      case 'c': s = typeof a === 'number' ? jchar(a) : jstr(vm, a); break
      case 'b': s = a ? 'true' : 'false'; break
      default: s = jstr(vm, a)
    }
    if (width && s.length < +width) s = left ? s.padEnd(+width) : s.padStart(+width, zero ? '0' : ' ')
    return s
  })
}
export const unbox = (v: any) => (v instanceof JObject && 'value' in v.f ? v.f.value : v)

export function box(vm: VM, cls: string, value: any) {
  const o = new JObject(vm.cls(cls))
  o.f.value = value
  return o
}

function iterator(vm: VM, items: () => any[]) {
  const it = new JObject(vm.cls('Ljava/util/Iterator;'))
  let i = 0
  it.f.hasNext = () => i < items().length
  it.f.next = () => items()[i++]
  it.f.remove = () => { items().splice(--i, 1) }
  return it
}

export function registerJava(vm: VM) {
  const def = (name: string, sup: string | undefined, methods: Record<string, NativeFn>, extra: { interfaces?: string[]; statics?: Record<string, any> } = {}) =>
    vm.shim(name, { super: sup, methods, ...extra })
  const throwable = (name: string, sup: string) => def(name, sup, {})

  def(OBJ, undefined, {
    '<init>()V': () => {},
    'toString()Ljava/lang/String;': (v, s) => `${s.cls.name.slice(1, -1).replace(/\//g, '.')}@${(identityHash(s) >>> 0).toString(16)}`,
    'hashCode()I': (v, s) => identityHash(s),
    'equals(Ljava/lang/Object;)Z': (v, s, [o]) => (s === o ? 1 : 0),
    'getClass()Ljava/lang/Class;': (v, s) => v.classObject(v.classOf(s)),
    'notify()V': () => {}, 'notifyAll()V': () => {}, 'wait()V': () => {},
  })
  def('Ljava/lang/Class;', OBJ, {
    'getName()Ljava/lang/String;': (v, s) => s.f.of.name.slice(1, -1).replace(/\//g, '.'),
    'getSimpleName()Ljava/lang/String;': (v, s) => s.f.of.name.slice(1, -1).split(/[/$]/).pop(),
    'toString()Ljava/lang/String;': (v, s) => 'class ' + s.f.of.name.slice(1, -1).replace(/\//g, '.'),
  })

  // strings are plain js strings
  const S = (fn: (s: string, a: any[]) => any): NativeFn => (v, s, a) => fn(s as string, a)
  def('Ljava/lang/String;', OBJ, {
    '<init>()V': () => '',
    'length()I': S((s) => s.length),
    'charAt(I)C': S((s, [i]) => { if (i < 0 || i >= s.length) throw vm.error('Ljava/lang/StringIndexOutOfBoundsException;', String(i)); return s.charCodeAt(i) }),
    'isEmpty()Z': S((s) => (s.length ? 0 : 1)),
    'equals(Ljava/lang/Object;)Z': S((s, [o]) => (s === o ? 1 : 0)),
    'equalsIgnoreCase(Ljava/lang/String;)Z': S((s, [o]) => (o != null && s.toLowerCase() === o.toLowerCase() ? 1 : 0)),
    'hashCode()I': S((s) => hash(s)),
    'toString()Ljava/lang/String;': S((s) => s),
    'trim()Ljava/lang/String;': S((s) => s.replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, '')),
    'toUpperCase()Ljava/lang/String;': S((s) => s.toUpperCase()),
    'toLowerCase()Ljava/lang/String;': S((s) => s.toLowerCase()),
    'substring(I)Ljava/lang/String;': S((s, [a]) => s.substring(a)),
    'substring(II)Ljava/lang/String;': S((s, [a, b]) => s.substring(a, b)),
    'indexOf(Ljava/lang/String;)I': S((s, [x]) => s.indexOf(x)),
    'indexOf(I)I': S((s, [c]) => s.indexOf(jchar(c))),
    'lastIndexOf(Ljava/lang/String;)I': S((s, [x]) => s.lastIndexOf(x)),
    'lastIndexOf(I)I': S((s, [c]) => s.lastIndexOf(jchar(c))),
    'contains(Ljava/lang/CharSequence;)Z': S((s, [x]) => (s.includes(jstr(vm, x)) ? 1 : 0)),
    'startsWith(Ljava/lang/String;)Z': S((s, [x]) => (s.startsWith(x) ? 1 : 0)),
    'endsWith(Ljava/lang/String;)Z': S((s, [x]) => (s.endsWith(x) ? 1 : 0)),
    'concat(Ljava/lang/String;)Ljava/lang/String;': S((s, [x]) => s + x),
    'replace(CC)Ljava/lang/String;': S((s, [a, b]) => s.split(jchar(a)).join(jchar(b))),
    'replace(Ljava/lang/CharSequence;Ljava/lang/CharSequence;)Ljava/lang/String;': S((s, [a, b]) => s.split(jstr(vm, a)).join(jstr(vm, b))),
    'split(Ljava/lang/String;)[Ljava/lang/String;': S((s, [re]) => { const parts = s.split(new RegExp(re)); while (parts.length && parts[parts.length - 1] === '') parts.pop(); const a = vm.newArray('[Ljava/lang/String;', parts.length); parts.forEach((p, i) => ((a.data as any)[i] = p)); return a }),
    'compareTo(Ljava/lang/String;)I': S((s, [o]) => (s < o ? -1 : s > o ? 1 : 0)),
    'toCharArray()[C': S((s) => { const a = vm.newArray('[C', s.length); for (let i = 0; i < s.length; i++) (a.data as any)[i] = s.charCodeAt(i); return a }),
    'getBytes()[B': S((s) => { const b = new TextEncoder().encode(s); const a = vm.newArray('[B', b.length); (a.data as Int8Array).set(new Int8Array(b.buffer)); return a }),
    'matches(Ljava/lang/String;)Z': S((s, [re]) => (new RegExp('^(?:' + re + ')$').test(s) ? 1 : 0)),
  }, {
    interfaces: ['Ljava/lang/CharSequence;'],
  })
  const strStatic: Record<string, NativeFn> = {
    'valueOf(I)Ljava/lang/String;': (v, s, [x]) => String(x),
    'valueOf(J)Ljava/lang/String;': (v, s, [x]) => String(x),
    'valueOf(Z)Ljava/lang/String;': (v, s, [x]) => (x ? 'true' : 'false'),
    'valueOf(C)Ljava/lang/String;': (v, s, [x]) => jchar(x),
    'valueOf(F)Ljava/lang/String;': (v, s, [x]) => jnum(x),
    'valueOf(D)Ljava/lang/String;': (v, s, [x]) => jnum(x),
    'valueOf(Ljava/lang/Object;)Ljava/lang/String;': (v, s, [x]) => jstr(vm, x),
    'valueOf([C)Ljava/lang/String;': (v, s, [a]) => String.fromCharCode(...(a.data as Uint16Array)),
    'format(Ljava/lang/String;[Ljava/lang/Object;)Ljava/lang/String;': (v, s, [f, a]) => jformat(vm, f, a ? [...a.data] : []),
    '<init>([C)V': () => {},
  }
  Object.assign(vm.shims.get('Ljava/lang/String;')!.methods!, strStatic)
  def('Ljava/lang/CharSequence;', OBJ, { 'toString()Ljava/lang/String;': (v, s) => jstr(vm, s), 'length()I': (v, s) => jstr(vm, s).length })

  // StringBuilder (and StringBuffer): the text lives in f.s
  const sb = (n: string) => def(n, OBJ, {
    '<init>()V': (v, s) => { s.f.s = '' },
    '<init>(I)V': (v, s) => { s.f.s = '' },
    '<init>(Ljava/lang/String;)V': (v, s, [x]) => { s.f.s = jstr(vm, x) },
    '<init>(Ljava/lang/CharSequence;)V': (v, s, [x]) => { s.f.s = jstr(vm, x) },
    [`append(Ljava/lang/String;)L${n.slice(1)}`]: (v, s, [x]) => { s.f.s += x == null ? 'null' : x; return s },
    [`append(Ljava/lang/CharSequence;)L${n.slice(1)}`]: (v, s, [x]) => { s.f.s += jstr(vm, x); return s },
    [`append(Ljava/lang/Object;)L${n.slice(1)}`]: (v, s, [x]) => { s.f.s += jstr(vm, x); return s },
    [`append(I)L${n.slice(1)}`]: (v, s, [x]) => { s.f.s += String(x); return s },
    [`append(J)L${n.slice(1)}`]: (v, s, [x]) => { s.f.s += String(x); return s },
    [`append(C)L${n.slice(1)}`]: (v, s, [x]) => { s.f.s += jchar(x); return s },
    [`append(Z)L${n.slice(1)}`]: (v, s, [x]) => { s.f.s += x ? 'true' : 'false'; return s },
    [`append(F)L${n.slice(1)}`]: (v, s, [x]) => { s.f.s += jnum(x); return s },
    [`append(D)L${n.slice(1)}`]: (v, s, [x]) => { s.f.s += jnum(x); return s },
    [`insert(ILjava/lang/String;)L${n.slice(1)}`]: (v, s, [i, x]) => { s.f.s = s.f.s.slice(0, i) + x + s.f.s.slice(i); return s },
    [`reverse()L${n.slice(1)}`]: (v, s) => { s.f.s = [...s.f.s].reverse().join(''); return s },
    [`deleteCharAt(I)L${n.slice(1)}`]: (v, s, [i]) => { s.f.s = s.f.s.slice(0, i) + s.f.s.slice(i + 1); return s },
    'length()I': (v, s) => s.f.s.length,
    'charAt(I)C': (v, s, [i]) => s.f.s.charCodeAt(i),
    'setLength(I)V': (v, s, [n2]) => { s.f.s = s.f.s.slice(0, n2).padEnd(n2, '\0') },
    'toString()Ljava/lang/String;': (v, s) => s.f.s,
  }, { interfaces: ['Ljava/lang/CharSequence;'] })
  sb('Ljava/lang/StringBuilder;')
  sb('Ljava/lang/StringBuffer;')

  // boxes
  const boxCls = (n: string, prim: string, parse: (s: string) => any, toS: (x: any) => string) => def(n, 'Ljava/lang/Number;', {
    [`<init>(${prim})V`]: (v, s, [x]) => { s.f.value = x },
    [`${({ I: 'int', J: 'long', Z: 'boolean', D: 'double', F: 'float', C: 'char', S: 'short', B: 'byte' } as any)[prim]}Value()${prim}`]: (v, s) => s.f.value,
    'intValue()I': (v, s) => Number(s.f.value) | 0,
    'longValue()J': (v, s) => BigInt(typeof s.f.value === 'bigint' ? s.f.value : Math.trunc(Number(s.f.value))),
    'doubleValue()D': (v, s) => Number(s.f.value),
    'floatValue()F': (v, s) => Math.fround(Number(s.f.value)),
    'toString()Ljava/lang/String;': (v, s) => toS(s.f.value),
    'hashCode()I': (v, s) => Number(s.f.value) | 0,
    'equals(Ljava/lang/Object;)Z': (v, s, [o]) => (o instanceof JObject && o.cls === s.cls && o.f.value === s.f.value ? 1 : 0),
    [`valueOf(${prim})L${n.slice(1)}`]: (v, s, [x]) => box(vm, n, x),
    [`valueOf(Ljava/lang/String;)L${n.slice(1)}`]: (v, s, [x]) => box(vm, n, parse(x)),
    [`toString(${prim})Ljava/lang/String;`]: (v, s, [x]) => toS(x),
  })
  const parseInt = (s: string, radix = 10) => {
    if (s == null || !/^[+-]?[0-9a-zA-Z]+$/.test(s.trim()) || isNaN(parseInt2(s, radix))) throw vm.error('Ljava/lang/NumberFormatException;', `Invalid int: "${s}"`)
    return parseInt2(s, radix) | 0
  }
  const parseInt2 = (s: string, r: number) => Number.parseInt(s, r)
  boxCls('Ljava/lang/Integer;', 'I', (s) => parseInt(s), (x) => String(x))
  boxCls('Ljava/lang/Long;', 'J', (s) => BigInt(s), (x) => String(x))
  boxCls('Ljava/lang/Double;', 'D', (s) => Number(s), jnum)
  boxCls('Ljava/lang/Float;', 'F', (s) => Math.fround(Number(s)), jnum)
  boxCls('Ljava/lang/Boolean;', 'Z', (s) => (s?.toLowerCase() === 'true' ? 1 : 0), (x) => (x ? 'true' : 'false'))
  boxCls('Ljava/lang/Character;', 'C', (s) => s.charCodeAt(0), jchar)
  boxCls('Ljava/lang/Short;', 'S', (s) => parseInt(s), String)
  boxCls('Ljava/lang/Byte;', 'B', (s) => parseInt(s), String)
  def('Ljava/lang/Number;', OBJ, {})
  Object.assign(vm.shims.get('Ljava/lang/Integer;')!.methods!, {
    'parseInt(Ljava/lang/String;)I': (v: VM, s: any, [x]: any[]) => parseInt(x),
    'parseInt(Ljava/lang/String;I)I': (v: VM, s: any, [x, r]: any[]) => parseInt(x, r),
    'toHexString(I)Ljava/lang/String;': (v: VM, s: any, [x]: any[]) => (x >>> 0).toString(16),
    'toBinaryString(I)Ljava/lang/String;': (v: VM, s: any, [x]: any[]) => (x >>> 0).toString(2),
    'toString(II)Ljava/lang/String;': (v: VM, s: any, [x, r]: any[]) => x.toString(r),
    'compare(II)I': (v: VM, s: any, [a, b]: any[]) => (a < b ? -1 : a > b ? 1 : 0),
    'bitCount(I)I': (v: VM, s: any, [x]: any[]) => { let n = 0; for (let y = x >>> 0; y; y >>>= 1) n += y & 1; return n },
  })
  vm.shims.get('Ljava/lang/Integer;')!.statics = { MAX_VALUE: 2147483647, MIN_VALUE: -2147483648 }
  Object.assign(vm.shims.get('Ljava/lang/Long;')!.methods!, { 'parseLong(Ljava/lang/String;)J': (v: VM, s: any, [x]: any[]) => BigInt(x), 'toHexString(J)Ljava/lang/String;': (v: VM, s: any, [x]: any[]) => BigInt.asUintN(64, x).toString(16) })
  Object.assign(vm.shims.get('Ljava/lang/Double;')!.methods!, { 'parseDouble(Ljava/lang/String;)D': (v: VM, s: any, [x]: any[]) => { const n = Number(x); if (isNaN(n) && x?.trim() !== 'NaN') throw vm.error('Ljava/lang/NumberFormatException;', x); return n }, 'isNaN(D)Z': (v: VM, s: any, [x]: any[]) => (isNaN(x) ? 1 : 0) })
  Object.assign(vm.shims.get('Ljava/lang/Float;')!.methods!, { 'parseFloat(Ljava/lang/String;)F': (v: VM, s: any, [x]: any[]) => Math.fround(Number(x)) })
  Object.assign(vm.shims.get('Ljava/lang/Boolean;')!.methods!, { 'parseBoolean(Ljava/lang/String;)Z': (v: VM, s: any, [x]: any[]) => (x?.toLowerCase() === 'true' ? 1 : 0) })
  Object.assign(vm.shims.get('Ljava/lang/Character;')!.methods!, {
    'isDigit(C)Z': (v: VM, s: any, [c]: any[]) => (/\d/.test(jchar(c)) ? 1 : 0),
    'isLetter(C)Z': (v: VM, s: any, [c]: any[]) => (/\p{L}/u.test(jchar(c)) ? 1 : 0),
    'isWhitespace(C)Z': (v: VM, s: any, [c]: any[]) => (/\s/.test(jchar(c)) ? 1 : 0),
    'toUpperCase(C)C': (v: VM, s: any, [c]: any[]) => jchar(c).toUpperCase().charCodeAt(0),
    'toLowerCase(C)C': (v: VM, s: any, [c]: any[]) => jchar(c).toLowerCase().charCodeAt(0),
  })

  const M = (f: (...a: number[]) => number): NativeFn => (v, s, a) => f(...a)
  def('Ljava/lang/Math;', OBJ, {
    'max(II)I': M(Math.max), 'min(II)I': M(Math.min), 'abs(I)I': M((x) => Math.abs(x) | 0),
    'max(JJ)J': (v, s, [a, b]) => (a > b ? a : b), 'min(JJ)J': (v, s, [a, b]) => (a < b ? a : b), 'abs(J)J': (v, s, [a]) => (a < 0n ? -a : a),
    'max(DD)D': M(Math.max), 'min(DD)D': M(Math.min), 'abs(D)D': M(Math.abs), 'max(FF)F': M(Math.max), 'min(FF)F': M(Math.min), 'abs(F)F': M(Math.abs),
    'sqrt(D)D': M(Math.sqrt), 'pow(DD)D': M(Math.pow), 'sin(D)D': M(Math.sin), 'cos(D)D': M(Math.cos), 'tan(D)D': M(Math.tan), 'atan2(DD)D': M(Math.atan2),
    'atan(D)D': M(Math.atan), 'asin(D)D': M(Math.asin), 'acos(D)D': M(Math.acos), 'exp(D)D': M(Math.exp), 'log(D)D': M(Math.log), 'log10(D)D': M(Math.log10),
    'floor(D)D': M(Math.floor), 'ceil(D)D': M(Math.ceil), 'round(D)J': (v, s, [x]) => BigInt(Math.floor(x + 0.5)), 'round(F)I': M((x) => Math.floor(x + 0.5) | 0),
    'random()D': M(Math.random), 'toRadians(D)D': M((x) => (x * Math.PI) / 180), 'toDegrees(D)D': M((x) => (x * 180) / Math.PI), 'hypot(DD)D': M(Math.hypot), 'signum(F)F': M(Math.sign),
  }, { statics: { PI: Math.PI, E: Math.E } })
  vm.shims.set('Ljava/lang/StrictMath;', vm.shims.get('Ljava/lang/Math;')!)

  const start = performance.now()
  def('Ljava/lang/System;', OBJ, {
    'currentTimeMillis()J': () => BigInt(Date.now()),
    'nanoTime()J': () => BigInt(Math.round((performance.now() - start) * 1e6)),
    'arraycopy(Ljava/lang/Object;ILjava/lang/Object;II)V': (v, s, [src, sp, dst, dp, n]) => {
      if (src == null || dst == null) throw vm.error('Ljava/lang/NullPointerException;', 'arraycopy')
      if (sp < 0 || dp < 0 || n < 0 || sp + n > src.data.length || dp + n > dst.data.length) throw vm.error('Ljava/lang/ArrayIndexOutOfBoundsException;', 'arraycopy')
      const tmp = Array.prototype.slice.call(src.data, sp, sp + n)
      for (let i = 0; i < n; i++) dst.data[dp + i] = tmp[i]
    },
    'getProperty(Ljava/lang/String;)Ljava/lang/String;': (v, s, [k]) => ({ 'line.separator': '\n', 'java.vm.version': '1.6.0', 'os.arch': 'armv7l', 'http.agent': 'droid/4.4' } as any)[k] ?? null,
    'identityHashCode(Ljava/lang/Object;)I': (v, s, [o]) => (o ? identityHash(o) : 0),
    'gc()V': () => {},
    'exit(I)V': () => { (globalThis as any).droid?.app.finish() },
    'loadLibrary(Ljava/lang/String;)V': () => { /* replaced by the android runtime */ },
  })
  const out = new JObject(vm.cls('Ljava/io/PrintStream;'))
  vm.shims.get('Ljava/lang/System;')!.statics = { out, err: out }
  def('Ljava/io/PrintStream;', OBJ, {
    'println(Ljava/lang/String;)V': (v, s, [x]) => vm.log(String(x)),
    'println(Ljava/lang/Object;)V': (v, s, [x]) => vm.log(jstr(vm, x)),
    'println(I)V': (v, s, [x]) => vm.log(String(x)),
    'println()V': () => vm.log(''),
    'print(Ljava/lang/String;)V': (v, s, [x]) => vm.log(String(x)),
  })

  // throwables
  def('Ljava/lang/Throwable;', OBJ, {
    '<init>()V': () => {},
    '<init>(Ljava/lang/String;)V': (v, s, [m]) => { s.f.message = m },
    '<init>(Ljava/lang/String;Ljava/lang/Throwable;)V': (v, s, [m, c]) => { s.f.message = m; s.f.cause = c },
    '<init>(Ljava/lang/Throwable;)V': (v, s, [c]) => { s.f.cause = c; s.f.message = c ? jstr(vm, c) : null },
    'getMessage()Ljava/lang/String;': (v, s) => s.f.message ?? null,
    'getLocalizedMessage()Ljava/lang/String;': (v, s) => s.f.message ?? null,
    'getCause()Ljava/lang/Throwable;': (v, s) => s.f.cause ?? null,
    'toString()Ljava/lang/String;': (v, s) => s.cls.name.slice(1, -1).replace(/\//g, '.') + (s.f.message != null ? ': ' + s.f.message : ''),
    'printStackTrace()V': (v, s) => console.warn('java exception', jstr(vm, s)),
    'getStackTrace()[Ljava/lang/StackTraceElement;': () => vm.newArray('[Ljava/lang/StackTraceElement;', 0),
  })
  throwable('Ljava/lang/Exception;', 'Ljava/lang/Throwable;')
  throwable('Ljava/lang/Error;', 'Ljava/lang/Throwable;')
  throwable('Ljava/lang/RuntimeException;', 'Ljava/lang/Exception;')
  for (const n of ['NullPointerException', 'ArithmeticException', 'ClassCastException', 'IllegalStateException', 'IllegalArgumentException', 'UnsupportedOperationException', 'IndexOutOfBoundsException', 'NegativeArraySizeException', 'SecurityException'])
    throwable(`Ljava/lang/${n};`, 'Ljava/lang/RuntimeException;')
  throwable('Ljava/lang/NumberFormatException;', 'Ljava/lang/IllegalArgumentException;')
  throwable('Ljava/lang/ArrayIndexOutOfBoundsException;', 'Ljava/lang/IndexOutOfBoundsException;')
  throwable('Ljava/lang/StringIndexOutOfBoundsException;', 'Ljava/lang/IndexOutOfBoundsException;')
  throwable('Ljava/util/NoSuchElementException;', 'Ljava/lang/RuntimeException;')
  throwable('Ljava/util/ConcurrentModificationException;', 'Ljava/lang/RuntimeException;')
  throwable('Ljava/lang/InterruptedException;', 'Ljava/lang/Exception;')
  throwable('Ljava/io/IOException;', 'Ljava/lang/Exception;')
  throwable('Ljava/lang/CloneNotSupportedException;', 'Ljava/lang/Exception;')
  for (const n of ['LinkageError', 'VirtualMachineError']) throwable(`Ljava/lang/${n};`, 'Ljava/lang/Error;')
  for (const n of ['UnsatisfiedLinkError', 'NoClassDefFoundError', 'VerifyError', 'IncompatibleClassChangeError']) throwable(`Ljava/lang/${n};`, 'Ljava/lang/LinkageError;')
  for (const n of ['NoSuchMethodError', 'AbstractMethodError', 'NoSuchFieldError']) throwable(`Ljava/lang/${n};`, 'Ljava/lang/IncompatibleClassChangeError;')
  throwable('Ljava/lang/StackOverflowError;', 'Ljava/lang/VirtualMachineError;')
  throwable('Ljava/lang/OutOfMemoryError;', 'Ljava/lang/VirtualMachineError;')

  // threads: no real threads; Thread.start runs on the event loop
  def('Ljava/lang/Runnable;', OBJ, {})
  def('Ljava/lang/Thread;', OBJ, {
    '<init>()V': () => {},
    '<init>(Ljava/lang/Runnable;)V': (v, s, [r]) => { s.f.target = r },
    '<init>(Ljava/lang/Runnable;Ljava/lang/String;)V': (v, s, [r]) => { s.f.target = r },
    'start()V': (v, s) => setTimeout(() => { try { s.f.target ? vm.callVirtual(s.f.target, 'run()V') : vm.callVirtual(s, 'run()V') } catch (e) { console.warn('thread', e instanceof JavaThrow ? jstr(vm, e.obj) : e) } }, 0),
    'run()V': (v, s) => { if (s.f.target) vm.callVirtual(s.f.target, 'run()V') },
    'sleep(J)V': () => {},
    'currentThread()Ljava/lang/Thread;': () => mainThread,
    'getName()Ljava/lang/String;': () => 'main',
    'interrupt()V': () => {}, 'setDaemon(Z)V': () => {}, 'setPriority(I)V': () => {}, 'join()V': () => {},
  }, { interfaces: ['Ljava/lang/Runnable;'] })
  const mainThread = new JObject(vm.cls('Ljava/lang/Thread;'))

  // collections: backed by js arrays and maps
  def('Ljava/lang/Iterable;', OBJ, {})
  def('Ljava/util/Collection;', OBJ, {}, { interfaces: ['Ljava/lang/Iterable;'] })
  def('Ljava/util/List;', OBJ, {}, { interfaces: ['Ljava/util/Collection;'] })
  def('Ljava/util/Iterator;', OBJ, {
    'hasNext()Z': (v, s) => (s.f.hasNext() ? 1 : 0),
    'next()Ljava/lang/Object;': (v, s) => { if (!s.f.hasNext()) throw vm.error('Ljava/util/NoSuchElementException;', ''); return s.f.next() },
    'remove()V': (v, s) => s.f.remove(),
  })
  const list: Record<string, NativeFn> = {
    '<init>()V': (v, s) => { s.f.a = [] },
    '<init>(I)V': (v, s) => { s.f.a = [] },
    '<init>(Ljava/util/Collection;)V': (v, s, [c]) => { s.f.a = [...(c?.f.a || [])] },
    'add(Ljava/lang/Object;)Z': (v, s, [x]) => { s.f.a.push(x); return 1 },
    'add(ILjava/lang/Object;)V': (v, s, [i, x]) => { s.f.a.splice(i, 0, x) },
    'addAll(Ljava/util/Collection;)Z': (v, s, [c]) => { s.f.a.push(...(c?.f.a || [])); return 1 },
    'get(I)Ljava/lang/Object;': (v, s, [i]) => { if (i < 0 || i >= s.f.a.length) throw vm.error('Ljava/lang/IndexOutOfBoundsException;', `Invalid index ${i}, size is ${s.f.a.length}`); return s.f.a[i] },
    'set(ILjava/lang/Object;)Ljava/lang/Object;': (v, s, [i, x]) => { const o = s.f.a[i]; s.f.a[i] = x; return o },
    'size()I': (v, s) => s.f.a.length,
    'isEmpty()Z': (v, s) => (s.f.a.length ? 0 : 1),
    'clear()V': (v, s) => { s.f.a.length = 0 },
    'remove(I)Ljava/lang/Object;': (v, s, [i]) => s.f.a.splice(i, 1)[0],
    'remove(Ljava/lang/Object;)Z': (v, s, [x]) => { const i = s.f.a.findIndex((y: any) => jeq(vm, x, y)); if (i < 0) return 0; s.f.a.splice(i, 1); return 1 },
    'contains(Ljava/lang/Object;)Z': (v, s, [x]) => (s.f.a.some((y: any) => jeq(vm, x, y)) ? 1 : 0),
    'indexOf(Ljava/lang/Object;)I': (v, s, [x]) => s.f.a.findIndex((y: any) => jeq(vm, x, y)),
    'iterator()Ljava/util/Iterator;': (v, s) => iterator(vm, () => s.f.a),
    'toArray()[Ljava/lang/Object;': (v, s) => { const a = vm.newArray('[Ljava/lang/Object;', s.f.a.length); s.f.a.forEach((x: any, i: number) => ((a.data as any)[i] = x)); return a },
    'toString()Ljava/lang/String;': (v, s) => '[' + s.f.a.map((x: any) => jstr(vm, x)).join(', ') + ']',
  }
  def('Ljava/util/AbstractList;', OBJ, {}, { interfaces: ['Ljava/util/List;'] })
  def('Ljava/util/ArrayList;', 'Ljava/util/AbstractList;', list, { interfaces: ['Ljava/util/List;'] })
  def('Ljava/util/LinkedList;', 'Ljava/util/AbstractList;', { ...list, 'addFirst(Ljava/lang/Object;)V': (v, s, [x]) => { s.f.a.unshift(x) }, 'removeFirst()Ljava/lang/Object;': (v, s) => s.f.a.shift(), 'getFirst()Ljava/lang/Object;': (v, s) => s.f.a[0] }, { interfaces: ['Ljava/util/List;'] })
  def('Ljava/util/Vector;', 'Ljava/util/AbstractList;', list, { interfaces: ['Ljava/util/List;'] })
  def('Ljava/util/Map;', OBJ, {})
  const keyOf = (k: any) => (k == null ? 'null' : typeof k === 'string' ? 's' + k : k instanceof JObject && 'value' in k.f ? 'b' + String(k.f.value) : k)
  def('Ljava/util/HashMap;', OBJ, {
    '<init>()V': (v, s) => { s.f.m = new Map() },
    '<init>(I)V': (v, s) => { s.f.m = new Map() },
    'put(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;': (v, s, [k, x]) => { const o = s.f.m.get(keyOf(k)); s.f.m.set(keyOf(k), [k, x]); return o ? o[1] : null },
    'get(Ljava/lang/Object;)Ljava/lang/Object;': (v, s, [k]) => s.f.m.get(keyOf(k))?.[1] ?? null,
    'containsKey(Ljava/lang/Object;)Z': (v, s, [k]) => (s.f.m.has(keyOf(k)) ? 1 : 0),
    'remove(Ljava/lang/Object;)Ljava/lang/Object;': (v, s, [k]) => { const o = s.f.m.get(keyOf(k)); s.f.m.delete(keyOf(k)); return o ? o[1] : null },
    'size()I': (v, s) => s.f.m.size,
    'isEmpty()Z': (v, s) => (s.f.m.size ? 0 : 1),
    'clear()V': (v, s) => s.f.m.clear(),
  }, { interfaces: ['Ljava/util/Map;'] })
  vm.shims.set('Ljava/util/Hashtable;', vm.shims.get('Ljava/util/HashMap;')!)
  def('Ljava/util/Random;', OBJ, {
    '<init>()V': () => {}, '<init>(J)V': () => {},
    'nextInt()I': () => (Math.random() * 4294967296) | 0,
    'nextInt(I)I': (v, s, [n]) => Math.floor(Math.random() * n),
    'nextFloat()F': () => Math.fround(Math.random()),
    'nextDouble()D': () => Math.random(),
    'nextBoolean()Z': () => (Math.random() < 0.5 ? 1 : 0),
  })
  def('Ljava/util/Arrays;', OBJ, {
    'fill([II)V': (v, s, [a, x]) => a.data.fill(x),
    'sort([I)V': (v, s, [a]) => (a.data as Int32Array).sort(),
    'asList([Ljava/lang/Object;)Ljava/util/List;': (v, s, [a]) => { const l = new JObject(vm.cls('Ljava/util/ArrayList;')); l.f.a = [...a.data]; return l },
    'toString([I)Ljava/lang/String;': (v, s, [a]) => '[' + [...a.data].join(', ') + ']',
  })
}

export function jeq(vm: VM, a: any, b: any) {
  if (a === b) return true
  if (a == null || b == null) return false
  if (typeof a === 'string' || typeof b === 'string') return a === b
  return !!vm.callVirtual(a, 'equals(Ljava/lang/Object;)Z', [b])
}
export { JArray }
