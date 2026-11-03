// milestone 1 test page: holo widgets in dark and light, generated from the aosp assets.
// ?density=xhdpi forces a bucket, otherwise it comes from the screen.
import { bucketFor, detectDpi, loadHolo, dpiOf, assetUrl, type Bucket } from '../shell/density'
import { attachNinePatch, type NineMeta } from '../shell/ninepatch'

const q = new URLSearchParams(location.search)
const bucket = loadHolo((q.get('density') as Bucket) || bucketFor(detectDpi()))

const phone = (theme: 'dark' | 'light') => `
<div class="phone holo-${theme}">
  <div class="h-actionbar">
    <span class="h-ab-item h-ab-home"><i class="h-ab-up"></i><span class="h-ab-title">holo ${theme}</span></span>
    <span class="h-ab-title"></span>
    <span class="h-ab-item"><i class="h-ab-overflow"></i></span>
  </div>
  <div class="h-tabs"><span class="h-tab selected">all</span><span class="h-tab">photos</span><span class="h-tab">videos</span></div>

  <div class="h-section">buttons</div>
  <div class="row">
    <button class="h-btn">normal</button>
    <button class="h-btn pressed">pressed</button>
    <button class="h-btn focused">focused</button>
    <button class="h-btn" disabled>disabled</button>
  </div>

  <div class="h-section">checks and switches</div>
  <div class="row">
    <input type="checkbox" class="h-check" checked>
    <input type="checkbox" class="h-check">
    <input type="radio" name="r-${theme}" class="h-radio" checked>
    <input type="radio" name="r-${theme}" class="h-radio">
    <label class="h-switch"><input type="checkbox" checked><span class="track"><span class="thumb">on</span></span></label>
    <label class="h-switch"><input type="checkbox"><span class="track"><span class="thumb">off</span></span></label>
  </div>

  <div class="h-section">text</div>
  <div class="row"><input class="h-edit" placeholder="type something"></div>
  <div class="row"><div class="h-spinner" style="width:100%">spinner item</div></div>

  <div class="h-section">progress</div>
  <div class="row" style="display:block">
    <span class="h-progress"><span class="bar2" style="width:70%"></span><span class="bar" style="width:40%"></span></span>
    <span class="h-seek"><span class="track"></span><span class="fill" style="width:50%"></span><span class="knob" style="left:calc(16px + (100% - 32px) * .5)"></span></span>
    <span class="h-spin"><i></i></span> <span class="h-spin-large"><i></i></span>
  </div>

  <div class="h-section">list</div>
  <ul class="h-list">
    <li class="h-item"><div class="lines"><span class="title">wi-fi</span><span class="summary">connected to jhfi</span></div></li>
    <li class="h-divider"></li>
    <li class="h-item pressed"><div class="lines"><span class="title">pressed item</span><span class="summary">list_selector_holo</span></div></li>
    <li class="h-divider"></li>
    <li class="h-item small activated"><div class="lines"><span class="title">activated</span></div></li>
  </ul>

  <div class="demo-dialog">
    <div class="h-scrim">
      <div class="h-dialog">
        <div class="d-title">dialog title</div>
        <div class="d-title-line"></div>
        <div class="d-body">this dialog uses dialog_full_holo from aosp.</div>
        <div class="d-buttons"><button class="h-btn-borderless">cancel</button><button class="h-btn-borderless">ok</button></div>
      </div>
    </div>
  </div>

  <div class="row" style="justify-content:center;padding:16px"><span class="h-toast">this is a toast</span></div>
  <div class="row" style="justify-content:flex-end"><div class="h-menu"><span>settings</span><span>help</span></div></div>
  <div class="np" data-nine="btn_toggle_off">canvas 9-patch (multi region)</div>
</div>`

document.getElementById('page')!.innerHTML = phone('dark') + phone('light') + `<p style="color:#888;font:12px monospace;width:100%">density ${bucket}</p>`

// multi-region 9-patches go through the canvas renderer
fetch(assetUrl('ninepatch.json')).then((r) => r.json()).then((all: Record<string, Record<string, NineMeta>>) => {
  for (const el of document.querySelectorAll<HTMLElement>('[data-nine]')) {
    const name = el.dataset.nine!
    const metas = all[`framework/${name}`]
    const b = (metas[bucket] ? bucket : Object.keys(metas)[0]) as Bucket
    attachNinePatch(el, assetUrl(`framework/drawable-${b}/${name}.png`), metas[b], dpiOf(b))
  }
})

// small bit of life for the seek bar
for (const s of document.querySelectorAll<HTMLElement>('.h-seek')) {
  s.addEventListener('pointerdown', (e) => {
    const move = (ev: PointerEvent) => {
      const r = s.getBoundingClientRect()
      const f = Math.min(1, Math.max(0, (ev.clientX - r.left - 16) / (r.width - 32)))
      ;(s.querySelector('.fill') as HTMLElement).style.width = `calc((100% - 32px) * ${f})`
      ;(s.querySelector('.knob') as HTMLElement).style.left = `calc(16px + (100% - 32px) * ${f})`
    }
    move(e)
    s.setPointerCapture(e.pointerId)
    s.onpointermove = move
    s.onpointerup = () => (s.onpointermove = null)
  })
}
