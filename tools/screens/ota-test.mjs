import { createRequire } from 'node:module'
const { chromium } = createRequire(import.meta.url)('playwright')
import { execSync } from 'node:child_process'
const b = await chromium.launch(); const ctx = await b.newContext(); const page = await ctx.newPage()
const base = 'http://localhost:4173/'
await page.goto(base + 'index.html?fastboot&sw')
await page.evaluate(() => localStorage.setItem('droid.settings', JSON.stringify({ 'setup.done': true, 'lock.type': 'none' })))
await page.reload(); await page.waitForTimeout(6000)
const keys = () => page.evaluate(() => caches.keys())
console.log('v1', await keys(), await page.evaluate(() => !!navigator.serviceWorker.controller))
execSync('npm run build', { cwd: '/home/user/droid', stdio: 'ignore' })
await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r.update()))
await page.waitForTimeout(6000)
console.log('ready', await page.evaluate(() => window.droid_shell.settings.get('ota.ready')), await page.locator('.sb-ticker').count())
await page.reload(); await page.waitForTimeout(8000)
console.log('v2', await keys(), 'booted', await page.evaluate(() => !!window.droid_shell), 'sw', await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL))
await page.screenshot({ path: '/tmp/claude-0/-home-user-droid/c6f23d82-1f7c-556b-a34a-7f2d25328f99/scratchpad/ota.png' })
await b.close()
