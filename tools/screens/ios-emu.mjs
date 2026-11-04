// load the live site with iPhone / iPad emulation (chromium engine, so only UA, size, DPR and touch)
import { createRequire } from 'node:module'
const { chromium, devices } = createRequire(import.meta.url)('playwright')
const url = process.argv[2] || 'https://jhu7600codes.github.io/droid/'
const out = process.argv[3] || '.'
const b = await chromium.launch()
for (const name of ['iPhone 13', 'iPad (gen 7)']) {
  const ctx = await b.newContext({ ...devices[name] })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.log(name, 'pageerror', e.message))
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(name, m.type(), m.text().slice(0, 200)) })
  await page.goto(url + '?fastboot')
  await page.waitForTimeout(9000)
  await page.screenshot({ path: `${out}/${name.replace(/\W+/g, '-')}.png` })
  console.log(name, 'ok')
  await ctx.close()
}
await b.close()
