// resolves aosp images by package and name for the current density bucket.
// the index comes from assets/aosp/index.json ("pkg/name" -> "ext:bucket,bucket").
import { assetUrl, type Bucket } from './density'

const ORDER = ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi']
let index: Record<string, string> = {}
let bucket: Bucket = 'hdpi'

export async function loadIndex(b: Bucket) {
  bucket = b
  index = await fetch(assetUrl('index.json')).then((r) => r.json())
}
export const setBucket = (b: Bucket) => (bucket = b)

function pick(avail: string[]): string {
  if (avail.includes(bucket)) return bucket
  const i = ORDER.indexOf(bucket)
  for (let j = i + 1; j < ORDER.length; j++) if (avail.includes(ORDER[j])) return ORDER[j]
  for (let j = i - 1; j >= 0; j--) if (avail.includes(ORDER[j])) return ORDER[j]
  return avail[0]
}

// pkg: 'framework' | 'systemui' | 'apps/launcher3' ... ; returns '' when missing
export function img(pkg: string, name: string): string {
  const key = `${pkg}/${name}`
  const e = index[key]
  if (!e) {
    console.warn('missing image', key)
    return ''
  }
  const [ext, list] = e.split(':')
  const b = pick(list.split(','))
  // 9-patches are stored stripped as png
  return assetUrl(`${pkg}/drawable-${b}/${name}.${ext === '9' ? 'png' : ext}`)
}

export const has = (pkg: string, name: string) => !!index[`${pkg}/${name}`]

// <img> helper
export function icon(pkg: string, name: string, cls = '') {
  const i = document.createElement('img')
  i.src = img(pkg, name)
  i.draggable = false
  i.alt = ''
  if (cls) i.className = cls
  return i
}

export const brand = (name: 'droid-logo' | 'droid-d-icon') => `assets/brand/${name}.svg`
