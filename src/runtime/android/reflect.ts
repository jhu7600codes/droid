// framework shim, part 4: java reflection (Class.forName, getMethod / invoke, fields, constructors,
// java.lang.reflect.Array). engines like unity look things up by name all the time.
import { VM, JObject, JArray, JavaThrow, JavaCall, type JClass, type JMethod, type NativeFn } from './dalvik.ts'
import { box, unbox } from './java.ts'

const OBJ = 'Ljava/lang/Object;'
const PRIM: Record<string, string> = { I: 'int', J: 'long', Z: 'boolean', B: 'byte', C: 'char', S: 'short', F: 'float', D: 'double', V: 'void' }
const BOXES: Record<string, string> = { I: 'Ljava/lang/Integer;', J: 'Ljava/lang/Long;', Z: 'Ljava/lang/Boolean;', B: 'Ljava/lang/Byte;', C: 'Ljava/lang/Character;', S: 'Ljava/lang/Short;', F: 'Ljava/lang/Float;', D: 'Ljava/lang/Double;' }
const STATIC = 0x8, PUBLIC = 0x1

// "java.lang.String" / "[I" / "[Ljava.lang.String;" -> descriptor
export const descOf = (name: string) => (name.startsWith('[') ? name.replace(/\./g, '/') : 'L' + name.replace(/\./g, '/') + ';')
export const nameOf = (desc: string) => (desc.startsWith('[') ? desc.replace(/\//g, '.') : PRIM[desc] ?? desc.slice(1, -1).replace(/\//g, '.'))

export function registerReflect(vm: VM) {
  const def = (name: string, sup: string, methods: Record<string, NativeFn>, extra: { interfaces?: string[]; statics?: Record<string, any> } = {}) => vm.shim(name, { super: sup, methods, ...extra })
  const cnf = (n: string) => vm.error('Ljava/lang/ClassNotFoundException;', n)
  vm.shim('Ljava/lang/ReflectiveOperationException;', { super: 'Ljava/lang/Exception;', methods: { '<init>(Ljava/lang/String;)V': (v, s, [m]) => { s.f.message = m } } })
  for (const n of ['ClassNotFoundException', 'NoSuchMethodException', 'NoSuchFieldException', 'IllegalAccessException', 'InstantiationException'])
    vm.shim(`Ljava/lang/${n};`, { super: 'Ljava/lang/ReflectiveOperationException;', methods: { '<init>(Ljava/lang/String;)V': (v, s, [m]) => { s.f.message = m }, '<init>()V': () => {} } })
  vm.shim('Ljava/lang/reflect/InvocationTargetException;', { super: 'Ljava/lang/ReflectiveOperationException;', methods: {
    '<init>(Ljava/lang/Throwable;)V': (v, s, [c]) => { s.f.cause = c; s.f.target = c },
    'getTargetException()Ljava/lang/Throwable;': (v, s) => s.f.target ?? null,
    'getCause()Ljava/lang/Throwable;': (v, s) => s.f.target ?? null,
  } })

  // ---------- values in and out of reflective calls ----------
  const unwrap = (t: string, v: any) => {
    if (!(t in BOXES)) return v
    const x = unbox(v)
    if (t === 'J') return typeof x === 'bigint' ? x : BigInt(x ?? 0)
    if (t === 'F' || t === 'D') return Number(x ?? 0)
    if (typeof x === 'bigint') return Number(x) | 0
    return x ?? 0
  }
  const wrap = (t: string, v: any) => (t === 'V' ? null : t in BOXES ? box(vm, BOXES[t], v) : v)
  const argsOf = (m: JMethod, arr: JArray | null) => m.params.map((p, i) => unwrap(p, arr?.data[i] ?? null))
  const ite = (e: JavaThrow) => { const x = new JObject(vm.cls('Ljava/lang/reflect/InvocationTargetException;')); x.f.target = x.f.cause = e.obj; x.f.message = e.obj.f.message; return new JavaThrow(x) }
  const call = (m: JMethod, self: any, args: any[]) => {
    try { return vm.invoke(m, self, args) }
    catch (e) {
      if (e instanceof JavaThrow) { const ite = new JObject(vm.cls('Ljava/lang/reflect/InvocationTargetException;')); ite.f.target = ite.f.cause = e.obj; ite.f.message = e.obj.f.message; throw new JavaThrow(ite) }
      throw e
    }
  }

  // ---------- members ----------
  const methodObj = (m: JMethod, ctor = false) => {
    const o = new JObject(vm.cls(ctor ? 'Ljava/lang/reflect/Constructor;' : 'Ljava/lang/reflect/Method;'))
    o.f.m = m
    return o
  }
  const paramTypes = (m: JMethod) => { const a = vm.newArray('[Ljava/lang/Class;', m.params.length); m.params.forEach((p, i) => (a.data[i] = classFor(p))); return a }
  // all methods of a class and its supers (and interfaces), first one per key wins
  const allMethods = (c: JClass | null, own = false) => {
    const out = new Map<string, JMethod>()
    const add = (x: JClass) => { for (const [k, m] of x.methods) if (!out.has(k) && !m.name.startsWith('<')) out.set(k, m) }
    if (own) { if (c) add(c); return [...out.values()] }
    const seen = new Set<JClass>()
    const walk = (x: JClass | null) => { for (; x; x = x.super) { if (seen.has(x)) return; seen.add(x); add(x); x.interfaces.forEach((i) => walk(i)) } }
    walk(c)
    return [...out.values()]
  }
  const sameParams = (m: JMethod, types: JArray | null) => {
    const want = types ? [...types.data].map((t: any) => descOfClass(t)) : []
    return m.params.length === want.length && m.params.every((p, i) => p === want[i])
  }
  const findByName = (c: JClass, name: string, types: JArray | null, own: boolean) => {
    for (const m of allMethods(c, own)) if (m.name === name && sameParams(m, types)) return m
    return null
  }
  const fieldOwner = (c: JClass | null, name: string): JClass | null => { for (let x = c; x; x = x.super) if (name in x.fieldTypes || name in x.staticValues) return x; return null }
  const fieldObj = (owner: JClass, name: string) => {
    const f = new JObject(vm.cls('Ljava/lang/reflect/Field;'))
    f.f.owner = owner; f.f.name = name; f.f.type = owner.fieldTypes[name] ?? guessType(owner.staticValues[name])
    return f
  }
  const guessType = (v: any) => (typeof v === 'number' ? (Number.isInteger(v) ? 'I' : 'D') : typeof v === 'bigint' ? 'J' : typeof v === 'string' ? 'Ljava/lang/String;' : OBJ)
  const isStaticField = (f: JObject) => f.f.name in f.f.owner.staticValues && !(f.f.owner.dexClass?.instanceFields?.some((x: any) => x.ref.name === f.f.name))

  def('Ljava/lang/Class;', OBJ, {
    'forName(Ljava/lang/String;)Ljava/lang/Class;': (v, s, [n]) => { const d = descOf(n); if (!vm.hasClass(d)) throw cnf(n); const c = vm.cls(d); vm.init(c); return vm.classObject(c) },
    'forName(Ljava/lang/String;ZLjava/lang/ClassLoader;)Ljava/lang/Class;': (v, s, [n, initialize]) => { const d = descOf(n); if (!vm.hasClass(d)) throw cnf(n); const c = vm.cls(d); if (initialize) vm.init(c); return vm.classObject(c) },
    'getName()Ljava/lang/String;': (v, s) => nameOf(descOfClass(s)),
    'getCanonicalName()Ljava/lang/String;': (v, s) => nameOf(descOfClass(s)).replace(/\$/g, '.'),
    'getSimpleName()Ljava/lang/String;': (v, s) => nameOf(descOfClass(s)).split(/[.$]/).pop(),
    'toString()Ljava/lang/String;': (v, s) => (s.f.prim ? PRIM[s.f.prim] : 'class ' + nameOf(descOfClass(s))),
    'hashCode()I': (v, s) => { let h = 0; for (const ch of descOfClass(s)) h = (Math.imul(31, h) + ch.charCodeAt(0)) | 0; return h },
    'isPrimitive()Z': (v, s) => (s.f.prim ? 1 : 0),
    'isArray()Z': (v, s) => (descOfClass(s).startsWith('[') ? 1 : 0),
    'isInterface()Z': (v, s) => (ofClass(s).flags & 0x200 ? 1 : 0),
    'isEnum()Z': (v, s) => (ofClass(s).super?.name === 'Ljava/lang/Enum;' ? 1 : 0),
    'getModifiers()I': (v, s) => ofClass(s).flags | PUBLIC,
    'getComponentType()Ljava/lang/Class;': (v, s) => { const d = descOfClass(s); return d.startsWith('[') ? classFor(d.slice(1)) : null },
    'getSuperclass()Ljava/lang/Class;': (v, s) => (ofClass(s).super ? vm.classObject(ofClass(s).super!) : null),
    'getInterfaces()[Ljava/lang/Class;': (v, s) => { const l = ofClass(s).interfaces; const a = vm.newArray('[Ljava/lang/Class;', l.length); l.forEach((c, i) => (a.data[i] = vm.classObject(c))); return a },
    'isInstance(Ljava/lang/Object;)Z': (v, s, [o]) => (vm.instanceOf(o, ofClass(s)) ? 1 : 0),
    'isAssignableFrom(Ljava/lang/Class;)Z': (v, s, [o]) => (s === o || (!s.f.prim && !o.f.prim && vm.isSubclass(ofClass(o), ofClass(s))) ? 1 : 0),
    'cast(Ljava/lang/Object;)Ljava/lang/Object;': (v, s, [o]) => o,
    'getClassLoader()Ljava/lang/ClassLoader;': () => loader,
    'desiredAssertionStatus()Z': () => 0,
    'getPackage()Ljava/lang/Package;': () => null,
    'newInstance()Ljava/lang/Object;': (v, s) => { const c = ofClass(s); vm.init(c); const o = new JObject(c); const m = vm.findMethod(c, '<init>()V'); if (m) vm.invoke(m, o, []); return o },
    'getMethod(Ljava/lang/String;[Ljava/lang/Class;)Ljava/lang/reflect/Method;': (v, s, [n, types]) => { const m = findByName(ofClass(s), n, types, false); if (!m) throw vm.error('Ljava/lang/NoSuchMethodException;', n); return methodObj(m) },
    'getDeclaredMethod(Ljava/lang/String;[Ljava/lang/Class;)Ljava/lang/reflect/Method;': (v, s, [n, types]) => { const m = findByName(ofClass(s), n, types, true); if (!m) throw vm.error('Ljava/lang/NoSuchMethodException;', n); return methodObj(m) },
    'getMethods()[Ljava/lang/reflect/Method;': (v, s) => { const l = allMethods(ofClass(s)); const a = vm.newArray('[Ljava/lang/reflect/Method;', l.length); l.forEach((m, i) => (a.data[i] = methodObj(m))); return a },
    'getDeclaredMethods()[Ljava/lang/reflect/Method;': (v, s) => { const l = allMethods(ofClass(s), true); const a = vm.newArray('[Ljava/lang/reflect/Method;', l.length); l.forEach((m, i) => (a.data[i] = methodObj(m))); return a },
    'getConstructor([Ljava/lang/Class;)Ljava/lang/reflect/Constructor;': (v, s, [types]) => ctor(ofClass(s), types),
    'getDeclaredConstructor([Ljava/lang/Class;)Ljava/lang/reflect/Constructor;': (v, s, [types]) => ctor(ofClass(s), types),
    'getConstructors()[Ljava/lang/reflect/Constructor;': (v, s) => ctors(ofClass(s)),
    'getDeclaredConstructors()[Ljava/lang/reflect/Constructor;': (v, s) => ctors(ofClass(s)),
    'getField(Ljava/lang/String;)Ljava/lang/reflect/Field;': (v, s, [n]) => { vm.init(ofClass(s)); const o = fieldOwner(ofClass(s), n); if (!o) throw vm.error('Ljava/lang/NoSuchFieldException;', n); return fieldObj(o, n) },
    'getDeclaredField(Ljava/lang/String;)Ljava/lang/reflect/Field;': (v, s, [n]) => { const c = ofClass(s); vm.init(c); if (!(n in c.fieldTypes || n in c.staticValues)) throw vm.error('Ljava/lang/NoSuchFieldException;', n); return fieldObj(c, n) },
    'getFields()[Ljava/lang/reflect/Field;': (v, s) => fields(ofClass(s), false),
    'getDeclaredFields()[Ljava/lang/reflect/Field;': (v, s) => fields(ofClass(s), true),
    'getEnumConstants()[Ljava/lang/Object;': (v, s) => { try { return vm.callStatic(ofClass(s).name, `values()[${ofClass(s).name}`) } catch { return null } },
    'getAnnotation(Ljava/lang/Class;)Ljava/lang/annotation/Annotation;': () => null,
    'isAnnotationPresent(Ljava/lang/Class;)Z': () => 0,
    'getDeclaringClass()Ljava/lang/Class;': (v, s) => { const n = ofClass(s).name; const i = n.lastIndexOf('$'); return i > 0 && vm.hasClass(n.slice(0, i) + ';') ? vm.classObject(vm.cls(n.slice(0, i) + ';')) : null },
    'getEnclosingClass()Ljava/lang/Class;': (v, s) => { const n = ofClass(s).name; const i = n.lastIndexOf('$'); return i > 0 && vm.hasClass(n.slice(0, i) + ';') ? vm.classObject(vm.cls(n.slice(0, i) + ';')) : null },
  })
  // primitive classes (int.class ...) are classes named by their descriptor letter
  const prim = new Map<string, JObject>()
  const primClass = (d: string) => {
    let o = prim.get(d)
    if (!o) { o = new JObject(vm.cls('Ljava/lang/Class;')); o.f.prim = d; o.f.of = { name: d, super: null, interfaces: [], methods: new Map(), staticValues: {}, fieldTypes: {}, initialized: true, flags: PUBLIC }; prim.set(d, o) }
    return o
  }
  for (const [d, b] of Object.entries(BOXES)) { const sh = vm.shims.get(b); if (sh) vm.shim(b, { ...sh, statics: { ...(sh.statics || {}), TYPE: primClass(d) } }) }
  vm.shims.set('Ljava/lang/Void;', { super: OBJ, methods: {}, statics: { TYPE: primClass('V') } })
  const classFor = (desc: string): JObject => (PRIM[desc] ? primClass(desc) : vm.classObject(vm.cls(desc)))
  const ofClass = (c: JObject): JClass => c.f.of
  const descOfClass = (c: JObject): string => c.f.prim ?? ofClass(c).name

  const ctor = (c: JClass, types: JArray | null) => {
    for (const [k, m] of c.methods) if (k.startsWith('<init>(') && sameParams(m, types)) return methodObj(m, true)
    if (!types?.data.length && !c.dexClass) return methodObj({ cls: c, name: '<init>', key: '<init>()V', desc: '()V', ret: 'V', params: [], flags: PUBLIC, code: null, native: () => {} } as JMethod, true)
    throw vm.error('Ljava/lang/NoSuchMethodException;', '<init>')
  }
  const ctors = (c: JClass) => { const l = [...c.methods.values()].filter((m) => m.name === '<init>'); const a = vm.newArray('[Ljava/lang/reflect/Constructor;', l.length); l.forEach((m, i) => (a.data[i] = methodObj(m, true))); return a }
  const fields = (c: JClass, own: boolean) => {
    vm.init(c)
    const out: JObject[] = []
    for (let x: JClass | null = c; x; x = own ? null : x.super) for (const n of new Set([...Object.keys(x.fieldTypes), ...Object.keys(x.staticValues)])) out.push(fieldObj(x, n))
    const a = vm.newArray('[Ljava/lang/reflect/Field;', out.length)
    out.forEach((f, i) => (a.data[i] = f))
    return a
  }

  const memberCommon = (): Record<string, NativeFn> => ({
    'setAccessible(Z)V': () => {},
    'isAccessible()Z': () => 1,
    'getAnnotation(Ljava/lang/Class;)Ljava/lang/annotation/Annotation;': () => null,
    'isAnnotationPresent(Ljava/lang/Class;)Z': () => 0,
  })
  def('Ljava/lang/reflect/AccessibleObject;', OBJ, memberCommon())
  def('Ljava/lang/reflect/Member;', OBJ, {})
  def('Ljava/lang/reflect/Method;', 'Ljava/lang/reflect/AccessibleObject;', {
    'invoke(Ljava/lang/Object;[Ljava/lang/Object;)Ljava/lang/Object;': (v, s, [o, a]) => {
      const m: JMethod = s.f.m
      const isStatic = !!(m.flags & STATIC)
      if (!isStatic && o == null) throw vm.error('Ljava/lang/NullPointerException;', 'null receiver')
      const target = isStatic ? m : vm.findMethod(vm.classOf(o), m.key) ?? m
      if (isStatic) vm.init(m.cls)
      // a java method runs as a frame of this thread (it may wait: locks, network); natives directly
      if (target.code && !target.native) throw new JavaCall(target, isStatic ? null : o, argsOf(m, a), (r) => wrap(m.ret, r), ite)
      return wrap(m.ret, call(target, isStatic ? null : o, argsOf(m, a)))
    },
    'getName()Ljava/lang/String;': (v, s) => s.f.m.name,
    'getReturnType()Ljava/lang/Class;': (v, s) => classFor(s.f.m.ret),
    'getParameterTypes()[Ljava/lang/Class;': (v, s) => paramTypes(s.f.m),
    'getDeclaringClass()Ljava/lang/Class;': (v, s) => vm.classObject(s.f.m.cls),
    'getModifiers()I': (v, s) => s.f.m.flags | PUBLIC,
    'getExceptionTypes()[Ljava/lang/Class;': () => vm.newArray('[Ljava/lang/Class;', 0),
    'toString()Ljava/lang/String;': (v, s) => `${nameOf(s.f.m.ret)} ${nameOf(s.f.m.cls.name)}.${s.f.m.name}(${s.f.m.params.map(nameOf).join(',')})`,
    'equals(Ljava/lang/Object;)Z': (v, s, [o]) => (o?.f?.m === s.f.m ? 1 : 0),
    'hashCode()I': (v, s) => s.f.m.key.length,
  }, { interfaces: ['Ljava/lang/reflect/Member;'] })
  def('Ljava/lang/reflect/Constructor;', 'Ljava/lang/reflect/AccessibleObject;', {
    'newInstance([Ljava/lang/Object;)Ljava/lang/Object;': (v, s, [a]) => {
      const m: JMethod = s.f.m
      vm.init(m.cls)
      const o = new JObject(m.cls)
      call(m, o, argsOf(m, a))
      return o
    },
    'getParameterTypes()[Ljava/lang/Class;': (v, s) => paramTypes(s.f.m),
    'getDeclaringClass()Ljava/lang/Class;': (v, s) => vm.classObject(s.f.m.cls),
    'getModifiers()I': (v, s) => s.f.m.flags | PUBLIC,
    'getName()Ljava/lang/String;': (v, s) => nameOf(s.f.m.cls.name),
  }, { interfaces: ['Ljava/lang/reflect/Member;'] })
  const fget = (f: JObject, o: any) => (isStaticField(f) ? f.f.owner.staticValues[f.f.name] : o?.f[f.f.name] ?? defaultOf(f.f.type))
  const fset = (f: JObject, o: any, v: any) => { if (isStaticField(f)) f.f.owner.staticValues[f.f.name] = v; else o.f[f.f.name] = v }
  const defaultOf = (t: string) => (t === 'J' ? 0n : t in BOXES ? 0 : null)
  const typed = (t: string): Record<string, NativeFn> => {
    const out: Record<string, NativeFn> = {}
    for (const [d, n] of Object.entries({ I: 'Int', J: 'Long', Z: 'Boolean', B: 'Byte', C: 'Char', S: 'Short', F: 'Float', D: 'Double' })) {
      out[`get${n}(Ljava/lang/Object;)${d}`] = (v, s, [o]) => unwrap(d, fget(s, o))
      out[`set${n}(Ljava/lang/Object;${d})V`] = (v, s, [o, x]) => fset(s, o, x)
    }
    void t
    return out
  }
  def('Ljava/lang/reflect/Field;', 'Ljava/lang/reflect/AccessibleObject;', {
    'get(Ljava/lang/Object;)Ljava/lang/Object;': (v, s, [o]) => wrap(s.f.type[0] in BOXES && s.f.type.length === 1 ? s.f.type : 'L', fget(s, o)),
    'set(Ljava/lang/Object;Ljava/lang/Object;)V': (v, s, [o, x]) => fset(s, o, s.f.type.length === 1 ? unwrap(s.f.type, x) : x),
    ...typed(''),
    'getName()Ljava/lang/String;': (v, s) => s.f.name,
    'getType()Ljava/lang/Class;': (v, s) => classFor(s.f.type),
    'getDeclaringClass()Ljava/lang/Class;': (v, s) => vm.classObject(s.f.owner),
    'getModifiers()I': (v, s) => (isStaticField(s) ? STATIC : 0) | PUBLIC,
  }, { interfaces: ['Ljava/lang/reflect/Member;'] })
  def('Ljava/lang/reflect/Modifier;', OBJ, {
    'isStatic(I)Z': (v, s, [m]) => (m & STATIC ? 1 : 0), 'isPublic(I)Z': (v, s, [m]) => (m & PUBLIC ? 1 : 0),
    'isPrivate(I)Z': (v, s, [m]) => (m & 2 ? 1 : 0), 'isFinal(I)Z': (v, s, [m]) => (m & 0x10 ? 1 : 0),
    'isAbstract(I)Z': (v, s, [m]) => (m & 0x400 ? 1 : 0), 'isInterface(I)Z': (v, s, [m]) => (m & 0x200 ? 1 : 0),
  }, { statics: { PUBLIC: 1, PRIVATE: 2, PROTECTED: 4, STATIC: 8, FINAL: 0x10, ABSTRACT: 0x400, INTERFACE: 0x200 } })
  def('Ljava/lang/reflect/Array;', OBJ, {
    'newInstance(Ljava/lang/Class;I)Ljava/lang/Object;': (v, s, [c, n]) => vm.newArray('[' + descOfClass(c), n),
    'getLength(Ljava/lang/Object;)I': (v, s, [a]) => a.data.length,
    'get(Ljava/lang/Object;I)Ljava/lang/Object;': (v, s, [a, i]) => { const t = a.cls.name.slice(1); return t.length === 1 ? wrap(t, a.data[i]) : a.data[i] },
    'set(Ljava/lang/Object;ILjava/lang/Object;)V': (v, s, [a, i, x]) => { const t = a.cls.name.slice(1); a.data[i] = t.length === 1 ? unwrap(t, x) : x },
    'getInt(Ljava/lang/Object;I)I': (v, s, [a, i]) => a.data[i],
  })

  // one class loader for everything
  def('Ljava/lang/ClassLoader;', OBJ, {
    '<init>()V': () => {}, '<init>(Ljava/lang/ClassLoader;)V': (v, s, [p]) => { s.f.parent = p },
    'loadClass(Ljava/lang/String;)Ljava/lang/Class;': (v, s, [n]) => { const d = descOf(n); if (!vm.hasClass(d)) throw cnf(n); return vm.classObject(vm.cls(d)) },
    'loadClass(Ljava/lang/String;Z)Ljava/lang/Class;': (v, s, [n]) => { const d = descOf(n); if (!vm.hasClass(d)) throw cnf(n); return vm.classObject(vm.cls(d)) },
    'findLoadedClass(Ljava/lang/String;)Ljava/lang/Class;': (v, s, [n]) => { const d = descOf(n); return vm.hasClass(d) ? vm.classObject(vm.cls(d)) : null },
    'getResources(Ljava/lang/String;)Ljava/util/Enumeration;': () => vm.callStatic('Ljava/util/Collections;', 'enumeration(Ljava/util/Collection;)Ljava/util/Enumeration;', [vm.newObject('Ljava/util/ArrayList;')]),
    'getParent()Ljava/lang/ClassLoader;': () => null,
    'getSystemClassLoader()Ljava/lang/ClassLoader;': () => loader,
    'getResource(Ljava/lang/String;)Ljava/net/URL;': () => null,
    'getResourceAsStream(Ljava/lang/String;)Ljava/io/InputStream;': () => null,
  })
  const loader = new JObject(vm.cls('Ljava/lang/ClassLoader;'))

  // ---------- dynamic proxies: a made-up class whose every interface method calls handler.invoke ----------
  let proxyN = 0
  const proxyClasses = new Map<string, JClass>()
  const proxyClass = (ifaces: JClass[]): JClass => {
    const k = ifaces.map((i) => i.name).join(',')
    const had = proxyClasses.get(k)
    if (had) return had
    const name = `L$Proxy${proxyN++};`
    const c: JClass = { name, super: vm.cls('Ljava/lang/reflect/Proxy;'), interfaces: ifaces, methods: new Map(), staticValues: {}, fieldTypes: {}, initialized: true, flags: PUBLIC | 0x10 }
    const add = (m: JMethod) => {
      if (c.methods.has(m.key) || m.name.startsWith('<') || m.flags & STATIC) return
      vm.epoch++; c.methods.set(m.key, { ...m, cls: c, flags: PUBLIC, code: null, native: (vm2: VM, self: JObject, args: any[]) => {
        const arr = m.params.length ? vm.newArray('[Ljava/lang/Object;', m.params.length) : null
        m.params.forEach((p, i) => (arr!.data[i] = wrap(p, args[i])))
        const key = 'invoke(Ljava/lang/Object;Ljava/lang/reflect/Method;[Ljava/lang/Object;)Ljava/lang/Object;'
        const im = vm.findMethod(vm.classOf(self.f.h), key)
        if (!im) throw vm.error('Ljava/lang/AbstractMethodError;', 'InvocationHandler.invoke')
        // the handler runs as a frame of this thread, so it can wait (network calls behind a proxy)
        throw new JavaCall(im, self.f.h, [self, methodObj(m), arr], (r) => (m.ret === 'V' ? undefined : unwrap(m.ret, r)))
      } } as JMethod)
    }
    for (const i of ifaces) for (const m of allMethods(i)) add(m)
    for (const key of ['equals(Ljava/lang/Object;)Z', 'hashCode()I', 'toString()Ljava/lang/String;']) { const m = vm.findMethod(vm.cls(OBJ), key); if (m) add(m) }
    vm.classes.set(name, c)
    proxyClasses.set(k, c)
    return c
  }
  def('Ljava/lang/reflect/Proxy;', OBJ, {
    'newProxyInstance(Ljava/lang/ClassLoader;[Ljava/lang/Class;Ljava/lang/reflect/InvocationHandler;)Ljava/lang/Object;': (v, s, [, ifs, h]) => {
      const o = new JObject(proxyClass([...(ifs?.data || [])].map((x: any) => ofClass(x))))
      o.f.h = h
      return o
    },
    'getProxyClass(Ljava/lang/ClassLoader;[Ljava/lang/Class;)Ljava/lang/Class;': (v, s, [, ifs]) => vm.classObject(proxyClass([...(ifs?.data || [])].map((x: any) => ofClass(x)))),
    'isProxyClass(Ljava/lang/Class;)Z': (v, s, [c]) => (ofClass(c).super?.name === 'Ljava/lang/reflect/Proxy;' ? 1 : 0),
    'getInvocationHandler(Ljava/lang/Object;)Ljava/lang/reflect/InvocationHandler;': (v, s, [o]) => o?.f.h ?? null,
  })
  return { classFor, loader }
}
