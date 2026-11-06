// android.graphics for the real framework: what skia does on android, on the web's 2d canvas.
// Matrix, Path, Paint (and text measuring with roboto's metrics), Typeface, Bitmap and decoding,
// Canvas (state stack, clips, layers), NinePatch, shaders, color filters, xfermodes, Region,
// PathMeasure. native handles are small ints that index js objects.
import type { VM, JObject, JArray } from '../dalvik.ts'
import { jstr } from '../java.ts'

// ---------- matrices: [a c e / b d f / p0 p1 p2] as android's 3x3 (row-major, skia order) ----------
type M = Float64Array // [sx, kx, tx, ky, sy, ty, p0, p1, p2]
const ident = (): M => new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1])
const mul = (a: M, b: M): M => { // a * b
  const r = new Float64Array(9)
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j]
  return r
}
const translateM = (dx: number, dy: number): M => new Float64Array([1, 0, dx, 0, 1, dy, 0, 0, 1])
const scaleM = (sx: number, sy: number, px = 0, py = 0): M => new Float64Array([sx, 0, px - sx * px, 0, sy, py - sy * py, 0, 0, 1])
const rotateM = (deg: number, px = 0, py = 0): M => { const r = (deg * Math.PI) / 180; return sinCosM(Math.sin(r), Math.cos(r), px, py) }
const sinCosM = (s: number, c: number, px = 0, py = 0): M => new Float64Array([c, -s, s * py + (1 - c) * px, s, c, -s * px + (1 - c) * py, 0, 0, 1])
const skewM = (kx: number, ky: number, px = 0, py = 0): M => new Float64Array([1, kx, -kx * py, ky, 1, -ky * px, 0, 0, 1])
const mapPt = (m: M, x: number, y: number): [number, number] => {
  const w = m[6] * x + m[7] * y + m[8] || 1
  return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w]
}
const invert = (m: M): M | null => {
  const [a, b, c, d, e, f, g, h, i] = m
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g
  const det = a * A + b * B + c * C
  if (!det || !isFinite(det)) return null
  const r = new Float64Array([A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d])
  for (let k = 0; k < 9; k++) r[k] /= det
  return r
}
const isIdent = (m: M) => m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 0 && m[4] === 1 && m[5] === 0 && m[6] === 0 && m[7] === 0 && m[8] === 1
const mapRect = (m: M, l: number, t: number, r: number, b: number): [number, number, number, number] => {
  const ps = [mapPt(m, l, t), mapPt(m, r, t), mapPt(m, r, b), mapPt(m, l, b)]
  return [Math.min(...ps.map((p) => p[0])), Math.min(...ps.map((p) => p[1])), Math.max(...ps.map((p) => p[0])), Math.max(...ps.map((p) => p[1]))]
}

// ---------- paths: android's verbs, replayed into a Path2D ----------
interface PathData { cmds: (string | number)[][]; fill: number; lastX: number; lastY: number; startX: number; startY: number; p2d?: Path2D | null }
const newPath = (): PathData => ({ cmds: [], fill: 0, lastX: 0, lastY: 0, startX: 0, startY: 0 })
function arcPoints(cx: number, cy: number, rx: number, ry: number, start: number, sweep: number, out: (string | number)[][], move: boolean) {
  const steps = Math.max(1, Math.ceil(Math.abs(sweep) / 90))
  const a0 = (start * Math.PI) / 180, da = (sweep * Math.PI) / 180 / steps
  const sx = cx + rx * Math.cos(a0), sy = cy + ry * Math.sin(a0)
  out.push([move ? 'M' : 'L', sx, sy])
  for (let i = 0; i < steps; i++) {
    const t1 = a0 + i * da, t2 = t1 + da, k = (4 / 3) * Math.tan(da / 4)
    const x1 = cx + rx * (Math.cos(t1) - k * Math.sin(t1)), y1 = cy + ry * (Math.sin(t1) + k * Math.cos(t1))
    const x2 = cx + rx * (Math.cos(t2) + k * Math.sin(t2)), y2 = cy + ry * (Math.sin(t2) - k * Math.cos(t2))
    out.push(['C', x1, y1, x2, y2, cx + rx * Math.cos(t2), cy + ry * Math.sin(t2)])
  }
}
const path2d = (p: PathData): Path2D => {
  if (p.p2d) return p.p2d
  const q = new Path2D()
  for (const c of p.cmds) {
    switch (c[0]) {
      case 'M': q.moveTo(c[1] as number, c[2] as number); break
      case 'L': q.lineTo(c[1] as number, c[2] as number); break
      case 'Q': q.quadraticCurveTo(c[1] as number, c[2] as number, c[3] as number, c[4] as number); break
      case 'C': q.bezierCurveTo(c[1] as number, c[2] as number, c[3] as number, c[4] as number, c[5] as number, c[6] as number); break
      case 'Z': q.closePath(); break
    }
  }
  return (p.p2d = q)
}
const pathPoints = (p: PathData) => { const pts: number[] = []; for (const c of p.cmds) for (let i = 1; i < c.length; i += 2) pts.push(c[i] as number, c[i + 1] as number); return pts }
const transformPath = (p: PathData, m: M): PathData => ({ ...p, p2d: null, cmds: p.cmds.map((c) => { const o = [c[0]] as (string | number)[]; for (let i = 1; i < c.length; i += 2) o.push(...mapPt(m, c[i] as number, c[i + 1] as number)); return o }) })
// flattened polylines (for measuring)
function flatten(p: PathData): { pts: [number, number][]; closed: boolean }[] {
  const out: { pts: [number, number][]; closed: boolean }[] = []
  let cur: [number, number][] = [], x = 0, y = 0
  const push = () => { if (cur.length > 1) out.push({ pts: cur, closed: false }); cur = [] }
  for (const c of p.cmds) {
    if (c[0] === 'M') { push(); x = c[1] as number; y = c[2] as number; cur = [[x, y]] }
    else if (c[0] === 'L') { x = c[1] as number; y = c[2] as number; cur.push([x, y]) }
    else if (c[0] === 'Q' || c[0] === 'C') {
      const n = 16, x0 = x, y0 = y
      for (let i = 1; i <= n; i++) {
        const t = i / n, u = 1 - t
        if (c[0] === 'Q') { x = u * u * x0 + 2 * u * t * (c[1] as number) + t * t * (c[3] as number); y = u * u * y0 + 2 * u * t * (c[2] as number) + t * t * (c[4] as number) }
        else { x = u * u * u * x0 + 3 * u * u * t * (c[1] as number) + 3 * u * t * t * (c[3] as number) + t * t * t * (c[5] as number); y = u * u * u * y0 + 3 * u * u * t * (c[2] as number) + 3 * u * t * t * (c[4] as number) + t * t * t * (c[6] as number) }
        cur.push([x, y])
      }
    } else if (c[0] === 'Z') { if (cur.length) { cur.push(cur[0]); out.push({ pts: cur, closed: true }); x = cur[0][0]; y = cur[0][1]; cur = [[x, y]] } }
  }
  push()
  return out
}

// ---------- paint ----------
interface Paint {
  flags: number; color: number; style: number; strokeWidth: number; miter: number; cap: number; join: number
  textSize: number; scaleX: number; skewX: number; align: number; typeface: number; hinting: number
  shader: number; colorFilter: number; xfermode: number; pathEffect: number; maskFilter: number
  shadow: { r: number; dx: number; dy: number; color: number } | null; locale: string
}
const newPaint = (): Paint => ({ flags: 0x100 | 0x400, color: 0xff000000 | 0, style: 0, strokeWidth: 0, miter: 4, cap: 0, join: 0, textSize: 12, scaleX: 1, skewX: 0, align: 0, typeface: 0, hinting: 1, shader: 0, colorFilter: 0, xfermode: 0, pathEffect: 0, maskFilter: 0, shadow: null, locale: 'en' })
const F = { AA: 1, FILTER: 2, DITHER: 4, UNDERLINE: 8, STRIKE: 16, FAKE_BOLD: 32, LINEAR: 64, SUBPIXEL: 128 }
const rgba = (c: number, alphaMul = 1) => `rgba(${(c >> 16) & 255},${(c >> 8) & 255},${c & 255},${(((c >>> 24) / 255) * alphaMul).toFixed(4)})`
// roboto's vertical metrics (per em), what android reports for its default font
const ROBOTO = { top: -1.056, ascent: -0.928, descent: 0.244, bottom: 0.271, leading: 0 }

interface Face { family: string; weight: number; italic: boolean }
interface Shader { kind: 'bitmap' | 'linear' | 'radial' | 'sweep' | 'compose'; args: any; local: M | null }
interface ColorFilter { kind: 'pd' | 'lighting' | 'matrix'; color?: number; mode?: number; mul?: number; add?: number; m?: number[] }

// ---------- bitmaps (configs are kitkat's native numbers: ALPHA_8 1, RGB_565 3, ARGB_4444 4, ARGB_8888 5) ----------
export interface Bmp { w: number; h: number; config: number; canvas: HTMLCanvasElement | OffscreenCanvas | null; ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null; mutable: boolean; alpha: boolean; gen: number }

export function registerAospGraphics(vm: VM, hooks: { assetBytes?: (h: number) => Uint8Array | undefined; redraw?: () => void } = {}) {
  const text = (x: any) => (x == null ? '' : jstr(vm, x))
  const H = new Map<number, any>()
  let nextH = 1
  const put = (o: any) => { const h = nextH++; H.set(h, o); return h }
  const get = <T>(h: number): T => H.get(h) as T
  const hasCanvas = typeof OffscreenCanvas !== 'undefined' || typeof document !== 'undefined'
  const makeCanvas = (w: number, h: number) => {
    if (!hasCanvas) return null
    const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(Math.max(1, w), Math.max(1, h)) : Object.assign(document.createElement('canvas'), { width: Math.max(1, w), height: Math.max(1, h) })
    return c
  }
  const newBmp = (w: number, h: number, config = 5, mutable = true): Bmp => {
    const canvas = makeCanvas(w, h)
    const ctx = (canvas?.getContext('2d') ?? null) as Bmp['ctx']
    return { w, h, config, canvas, ctx, mutable, alpha: config !== 3, gen: 1 }
  }
  const floatsOf = (a: JArray) => a.data as Float32Array
  const rectOf = (r: JObject) => [r.f.left, r.f.top, r.f.right, r.f.bottom] as [number, number, number, number]
  const setRect = (r: JObject, l: number, t: number, rr: number, b: number) => { r.f.left = l; r.f.top = t; r.f.right = rr; r.f.bottom = b }
  const isRectF = (o: any) => o && o.cls?.name === 'Landroid/graphics/RectF;'

  // ---------- Matrix ----------
  const Mx = (h: number): M => get<M>(h)
  const setM = (h: number, m: M) => { Mx(h).set(m) }
  vm.registerNatives('Landroid/graphics/Matrix;', {
    native_create: (v, s, [src]) => put(src ? new Float64Array(Mx(src)) : ident()),
    finalizer: (v, s, [h]) => { H.delete(h) },
    native_isIdentity: (v, s, [h]) => (isIdent(Mx(h)) ? 1 : 0),
    native_rectStaysRect: (v, s, [h]) => { const m = Mx(h); return (m[1] === 0 && m[3] === 0) || (m[0] === 0 && m[4] === 0) ? 1 : 0 },
    native_reset: (v, s, [h]) => setM(h, ident()),
    native_set: (v, s, [h, o]) => setM(h, Mx(o)),
    native_setTranslate: (v, s, [h, dx, dy]) => setM(h, translateM(dx, dy)),
    native_setScale: (v, s, [h, sx, sy, px, py]) => setM(h, scaleM(sx, sy, px ?? 0, py ?? 0)),
    native_setRotate: (v, s, [h, d, px, py]) => setM(h, rotateM(d, px ?? 0, py ?? 0)),
    native_setSinCos: (v, s, [h, sn, cs, px, py]) => setM(h, sinCosM(sn, cs, px ?? 0, py ?? 0)),
    native_setSkew: (v, s, [h, kx, ky, px, py]) => setM(h, skewM(kx, ky, px ?? 0, py ?? 0)),
    native_setConcat: (v, s, [h, a, b]) => { setM(h, mul(Mx(a), Mx(b))); return 1 },
    native_preTranslate: (v, s, [h, dx, dy]) => { setM(h, mul(Mx(h), translateM(dx, dy))); return 1 },
    native_preScale: (v, s, [h, sx, sy, px, py]) => { setM(h, mul(Mx(h), scaleM(sx, sy, px ?? 0, py ?? 0))); return 1 },
    native_preRotate: (v, s, [h, d, px, py]) => { setM(h, mul(Mx(h), rotateM(d, px ?? 0, py ?? 0))); return 1 },
    native_preSkew: (v, s, [h, kx, ky, px, py]) => { setM(h, mul(Mx(h), skewM(kx, ky, px ?? 0, py ?? 0))); return 1 },
    native_preConcat: (v, s, [h, o]) => { setM(h, mul(Mx(h), Mx(o))); return 1 },
    native_postTranslate: (v, s, [h, dx, dy]) => { setM(h, mul(translateM(dx, dy), Mx(h))); return 1 },
    native_postScale: (v, s, [h, sx, sy, px, py]) => { setM(h, mul(scaleM(sx, sy, px ?? 0, py ?? 0), Mx(h))); return 1 },
    native_postRotate: (v, s, [h, d, px, py]) => { setM(h, mul(rotateM(d, px ?? 0, py ?? 0), Mx(h))); return 1 },
    native_postSkew: (v, s, [h, kx, ky, px, py]) => { setM(h, mul(skewM(kx, ky, px ?? 0, py ?? 0), Mx(h))); return 1 },
    native_postConcat: (v, s, [h, o]) => { setM(h, mul(Mx(o), Mx(h))); return 1 },
    native_setRectToRect: (v, s, [h, src, dst, stf]) => {
      const [sl, st, sr, sb] = rectOf(src), [dl, dt, dr, db] = rectOf(dst)
      const sw = sr - sl, sh = sb - st
      if (sw <= 0 || sh <= 0) { setM(h, ident()); return 0 }
      let sx = (dr - dl) / sw, sy = (db - dt) / sh, tx = dl - sl * sx, ty = dt - st * sy
      if (stf !== 0) { // fill keeps aspect: START 1, CENTER 2, END 3
        const k = Math.min(sx, sy); const ex = (dr - dl) - sw * k, ey = (db - dt) - sh * k
        sx = sy = k; tx = dl - sl * k; ty = dt - st * k
        if (stf === 2) { tx += ex / 2; ty += ey / 2 } else if (stf === 3) { tx += ex; ty += ey }
      }
      setM(h, new Float64Array([sx, 0, tx, 0, sy, ty, 0, 0, 1])); return 1
    },
    native_setPolyToPoly: (v, s, [h, src, si, dst, di, n]) => {
      const a = floatsOf(src), b = floatsOf(dst)
      if (n === 0) { setM(h, ident()); return 1 }
      if (n === 1) { setM(h, translateM(b[di] - a[si], b[di + 1] - a[si + 1])); return 1 }
      // 2+ points: similarity from the first two (enough for the framework's uses)
      const ax = a[si + 2] - a[si], ay = a[si + 3] - a[si + 1], bx = b[di + 2] - b[di], by = b[di + 3] - b[di + 1]
      const la = Math.hypot(ax, ay) || 1, k = Math.hypot(bx, by) / la, rot = Math.atan2(by, bx) - Math.atan2(ay, ax)
      let m = mul(rotateM((rot * 180) / Math.PI), scaleM(k, k)); m = mul(m, translateM(-a[si], -a[si + 1])); m = mul(translateM(b[di], b[di + 1]), m)
      setM(h, m); return 1
    },
    native_invert: (v, s, [h, o]) => { const r = invert(Mx(h)); if (!r) return 0; if (o) setM(o, r); return 1 },
    native_mapPoints: (v, s, [h, dst, di, src, si, n, isPts]) => {
      const m = Mx(h), a = floatsOf(src), b = floatsOf(dst)
      for (let i = 0; i < n; i++) {
        const x = a[si + i * 2], y = a[si + i * 2 + 1]
        if (isPts) { const p = mapPt(m, x, y); b[di + i * 2] = p[0]; b[di + i * 2 + 1] = p[1] }
        else { b[di + i * 2] = m[0] * x + m[1] * y; b[di + i * 2 + 1] = m[3] * x + m[4] * y }
      }
    },
    native_mapRect: (v, s, [h, dst, src]) => { const m = Mx(h); const r = mapRect(m, ...rectOf(src)); setRect(dst, ...r); return (m[1] === 0 && m[3] === 0) ? 1 : 0 },
    native_mapRadius: (v, s, [h, r]) => { const m = Mx(h); return Math.fround(r * Math.sqrt(Math.abs(m[0] * m[4] - m[1] * m[3]))) },
    native_getValues: (v, s, [h, arr]) => { const m = Mx(h), a = floatsOf(arr); for (let i = 0; i < 9; i++) a[i] = m[i] },
    native_setValues: (v, s, [h, arr]) => { const a = floatsOf(arr); setM(h, new Float64Array(a.slice(0, 9))) },
    native_equals: (v, s, [a, b]) => { const x = Mx(a), y = Mx(b); for (let i = 0; i < 9; i++) if (x[i] !== y[i]) return 0; return 1 },
  })

  // ---------- Path ----------
  const P = (h: number): PathData => get<PathData>(h)
  const add = (p: PathData, c: (string | number)[]) => { p.cmds.push(c); p.p2d = null; if (c.length >= 3) { p.lastX = c[c.length - 2] as number; p.lastY = c[c.length - 1] as number } if (c[0] === 'M') { p.startX = p.lastX; p.startY = p.lastY } if (c[0] === 'Z') { p.lastX = p.startX; p.lastY = p.startY } }
  const ensureMove = (p: PathData) => { if (!p.cmds.length || p.cmds[p.cmds.length - 1][0] === 'Z') add(p, ['M', p.lastX, p.lastY]) }
  const rectCmds = (p: PathData, l: number, t: number, r: number, b: number, dir: number) => {
    add(p, ['M', l, t])
    if (dir === 0) { add(p, ['L', r, t]); add(p, ['L', r, b]); add(p, ['L', l, b]) } else { add(p, ['L', l, b]); add(p, ['L', r, b]); add(p, ['L', r, t]) }
    add(p, ['Z'])
  }
  const ovalCmds = (p: PathData, l: number, t: number, r: number, b: number, dir: number) => {
    const out: (string | number)[][] = []
    arcPoints((l + r) / 2, (t + b) / 2, (r - l) / 2, (b - t) / 2, 0, dir === 0 ? 360 : -360, out, true)
    for (const c of out) add(p, c)
    add(p, ['Z'])
  }
  const roundRectCmds = (p: PathData, l: number, t: number, r: number, b: number, radii: number[]) => {
    const [tlx, tly, trx, try_, brx, bry, blx, bly] = radii
    const out: (string | number)[][] = []
    out.push(['M', l + tlx, t]); out.push(['L', r - trx, t])
    if (trx || try_) arcPoints(r - trx, t + try_, trx, try_, 270, 90, out, false)
    out.push(['L', r, b - bry])
    if (brx || bry) arcPoints(r - brx, b - bry, brx, bry, 0, 90, out, false)
    out.push(['L', l + blx, b])
    if (blx || bly) arcPoints(l + blx, b - bly, blx, bly, 90, 90, out, false)
    out.push(['L', l, t + tly])
    if (tlx || tly) arcPoints(l + tlx, t + tly, tlx, tly, 180, 90, out, false)
    out.push(['Z'])
    for (const c of out) add(p, c)
  }
  const bounds = (p: PathData): [number, number, number, number] => {
    const pts = pathPoints(p)
    if (!pts.length) return [0, 0, 0, 0]
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity
    for (let i = 0; i < pts.length; i += 2) { l = Math.min(l, pts[i]); r = Math.max(r, pts[i]); t = Math.min(t, pts[i + 1]); b = Math.max(b, pts[i + 1]) }
    return [l, t, r, b]
  }
  vm.registerNatives('Landroid/graphics/Path;', {
    init1: () => put(newPath()),
    init2: (v, s, [o]) => { const q = P(o); return put({ ...q, cmds: q.cmds.map((c) => [...c]), p2d: null }) },
    finalizer: (v, s, [h]) => { H.delete(h) },
    native_reset: (v, s, [h]) => { const p = P(h); p.cmds = []; p.p2d = null; p.lastX = p.lastY = 0; p.fill = 0 },
    native_rewind: (v, s, [h]) => { const p = P(h); p.cmds = []; p.p2d = null; p.lastX = p.lastY = 0 },
    native_set: (v, s, [d, src]) => { const q = P(src); Object.assign(P(d), { ...q, cmds: q.cmds.map((c) => [...c]), p2d: null }) },
    native_getFillType: (v, s, [h]) => P(h).fill,
    native_setFillType: (v, s, [h, f]) => { P(h).fill = f },
    native_isEmpty: (v, s, [h]) => (P(h).cmds.length ? 0 : 1),
    native_isRect: () => 0,
    native_computeBounds: (v, s, [h, r]) => setRect(r, ...bounds(P(h))),
    native_incReserve: () => {},
    native_moveTo: (v, s, [h, x, y]) => add(P(h), ['M', x, y]),
    native_rMoveTo: (v, s, [h, x, y]) => { const p = P(h); add(p, ['M', p.lastX + x, p.lastY + y]) },
    native_lineTo: (v, s, [h, x, y]) => { const p = P(h); ensureMove(p); add(p, ['L', x, y]) },
    native_rLineTo: (v, s, [h, x, y]) => { const p = P(h); ensureMove(p); add(p, ['L', p.lastX + x, p.lastY + y]) },
    native_quadTo: (v, s, [h, a, b, c, d]) => { const p = P(h); ensureMove(p); add(p, ['Q', a, b, c, d]) },
    native_rQuadTo: (v, s, [h, a, b, c, d]) => { const p = P(h); ensureMove(p); const x = p.lastX, y = p.lastY; add(p, ['Q', x + a, y + b, x + c, y + d]) },
    native_cubicTo: (v, s, [h, a, b, c, d, e, f]) => { const p = P(h); ensureMove(p); add(p, ['C', a, b, c, d, e, f]) },
    native_rCubicTo: (v, s, [h, a, b, c, d, e, f]) => { const p = P(h); ensureMove(p); const x = p.lastX, y = p.lastY; add(p, ['C', x + a, y + b, x + c, y + d, x + e, y + f]) },
    native_arcTo: (v, s, [h, oval, start, sweep, force]) => {
      const p = P(h), [l, t, r, b] = rectOf(oval), out: (string | number)[][] = []
      arcPoints((l + r) / 2, (t + b) / 2, (r - l) / 2, (b - t) / 2, start, sweep, out, !!force || !p.cmds.length)
      for (const c of out) add(p, c)
    },
    native_close: (v, s, [h]) => { const p = P(h); if (p.cmds.length) add(p, ['Z']) },
    native_addRect: (v, s, [h, a, b, c, d, e]) => { if (isRectF(a)) rectCmds(P(h), ...rectOf(a), b); else rectCmds(P(h), a, b, c, d, e) },
    native_addOval: (v, s, [h, oval, dir]) => ovalCmds(P(h), ...rectOf(oval), dir),
    native_addCircle: (v, s, [h, x, y, r, dir]) => ovalCmds(P(h), x - r, y - r, x + r, y + r, dir),
    native_addArc: (v, s, [h, oval, start, sweep]) => { const [l, t, r, b] = rectOf(oval), out: (string | number)[][] = []; arcPoints((l + r) / 2, (t + b) / 2, (r - l) / 2, (b - t) / 2, start, sweep, out, true); for (const c of out) add(P(h), c) },
    native_addRoundRect: (v, s, [h, rect, a, b]) => {
      const [l, t, r, bt] = rectOf(rect)
      const radii = a instanceof Object && (a as JArray).data ? [...floatsOf(a)] : [a, b, a, b, a, b, a, b]
      roundRectCmds(P(h), l, t, r, bt, radii.map((x) => Math.min(Math.abs(x), (r - l) / 2, (bt - t) / 2)))
    },
    native_addPath: (v, s, args) => {
      // (path, src) / (path, src, dx, dy) / (path, src, matrix)
      let q = P(args[1])
      if (args.length === 4) q = transformPath(q, translateM(args[2], args[3]))
      else if (args.length === 3) q = transformPath(q, Mx(args[2]))
      for (const c of q.cmds) add(P(args[0]), [...c])
    },
    native_offset: (v, s, [h, dx, dy, dst]) => { const r = transformPath(P(h), translateM(dx, dy)); Object.assign(dst ? P(dst) : P(h), { cmds: r.cmds, p2d: null }) },
    native_setLastPoint: (v, s, [h, x, y]) => { const p = P(h); const c = p.cmds[p.cmds.length - 1]; if (c && c.length >= 3) { c[c.length - 2] = x; c[c.length - 1] = y; p.p2d = null } else add(p, ['M', x, y]); p.lastX = x; p.lastY = y },
    native_transform: (v, s, [h, m, dst]) => { const r = transformPath(P(h), Mx(m)); Object.assign(dst ? P(dst) : P(h), { cmds: r.cmds, p2d: null }) },
    native_op: (v, s, [a, b, op, res]) => { const r = P(res); r.cmds = [...P(a).cmds, ...(op === 2 || op === 4 ? P(b).cmds : [])].map((c) => [...c]); r.p2d = null; return 1 },
  })

  // ---------- Paint ----------
  const Pt = (s: JObject): Paint => get<Paint>(s.f.mNativePaint)
  const PH = (h: number): Paint => get<Paint>(h)
  const measure = (() => {
    const c = makeCanvas(4, 4)
    return (c?.getContext('2d') ?? null) as CanvasRenderingContext2D | null
  })()
  const faceOf = (p: Paint): Face => get<Face>(p.typeface) ?? { family: 'Roboto, sans-serif', weight: 400, italic: false }
  const fontOf = (p: Paint) => { const f = faceOf(p); const bold = f.weight >= 600 || (p.flags & F.FAKE_BOLD); return `${f.italic ? 'italic ' : ''}${bold ? '700' : f.weight} ${p.textSize}px ${f.family}` }
  const widthCache = new Map<string, number>()
  // the advance of one character (cached per font), roboto widths when there is no canvas (tests)
  const charWidth = (p: Paint, font: string, ch: string) => {
    const k = font + '|' + ch
    let w = widthCache.get(k)
    if (w === undefined) {
      if (measure) { measure.font = font; w = measure.measureText(ch).width / p.textSize } else w = ch === ' ' ? 0.25 : /[iljtf.,'|!:;]/.test(ch) ? 0.28 : /[mwMW]/.test(ch) ? 0.85 : /[A-Z]/.test(ch) ? 0.65 : 0.55
      widthCache.set(k, w)
    }
    return w * p.textSize * p.scaleX
  }
  const advances = (p: Paint, str: string, out?: Float32Array, at = 0) => {
    const font = fontOf(p)
    let total = 0
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i)
      let w = 0
      if (c >= 0xdc00 && c <= 0xdfff && i > 0) w = 0 // low surrogate: its pair carried the width
      else if (c >= 0xd800 && c <= 0xdbff) w = charWidth(p, font, str.slice(i, i + 2))
      else w = charWidth(p, font, str[i])
      if (out) out[at + i] = w
      total += w
    }
    return total
  }
  const strOf = (a: any, start: number, end: number) => (typeof a === 'string' ? a.slice(start, end) : String.fromCharCode(...Array.prototype.slice.call((a as JArray).data, start, end)))
  const metrics = (p: Paint) => ({ top: ROBOTO.top * p.textSize, ascent: ROBOTO.ascent * p.textSize, descent: ROBOTO.descent * p.textSize, bottom: ROBOTO.bottom * p.textSize, leading: 0 })
  vm.registerNatives('Landroid/graphics/Paint;', {
    native_init: () => put(newPaint()),
    native_initWithPaint: (v, s, [o]) => put({ ...PH(o), shadow: PH(o).shadow ? { ...PH(o).shadow! } : null }),
    native_reset: (v, s, [h]) => { Object.assign(PH(h), newPaint()) },
    native_set: (v, s, [d, src]) => { Object.assign(PH(d), { ...PH(src) }) },
    finalizer: (v, s, [h]) => { H.delete(h) },
    getFlags: (v, s) => Pt(s).flags, setFlags: (v, s, [f]) => { Pt(s).flags = f },
    getHinting: (v, s) => Pt(s).hinting, setHinting: (v, s, [x]) => { Pt(s).hinting = x },
    setAntiAlias: (v, s, [x]) => { const p = Pt(s); p.flags = x ? p.flags | F.AA : p.flags & ~F.AA },
    setDither: (v, s, [x]) => { const p = Pt(s); p.flags = x ? p.flags | F.DITHER : p.flags & ~F.DITHER },
    setLinearText: (v, s, [x]) => { const p = Pt(s); p.flags = x ? p.flags | F.LINEAR : p.flags & ~F.LINEAR },
    setSubpixelText: (v, s, [x]) => { const p = Pt(s); p.flags = x ? p.flags | F.SUBPIXEL : p.flags & ~F.SUBPIXEL },
    setUnderlineText: (v, s, [x]) => { const p = Pt(s); p.flags = x ? p.flags | F.UNDERLINE : p.flags & ~F.UNDERLINE },
    setStrikeThruText: (v, s, [x]) => { const p = Pt(s); p.flags = x ? p.flags | F.STRIKE : p.flags & ~F.STRIKE },
    setFakeBoldText: (v, s, [x]) => { const p = Pt(s); p.flags = x ? p.flags | F.FAKE_BOLD : p.flags & ~F.FAKE_BOLD },
    setFilterBitmap: (v, s, [x]) => { const p = Pt(s); p.flags = x ? p.flags | F.FILTER : p.flags & ~F.FILTER },
    getColor: (v, s) => Pt(s).color, setColor: (v, s, [c]) => { Pt(s).color = c | 0 },
    getAlpha: (v, s) => Pt(s).color >>> 24, setAlpha: (v, s, [a]) => { const p = Pt(s); p.color = ((a & 255) << 24) | (p.color & 0xffffff) },
    getStrokeWidth: (v, s) => Pt(s).strokeWidth, setStrokeWidth: (v, s, [w]) => { Pt(s).strokeWidth = w },
    getStrokeMiter: (v, s) => Pt(s).miter, setStrokeMiter: (v, s, [m]) => { Pt(s).miter = m },
    nSetShadowLayer: (v, s, [r, dx, dy, c]) => { Pt(s).shadow = r > 0 ? { r, dx, dy, color: c } : null },
    getTextSize: (v, s) => Pt(s).textSize, setTextSize: (v, s, [x]) => { Pt(s).textSize = x },
    getTextScaleX: (v, s) => Pt(s).scaleX, setTextScaleX: (v, s, [x]) => { Pt(s).scaleX = x },
    getTextSkewX: (v, s) => Pt(s).skewX, setTextSkewX: (v, s, [x]) => { Pt(s).skewX = x },
    ascent: (v, s) => Math.fround(metrics(Pt(s)).ascent), descent: (v, s) => Math.fround(metrics(Pt(s)).descent),
    getFontMetrics: (v, s, [fm]) => { const m = metrics(Pt(s)); if (fm) Object.assign(fm.f, m); return Math.fround(m.descent - m.ascent) },
    getFontMetricsInt: (v, s, [fm]) => {
      const m = metrics(Pt(s)), r = { top: Math.floor(m.top), ascent: Math.round(m.ascent), descent: Math.round(m.descent), bottom: Math.ceil(m.bottom), leading: 0 }
      if (fm) Object.assign(fm.f, r)
      return r.descent - r.ascent
    },
    native_measureText: (v, s, [a, b, c]) => { const str = typeof a === 'string' ? (typeof c === 'number' ? a.slice(b, c) : a) : strOf(a, b, b + c); return Math.fround(advances(Pt(s), str)) },
    native_breakText: (v, s, args) => {
      const p = Pt(s)
      let str: string, max: number, out: JArray | null, forward = true
      if (typeof args[0] === 'string') { str = args[0]; forward = !!args[1]; max = args[2]; out = args[4] } else { str = strOf(args[0], args[1], args[1] + args[2]); max = args[3]; out = args[5] }
      const w = new Float32Array(str.length); advances(p, str, w)
      let sum = 0, n = 0
      if (forward) { for (; n < str.length && sum + w[n] <= max; n++) sum += w[n] } else { for (let i = str.length - 1; i >= 0 && sum + w[i] <= max; i--, n++) sum += w[i] }
      if (out) (out.data as Float32Array)[0] = sum
      return n
    },
    native_getStyle: (v, s, [h]) => PH(h).style, native_setStyle: (v, s, [h, x]) => { PH(h).style = x },
    native_getStrokeCap: (v, s, [h]) => PH(h).cap, native_setStrokeCap: (v, s, [h, x]) => { PH(h).cap = x },
    native_getStrokeJoin: (v, s, [h]) => PH(h).join, native_setStrokeJoin: (v, s, [h, x]) => { PH(h).join = x },
    native_getFillPath: (v, s, [, src, dst]) => { Object.assign(P(dst), { ...P(src), cmds: P(src).cmds.map((c) => [...c]), p2d: null }); return 1 },
    native_setShader: (v, s, [h, x]) => { PH(h).shader = x; return x },
    native_setColorFilter: (v, s, [h, x]) => { PH(h).colorFilter = x; return x },
    native_setXfermode: (v, s, [h, x]) => { PH(h).xfermode = x; return x },
    native_setPathEffect: (v, s, [h, x]) => { PH(h).pathEffect = x; return x },
    native_setMaskFilter: (v, s, [h, x]) => { PH(h).maskFilter = x; return x },
    native_setTypeface: (v, s, [h, x]) => { PH(h).typeface = x; return x },
    native_setRasterizer: (v, s, [, x]) => x,
    native_getTextAlign: (v, s, [h]) => PH(h).align, native_setTextAlign: (v, s, [h, x]) => { PH(h).align = x },
    native_setTextLocale: (v, s, [h, l]) => { PH(h).locale = text(l) },
    native_getTextWidths: (v, s, [h, a, b, c, , out]) => { const str = typeof a === 'string' ? a.slice(b, c) : strOf(a, b, b + c); advances(PH(h), str, out.data as Float32Array); return str.length },
    native_getTextGlyphs: (v, s, [, str, start, end, , , , glyphs]) => { const t = text(str); for (let i = start; i < end; i++) glyphs.data[i - start] = t.charCodeAt(i); return end - start },
    native_getTextRunAdvances: (v, s, [h, a, b, c, , , , out, at]) => {
      const str = typeof a === 'string' ? a.slice(b, c) : strOf(a, b, b + c)
      return Math.fround(advances(PH(h), str, out ? out.data as Float32Array : undefined, at ?? 0))
    },
    native_getTextRunCursor: (v, s, [, a, contextStart, contextLen, , offset, cursorOpt]) => {
      // cursor positions: every character boundary that is not inside a surrogate pair
      const str = typeof a === 'string' ? a : strOf(a, 0, (a as JArray).data.length)
      const end = typeof a === 'string' ? contextLen : contextStart + contextLen
      const ok = (i: number) => i <= contextStart || i >= end || !(str.charCodeAt(i) >= 0xdc00 && str.charCodeAt(i) <= 0xdfff)
      switch (cursorOpt) {
        case 0: { let i = offset + 1; while (i < end && !ok(i)) i++; return Math.min(i, end) } // after
        case 1: { let i = offset - 1; while (i > contextStart && !ok(i)) i--; return Math.max(i, contextStart) } // before
        case 2: { let i = offset; while (i < end && !ok(i)) i++; return i } // at or after
        case 3: { let i = offset; while (i > contextStart && !ok(i)) i--; return i } // at or before
        default: return ok(offset) ? offset : -1
      }
    },
    native_getTextPath: (v, s, [h, , a, b, c, x, y, path]) => { const str = typeof a === 'string' ? a.slice(b, c) : strOf(a, b, b + c); const w = advances(PH(h), str); const m = metrics(PH(h)); rectCmds(P(path), x, y + m.ascent, x + w, y + m.descent, 0) },
    nativeGetStringBounds: (v, s, [h, str, start, end, , r]) => { const p = PH(h), t = text(str).slice(start, end), m = metrics(p); setRect(r, 0, Math.floor(m.ascent * 0.76), Math.ceil(advances(p, t)), Math.ceil(m.descent * 0.3)) },
    nativeGetCharArrayBounds: (v, s, [h, a, i, n, , r]) => { const p = PH(h), m = metrics(p); setRect(r, 0, Math.floor(m.ascent * 0.76), Math.ceil(advances(p, strOf(a, i, i + n))), Math.ceil(m.descent * 0.3)) },
  })

  // ---------- Typeface ----------
  const face = (family: string, style: number): Face => ({ family: /mono/i.test(family) ? '"Droid Sans Mono", monospace' : /serif/i.test(family) && !/sans/i.test(family) ? '"Droid Serif", serif' : 'Roboto, "Helvetica Neue", Arial, sans-serif', weight: style & 1 ? 700 : /light/i.test(family) ? 300 : /thin/i.test(family) ? 100 : /medium/i.test(family) ? 500 : 400, italic: !!(style & 2) })
  vm.registerNatives('Landroid/graphics/Typeface;', {
    nativeCreate: (v, s, [fam, style]) => put(face(text(fam), style)),
    nativeCreateFromTypeface: (v, s, [h, style]) => { const f = get<Face>(h) ?? face('', 0); return put({ ...f, weight: style & 1 ? 700 : f.weight === 700 ? 400 : f.weight, italic: !!(style & 2) }) },
    nativeUnref: () => {},
    nativeGetStyle: (v, s, [h]) => { const f = get<Face>(h); return f ? (f.weight >= 600 ? 1 : 0) | (f.italic ? 2 : 0) : 0 },
    nativeCreateFromAsset: () => put(face('', 0)),
    nativeCreateFromFile: () => put(face('', 0)),
  })

  // ---------- Bitmap ----------
  const B = (h: number): Bmp => get<Bmp>(h)
  const javaBitmap = (bm: Bmp, density = -1, chunk: Uint8Array | null = null, layout: number[] | null = null) => {
    const h = put(bm)
    let ch: JArray | null = null
    if (chunk) { ch = vm.newArray('[B', chunk.length); (ch.data as Int8Array).set(new Int8Array(chunk.buffer, chunk.byteOffset, chunk.length)) }
    let lb: JArray | null = null
    if (layout) { lb = vm.newArray('[I', 4); (lb.data as Int32Array).set(layout) }
    return vm.newObject('Landroid/graphics/Bitmap;', '<init>(I[BIIIZZ[B[I)V', [h, null, bm.w, bm.h, density, bm.mutable ? 1 : 0, 1, ch, lb])
  }
  const pixelsOf = (bm: Bmp, x = 0, y = 0, w = bm.w, h = bm.h) => bm.ctx ? bm.ctx.getImageData(x, y, w, h).data : new Uint8ClampedArray(w * h * 4)
  const argb = (d: Uint8ClampedArray, i: number) => ((d[i + 3] << 24) | (d[i] << 16) | (d[i + 1] << 8) | d[i + 2]) | 0
  vm.registerNatives('Landroid/graphics/Bitmap;', {
    nativeCreate: (v, s, [colors, off, stride, w, h, config, mutable]) => {
      const bm = newBmp(w, h, config, !!mutable)
      if (colors && bm.ctx) {
        const img = bm.ctx.createImageData(w, h), c = colors.data as Int32Array
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const p = c[off + y * stride + x], i = (y * w + x) * 4; img.data[i] = (p >> 16) & 255; img.data[i + 1] = (p >> 8) & 255; img.data[i + 2] = p & 255; img.data[i + 3] = (p >>> 24) & 255 }
        bm.ctx.putImageData(img, 0, 0)
      }
      return javaBitmap(bm)
    },
    nativeCopy: (v, s, [h, config, mutable]) => { const a = B(h), bm = newBmp(a.w, a.h, config, !!mutable); if (a.canvas && bm.ctx) bm.ctx.drawImage(a.canvas as CanvasImageSource, 0, 0); return javaBitmap(bm) },
    nativeDestructor: (v, s, [h]) => { H.delete(h) },
    nativeRecycle: (v, s, [h]) => { const b = B(h); if (b) { b.canvas = null; b.ctx = null } return 1 },
    nativeReconfigure: (v, s, [h, w, hh, config]) => { const b = B(h); Object.assign(b, newBmp(w, hh, config, b.mutable)) },
    nativeCompress: () => 0,
    nativeErase: (v, s, [h, c]) => { const b = B(h); if (b.ctx) { b.ctx.save(); b.ctx.setTransform(1, 0, 0, 1, 0, 0); b.ctx.globalCompositeOperation = 'copy'; b.ctx.fillStyle = rgba(c); b.ctx.fillRect(0, 0, b.w, b.h); b.ctx.restore() } b.gen++ },
    nativeRowBytes: (v, s, [h]) => B(h).w * (B(h).config === 5 ? 4 : B(h).config === 1 ? 1 : 2),
    nativeConfig: (v, s, [h]) => B(h).config,
    nativeGetPixel: (v, s, [h, x, y]) => argb(pixelsOf(B(h), x, y, 1, 1), 0),
    nativeGetPixels: (v, s, [h, out, off, stride, x, y, w, hh]) => { const d = pixelsOf(B(h), x, y, w, hh), o = out.data as Int32Array; for (let j = 0; j < hh; j++) for (let i = 0; i < w; i++) o[off + j * stride + i] = argb(d, (j * w + i) * 4) },
    nativeSetPixel: (v, s, [h, x, y, c]) => { const b = B(h); if (b.ctx) { b.ctx.save(); b.ctx.setTransform(1, 0, 0, 1, 0, 0); b.ctx.globalCompositeOperation = 'copy'; b.ctx.fillStyle = rgba(c); b.ctx.fillRect(x, y, 1, 1); b.ctx.restore() } b.gen++ },
    nativeSetPixels: (v, s, [h, colors, off, stride, x, y, w, hh]) => {
      const b = B(h); if (!b.ctx || w <= 0 || hh <= 0) return
      const img = b.ctx.createImageData(w, hh), c = colors.data as Int32Array
      for (let j = 0; j < hh; j++) for (let i = 0; i < w; i++) { const p = c[off + j * stride + i], k = (j * w + i) * 4; img.data[k] = (p >> 16) & 255; img.data[k + 1] = (p >> 8) & 255; img.data[k + 2] = p & 255; img.data[k + 3] = (p >>> 24) & 255 }
      b.ctx.putImageData(img, x, y); b.gen++
    },
    nativeCopyPixelsToBuffer: (v, s, [h, buf]) => { const d = pixelsOf(B(h)); const bb = buf.f; if (bb?.u8) (bb.u8 as Uint8Array).set(d.subarray(0, Math.min(d.length, bb.u8.length))) },
    nativeCopyPixelsFromBuffer: (v, s, [h, buf]) => { const b = B(h); const u8 = buf.f?.u8 as Uint8Array | undefined; if (!b.ctx || !u8) return; const img = b.ctx.createImageData(b.w, b.h); img.data.set(u8.subarray(0, img.data.length)); b.ctx.putImageData(img, 0, 0); b.gen++ },
    nativeGenerationId: (v, s, [h]) => B(h).gen,
    nativeCreateFromParcel: () => null, nativeWriteToParcel: () => 0,
    nativeExtractAlpha: (v, s, [h]) => { const a = B(h), bm = newBmp(a.w, a.h, 1); if (a.canvas && bm.ctx) bm.ctx.drawImage(a.canvas as CanvasImageSource, 0, 0); return javaBitmap(bm) },
    nativePrepareToDraw: () => {},
    nativeHasAlpha: (v, s, [h]) => (B(h).alpha ? 1 : 0),
    nativeSetAlphaAndPremultiplied: (v, s, [h, a]) => { B(h).alpha = !!a },
    nativeSetHasAlpha: (v, s, [h, a]) => { B(h).alpha = !!a },
    nativeHasMipMap: () => 0, nativeSetHasMipMap: () => {},
    nativeSameAs: (v, s, [a, b]) => (a === b ? 1 : 0),
  })

  // ---------- decoding: size and nine-patch data at once from the file, pixels when the browser has them ----------
  const be32 = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3])
  const info = (b: Uint8Array) => {
    let w = 0, h = 0, mime = '', chunk: Uint8Array | null = null, layout: number[] | null = null
    if (b[0] === 0x89 && b[1] === 0x50) {
      mime = 'image/png'; w = be32(b, 16); h = be32(b, 20)
      for (let o = 8; o + 8 <= b.length;) {
        const len = be32(b, o) >>> 0, type = String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7])
        if (type === 'npTc') chunk = b.slice(o + 8, o + 8 + len)
        if (type === 'npLb') layout = [be32(b, o + 8), be32(b, o + 12), be32(b, o + 16), be32(b, o + 20)]
        if (type === 'IDAT' || type === 'IEND') break
        o += 12 + len
      }
    } else if (b[0] === 0xff && b[1] === 0xd8) {
      mime = 'image/jpeg'
      for (let i = 2; i + 9 < b.length;) { if (b[i] !== 0xff) { i++; continue } const m = b[i + 1], len = (b[i + 2] << 8) | b[i + 3]; if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) { h = (b[i + 5] << 8) | b[i + 6]; w = (b[i + 7] << 8) | b[i + 8]; break } i += 2 + len }
    } else if (b[0] === 0x47 && b[1] === 0x49) { mime = 'image/gif'; w = b[6] | (b[7] << 8); h = b[8] | (b[9] << 8) }
    else if (b[0] === 0x52 && b[8] === 0x57) {
      mime = 'image/webp'
      const k = String.fromCharCode(b[12], b[13], b[14], b[15])
      if (k === 'VP8 ') { w = (b[26] | (b[27] << 8)) & 0x3fff; h = (b[28] | (b[29] << 8)) & 0x3fff }
      else if (k === 'VP8L') { const x = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24); w = (x & 0x3fff) + 1; h = ((x >> 14) & 0x3fff) + 1 }
      else if (k === 'VP8X') { w = 1 + (b[24] | (b[25] << 8) | (b[26] << 16)); h = 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) }
    }
    return { w, h, mime, chunk, layout }
  }
  // the nine-patch chunk's padding (file order is big-endian)
  const chunkPadding = (c: Uint8Array) => [be32(c, 12), be32(c, 20), be32(c, 16), be32(c, 24)] // left, top, right, bottom
  const decode = (b: Uint8Array | undefined, padding: JObject | null, opts: JObject | null) => {
    if (!b || b.length < 16) return null
    const inf = info(b)
    if (!inf.w || !inf.h) return null
    const sample = Math.max(1, opts?.f.inSampleSize | 0 || 1)
    let scale = 1
    if (opts && opts.f.inScaled !== 0 && opts.f.inDensity && opts.f.inTargetDensity && opts.f.inDensity !== opts.f.inTargetDensity && opts.f.inDensity !== 0xffff) scale = opts.f.inTargetDensity / opts.f.inDensity
    const w = Math.max(1, Math.round((inf.w / sample) * scale)), h = Math.max(1, Math.round((inf.h / sample) * scale))
    if (opts) { opts.f.outWidth = w; opts.f.outHeight = h; opts.f.outMimeType = inf.mime }
    let chunk = inf.chunk
    if (chunk && scale !== 1) chunk = scaleChunk(chunk, scale)
    if (padding && chunk) { const [l, t, r, bt] = chunkPadding(chunk); setRect(padding, l, t, r, bt) }
    if (opts?.f.inJustDecodeBounds) return null
    const bm = newBmp(w, h, 5, !!opts?.f.inMutable)
    // pixels arrive when the browser has decoded them; android draws the bitmap on its next frame
    if (bm.ctx && typeof createImageBitmap !== 'undefined') {
      const blob = new Blob([b.slice() as BlobPart], { type: inf.mime })
      createImageBitmap(blob).then((img) => { if (bm.ctx) { bm.ctx.drawImage(img, 0, 0, w, h); bm.gen++; hooks.redraw?.() } img.close?.() }).catch(() => {})
    }
    return javaBitmap(bm, -1, chunk, inf.layout)
  }
  const scaleChunk = (c: Uint8Array, k: number) => {
    const o = c.slice(), dv = new DataView(o.buffer)
    const nx = o[1], ny = o[2]
    for (let i = 12; i < 28; i += 4) dv.setInt32(i, Math.round(dv.getInt32(i) * k))
    for (let i = 0; i < nx + ny; i++) dv.setInt32(32 + i * 4, Math.round(dv.getInt32(32 + i * 4) * k))
    return o
  }
  const drainStream = (is: JObject, storage: JArray | null) => {
    const parts: Uint8Array[] = []
    const buf = storage ?? vm.newArray('[B', 16384)
    for (;;) {
      const n = vm.callVirtual(is, 'read([BII)I', [buf, 0, buf.data.length]) as number
      if (n <= 0) break
      parts.push(new Uint8Array((buf.data as Int8Array).buffer.slice((buf.data as Int8Array).byteOffset, (buf.data as Int8Array).byteOffset + n)))
    }
    const total = parts.reduce((a, p) => a + p.length, 0), out = new Uint8Array(total)
    let k = 0; for (const p of parts) { out.set(p, k); k += p.length }
    return out
  }
  vm.registerNatives('Landroid/graphics/BitmapFactory;', {
    nativeDecodeStream: (v, s, [is, storage, padding, opts]) => decode(drainStream(is, storage), padding, opts),
    nativeDecodeAsset: (v, s, [asset, padding, opts]) => decode(hooks.assetBytes?.(asset), padding, opts),
    nativeDecodeByteArray: (v, s, [a, off, len, opts]) => decode(new Uint8Array((a.data as Int8Array).buffer, (a.data as Int8Array).byteOffset + off, len), null, opts),
    nativeDecodeFileDescriptor: () => null,
    nativeIsSeekable: () => 0,
  })
  vm.registerNatives('Landroid/graphics/BitmapFactory$Options;', { requestCancel: () => {} })

  // ---------- shaders, filters, modes ----------
  vm.registerNatives('Landroid/graphics/Shader;', {
    nativeDestructor: (v, s, [h]) => { H.delete(h) },
    nativeSetLocalMatrix: (v, s, [h, , m]) => { const sh = get<Shader>(h); if (sh) sh.local = m ? new Float64Array(Mx(m)) : null },
  })
  vm.registerNatives('Landroid/graphics/BitmapShader;', { nativeCreate: (v, s, [bm, tx, ty]) => put({ kind: 'bitmap', args: { bm, tx, ty }, local: null }), nativePostCreate: () => 0 })
  const stops = (colors: JArray | number[], pos: JArray | null) => { const c = Array.isArray(colors) ? colors : [...(colors.data as Int32Array)]; const p = pos ? [...(pos.data as Float32Array)] : c.map((_, i) => i / Math.max(1, c.length - 1)); return c.map((x, i) => [p[i], x] as [number, number]) }
  vm.registerNatives('Landroid/graphics/LinearGradient;', {
    nativeCreate1: (v, s, [x0, y0, x1, y1, colors, pos, tile]) => put({ kind: 'linear', args: { x0, y0, x1, y1, stops: stops(colors, pos), tile }, local: null }),
    nativeCreate2: (v, s, [x0, y0, x1, y1, c0, c1, tile]) => put({ kind: 'linear', args: { x0, y0, x1, y1, stops: stops([c0, c1], null), tile }, local: null }),
    nativePostCreate1: () => 0, nativePostCreate2: () => 0,
  })
  vm.registerNatives('Landroid/graphics/RadialGradient;', {
    nativeCreate1: (v, s, [x, y, r, colors, pos, tile]) => put({ kind: 'radial', args: { x, y, r, stops: stops(colors, pos), tile }, local: null }),
    nativeCreate2: (v, s, [x, y, r, c0, c1, tile]) => put({ kind: 'radial', args: { x, y, r, stops: stops([c0, c1], null), tile }, local: null }),
    nativePostCreate1: () => 0, nativePostCreate2: () => 0,
  })
  vm.registerNatives('Landroid/graphics/SweepGradient;', {
    nativeCreate1: (v, s, [x, y, colors, pos]) => put({ kind: 'sweep', args: { x, y, stops: stops(colors, pos) }, local: null }),
    nativeCreate2: (v, s, [x, y, c0, c1]) => put({ kind: 'sweep', args: { x, y, stops: stops([c0, c1], null) }, local: null }),
    nativePostCreate1: () => 0, nativePostCreate2: () => 0,
  })
  vm.registerNatives('Landroid/graphics/ComposeShader;', { nativeCreate1: (v, s, [a]) => put({ ...get<Shader>(a) }), nativeCreate2: (v, s, [a]) => put({ ...get<Shader>(a) }), nativePostCreate1: () => 0, nativePostCreate2: () => 0 })
  vm.registerNatives('Landroid/graphics/ColorFilter;', { finalizer: (v, s, [h]) => { H.delete(h) } })
  vm.registerNatives('Landroid/graphics/PorterDuffColorFilter;', { native_CreatePorterDuffFilter: (v, s, [c, mode]) => put({ kind: 'pd', color: c, mode }), nCreatePorterDuffFilter: () => 0 })
  vm.registerNatives('Landroid/graphics/LightingColorFilter;', { native_CreateLightingFilter: (v, s, [m, a]) => put({ kind: 'lighting', mul: m, add: a }), nCreateLightingFilter: () => 0 })
  vm.registerNatives('Landroid/graphics/ColorMatrixColorFilter;', { nativeColorMatrixFilter: (v, s, [a]) => put({ kind: 'matrix', m: [...(a.data as Float32Array)] }), nColorMatrixFilter: () => 0 })
  vm.registerNatives('Landroid/graphics/Xfermode;', { finalizer: (v, s, [h]) => { H.delete(h) } })
  vm.registerNatives('Landroid/graphics/PorterDuffXfermode;', { nativeCreateXfermode: (v, s, [mode]) => put({ mode }) })
  vm.registerNatives('Landroid/graphics/AvoidXfermode;', { nativeCreate: () => put({ mode: 3 }) })
  vm.registerNatives('Landroid/graphics/PixelXorXfermode;', { nativeCreate: () => put({ mode: 11 }) })
  vm.registerNatives('Landroid/graphics/MaskFilter;', { nativeDestructor: (v, s, [h]) => { H.delete(h) } })
  vm.registerNatives('Landroid/graphics/BlurMaskFilter;', { nativeConstructor: (v, s, [r, style]) => put({ blur: r, style }) })
  vm.registerNatives('Landroid/graphics/EmbossMaskFilter;', { nativeConstructor: () => put({}) })
  vm.registerNatives('Landroid/graphics/PathEffect;', { nativeDestructor: (v, s, [h]) => { H.delete(h) } })
  vm.registerNatives('Landroid/graphics/DashPathEffect;', { nativeCreate: (v, s, [iv, phase]) => put({ dash: [...(iv.data as Float32Array)], phase }) })
  vm.registerNatives('Landroid/graphics/CornerPathEffect;', { nativeCreate: (v, s, [r]) => put({ corner: r }) })
  vm.registerNatives('Landroid/graphics/DiscretePathEffect;', { nativeCreate: () => put({}) })
  vm.registerNatives('Landroid/graphics/ComposePathEffect;', { nativeCreate: (v, s, [a]) => put({ ...get<any>(a) }) })
  vm.registerNatives('Landroid/graphics/SumPathEffect;', { nativeCreate: (v, s, [a]) => put({ ...get<any>(a) }) })
  vm.registerNatives('Landroid/graphics/DrawFilter;', { nativeDestructor: (v, s, [h]) => { H.delete(h) } })
  vm.registerNatives('Landroid/graphics/PaintFlagsDrawFilter;', { nativeConstructor: (v, s, [clear, set]) => put({ clear, set }) })
  vm.registerNatives('Landroid/graphics/Rasterizer;', { finalizer: () => {} })
  vm.registerNatives('Landroid/graphics/LayerRasterizer;', { nativeConstructor: () => put({}), nativeAddLayer: () => {} })

  // porter-duff modes -> composite operations
  const PD = ['clear', 'copy', 'destination-over', 'source-over', 'destination-over', 'source-in', 'destination-in', 'source-out', 'destination-out', 'source-atop', 'destination-atop', 'xor', 'darken', 'lighten', 'multiply', 'screen', 'lighter', 'overlay'] as GlobalCompositeOperation[]
  // CLEAR SRC DST SRC_OVER DST_OVER SRC_IN DST_IN SRC_OUT DST_OUT SRC_ATOP DST_ATOP XOR DARKEN LIGHTEN MULTIPLY SCREEN ADD OVERLAY
  const filtered = (c: number, cf: ColorFilter | undefined) => {
    if (!cf) return c
    if (cf.kind === 'pd') {
      const m = cf.mode!, fc = cf.color!
      if (m === 5 || m === 9 || m === 1) return ((((c >>> 24) * (fc >>> 24)) / 255) << 24) | (fc & 0xffffff) // SRC_IN / SRC_ATOP / SRC: the filter color, our alpha
      if (m === 14) { const r = (((c >> 16) & 255) * ((fc >> 16) & 255)) / 255, g = (((c >> 8) & 255) * ((fc >> 8) & 255)) / 255, b = ((c & 255) * (fc & 255)) / 255; return (c & 0xff000000) | (r << 16) | (g << 8) | b }
      return c
    }
    if (cf.kind === 'lighting') {
      const ch = (sh: number) => Math.min(255, ((((c >> sh) & 255) * ((cf.mul! >> sh) & 255)) / 255) + ((cf.add! >> sh) & 255))
      return (c & 0xff000000) | (ch(16) << 16) | (ch(8) << 8) | ch(0)
    }
    if (cf.kind === 'matrix') {
      const m = cf.m!, r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255, a = c >>> 24
      const o = (i: number) => Math.max(0, Math.min(255, m[i] * r + m[i + 1] * g + m[i + 2] * b + m[i + 3] * a + m[i + 4]))
      return (o(15) << 24) | (o(0) << 16) | (o(5) << 8) | o(10)
    }
    return c
  }

  // ---------- Canvas ----------
  interface Layer { bm: Bmp; parent: Bmp; alpha: number; mode: GlobalCompositeOperation; x: number; y: number }
  interface State { m: M; clip: [number, number, number, number]; layer?: Layer; ctxSaves: number }
  interface Cv { bm: Bmp | null; m: M; clip: [number, number, number, number]; stack: State[]; filter: any; surface?: any }
  const C = (h: number): Cv => get<Cv>(h)
  const CS = (s: JObject): Cv => C(s.f.mNativeCanvas)
  const newCv = (bm: Bmp | null): Cv => ({ bm, m: ident(), clip: [0, 0, bm?.w ?? 0, bm?.h ?? 0], stack: [], filter: null })
  const ctxOf = (cv: Cv) => cv.bm?.ctx ?? null
  const applyM = (cv: Cv, ctx: NonNullable<Bmp['ctx']>) => { const m = cv.m; ctx.setTransform(m[0], m[3], m[1], m[4], m[2], m[5]) }
  const touch = (cv: Cv) => { if (cv.bm) cv.bm.gen++ }
  // style a context for a paint
  const style = (cv: Cv, ctx: NonNullable<Bmp['ctx']>, p: Paint, stroke: boolean) => {
    const cf = get<ColorFilter>(p.colorFilter)
    const color = filtered(p.color, cf)
    const sh = get<Shader>(p.shader)
    let fill: string | CanvasGradient | CanvasPattern = rgba(color)
    if (sh) {
      const a = sh.args
      if (sh.kind === 'linear') { const g = ctx.createLinearGradient(a.x0, a.y0, a.x1, a.y1); for (const [o, c] of a.stops) g.addColorStop(Math.max(0, Math.min(1, o)), rgba(filtered(c, cf))); fill = g }
      else if (sh.kind === 'radial') { const g = ctx.createRadialGradient(a.x, a.y, 0, a.x, a.y, a.r); for (const [o, c] of a.stops) g.addColorStop(Math.max(0, Math.min(1, o)), rgba(filtered(c, cf))); fill = g }
      else if (sh.kind === 'sweep' && 'createConicGradient' in ctx) { const g = (ctx as any).createConicGradient(0, a.x, a.y); for (const [o, c] of a.stops) g.addColorStop(Math.max(0, Math.min(1, o)), rgba(filtered(c, cf))); fill = g }
      else if (sh.kind === 'bitmap') { const bm = B(a.bm); const rep = a.tx === 1 && a.ty === 1 ? 'repeat' : a.tx === 1 ? 'repeat-x' : a.ty === 1 ? 'repeat-y' : 'no-repeat'; const pat = bm?.canvas ? ctx.createPattern(bm.canvas as CanvasImageSource, rep) : null; if (pat) { if (sh.local && (pat as any).setTransform) { const l = sh.local; (pat as any).setTransform(new DOMMatrix([l[0], l[3], l[1], l[4], l[2], l[5]])) } fill = pat } }
      if (sh.kind !== 'bitmap' && sh.local && typeof fill !== 'string') { /* gradients follow the canvas matrix; a local matrix is folded in by the caller */ }
      ctx.globalAlpha = (p.color >>> 24) / 255
    } else ctx.globalAlpha = 1
    if (stroke) ctx.strokeStyle = fill; else ctx.fillStyle = fill
    const xf = get<{ mode: number }>(p.xfermode)
    ctx.globalCompositeOperation = xf ? PD[xf.mode] ?? 'source-over' : 'source-over'
    const scale = Math.sqrt(Math.abs(cv.m[0] * cv.m[4] - cv.m[1] * cv.m[3])) || 1
    ctx.lineWidth = p.strokeWidth > 0 ? p.strokeWidth : 1 / scale
    ctx.lineCap = (['butt', 'round', 'square'] as CanvasLineCap[])[p.cap] ?? 'butt'
    ctx.lineJoin = (['miter', 'round', 'bevel'] as CanvasLineJoin[])[p.join] ?? 'miter'
    ctx.miterLimit = p.miter
    const pe = get<any>(p.pathEffect)
    ctx.setLineDash(pe?.dash ?? []); ctx.lineDashOffset = pe?.phase ?? 0
    if (p.shadow) { ctx.shadowBlur = p.shadow.r * scale; ctx.shadowOffsetX = p.shadow.dx * scale; ctx.shadowOffsetY = p.shadow.dy * scale; ctx.shadowColor = rgba(p.shadow.color) }
    else { ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0; ctx.shadowColor = 'transparent' }
    ctx.imageSmoothingEnabled = !!(p.flags & F.FILTER) || true
  }
  const shape = (cv: Cv, p: Paint | null, draw: (ctx: NonNullable<Bmp['ctx']>) => void, path2?: Path2D, fillRule: CanvasFillRule = 'nonzero') => {
    const ctx = ctxOf(cv); if (!ctx || !p) return
    ctx.save(); applyM(cv, ctx)
    ctx.beginPath(); draw(ctx)
    if (p.style !== 1) { style(cv, ctx, p, false); path2 ? ctx.fill(path2, fillRule) : ctx.fill(fillRule) }
    if (p.style !== 0) { style(cv, ctx, p, true); path2 ? ctx.stroke(path2) : ctx.stroke() }
    ctx.restore(); touch(cv)
  }
  const drawImg = (cv: Cv, bm: Bmp, p: Paint | null, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number, extra?: M) => {
    const ctx = ctxOf(cv); if (!ctx || !bm?.canvas || sw <= 0 || sh <= 0) return
    ctx.save(); applyM(cv, ctx)
    if (extra) ctx.transform(extra[0], extra[3], extra[1], extra[4], extra[2], extra[5])
    ctx.globalAlpha = p ? (p.color >>> 24) / 255 : 1
    const xf = p && get<{ mode: number }>(p.xfermode)
    ctx.globalCompositeOperation = xf ? PD[xf.mode] ?? 'source-over' : 'source-over'
    ctx.imageSmoothingEnabled = !p || !!(p.flags & F.FILTER) || Math.abs(dw - sw) > 0.5
    const cf = p && get<ColorFilter>(p.colorFilter)
    let src: CanvasImageSource = bm.canvas as CanvasImageSource
    if (cf && (cf.kind === 'pd' || cf.kind === 'lighting' || cf.kind === 'matrix')) src = tinted(bm, cf) ?? src
    ctx.drawImage(src, sx, sy, sw, sh, dx, dy, dw, dh)
    ctx.restore(); touch(cv)
  }
  // a bitmap through a color filter (kept until the bitmap or the filter changes)
  const tintCache = new WeakMap<Bmp, { key: string; c: any }>()
  const tinted = (bm: Bmp, cf: ColorFilter) => {
    const key = JSON.stringify(cf) + '|' + bm.gen
    const hit = tintCache.get(bm)
    if (hit?.key === key) return hit.c
    const t = newBmp(bm.w, bm.h)
    if (!t.ctx || !bm.canvas) return null
    t.ctx.drawImage(bm.canvas as CanvasImageSource, 0, 0)
    if (cf.kind === 'pd' && (cf.mode === 5 || cf.mode === 9 || cf.mode === 1)) { t.ctx.globalCompositeOperation = 'source-in'; t.ctx.fillStyle = rgba(cf.color!); t.ctx.fillRect(0, 0, bm.w, bm.h) }
    else if (cf.kind === 'pd' && cf.mode === 14) { t.ctx.globalCompositeOperation = 'multiply'; t.ctx.fillStyle = rgba(cf.color!); t.ctx.fillRect(0, 0, bm.w, bm.h); t.ctx.globalCompositeOperation = 'destination-in'; t.ctx.drawImage(bm.canvas as CanvasImageSource, 0, 0) }
    else {
      const img = t.ctx.getImageData(0, 0, bm.w, bm.h), d = img.data
      for (let i = 0; i < d.length; i += 4) { const c = filtered(((d[i + 3] << 24) | (d[i] << 16) | (d[i + 1] << 8) | d[i + 2]) | 0, cf); d[i] = (c >> 16) & 255; d[i + 1] = (c >> 8) & 255; d[i + 2] = c & 255; d[i + 3] = (c >>> 24) & 255 }
      t.ctx.putImageData(img, 0, 0)
    }
    tintCache.set(bm, { key, c: t.canvas })
    return t.canvas
  }
  const intersect = (a: [number, number, number, number], b: [number, number, number, number]): [number, number, number, number] => [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])]
  const clipShape = (cv: Cv, op: number, build: (ctx: NonNullable<Bmp['ctx']>) => void, dev: [number, number, number, number]) => {
    const ctx = ctxOf(cv)
    // INTERSECT 1, REPLACE 5: narrow; DIFFERENCE 0: cut out; UNION 2, XOR 3, REVERSE_DIFFERENCE 4: keep the bounds
    if (op === 1 || op === 5) {
      if (ctx) { applyM(cv, ctx); ctx.beginPath(); build(ctx); ctx.clip() }
      cv.clip = op === 5 ? dev : intersect(cv.clip, dev)
    } else if (op === 0 && ctx) {
      applyM(cv, ctx); ctx.beginPath(); ctx.rect(-1e5, -1e5, 2e5, 2e5); build(ctx); ctx.clip('evenodd')
    }
    return cv.clip[2] > cv.clip[0] && cv.clip[3] > cv.clip[1] ? 1 : 0
  }
  const rectClip = (cv: Cv, l: number, t: number, r: number, b: number, op = 1) => clipShape(cv, op, (ctx) => ctx.rect(l, t, r - l, b - t), mapRect(cv.m, l, t, r, b))
  const save = (cv: Cv) => { const ctx = ctxOf(cv); ctx?.save(); cv.stack.push({ m: new Float64Array(cv.m), clip: [...cv.clip] as State['clip'], ctxSaves: 1 }); return cv.stack.length }
  const restore = (cv: Cv) => {
    const st = cv.stack.pop()
    if (!st) return
    if (st.layer) {
      // a saveLayer: the layer's pixels go back onto what was under it
      const L = st.layer, under = L.parent.ctx
      cv.bm = L.parent
      if (under && L.bm.canvas) { under.save(); under.setTransform(1, 0, 0, 1, 0, 0); under.globalAlpha = L.alpha; under.globalCompositeOperation = L.mode; under.drawImage(L.bm.canvas as CanvasImageSource, 0, 0); under.restore() }
      L.parent.gen++
    } else ctxOf(cv)?.restore()
    cv.m = st.m; cv.clip = st.clip
  }
  const saveLayer = (cv: Cv, l: number, t: number, r: number, b: number, alpha: number, mode: GlobalCompositeOperation) => {
    const n = save(cv)
    const parent = cv.bm
    if (!parent?.ctx) return n
    ctxOf(cv)?.restore() // the layer has its own context; the save above only keeps our state
    const layer = newBmp(parent.w, parent.h)
    cv.stack[cv.stack.length - 1].layer = { bm: layer, parent, alpha, mode, x: 0, y: 0 }
    cv.bm = layer
    // the layer starts with the current clip (and the bounds given)
    if (layer.ctx) { const c = intersect(cv.clip, mapRect(cv.m, l, t, r, b)); layer.ctx.beginPath(); layer.ctx.rect(c[0], c[1], c[2] - c[0], c[3] - c[1]); layer.ctx.clip(); layer.ctx.save() }
    return n
  }
  const textAt = (cv: Cv, p: Paint, str: string, x: number, y: number) => {
    const ctx = ctxOf(cv); if (!ctx || !str) return
    ctx.save(); applyM(cv, ctx)
    style(cv, ctx, p, false)
    ctx.font = fontOf(p)
    ctx.textBaseline = 'alphabetic'
    ctx.textAlign = (['left', 'center', 'right'] as CanvasTextAlign[])[p.align] ?? 'left'
    if (p.scaleX !== 1 || p.skewX) { ctx.translate(x, y); ctx.transform(p.scaleX, 0, p.skewX, 1, 0, 0); x = 0; y = 0 }
    if (p.style === 1) { style(cv, ctx, p, true); ctx.strokeText(str, x, y) } else ctx.fillText(str, x, y)
    if (p.flags & (F.UNDERLINE | F.STRIKE)) {
      const w = advances(p, str) / (p.scaleX || 1), x0 = p.align === 1 ? x - w / 2 : p.align === 2 ? x - w : x
      const th = Math.max(1, p.textSize / 18)
      if (p.flags & F.UNDERLINE) ctx.fillRect(x0, y + p.textSize * 0.11, w, th)
      if (p.flags & F.STRIKE) ctx.fillRect(x0, y - p.textSize * 0.3, w, th)
    }
    ctx.restore(); touch(cv)
  }
  const paintOf = (h: number) => (h ? PH(h) : null)
  vm.registerNatives('Landroid/graphics/Canvas;', {
    initRaster: (v, s, [bmh]) => put(newCv(bmh ? B(bmh) : null)),
    finalizer: (v, s, [h]) => { H.delete(h) },
    copyNativeCanvasState: (v, s, [a, b]) => { const x = C(a), y = C(b); y.m = new Float64Array(x.m); y.clip = [...x.clip] as any },
    freeCaches: () => { widthCache.clear() }, freeTextLayoutCaches: () => { widthCache.clear() },
    isOpaque: (v, s) => (CS(s).bm && !CS(s).bm!.alpha ? 1 : 0),
    getWidth: (v, s) => CS(s).bm?.w ?? 0, getHeight: (v, s) => CS(s).bm?.h ?? 0,
    save: (v, s) => save(CS(s)), // the count before this save (that is what restoreToCount takes)
    restore: (v, s) => { const cv = CS(s); if (!cv.stack.length) throw vm.error('Ljava/lang/IllegalStateException;', 'Underflow in restore'); restore(cv) },
    getSaveCount: (v, s) => CS(s).stack.length + 1,
    restoreToCount: (v, s, [n]) => { const cv = CS(s); if (n < 1) throw vm.error('Ljava/lang/IllegalArgumentException;', 'Underflow in restoreToCount'); while (cv.stack.length >= n) restore(cv) },
    translate: (v, s, [dx, dy]) => { const cv = CS(s); cv.m = mul(cv.m, translateM(dx, dy)) },
    scale: (v, s, [sx, sy]) => { const cv = CS(s); cv.m = mul(cv.m, scaleM(sx, sy)) },
    rotate: (v, s, [d]) => { const cv = CS(s); cv.m = mul(cv.m, rotateM(d)) },
    skew: (v, s, [sx, sy]) => { const cv = CS(s); cv.m = mul(cv.m, skewM(sx, sy)) },
    clipRect: (v, s, [a, b, c, d]) => { const cv = CS(s); return typeof a === 'object' && a ? rectClip(cv, ...rectOf(a)) : rectClip(cv, a, b, c, d) },
    native_clipRect: (v, s, [h, l, t, r, b, op]) => rectClip(C(h), l, t, r, b, op),
    native_clipPath: (v, s, [h, ph, op]) => {
      const cv = C(h), p = P(ph), dev = mapRect(cv.m, ...bounds(p)), ctx = ctxOf(cv)
      if (op === 1 || op === 5) { if (ctx) { applyM(cv, ctx); ctx.clip(path2d(p), p.fill & 1 ? 'evenodd' : 'nonzero') } cv.clip = op === 5 ? dev : intersect(cv.clip, dev) }
      else if (op === 0 && ctx) { applyM(cv, ctx); const q = new Path2D(); q.rect(-1e5, -1e5, 2e5, 2e5); q.addPath(path2d(p)); ctx.clip(q, 'evenodd') }
      return cv.clip[2] > cv.clip[0] && cv.clip[3] > cv.clip[1] ? 1 : 0
    },
    native_clipRegion: (v, s, [h, rh, op]) => { const rg = get<Rg>(rh); return rg ? clipShape(C(h), op, (ctx) => { for (const r of rg.rects) ctx.rect(r[0], r[1], r[2] - r[0], r[3] - r[1]) }, rg.bounds) : 1 },
    native_saveLayer: (v, s, [h, a, b, c, d, paint]) => { const cv = C(h); const [l, t, r, bt] = typeof a === 'object' && a ? rectOf(a) : a == null ? [-1e5, -1e5, 1e5, 1e5] : [a, b, c, d]; const p = typeof a === 'object' ? paintOf(b) : paintOf(paint); const xf = p && get<{ mode: number }>(p.xfermode); return saveLayer(cv, l, t, r, bt, p ? (p.color >>> 24) / 255 : 1, xf ? PD[xf.mode] ?? 'source-over' : 'source-over') },
    native_saveLayerAlpha: (v, s, [h, a, b, c, d, alpha]) => { const cv = C(h); const [l, t, r, bt] = typeof a === 'object' && a ? rectOf(a) : a == null ? [-1e5, -1e5, 1e5, 1e5] : [a, b, c, d]; const al = typeof a === 'object' ? b : alpha; return saveLayer(cv, l, t, r, bt, (al & 255) / 255, 'source-over') },
    native_concat: (v, s, [h, m]) => { const cv = C(h); cv.m = mul(cv.m, Mx(m)) },
    native_setMatrix: (v, s, [h, m]) => { const cv = C(h); cv.m = m ? new Float64Array(Mx(m)) : ident() },
    nativeSetDrawFilter: (v, s, [h, f]) => { C(h).filter = f ? get(f) : null },
    native_getClipBounds: (v, s, [h, r]) => {
      const cv = C(h), inv = invert(cv.m)
      const [l, t, rr, b] = inv ? mapRect(inv, ...cv.clip) : cv.clip
      if (r) setRect(r, Math.floor(l), Math.floor(t), Math.ceil(rr), Math.ceil(b))
      return rr > l && b > t ? 1 : 0
    },
    native_getCTM: (v, s, [h, m]) => setM(m, C(h).m),
    native_quickReject: (v, s, [h, a, b, c, d]) => {
      const cv = C(h)
      const [l, t, r, bt] = typeof a === 'object' && a ? (isRectF(a) ? rectOf(a) : [0, 0, 0, 0]) : typeof a === 'number' && b === undefined ? bounds(P(a)) : [a, b, c, d]
      const dev = mapRect(cv.m, l, t, r, bt), cl = cv.clip
      return dev[2] <= cl[0] || dev[0] >= cl[2] || dev[3] <= cl[1] || dev[1] >= cl[3] ? 1 : 0
    },
    native_drawRGB: (v, s, [h, r, g, b]) => fillAll(C(h), (0xff << 24) | (r << 16) | (g << 8) | b, 3),
    native_drawARGB: (v, s, [h, a, r, g, b]) => fillAll(C(h), (a << 24) | (r << 16) | (g << 8) | b, 3),
    native_drawColor: (v, s, [h, c, mode]) => fillAll(C(h), c, mode ?? 3),
    native_drawPaint: (v, s, [h, p]) => { const cv = C(h), ctx = ctxOf(cv); if (!ctx) return; ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); style(cv, ctx, PH(p), false); ctx.fillRect(cv.clip[0], cv.clip[1], cv.clip[2] - cv.clip[0], cv.clip[3] - cv.clip[1]); ctx.restore(); touch(cv) },
    drawPoint: (v, s, [x, y, p]) => { const pt = Pt(p); const w = pt.strokeWidth || 1; shape(CS(s), { ...pt, style: 0 }, (ctx) => pt.cap === 1 ? ctx.arc(x, y, w / 2, 0, Math.PI * 2) : ctx.rect(x - w / 2, y - w / 2, w, w)) },
    drawPoints: (v, s, [pts, off, n, p]) => { const a = floatsOf(pts), pt = Pt(p), w = pt.strokeWidth || 1; shape(CS(s), { ...pt, style: 0 }, (ctx) => { for (let i = 0; i + 1 < n; i += 2) { const x = a[off + i], y = a[off + i + 1]; if (pt.cap === 1) { ctx.moveTo(x + w / 2, y); ctx.arc(x, y, w / 2, 0, Math.PI * 2) } else ctx.rect(x - w / 2, y - w / 2, w, w) } }) },
    native_drawLine: (v, s, [h, x0, y0, x1, y1, p]) => shape(C(h), { ...PH(p), style: 1 }, (ctx) => { ctx.moveTo(x0, y0); ctx.lineTo(x1, y1) }),
    drawLines: (v, s, [pts, off, n, p]) => { const a = floatsOf(pts); shape(CS(s), { ...Pt(p), style: 1 }, (ctx) => { for (let i = 0; i + 3 < n; i += 4) { ctx.moveTo(a[off + i], a[off + i + 1]); ctx.lineTo(a[off + i + 2], a[off + i + 3]) } }) },
    native_drawRect: (v, s, [h, a, b, c, d, e]) => { const [l, t, r, bt, p] = typeof a === 'object' ? [...rectOf(a), b] : [a, b, c, d, e]; shape(C(h), PH(p), (ctx) => ctx.rect(l, t, r - l, bt - t)) },
    native_drawOval: (v, s, [h, o, p]) => { const [l, t, r, b] = rectOf(o); shape(C(h), PH(p), (ctx) => ctx.ellipse((l + r) / 2, (t + b) / 2, Math.abs(r - l) / 2, Math.abs(b - t) / 2, 0, 0, Math.PI * 2)) },
    native_drawCircle: (v, s, [h, x, y, r, p]) => shape(C(h), PH(p), (ctx) => ctx.arc(x, y, Math.max(0, r), 0, Math.PI * 2)),
    native_drawArc: (v, s, [h, o, start, sweep, center, p]) => { const [l, t, r, b] = rectOf(o); shape(C(h), PH(p), (ctx) => { const cx = (l + r) / 2, cy = (t + b) / 2; if (center) ctx.moveTo(cx, cy); ctx.ellipse(cx, cy, Math.abs(r - l) / 2, Math.abs(b - t) / 2, 0, (start * Math.PI) / 180, ((start + sweep) * Math.PI) / 180, sweep < 0); if (center) ctx.closePath() }) },
    native_drawRoundRect: (v, s, [h, o, rx, ry, p]) => { const [l, t, r, b] = rectOf(o); shape(C(h), PH(p), (ctx) => { const x = Math.min(rx, (r - l) / 2), y = Math.min(ry, (b - t) / 2); if ((ctx as any).roundRect && x === y) (ctx as any).roundRect(l, t, r - l, b - t, x); else { ctx.moveTo(l + x, t); ctx.lineTo(r - x, t); ctx.ellipse(r - x, t + y, x, y, 0, -Math.PI / 2, 0); ctx.lineTo(r, b - y); ctx.ellipse(r - x, b - y, x, y, 0, 0, Math.PI / 2); ctx.lineTo(l + x, b); ctx.ellipse(l + x, b - y, x, y, 0, Math.PI / 2, Math.PI); ctx.lineTo(l, t + y); ctx.ellipse(l + x, t + y, x, y, 0, Math.PI, Math.PI * 1.5); ctx.closePath() } }) },
    native_drawPath: (v, s, [h, ph, p]) => { const pa = P(ph); shape(C(h), PH(p), () => {}, path2d(pa), pa.fill & 1 ? 'evenodd' : 'nonzero') },
    native_drawBitmap: (v, s, args) => {
      if (args[1] instanceof Object && (args[1] as JArray).data) { // int[] colors
        const [h, colors, off, stride, x, y, w, hh, , p] = args
        const t = newBmp(w, hh); if (t.ctx) { const img = t.ctx.createImageData(w, hh), c = (colors as JArray).data as Int32Array; for (let j = 0; j < hh; j++) for (let i = 0; i < w; i++) { const px = c[off + j * stride + i], k = (j * w + i) * 4; img.data[k] = (px >> 16) & 255; img.data[k + 1] = (px >> 8) & 255; img.data[k + 2] = px & 255; img.data[k + 3] = (px >>> 24) & 255 } t.ctx.putImageData(img, 0, 0) }
        return drawImg(C(h), t, paintOf(p), 0, 0, w, hh, x, y, w, hh)
      }
      if (typeof args[2] === 'number') { // (canvas, bitmap, left, top, paint, canvasDensity, screenDensity, bitmapDensity)
        const [h, bh, x, y, p, cd, , bd] = args; const bm = B(bh)
        const k = cd && bd && cd !== bd ? cd / bd : 1
        return drawImg(C(h), bm, paintOf(p), 0, 0, bm.w, bm.h, x, y, bm.w * k, bm.h * k)
      }
      const [h, bh, src, dst, p] = args; const bm = B(bh)
      const [sl, st, sr, sb] = src ? rectOf(src) : [0, 0, bm.w, bm.h], [dl, dt, dr, db] = rectOf(dst)
      drawImg(C(h), bm, paintOf(p), sl, st, sr - sl, sb - st, dl, dt, dr - dl, db - dt)
    },
    nativeDrawBitmapMatrix: (v, s, [h, bh, m, p]) => { const bm = B(bh); drawImg(C(h), bm, paintOf(p), 0, 0, bm.w, bm.h, 0, 0, bm.w, bm.h, Mx(m)) },
    nativeDrawBitmapMesh: (v, s, [h, bh, , , , , , , p]) => { const bm = B(bh); drawImg(C(h), bm, paintOf(p), 0, 0, bm.w, bm.h, 0, 0, bm.w, bm.h) },
    nativeDrawVertices: () => {},
    native_drawText: (v, s, [h, a, b, c, x, y, , p]) => textAt(C(h), PH(p), typeof a === 'string' ? a.slice(b, c) : strOf(a, b, b + c), x, y),
    native_drawTextRun: (v, s, [h, a, start, end, , , x, y, , p]) => textAt(C(h), PH(p), typeof a === 'string' ? a.slice(start, end) : strOf(a, start, start + end), x, y),
    native_drawPosText: (v, s, [h, a, b, c, d, e]) => {
      const [str, pos, p] = typeof a === 'string' ? [a, floatsOf(b), c] : [strOf(a, b, b + c), floatsOf(d), e]
      for (let i = 0; i < str.length; i++) textAt(C(h), { ...PH(p), align: 0 }, str[i], pos[i * 2], pos[i * 2 + 1])
    },
    native_drawTextOnPath: (v, s, [h, a, b, c, d, e, f, , g]) => {
      const [str, ph, ho, vo, p] = typeof a === 'string' ? [a, b, c, d, f] : [strOf(a, b, b + c), d, e, f, g]
      const seg = flatten(P(ph))[0]; if (!seg) return
      textAt(C(h), PH(p), str, seg.pts[0][0] + ho, seg.pts[0][1] + vo)
    },
  })
  const fillAll = (cv: Cv, c: number, mode: number) => {
    const ctx = ctxOf(cv); if (!ctx) return
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalCompositeOperation = PD[mode] ?? 'source-over'; ctx.fillStyle = rgba(c); ctx.globalAlpha = 1
    const [l, t, r, b] = cv.clip
    if (mode === 0) ctx.clearRect(l, t, r - l, b - t); else ctx.fillRect(l, t, r - l, b - t)
    ctx.restore(); touch(cv)
  }

  // ---------- nine patches ----------
  vm.registerNatives('Landroid/graphics/NinePatch;', {
    isNinePatchChunk: (v, s, [c]) => (c && c.data.length >= 32 && c.data[0] !== -1 ? 1 : 0),
    validateNinePatchChunk: (v, s, [, c]) => put(new Uint8Array((c.data as Int8Array).buffer, (c.data as Int8Array).byteOffset, c.data.length).slice()),
    nativeFinalize: (v, s, [h]) => { H.delete(h) },
    nativeDraw: (v, s, [h, loc, bh, ch, p, destDensity, srcDensity]) => {
      const cv = C(h), bm = B(bh), c = get<Uint8Array>(ch)
      if (!bm || !c) return
      const [l, t, r, b] = rectOf(loc)
      const k = destDensity && srcDensity && destDensity !== srcDensity ? destDensity / srcDensity : 1
      ninePatch(cv, bm, c, paintOf(p), l, t, r, b, k)
    },
    nativeGetTransparentRegion: () => 0,
  })
  const ninePatch = (cv: Cv, bm: Bmp, c: Uint8Array, p: Paint | null, l: number, t: number, r: number, b: number, k: number) => {
    const nx = c[1], ny = c[2]
    const xs: number[] = [], ys: number[] = []
    for (let i = 0; i < nx; i++) xs.push(be32(c, 32 + i * 4))
    for (let i = 0; i < ny; i++) ys.push(be32(c, 32 + nx * 4 + i * 4))
    // segments along one axis: [srcStart, srcEnd, stretchable]
    const segs = (divs: number[], size: number) => {
      const out: [number, number, boolean][] = []
      let at = 0
      for (let i = 0; i + 1 < divs.length; i += 2) { if (divs[i] > at) out.push([at, divs[i], false]); out.push([divs[i], divs[i + 1], true]); at = divs[i + 1] }
      if (at < size) out.push([at, size, false])
      return out
    }
    const place = (sg: [number, number, boolean][], start: number, len: number) => {
      const fixed = sg.filter((x) => !x[2]).reduce((a, x) => a + (x[1] - x[0]) * k, 0)
      const stretchSrc = sg.filter((x) => x[2]).reduce((a, x) => a + (x[1] - x[0]), 0)
      const room = Math.max(0, len - fixed), shrink = fixed > len && fixed > 0 ? len / fixed : 1
      let at = start
      return sg.map(([a, z, st]) => { const w = st ? (stretchSrc ? (room * (z - a)) / stretchSrc : 0) : (z - a) * k * shrink; const d = [a, z, at, at + w] as [number, number, number, number]; at += w; return d })
    }
    const cx = place(segs(xs, bm.w), l, r - l), cy = place(segs(ys, bm.h), t, b - t)
    for (const [sy0, sy1, dy0, dy1] of cy) for (const [sx0, sx1, dx0, dx1] of cx) if (sx1 > sx0 && sy1 > sy0 && dx1 > dx0 && dy1 > dy0) drawImg(cv, bm, p, sx0, sy0, sx1 - sx0, sy1 - sy0, dx0, dy0, dx1 - dx0, dy1 - dy0)
  }

  // ---------- regions: a list of rectangles and their bounds ----------
  interface Rg { rects: [number, number, number, number][]; bounds: [number, number, number, number] }
  const RG = (h: number): Rg => get<Rg>(h)
  const rgBounds = (rects: Rg['rects']): Rg['bounds'] => rects.length ? [Math.min(...rects.map((x) => x[0])), Math.min(...rects.map((x) => x[1])), Math.max(...rects.map((x) => x[2])), Math.max(...rects.map((x) => x[3]))] : [0, 0, 0, 0]
  const rgOp = (dst: Rg, a: Rg['rects'], b: Rg['rects'], op: number) => {
    let rects: Rg['rects']
    switch (op) {
      case 1: rects = a.flatMap((x) => b.map((y) => intersect(x, y))).filter((x) => x[2] > x[0] && x[3] > x[1]); break // intersect
      case 2: case 3: rects = [...a, ...b]; break // union, xor
      case 5: rects = [...b]; break // replace
      case 0: rects = a; break // difference: keep (an approximation)
      case 4: rects = b; break
      default: rects = a
    }
    dst.rects = rects.filter((x) => x[2] > x[0] && x[3] > x[1]); dst.bounds = rgBounds(dst.rects)
    return dst.rects.length ? 1 : 0
  }
  vm.registerNatives('Landroid/graphics/Region;', {
    nativeConstructor: () => put({ rects: [], bounds: [0, 0, 0, 0] }),
    nativeDestructor: (v, s, [h]) => { H.delete(h) },
    nativeSetRegion: (v, s, [d, src]) => { const a = RG(src); Object.assign(RG(d), { rects: a.rects.map((x) => [...x]), bounds: [...a.bounds] }); return 1 },
    nativeSetRect: (v, s, [d, l, t, r, b]) => { const rr: Rg['rects'] = r > l && b > t ? [[l, t, r, b]] : []; Object.assign(RG(d), { rects: rr, bounds: rgBounds(rr) }); return rr.length ? 1 : 0 },
    nativeSetPath: (v, s, [d, ph, clip]) => { const bd = bounds(P(ph)), c = RG(clip).bounds, x = intersect(bd, c); const rr: Rg['rects'] = x[2] > x[0] && x[3] > x[1] ? [x] : []; Object.assign(RG(d), { rects: rr, bounds: rgBounds(rr) }); return rr.length ? 1 : 0 },
    nativeGetBounds: (v, s, [h, r]) => { const b = RG(h).bounds; setRect(r, b[0], b[1], b[2], b[3]); return RG(h).rects.length ? 1 : 0 },
    nativeGetBoundaryPath: (v, s, [h, ph]) => { for (const r of RG(h).rects) rectCmds(P(ph), ...r, 0); return RG(h).rects.length ? 1 : 0 },
    nativeOp: (v, s, args) => {
      if (args.length === 6) { const [d, l, t, r, b, op] = args; return rgOp(RG(d), RG(d).rects, [[l, t, r, b]], op) }
      if (args[1] && typeof args[1] === 'object') { const [d, rect, rg, op] = args; return rgOp(RG(d), [rectOf(rect)], RG(rg).rects, op) }
      const [d, a, b, op] = args; return rgOp(RG(d), RG(a).rects, RG(b).rects, op)
    },
    nativeCreateFromParcel: () => put({ rects: [], bounds: [0, 0, 0, 0] }), nativeWriteToParcel: () => 1,
    nativeEquals: (v, s, [a, b]) => (JSON.stringify(RG(a)) === JSON.stringify(RG(b)) ? 1 : 0),
    nativeToString: (v, s, [h]) => `Region(${RG(h).bounds.join(',')})`,
    isEmpty: (v, s) => (RG(s.f.mNativeRegion).rects.length ? 0 : 1),
    isRect: (v, s) => (RG(s.f.mNativeRegion).rects.length === 1 ? 1 : 0),
    isComplex: (v, s) => (RG(s.f.mNativeRegion).rects.length > 1 ? 1 : 0),
    contains: (v, s, [x, y]) => (RG(s.f.mNativeRegion).rects.some((r) => x >= r[0] && x < r[2] && y >= r[1] && y < r[3]) ? 1 : 0),
    quickContains: (v, s, [l, t, r, b]) => (RG(s.f.mNativeRegion).rects.some((x) => l >= x[0] && t >= x[1] && r <= x[2] && b <= x[3]) ? 1 : 0),
    quickReject: (v, s, [a, t, r, b]) => { const bd = RG(s.f.mNativeRegion).bounds; const o: Rg['bounds'] = typeof a === 'object' ? RG(a.f.mNativeRegion).bounds : [a, t, r, b]; return o[2] <= bd[0] || o[0] >= bd[2] || o[3] <= bd[1] || o[1] >= bd[3] ? 1 : 0 },
    translate: (v, s, [dx, dy, dst]) => { const src = RG(s.f.mNativeRegion), d = dst ? RG(dst.f.mNativeRegion) : src; d.rects = src.rects.map((r) => [r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy]); d.bounds = rgBounds(d.rects) },
    scale: (v, s, [k, dst]) => { const src = RG(s.f.mNativeRegion), d = dst ? RG(dst.f.mNativeRegion) : src; d.rects = src.rects.map((r) => r.map((x) => Math.round(x * k)) as any); d.bounds = rgBounds(d.rects) },
  })
  vm.registerNatives('Landroid/graphics/RegionIterator;', {
    nativeConstructor: (v, s, [rg]) => put({ rects: RG(rg).rects, i: 0 }),
    nativeDestructor: (v, s, [h]) => { H.delete(h) },
    nativeNext: (v, s, [h, r]) => { const it = get<any>(h); const x = it.rects[it.i++]; if (!x) return 0; setRect(r, ...(x as [number, number, number, number])); return 1 },
  })

  // ---------- path measure ----------
  vm.registerNatives('Landroid/graphics/PathMeasure;', {
    native_create: (v, s, [ph, closed]) => put({ segs: ph ? flatten(P(ph)) : [], i: 0, closed: !!closed }),
    native_setPath: (v, s, [h, ph]) => { Object.assign(get<any>(h), { segs: ph ? flatten(P(ph)) : [], i: 0 }) },
    native_getLength: (v, s, [h]) => { const seg = get<any>(h).segs[get<any>(h).i]; if (!seg) return 0; let L = 0; for (let k = 1; k < seg.pts.length; k++) L += Math.hypot(seg.pts[k][0] - seg.pts[k - 1][0], seg.pts[k][1] - seg.pts[k - 1][1]); return Math.fround(L) },
    native_getPosTan: (v, s, [h, d, pos, tan]) => {
      const seg = get<any>(h).segs[get<any>(h).i]; if (!seg) return 0
      let L = 0
      for (let k = 1; k < seg.pts.length; k++) {
        const [x0, y0] = seg.pts[k - 1], [x1, y1] = seg.pts[k], l = Math.hypot(x1 - x0, y1 - y0)
        if (L + l >= d || k === seg.pts.length - 1) { const t = l ? Math.max(0, Math.min(1, (d - L) / l)) : 0; if (pos) { pos.data[0] = x0 + (x1 - x0) * t; pos.data[1] = y0 + (y1 - y0) * t } if (tan) { tan.data[0] = l ? (x1 - x0) / l : 1; tan.data[1] = l ? (y1 - y0) / l : 0 } return 1 }
        L += l
      }
      return 0
    },
    native_getMatrix: () => 0,
    native_getSegment: (v, s, [h, a, b, dst, move]) => {
      const seg = get<any>(h).segs[get<any>(h).i]; if (!seg) return 0
      let L = 0, started = false
      const p = P(dst)
      for (let k = 1; k < seg.pts.length; k++) {
        const [x0, y0] = seg.pts[k - 1], [x1, y1] = seg.pts[k], l = Math.hypot(x1 - x0, y1 - y0)
        const s0 = Math.max(a, L), s1 = Math.min(b, L + l)
        if (s1 > s0 && l > 0) {
          const t0 = (s0 - L) / l, t1 = (s1 - L) / l
          if (!started) { add(p, [move ? 'M' : 'L', x0 + (x1 - x0) * t0, y0 + (y1 - y0) * t0]); started = true }
          add(p, ['L', x0 + (x1 - x0) * t1, y0 + (y1 - y0) * t1])
        }
        L += l
      }
      return started ? 1 : 0
    },
    native_isClosed: (v, s, [h]) => (get<any>(h).segs[get<any>(h).i]?.closed ? 1 : 0),
    native_nextContour: (v, s, [h]) => { const m = get<any>(h); m.i++; return m.i < m.segs.length ? 1 : 0 },
    native_destroy: (v, s, [h]) => { H.delete(h) },
  })

  // ---------- Camera (3d views): flat, the transforms are identities ----------
  vm.registerNatives('Landroid/graphics/Camera;', {
    nativeConstructor: (v, s) => { s.f.native_instance = put({}) }, nativeDestructor: () => {},
    save: () => {}, restore: () => {}, translate: () => {}, rotateX: () => {}, rotateY: () => {}, rotateZ: () => {}, rotate: () => {},
    getLocationX: () => 0, getLocationY: () => 0, getLocationZ: () => -8, setLocation: () => {}, dotWithNormal: () => 0,
    nativeGetMatrix: (v, s, [m]) => setM(m, ident()), nativeApplyToCanvas: () => {},
  })
  vm.registerNatives('Landroid/graphics/Picture;', {
    nativeConstructor: () => put({}), nativeDestructor: () => {}, nativeBeginRecording: (v, s, [, w, h]) => put(newCv(newBmp(w, h))),
    nativeEndRecording: () => {}, nativeDraw: () => {}, nativeCreateFromStream: () => put({}), nativeWriteToStream: () => 0,
    getWidth: () => 0, getHeight: () => 0,
  })
  vm.registerNatives('Landroid/graphics/Interpolator;', { nativeConstructor: () => put({}), nativeDestructor: () => {}, nativeReset: () => {}, nativeSetKeyFrame: () => {}, nativeSetRepeatMirror: () => {}, nativeTimeToValues: () => 0 })

  // for the window: a canvas drawing into a bitmap the runtime shows
  return {
    bitmapOf: (h: number) => B(h),
    canvasFor: (bm: Bmp) => put(newCv(bm)),
    resetCanvas: (h: number, bm: Bmp) => { const cv = C(h); Object.assign(cv, newCv(bm)) },
    newBmp,
    put, get,
  }
}
