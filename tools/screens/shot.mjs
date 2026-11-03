// screenshots of a built page at several sizes. usage: node tools/screens/shot.mjs <page> <outdir>
import { createRequire } from 'node:module'
const { chromium } = createRequire(import.meta.url)('playwright') // preinstalled globally or from devDeps
import { createServer } from 'node:http'
import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, extname } from 'node:path'

const [page = 'holo-test.html', out = 'shots'] = process.argv.slice(2)
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' }
const srv = createServer((req, res) => {
  const p = join('dist', decodeURIComponent(req.url.split('?')[0]))
  if (!existsSync(p)) { res.writeHead(404); return res.end() }
  res.writeHead(200, { 'content-type': types[extname(p)] || 'application/octet-stream' })
  res.end(readFileSync(p))
}).listen(0)
const port = srv.address().port
mkdirSync(out, { recursive: true })
const b = await chromium.launch()
for (const [w, h, dpr] of [[720, 1400, 1.5], [720, 1400, 2], [1200, 1400, 3]]) {
  const p = await b.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: dpr })
  const errs = []
  p.on('console', (m) => m.type() === 'error' && errs.push(m.text()))
  p.on('requestfailed', (r) => errs.push('failed ' + r.url()))
  p.on('response', (r) => r.status() >= 400 && errs.push(r.status() + ' ' + r.url()))
  await p.goto(`http://localhost:${port}/${page}`)
  await p.waitForTimeout(800)
  await p.screenshot({ path: `${out}/${page.replace('.html', '')}-${w}x${h}@${dpr}.png`, fullPage: true })
  console.log(w, h, dpr, errs.length ? errs : 'ok')
  await p.close()
}
await b.close(); srv.close()
