// reads an uncompiled .9.png (the source form with the 1px marker border)
// and returns the stripped image plus stretch and padding regions.
import { PNG } from 'pngjs'

function isBlack(png, x, y) {
  const i = (y * png.width + x) * 4
  const d = png.data
  return d[i] === 0 && d[i + 1] === 0 && d[i + 2] === 0 && d[i + 3] === 255
}

// returns [[start, end), ...] of black runs along a line, in stripped coordinates
function runs(len, test) {
  const out = []
  let start = -1
  for (let i = 0; i < len; i++) {
    const on = test(i)
    if (on && start < 0) start = i
    if (!on && start >= 0) { out.push([start, i]); start = -1 }
  }
  if (start >= 0) out.push([start, len])
  return out
}

export function parseNinePatch(buf) {
  const src = PNG.sync.read(buf)
  const w = src.width - 2
  const h = src.height - 2

  const stretchX = runs(w, (x) => isBlack(src, x + 1, 0))
  const stretchY = runs(h, (y) => isBlack(src, 0, y + 1))
  const padX = runs(w, (x) => isBlack(src, x + 1, src.height - 1))
  const padY = runs(h, (y) => isBlack(src, src.width - 1, y + 1))

  // no padding line means padding = the stretch area (same as android)
  const px = padX.length ? padX : stretchX
  const py = padY.length ? padY : stretchY
  const pad = [
    px.length ? px[0][0] : 0,
    py.length ? py[0][0] : 0,
    px.length ? w - px[px.length - 1][1] : 0,
    py.length ? h - py[py.length - 1][1] : 0,
  ]

  const out = new PNG({ width: w, height: h })
  PNG.bitblt(src, out, 1, 1, w, h, 0, 0)
  return { png: PNG.sync.write(out), meta: { w, h, sx: stretchX, sy: stretchY, pad } }
}
