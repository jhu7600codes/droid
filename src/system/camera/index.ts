// camera (spec section 23), modeled on the kitkat aosp camera: full screen preview, round shutter,
// mode switcher (photo / video), front and back, flash where the browser has torch, tap to focus.
// photos and videos go to shared storage under dcim/camera/. also handles the 'capture' intent.
import type { SystemApp, ActivityContext, Activity } from '../../shell/types'
import { RESULT_OK, RESULT_CANCELED } from '../../shell/types'
import { h, pressable, dialog, toast } from '../../shell/ui'
import { img } from '../../shell/assets'
import { screenEl } from '../../shell/layers'
import { shared, stamp } from '../../shell/storage'
import { wm } from '../../shell/wm'
import { sound } from '../../shell/sound'
import './camera.css'

const C = 'apps/camera'
type Mode = 'photo' | 'video'

function camera(ctx: ActivityContext): Activity {
  const capture = ctx.intent.action === 'capture'
  const video = h('video.cam-preview', { autoplay: true, playsInline: true, muted: true }) as HTMLVideoElement
  video.setAttribute('playsinline', '')
  const focus = h('div.cam-focus')
  const flashBtn = pressable(h('div.cam-btn.cam-flash', {}, h('img')))
  const flipBtn = pressable(h('div.cam-btn.cam-flip', {}, h('img', { src: img(C, 'ic_switch_front') })))
  const modeBtn = pressable(h('div.cam-btn.cam-mode', {}, h('img', { src: img(C, 'ic_switch_camera') })))
  const shutter = pressable(h('div.cam-shutter', {}, h('img', { src: img(C, 'btn_shutter_default') })))
  const thumb = pressable(h('div.cam-thumb'))
  const timer = h('div.cam-timer')
  const modes = h('div.cam-modes', {},
    pressable(h('div.cam-btn', { 'data-mode': 'photo' }, h('img', { src: img(C, 'ic_switch_camera') }))),
    pressable(h('div.cam-btn', { 'data-mode': 'video' }, h('img', { src: img(C, 'ic_switch_video') }))))
  const flash = h('div.cam-white')
  const review = h('div.cam-review')
  const controls = h('div.cam-controls', {}, modeBtn, shutter, capture ? h('div.cam-btn') : thumb)
  const root = h('div.cam', {}, video, focus, flash, h('div.cam-top', {}, flipBtn, flashBtn), timer, modes, controls, review)
  ctx.root.append(root)

  let stream: MediaStream | null = null
  let facing: 'environment' | 'user' = 'environment'
  let mode: Mode = (ctx.intent.extras?.mode as Mode) || 'photo'
  let torch: 'off' | 'on' | 'auto' = 'off'
  let hasTorch = false
  let rec: MediaRecorder | null = null
  let started = 0
  let tick = 0
  let last: string | null = null

  async function start() {
    stop()
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: facing, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: mode === 'video',
      })
    } catch {
      try { stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: mode === 'video' }) }
      catch {
        await dialog({ title: 'Camera error', message: 'Can\'t connect to the camera.' })
        ctx.finish({ code: RESULT_CANCELED })
        return
      }
    }
    video.srcObject = stream
    video.classList.toggle('mirror', facing === 'user')
    const track = stream.getVideoTracks()[0]
    const caps = (track.getCapabilities?.() || {}) as any
    hasTorch = !!caps.torch
    flashBtn.style.visibility = hasTorch ? 'visible' : 'hidden'
    setTorch(torch)
  }
  function stop() {
    stream?.getTracks().forEach((t) => t.stop())
    stream = null
  }
  async function setTorch(t: typeof torch) {
    torch = t
    flashBtn.querySelector('img')!.src = img(C, `ic_flash_${t}_holo_light`)
    const track = stream?.getVideoTracks()[0]
    if (hasTorch && track) await track.applyConstraints({ advanced: [{ torch: t === 'on' } as any] }).catch(() => {})
  }
  const setMode = (m: Mode) => {
    mode = m
    modeBtn.querySelector('img')!.src = img(C, m === 'video' ? 'ic_switch_video' : 'ic_switch_camera')
    shutter.querySelector('img')!.src = img(C, m === 'video' ? 'btn_shutter_video_default' : 'btn_shutter_default')
    modes.classList.remove('open')
    start()
  }

  flashBtn.addEventListener('click', () => setTorch(torch === 'off' ? 'on' : torch === 'on' ? 'auto' : 'off'))
  flipBtn.addEventListener('click', () => {
    facing = facing === 'user' ? 'environment' : 'user'
    flipBtn.querySelector('img')!.src = img(C, facing === 'user' ? 'ic_switch_back' : 'ic_switch_front')
    start()
  })
  modeBtn.addEventListener('click', () => modes.classList.toggle('open'))
  modes.querySelectorAll<HTMLElement>('[data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode as Mode)))

  // tap to focus: show the ring, ask the camera to focus there where it can
  video.addEventListener('click', async (e) => {
    const r = video.getBoundingClientRect()
    const scale = r.width / video.offsetWidth || 1
    focus.style.left = (e.clientX - r.left) / scale + 'px'
    focus.style.top = (e.clientY - r.top) / scale + 'px'
    focus.classList.remove('on'); void focus.offsetWidth; focus.classList.add('on')
    const track = stream?.getVideoTracks()[0]
    const caps = (track?.getCapabilities?.() || {}) as any
    if (track && caps.pointsOfInterest) {
      await track.applyConstraints({ advanced: [{ pointsOfInterest: [{ x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }], focusMode: 'single-shot' } as any] }).catch(() => {})
    }
  })

  async function takePhoto() {
    if (!stream) return
    const w = video.videoWidth, hh = video.videoHeight
    if (!w) return
    const c = document.createElement('canvas')
    c.width = w; c.height = hh
    const g = c.getContext('2d')!
    if (facing === 'user') { g.translate(w, 0); g.scale(-1, 1) }
    g.drawImage(video, 0, 0)
    flash.classList.remove('on'); void flash.offsetWidth; flash.classList.add('on')
    sound.play('camera_click')
    const blob: Blob = await new Promise((ok) => c.toBlob((b) => ok(b!), 'image/jpeg', 0.92))
    const path = `dcim/camera/IMG_${stamp()}.jpg`
    await shared.write(path, blob)
    setThumb(path)
    if (capture) showReview(path, c)
  }

  function toggleVideo() {
    if (!stream) return
    if (rec) { rec.stop(); return }
    const type = ['video/webm;codecs=vp9,opus', 'video/webm', 'video/mp4'].find((t) => (window as any).MediaRecorder?.isTypeSupported(t))
    if (!type) { toast('Video recording is not supported here'); return }
    const chunks: Blob[] = []
    rec = new MediaRecorder(stream, { mimeType: type })
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data)
    rec.onstop = async () => {
      clearInterval(tick)
      timer.textContent = ''
      root.classList.remove('recording')
      shutter.querySelector('img')!.src = img(C, 'btn_shutter_video_default')
      const blob = new Blob(chunks, { type: type.split(';')[0] })
      const path = `dcim/camera/VID_${stamp()}.${type.includes('mp4') ? 'mp4' : 'webm'}`
      await shared.write(path, blob)
      setThumb(path)
      rec = null
      if (capture) ctx.finish({ code: RESULT_OK, data: { path, type: blob.type } })
    }
    rec.start(1000)
    started = Date.now()
    root.classList.add('recording')
    shutter.querySelector('img')!.src = img(C, 'btn_shutter_video_recording')
    sound.play('VideoRecord')
    tick = window.setInterval(() => {
      const s = Math.floor((Date.now() - started) / 1000)
      timer.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
    }, 250)
  }

  async function setThumb(path: string) {
    last = path
    if (path.endsWith('.jpg')) thumb.style.backgroundImage = `url("${await shared.url(path)}")`
    else thumb.style.backgroundImage = `url("${img('apps/gallery', 'ic_gallery_play')}")`
    thumb.classList.remove('pop'); void thumb.offsetWidth; thumb.classList.add('pop')
  }
  thumb.addEventListener('click', () => { if (last) wm.start({ action: 'view', data: 'shared:' + last, type: last.endsWith('.jpg') ? 'image/jpeg' : 'video/*' }, undefined) })

  // capture intent: review with retake / done
  function showReview(path: string, c: HTMLCanvasElement) {
    review.innerHTML = ''
    review.style.backgroundImage = `url("${c.toDataURL('image/jpeg', 0.8)}")`
    review.append(h('div.cam-review-bar', {},
      pressable(h('div.cam-btn', { onclick: () => { review.classList.remove('on'); shared.remove(path) } }, h('img', { src: img(C, 'ic_btn_shutter_retake') }))),
      pressable(h('div.cam-btn', { onclick: () => ctx.finish({ code: RESULT_CANCELED }) }, h('img', { src: img(C, 'ic_menu_cancel_holo_light') }))),
      pressable(h('div.cam-btn', { onclick: () => {
        // a smaller copy as a data url, so sandboxed apps can use it without the storage permission
        const s = Math.min(1, 1280 / Math.max(c.width, c.height))
        const t = document.createElement('canvas')
        t.width = c.width * s; t.height = c.height * s
        t.getContext('2d')!.drawImage(c, 0, 0, t.width, t.height)
        ctx.finish({ code: RESULT_OK, data: { path, type: 'image/jpeg', url: t.toDataURL('image/jpeg', 0.85) } })
      } }, h('img', { src: img(C, 'ic_menu_done_holo_light') })))))
    review.classList.add('on')
  }

  shutter.addEventListener('click', () => (mode === 'photo' ? takePhoto() : toggleVideo()))
  // hardware-ish shortcuts: space or volume keys take a picture
  const key = (e: KeyboardEvent) => { if (e.code === 'Space' || e.key === 'AudioVolumeUp' || e.key === 'AudioVolumeDown') { e.preventDefault(); shutter.click() } }

  ;(async () => {
    const pics = (await shared.list('dcim/camera')).sort()
    if (pics.length) setThumb('dcim/camera/' + pics[pics.length - 1])
  })()
  setMode(mode)

  return {
    resume() { screenEl.classList.add('hide-sb'); addEventListener('keydown', key); if (!stream) start() },
    pause() { screenEl.classList.remove('hide-sb'); removeEventListener('keydown', key); if (rec) rec.stop(); stop(); return undefined },
    destroy() { stop(); screenEl.classList.remove('hide-sb') },
    back() { if (modes.classList.contains('open')) { modes.classList.remove('open'); return true } if (review.classList.contains('on')) { review.classList.remove('on'); return true } return false },
  }
}

const app: SystemApp = {
  manifest: {
    id: 'droid.camera', name: 'Camera', version: '4.4', versioncode: 19, type: 'web', main: 'camera',
    activities: { camera: { label: 'Camera', launcher: true, 'launch-mode': 'single-top' } }, system: true,
    'intent-filters': [{ activity: 'camera', actions: ['capture'] }],
    permissions: ['camera', 'microphone', 'storage'],
    orientation: 'any',
  },
  icon: '',
  iconRef: ['apps/camera', 'ic_launcher_camera'],
  activities: { camera },
}
export default app
