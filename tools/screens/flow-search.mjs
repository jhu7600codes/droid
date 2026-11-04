// browser search through the live proxy: type in the url bar, look at the results page
export default async ({ page, shot, base }) => {
  page.on('response', (r) => { if (r.url().includes('/p/') && r.request().resourceType() === 'document') console.log('doc', r.status(), r.url().replace(/\/p\/[^/]+/, '/p/SID').slice(0, 160), r.headers()['location'] || '') })
  page.on('console', (m) => { if (m.type() === 'error') console.log('console:', m.text().slice(0, 200)) })
  await page.goto(base + 'index.html?fastboot')
  await page.evaluate(() => localStorage.setItem('droid.settings', JSON.stringify({ 'setup.done': true, 'lock.type': 'none', ime: 'device' })))
  await page.reload(); await page.waitForTimeout(2500)
  await page.evaluate(() => window.droid_shell.wm.start({ package: 'droid.browser', action: 'main' }))
  await page.waitForTimeout(2000)
  const url = page.locator('.window.visible .br-url')
  await url.click(); await url.fill('android kitkat'); await url.press('Enter')
  await page.waitForTimeout(12000)
  console.log('url now:', await url.inputValue())
  await shot('search-01')
  const f = page.frameLocator('.window.visible iframe.visible, .window.visible iframe').first()
  console.log('results:', await f.locator('article.result, .result').count().catch((e) => 'err ' + e.message))
}
