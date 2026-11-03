// proxy self test: auth, ssrf blocks, rewriting. run: npm test (in proxy/)
import assert from 'node:assert/strict'
import { rewriteHtml, rewriteCss, toProxy, fromProxy } from './rewrite.mjs'
import { checkUrl, isBlockedIp } from './guard.mjs'

process.env.PORT = '0'
const sid = 'abc'
assert.equal(toProxy('/x.css', 'https://a.com/b/c.html', sid), '/p/abc/https/a.com/x.css')
assert.equal(toProxy('https://cdn.b.org/y.js?v=1', 'https://a.com/', sid), '/p/abc/https/cdn.b.org/y.js?v=1')
assert.equal(toProxy('#top', 'https://a.com/', sid), '#top')
assert.deepEqual(fromProxy('/p/abc/https/a.com/x?y=1'), { sid: 'abc', url: 'https://a.com/x?y=1' })
const html = rewriteHtml('<html><head><meta http-equiv="Content-Security-Policy" content="x"></head><body><a href="/about">a</a><img src="https://i.com/p.png" srcset="/a.png 1x, /b.png 2x"><div style="background:url(/bg.png)"></div></body></html>', 'https://a.com/', sid, '/*shim*/')
assert.ok(!html.includes('Content-Security-Policy'))
assert.ok(html.includes('href="/p/abc/https/a.com/about"'))
assert.ok(html.includes('src="/p/abc/https/i.com/p.png"'))
assert.ok(html.includes('/p/abc/https/a.com/b.png 2x'))
assert.ok(html.includes('url(/p/abc/https/a.com/bg.png)'))
assert.ok(html.includes('<script>/*shim*/</script>'))
assert.ok(rewriteCss('@import "x.css"; a{background:url("i.png")}', 'https://a.com/s/', sid).includes('/p/abc/https/a.com/s/i.png'))
for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '169.254.169.254', '::1', 'fd00::1', '100.64.0.1', '0.0.0.0']) assert.ok(isBlockedIp(ip), ip)
assert.ok(!isBlockedIp('93.184.216.34'))
for (const u of ['http://127.0.0.1/', 'http://localhost/', 'http://[::1]/', 'file:///etc/passwd', 'http://a.com:22/', 'http://169.254.169.254/latest', 'http://user:pw@a.com/']) assert.ok(checkUrl(u), u)
assert.equal(checkUrl('https://example.com/'), null)

// live server: auth and blocked targets
process.env.DATA_DIR = (await import('node:os')).tmpdir() + '/droid-proxy-test-' + process.pid
const { default: server } = await import('./server.mjs')
await new Promise((ok) => server.once('listening', ok))
const base = `http://127.0.0.1:${server.address().port}`
assert.equal((await fetch(base + '/health')).status, 200)
assert.equal((await fetch(base + '/fetch?url=https://example.com')).status, 401)
const { token } = await (await fetch(base + '/register', { method: 'POST' })).json()
assert.ok(token)
const blocked = await fetch(base + '/fetch?url=' + encodeURIComponent('http://127.0.0.1:' + server.address().port + '/health'), { headers: { 'x-droid-token': token } })
assert.equal(blocked.status, 403)
const meta = await fetch(base + '/fetch?url=' + encodeURIComponent('http://169.254.169.254/'), { headers: { 'x-droid-token': token } })
assert.equal(meta.status, 403)
const s = await (await fetch(base + '/session', { method: 'POST', headers: { 'x-droid-token': token }, body: '{"app":"t","tab":"1"}' })).json()
assert.ok(s.sid)
const page = await fetch(`${base}/p/${s.sid}/http/10.0.0.1/`)
assert.ok((await page.text()).includes('not allowed'))
console.log('proxy tests passed')
server.close()
process.exit(0)
