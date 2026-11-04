// search engines through a LOCAL proxy (node proxy/server.mjs on :8788): ENGINE env picks one
export default async ({ page, shot, base }) => {
  const engine = process.env.ENGINE || 'dogpile'
  page.on('response', (r) => { if (r.request().resourceType() === 'document' && /:8788/.test(r.url())) console.log('doc', r.status(), r.url().replace(/\/p\/[^/]+/, '/p/SID').slice(0, 130)) })
  page.on('response', (r) => { const t = r.request().resourceType(); if ((t === 'fetch' || t === 'xhr') ) console.log('api', r.status(), r.request().method(), r.url().replace(/\/p\/[^/]+/, '/p/SID').slice(0, 140)) })
  page.on('requestfailed', (r) => console.log('FAIL', r.failure()?.errorText, r.url().slice(0, 140)))
  page.on('response', (r) => { const t = r.request().resourceType(); if (/:8788\/p\//.test(r.url()) && !/dogpile\.com\/_next/.test(r.url())) console.log('res', r.status(), t, r.url().replace(/\/p\/[^/]+/, '/p/SID').slice(0, 140)) })
  page.on('console', (m) => { if (m.type() === 'error') console.log('console', m.text().slice(0, 160)) })
  await page.goto(base + 'index.html?fastboot')
  await page.evaluate((e) => localStorage.setItem('droid.settings', JSON.stringify({ 'setup.done': true, 'lock.type': 'none', ime: 'device', 'browser.engine': e, 'proxy.url': 'http://localhost:8788' })), engine)
  await page.reload(); await page.waitForTimeout(2500)
  await page.evaluate(() => window.droid_shell.wm.start({ package: 'droid.browser', action: 'main' }))
  await page.waitForTimeout(2000)
  const url = page.locator('.window.visible .br-url')
  await url.click(); await url.fill('android kitkat'); await url.press('Enter')
  await page.waitForTimeout(18000)
  console.log('url now:', await url.inputValue())
  await shot('local-' + engine)
}
