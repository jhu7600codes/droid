// local only: run ss.apk, pause the page with the debugger after unity makes its gl context, print the stack
import ss from './flow-ss.mjs'
export default async (ctx) => {
  const { page } = ctx
  const cdp = await page.context().newCDPSession(page)
  const scripts = new Map()
  cdp.on('Debugger.scriptParsed', (e) => scripts.set(e.scriptId, e.url || '(' + e.scriptId + ' len ' + e.length + ')'))
  await cdp.send('Debugger.enable')
  let n = 0
  cdp.on('Debugger.paused', async (e) => {
    if (n++ < 3) console.log('PAUSED\n' + e.callFrames.slice(0, 30).map((f) => `  ${f.functionName || '?'} ${scripts.get(f.location.scriptId)?.slice(-40)}:${f.location.lineNumber}:${f.location.columnNumber}`).join('\n'))
    await cdp.send('Debugger.resume').catch(() => {})
  })
  page.on('console', (m) => { if (/Creating OpenGL/.test(m.text())) { for (const d of [4000, 8000, 12000]) setTimeout(() => cdp.send('Debugger.pause').catch(() => {}), d) } })
  process.env.RUN_MS = '16000'
  await ss({ ...ctx, shot: async () => {} }).catch((e) => console.log('flow err', e.message.slice(0, 100)))
}
