// system update flow: load build 1, deploy build 2, the notification shows, settings restarts into it
import { createRequire } from 'node:module'
import { execSync } from 'node:child_process'
const { chromium } = createRequire(import.meta.url)('playwright')
const b = await chromium.launch(); const ctx = await b.newContext(); const page = await ctx.newPage()
const base = 'http://localhost:4173/'
const build = () => page.evaluate(() => window.droid_shell && document.querySelector('script[type=module]')?.src)
await page.goto(base + 'index.html?fastboot&sw')
await page.evaluate(() => localStorage.setItem('droid.settings', JSON.stringify({ 'setup.done': true, 'lock.type': 'none' })))
await page.reload(); await page.waitForTimeout(4000)
console.log('v1', await build())
execSync('npm run build', { cwd: '/home/user/droid', stdio: 'ignore' })
await page.waitForTimeout(8000) // the boot check runs at 10s
console.log('ready', await page.evaluate(() => window.droid_shell.settings.get('ota.ready')), 'notif', await page.locator('.sb-ticker').count())
await page.evaluate(() => window.droid_shell.wm.start({ action: 'system-update' }))
await page.waitForTimeout(1500)
await page.screenshot({ path: process.argv[2] + '/ota-1.png' })
await page.locator('.window.visible .upd .h-btn').click()
await page.waitForTimeout(6000)
console.log('v2', await build(), 'ready', await page.evaluate(() => window.droid_shell?.settings.get('ota.ready')), page.url())
await page.screenshot({ path: process.argv[2] + '/ota-2.png' })
await b.close()
