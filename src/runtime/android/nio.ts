// java.nio buffers: ByteBuffer and the typed buffers (short, char, int, long, float, double), heap
// and direct, with byte order, views (asFloatBuffer...), slices and bulk get / put. every buffer is a
// window on bytes: a java array's bytes for heap buffers, and for direct buffers native memory when a
// native library is loaded (so JNI's GetDirectBufferAddress gives code a real pointer), else js bytes.
import { jstr } from './java.ts'
import { VM, JObject, JArray, type NativeFn } from './dalvik.ts'

const NIO = 'Ljava/nio/'
const OBJ = 'Ljava/lang/Object;'
type Kind = 'Byte' | 'Short' | 'Char' | 'Int' | 'Long' | 'Float' | 'Double'
const SIZE: Record<Kind, number> = { Byte: 1, Short: 2, Char: 2, Int: 4, Long: 8, Float: 4, Double: 8 }
const SIG: Record<Kind, string> = { Byte: 'B', Short: 'S', Char: 'C', Int: 'I', Long: 'J', Float: 'F', Double: 'D' }

// what a buffer object holds (in s.f)
interface B {
  bytes: () => Uint8Array // the whole backing store (re-read: native memory can grow)
  base: number // byte offset of element 0
  cap: number; pos: number; lim: number; mark: number // in elements
  le: boolean
  kind: Kind
  direct: boolean
  addr?: number // native address of element 0 (direct buffers in native memory)
  array?: JArray; arrayOffset?: number
  readOnly?: boolean
}

export interface DirectAlloc { alloc(n: number): number; bytes(): Uint8Array }

export function registerNio(vm: VM) {
  const b = (s: JObject) => s.f.nio as B
  const make = (kind: Kind, x: Omit<B, 'kind' | 'mark'> & { mark?: number }) => {
    const o = new JObject(vm.cls(NIO + kind + 'Buffer;'))
    o.f.nio = { mark: -1, ...x, kind } satisfies B
    return o
  }
  const dv = (x: B) => { const u = x.bytes(); return new DataView(u.buffer, u.byteOffset, u.byteLength) }
  const getAt = (x: B, i: number): any => {
    if (i < 0 || i >= x.lim) throw vm.error('Ljava/lang/IndexOutOfBoundsException;', `index ${i}, limit ${x.lim}`)
    return read(x, x.kind, x.base + i * SIZE[x.kind])
  }
  const read = (x: B, k: Kind, at: number): any => {
    const d = dv(x)
    switch (k) {
      case 'Byte': return d.getInt8(at)
      case 'Short': return d.getInt16(at, x.le)
      case 'Char': return d.getUint16(at, x.le)
      case 'Int': return d.getInt32(at, x.le)
      case 'Long': return d.getBigInt64(at, x.le)
      case 'Float': return d.getFloat32(at, x.le)
      case 'Double': return d.getFloat64(at, x.le)
    }
  }
  const write = (x: B, k: Kind, at: number, v: any) => {
    if (x.readOnly) throw vm.error('Ljava/nio/ReadOnlyBufferException;', '')
    const d = dv(x)
    switch (k) {
      case 'Byte': d.setInt8(at, v); break
      case 'Short': d.setInt16(at, v, x.le); break
      case 'Char': d.setUint16(at, v, x.le); break
      case 'Int': d.setInt32(at, v, x.le); break
      case 'Long': d.setBigInt64(at, BigInt(v), x.le); break
      case 'Float': d.setFloat32(at, v, x.le); break
      case 'Double': d.setFloat64(at, v, x.le); break
    }
  }
  const putAt = (x: B, i: number, v: any) => {
    if (i < 0 || i >= x.lim) throw vm.error('Ljava/lang/IndexOutOfBoundsException;', `index ${i}, limit ${x.lim}`)
    write(x, x.kind, x.base + i * SIZE[x.kind], v)
  }
  const next = (x: B, n = 1) => {
    if (x.pos + n > x.lim) throw vm.error('Ljava/nio/BufferUnderflowException;', '')
    const p = x.pos; x.pos += n; return p
  }
  const nextPut = (x: B, n = 1) => {
    if (x.pos + n > x.lim) throw vm.error('Ljava/nio/BufferOverflowException;', '')
    const p = x.pos; x.pos += n; return p
  }
  // bytes of a java primitive array (shared, not copied)
  const arrayBytes = (a: JArray) => {
    const d = a.data as any
    if (!ArrayBuffer.isView(d)) throw new Error('nio: long[] buffers are not supported')
    return new Uint8Array(d.buffer, d.byteOffset, d.byteLength)
  }
  const heap = (kind: Kind, n: number) => {
    const arr = vm.newArray('[' + SIG[kind], n)
    if (kind === 'Long') return make(kind, { bytes: (() => { const u = new Uint8Array(n * 8); return () => u })(), base: 0, cap: n, pos: 0, lim: n, le: false, direct: false })
    const u = arrayBytes(arr)
    return make(kind, { bytes: () => u, base: 0, cap: n, pos: 0, lim: n, le: kind !== 'Byte' ? true : false, direct: false, array: arr, arrayOffset: 0 })
  }
  const direct = (n: number) => {
    const d = (vm as any).directAlloc as DirectAlloc | undefined
    if (d) { const addr = d.alloc(Math.max(n, 1)); d.bytes().fill(0, addr, addr + n); return make('Byte', { bytes: () => d.bytes(), base: addr, cap: n, pos: 0, lim: n, le: false, direct: true, addr }) }
    const u = new Uint8Array(n)
    return make('Byte', { bytes: () => u, base: 0, cap: n, pos: 0, lim: n, le: false, direct: true })
  }
  // a view: same bytes, from the current position (slice / duplicate / asXBuffer)
  const view = (x: B, kind: Kind, from: number, count: number, keepPos: boolean): JObject => {
    const es = SIZE[x.kind]
    const byteStart = x.base + from * es
    const n = Math.floor((count * es) / SIZE[kind])
    const o = make(kind, { bytes: x.bytes, base: byteStart, cap: n, pos: 0, lim: n, le: x.le, direct: x.direct, readOnly: x.readOnly,
      addr: x.addr !== undefined ? x.addr + from * es : undefined,
      array: kind === x.kind ? x.array : undefined, arrayOffset: kind === x.kind && x.array ? (x.arrayOffset ?? 0) + from : undefined })
    if (keepPos) { const y = b(o); y.pos = x.pos; y.lim = x.lim; y.cap = x.cap; y.mark = x.mark; y.base = x.base; if (x.addr !== undefined) y.addr = x.addr; y.arrayOffset = x.arrayOffset }
    return o
  }
  const order = (le: boolean) => vm.cls(NIO + 'ByteOrder;').staticValues[le ? 'LITTLE_ENDIAN' : 'BIG_ENDIAN']

  // ---------- java.nio.Buffer (the shared part) ----------
  const common = (ret: string): Record<string, NativeFn> => ({
    'capacity()I': (v, s) => b(s).cap,
    'position()I': (v, s) => b(s).pos,
    [`position(I)${ret}`]: (v, s, [p]) => { const x = b(s); if (p < 0 || p > x.lim) throw vm.error('Ljava/lang/IllegalArgumentException;', 'position ' + p); x.pos = p; if (x.mark > p) x.mark = -1; return s },
    'limit()I': (v, s) => b(s).lim,
    [`limit(I)${ret}`]: (v, s, [l]) => { const x = b(s); if (l < 0 || l > x.cap) throw vm.error('Ljava/lang/IllegalArgumentException;', 'limit ' + l); x.lim = l; if (x.pos > l) x.pos = l; if (x.mark > l) x.mark = -1; return s },
    [`mark()${ret}`]: (v, s) => { const x = b(s); x.mark = x.pos; return s },
    [`reset()${ret}`]: (v, s) => { const x = b(s); if (x.mark < 0) throw vm.error('Ljava/nio/InvalidMarkException;', ''); x.pos = x.mark; return s },
    [`clear()${ret}`]: (v, s) => { const x = b(s); x.pos = 0; x.lim = x.cap; x.mark = -1; return s },
    [`flip()${ret}`]: (v, s) => { const x = b(s); x.lim = x.pos; x.pos = 0; x.mark = -1; return s },
    [`rewind()${ret}`]: (v, s) => { const x = b(s); x.pos = 0; x.mark = -1; return s },
    'remaining()I': (v, s) => { const x = b(s); return x.lim - x.pos },
    'hasRemaining()Z': (v, s) => { const x = b(s); return x.pos < x.lim ? 1 : 0 },
    'isDirect()Z': (v, s) => (b(s).direct ? 1 : 0),
    'isReadOnly()Z': (v, s) => (b(s).readOnly ? 1 : 0),
    'hasArray()Z': (v, s) => (b(s).array && !b(s).readOnly ? 1 : 0),
    'array()Ljava/lang/Object;': (v, s) => { const x = b(s); if (!x.array) throw vm.error('Ljava/lang/UnsupportedOperationException;', ''); return x.array },
    'arrayOffset()I': (v, s) => b(s).arrayOffset ?? 0,
  })
  vm.shim(NIO + 'Buffer;', { super: OBJ, methods: common(`L${NIO.slice(1)}Buffer;`) })

  for (const kind of Object.keys(SIZE) as Kind[]) {
    const T = SIG[kind], name = `${NIO}${kind}Buffer;`, self = `L${NIO.slice(1)}${kind}Buffer;`
    const box = (x: any) => (kind === 'Char' ? x & 0xffff : x)
    const methods: Record<string, NativeFn> = {
      // the covariant forms newer compilers call (ByteBuffer.position(I)Ljava/nio/ByteBuffer; ...)
      ...common(self),
      [`get()${T}`]: (v, s) => { const x = b(s); return getAt(x, next(x)) },
      [`get(I)${T}`]: (v, s, [i]) => getAt(b(s), i),
      [`put(${T})${self}`]: (v, s, [val]) => { const x = b(s); putAt(x, nextPut(x), box(val)); return s },
      [`put(I${T})${self}`]: (v, s, [i, val]) => { putAt(b(s), i, box(val)); return s },
      [`get([${T}II)${self}`]: (v, s, [arr, off, len]) => {
        const x = b(s), p = next(x, len)
        if (kind === 'Byte') { const u = x.bytes(); (arr.data as Int8Array).set(new Int8Array(u.buffer, u.byteOffset + x.base + p, len), off); return s }
        for (let i = 0; i < len; i++) (arr.data as any)[off + i] = getAt(x, p + i)
        return s
      },
      [`get([${T})${self}`]: (v, s, [arr]) => methods[`get([${T}II)${self}`](v, s, [arr, 0, arr.data.length]),
      [`put([${T}II)${self}`]: (v, s, [arr, off, len]) => {
        const x = b(s), p = nextPut(x, len)
        if (kind === 'Byte' && !x.readOnly) { const u = x.bytes(); u.set(new Uint8Array((arr.data as Int8Array).buffer, (arr.data as Int8Array).byteOffset + off, len), x.base + p); return s }
        if (x.le && kind !== 'Long' && !x.readOnly && ArrayBuffer.isView(arr.data)) { // same layout as a little-endian typed array
          const src = arr.data as any, es = SIZE[kind]
          x.bytes().set(new Uint8Array(src.buffer, src.byteOffset + off * es, len * es), x.base + p * es)
          return s
        }
        for (let i = 0; i < len; i++) putAt(x, p + i, (arr.data as any)[off + i])
        return s
      },
      [`put([${T})${self}`]: (v, s, [arr]) => methods[`put([${T}II)${self}`](v, s, [arr, 0, arr.data.length]),
      [`put(${self})${self}`]: (v, s, [src]) => {
        const y = b(src), x = b(s), n = y.lim - y.pos
        const p = nextPut(x, n)
        const tmp: any[] = []
        for (let i = 0; i < n; i++) tmp.push(getAt(y, y.pos + i))
        y.pos += n
        tmp.forEach((val, i) => putAt(x, p + i, val))
        return s
      },
      [`slice()${self}`]: (v, s) => { const x = b(s); return view(x, kind, x.pos, x.lim - x.pos, false) },
      [`duplicate()${self}`]: (v, s) => { const x = b(s); return view(x, kind, 0, x.cap, true) },
      [`asReadOnlyBuffer()${self}`]: (v, s) => { const x = b(s); const o = view(x, kind, 0, x.cap, true); b(o).readOnly = true; return o },
      [`compact()${self}`]: (v, s) => {
        const x = b(s), n = x.lim - x.pos, es = SIZE[kind], u = x.bytes()
        u.copyWithin(x.base, x.base + x.pos * es, x.base + x.lim * es)
        x.pos = n; x.lim = x.cap; x.mark = -1
        return s
      },
      'order()Ljava/nio/ByteOrder;': (v, s) => order(b(s).le),
      'hashCode()I': (v, s) => { const x = b(s); let h = 1; for (let i = x.lim - 1; i >= x.pos; i--) h = (31 * h + Number(getAt(x, i))) | 0; return h },
      'toString()Ljava/lang/String;': (v, s) => { const x = b(s); return `java.nio.${kind}Buffer[pos=${x.pos} lim=${x.lim} cap=${x.cap}]` },
      'equals(Ljava/lang/Object;)Z': (v, s, [o]) => {
        if (!(o instanceof JObject) || !o.f.nio || b(o).kind !== kind) return 0
        const x = b(s), y = b(o)
        if (x.lim - x.pos !== y.lim - y.pos) return 0
        for (let i = 0; i < x.lim - x.pos; i++) if (getAt(x, x.pos + i) !== getAt(y, y.pos + i)) return 0
        return 1
      },
      [`array()[${T}`]: (v, s) => { const x = b(s); if (!x.array) throw vm.error('Ljava/lang/UnsupportedOperationException;', ''); return x.array },
    }
    const statics: Record<string, any> = {}
    const staticMethods: Record<string, NativeFn> = {
      [`allocate(I)${self}`]: (v, s, [n]) => heap(kind, n),
      [`wrap([${T})${self}`]: (v, s, [arr]) => wrap(kind, arr, 0, arr.data.length),
      [`wrap([${T}II)${self}`]: (v, s, [arr, off, len]) => wrap(kind, arr, off, len),
    }
    if (kind === 'Byte') {
      Object.assign(staticMethods, { 'allocateDirect(I)Ljava/nio/ByteBuffer;': (v: VM, s: any, [n]: any[]) => direct(n) })
      Object.assign(methods, {
        'order(Ljava/nio/ByteOrder;)Ljava/nio/ByteBuffer;': (v: VM, s: JObject, [o]: any[]) => { b(s).le = !!o?.f?.le; return s },
        'isDirect()Z': (v: VM, s: JObject) => (b(s).direct ? 1 : 0),
      })
      // typed reads and writes, and typed views of the bytes
      for (const k of ['Short', 'Char', 'Int', 'Long', 'Float', 'Double'] as Kind[]) {
        const t = SIG[k], es = SIZE[k]
        methods[`get${k}()${t}`] = (v, s) => { const x = b(s); return read(x, k, x.base + next(x, es)) }
        methods[`get${k}(I)${t}`] = (v, s, [i]) => { const x = b(s); if (i < 0 || i + es > x.lim) throw vm.error('Ljava/lang/IndexOutOfBoundsException;', String(i)); return read(x, k, x.base + i) }
        methods[`put${k}(${t})Ljava/nio/ByteBuffer;`] = (v, s, [val]) => { const x = b(s); write(x, k, x.base + nextPut(x, es), k === 'Char' ? val & 0xffff : val); return s }
        methods[`put${k}(I${t})Ljava/nio/ByteBuffer;`] = (v, s, [i, val]) => { const x = b(s); if (i < 0 || i + es > x.lim) throw vm.error('Ljava/lang/IndexOutOfBoundsException;', String(i)); write(x, k, x.base + i, k === 'Char' ? val & 0xffff : val); return s }
        methods[`as${k}Buffer()L${NIO.slice(1)}${k}Buffer;`] = (v, s) => { const x = b(s); return view(x, k, x.pos, x.lim - x.pos, false) }
      }
    }
    if (kind === 'Char') {
      // a CharBuffer is a CharSequence of what is between position and limit
      const str = (x: any, a: number, e: number) => { let t = ''; for (let i = a; i < e; i++) t += String.fromCharCode(Number(getAt(x, i))); return t }
      Object.assign(methods, {
        'charAt(I)C': (v: VM, s: JObject, [i]: any[]) => { const x = b(s); if (i < 0 || i >= x.lim - x.pos) throw vm.error('Ljava/lang/IndexOutOfBoundsException;', String(i)); return Number(getAt(x, x.pos + i)) },
        'length()I': (v: VM, s: JObject) => { const x = b(s); return x.lim - x.pos },
        'toString()Ljava/lang/String;': (v: VM, s: JObject) => { const x = b(s); return str(x, x.pos, x.lim) },
        'subSequence(II)Ljava/lang/CharSequence;': (v: VM, s: JObject, [a, e]: any[]) => { const x = b(s); return str(x, x.pos + a, x.pos + e) },
      })
      staticMethods['wrap(Ljava/lang/CharSequence;)Ljava/nio/CharBuffer;'] = (v, s, [cs]) => { const t = jstr(vm, cs); const arr = vm.newArray('[C', t.length); for (let i = 0; i < t.length; i++) (arr.data as any)[i] = t.charCodeAt(i); return wrap('Char', arr, 0, t.length) }
    }
    vm.shim(name, { super: NIO + 'Buffer;', interfaces: kind === 'Char' ? ['Ljava/lang/CharSequence;'] : [], methods: { ...methods, ...staticMethods }, statics })
  }
  function wrap(kind: Kind, arr: JArray, off: number, len: number) {
    if (kind === 'Long') { const o = heap('Long', arr.data.length); const x = b(o); (arr.data as bigint[]).forEach((val, i) => write(x, 'Long', i * 8, val)); x.pos = off; x.lim = off + len; return o }
    const u = arrayBytes(arr)
    return make(kind, { bytes: () => u, base: 0, cap: arr.data.length, pos: off, lim: off + len, le: kind !== 'Byte', direct: false, array: arr, arrayOffset: 0 })
  }

  // ---------- ByteOrder ----------
  const bo = (le: boolean) => { const o = new JObject(vm.cls(NIO + 'ByteOrder;')); o.f.le = le; return o }
  vm.shim(NIO + 'ByteOrder;', { super: OBJ, methods: {
    'nativeOrder()Ljava/nio/ByteOrder;': () => order(true),
    'toString()Ljava/lang/String;': (v, s) => (s.f.le ? 'LITTLE_ENDIAN' : 'BIG_ENDIAN'),
  }, statics: {} })
  const boc = vm.cls(NIO + 'ByteOrder;')
  boc.staticValues.LITTLE_ENDIAN = bo(true)
  boc.staticValues.BIG_ENDIAN = bo(false)
  for (const e of ['BufferUnderflowException', 'BufferOverflowException', 'InvalidMarkException', 'ReadOnlyBufferException']) if (!vm.shims.has(NIO + e + ';')) vm.shim(NIO + e + ';', { super: 'Ljava/lang/RuntimeException;', methods: {} })

  // for JNI: direct buffers seen from native code
  return {
    address: (o: any) => (o?.f?.nio?.direct && o.f.nio.addr !== undefined ? (o.f.nio as B).addr! : 0),
    capacity: (o: any) => (o?.f?.nio?.direct ? (o.f.nio as B).cap : -1),
    wrapNative: (addr: number, cap: number, bytes: () => Uint8Array) => make('Byte', { bytes, base: addr, cap, pos: 0, lim: cap, le: false, direct: true, addr }),
  }
}
