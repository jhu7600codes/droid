// real networking for converted apps: java.net.URL / HttpURLConnection (and HttpsURLConnection),
// apache's DefaultHttpClient and AndroidHttpClient go out through droid.net.fetch (the shell sends
// them directly when the site allows it, else through the droid proxy, which also gets plain http
// and odd ports past an https page). a request runs on the calling java thread: the thread blocks
// until the answer is in, other threads keep running. on the ui thread it is
// NetworkOnMainThreadException, as on android (api 11+).
import { VM, JObject, JArray, type NativeFn } from './dalvik.ts'
import { Block, scheduler } from './threads.ts'
import { jstr } from './java.ts'

const OBJ = 'Ljava/lang/Object;'
interface Answer { status: number; message: string; headers: [string, string][]; body: Uint8Array; url: string }

export function registerHttp(vm: VM, droid: any, uiThread: () => boolean) {
  const def = (name: string, sup: string, methods: Record<string, NativeFn>, extra: { interfaces?: string[]; statics?: Record<string, any> } = {}) => {
    const old = vm.shims.get(name)
    vm.shim(name, { super: old?.super ?? sup, interfaces: [...(old?.interfaces || []), ...(extra.interfaces || [])], methods: { ...(old?.methods || {}), ...methods }, statics: { ...(old?.statics || {}), ...(extra.statics || {}) } })
  }
  const obj = (cls: string, f: Record<string, any> = {}) => { const o = new JObject(vm.cls(cls)); Object.assign(o.f, f); return o }
  const noop: NativeFn = () => {}
  const text = (x: any) => (x == null ? '' : jstr(vm, x))
  const ex = (cls: string, msg: string) => vm.error(cls, msg)
  const byteArray = (u: Uint8Array) => { const r = vm.newArray('[B', u.length); (r.data as Int8Array).set(new Int8Array(u.buffer, u.byteOffset, u.length)); return r }
  const inStream = (u: Uint8Array) => vm.newObject('Ljava/io/ByteArrayInputStream;', '<init>([B)V', [byteArray(u)])
  for (const e of ['Landroid/os/NetworkOnMainThreadException;']) if (!vm.shims.has(e)) vm.shim(e, { super: 'Ljava/lang/RuntimeException;', methods: { '<init>()V': noop } })
  for (const e of ['Ljava/net/ProtocolException;', 'Ljava/net/UnknownHostException;', 'Ljava/net/ConnectException;', 'Ljava/net/SocketTimeoutException;', 'Ljava/io/FileNotFoundException;'])
    if (!vm.shims.has(e)) vm.shim(e, { super: 'Ljava/io/IOException;', methods: { '<init>(Ljava/lang/String;)V': (v, s, [m]) => { s.f.message = m }, '<init>()V': noop } })

  // start a request; the calling thread waits for it (a Block), its value is the answer or an exception
  const request = (url: string, method: string, headers: Record<string, string>, body: Uint8Array | null, timeoutMs: number): Answer => {
    if (uiThread()) throw ex('Landroid/os/NetworkOnMainThreadException;', 'network on the main thread')
    let done = false, answer: Answer | null = null, failure: string | null = null
    const init: any = { method, headers }
    if (body && method !== 'GET' && method !== 'HEAD') init.body = body.slice().buffer
    const timer = timeoutMs > 0 ? setTimeout(() => { if (!done) { done = true; failure = 'timeout'; scheduler.wake() } }, timeoutMs) : null
    Promise.resolve().then(() => droid.net.fetch(url, init)).then(async (r: Response) => {
      const b = new Uint8Array(await r.arrayBuffer())
      const hs: [string, string][] = []
      r.headers.forEach((v, k) => { if (k !== 'content-encoding' && k !== 'content-length') hs.push([k, v]) })
      hs.push(['content-length', String(b.length)])
      answer = { status: r.status, message: r.statusText || reason(r.status), headers: hs, body: b, url }
    }).catch((e: any) => { failure = e?.message || String(e) }).finally(() => { if (timer) clearTimeout(timer); done = true; scheduler.wake() })
    throw new Block(() => done, Infinity, 'network').then(() => {
      if (answer) return answer
      const host = (() => { try { return new URL(url).hostname } catch { return url } })()
      if (failure === 'timeout') throw ex('Ljava/net/SocketTimeoutException;', `failed to connect to ${host} (timeout)`)
      if (/denied/i.test(failure || '')) throw ex('Ljava/net/ConnectException;', `failed to connect to ${host}: ${failure}`)
      throw ex('Ljava/net/UnknownHostException;', `Unable to resolve host "${host}": ${failure || 'No address associated with hostname'}`)
    })
  }
  const reason = (n: number) => ({ 200: 'OK', 201: 'Created', 204: 'No Content', 206: 'Partial Content', 301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 429: 'Too Many Requests', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable' } as Record<number, string>)[n] || ''

  // ---------- URLConnection ----------
  // the request runs the first time anything needs the answer; the Block re-runs the same native
  // (the interpreter calls it again after the wait), so the answer is cached on the connection
  // the first native that needs the answer starts the request and waits (a Block); when the answer
  // is in, the Block's finish computes that native's own return value from it
  const start = (s: JObject): Answer => {
    const out: JObject | null = s.f.out
    const body = out ? new Uint8Array((vm.callVirtual(out, 'toByteArray()[B') as JArray).data as Int8Array) : null
    const method = s.f.method ?? (out ? 'POST' : 'GET')
    const hdrs: Record<string, string> = {}
    for (const [k, v] of s.f.headers as Map<string, string>) hdrs[k] = v
    if (body && !Object.keys(hdrs).some((k) => k.toLowerCase() === 'content-type')) hdrs['Content-Type'] = 'application/x-www-form-urlencoded'
    return request(s.f.url.f.url, method, hdrs, body, (s.f.connectTimeout || 0) + (s.f.readTimeout || 0) || 60000)
  }
  const need = <T>(s: JObject, f: (a: Answer) => T): T => {
    if (s.f.answer) return f(s.f.answer)
    if (s.f.failed) throw s.f.failed
    try { s.f.answer = start(s); return f(s.f.answer) }
    catch (e) {
      if (!(e instanceof Block)) throw e
      const fin = e.finish
      e.finish = () => { try { s.f.answer = fin() } catch (er) { s.f.failed = er; throw er } return f(s.f.answer) }
      throw e
    }
  }
  const header = (a: Answer, k: string) => { const l = k.toLowerCase(); const hit = a.headers.filter(([x]) => x === l).map(([, v]) => v); return hit.length ? hit.join(l === 'set-cookie' ? '\n' : ', ') : null }
  const headerMap = (a: Answer) => {
    const m = vm.newObject('Ljava/util/LinkedHashMap;')
    const keys = [...new Set(a.headers.map(([k]) => k))]
    const statusList = vm.newObject('Ljava/util/ArrayList;'); vm.callVirtual(statusList, 'add(Ljava/lang/Object;)Z', [`HTTP/1.1 ${a.status} ${a.message}`])
    vm.callVirtual(m, 'put(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;', [null, statusList])
    for (const k of keys) { const l = vm.newObject('Ljava/util/ArrayList;'); for (const [x, v] of a.headers) if (x === k) vm.callVirtual(l, 'add(Ljava/lang/Object;)Z', [v]); vm.callVirtual(m, 'put(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;', [k, l]) }
    return m
  }
  const conn: Record<string, NativeFn> = {
    'connect()V': (v, s) => need(s, () => undefined),
    'getInputStream()Ljava/io/InputStream;': (v, s) => need(s, (a) => { if (a.status >= 400) throw ex('Ljava/io/FileNotFoundException;', s.f.url.f.url); return inStream(a.body) }),
    'getErrorStream()Ljava/io/InputStream;': (v, s) => { const a = s.f.answer as Answer | undefined; return a && a.status >= 400 ? inStream(a.body) : null },
    'getOutputStream()Ljava/io/OutputStream;': (v, s) => (s.f.out ??= vm.newObject('Ljava/io/ByteArrayOutputStream;')),
    'getResponseCode()I': (v, s) => need(s, (a) => a.status),
    'getResponseMessage()Ljava/lang/String;': (v, s) => need(s, (a) => a.message),
    'getContentLength()I': (v, s) => need(s, (a) => a.body.length),
    'getContentLengthLong()J': (v, s) => need(s, (a) => BigInt(a.body.length)),
    'getContentType()Ljava/lang/String;': (v, s) => need(s, (a) => header(a, 'content-type')),
    'getContentEncoding()Ljava/lang/String;': () => null,
    'getContent()Ljava/lang/Object;': (v, s) => need(s, (a) => inStream(a.body)),
    'getDate()J': (v, s) => need(s, (a) => BigInt(Date.parse(header(a, 'date') || '') || 0)),
    'getLastModified()J': (v, s) => need(s, (a) => BigInt(Date.parse(header(a, 'last-modified') || '') || 0)),
    'getExpiration()J': () => 0n,
    'getHeaderField(Ljava/lang/String;)Ljava/lang/String;': (v, s, [k]) => need(s, (a) => (k == null ? `HTTP/1.1 ${a.status} ${a.message}` : header(a, text(k)))),
    'getHeaderField(I)Ljava/lang/String;': (v, s, [i]) => need(s, (a) => (i === 0 ? `HTTP/1.1 ${a.status} ${a.message}` : a.headers[i - 1]?.[1] ?? null)),
    'getHeaderFieldKey(I)Ljava/lang/String;': (v, s, [i]) => need(s, (a) => (i === 0 ? null : a.headers[i - 1]?.[0] ?? null)),
    'getHeaderFieldInt(Ljava/lang/String;I)I': (v, s, [k, d]) => need(s, (a) => { const x = parseInt(header(a, text(k)) || ''); return isNaN(x) ? d : x }),
    'getHeaderFieldDate(Ljava/lang/String;J)J': (v, s, [k, d]) => need(s, (a) => { const x = Date.parse(header(a, text(k)) || ''); return isNaN(x) ? d : BigInt(x) }),
    'getHeaderFields()Ljava/util/Map;': (v, s) => need(s, (a) => headerMap(a)),
    'getRequestProperties()Ljava/util/Map;': (v, s) => { const m = vm.newObject('Ljava/util/HashMap;'); for (const [k, x] of s.f.headers) { const l = vm.newObject('Ljava/util/ArrayList;'); vm.callVirtual(l, 'add(Ljava/lang/Object;)Z', [x]); vm.callVirtual(m, 'put(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;', [k, l]) } return m },
    'getURL()Ljava/net/URL;': (v, s) => s.f.url,
    'setRequestProperty(Ljava/lang/String;Ljava/lang/String;)V': (v, s, [k, x]) => { s.f.headers.set(text(k), text(x)) },
    'addRequestProperty(Ljava/lang/String;Ljava/lang/String;)V': (v, s, [k, x]) => { const p = s.f.headers.get(text(k)); s.f.headers.set(text(k), p ? p + ', ' + text(x) : text(x)) },
    'getRequestProperty(Ljava/lang/String;)Ljava/lang/String;': (v, s, [k]) => s.f.headers.get(text(k)) ?? null,
    'setRequestMethod(Ljava/lang/String;)V': (v, s, [m]) => { const x = text(m).toUpperCase(); if (!['GET', 'POST', 'HEAD', 'OPTIONS', 'PUT', 'DELETE', 'TRACE', 'PATCH'].includes(x)) throw ex('Ljava/net/ProtocolException;', 'Unknown method ' + x); s.f.method = x },
    'getRequestMethod()Ljava/lang/String;': (v, s) => s.f.method ?? 'GET',
    'setDoOutput(Z)V': (v, s, [x]) => { s.f.doOutput = !!x; if (x && !s.f.method) s.f.method = 'POST' }, 'getDoOutput()Z': (v, s) => (s.f.doOutput ? 1 : 0),
    'setDoInput(Z)V': noop, 'getDoInput()Z': () => 1, 'setUseCaches(Z)V': noop, 'getUseCaches()Z': () => 0, 'setDefaultUseCaches(Z)V': noop, 'setIfModifiedSince(J)V': noop,
    'setConnectTimeout(I)V': (v, s, [x]) => { s.f.connectTimeout = x }, 'getConnectTimeout()I': (v, s) => s.f.connectTimeout ?? 0,
    'setReadTimeout(I)V': (v, s, [x]) => { s.f.readTimeout = x }, 'getReadTimeout()I': (v, s) => s.f.readTimeout ?? 0,
    'setInstanceFollowRedirects(Z)V': noop, 'getInstanceFollowRedirects()Z': () => 1, 'setChunkedStreamingMode(I)V': noop, 'setFixedLengthStreamingMode(I)V': noop, 'setFixedLengthStreamingMode(J)V': noop, 'setAllowUserInteraction(Z)V': noop,
    'usingProxy()Z': () => 0, 'disconnect()V': noop,
    'toString()Ljava/lang/String;': (v, s) => `${s.cls.name.slice(1, -1).replace(/\//g, '.')}:${s.f.url.f.url}`,
  }
  def('Ljava/net/URLConnection;', OBJ, conn)
  def('Ljava/net/HttpURLConnection;', 'Ljava/net/URLConnection;', {}, { statics: { HTTP_OK: 200, HTTP_CREATED: 201, HTTP_ACCEPTED: 202, HTTP_NO_CONTENT: 204, HTTP_PARTIAL: 206, HTTP_MOVED_PERM: 301, HTTP_MOVED_TEMP: 302, HTTP_SEE_OTHER: 303, HTTP_NOT_MODIFIED: 304, HTTP_BAD_REQUEST: 400, HTTP_UNAUTHORIZED: 401, HTTP_FORBIDDEN: 403, HTTP_NOT_FOUND: 404, HTTP_CLIENT_TIMEOUT: 408, HTTP_INTERNAL_ERROR: 500, HTTP_BAD_GATEWAY: 502, HTTP_UNAVAILABLE: 503, HTTP_GATEWAY_TIMEOUT: 504 } })
  def('Ljavax/net/ssl/HttpsURLConnection;', 'Ljava/net/HttpURLConnection;', {
    'setSSLSocketFactory(Ljavax/net/ssl/SSLSocketFactory;)V': noop, 'setHostnameVerifier(Ljavax/net/ssl/HostnameVerifier;)V': noop,
    'getCipherSuite()Ljava/lang/String;': () => 'TLS_AES_128_GCM_SHA256',
  })
  const open = (s: JObject) => {
    const c = obj(s.f.protocol === 'https' ? 'Ljavax/net/ssl/HttpsURLConnection;' : 'Ljava/net/HttpURLConnection;', { url: s, host: s.f.host, headers: new Map<string, string>() })
    c.f.headers.set('User-Agent', `Dalvik/1.6.0 (Linux; U; Android 4.4.4; Droid Build/KTU84Q)`)
    return c
  }
  def('Ljava/net/URL;', OBJ, {
    'openConnection()Ljava/net/URLConnection;': (v, s) => { if (s.f.protocol !== 'http' && s.f.protocol !== 'https') throw ex('Ljava/net/MalformedURLException;', 'unknown protocol: ' + s.f.protocol); return (s.f.lastConn = open(s)) },
    'openConnection(Ljava/net/Proxy;)Ljava/net/URLConnection;': (v, s) => (s.f.lastConn = open(s)),
    'openStream()Ljava/io/InputStream;': (v, s) => need(open(s), (a) => { if (a.status >= 400) throw ex('Ljava/io/FileNotFoundException;', s.f.url); return inStream(a.body) }),
  })

  // ---------- apache http client ----------
  const AH = 'Lorg/apache/http/'
  const execute: NativeFn = (v, s, [req, second]) => {
    const u = vm.newObject('Ljava/net/URL;', '<init>(Ljava/lang/String;)V', [String(req.f.uri ?? '')])
    const c = open(u)
    c.f.method = text(vm.callVirtual(req, 'getMethod()Ljava/lang/String;'))
    for (const [k, x] of (req.f.headers || [])) c.f.headers.set(k, x)
    if (req.f.entity?.f.body) { const o = vm.newObject('Ljava/io/ByteArrayOutputStream;'); vm.callVirtual(o, 'write([B)V', [byteArray(req.f.entity.f.body)]); c.f.out = o; if (req.f.entity.f.type && !c.f.headers.has('Content-Type')) c.f.headers.set('Content-Type', req.f.entity.f.type) }
    return need(c, (a) => {
      const resp = obj(AH + 'message/BasicHttpResponse;', { a, entity: obj(AH + 'entity/ByteArrayEntity;', { body: a.body, type: header(a, 'content-type') }) })
      if (second instanceof JObject && vm.instanceOf(second, vm.cls(AH + 'client/ResponseHandler;'))) return vm.callVirtual(second, 'handleResponse(Lorg/apache/http/HttpResponse;)Ljava/lang/Object;', [resp])
      return resp
    })
  }
  for (const c of [AH + 'impl/client/AbstractHttpClient;', AH + 'impl/client/DefaultHttpClient;', 'Landroid/net/http/AndroidHttpClient;'])
    def(c, OBJ, {
      'execute(Lorg/apache/http/client/methods/HttpUriRequest;)Lorg/apache/http/HttpResponse;': execute,
      'execute(Lorg/apache/http/client/methods/HttpUriRequest;Lorg/apache/http/protocol/HttpContext;)Lorg/apache/http/HttpResponse;': execute,
      'execute(Lorg/apache/http/client/methods/HttpUriRequest;Lorg/apache/http/client/ResponseHandler;)Ljava/lang/Object;': execute,
    })
  const reqHeaders: Record<string, NativeFn> = {
    'addHeader(Ljava/lang/String;Ljava/lang/String;)V': (v, s, [k, x]) => { (s.f.headers ||= new Map()).set(text(k), text(x)) },
    'setHeader(Ljava/lang/String;Ljava/lang/String;)V': (v, s, [k, x]) => { (s.f.headers ||= new Map()).set(text(k), text(x)) },
    'addHeader(Lorg/apache/http/Header;)V': (v, s, [h]) => { (s.f.headers ||= new Map()).set(text(h.f.name), text(h.f.value)) },
    'setHeader(Lorg/apache/http/Header;)V': (v, s, [h]) => { (s.f.headers ||= new Map()).set(text(h.f.name), text(h.f.value)) },
    'setEntity(Lorg/apache/http/HttpEntity;)V': (v, s, [e]) => { s.f.entity = e },
    'getEntity()Lorg/apache/http/HttpEntity;': (v, s) => s.f.entity ?? null,
  }
  for (const c of ['HttpRequestBase', 'HttpEntityEnclosingRequestBase', 'HttpGet', 'HttpPost', 'HttpPut', 'HttpDelete', 'HttpHead']) def(`${AH}client/methods/${c};`, OBJ, reqHeaders)
  def(AH + 'entity/AbstractHttpEntity;', OBJ, { 'setContentType(Ljava/lang/String;)V': (v, s, [t]) => { s.f.type = text(t) }, 'getContentType()Lorg/apache/http/Header;': (v, s) => (s.f.type ? obj(AH + 'message/BasicHeader;', { name: 'Content-Type', value: s.f.type }) : null) })
  const hdrs = (a: Answer) => { const arr = vm.newArray('[Lorg/apache/http/Header;', a.headers.length); a.headers.forEach(([k, x], i) => (arr.data[i] = obj(AH + 'message/BasicHeader;', { name: k, value: x }))); return arr }
  def(AH + 'message/BasicHttpResponse;', OBJ, {
    'getStatusLine()Lorg/apache/http/StatusLine;': (v, s) => obj(AH + 'message/BasicStatusLine;', { a: s.f.a }),
    'getEntity()Lorg/apache/http/HttpEntity;': (v, s) => s.f.entity,
    'getFirstHeader(Ljava/lang/String;)Lorg/apache/http/Header;': (v, s, [k]) => { const x = header(s.f.a, text(k)); return x == null ? null : obj(AH + 'message/BasicHeader;', { name: text(k), value: x.split(', ')[0] }) },
    'getLastHeader(Ljava/lang/String;)Lorg/apache/http/Header;': (v, s, [k]) => { const x = header(s.f.a, text(k)); return x == null ? null : obj(AH + 'message/BasicHeader;', { name: text(k), value: x }) },
    'getHeaders(Ljava/lang/String;)[Lorg/apache/http/Header;': (v, s, [k]) => hdrs({ ...s.f.a, headers: s.f.a.headers.filter(([x]: [string]) => x === text(k).toLowerCase()) }),
    'getAllHeaders()[Lorg/apache/http/Header;': (v, s) => hdrs(s.f.a),
    'containsHeader(Ljava/lang/String;)Z': (v, s, [k]) => (header(s.f.a, text(k)) != null ? 1 : 0),
  }, { interfaces: [AH + 'HttpResponse;'] })
  def(AH + 'message/BasicStatusLine;', OBJ, {
    'getStatusCode()I': (v, s) => s.f.a.status, 'getReasonPhrase()Ljava/lang/String;': (v, s) => s.f.a.message,
    'toString()Ljava/lang/String;': (v, s) => `HTTP/1.1 ${s.f.a.status} ${s.f.a.message}`,
  }, { interfaces: [AH + 'StatusLine;'] })
  def(AH + 'entity/ByteArrayEntity;', AH + 'entity/AbstractHttpEntity;', {
    'getContent()Ljava/io/InputStream;': (v, s) => inStream(s.f.body ?? new Uint8Array()),
    'getContentLength()J': (v, s) => BigInt(s.f.body?.length ?? 0),
    'writeTo(Ljava/io/OutputStream;)V': (v, s, [o]) => { vm.callVirtual(o, 'write([B)V', [byteArray(s.f.body ?? new Uint8Array())]) },
    'consumeContent()V': noop, 'isStreaming()Z': () => 0, 'isRepeatable()Z': () => 1, 'isChunked()Z': () => 0,
  }, { interfaces: [AH + 'HttpEntity;'] })
  def(AH + 'message/BasicHeader;', OBJ, { 'toString()Ljava/lang/String;': (v, s) => `${s.f.name}: ${s.f.value}` })
}
