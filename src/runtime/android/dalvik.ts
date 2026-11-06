// the dex runtime: a dalvik bytecode interpreter (spec section 10). interpreter first; the runtime is
// behind load / invoke so a wasm-generating dynarec can replace it later.
//
// values: int / float / double = js number, long = bigint, boolean = 0 or 1, char = number,
// java.lang.String = js string, null = null, objects = JObject, arrays = JArray.
// wide values take two registers: the value sits in the first, the second is unused.
import type { Dex, DexClass, Code, MethodRef } from './dex.ts'
import { ACC } from './dex.ts'
import { scheduler, isBlock, tryEnter, enterBlock, exit, taskId, type Block, type Task } from './threads.ts'

export interface Frame {
  m: JMethod; r: any[]; pc: number; ipc: number; ins: Uint16Array; dex: Dex; code: Code; kinds: Map<number, string>
  result: any; exc: any
  post?: (v: any) => any // a JavaCall's frame: turns its return value into the calling native's
  onThrow?: (e: JavaThrow) => JavaThrow // ... and its exceptions
}
// thrown by framework (js) code that wants to call a java method and return what it gives: the
// interpreter runs it as an ordinary frame on the same thread (so it can wait on locks, network...)
// instead of a nested js call. post turns the result into the native's return value.
export class JavaCall {
  m: JMethod; self: any; args: any[]; post?: (v: any) => any; onThrow?: (e: JavaThrow) => JavaThrow
  constructor(m: JMethod, self: any, args: any[], post?: (v: any) => any, onThrow?: (e: JavaThrow) => JavaThrow) { this.m = m; this.self = self; this.args = args; this.post = post; this.onThrow = onThrow }
}
const YIELD = Symbol('yield'), BLOCKED = Symbol('blocked'), NO_CALL = Symbol('no call')
// a java thread: its own frame stack, scheduled as a green thread
export class JThread implements Task {
  id = taskId()
  state: Task['state'] = 'runnable'
  block: Block | null = null
  blockValue = false // does the block's finish() give the value of the call that waited
  busy: boolean
  frames: Frame[] = []
  obj: JObject | null = null // its java.lang.Thread
  interrupted = false
  nativeCall = false // stopped inside a native method (resumes there)
  pendingThrow: JavaThrow | null = null // an exception from a resumed native call, raised at the call
  lastValue: any = undefined // what the last finished top-level call returned
  onDone?: (err: unknown) => void
  vm: VM
  name: string
  constructor(vm: VM, name: string, main = false) { this.vm = vm; this.name = name; this.busy = main }
  step(ms: number) { this.vm.stepThread(this, ms) }
  urgent() { return !!this.vm.nativeAsync?.signalsPending(this) }
}

export type NativeFn = (vm: VM, self: any, args: any[]) => any

export interface JMethod {
  cls: JClass; name: string; key: string; desc: string; ret: string; params: string[]; flags: number
  code: Code | null; native?: NativeFn; dex?: Dex
}
export interface JClass {
  name: string; super: JClass | null; interfaces: JClass[]; methods: Map<string, JMethod>
  staticValues: Record<string, any>; fieldTypes: Record<string, string>; initialized: boolean; flags: number
  dexClass?: DexClass; dex?: Dex; classObject?: JObject
}
export class JObject {
  cls: JClass
  f: Record<string, any> = {}
  constructor(cls: JClass) { this.cls = cls }
}
export class JArray {
  cls: JClass
  data: any[] | Int32Array | Float64Array | Float32Array | Int8Array | Int16Array | Uint16Array
  constructor(cls: JClass, data: JArray['data']) { this.cls = cls; this.data = data }
}
// a java exception travelling through js
export class JavaThrow extends Error {
  obj: JObject
  constructor(obj: JObject) { super(String(obj.f.message ?? obj.cls.name)); this.obj = obj }
}

// framework classes written in js (src/runtime/android/framework.ts registers them)
export interface ShimClass { super?: string; interfaces?: string[]; methods?: Record<string, NativeFn>; statics?: Record<string, any>; flags?: number }

// dalvik registers are untyped: a null reference is often a plain 0 from const/4
const obj = (v: any) => (v === 0 ? null : v)
const defaultFor = (t: string) => (t === 'J' ? 0n : 'ZBSCIFD'.includes(t) ? 0 : null)
const toInt = (x: number) => (isNaN(x) ? 0 : x >= 2147483647 ? 2147483647 : x <= -2147483648 ? -2147483648 : Math.trunc(x) | 0)
const toLong = (x: number) => (isNaN(x) ? 0n : x >= 9.223372036854776e18 ? 9223372036854775807n : x <= -9.223372036854776e18 ? -9223372036854775808n : BigInt(Math.trunc(x)))
const L = (v: bigint) => BigInt.asIntN(64, v)

export class VM {
  classes = new Map<string, JClass>()
  dexes: Dex[] = []
  shims = new Map<string, ShimClass>()
  missing = new Set<string>() // framework pieces the app used but droid lacks (shown in the report)
  natives: (m: JMethod, self: any, args: any[]) => any = (m) => { throw this.error('Ljava/lang/UnsatisfiedLinkError;', `no native ${m.cls.name}->${m.key}`) }
  log = (s: string) => console.log(s)
  steps = 0

  // class name -> where it is defined (the first dex that has it wins)
  private dexIndex = new Map<string, { c: DexClass; d: Dex }>()
  addDex(d: Dex) { this.dexes.push(d); for (const c of d.classes) if (!this.dexIndex.has(c.name)) this.dexIndex.set(c.name, { c, d }) }
  shim(name: string, c: ShimClass) {
    this.shims.set(name, c)
    this.missing.delete(name)
    // a class already built from an older shim gets the new methods and statics too
    const built = this.classes.get(name)
    if (built && !built.dexClass) {
      for (const [key, fn] of Object.entries(c.methods || {})) {
        const n = key.slice(0, key.indexOf('(')), desc = key.slice(key.indexOf('('))
        built.methods.set(key, { cls: built, name: n, key, desc, ret: desc.slice(desc.indexOf(')') + 1), params: splitParams(desc), flags: ACC.PUBLIC, code: null, native: fn })
      }
      Object.assign(built.staticValues, c.statics || {})
      if (c.super && built.super?.name !== c.super) built.super = this.cls(c.super)
      if (c.interfaces) built.interfaces = c.interfaces.map((i) => this.cls(i))
    }
  }

  // ---------- classes ----------
  findDexClass(name: string) { return this.dexIndex.get(name) ?? null }
  // js implementations of `native` methods in dex classes (the android framework's natives)
  dexNatives = new Map<string, NativeFn>()
  // keys are full method keys ('name(desc)ret') or just the name: then every overload of that name
  // gets the function (it tells them apart by its arguments)
  registerNatives(cls: string, fns: Record<string, NativeFn>) {
    for (const [k, f] of Object.entries(fns)) {
      this.dexNatives.set(cls + '->' + k, f)
      const built = this.classes.get(cls)
      if (!built) continue
      for (const m of built.methods.values()) if (m.key === k || (!k.includes('(') && m.name === k && m.flags & ACC.NATIVE)) m.native = f
    }
  }
  private dexNative(cls: string, key: string) { return this.dexNatives.get(cls + '->' + key) ?? this.dexNatives.get(cls + '->' + key.slice(0, key.indexOf('('))) }
  cls(name: string): JClass {
    let c = this.classes.get(name)
    if (c) return c
    if (name.startsWith('[')) {
      c = this.newClass(name, this.cls('Ljava/lang/Object;'), 0)
      return c
    }
    const fromDex = this.findDexClass(name)
    if (fromDex) {
      const dc = fromDex.c
      c = this.newClass(name, dc.super ? this.cls(dc.super) : null, dc.flags)
      c.dexClass = dc
      c.dex = fromDex.d
      c.interfaces = dc.interfaces.map((i) => this.cls(i))
      for (const m of [...dc.directMethods, ...dc.virtualMethods]) {
        c.methods.set(m.ref.key, { cls: c, name: m.ref.name, key: m.ref.key, desc: m.ref.proto.desc, ret: m.ref.proto.ret, params: m.ref.proto.params, flags: m.flags, code: m.code, dex: fromDex.d, native: m.flags & ACC.NATIVE ? this.dexNative(name, m.ref.key) : undefined })
      }
      dc.staticFields.forEach((f, i) => { c!.fieldTypes[f.ref.name] = f.ref.type; c!.staticValues[f.ref.name] = i < dc.staticValues.length ? this.fromEncoded(dc.staticValues[i], f.ref.type) : defaultFor(f.ref.type[0]) })
      for (const f of dc.instanceFields) c.fieldTypes[f.ref.name] = f.ref.type
      return c
    }
    const s = this.shims.get(name)
    if (s) {
      c = this.newClass(name, s.super ? this.cls(s.super) : name === 'Ljava/lang/Object;' ? null : this.cls('Ljava/lang/Object;'), s.flags || 0)
      c.interfaces = (s.interfaces || []).map((i) => this.cls(i))
      for (const [key, fn] of Object.entries(s.methods || {})) {
        const name2 = key.slice(0, key.indexOf('('))
        const desc = key.slice(key.indexOf('('))
        c.methods.set(key, { cls: c, name: name2, key, desc, ret: desc.slice(desc.indexOf(')') + 1), params: splitParams(desc), flags: ACC.PUBLIC, code: null, native: fn })
      }
      Object.assign(c.staticValues, s.statics || {})
      c.initialized = true
      return c
    }
    // an unknown framework class: an empty stub, so code can at least load. calls into it are reported.
    this.missing.add(name)
    c = this.newClass(name, name === 'Ljava/lang/Object;' ? null : this.cls('Ljava/lang/Object;'), 0)
    c.initialized = true
    return c
  }
  private newClass(name: string, sup: JClass | null, flags: number): JClass {
    const c: JClass = { name, super: sup, interfaces: [], methods: new Map(), staticValues: {}, fieldTypes: {}, initialized: false, flags }
    this.classes.set(name, c)
    return c
  }
  private fromEncoded(v: unknown, type: string) {
    if (type === 'J') return typeof v === 'bigint' ? v : BigInt((v as number) || 0)
    if (v && typeof v === 'object' && 'type' in (v as any)) return this.classObject(this.cls((v as any).type))
    return v
  }
  init(c: JClass) {
    if (c.initialized) return
    c.initialized = true
    if (c.super) this.init(c.super)
    const clinit = c.methods.get('<clinit>()V')
    if (clinit) this.invoke(clinit, null, [])
  }
  isSubclass(c: JClass | null, of: JClass): boolean {
    for (let x = c; x; x = x.super) {
      if (x === of) return true
      for (const i of x.interfaces) if (this.isSubclass(i, of)) return true
    }
    return false
  }
  classOf(v: any): JClass {
    if (typeof v === 'string') return this.cls('Ljava/lang/String;')
    if (v instanceof JObject || v instanceof JArray) return v.cls
    return this.cls('Ljava/lang/Object;')
  }
  instanceOf(v: any, c: JClass) {
    if (v == null) return false
    if (c.name === 'Ljava/lang/Object;') return true
    if (c.name.startsWith('[')) return v instanceof JArray && (v.cls === c || c.name === '[Ljava/lang/Object;' && v.cls.name.startsWith('[L'))
    if (typeof v === 'string') return ['Ljava/lang/String;', 'Ljava/lang/CharSequence;', 'Ljava/lang/Comparable;', 'Ljava/io/Serializable;'].includes(c.name)
    return this.isSubclass(this.classOf(v), c)
  }
  // is there such a class (app dex or framework shim), without making a stub for it
  hasClass(name: string) { return !!(this.classes.get(name) && !this.missing.has(name)) || !!this.findDexClass(name) || this.shims.has(name) || name.startsWith('[') }
  classObject(c: JClass) {
    if (!c.classObject) { c.classObject = new JObject(this.cls('Ljava/lang/Class;')); c.classObject.f.of = c }
    return c.classObject
  }

  // ---------- methods ----------
  findMethod(c: JClass | null, key: string): JMethod | null {
    for (let x = c; x; x = x.super) {
      const m = x.methods.get(key)
      if (m && !(m.flags & ACC.ABSTRACT)) return m
    }
    // covariant returns: javac / kotlinc bridge methods may be missing for shim classes,
    // so match on name and parameters when the exact key is not there
    const sig = key.slice(0, key.indexOf(')') + 1)
    for (let x = c; x; x = x.super) {
      if (!x.dexClass) for (const [k, m] of x.methods) if (k.startsWith(sig) && !(m.flags & ACC.ABSTRACT) && m.native) return m
    }
    // default methods and interface shims
    const seen = new Set<JClass>()
    const walk = (x: JClass | null): JMethod | null => {
      for (; x; x = x.super) for (const i of x.interfaces) {
        if (seen.has(i)) continue
        seen.add(i)
        const m = i.methods.get(key)
        if (m && (m.code || m.native)) return m
        const deep = walk(i)
        if (deep) return deep
      }
      return null
    }
    return walk(c)
  }
  // call a virtual method on an object from js (framework -> app callbacks)
  callVirtual(self: any, key: string, args: any[] = []) {
    const m = this.findMethod(this.classOf(self), key)
    if (!m) return undefined
    return this.invoke(m, self, args)
  }
  callStatic(cls: string, key: string, args: any[] = []) {
    const c = this.cls(cls)
    this.init(c)
    const m = this.findMethod(c, key)
    if (!m) throw this.error('Ljava/lang/NoSuchMethodError;', cls + '->' + key)
    return this.invoke(m, null, args)
  }
  newObject(cls: string, ctorKey = '<init>()V', args: any[] = []) {
    const c = this.cls(cls)
    this.init(c)
    const o = new JObject(c)
    const m = this.findMethod(c, ctorKey)
    if (m) this.invoke(m, o, args)
    return o
  }
  error(cls: string, message: string) {
    const o = new JObject(this.cls(cls))
    o.f.message = message
    o.f.jstack = this.javaStack()
    return new JavaThrow(o)
  }
  newArray(type: string, n: number): JArray {
    if (n < 0) throw this.error('Ljava/lang/NegativeArraySizeException;', String(n))
    const el = type.slice(1)
    const data = el === 'I' ? new Int32Array(n) : el === 'B' || el === 'Z' ? new Int8Array(n) : el === 'S' ? new Int16Array(n) : el === 'C' ? new Uint16Array(n)
      : el === 'F' ? new Float32Array(n) : el === 'D' ? new Float64Array(n) : el === 'J' ? new Array(n).fill(0n) : new Array(n).fill(null)
    return new JArray(this.cls(type), data)
  }

  // ---------- threads ----------
  // the main thread runs everything that comes from js (ui callbacks, lifecycle); other java threads
  // and attached native threads are green threads run by the scheduler (threads.ts)
  // set by the native runtime: native calls on green threads that can stop and resume
  nativeAsync: { begin(t: JThread, m: JMethod, self: any, args: any[], deadline: number): { done: true; value: any } | { done: false; block: Block | null }; resumeCall(t: JThread, deadline: number): { done: true; value: any } | { done: false; block: Block | null }; signalsPending(t: JThread): boolean; takeSignals(t: JThread): void } | null = null
  main = new JThread(this, 'main', true)
  current: JThread = this.main
  startThread(name: string, m: JMethod, self: any, args: any[] = [], obj: JObject | null = null) {
    const t = new JThread(this, name)
    t.obj = obj
    this.pushFrame(t, m, self, args)
    scheduler.add(t)
    return t
  }
  // the scheduler gives thread t up to `ms` milliseconds
  stepThread(t: JThread, ms: number) {
    const prev = this.current
    this.current = t
    t.busy = true
    try {
      const deadline = performance.now() + ms
      // native signal handlers (a garbage collector stopping the world) run even while the thread waits
      if (this.nativeAsync?.signalsPending(t)) {
        this.nativeAsync.takeSignals(t)
        if (t.state === 'blocked' && t.block && !t.block.ready()) return
        if (t.state === 'blocked') t.state = 'runnable'
      }
      if (t.nativeCall) {
        // a native call that stopped last time: go on with it (its own block, if any, is handled there)
        t.block = null
        let n: ReturnType<NonNullable<VM['nativeAsync']>['resumeCall']> | null = null
        try { n = this.nativeAsync!.resumeCall(t, deadline) }
        catch (e) { if (!(e instanceof JavaThrow)) throw e; t.pendingThrow = e } // thrown at the call, below
        if (n && !n.done) { if (n.block) { t.block = n.block; t.state = 'blocked' } return }
        t.nativeCall = false
        if (n) t.frames[t.frames.length - 1].result = n.value
      } else if (t.block) {
        // the wait is over: its value is the call's result; an exception it ends with is thrown at the call
        const b = t.block; t.block = null
        try { const v = b.finish(); if (t.blockValue) t.frames[t.frames.length - 1].result = v }
        catch (e) { if (!(e instanceof JavaThrow) || !t.frames.length) throw e; t.pendingThrow = e }
      }
      const r = this.exec(t, 0, deadline)
      if (r === YIELD) return
      if (r === BLOCKED) { t.state = 'blocked'; return }
      t.lastValue = r
      t.state = 'done'
      t.onDone?.(null)
    } catch (e) {
      t.state = 'done'
      t.frames.length = 0
      if (t.onDone) t.onDone(e)
      else console.warn(`java thread "${t.name}" ended with`, e instanceof JavaThrow ? (e.obj.f.message ?? e.obj.cls.name) : e)
    } finally { t.busy = false; this.current = prev }
  }

  // calls a method from js and returns its value (framework -> app callbacks, reflection, jni).
  // java methods run on the current thread, nested; if they have to wait, other threads run meanwhile
  invoke(m: JMethod, self: any, args: any[]): any {
    if (m.native || m.flags & ACC.NATIVE) {
      try { return m.native ? m.native(this, self, args) : this.natives(m, self, args) }
      catch (e) {
        if (isBlock(e)) return scheduler.pump(this.current, e)
        if (e instanceof JavaCall) {
          let v: any
          try { v = this.invoke(e.m, e.self, e.args) } catch (er) { if (er instanceof JavaThrow && e.onThrow) throw e.onThrow(er); throw er }
          return e.post ? e.post(v) : v
        }
        throw e
      }
    }
    if (!m.code) {
      this.missing.add(`${m.cls.name}->${m.key}`)
      throw this.error('Ljava/lang/AbstractMethodError;', `${m.cls.name}->${m.key}`)
    }
    const t = this.current
    const stop = t.frames.length
    this.pushFrame(t, m, self, args)
    const busy = t.busy
    t.busy = true
    try { return this.exec(t, stop, Infinity) }
    catch (e) { t.frames.length = stop; throw e }
    finally { t.busy = busy }
  }

  // queue a java call on a thread (driver threads run one call after another)
  pushCall(t: JThread, m: JMethod, self: any, args: any[]) { this.pushFrame(t, m, self, args) }
  // debugging: called for every java method entered (tools/aosp/boot.mjs JTRACE=...)
  onEnter: ((m: JMethod) => void) | null = null
  private pushFrame(t: JThread, m: JMethod, self: any, args: any[]) {
    if (this.onEnter) this.onEnter(m)
    if (t.frames.length > 3000) throw this.error('Ljava/lang/StackOverflowError;', 'stack size ' + t.frames.length)
    const code = m.code!
    const r: any[] = new Array(code.registers).fill(0)
    // arguments go in the last `ins` registers; wide arguments take two
    let a = code.registers - code.ins
    if (!(m.flags & ACC.STATIC)) r[a++] = self
    for (let i = 0; i < m.params.length; i++) {
      r[a] = args[i]
      a += m.params[i] === 'J' || m.params[i] === 'D' ? 2 : 1
    }
    t.frames.push({ m, r, pc: 0, ipc: 0, ins: code.insns, dex: m.dex!, code, kinds: constKinds(m, m.dex!), result: undefined, exc: null })
  }

  // ---------- the interpreter ----------
  // runs thread t until its frame count drops back to `stop` (returns the last frame's value),
  // or the deadline passes (YIELD), or it has to wait (BLOCKED). nested calls pass deadline Infinity:
  // they never yield and wait in place.
  private exec(t: JThread, stop: number, deadline: number): any {
    const s16 = (x: number) => (x << 16) >> 16
    const s8 = (x: number) => (x << 24) >> 24
    const npe = () => this.error('Ljava/lang/NullPointerException;', 'null')
    outer: for (;;) {
      const f = t.frames[t.frames.length - 1]
      const { r, ins, dex, kinds } = f
      const u32at = (p: number) => (ins[p] | (ins[p + 1] << 16)) >>> 0
      const s32at = (p: number) => ins[p] | (ins[p + 1] << 16)
      let pc = f.pc
      try {
        if (t.pendingThrow) { const e = t.pendingThrow; t.pendingThrow = null; pc = f.ipc; throw e }
        for (;;) {
          if ((++this.steps & 2047) === 0 && deadline !== Infinity && performance.now() > deadline) { f.pc = pc; return YIELD }
          const w = ins[pc]
          const op = w & 0xff
          const AA = w >> 8, A = (w >> 8) & 0xf, B = w >> 12
          switch (op) {
            case 0x00: pc += 1; break
            case 0x01: case 0x04: case 0x07: r[A] = r[B]; pc += 1; break
            case 0x02: case 0x05: case 0x08: r[AA] = r[ins[pc + 1]]; pc += 2; break
            case 0x03: case 0x06: case 0x09: r[ins[pc + 1]] = r[ins[pc + 2]]; pc += 3; break
            case 0x0a: case 0x0b: case 0x0c: r[AA] = f.result; pc += 1; break
            case 0x0d: r[AA] = f.exc; pc += 1; break
            case 0x0e: case 0x0f: case 0x10: case 0x11: {
              let value = op === 0x0e ? undefined : op === 0x11 ? obj(r[AA]) : r[AA]
              t.frames.pop()
              if (f.post) { try { value = f.post(value) } catch (er) { if (t.frames.length === stop) throw er; t.pendingThrow = er as any; continue outer } }
              if (t.frames.length === stop) return value
              t.frames[t.frames.length - 1].result = value
              continue outer
            }
            case 0x12: r[A] = conv(kinds, pc, (B << 28) >> 28); pc += 1; break
            case 0x13: r[AA] = conv(kinds, pc, s16(ins[pc + 1])); pc += 2; break
            case 0x14: r[AA] = conv(kinds, pc, s32at(pc + 1)); pc += 3; break
            case 0x15: r[AA] = conv(kinds, pc, (ins[pc + 1] << 16) | 0); pc += 2; break
            case 0x16: r[AA] = conv(kinds, pc, BigInt(s16(ins[pc + 1]))); pc += 2; break
            case 0x17: r[AA] = conv(kinds, pc, BigInt(s32at(pc + 1))); pc += 3; break
            case 0x18: r[AA] = conv(kinds, pc, L(BigInt(u32at(pc + 1)) | (BigInt(u32at(pc + 3)) << 32n))); pc += 5; break
            case 0x19: r[AA] = conv(kinds, pc, L(BigInt(ins[pc + 1]) << 48n)); pc += 2; break
            case 0x1a: r[AA] = dex.strings[ins[pc + 1]]; pc += 2; break
            case 0x1b: r[AA] = dex.strings[u32at(pc + 1)]; pc += 3; break
            case 0x1c: r[AA] = this.classObject(this.cls(dex.types[ins[pc + 1]])); pc += 2; break
            case 0x1d: { // monitor-enter
              const o = obj(r[AA])
              if (o == null) throw npe()
              pc += 1
              if (!tryEnter(o, t)) {
                const b = enterBlock(o, t)
                if (deadline === Infinity) { scheduler.pump(t, b); break }
                f.pc = pc; t.block = b; t.blockValue = false; t.state = 'blocked'
                return BLOCKED
              }
              break
            }
            case 0x1e: { const o = obj(r[AA]); if (o == null) throw npe(); exit(o, t); pc += 1; break }
            case 0x1f: {
              const v = obj(r[AA]), c = this.cls(dex.types[ins[pc + 1]])
              if (v != null && !this.instanceOf(v, c)) throw this.error('Ljava/lang/ClassCastException;', `${this.classOf(v).name} cannot be cast to ${c.name}`)
              pc += 2; break
            }
            case 0x20: r[A] = this.instanceOf(obj(r[B]), this.cls(dex.types[ins[pc + 1]])) ? 1 : 0; pc += 2; break
            case 0x21: { const arr = obj(r[B]); if (arr == null) throw npe(); r[A] = arr.data.length; pc += 1; break }
            case 0x22: { const c = this.cls(dex.types[ins[pc + 1]]); this.init(c); r[AA] = new JObject(c); pc += 2; break }
            case 0x23: r[A] = this.newArray(dex.types[ins[pc + 1]], r[B]); pc += 2; break
            case 0x24: case 0x25: {
              const t = dex.types[ins[pc + 1]]
              const regs = op === 0x24 ? this.regs35c(ins, pc) : this.regs3rc(ins, pc)
              const arr = this.newArray(t, regs.length)
              regs.forEach((x, i) => ((arr.data as any)[i] = r[x]))
              f.result = arr
              pc += 3; break
            }
            case 0x26: {
              const p = pc + s32at(pc + 1)
              const width = ins[p + 1], n = u32at(p + 2)
              const arr = r[AA] as JArray
              const bytes = new Uint8Array(ins.buffer, ins.byteOffset + (p + 4) * 2, width * n)
              const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
              for (let i = 0; i < n; i++) {
                const v = width === 1 ? dv.getInt8(i) : width === 2 ? dv.getInt16(i * 2, true) : width === 4 ? dv.getInt32(i * 4, true) : dv.getBigInt64(i * 8, true)
                ;(arr.data as any)[i] = arr.cls.name === '[F' && width === 4 ? dv.getFloat32(i * 4, true) : arr.cls.name === '[D' ? dv.getFloat64(i * 8, true) : arr.cls.name === '[C' ? dv.getUint16(i * 2, true) : v
              }
              pc += 3; break
            }
            case 0x27: { const e = obj(r[AA]); if (e == null) throw npe(); throw new JavaThrow(e) }
            case 0x28: pc += s8(AA); break
            case 0x29: pc += s16(ins[pc + 1]); break
            case 0x2a: pc += s32at(pc + 1); break
            case 0x2b: {
              const p = pc + s32at(pc + 1)
              const size = ins[p + 1], first = s32at(p + 2), v = r[AA]
              const idx = v - first
              pc = idx >= 0 && idx < size ? pc + s32at(p + 4 + idx * 2) : pc + 3
              break
            }
            case 0x2c: {
              const p = pc + s32at(pc + 1)
              const size = ins[p + 1], v = r[AA]
              let to = pc + 3
              for (let i = 0; i < size; i++) if (s32at(p + 2 + i * 2) === v) { to = pc + s32at(p + 2 + size * 2 + i * 2); break }
              pc = to; break
            }
            case 0x2d: case 0x2e: case 0x2f: case 0x30: {
              const x = r[ins[pc + 1] & 0xff], y = r[ins[pc + 1] >> 8]
              r[AA] = isNaN(x) || isNaN(y) ? (op === 0x2d || op === 0x2f ? -1 : 1) : x < y ? -1 : x > y ? 1 : 0
              pc += 2; break
            }
            case 0x31: { const x = r[ins[pc + 1] & 0xff], y = r[ins[pc + 1] >> 8]; r[AA] = x < y ? -1 : x > y ? 1 : 0; pc += 2; break }
            case 0x32: case 0x33: case 0x34: case 0x35: case 0x36: case 0x37: {
              const x = r[A], y = r[B]
              const t = op === 0x32 ? x === y : op === 0x33 ? x !== y : op === 0x34 ? x < y : op === 0x35 ? x >= y : op === 0x36 ? x > y : x <= y
              pc += t ? s16(ins[pc + 1]) : 2; break
            }
            case 0x38: case 0x39: case 0x3a: case 0x3b: case 0x3c: case 0x3d: {
              const x = r[AA]
              const z = x == null || x === 0 || x === 0n || x === false
              const t = op === 0x38 ? z : op === 0x39 ? !z : op === 0x3a ? x < 0 : op === 0x3b ? x >= 0 || z : op === 0x3c ? x > 0 : x <= 0 || z
              pc += t ? s16(ins[pc + 1]) : 2; break
            }
            case 0x44: case 0x45: case 0x46: case 0x47: case 0x48: case 0x49: case 0x4a: {
              const arr = obj(r[ins[pc + 1] & 0xff]) as JArray, i = r[ins[pc + 1] >> 8]
              if (arr == null) throw npe()
              if (i < 0 || i >= arr.data.length) throw this.error('Ljava/lang/ArrayIndexOutOfBoundsException;', `length=${arr.data.length}; index=${i}`)
              r[AA] = arr.data[i]
              pc += 2; break
            }
            case 0x4b: case 0x4c: case 0x4d: case 0x4e: case 0x4f: case 0x50: case 0x51: {
              const arr = obj(r[ins[pc + 1] & 0xff]) as JArray, i = r[ins[pc + 1] >> 8]
              if (arr == null) throw npe()
              if (i < 0 || i >= arr.data.length) throw this.error('Ljava/lang/ArrayIndexOutOfBoundsException;', `length=${arr.data.length}; index=${i}`)
              ;(arr.data as any)[i] = op === 0x4d ? obj(r[AA]) : r[AA]
              pc += 2; break
            }
            case 0x52: case 0x53: case 0x54: case 0x55: case 0x56: case 0x57: case 0x58: {
              const o = obj(r[B])
              if (o == null) throw npe()
              const f = dex.fields[ins[pc + 1]]
              const v = o.f[f.name]
              r[A] = v === undefined ? defaultFor(f.type[0]) : v
              pc += 2; break
            }
            case 0x59: case 0x5a: case 0x5b: case 0x5c: case 0x5d: case 0x5e: case 0x5f: {
              const o = obj(r[B])
              if (o == null) throw npe()
              o.f[dex.fields[ins[pc + 1]].name] = op === 0x5b ? obj(r[A]) : r[A]
              pc += 2; break
            }
            case 0x60: case 0x61: case 0x62: case 0x63: case 0x64: case 0x65: case 0x66: {
              const f = dex.fields[ins[pc + 1]]
              const c = this.staticOwner(f.cls, f.name)
              this.init(c)
              const v = c.staticValues[f.name]
              r[AA] = v === undefined ? defaultFor(f.type[0]) : v
              pc += 2; break
            }
            case 0x67: case 0x68: case 0x69: case 0x6a: case 0x6b: case 0x6c: case 0x6d: {
              const f = dex.fields[ins[pc + 1]]
              const c = this.staticOwner(f.cls, f.name)
              this.init(c)
              c.staticValues[f.name] = op === 0x69 ? obj(r[AA]) : r[AA]
              pc += 2; break
            }
            case 0x6e: case 0x6f: case 0x70: case 0x71: case 0x72: case 0x74: case 0x75: case 0x76: case 0x77: case 0x78: {
              const range = op >= 0x74
              const kind = range ? op - 0x74 : op - 0x6e // 0 virtual 1 super 2 direct 3 static 4 interface
              const ref = dex.methods[ins[pc + 1]]
              const regs = range ? this.regs3rc(ins, pc) : this.regs35c(ins, pc)
              const c = this.resolveInvoke(kind, ref, regs.map((x) => r[x]))
              if (c === NO_CALL) { f.result = undefined; pc += 3; break }
              const { target, self, args } = c
              if (target.code && !target.native && !(target.flags & ACC.NATIVE)) {
                // a java method: a new frame on this thread, the loop goes on there
                f.ipc = pc; f.pc = pc + 3
                this.pushFrame(t, target, self, args)
                continue outer
              }
              // native code on a green thread: it can stop mid-call and go on in the next slice
              f.ipc = pc
              if (!target.native && deadline !== Infinity && this.nativeAsync) {
                const r = this.nativeAsync.begin(t, target, self, args, deadline)
                if (!r.done) { f.pc = pc + 3; t.nativeCall = true; if (r.block) { t.block = r.block; t.blockValue = false; t.state = 'blocked'; return BLOCKED } return YIELD }
                f.result = r.value
                pc += 3; break
              }
              // framework (js) or native code: runs to completion here, or asks to wait
              let v: any
              try { v = target.native ? target.native(this, self, args) : this.natives(target, self, args) }
              catch (e) {
                if (e instanceof JavaCall && e.m.code && !e.m.native) {
                  f.pc = pc + 3
                  this.pushFrame(t, e.m, e.self, e.args)
                  const nf = t.frames[t.frames.length - 1]
                  nf.post = e.post; nf.onThrow = e.onThrow
                  continue outer
                }
                if (e instanceof JavaCall) { let x: any; try { x = this.invoke(e.m, e.self, e.args) } catch (er) { if (er instanceof JavaThrow && e.onThrow) throw e.onThrow(er); throw er } v = e.post ? e.post(x) : x; f.result = v; pc += 3; break }
                if (!isBlock(e)) throw e
                if (deadline === Infinity) v = scheduler.pump(t, e)
                else { f.pc = pc + 3; t.block = e; t.blockValue = true; t.state = 'blocked'; return BLOCKED }
              }
              // java strings are js strings: a String constructor's value replaces the blank object
              if (typeof v === 'string' && target.name === '<init>' && self instanceof JObject && self.cls.name === 'Ljava/lang/String;') { for (let i = 0; i < r.length; i++) if (r[i] === self) r[i] = v }
              f.result = v
              pc += 3; break
            }
            case 0x7b: r[A] = (-r[B]) | 0; pc += 1; break
            case 0x7c: r[A] = ~r[B]; pc += 1; break
            case 0x7d: r[A] = L(-(r[B] as bigint)); pc += 1; break
            case 0x7e: r[A] = L(~(r[B] as bigint)); pc += 1; break
            case 0x7f: r[A] = Math.fround(-r[B]); pc += 1; break
            case 0x80: r[A] = -r[B]; pc += 1; break
            case 0x81: r[A] = BigInt(r[B]); pc += 1; break
            case 0x82: r[A] = Math.fround(r[B]); pc += 1; break
            case 0x83: r[A] = r[B]; pc += 1; break
            case 0x84: r[A] = Number(BigInt.asIntN(32, r[B])); pc += 1; break
            case 0x85: r[A] = Math.fround(Number(r[B])); pc += 1; break
            case 0x86: r[A] = Number(r[B]); pc += 1; break
            case 0x87: case 0x8a: r[A] = toInt(r[B]); pc += 1; break
            case 0x88: case 0x8b: r[A] = toLong(r[B]); pc += 1; break
            case 0x89: r[A] = r[B]; pc += 1; break
            case 0x8c: r[A] = Math.fround(r[B]); pc += 1; break
            case 0x8d: r[A] = (r[B] << 24) >> 24; pc += 1; break
            case 0x8e: r[A] = r[B] & 0xffff; pc += 1; break
            case 0x8f: r[A] = (r[B] << 16) >> 16; pc += 1; break
            default: {
              if (op >= 0x90 && op <= 0xaf) { r[AA] = this.binop(op - 0x90, r[ins[pc + 1] & 0xff], r[ins[pc + 1] >> 8]); pc += 2; break }
              if (op >= 0xb0 && op <= 0xcf) { r[A] = this.binop(op - 0xb0, r[A], r[B]); pc += 1; break }
              if (op >= 0xd0 && op <= 0xd7) { const lit = s16(ins[pc + 1]); r[A] = op === 0xd1 ? (lit - r[B]) | 0 : this.binop([0, 0, 2, 3, 4, 5, 6, 7][op - 0xd0], r[B], lit); pc += 2; break }
              if (op >= 0xd8 && op <= 0xe2) {
                const bb = ins[pc + 1] & 0xff, lit = s8(ins[pc + 1] >> 8)
                r[AA] = op === 0xd9 ? (lit - r[bb]) | 0 : this.binop([0, 0, 2, 3, 4, 5, 6, 7, 8, 9, 10][op - 0xd8], r[bb], lit)
                pc += 2; break
              }
              throw this.error('Ljava/lang/VerifyError;', `opcode 0x${op.toString(16)} not supported in ${f.m.cls.name}->${f.m.key}`)
            }
          }
        }
      } catch (e) {
        if (isBlock(e)) throw new Error('droid: a wait outside of a call (' + e.what + ')')
        // a java exception: look for a handler in this frame, else in the callers
        let err = e instanceof JavaThrow ? e : this.wrapJsError(e)
        if (!err.obj.f.jstack) err.obj.f.jstack = this.javaStack(t)
        let at = pc
        for (;;) {
          const fr = t.frames[t.frames.length - 1]
          const tr = fr.code.tries.find((x) => at >= x.start && at < x.end)
          const h = tr?.handlers.find((x) => x.type === null || this.isSubclass(err.obj.cls, this.cls(x.type)))
          if (h) { fr.exc = err.obj; fr.pc = h.addr; continue outer }
          t.frames.pop()
          if (fr.onThrow) err = fr.onThrow(err)
          if (t.frames.length === stop) throw err
          at = t.frames[t.frames.length - 1].ipc
        }
      }
    }
  }
  // "pkg.Class.method" of the running frames, innermost first
  javaStack(t: JThread = this.current) { return t.frames.slice(-12).reverse().map((f) => `${f.m.cls.name.slice(1, -1).replace(/\//g, '.')}.${f.m.name}`) }

  private wrapJsError(e: unknown): JavaThrow {
    if (e instanceof JavaThrow) return e
    if (e instanceof RangeError && /call stack/i.test(e.message)) {
      // the host's stack ran out: say which calls repeat, so the loop can be found
      const names = (e.stack || '').split('\n').slice(1).map((l) => l.trim().replace(/^at /, '').split(' (')[0])
      const counts = new Map<string, number>()
      for (const n of names) counts.set(n, (counts.get(n) || 0) + 1)
      const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([n, c]) => `${n} x${c}`).join(', ')
      console.error('stack overflow in the runtime; repeating:', top, '| java:', this.javaStack().join(' < '))
      return this.error('Ljava/lang/StackOverflowError;', 'stack overflow')
    }
    console.error('runtime error', (e as Error)?.stack?.split('\n').slice(0, 4).join(' / '))
    return this.error('Ljava/lang/RuntimeException;', 'Droid runtime: ' + ((e as Error)?.message || String(e)))
  }

  private staticOwner(cls: string, field: string): JClass {
    // static fields may be declared on a superclass or interface
    for (let c: JClass | null = this.cls(cls); c; c = c.super) if (field in c.staticValues || field in c.fieldTypes) return c
    return this.cls(cls)
  }

  private regs35c(ins: Uint16Array, pc: number) {
    const w = ins[pc], n = w >> 12, g = (w >> 8) & 0xf, cdef = ins[pc + 2]
    return [cdef & 0xf, (cdef >> 4) & 0xf, (cdef >> 8) & 0xf, (cdef >> 12) & 0xf, g].slice(0, n)
  }
  private regs3rc(ins: Uint16Array, pc: number) {
    const n = ins[pc] >> 8, first = ins[pc + 2]
    return Array.from({ length: n }, (_, i) => first + i)
  }

  private resolveInvoke(kind: number, ref: MethodRef, raw: any[]): typeof NO_CALL | { target: JMethod; self: any; args: any[] } {
    // registers -> arguments: wide values take two registers, keep only the first
    const isStatic = kind === 3
    const args: any[] = []
    let i = isStatic ? 0 : 1
    for (const p of ref.proto.params) { args.push(p[0] === 'L' || p[0] === '[' ? obj(raw[i]) : raw[i]); i += p === 'J' || p === 'D' ? 2 : 1 }
    const self = isStatic ? null : obj(raw[0])
    let target: JMethod | null
    if (kind === 3) {
      const c = this.cls(ref.cls)
      this.init(c)
      target = this.findMethod(c, ref.key)
    } else {
      if (self == null) throw this.error('Ljava/lang/NullPointerException;', `Attempt to invoke ${ref.name} on a null object`)
      if (kind === 2) target = this.findMethod(this.cls(ref.cls), ref.key)
      else if (kind === 1) target = this.findMethod(this.cls(ref.cls), ref.key) // super: resolved against the named class
      else target = this.findMethod(this.classOf(self), ref.key) || this.findMethod(this.cls(ref.cls), ref.key)
    }
    if (!target) {
      // calls into framework parts droid does not have: object constructors are harmless, the rest is reported
      if (ref.name === '<init>') return NO_CALL
      this.missing.add(`${ref.cls}->${ref.key}`)
      throw this.error('Ljava/lang/NoSuchMethodError;', `${ref.cls}->${ref.key} on ${self == null ? 'static' : this.classOf(self).name} (not in Droid's framework shim yet)`)
    }
    return { target, self, args }
  }

  // index: add sub mul div rem and or xor shl shr ushr for int (0-10), long (11-21); float (22-26), double (27-31)
  private binop(i: number, x: any, y: any): any {
    if (i <= 10) {
      switch (i) {
        case 0: return (x + y) | 0
        case 1: return (x - y) | 0
        case 2: return Math.imul(x, y)
        case 3: if (y === 0) throw this.error('Ljava/lang/ArithmeticException;', 'divide by zero'); return x === -2147483648 && y === -1 ? x : (x / y) | 0
        case 4: if (y === 0) throw this.error('Ljava/lang/ArithmeticException;', 'divide by zero'); return y === -1 ? 0 : (x % y) | 0
        case 5: return x & y
        case 6: return x | y
        case 7: return x ^ y
        case 8: return x << (y & 31)
        case 9: return x >> (y & 31)
        case 10: return (x >>> (y & 31)) | 0
      }
    }
    if (i <= 21) {
      const j = i - 11
      if (j >= 8) { const s = BigInt(Number(y) & 63); return j === 8 ? L(x << s) : j === 9 ? x >> s : L(BigInt.asUintN(64, x) >> s) }
      if ((j === 3 || j === 4) && y === 0n) throw this.error('Ljava/lang/ArithmeticException;', 'divide by zero')
      const X = x as bigint, Y = y as bigint
      switch (j) { case 0: return L(X + Y); case 1: return L(X - Y); case 2: return L(X * Y); case 3: return L(X / Y); case 4: return L(X % Y); case 5: return x & y; case 6: return x | y; default: return x ^ y }
    }
    const f = i <= 26
    const j = f ? i - 22 : i - 27
    const v = [x + y, x - y, x * y, x / y, x % y][j]
    return f ? Math.fround(v) : v
  }
}

export function splitParams(desc: string): string[] {
  const out: string[] = []
  let i = 1
  while (desc[i] !== ')') {
    const s = i
    while (desc[i] === '[') i++
    if (desc[i] === 'L') i = desc.indexOf(';', i) + 1
    else i++
    out.push(desc.slice(s, i))
  }
  return out
}

// ---------- const type pass ----------
const f32 = new Float32Array(1), i32 = new Int32Array(f32.buffer)
const f64 = new Float64Array(1), i64 = new BigInt64Array(f64.buffer)
function conv(kinds: Map<number, string>, pc: number, v: any) {
  const k = kinds.get(pc)
  if (!k) return v
  if (k === 'F') { i32[0] = Number(v); return f32[0] }
  i64[0] = typeof v === 'bigint' ? v : BigInt(v); return f64[0]
}

// instruction size in code units (payload pseudo-instructions included)
export function insnSize(ins: Uint16Array, pc: number) {
  const w = ins[pc], op = w & 0xff
  if (op === 0x00 && w !== 0) {
    if (w === 0x0100) return ins[pc + 1] * 2 + 4
    if (w === 0x0200) return ins[pc + 1] * 4 + 2
    if (w === 0x0300) return Math.ceil((ins[pc + 1] * ((ins[pc + 2] | (ins[pc + 3] << 16)) >>> 0)) / 2) + 4
  }
  if (op === 0x18) return 5
  if ([0x03, 0x06, 0x09, 0x14, 0x17, 0x1b, 0x24, 0x25, 0x26, 0x2a, 0x2b, 0x2c].includes(op) || (op >= 0x6e && op <= 0x78)) return 3
  if ([0x02, 0x05, 0x08, 0x13, 0x15, 0x16, 0x19, 0x1a, 0x1c, 0x1f, 0x20, 0x22, 0x23, 0x29].includes(op) || (op >= 0x2d && op <= 0x6d) || (op >= 0x90 && op <= 0xaf) || (op >= 0xd0 && op <= 0xe2)) return 2
  return 1
}

const cache = new WeakMap<object, Map<number, string>>()
// for every const instruction: the first later read of its register tells if it is a float or double
function constKinds(m: JMethod, dex: Dex): Map<number, string> {
  const code = m.code!
  let out = cache.get(code)
  if (out) return out
  out = new Map()
  const ins = code.insns
  const pcs: number[] = []
  for (let pc = 0; pc < ins.length; pc += insnSize(ins, pc)) pcs.push(pc)
  pcs.forEach((pc, idx) => {
    const op = ins[pc] & 0xff
    if (op < 0x12 || op > 0x19) return
    const reg = op === 0x12 ? (ins[pc] >> 8) & 0xf : ins[pc] >> 8
    for (const q of pcs.slice(idx + 1, idx + 40)) {
      const t = readType(ins, q, reg, m, dex)
      if (t === 'stop') return
      if (t) { if (t === 'F' || t === 'D') out!.set(pc, t); return }
    }
  })
  cache.set(code, out)
  return out
}

// what type instruction q reads register reg as: 'F' | 'D' | 'I' (anything else) | null (does not read it) | 'stop' (overwrites it)
function readType(ins: Uint16Array, q: number, reg: number, m: JMethod, dex: Dex): string | null {
  const w = ins[q], op = w & 0xff, A = (w >> 8) & 0xf, B = w >> 12, AA = w >> 8
  const b = ins[q + 1] & 0xff, c = ins[q + 1] >> 8
  const wide = (r: number) => r === reg || r + 1 === reg
  if (op === 0x2d || op === 0x2e) return b === reg || c === reg ? 'F' : AA === reg ? 'stop' : null
  if (op === 0x2f || op === 0x30) return wide(b) || wide(c) ? 'D' : AA === reg ? 'stop' : null
  if (op === 0x7f || (op >= 0x87 && op <= 0x89)) return B === reg ? 'F' : A === reg ? 'stop' : null
  if (op === 0x80 || (op >= 0x8a && op <= 0x8c)) return wide(B) ? 'D' : A === reg ? 'stop' : null
  if (op >= 0xa6 && op <= 0xaa) return b === reg || c === reg ? 'F' : AA === reg ? 'stop' : null
  if (op >= 0xab && op <= 0xaf) return wide(b) || wide(c) ? 'D' : AA === reg ? 'stop' : null
  if (op >= 0xc6 && op <= 0xca) return A === reg || B === reg ? 'F' : null
  if (op >= 0xcb && op <= 0xcf) return wide(A) || wide(B) ? 'D' : null
  if ((op >= 0x59 && op <= 0x5f) && A === reg) { const t = dex.fields[ins[q + 1]].type; return t === 'F' || t === 'D' ? t : 'I' }
  if ((op >= 0x67 && op <= 0x6d) && AA === reg) { const t = dex.fields[ins[q + 1]].type; return t === 'F' || t === 'D' ? t : 'I' }
  if ((op === 0x0f || op === 0x10) && (op === 0x10 ? wide(AA) : AA === reg)) return m.ret === 'F' || m.ret === 'D' ? m.ret : 'I'
  if (op >= 0x6e && op <= 0x78 && op !== 0x73) {
    const ref = dex.methods[ins[q + 1]]
    const range = op >= 0x74
    const regs = range ? Array.from({ length: AA }, (_, i) => ins[q + 2] + i) : [ins[q + 2] & 0xf, (ins[q + 2] >> 4) & 0xf, (ins[q + 2] >> 8) & 0xf, (ins[q + 2] >> 12) & 0xf, A].slice(0, B)
    let i = op === 0x71 || op === 0x77 ? 0 : 1
    for (const p of ref.proto.params) { if (regs[i] === reg) return p === 'F' || p === 'D' ? p : 'I'; i += p === 'J' || p === 'D' ? 2 : 1 }
    return regs.includes(reg) ? 'I' : null
  }
  // other instructions: if they write the register first, give up
  if ((op >= 0x01 && op <= 0x0d) || (op >= 0x12 && op <= 0x1c) || op === 0x20 || op === 0x21 || op === 0x22 || op === 0x23 || (op >= 0x44 && op <= 0x4a) || (op >= 0x52 && op <= 0x58) || (op >= 0x60 && op <= 0x66) || (op >= 0x7b && op <= 0xe2)) {
    const dst = (op >= 0x7b && op <= 0x8f) || (op >= 0xb0 && op <= 0xd7) || op === 0x01 || op === 0x04 || op === 0x07 || op === 0x12 || op === 0x20 || op === 0x21 || op === 0x23 || (op >= 0x52 && op <= 0x58) ? A : AA
    if (dst === reg) return 'stop'
  }
  return null
}
