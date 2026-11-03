// canvas 9-patch renderer. css border-image handles the common case (one stretch region per axis),
// this one handles any number of stretch regions, like android's NinePatch.draw.
// metadata comes from assets/aosp/ninepatch.json (written by tools/import-aosp).

export interface NineMeta {
  w: number
  h: number
  sx: [number, number][] // stretch runs on x, [start, end) in image px
  sy: [number, number][]
  pad: [number, number, number, number] // l t r b
}

type Seg = { from: number; to: number; stretch: boolean }

function segments(len: number, runs: [number, number][]): Seg[] {
  const out: Seg[] = []
  let pos = 0
  for (const [a, b] of runs) {
    if (a > pos) out.push({ from: pos, to: a, stretch: false })
    out.push({ from: a, to: b, stretch: true })
    pos = b
  }
  if (pos < len) out.push({ from: pos, to: len, stretch: false })
  return out
}

// maps source segments to destination sizes. fixed parts keep size * scale,
// stretch parts share what is left in proportion to their source size
function layout(segs: Seg[], dest: number, scale: number): number[] {
  const fixed = segs.filter((s) => !s.stretch).reduce((n, s) => n + (s.to - s.from) * scale, 0)
  const stretchSrc = segs.filter((s) => s.stretch).reduce((n, s) => n + (s.to - s.from), 0)
  const free = Math.max(0, dest - fixed)
  // if the target is smaller than the fixed parts, shrink everything evenly (android does the same)
  const shrink = fixed > dest ? dest / fixed : 1
  return segs.map((s) => (s.stretch ? (stretchSrc ? (free * (s.to - s.from)) / stretchSrc : 0) : (s.to - s.from) * scale * shrink))
}

// draw img (stripped 9-patch) into ctx at w x h css px. scale = image px -> css px (160 / image dpi)
export function drawNinePatch(ctx: CanvasRenderingContext2D, img: CanvasImageSource, meta: NineMeta, w: number, h: number, scale: number) {
  const xs = segments(meta.w, meta.sx)
  const ys = segments(meta.h, meta.sy)
  const dw = layout(xs, w, scale)
  const dh = layout(ys, h, scale)
  let y = 0
  ys.forEach((sy, j) => {
    let x = 0
    xs.forEach((sx, i) => {
      if (dw[i] > 0 && dh[j] > 0) ctx.drawImage(img, sx.from, sy.from, sx.to - sx.from, sy.to - sy.from, x, y, dw[i], dh[j])
      x += dw[i]
    })
    y += dh[j]
  })
}

const images = new Map<string, Promise<HTMLImageElement>>()
function load(src: string) {
  let p = images.get(src)
  if (!p) {
    p = new Promise((ok, fail) => {
      const im = new Image()
      im.onload = () => ok(im)
      im.onerror = fail
      im.src = src
    })
    images.set(src, p)
  }
  return p
}

// paints a multi-region 9-patch as the element background and keeps it right on resize.
// src: image url, meta: the bucket's metadata, dpi: the bucket density (160, 240, 320, 480)
export function attachNinePatch(el: HTMLElement, src: string, meta: NineMeta, dpi: number) {
  const canvas = document.createElement('canvas')
  const scale = 160 / dpi
  let img: HTMLImageElement | null = null
  const paint = () => {
    if (!img) return
    const r = el.getBoundingClientRect()
    const ratio = window.devicePixelRatio || 1
    canvas.width = Math.max(1, Math.round(r.width * ratio))
    canvas.height = Math.max(1, Math.round(r.height * ratio))
    const ctx = canvas.getContext('2d')!
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    ctx.imageSmoothingEnabled = true
    drawNinePatch(ctx, img, meta, r.width, r.height, scale)
    el.style.backgroundImage = `url(${canvas.toDataURL()})`
    el.style.backgroundSize = '100% 100%'
  }
  load(src).then((im) => { img = im; paint() })
  const ro = new ResizeObserver(paint)
  ro.observe(el)
  const [l, t, r, b] = meta.pad.map((p) => p * scale)
  el.style.padding = `${t}px ${r}px ${b}px ${l}px`
  return () => ro.disconnect()
}
