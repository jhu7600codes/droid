// package installer (kitkat style): shows the app and its permissions, then installs.
// handles 'install' (data = blob url of a .dpk) and 'uninstall' (data = package:<id>).
import type { SystemApp, ActivityContext, Activity } from '../../shell/types'
import { RESULT_OK } from '../../shell/types'
import { h, pressable, dialog, toast, progress } from '../../shell/ui'
import { listZip } from '../../runtime/zip'
import { img } from '../../shell/assets'
import { kernel } from '../../shell/kernel'
import { wm } from '../../shell/wm'
import { parseDpk, install, installKind, uninstall, mimeOf, type Parsed } from '../../runtime/packages'
import { permName } from '../../runtime/manifest'
import { permissionText } from '../../runtime/bridge'
import './installer.css'

const PI = 'apps/packageinstaller'

function shell(ctx: ActivityContext, icon: string, name: string) {
  const body = h('div.pi-body')
  const bar = h('div.pi-buttons')
  ctx.root.append(h('div.app.app-dark.pi', {}, h('div.pi-head', {}, h('img', { src: icon }), h('span', {}, name)), h('div.pi-line'), h('div.content', {}, body), bar))
  return { body, bar }
}
const btn = (label: string, fn: () => void) => pressable(h('button.h-btn-borderless', { onclick: fn }, label))

function installer(ctx: ActivityContext): Activity {
  const src = ctx.intent.data!
  ;(async () => {
    let p: Parsed
    let converted: string[] | null = null
    try {
      let buf = await (await fetch(src)).arrayBuffer()
      // an old android apk: convert it to a dpk first (spec section 10)
      if (listZip(buf).some((e) => e.path === 'AndroidManifest.xml') && !listZip(buf).some((e) => e.path === 'manifest.json')) {
        const stop = progress('Converting the APK…')
        try {
          const { convertApk } = await import('../../runtime/android/convert')
          const runtime = await (await fetch('runtime/android-runtime.js')).text()
          const r = await convertApk(buf, runtime)
          buf = r.dpk.buffer.slice(r.dpk.byteOffset, r.dpk.byteOffset + r.dpk.length) as ArrayBuffer
          converted = r.report
        } finally { stop() }
      }
      p = await parseDpk(buf)
    }
    catch (e) {
      await dialog({ title: 'Parse error', message: `There was a problem parsing the package. ${(e as Error).message}` })
      return ctx.finish()
    }
    const m = p.manifest
    const iconBytes = m.icon ? p.files.get(m.icon) : null
    const icon = iconBytes ? URL.createObjectURL(new Blob([iconBytes as BlobPart], { type: mimeOf(m.icon!) })) : 'assets/brand/default-app-icon.svg'
    const { body, bar } = shell(ctx, icon, m.name)
    const kind = await installKind(m)
    const perms = (m.permissions || []).map(permName)
    const q = { install: 'Do you want to install this application?', update: 'Do you want to install an update to this existing application? Your existing data will not be lost.', same: 'This version is already installed. Install it again?', downgrade: 'A newer version is installed. Replace it with this older version?' }[kind]
    body.append(h('div.pi-q', {}, q), h('div.pi-meta', {}, `Version ${m.version}${m.author ? ' · ' + m.author : ''} · ${(p.size / 1024).toFixed(0)} KB`))
    if (converted) body.append(h('div.pi-meta', {}, `Converted from an Android APK (${(m as any).runtime} runtime). ${converted.join('. ')}`))
    if (perms.length) {
      body.append(h('div.h-section', {}, 'It will get access to'))
      for (const pm of perms) body.append(h('div.pi-perm', {}, h('span.pi-dot'), h('span', {}, permissionText(pm))))
    } else body.append(h('div.pi-meta', {}, 'It does not require any special access.'))
    bar.append(btn('Cancel', () => ctx.finish()), btn(kind === 'install' ? 'Install' : 'Install', async () => {
      body.innerHTML = ''
      bar.innerHTML = ''
      body.append(h('div.pi-progress', {}, h('span.h-spin', {}, h('i')), h('span', {}, 'Installing…')))
      try {
        await install(p, { allowDowngrade: kind === 'downgrade' || kind === 'same', source: 'file' })
        body.innerHTML = ''
        body.append(h('div.pi-done', {}, h('img', { src: img(PI, 'ic_success') }), h('span', {}, 'App installed.')))
        bar.append(btn('Done', () => ctx.finish({ code: RESULT_OK })), btn('Open', () => { ctx.finish({ code: RESULT_OK }); wm.start({ package: m.id, action: 'main' }) }))
      } catch (e) {
        body.innerHTML = ''
        body.append(h('div.pi-q', {}, 'App not installed. ' + (e as Error).message))
        bar.append(btn('Done', () => ctx.finish()))
      }
    }))
  })()
  return {}
}

function uninstaller(ctx: ActivityContext): Activity {
  const id = (ctx.intent.data || '').replace(/^package:/, '')
  const app = kernel.get(id)
  ;(async () => {
    if (!app || app.system) { toast('This app can\'t be uninstalled'); return ctx.finish() }
    const r = await dialog({ title: app.manifest.name, message: 'Do you want to uninstall this app?', cancel: 'Cancel', ok: 'OK' })
    if (r.button === 'ok') {
      for (const t of [...wm.tasks]) if (t.pkg === id) wm.removeTask(t)
      await uninstall(id)
      toast('Uninstall finished.')
      ctx.finish({ code: RESULT_OK })
    } else ctx.finish()
  })()
  return {}
}

const app: SystemApp = {
  manifest: {
    id: 'droid.packageinstaller', name: 'Package installer', version: '4.4', versioncode: 19, type: 'web', main: 'install',
    activities: { install: { label: 'Package installer' }, uninstall: { label: 'Uninstall' } }, system: true,
    'intent-filters': [
      { activity: 'install', actions: ['install', 'view'], mimetypes: ['application/x-dpk', 'application/vnd.android.package-archive'] },
      { activity: 'uninstall', actions: ['uninstall'], schemes: ['package'] },
    ],
    permissions: ['system.apps'],
  },
  icon: '',
  activities: { install: installer, uninstall: uninstaller },
}
export default app
