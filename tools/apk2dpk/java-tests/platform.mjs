// org.json, gzip / crc32, hmac, URI through droid's shims
import { VM } from '../../../src/runtime/android/dalvik.ts'
import { registerJava } from '../../../src/runtime/android/java.ts'
import { gunzip, gzipStored, crc32 } from '../../../src/runtime/android/platform.ts'
import { gzipSync } from 'node:zlib'
const vm = new VM(); registerJava(vm)
let fails = 0
const J = (x) => JSON.stringify(x, (k, v) => (typeof v === 'bigint' ? v.toString() + 'n' : v))
const eq = (got, want, m) => { if (J(got) !== J(want)) { fails++; console.log('FAIL', m, 'got', J(got), 'want', J(want)) } }
const V = (o, key, args = []) => vm.callVirtual(o, key, args)
const N = (cls, key, args) => vm.newObject(cls, key, args)
const o = N('Lorg/json/JSONObject;', '<init>(Ljava/lang/String;)V', ['{"a":1,"b":"x","c":[1,2.5,true,null],"d":{"e":12345678901234567},"f":null}'])
eq(V(o, 'getInt(Ljava/lang/String;)I', ['a']), 1, 'getInt')
eq(V(o, 'getString(Ljava/lang/String;)Ljava/lang/String;', ['b']), 'x', 'getString')
eq(V(o, 'getString(Ljava/lang/String;)Ljava/lang/String;', ['a']), '1', 'getString of number')
const c = V(o, 'getJSONArray(Ljava/lang/String;)Lorg/json/JSONArray;', ['c'])
eq(V(c, 'length()I'), 4, 'array length'); eq(V(c, 'getDouble(I)D', [1]), 2.5, 'getDouble'); eq(V(c, 'getBoolean(I)Z', [2]), 1, 'getBoolean'); eq(V(c, 'isNull(I)Z', [3]), 1, 'isNull')
eq(V(V(o, 'getJSONObject(Ljava/lang/String;)Lorg/json/JSONObject;', ['d']), 'getLong(Ljava/lang/String;)J', ['e']), 12345678901234567n, 'big long')
eq(V(o, 'optString(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;', ['zz', 'def']), 'def', 'optString default')
eq(V(o, 'isNull(Ljava/lang/String;)Z', ['f']), 1, 'isNull key')
eq(V(o, 'has(Ljava/lang/String;)Z', ['zz']), 0, 'has')
let threw = false; try { V(o, 'getInt(Ljava/lang/String;)I', ['zz']) } catch { threw = true } eq(threw, true, 'missing throws')
const p = N('Lorg/json/JSONObject;', '<init>()V', [])
V(p, 'put(Ljava/lang/String;I)Lorg/json/JSONObject;', ['n', 3]); V(p, 'put(Ljava/lang/String;Ljava/lang/Object;)Lorg/json/JSONObject;', ['s', 'a/b"']); V(p, 'put(Ljava/lang/String;Z)Lorg/json/JSONObject;', ['t', 1])
eq(V(p, 'toString()Ljava/lang/String;'), '{"n":3,"s":"a\\/b\\"","t":true}', 'toString')
eq(V(o, 'toString()Ljava/lang/String;'), '{"a":1,"b":"x","c":[1,2.5,true,null],"d":{"e":12345678901234567},"f":null}', 'roundtrip')
// gzip
const raw = new TextEncoder().encode('hello hello hello gzip world '.repeat(50))
eq(new TextDecoder().decode(gunzip(gzipSync(raw))), new TextDecoder().decode(raw), 'gunzip node gzip')
eq(new TextDecoder().decode(gunzip(gzipStored(raw))), new TextDecoder().decode(raw), 'gzip stored roundtrip')
eq(crc32(new TextEncoder().encode('123456789')), 0xcbf43926, 'crc32')
// hmac
const key = N('Ljavax/crypto/spec/SecretKeySpec;', '<init>([BLjava/lang/String;)V', [(() => { const a = vm.newArray('[B', 3); a.data.set([107, 101, 121]); return a })(), 'HmacSHA256'])
const mac = vm.callStatic('Ljavax/crypto/Mac;', 'getInstance(Ljava/lang/String;)Ljavax/crypto/Mac;', ['HmacSHA256'])
V(mac, 'init(Ljava/security/Key;)V', [key])
const msg = vm.newArray('[B', 43); msg.data.set(new TextEncoder().encode('The quick brown fox jumps over the lazy dog'))
const out = V(mac, 'doFinal([B)[B', [msg])
eq(Buffer.from(new Uint8Array(out.data.buffer)).toString('hex'), 'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8', 'hmac sha256')
const u = N('Ljava/net/URI;', '<init>(Ljava/lang/String;)V', ['https://a.b:8080/x/y?q=1#f'])
eq([V(u, 'getScheme()Ljava/lang/String;'), V(u, 'getHost()Ljava/lang/String;'), V(u, 'getPort()I'), V(u, 'getPath()Ljava/lang/String;'), V(u, 'getQuery()Ljava/lang/String;')], ['https', 'a.b', 8080, '/x/y', 'q=1'], 'URI parts')
console.log(fails ? `${fails} FAILED` : 'ALL OK')
