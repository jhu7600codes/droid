// java threads in a converted kotlin app: queue, wait / notify, a spinning thread, executor, latch.
// the ui must stay responsive meanwhile (a tap on another button still works)
export default async ({ page, shot, base }) => {
  page.on('console', (m) => { if (/thread|missing|stopped|error|deadlock/i.test(m.text())) console.log('console:', m.text().slice(0, 400)) })
  await page.goto(base + 'index.html?fastboot')
  await page.evaluate(() => localStorage.setItem('droid.settings', JSON.stringify({ 'setup.done': true, 'lock.type': 'none' })))
  await page.reload(); await page.waitForTimeout(2500)
  await page.evaluate(() => { window.droid_shell.wm.start({ action: 'install', data: 'apk-test/test-kt.apk', type: 'application/vnd.android.package-archive' }) })
  await page.waitForTimeout(2500)
  await page.click('.pi-buttons .h-btn-borderless:last-child'); await page.waitForTimeout(1500)
  await page.click('.pi-buttons .h-btn-borderless:last-child'); await page.waitForTimeout(3000)
  const f = page.frameLocator('.window.visible iframe')
  await f.getByText('Run threads').click()
  const t0 = Date.now()
  await page.waitForTimeout(100)
  await f.getByText('Add a pigeon').click() // the ui answers while threads run
  console.log('ui answered after', Date.now() - t0, 'ms')
  for (let i = 0; i < 40; i++) { const t = await f.locator('#app').innerText().catch(() => ''); if (/threads ok/.test(t)) break; await page.waitForTimeout(250) }
  console.log('info:', (await f.locator('#app').innerText()).split('\n').find((l) => /threads/.test(l)))
  const fr = page.frames().find((x) => x.url().startsWith('blob:') || x.url() === 'about:srcdoc') 
  for (const x of page.frames()) { const d = await x.evaluate(() => window.__threads?.()).catch(() => null); if (d) console.log('threads:', JSON.stringify(d, null, 1)) }
  void fr
  await shot('threads-01')
}
