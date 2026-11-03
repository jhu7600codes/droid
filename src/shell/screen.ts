// screen detection (spec section 20). builds the droid screen from the browser viewport:
// size in dp, density bucket, orientation, form factor, and how it is placed in the window.
//
// native mode: the droid screen is the whole viewport (1 css px = 1 dp, display size scales it).
// fit mode: a fixed resolution scaled into the window with black bars.
import { settings } from './settings'
import { bucketFor, BUCKETS, type Bucket } from './density'

export const PRESETS: Record<string, { label: string; w: number; h: number; dpi: number }> = {
  'phone-hdpi': { label: '480 x 800 hdpi', w: 480, h: 800, dpi: 240 },
  'phone-xhdpi': { label: '720 x 1280 xhdpi', w: 720, h: 1280, dpi: 320 },
  'phone-xxhdpi': { label: '1080 x 1920 xxhdpi', w: 1080, h: 1920, dpi: 480 },
  'tablet-mdpi': { label: '1280 x 800 tablet mdpi', w: 1280, h: 800, dpi: 160 },
  'tablet-xhdpi': { label: '2560 x 1600 tablet xhdpi', w: 2560, h: 1600, dpi: 320 },
}

export type Form = 'phone' | 'tablet' | 'desktop'
export interface ScreenInfo {
  width: number // dp, whole screen
  height: number
  dpi: number
  bucket: Bucket
  density: number // dpi / 160
  orientation: 'portrait' | 'landscape'
  form: Form
  mode: 'native' | 'fit'
  scale: number // css transform from dp to viewport px
  offsetX: number
  offsetY: number
  insets: { top: number; right: number; bottom: number; left: number } // safe area, dp
  statusBar: number // dp
  navBar: number
  navSide: 'bottom' | 'right'
}

function safeArea() {
  const probe = document.createElement('div')
  probe.style.cssText = 'position:fixed;visibility:hidden;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)'
  document.body.appendChild(probe)
  const cs = getComputedStyle(probe)
  const r = { top: parseFloat(cs.paddingTop) || 0, right: parseFloat(cs.paddingRight) || 0, bottom: parseFloat(cs.paddingBottom) || 0, left: parseFloat(cs.paddingLeft) || 0 }
  probe.remove()
  return r
}

const isPhoneBrowser = () => matchMedia('(pointer: coarse)').matches && Math.min(innerWidth, innerHeight) < 600

export function measure(): ScreenInfo {
  const vw = window.visualViewport?.width || innerWidth
  const vh = window.visualViewport?.height || innerHeight
  const mode = settings.get('screen.mode')
  const userScale = settings.get('screen.scale') || 1
  let fit = settings.get('screen.fit')
  if (fit === 'auto') fit = mode === 'auto' ? 'native' : isPhoneBrowser() ? 'native' : 'fit'

  let width: number, height: number, dpi: number, scale: number
  const insets = safeArea()
  if (mode === 'auto') {
    dpi = Math.round((window.devicePixelRatio || 1) * 160 * userScale)
    width = (vw - insets.left - insets.right) / userScale
    height = (vh - insets.top - insets.bottom) / userScale
    scale = userScale
  } else {
    const p = mode === 'custom' ? settings.get('screen.custom') : PRESETS[settings.get('screen.preset')] || PRESETS['phone-hdpi']
    dpi = p.dpi / userScale
    // preset is portrait-first; follow the window's orientation like a phone would
    const land = vw > vh
    const pw = (p.w * 160) / dpi, ph = (p.h * 160) / dpi
    width = land ? Math.max(pw, ph) : Math.min(pw, ph)
    height = land ? Math.min(pw, ph) : Math.max(pw, ph)
    if (fit === 'native') {
      // keep the dp size, stretch the screen to the viewport
      scale = Math.min(vw / width, vh / height)
      width = vw / scale
      height = vh / scale
    } else scale = Math.min(vw / width, vh / height)
  }
  width = Math.round(width)
  height = Math.round(height)
  const bucket = bucketFor(dpi)
  const shortest = Math.min(width, height)
  let form = settings.get('screen.form') as Form | 'auto'
  if (form === 'auto') form = shortest >= 600 ? (matchMedia('(pointer: fine)').matches && width >= 1024 ? 'desktop' : 'tablet') : 'phone'
  // desktop mode lands in milestone 7; until then the window manager treats it like tablet
  const orientation = width > height ? 'landscape' : 'portrait'
  const navSide = form === 'phone' && orientation === 'landscape' ? 'right' : 'bottom'
  return {
    width, height, dpi, bucket, density: dpi / 160, orientation, form, mode: fit as 'native' | 'fit',
    scale, offsetX: Math.round((vw - width * scale) / 2), offsetY: Math.round((vh - height * scale) / 2),
    insets, statusBar: 25, navBar: 48, navSide,
  }
}

// applies a ScreenInfo to the #screen element and css variables
export function apply(el: HTMLElement, s: ScreenInfo) {
  el.style.width = s.width + 'px'
  el.style.height = s.height + 'px'
  el.style.transform = `translate(${s.offsetX}px, ${s.offsetY}px) scale(${s.scale})`
  el.dataset.orientation = s.orientation
  el.dataset.form = s.form
  el.dataset.nav = s.navSide
  const st = el.style
  st.setProperty('--sb', s.statusBar + 'px')
  st.setProperty('--nb', s.navBar + 'px')
  st.setProperty('--sp', settings.get('font.scale') + 'px')
}

// calls fn with the new screen after resize / rotate / zoom, debounced
export function watch(fn: (s: ScreenInfo) => void) {
  let t = 0
  const go = () => { clearTimeout(t); t = window.setTimeout(() => fn(measure()), 120) }
  addEventListener('resize', go)
  window.visualViewport?.addEventListener('resize', go)
  addEventListener('orientationchange', go)
  for (const k of ['screen.mode', 'screen.preset', 'screen.custom', 'screen.fit', 'screen.scale', 'screen.form', 'font.scale'] as const) settings.on(k, go)
}

export { BUCKETS }
