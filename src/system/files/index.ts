// files: browse shared storage, open files with the right app, import from and export to the real device.
import type { SystemApp, ActivityContext, Activity } from '../../shell/types'
import { page, pageStack } from '../../shell/appkit'
import { h, pressable, dialog, toast } from '../../shell/ui'
import { img } from '../../shell/assets'
import { shared } from '../../shell/storage'
import { mimeOf } from '../../runtime/packages'
import { openDpk } from '../../runtime'
import './files.css'

const fmt = (n: number) => (n > 1 << 20 ? (n / (1 << 20)).toFixed(1) + ' MB' : (n / 1024).toFixed(1) + ' KB')

function files(ctx: ActivityContext): Activity {
  const stack = pageStack(ctx.root)
  const folder = (el: HTMLElement, pop: () => void, dir: string) => {
    const p = page(el, { title: dir ? dir.split('/').pop()! : 'Storage', icon: img('apps/launcher3', 'ic_launcher_info_normal_holo'), up: dir ? pop : undefined })
    p.menu([
      { title: 'Import from device…', onclick: () => importFiles(dir) },
      { title: 'New folder', onclick: async () => {
        const r = await dialog({ title: 'New folder', kind: 'input', placeholder: 'Folder name' })
        if (r.button === 'ok' && r.value) { await shared.write(`${dir ? dir + '/' : ''}${r.value.toLowerCase().replace(/[^a-z0-9._-]/g, '_')}/.keep`, new Blob([])); render() }
      } },
    ])
    const list = h('ul.h-list')
    p.content.append(list)
    const render = async () => {
      list.innerHTML = ''
      const names = await shared.list(dir)
      const dirs = new Set<string>(), fls: string[] = []
      for (const n of names) n.includes('/') ? dirs.add(n.split('/')[0]) : n !== '.keep' && fls.push(n)
      if (!dir) for (const d of ['dcim', 'download', 'pictures', 'music', 'documents']) dirs.add(d)
      for (const d of [...dirs].sort()) {
        const li = pressable(h('li.h-item.small', {}, h('span.f-icon.f-dir'), h('div.lines', {}, h('span.title', {}, d))))
        li.addEventListener('click', () => stack.push((e2, pop2) => folder(e2, pop2, dir ? `${dir}/${d}` : d)))
        list.append(li, h('li.h-divider'))
      }
      for (const f of fls.sort()) {
        const path = dir ? `${dir}/${f}` : f
        const b = await shared.read(path)
        const li = pressable(h('li.h-item.small', {}, h(`span.f-icon.f-${f.split('.').pop()}`, {}, (f.split('.').pop() || '').slice(0, 4)), h('div.lines', {}, h('span.title', {}, f), h('span.summary', {}, b ? fmt(b.size) : ''))))
        li.addEventListener('click', () => openFile(path))
        li.addEventListener('contextmenu', async (e) => {
          e.preventDefault()
          const r = await dialog({ title: f, items: ['Open', 'Save to device', 'Share', 'Delete'] })
          if (r.index === 0) openFile(path)
          if (r.index === 1) exportFile(path)
          if (r.index === 2) ctx.start({ action: 'send', type: mimeOf(path), data: 'shared:' + path, extras: { path } })
          if (r.index === 3) { await shared.remove(path); render() }
        })
        list.append(li, h('li.h-divider'))
      }
      if (!dirs.size && !fls.length) list.append(h('li.f-empty', {}, 'Empty folder'))
    }
    render()
    const on = () => render()
    addEventListener('shared:changed', on)
    return () => removeEventListener('shared:changed', on)
  }

  async function openFile(path: string) {
    const b = await shared.read(path)
    if (!b) return
    if (/\.(dpk|apk)$/.test(path)) return openDpk(b)
    const type = b.type || mimeOf(path)
    if (/^text\/|json|xml/.test(type)) {
      const text = await b.text()
      dialog({ title: path.split('/').pop(), body: h('pre.f-text', {}, text.slice(0, 20000)) })
      return
    }
    ctx.start({ action: 'view', data: 'shared:' + path, type })
  }
  async function exportFile(path: string) {
    const b = await shared.read(path)
    if (!b) return
    const a = h('a', { href: URL.createObjectURL(b), download: path.split('/').pop() }) as HTMLAnchorElement
    document.body.append(a); a.click(); a.remove()
  }
  function importFiles(dir: string) {
    const i = h('input', { type: 'file', multiple: true, style: { display: 'none' } }) as HTMLInputElement
    i.addEventListener('change', async () => {
      for (const f of [...(i.files || [])]) await shared.write(`${dir || 'download'}/${f.name.toLowerCase().replace(/[^a-z0-9._-]/g, '_')}`, f)
      toast(`${i.files?.length || 0} files imported`)
      i.remove()
    })
    document.body.append(i)
    i.click()
  }

  stack.push((el, pop) => folder(el, pop, ''))
  return { back: () => stack.pop() }
}

const app: SystemApp = {
  manifest: {
    id: 'droid.files', name: 'Files', version: '4.4', versioncode: 19, type: 'web', main: 'files',
    activities: { files: { label: 'Files', launcher: true } }, system: true, permissions: ['storage'],
  },
  icon: 'assets/brand/files-icon.svg',
  activities: { files },
}
export default app
