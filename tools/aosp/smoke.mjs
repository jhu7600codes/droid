// smoke test: real android framework code running in droid's vm (node, no browser).
// usage: node tools/aosp/smoke.mjs   (after AOSP=1 npm run build, or python3 tools/aosp/build.py)
import fs from 'node:fs'
import { VM } from '../../src/runtime/android/dalvik.ts'
import { registerJava } from '../../src/runtime/android/java.ts'
import { parseDex } from '../../src/runtime/android/dex.ts'
import { registerReflect } from '../../src/runtime/android/reflect.ts'
import { Vfs, registerJavaIo } from '../../src/runtime/android/javaio.ts'
import { registerCollections } from '../../src/runtime/android/collections.ts'
import { registerConcurrent } from '../../src/runtime/android/concurrent.ts'
import { registerAospNatives } from '../../src/runtime/android/aosp/natives.ts'
const vm = new VM(); registerJava(vm); registerCollections(vm); registerJavaIo(vm, new Vfs()); registerReflect(vm); registerConcurrent(vm); registerAospNatives(vm)
const b = fs.readFileSync(new URL('../../dist/runtime/aosp/framework.dex', import.meta.url))
vm.addDex(parseDex(new Uint8Array(b.buffer, b.byteOffset, b.length)))
let fails = 0
const ok = (name, f) => { try { const v = f(); console.log('ok  ', name, v === undefined ? '' : JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? String(x) : x))?.slice(0, 120)) } catch (e) { fails++; console.log('FAIL', name, e?.obj ? `${e.obj.cls.name} ${e.obj.f.message ?? ''}` : e?.message, (e?.obj?.f.jstack || []).slice(0, 4).join(' < ')) } }
const S = (c, k, a = []) => vm.callStatic(c, k, a), V = (o, k, a = []) => vm.callVirtual(o, k, a), N = (c, k, a) => vm.newObject(c, k, a)
ok('TextUtils.isEmpty', () => S('Landroid/text/TextUtils;', 'isEmpty(Ljava/lang/CharSequence;)Z', ['']))
ok('TextUtils.join', () => S('Landroid/text/TextUtils;', 'join(Ljava/lang/CharSequence;[Ljava/lang/Object;)Ljava/lang/String;', [', ', (() => { const a = vm.newArray('[Ljava/lang/Object;', 3); a.data[0] = 'a'; a.data[1] = 'b'; a.data[2] = 'c'; return a })()]))
ok('Rect.intersect', () => { const r = N('Landroid/graphics/Rect;', '<init>(IIII)V', [0, 0, 10, 10]); V(r, 'intersect(IIII)Z', [5, 5, 20, 20]); return V(r, 'toShortString()Ljava/lang/String;') })
ok('SparseArray', () => { const a = N('Landroid/util/SparseArray;', '<init>()V', []); V(a, 'put(ILjava/lang/Object;)V', [5, 'five']); V(a, 'put(ILjava/lang/Object;)V', [1, 'one']); return [V(a, 'size()I'), V(a, 'keyAt(I)I', [0]), V(a, 'get(I)Ljava/lang/Object;', [5])] })
ok('ArrayMap', () => { const m = N('Landroid/util/ArrayMap;', '<init>()V', []); V(m, 'put(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;', ['k', 'v']); return V(m, 'get(Ljava/lang/Object;)Ljava/lang/Object;', ['k']) })
ok('Uri.parse', () => { const u = S('Landroid/net/Uri;', 'parse(Ljava/lang/String;)Landroid/net/Uri;', ['https://a.b/c/d?x=1#f']); return [V(u, 'getHost()Ljava/lang/String;'), V(u, 'getLastPathSegment()Ljava/lang/String;'), V(u, 'getQueryParameter(Ljava/lang/String;)Ljava/lang/String;', ['x'])] })
ok('Color.parseColor', () => S('Landroid/graphics/Color;', 'parseColor(Ljava/lang/String;)I', ['#33b5e5']))
ok('Bundle', () => { const bd = N('Landroid/os/Bundle;', '<init>()V', []); V(bd, 'putString(Ljava/lang/String;Ljava/lang/String;)V', ['a', 'b']); return V(bd, 'getString(Ljava/lang/String;)Ljava/lang/String;', ['a']) })
ok('Html.fromHtml', () => V(S('Landroid/text/Html;', 'fromHtml(Ljava/lang/String;)Landroid/text/Spanned;', ['<b>bold</b> text']), 'toString()Ljava/lang/String;'))
ok('Log.d', () => S('Landroid/util/Log;', 'd(Ljava/lang/String;Ljava/lang/String;)I', ['droid', 'hello from the real framework']))
console.log(fails ? `${fails} FAILED` : 'ALL OK', '| missing:', [...vm.missing].slice(0, 30).join(' '))
