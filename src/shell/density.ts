// density buckets (android rules) and loading the matching generated holo stylesheet.
// in droid 1 css px = 1 dp, so the bucket only decides which images we load.

export const BUCKETS = { ldpi: 120, mdpi: 160, hdpi: 240, xhdpi: 320, xxhdpi: 480 } as const
export type Bucket = keyof typeof BUCKETS
// what we ship (no ldpi assets: android scales hdpi down, we load mdpi)
const SHIPPED: Bucket[] = ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi']

// android picks the bucket at or just above the real dpi
export function bucketFor(dpi: number): Bucket {
  for (const b of SHIPPED) if (dpi <= BUCKETS[b] * 1.1) return b
  return 'xxhdpi'
}

// in the browser 1 css px is ~1 dp, so dpi ~= devicePixelRatio * 160
export const detectDpi = () => Math.round((window.devicePixelRatio || 1) * 160)

// static assets are not bundled: they are copied as-is to dist/assets (see vite.config.ts),
// so the path is relative to the page.
const ASSETS = 'assets/aosp/'

function sheet(id: string, href: string) {
  let l = document.getElementById(id) as HTMLLinkElement | null
  if (!l) {
    l = document.createElement('link')
    l.id = id
    l.rel = 'stylesheet'
    document.head.appendChild(l)
  }
  l.href = href
}

export function loadHolo(bucket: Bucket) {
  sheet('aosp-fonts', ASSETS + 'fonts/fonts.css')
  sheet('aosp-colors', ASSETS + 'css/colors.css')
  sheet('aosp-holo', `${ASSETS}css/holo-${bucket}.css`)
  document.documentElement.dataset.density = bucket
  return bucket
}

export const dpiOf = (b: Bucket) => BUCKETS[b]
export const assetUrl = (rel: string) => ASSETS + rel
