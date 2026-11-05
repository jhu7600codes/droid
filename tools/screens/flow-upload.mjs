// getting an apk into droid: the store's install button (file picker), dropping a file on the
import fs from 'node:fs'
const log = (...a) => fs.appendFileSync('/tmp/claude-0/-home-user-droid/c6f23d82-1f7c-556b-a34a-7f2d25328f99/scratchpad/up.log', a.join(' ') + '\n')
// screen, and the android share target (POST to share-target, then ?shared=1)
export default async ({ page, shot, base }) => {
  const installer = async (what) => { await page.waitForTimeout(2500); const n = await page.locator('.window.visible .pi-buttons').count(); log(what, n ? 'installer opened' : 'NO INSTALLER'); if (n) await page.click('.window.visible .pi-buttons .h-btn-borderless:first-child', { timeout: 5000 }).catch(() => log('no cancel')); await page.waitForTimeout(800) }
  await page.goto(base + 'index.html?fastboot')
  await page.evaluate(() => localStorage.setItem('droid.settings', JSON.stringify({ 'setup.done': true, 'lock.type': 'none' })))
  await page.reload(); await page.waitForTimeout(2500)
  // 1. store -> install from file
  await page.evaluate(() => window.droid_shell.wm.start({ action: 'main', package: 'droid.store' }))
  await page.waitForTimeout(2000)
  await shot('up-01-store')
  const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 8000 }), page.locator('.window.visible [title="Install from file"], .window.visible .h-actionbar [aria-label="Install from file"]').first().click()])
  await chooser.setFiles('dist/apk-test/test.apk')
  await installer('picker:')
  await shot('up-02-picked')
  log('step2')
  // 2. drop on the screen
  const bytes = [...(await (await fetch(base + 'apk-test/test.apk')).arrayBuffer().then((b) => new Uint8Array(b)))]
  await page.evaluate((b) => {
    const dt = new DataTransfer()
    dt.items.add(new File([new Uint8Array(b)], 'test.apk', { type: 'application/vnd.android.package-archive' }))
    document.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
  }, bytes)
  await installer('drop:')
  log('step3')
  // 3. share target (needs the service worker in control)
  await page.goto(base + 'index.html?fastboot&sw'); await page.waitForTimeout(2500)
  await page.evaluate(() => Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(r, 8000))]))
  await page.goto(base + 'index.html?fastboot&sw'); await page.waitForTimeout(2500)
  log('sw controller', await page.evaluate(() => !!navigator.serviceWorker.controller))
  const res = await page.evaluate(async (b) => {
    const fd = new FormData(); fd.append('file', new File([new Uint8Array(b)], 'test.apk'))
    const r = await fetch('share-target', { method: 'POST', body: fd })
    return r.url
  }, bytes)
  log('share-target went to', res.replace(base, ''))
  await page.goto(res)
  await installer('share:')
  await shot('up-03-shared')
}
