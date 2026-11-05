// boot screen. two intros (settings > display > boot animation):
//   field (default): jhu's scene. a flock in a field; the droid d falls from the sky and lands,
//                    which startles the flock away; then the big d and "powered by droid".
//   lens: the d alone, it draws itself in, its lens spins up and its light comes on.
// the shell boots behind it. it ends when both the animation ('danen:intro-done')
// and the system (ready promise) are finished.
import './boot.css'

// the droid d (assets/brand/droid-d-icon.svg); ids get a prefix so two copies can share a page
const dMark = (id: string, parts = false) => `<defs><linearGradient id="${id}g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4fc3ef"/><stop offset="1" stop-color="#0099cc"/></linearGradient><radialGradient id="${id}s" cx=".35" cy=".3" r=".8"><stop offset="0" stop-color="#1c3442"/><stop offset="1" stop-color="#0a1218"/></radialGradient></defs>
  <circle${parts ? ' class="d-bowl"' : ''} cx="42" cy="60" r="22" fill="url(#${id}s)"/>
  <path${parts ? ' class="d-arc"' : ''} d="M30 60 a12 12 0 0 1 12 -12" fill="none" stroke="#33b5e5" stroke-width="4" stroke-linecap="round" opacity=".9"/>
  <circle${parts ? ' class="d-dot"' : ''} cx="42" cy="60" r="4.5" fill="#33b5e5"/>
  <circle${parts ? ' class="d-ring"' : ''} cx="42" cy="60" r="26" fill="none" stroke="url(#${id}g)" stroke-width="8"${parts ? ' pathLength="100"' : ''}/>
  <rect${parts ? ' class="d-stem"' : ''} x="64" y="10" width="8" height="80" rx="4" fill="url(#${id}g)"/>`

const FIELD = `<div id="intro" class="field">
  <div id="shot">
    <svg viewBox="0 0 160 90" preserveAspectRatio="xMidYMid slice" role="img" aria-label="the droid d falls into a field and the flock flies away">
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
        <circle id="glow" cx="86" cy="52" r="16" fill="#33b5e5"/>
        <g class="drop"><g class="land">
          <g transform="translate(78,40) scale(.2)">${dMark('fd', true)}</g>
        </g></g>
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

  <div id="powered"><div id="pb">powered by</div><div id="wm"><svg viewBox="0 0 100 100" role="img" aria-label="d">${dMark('wd')}</svg>roid</div></div>
</div>`

const LENS = `<div id="intro" class="lens">
  <div id="lens">
    <svg viewBox="0 0 100 100" role="img" aria-label="droid">${dMark('ld', true)}</svg>
    <div id="lword">droid</div>
  </div>
  <div id="lby">by Danen</div>
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
export function boot(parent: HTMLElement, ready: Promise<unknown>, opts: { short?: boolean; anim?: string } = {}) {
  const lens = opts.anim === 'lens'
  parent.insertAdjacentHTML('beforeend', lens ? LENS : FIELD)
  const intro = parent.querySelector<HTMLElement>('#intro')!
  if (!lens) fieldScene(intro)
  intro.classList.add('run')
  const length = opts.short ? 0 : lens ? 4600 : 8800
  const animDone = new Promise<void>((ok) => setTimeout(() => { document.dispatchEvent(new CustomEvent('danen:intro-done')); ok() }, length))
  return Promise.all([animDone, ready]).then(() => new Promise<void>((ok) => {
    intro.classList.add('gone')
    setTimeout(() => { intro.remove(); ok() }, 450)
  }))
}

function fieldScene(intro: HTMLElement) {
  intro.querySelector('#flock')!.innerHTML = birds.map((b, i) =>
    `<g transform="translate(${b[0]},${b[1]}) scale(.8)"><g class="peck" style="animation-delay:${i * 0.13}s">` +
    `<g class="fly" style="--dx:${b[2]}px;--dy:${b[3]}px;--delay:${2.3 + b[4]}s;--dur:${b[5]}s">${pigeon()}</g></g></g>`).join('')
  let d = 'M0 90 L0 60'
  for (let x = 0; x <= 160; x += 3) d += ` L${x + 1} ${56 + ((x * 37) % 5)} L${x + 3} 60`
  intro.querySelector('#grass')!.setAttribute('d', d + ' L160 90 Z')
}
