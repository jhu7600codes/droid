// converted apps get converted again when the converter is newer: install, pretend it is old, reload
export default async ({ page, shot, base }) => {
  page.on('console', (m) => { if (/reconvert/i.test(m.text())) console.log('console:', m.text().slice(0, 300)) })
  await page.goto(base + 'index.html?fastboot')
  await page.evaluate(() => localStorage.setItem('droid.settings', JSON.stringify({ 'setup.done': true, 'lock.type': 'none' })))
  await page.reload(); await page.waitForTimeout(2500)
  await page.evaluate(() => { window.droid_shell.wm.start({ action: 'install', data: 'apk-test/test-kt.apk', type: 'application/vnd.android.package-archive' }) })
  await page.waitForTimeout(2500)
  await page.click('.pi-buttons .h-btn-borderless:last-child'); await page.waitForTimeout(1500)
  await page.click('.pi-buttons .h-btn-borderless:last-child'); await page.waitForTimeout(2000)
  // make the installed record look like an old conversion
  const rec = (v) => new Promise((ok) => { const r = indexedDB.open('droid'); r.onsuccess = () => { const tx = r.result.transaction('packages', v ? 'readwrite' : 'readonly'); const st = tx.objectStore('packages'); const q = st.get('com.droid.kt'); q.onsuccess = () => { const x = q.result; if (v) { x.manifest['converted-from'].converter = 1; st.put(x, 'com.droid.kt') } ok(x.manifest['converted-from'].converter) } } })
  console.log('before:', await page.evaluate(rec, true))
  await page.reload(); await page.waitForTimeout(9000)
  console.log('after:', await page.evaluate(rec, false))
  await page.evaluate(() => window.droid_shell.wm.start({ package: 'com.droid.kt', action: 'main' }))
  await page.waitForTimeout(4000)
  console.log('app text:', (await page.frameLocator('.window.visible iframe').locator('#app').innerText()).split('\n')[0])
  await shot('reconvert-01')
}
