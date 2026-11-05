// regex, dates, number formats, digests, url encoding, base64 through droid's shims
import { VM } from '../../../src/runtime/android/dalvik.ts'
import { registerJava } from '../../../src/runtime/android/java.ts'
import { formatDate, parseDate } from '../../../src/runtime/android/javamore.ts'
const vm = new VM(); registerJava(vm)
let fails = 0
const J = (x) => JSON.stringify(x, (k, v) => (typeof v === 'bigint' ? v.toString() + 'n' : v))
const eq = (got, want, m) => { if (J(got) !== J(want)) { fails++; console.log('FAIL', m, 'got', J(got), 'want', J(want)) } }
const S = (cls, key, args = []) => vm.callStatic(cls, key, args)
const V = (o, key, args = []) => vm.callVirtual(o, key, args)
const arr = (a) => [...a.data]
// String regex
eq(arr(V('a,b,,c,,', 'split(Ljava/lang/String;)[Ljava/lang/String;', [','])), ['a', 'b', '', 'c'], 'split trailing empties')
eq(arr(V('a1b22c', 'split(Ljava/lang/String;)[Ljava/lang/String;', ['\\d+'])), ['a', 'b', 'c'], 'split regex')
eq(arr(V('abc', 'split(Ljava/lang/String;)[Ljava/lang/String;', [''])), ['a', 'b', 'c'], 'split empty')
eq(arr(V('a,b,c', 'split(Ljava/lang/String;I)[Ljava/lang/String;', [',', 2])), ['a', 'b,c'], 'split limit')
eq(arr(V(',a', 'split(Ljava/lang/String;)[Ljava/lang/String;', [','])), ['', 'a'], 'split leading')
eq(V('hello world', 'replaceAll(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;', ['(\\w+) (\\w+)', '$2 $1']), 'world hello', 'replaceAll groups')
eq(V('a.b.c', 'replaceAll(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;', ['\\.', '\\$']), 'a$b$c', 'replaceAll escaped $')
eq(V('2024-01-05', 'matches(Ljava/lang/String;)Z', ['\\d{4}-\\d{2}-\\d{2}']), 1, 'matches')
eq(V('x2024-01-05', 'matches(Ljava/lang/String;)Z', ['\\d{4}-\\d{2}-\\d{2}']), 0, 'matches whole')
eq(V('ABC', 'matches(Ljava/lang/String;)Z', ['(?i)abc']), 1, 'inline flag')
eq(V('a+b', 'replaceAll(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;', ['\\Q+\\E', '-']), 'a-b', '\\Q\\E')
// Pattern / Matcher
const p = S('Ljava/util/regex/Pattern;', 'compile(Ljava/lang/String;)Ljava/util/regex/Pattern;', ['v=([\\w-]{11})'])
const mm = V(p, 'matcher(Ljava/lang/CharSequence;)Ljava/util/regex/Matcher;', ['https://youtube.com/watch?v=dQw4w9WgXcQ&t=1'])
eq(V(mm, 'find()Z'), 1, 'find'); eq(V(mm, 'group(I)Ljava/lang/String;', [1]), 'dQw4w9WgXcQ', 'group 1'); eq(V(mm, 'start()I'), 26, 'start')
eq(V(mm, 'find()Z'), 0, 'find again')
const m2 = V(S('Ljava/util/regex/Pattern;', 'compile(Ljava/lang/String;I)Ljava/util/regex/Pattern;', ['(\\d)', 2]), 'matcher(Ljava/lang/CharSequence;)Ljava/util/regex/Matcher;', ['a1b2c3'])
const found = []; while (V(m2, 'find()Z')) found.push(V(m2, 'group()Ljava/lang/String;')); eq(found, ['1', '2', '3'], 'find loop')
eq(V(m2, 'groupCount()I'), 1, 'groupCount')
// dates
const t = Date.UTC(2024, 0, 5, 13, 4, 5, 6)
eq(formatDate("yyyy-MM-dd'T'HH:mm:ss.SSSZ", t, 'UTC'), '2024-01-05T13:04:05.006+0000', 'format iso')
eq(formatDate('EEE, d MMM yyyy h:mm a', t, 'UTC'), 'Fri, 5 Jan 2024 1:04 PM', 'format words')
eq(formatDate('HH:mm', t, 'GMT+03:00'), '16:04', 'format zone')
eq(parseDate("yyyy-MM-dd'T'HH:mm:ss", '2024-01-05T13:04:05', 'UTC'), Date.UTC(2024, 0, 5, 13, 4, 5), 'parse iso')
eq(parseDate('yyyyMMdd', '20240105', 'UTC'), Date.UTC(2024, 0, 5), 'parse packed')
eq(parseDate("yyyy-MM-dd'T'HH:mm:ssX", '2024-01-05T13:04:05+02:00', 'UTC'), Date.UTC(2024, 0, 5, 11, 4, 5), 'parse offset')
eq(parseDate('MMM d, yyyy', 'Jan 5, 2024', 'UTC'), Date.UTC(2024, 0, 5), 'parse month name')
eq(parseDate('yyyy-MM-dd', 'nope', 'UTC'), null, 'parse fails')
const cal = S('Ljava/util/Calendar;', 'getInstance(Ljava/util/TimeZone;)Ljava/util/Calendar;', [S('Ljava/util/TimeZone;', 'getTimeZone(Ljava/lang/String;)Ljava/util/TimeZone;', ['UTC'])])
V(cal, 'setTimeInMillis(J)V', [BigInt(Date.UTC(2024, 0, 31, 10))])
V(cal, 'add(II)V', [2, 1]); eq(V(cal, 'get(I)I', [5]), 29, 'add month clamps (leap feb)')
V(cal, 'add(II)V', [5, 1]); eq([V(cal, 'get(I)I', [2]), V(cal, 'get(I)I', [5]), V(cal, 'get(I)I', [7])], [2, 1, 6], 'add day -> mar 1 friday')
V(cal, 'set(II)V', [11, 0]); eq(V(cal, 'get(I)I', [11]), 0, 'set hour')
// numbers
const nf = S('Ljava/text/NumberFormat;', 'getNumberInstance()Ljava/text/NumberFormat;')
eq(V(nf, 'format(J)Ljava/lang/String;', [1234567n]), '1,234,567', 'grouping')
const df = vm.newObject('Ljava/text/DecimalFormat;'); V(df, '<init>(Ljava/lang/String;)V', ['#,##0.00'])
eq(V(df, 'format(D)Ljava/lang/String;', [1234.5]), '1,234.50', 'decimal pattern')
// digests (known vectors)
const md = (alg, x) => { const d = S('Ljava/security/MessageDigest;', 'getInstance(Ljava/lang/String;)Ljava/security/MessageDigest;', [alg]); const a = vm.newArray('[B', x.length); a.data.set(new TextEncoder().encode(x)); return [...V(d, 'digest([B)[B', [a]).data].map((b) => (b & 255).toString(16).padStart(2, '0')).join('') }
eq(md('MD5', 'abc'), '900150983cd24fb0d6963f7d28e17f72', 'md5')
eq(md('SHA-1', 'abc'), 'a9993e364706816aba3e25717850c26c9cd0d89d', 'sha1')
eq(md('SHA-256', 'abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'sha256')
eq(md('MD5', 'a'.repeat(1000)), 'cabe45dcc9ae5b66ba86600cca6b8ba8', 'md5 long')
eq(md('SHA-256', 'a'.repeat(1000)), '41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3', 'sha256 long')
eq(md('SHA-1', 'a'.repeat(1000)), '291e9a6c66994949b57ba5e650361e98fc36b1ba', 'sha1 long')
// url, base64
eq(S('Ljava/net/URLEncoder;', 'encode(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;', ['a b&c=d/é*', 'UTF-8']), 'a+b%26c%3Dd%2F%C3%A9*', 'urlencode')
eq(S('Ljava/net/URLDecoder;', 'decode(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;', ['a+b%26%C3%A9', 'UTF-8']), 'a b&é', 'urldecode')
const raw = vm.newArray('[B', 3); raw.data.set([1, 2, 3])
eq(S('Landroid/util/Base64;', 'encodeToString([BI)Ljava/lang/String;', [raw, 2]), 'AQID', 'base64')
eq([...S('Landroid/util/Base64;', 'decode(Ljava/lang/String;I)[B', ['AQID', 0]).data], [1, 2, 3], 'base64 decode')
eq(S('Ljava/lang/Double;', 'doubleToLongBits(D)J', [1.0]), 0x3ff0000000000000n, 'double bits')
eq(S('Ljava/lang/Float;', 'intBitsToFloat(I)F', [0x3fc00000]), 1.5, 'float bits')
console.log(fails ? `${fails} FAILED` : 'ALL OK')
