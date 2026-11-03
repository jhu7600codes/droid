// boot screen: the danen intro (pigeon scene, the big d, "powered by droid").
// the shell boots behind it. it ends when both the animation ('danen:intro-done')
// and the system (ready promise) are finished.
import './boot.css'

const BODY = `<div id="intro">
  <div id="shot">
    <svg viewBox="0 0 160 90" preserveAspectRatio="xMidYMid slice" role="img" aria-label="a pigeon in a field, the flock flies away">
      <defs>
        <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0b1d2c"/><stop offset="1" stop-color="#2f6070"/></linearGradient>
        <linearGradient id="field" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2e6b2f"/><stop offset="1" stop-color="#143a1c"/></linearGradient>
      </defs>
      <g id="zoom">
        <rect width="160" height="48" fill="url(#sky)"/>
        <circle cx="122" cy="34" r="6" fill="#ffbb33" opacity=".85"/>
        <path d="M0 44 Q30 36 60 42 T120 40 T160 43 V50 H0 Z" fill="#1e4a2c"/>
        <rect y="44" width="160" height="46" fill="url(#field)"/>
        <g id="flock"></g>
        <circle id="glow" cx="100" cy="52" r="16" fill="#33b5e5"/>
        <g class="hop">
          <g transform="translate(88,42) scale(.24)">
            <path d="M10 100 C8 84 20 70 40 68 L74 64 C92 66 96 84 96 100 Z" fill="#4a4f57"/>
            <path d="M58 100 C60 86 74 76 92 80 L96 100 Z" fill="#0099cc"/>
            <path d="M27 38 Q17 40 11 44 Q17 47.5 28 47 Z" fill="#ffbb33"/>
            <path d="M26 38 C30 28 40 22 52 22 C62 22 68 30 69 40 C70 52 70 60 76 66 Q54 86 28 76 C34 66 34 54 28 47 Z" fill="#0099cc"/>
            <path d="M26 38 C30 28 40 22 52 22 C62 22 68 30 69 40 C68 50 58 56 45 56 C36 55 30 51 28 47 Z" fill="#33b5e5"/>
            <ellipse cx="27.5" cy="40.5" rx="3.2" ry="2.6" fill="#7fd4f0"/>
            <path d="M28 76 Q54 86 76 66" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round"/>
            <circle cx="45" cy="33" r="5" fill="#fff"/>
            <g id="eye"><circle cx="45" cy="33" r="3.8" fill="#000"/><circle cx="46.2" cy="31.8" r="1.1" fill="#fff"/></g>
          </g>
        </g>
        <path id="grass" fill="#0d2412"/>
      </g>
    </svg>
  </div>

  <div id="mark">
    <svg viewBox="0 0 100 100" role="img" aria-label="d">
      <path d="M32 22 H50 A28 28 0 0 1 50 78 H32 Z" fill="none" stroke="#33b5e5" stroke-width="8" stroke-linejoin="round"/>
      <circle cx="50" cy="50" r="4.5" fill="#fff"/>
    </svg>
  </div>

  <div id="powered"><div id="pb">powered by</div><div id="wm"><svg viewBox="0 0 100 100" role="img" aria-label="d">
    <defs><clipPath id="bowl"><circle cx="42" cy="60" r="22"/></clipPath></defs>
    <circle cx="42" cy="60" r="22" fill="#0a1218"/>
    <g clip-path="url(#bowl)">
      <g transform="translate(16.4,41.2) scale(.6)">
        <path d="M27 38 Q17 40 11 44 Q17 47.5 28 47 Z" fill="#ffbb33"/>
        <path d="M26 38 C30 28 40 22 52 22 C62 22 68 30 69 40 C70 52 70 60 76 66 L76 110 L28 110 C34 66 34 54 28 47 Z" fill="#0099cc"/>
        <path d="M26 38 C30 28 40 22 52 22 C62 22 68 30 69 40 C68 50 58 56 45 56 C36 55 30 51 28 47 Z" fill="#33b5e5"/>
        <ellipse cx="27.5" cy="40.5" rx="3.2" ry="2.6" fill="#7fd4f0"/>
        <circle cx="45" cy="33" r="5" fill="#fff"/>
        <circle cx="45" cy="33" r="3.8" fill="#000"/>
        <circle cx="46.2" cy="31.8" r="1.1" fill="#fff"/>
      </g>
    </g>
    <circle cx="42" cy="60" r="26" fill="none" stroke="#33b5e5" stroke-width="8"/>
    <rect x="64" y="10" width="8" height="80" fill="#33b5e5"/>
  </svg>roid</div></div>
</div>`

function pigeon() {
  return '<path d="M16 6 L20 8 L16 9.5Z" fill="#59606c"/>' +
    '<ellipse cx="10" cy="7.2" rx="7" ry="4" fill="#6b7482"/>' +
    '<circle cx="4.2" cy="4.4" r="2.4" fill="#7a8494"/>' +
    '<path d="M1.9 4 L0 4.9 L2 5.4Z" fill="#8a8f78"/>' +
    '<path class="wing" d="M8 5.6 Q13 0.5 18 3 Q13 6.2 8 7.4Z" fill="#9aa6b8"/>'
}

// x, y, flight dx, dy, delay, duration
const birds = [
  [14, 49, -90, -70, 0, 1.8], [26, 52, -80, -85, 0.12, 2.0], [38, 47, -100, -60, 0.05, 1.7],
  [50, 53, -70, -90, 0.2, 2.1], [62, 48, -85, -75, 0.08, 1.9], [74, 52, -60, -88, 0.28, 2.2],
  [32, 46, -95, -80, 0.15, 1.8], [68, 46, -75, -66, 0.02, 1.6],
]

// shows the intro inside parent; resolves when it is gone
export function boot(parent: HTMLElement, ready: Promise<unknown>, opts: { short?: boolean } = {}) {
  parent.insertAdjacentHTML('beforeend', BODY)
  const intro = parent.querySelector<HTMLElement>('#intro')!
  intro.querySelector('#flock')!.innerHTML = birds.map((b, i) =>
    `<g transform="translate(${b[0]},${b[1]}) scale(.8)"><g class="peck" style="animation-delay:${i * 0.13}s">` +
    `<g class="fly" style="--dx:${b[2]}px;--dy:${b[3]}px;--delay:${2.9 + b[4]}s;--dur:${b[5]}s">${pigeon()}</g></g></g>`).join('')
  let d = 'M0 90 L0 60'
  for (let x = 0; x <= 160; x += 3) d += ` L${x + 1} ${56 + ((x * 37) % 5)} L${x + 3} 60`
  intro.querySelector('#grass')!.setAttribute('d', d + ' L160 90 Z')

  intro.classList.add('run')
  const length = opts.short ? 0 : 8800
  const animDone = new Promise<void>((ok) => setTimeout(() => { document.dispatchEvent(new CustomEvent('danen:intro-done')); ok() }, length))
  return Promise.all([animDone, ready]).then(() => new Promise<void>((ok) => {
    intro.classList.add('gone')
    setTimeout(() => { intro.remove(); ok() }, 450)
  }))
}
