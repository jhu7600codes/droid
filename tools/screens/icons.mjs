// renders the pwa icons from assets/brand/droid-d-icon.svg (run once, output is committed)
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
const { chromium } = createRequire(import.meta.url)('playwright')
const svg = readFileSync('assets/brand/droid-d-icon.svg', 'utf8')
const b = await chromium.launch()
for (const s of [192, 512]) {
  const p = await b.newPage({ viewport: { width: s, height: s } })
  await p.setContent(`<body style="margin:0;background:#000;display:flex;align-items:center;justify-content:center;height:100vh"><div style="width:72%;height:72%">${svg.replace('<svg', '<svg width="100%" height="100%"')}</div></body>`)
  await p.screenshot({ path: `public/icons/icon-${s}.png` })
}
await b.close()
