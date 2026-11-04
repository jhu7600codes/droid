// java.nio buffers through droid's shims: order, typed views, bulk get / put, slices, direct memory
import { VM } from '../../../src/runtime/android/dalvik.ts'
import { registerJava } from '../../../src/runtime/android/java.ts'
import { Vfs } from '../../../src/runtime/android/javaio.ts'
import { Native } from '../../../src/runtime/android/arm/native.ts'
const vm = new VM(); registerJava(vm)
const nat = new Native(vm, new Vfs(), 'test')
let fails = 0
const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m) } }
const S = (cls, key, args = []) => vm.callStatic('Ljava/nio/' + cls + ';', key, args)
const V = (o, key, args = []) => vm.callVirtual(o, key, args)
const bb = S('ByteBuffer', 'allocateDirect(I)Ljava/nio/ByteBuffer;', [64])
const LE = vm.cls('Ljava/nio/ByteOrder;').staticValues.LITTLE_ENDIAN
V(bb, 'order(Ljava/nio/ByteOrder;)Ljava/nio/ByteBuffer;', [LE])
V(bb, 'putInt(I)Ljava/nio/ByteBuffer;', [0x11223344]); V(bb, 'putFloat(F)Ljava/nio/ByteBuffer;', [1.5]); V(bb, 'putShort(S)Ljava/nio/ByteBuffer;', [-2])
ok(V(bb, 'position()I') === 10, 'position')
const addr = vm.nio.address(bb)
ok(addr > 0 && nat.mem.r32(addr) === 0x11223344, 'direct bytes are native memory')
ok(nat.mem.r32(addr + 4) === 0x3fc00000, 'float bits')
V(bb, 'flip()Ljava/nio/Buffer;')
ok(V(bb, 'getInt()I') === 0x11223344 && V(bb, 'getFloat()F') === 1.5 && V(bb, 'getShort()S') === -2, 'reads back')
const be = S('ByteBuffer', 'allocate(I)Ljava/nio/ByteBuffer;', [8])
V(be, 'putInt(I)Ljava/nio/ByteBuffer;', [1])
ok(V(be, 'get(I)B', [3]) === 1 && V(be, 'get(I)B', [0]) === 0, 'big endian by default')
const fb = V(S('ByteBuffer', 'allocateDirect(I)Ljava/nio/ByteBuffer;', [32]), 'asFloatBuffer()Ljava/nio/FloatBuffer;')
const arr = vm.newArray('[F', 3); arr.data.set([1, 2, 3])
V(fb, 'put([F)Ljava/nio/FloatBuffer;', [arr])
ok(V(fb, 'position()I') === 3 && V(fb, 'get(I)F', [2]) === 3, 'float view put / get')
const bytes = vm.newArray('[B', 4); bytes.data.set([9, 8, 7, 6])
const w = S('ByteBuffer', 'wrap([B)Ljava/nio/ByteBuffer;', [bytes])
ok(V(w, 'get()B') === 9, 'wrap'); V(w, 'put(IB)Ljava/nio/ByteBuffer;', [3, 1]); ok(bytes.data[3] === 1, 'wrap shares the array')
const sl = V(w, 'slice()Ljava/nio/ByteBuffer;'); ok(V(sl, 'capacity()I') === 3 && V(sl, 'get()B') === 8, 'slice')
const out = vm.newArray('[B', 2); V(sl, 'get([B)Ljava/nio/ByteBuffer;', [out]); ok(out.data[0] === 7 && out.data[1] === 1, 'bulk get')
let threw = false; try { V(sl, 'get()B') } catch { threw = true } ok(threw, 'underflow')
console.log(fails ? `${fails} FAILED` : 'ALL OK')
