// deno proxy self test (offline: auth, ssrf, sessions). run: deno test -A --unstable-kv proxy/deno/test.ts
import { handler } from './main.ts'
const ok = (c: boolean, m: string) => { if (!c) throw new Error(m) }
const call = (path: string, init: RequestInit = {}) => handler(new Request('http://proxy' + path, init))
Deno.test('health, auth, ssrf, sessions', async () => {
  ok((await call('/health')).status === 200, 'health')
  ok((await call('/fetch?url=https://example.com')).status === 401, 'needs token')
  const { token } = await (await call('/register', { method: 'POST' })).json()
  ok(!!token, 'token')
  for (const u of ['http://127.0.0.1/', 'http://169.254.169.254/latest', 'http://[::1]/', 'http://localhost:80/', 'http://10.0.0.1/', 'file:///etc/passwd', 'http://a.com:22/']) {
    const r = await call('/fetch?url=' + encodeURIComponent(u), { headers: { 'x-droid-token': token } })
    ok(r.status === 403, `blocked ${u}: ${r.status}`)
    await r.body?.cancel()
  }
  const { sid } = await (await call('/session', { method: 'POST', headers: { 'x-droid-token': token } })).json()
  ok(!!sid, 'session')
  const page = await call(`/p/${sid}/http/192.168.1.1/`)
  ok((await page.text()).includes('not allowed'), 'page ssrf')
})
