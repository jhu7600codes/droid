// publishing to the danen store's community side from droid (live backend, throwaway account that is
// deleted at the end): pick test.apk (converted to a dpk), fill the form, publish, see it in the
// community tab, open it, unpublish it from "my published apps"
const B = 'https://kicqdpzodcwiuzrdriie.supabase.co/functions/v1/danen'
const call = async (p, method = 'GET', body, s) => (await fetch(B + p, { method, headers: { 'content-type': 'application/json', ...(s ? { authorization: 'Danen ' + s } : {}) }, body: body ? JSON.stringify(body) : undefined })).json()
export default async ({ page, shot, base }) => {
  page.on('console', (m) => { const t = m.text(); if (/error|fail/i.test(t) && !/favicon|GL Driver/.test(t)) console.log('console:', t.slice(0, 200)) })
  const user = 'pub' + Date.now().toString(36)
  const { session } = await call('/account/create', 'POST', { username: user, nickname: 'Publish test', password: 'test-password-123' })
  try {
    await page.goto(base + 'index.html?fastboot')
    await page.evaluate((s) => localStorage.setItem('droid.settings', JSON.stringify({ 'setup.done': true, 'lock.type': 'none', 'danen.session': s })), session)
    await page.reload(); await page.waitForTimeout(2500)
    await page.evaluate(() => window.droid_shell.wm.start({ action: 'main', package: 'droid.store' }))
    await page.waitForTimeout(2500)
    await page.click('.window.visible .h-tab:has-text("Community")'); await page.waitForTimeout(800)
    await shot('pub-01-community-empty')
    await page.click('.window.visible .st-community .h-btn'); await page.waitForTimeout(800)
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('.window.visible .h-btn:has-text("Choose a package")')])
    await chooser.setFiles('dist/apk-test/test.apk')
    await page.waitForSelector('.window.visible .st-form textarea', { timeout: 30000 })
    await page.fill('.window.visible .st-form textarea', 'A small test app: JNI, OpenGL and touch.')
    await shot('pub-02-form')
    await page.click('.window.visible .st-form .h-btn:has-text("Publish")')
    await page.waitForTimeout(6000)
    await page.click('.window.visible .h-tab:has-text("Community")').catch(() => {}); await page.waitForTimeout(1500)
    await shot('pub-03-listed')
    const listed = await page.locator('.window.visible .st-card').count()
    console.log('community cards:', listed)
    if (listed) { await page.locator('.window.visible .st-card').first().click(); await page.waitForTimeout(1200); await shot('pub-04-listing') }
    const live = (await call('/store/apps')).apps.filter((a) => a.author === 'Publish test')
    console.log('live listing:', live.map((a) => `${a.id} ${a.version} ${a.category} converted=${a.converted} icon=${!!a.icon}`).join(', ') || 'none')
  } finally {
    await call('/account/delete', 'POST', undefined, session)
    console.log('account deleted; still listed:', (await call('/store/apps')).apps.some((a) => a.author === 'Publish test'))
  }
}
