// iphone emulation with fake safe-area insets (47 top, 34 bottom) against the local preview
import { createRequire } from 'node:module'
const { chromium, devices } = createRequire(import.meta.url)('playwright')
const b = await chromium.launch()
const ctx = await b.newContext({ ...devices['iPhone 13'] })
await ctx.addInitScript(() => {
  const gcs = window.getComputedStyle
  window.getComputedStyle = function (el, ...r) {
    const cs = gcs.call(this, el, ...r)
    if (el.style && el.style.cssText.includes('safe-area-inset')) return { paddingTop: '47px', paddingBottom: '34px', paddingLeft: '0px', paddingRight: '0px' }
    return cs
  }
  localStorage.setItem('droid.settings', JSON.stringify({ 'setup.done': true, 'lock.type': 'none' }))
})
const page = await ctx.newPage()
await page.goto('http://localhost:4173/index.html?fastboot')
await page.waitForTimeout(5000)
await page.screenshot({ path: process.argv[2] })
await b.close()
