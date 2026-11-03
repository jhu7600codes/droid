// drives the built shell through a few states and screenshots each one.
// usage: node tools/screens/flow.mjs <outdir> [width height dpr]
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { readFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'
const { chromium } = createRequire(import.meta.url)('playwright')

const [out = 'shots', W = '360', H = '640', DPR = '2'] = process.argv.slice(2)
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.dpk': 'application/x-dpk', '.wasm': 'application/wasm' }
const srv = createServer((req, res) => {
  let p = join('dist', decodeURIComponent(req.url.split('?')[0]))
  if (existsSync(p) && statSync(p).isDirectory()) p = join(p, 'index.html')
  if (!existsSync(p)) { res.writeHead(404); return res.end() }
  res.writeHead(200, { 'content-type': types[extname(p)] || 'application/octet-stream', 'access-control-allow-origin': '*' })
  res.end(readFileSync(p))
}).listen(0)
export const base = `http://localhost:${srv.address().port}/`
mkdirSync(out, { recursive: true })
const b = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] })
const ctx = await b.newContext({ viewport: { width: +W, height: +H }, deviceScaleFactor: +DPR, hasTouch: false, permissions: ['camera', 'microphone'] })
const page = await ctx.newPage()
const errs = []
page.on('console', (m) => ['error', 'warning'].includes(m.type()) && errs.push(m.type() + ': ' + m.text()))
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message))
page.on('response', (r) => r.status() >= 400 && errs.push(r.status() + ' ' + r.url()))
const shot = async (name) => { await page.waitForTimeout(500); await page.screenshot({ path: `${out}/${name}.png` }); console.log('shot', name) }
const steps = (await import(process.env.FLOW || './flow-m2.mjs')).default
await steps({ page, shot, base })
console.log(errs.length ? errs.slice(0, 30).join('\n') : 'no errors')
await b.close(); srv.close()
