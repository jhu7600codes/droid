// danen account e2e against the live backend: create, settings page shows it, a network change backs up,
// the backup holds it, then the test account is deleted
export default async ({ page, shot, base }) => {
  const user = 'droidtest' + Date.now().toString(36)
  await page.goto(base + 'index.html?fastboot')
  await page.evaluate(() => localStorage.setItem('droid.settings', JSON.stringify({ 'setup.done': true, 'lock.type': 'none' })))
  await page.reload(); await page.waitForTimeout(2500)
  await page.evaluate(() => window.droid_shell.wm.start({ action: 'settings', extras: { page: 'account' } }))
  await page.waitForTimeout(1200)
  await page.locator('.window.visible').getByText('Add a Danen account').click()
  await page.waitForTimeout(1200)
  const w = page.locator('.window.visible')
  await w.getByText('Create a new account').click()
  await w.locator('input[placeholder=Nickname]').fill('Droid Test')
  await w.locator('input[placeholder=Username]').fill(user)
  await w.locator('input[placeholder=Password]').fill('pigeons-coo-123')
  await w.locator('button', { hasText: 'Create account' }).click()
  await page.waitForTimeout(6000)
  await shot('danen-01-account')
  await page.evaluate(() => { const s = window.droid_shell.settings; s.set('net.own', [{ id: 'test', name: 'DR-Nt Test', kind: 'drnt', area: { lat: 1, lon: 2, r: 100 } }]) })
  await page.waitForTimeout(9000)
  const r = await page.evaluate(async () => {
    const s = window.droid_shell.settings
    const b = s.get('danen.backend'), t = s.get('danen.session')
    const sync = await fetch(b + '/sync', { headers: { authorization: 'Danen ' + t } }).then((x) => x.json())
    return { remote: s.get('danen.account')?.remote, sync: s.get('danen.sync'), err: s.get('danen.syncError'), net: JSON.stringify(sync.items?.settings?.value?.['net.own']) }
  })
  console.log(JSON.stringify(r))
  await page.evaluate(() => window.droid_shell.wm.start({ action: 'settings', extras: { page: 'backup' } }))
  await page.waitForTimeout(1200)
  await shot('danen-02-backup')
  console.log('deleted', await page.evaluate(async () => { const s = window.droid_shell.settings; return (await fetch(s.get('danen.backend') + '/account/delete', { method: 'POST', headers: { authorization: 'Danen ' + s.get('danen.session') } })).status }))
}
