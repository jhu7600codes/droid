// easter egg: tap "Droid version" five times. a big Droid tile shows up; tap it and it spins,
// long press it and the pigeon flock takes over the screen (tap a pigeon, it coos and flies off).
import { layers } from '../../shell/layers'
import { brand } from '../../shell/assets'
import './egg.css'

const COLORS = ['#33b5e5', '#aa66cc', '#99cc00', '#ffbb33', '#ff4444', '#0099cc', '#669900', '#ff8800']
const PIGEON = (c: string) => `<svg viewBox="0 0 64 64"><g fill="${c}"><ellipse cx="30" cy="38" rx="20" ry="13"/><circle cx="46" cy="22" r="9"/><path d="M8 34 L0 26 L14 30 Z"/><path d="M22 30 Q30 14 42 30 Z" opacity=".7"/></g><path d="M54 21 L62 24 L54 26 Z" fill="#ffbb33"/><circle cx="48" cy="20" r="2" fill="#000"/><path d="M26 50 l-2 8 M34 50 l2 8" stroke="${c}" stroke-width="3"/></svg>`

export function easterEgg() {
  const root = document.createElement('div')
  root.className = 'egg'
  const tile = document.createElement('div')
  tile.className = 'egg-tile'
  tile.innerHTML = `<img src="${brand('droid-d-icon')}" alt="">`
  const label = document.createElement('div')
  label.className = 'egg-label'
  label.textContent = '4.4'
  root.append(tile, label)
  layers.overlay.append(root)
  requestAnimationFrame(() => root.classList.add('on'))

  const close = () => {
    root.classList.remove('on')
    document.removeEventListener('droid:back', back, true)
    setTimeout(() => root.remove(), 300)
  }
  const back = (e: Event) => { e.preventDefault(); e.stopPropagation(); close() }
  document.addEventListener('droid:back', back, true)

  let spins = 0
  let held: ReturnType<typeof setTimeout> | undefined
  let flocking = false
  tile.addEventListener('pointerdown', (e) => {
    e.stopPropagation()
    held = setTimeout(() => { held = undefined; flock() }, 700)
  })
  tile.addEventListener('pointerup', (e) => {
    e.stopPropagation()
    if (!held) return
    clearTimeout(held)
    held = undefined
    tile.style.transform = `rotate(${++spins * 360}deg) scale(${1 + (spins % 3) * 0.08})`
    label.textContent = spins % 5 === 4 ? 'long press it' : '4.4'
  })
  root.addEventListener('click', (e) => { if (e.target === root && !flocking) close() })

  function flock() {
    flocking = true
    tile.classList.add('gone')
    label.textContent = 'Pigeon Flock'
    const w = root.clientWidth, h = root.clientHeight
    const spawn = () => {
      if (!root.isConnected) return
      const p = document.createElement('div')
      p.className = 'egg-pigeon'
      const size = 40 + Math.random() * 60
      const c = COLORS[(Math.random() * COLORS.length) | 0]
      p.innerHTML = PIGEON(c)
      p.style.width = p.style.height = size + 'px'
      const y = Math.random() * (h - size)
      const dur = 6 + Math.random() * 8
      p.style.top = y + 'px'
      p.animate([{ transform: `translateX(-${size}px)` }, { transform: `translateX(${w + size}px)` }], { duration: dur * 1000, easing: 'linear' }).onfinish = () => p.remove()
      p.addEventListener('pointerdown', (e) => {
        e.stopPropagation()
        const coo = document.createElement('div')
        coo.className = 'egg-coo'
        coo.textContent = 'coo'
        coo.style.left = p.getBoundingClientRect().left - root.getBoundingClientRect().left + 'px'
        coo.style.top = y - 20 + 'px'
        root.append(coo)
        setTimeout(() => coo.remove(), 900)
        p.classList.add('flee')
      })
      root.append(p)
      setTimeout(spawn, 300 + Math.random() * 700)
    }
    for (let i = 0; i < 6; i++) setTimeout(spawn, i * 150)
  }
}
