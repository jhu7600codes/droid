// milestone 5: a local test site behind the real proxy (test-only loopback flag), opened in the browser app
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
export default async ({ page, shot, base }) => {
  const site = createServer((req, res) => {
    if (req.url === '/style.css') { res.writeHead(200, { 'content-type': 'text/css' }); return res.end('body{background:#e8f4fa;font-family:sans-serif} h1{color:#0099cc} .logo{width:96px;height:96px;background:url(/logo.svg) center/contain no-repeat}') }
    if (req.url === '/logo.svg') { res.writeHead(200, { 'content-type': 'image/svg+xml' }); return res.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5" fill="#ffbb33"/></svg>') }
    if (req.url === '/two') { res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'seen=1' }); return res.end('<html><head><title>Page two</title><link rel=stylesheet href="/style.css"></head><body><h1>Page two</h1><p id=c></p><script>fetch("/api").then(r=>r.text()).then(t=>document.getElementById("c").textContent="api says: "+t)</script></body></html>') }
    if (req.url === '/api') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('cookie=' + (req.headers.cookie || 'none')) }
    res.writeHead(200, { 'content-type': 'text/html', 'x-frame-options': 'DENY' })
    res.end('<html><head><title>Test site</title><link rel=stylesheet href="/style.css"></head><body><h1>Hello through the droid proxy</h1><div class=logo></div><p>This page sends X-Frame-Options: DENY, the proxy strips it.</p><a id=next href="/two">go to page two</a></body></html>')
  }).listen(0)
  const sitePort = site.address().port
  const proxy = spawn(process.execPath, ['proxy/server.mjs'], { env: { ...process.env, PORT: '8798', DATA_DIR: '/tmp/claude-0/droidproxy-e2e', NODE_ENV: 'test', DANGER_ALLOW_LOOPBACK_FOR_TESTS: '1', ALLOW_PORTS: `80,443,${sitePort}` }, stdio: 'inherit' })
  await new Promise((r) => setTimeout(r, 800))
  const { token } = await (await fetch('http://127.0.0.1:8798/register', { method: 'POST' })).json()
  await page.goto(base + 'index.html?fastboot')
  await page.evaluate(([t]) => localStorage.setItem('droid.settings', JSON.stringify({ 'setup.done': true, 'lock.type': 'none', 'proxy.url': 'http://127.0.0.1:8798', 'proxy.token': t })), [token])
  await page.reload()
  await page.waitForTimeout(2500)
  await page.evaluate((u) => { window.droid_shell.wm.start({ action: 'view', data: u }) }, `http://127.0.0.1:${sitePort}/`)
  await page.waitForTimeout(2500)
  await shot('m5-01-page')
  await page.frameLocator('.br-frame.on').locator('#next').click()
  await page.waitForTimeout(2000)
  await shot('m5-02-page-two')
  await page.click('.br-tabs')
  await shot('m5-03-tabs')
  await page.evaluate(() => window.droid_shell.wm.back())
  await page.click('.br-bar .br-btn:last-child')
  await shot('m5-04-menu')
  proxy.kill(); site.close()
}
