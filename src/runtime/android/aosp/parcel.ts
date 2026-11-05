// android.os.Parcel's natives: a growable little-endian buffer with android's layout (4 byte
// alignment, utf-16 strings with a length, -1 for null). binders and file descriptors cannot be
// bytes in droid, so they go in a side table keyed by their position.
import type { VM, JObject, JArray } from '../dalvik.ts'

interface P { buf: Uint8Array; dv: DataView; size: number; pos: number; objs: Map<number, any> }

export function registerParcel(vm: VM) {
  const parcels = new Map<number, P>()
  let next = 1
  const P = (h: number) => { const p = parcels.get(h); if (!p) throw vm.error('Ljava/lang/IllegalStateException;', 'parcel already recycled'); return p }
  const grow = (p: P, need: number) => {
    if (need <= p.buf.length) return
    const b = new Uint8Array(Math.max(need, p.buf.length * 2, 64)); b.set(p.buf)
    p.buf = b; p.dv = new DataView(b.buffer)
  }
  const room = (p: P, n: number) => { const at = p.pos; grow(p, at + n); p.pos += n; if (p.pos > p.size) p.size = p.pos; return at }
  const take = (p: P, n: number) => { const at = p.pos; if (at + n > p.size) { p.pos = p.size; return -1 } p.pos += n; return at }
  const pad4 = (n: number) => (n + 3) & ~3
  const bytesOf = (a: JArray) => new Uint8Array((a.data as Int8Array).buffer, (a.data as Int8Array).byteOffset, a.data.length)
  const writeString = (p: P, s: string | null) => {
    if (s == null) { p.dv.setInt32(room(p, 4), -1, true); return }
    p.dv.setInt32(room(p, 4), s.length, true)
    const at = room(p, pad4((s.length + 1) * 2))
    for (let i = 0; i < s.length; i++) p.dv.setUint16(at + i * 2, s.charCodeAt(i), true)
    p.dv.setUint16(at + s.length * 2, 0, true)
  }
  const readString = (p: P): string | null => {
    const at = take(p, 4); if (at < 0) return null
    const n = p.dv.getInt32(at, true); if (n < 0) return null
    const b = take(p, pad4((n + 1) * 2)); if (b < 0) return null
    let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(p.dv.getUint16(b + i * 2, true))
    return s
  }
  vm.registerNatives('Landroid/os/Parcel;', {
    'nativeCreate()I': () => { const h = next++; const buf = new Uint8Array(64); parcels.set(h, { buf, dv: new DataView(buf.buffer), size: 0, pos: 0, objs: new Map() }); return h },
    'nativeFreeBuffer(I)V': (v, s, [h]) => { const p = P(h); p.size = 0; p.pos = 0; p.objs.clear() },
    'nativeDestroy(I)V': (v, s, [h]) => { parcels.delete(h) },
    'nativeDataSize(I)I': (v, s, [h]) => P(h).size,
    'nativeDataAvail(I)I': (v, s, [h]) => { const p = P(h); return Math.max(0, p.size - p.pos) },
    'nativeDataPosition(I)I': (v, s, [h]) => P(h).pos,
    'nativeDataCapacity(I)I': (v, s, [h]) => P(h).buf.length,
    'nativeSetDataSize(II)V': (v, s, [h, n]) => { const p = P(h); grow(p, n); p.size = n; if (p.pos > n) p.pos = n },
    'nativeSetDataPosition(II)V': (v, s, [h, n]) => { P(h).pos = n },
    'nativeSetDataCapacity(II)V': (v, s, [h, n]) => { const p = P(h); if (n >= p.size) grow(p, n) },
    'nativePushAllowFds(IZ)Z': () => 1, 'nativeRestoreAllowFds(IZ)V': () => {},
    'nativeWriteByteArray(I[BII)V': (v, s, [h, a, o, n]) => {
      const p = P(h)
      if (a == null) { p.dv.setInt32(room(p, 4), -1, true); return }
      p.dv.setInt32(room(p, 4), n, true)
      const at = room(p, pad4(n)); p.buf.set(bytesOf(a).subarray(o, o + n), at)
    },
    'nativeCreateByteArray(I)[B': (v, s, [h]) => {
      const p = P(h); const at = take(p, 4); if (at < 0) return null
      const n = p.dv.getInt32(at, true); if (n < 0) return null
      const b = take(p, pad4(n)); if (b < 0) return null
      const r = vm.newArray('[B', n); (r.data as Int8Array).set(new Int8Array(p.buf.buffer, b, n)); return r
    },
    'nativeWriteInt(II)V': (v, s, [h, x]) => { const p = P(h); p.dv.setInt32(room(p, 4), x, true) },
    'nativeWriteLong(IJ)V': (v, s, [h, x]) => { const p = P(h); p.dv.setBigInt64(room(p, 8), BigInt.asIntN(64, x), true) },
    'nativeWriteFloat(IF)V': (v, s, [h, x]) => { const p = P(h); p.dv.setFloat32(room(p, 4), x, true) },
    'nativeWriteDouble(ID)V': (v, s, [h, x]) => { const p = P(h); p.dv.setFloat64(room(p, 8), x, true) },
    'nativeWriteString(ILjava/lang/String;)V': (v, s, [h, x]) => writeString(P(h), x),
    'nativeReadInt(I)I': (v, s, [h]) => { const p = P(h); const at = take(p, 4); return at < 0 ? 0 : p.dv.getInt32(at, true) },
    'nativeReadLong(I)J': (v, s, [h]) => { const p = P(h); const at = take(p, 8); return at < 0 ? 0n : p.dv.getBigInt64(at, true) },
    'nativeReadFloat(I)F': (v, s, [h]) => { const p = P(h); const at = take(p, 4); return at < 0 ? 0 : p.dv.getFloat32(at, true) },
    'nativeReadDouble(I)D': (v, s, [h]) => { const p = P(h); const at = take(p, 8); return at < 0 ? 0 : p.dv.getFloat64(at, true) },
    'nativeReadString(I)Ljava/lang/String;': (v, s, [h]) => readString(P(h)),
    // binders and fds: a marker in the bytes, the object beside them
    'nativeWriteStrongBinder(ILandroid/os/IBinder;)V': (v, s, [h, b]) => { const p = P(h); const at = room(p, 8); p.dv.setInt32(at, b ? 0x73682a85 : 0, true); p.objs.set(at, b) },
    'nativeReadStrongBinder(I)Landroid/os/IBinder;': (v, s, [h]) => { const p = P(h); const at = take(p, 8); return at < 0 ? null : p.objs.get(at) ?? null },
    'nativeWriteFileDescriptor(ILjava/io/FileDescriptor;)V': (v, s, [h, fd]) => { const p = P(h); const at = room(p, 8); p.dv.setInt32(at, 0x66642a85, true); p.objs.set(at, fd) },
    'nativeReadFileDescriptor(I)Ljava/io/FileDescriptor;': (v, s, [h]) => { const p = P(h); const at = take(p, 8); return at < 0 ? null : p.objs.get(at) ?? null },
    'nativeHasFileDescriptors(I)Z': (v, s, [h]) => ([...P(h).objs.values()].some((o) => o && (o as JObject).cls?.name === 'Ljava/io/FileDescriptor;') ? 1 : 0),
    'nativeMarshall(I)[B': (v, s, [h]) => { const p = P(h); const r = vm.newArray('[B', p.size); (r.data as Int8Array).set(new Int8Array(p.buf.buffer, 0, p.size)); return r },
    'nativeUnmarshall(I[BII)V': (v, s, [h, a, o, n]) => { const p = P(h); grow(p, n); p.buf.set(bytesOf(a).subarray(o, o + n), 0); p.size = n; p.pos = 0; p.objs.clear() },
    'nativeAppendFrom(IIII)V': (v, s, [h, from, o, n]) => {
      const p = P(h), q = P(from); const at = room(p, n); p.buf.set(q.buf.subarray(o, o + n), at)
      for (const [k, x] of q.objs) if (k >= o && k < o + n) p.objs.set(at + k - o, x)
    },
    'nativeWriteInterfaceToken(ILjava/lang/String;)V': (v, s, [h, name]) => { const p = P(h); p.dv.setInt32(room(p, 4), 0, true); writeString(p, name) },
    'nativeEnforceInterface(ILjava/lang/String;)V': (v, s, [h]) => { const p = P(h); take(p, 4); readString(p) },
  })
}
