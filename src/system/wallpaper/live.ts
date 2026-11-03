// live wallpapers (original, not copies of aosp's): "spectrum" drifting holo light beams and
// "flock" droid pigeons flying across. canvas in the wallpaper layer, paused when covered or in battery saver.
import { layers, screenEl } from '../../shell/layers'
import { settings } from '../../shell/settings'

export const LIVE = { 'live:spectrum': 'Spectrum', 'live:flock': 'Flock' } as Record<string, string>
let canvas: HTMLCanvasElement | null = null
let raf = 0
let kind = ''

export function startLive(k: string) {
  stopLive()
  kind = k
  canvas = document.createElement('canvas')
  canvas.className = 'live-wp'
  layers.wallpaper.append(canvas)
  const loop = (t: number) => {
    raf = requestAnimationFrame(loop)
    // only draw when the wallpaper shows (launcher or lockscreen in front) and not in battery saver
    const covered = !document.documentElement.dataset.front?.match(/launcher/) && !screenEl.classList.contains('locked')
    if (covered || settings.get('battery.saver') || document.hidden) return
    draw(t)
  }
  raf = requestAnimationFrame(loop)
}
export function stopLive() {
  cancelAnimationFrame(raf)
  canvas?.remove()
  canvas = null
}

const beams = Array.from({ length: 14 }, (_, i) => ({ x: Math.random(), w: 0.04 + Math.random() * 0.12, s: 0.00002 + Math.random() * 0.00006, hue: [195, 200, 280, 90, 30][i % 5], a: 0.12 + Math.random() * 0.25, tilt: -0.35 + Math.random() * 0.2 }))
const birds = Array.from({ length: 9 }, () => ({ x: Math.random(), y: 0.15 + Math.random() * 0.6, s: 0.00003 + Math.random() * 0.00004, f: Math.random() * 6, size: 10 + Math.random() * 14 }))

function draw(t: number) {
  const c = canvas!
  const r = window.devicePixelRatio || 1
  const W = layers.wallpaper.clientWidth, H = layers.wallpaper.clientHeight
  if (c.width !== Math.round(W * r)) { c.width = Math.round(W * r); c.height = Math.round(H * r) }
  const g = c.getContext('2d')!
  g.setTransform(r, 0, 0, r, 0, 0)
  if (kind === 'live:spectrum') {
    const bg = g.createLinearGradient(0, 0, 0, H)
    bg.addColorStop(0, '#05121a'); bg.addColorStop(1, '#0b0716')
    g.fillStyle = bg; g.fillRect(0, 0, W, H)
    g.globalCompositeOperation = 'lighter'
    for (const b of beams) {
      const x = (((b.x + t * b.s) % 1.4) - 0.2) * W
      g.save()
      g.translate(x, H / 2)
      g.rotate(b.tilt)
      const gr = g.createLinearGradient(-b.w * W, 0, b.w * W, 0)
      gr.addColorStop(0, `hsla(${b.hue},90%,55%,0)`); gr.addColorStop(0.5, `hsla(${b.hue},90%,60%,${b.a})`); gr.addColorStop(1, `hsla(${b.hue},90%,55%,0)`)
      g.fillStyle = gr
      g.fillRect(-b.w * W, -H, b.w * W * 2, H * 2)
      g.restore()
    }
    g.globalCompositeOperation = 'source-over'
  } else {
    const bg = g.createLinearGradient(0, 0, 0, H)
    bg.addColorStop(0, '#0b1d2c'); bg.addColorStop(0.7, '#2f6070'); bg.addColorStop(0.7, '#2e6b2f'); bg.addColorStop(1, '#143a1c')
    g.fillStyle = bg; g.fillRect(0, 0, W, H)
    for (const b of birds) {
      const x = ((b.x + t * b.s) % 1.2 - 0.1) * W, y = b.y * H * 0.7 + Math.sin(t / 900 + b.f) * 8
      const flap = Math.sin(t / 90 + b.f)
      g.fillStyle = '#9aa6b8'
      g.beginPath(); g.ellipse(x, y, b.size, b.size * 0.55, 0, 0, Math.PI * 2); g.fill()
      g.fillStyle = '#6b7482'
      g.beginPath(); g.moveTo(x - b.size * 0.3, y); g.quadraticCurveTo(x, y - b.size * 1.6 * flap, x + b.size * 0.6, y); g.fill()
      g.fillStyle = '#ffbb33'
      g.beginPath(); g.moveTo(x + b.size, y - 2); g.lineTo(x + b.size * 1.4, y); g.lineTo(x + b.size, y + 2); g.fill()
    }
  }
}
