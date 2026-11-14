// android.media.SoundPool on web audio (the real framework's SoundPoolImpl natives): samples decode
// once, play() starts a buffer source with volume, pan, loop count and rate. "sample loaded" goes back
// to java on the main looper like android's native callback. files come as paths or as asset file
// descriptors (fds.ts).
import type { VM, JObject, JMethod } from '../dalvik.ts'
import { jstr } from '../java.ts'
import type { Vfs } from '../javaio.ts'
import { fdBytes } from './fds.ts'

let ctx: AudioContext | null = null
function audio(): AudioContext | null {
  if (ctx) return ctx
  const C = (globalThis as any).AudioContext || (globalThis as any).webkitAudioContext
  if (!C) return null
  try { ctx = new C() as AudioContext } catch { return null }
  // browsers start audio only after a tap
  const resume = () => { ctx?.resume().catch(() => {}) }
  for (const ev of ['pointerdown', 'touchstart', 'keydown']) (globalThis as any).addEventListener?.(ev, resume, { passive: true })
  return ctx
}

interface Stream { src: AudioBufferSourceNode; gain: GainNode; pan: StereoPannerNode | null; sound: number }
interface Pool { ref: any; out: GainNode | null; sounds: Map<number, AudioBuffer | null>; streams: Map<number, Stream>; next: number; nextStream: number; paused: boolean }

export function registerAospSoundPool(vm: VM, vfs: Vfs, later: (m: JMethod, self: JObject | null, args: any[]) => void) {
  const pools = new Map<number, Pool>()
  let nextPool = 1
  const P = (s: JObject) => pools.get(s.f.mNativeContext)
  const SP = 'Landroid/media/SoundPool$SoundPoolImpl;'
  let postM: JMethod | null = null
  const loaded = (p: Pool, id: number, ok: boolean) => {
    postM ??= vm.findMethod(vm.cls(SP), 'postEventFromNative(Ljava/lang/Object;IIILjava/lang/Object;)V')
    if (postM) later(postM, null, [p.ref, 1, id, ok ? 0 : 1, null])
  }
  const load = (p: Pool, bytes: Uint8Array | null) => {
    const id = p.next++
    p.sounds.set(id, null)
    const a = audio()
    if (!bytes || !a) { setTimeout(() => loaded(p, id, false), 0); return id }
    a.decodeAudioData(bytes.slice().buffer).then((buf) => { if (p.sounds.has(id)) p.sounds.set(id, buf); loaded(p, id, true) }, () => loaded(p, id, false))
    return id
  }
  const stop = (p: Pool, id: number) => { const st = p.streams.get(id); if (!st) return; try { st.src.stop() } catch { /* done */ } p.streams.delete(id) }
  vm.registerNatives(SP, {
    native_setup: (v, s, [ref]) => {
      const a = audio(), h = nextPool++
      const out = a ? a.createGain() : null
      if (out && a) out.connect(a.destination)
      pools.set(h, { ref, out, sounds: new Map(), streams: new Map(), next: 1, nextStream: 1, paused: false })
      s.f.mNativeContext = h
      return 0
    },
    '_load(Ljava/lang/String;I)I': (v, s, [path]) => { const p = P(s); return p ? load(p, vfs.read(jstr(vm, path).replace(/^file:\/\//, ''))) : 0 },
    '_load(Ljava/io/FileDescriptor;JJI)I': (v, s, [fd, off, len]) => {
      const p = P(s); if (!p) return 0
      const b = fdBytes(fd)
      return load(p, b ? b.subarray(Number(off), Number(off) + (Number(len) > 0 ? Number(len) : b.length)) : null)
    },
    unload: (v, s, [id]) => { const p = P(s); return p?.sounds.delete(id) ? 1 : 0 },
    play: (v, s, [id, l, r, , loop, rate]) => {
      const p = P(s), a = audio()
      const buf = p?.sounds.get(id)
      if (!p || !a || !buf || !p.out) return 0
      const src = a.createBufferSource(), gain = a.createGain()
      src.buffer = buf
      src.playbackRate.value = Math.max(0.5, Math.min(2, rate || 1))
      gain.gain.value = Math.max(l, r)
      // left / right volumes: a pan from their difference
      const pan = typeof a.createStereoPanner === 'function' ? a.createStereoPanner() : null
      if (pan) { pan.pan.value = l + r > 0 ? (r - l) / (l + r) : 0; src.connect(gain).connect(pan).connect(p.out) } else src.connect(gain).connect(p.out)
      // loop: -1 forever, n = n more times
      if (loop !== 0) { src.loop = true; if (loop > 0) src.stop(a.currentTime + (buf.duration / src.playbackRate.value) * (loop + 1)) }
      src.start()
      const sid = p.nextStream++
      p.streams.set(sid, { src, gain, pan, sound: id })
      src.onended = () => p.streams.delete(sid)
      return sid
    },
    pause: (v, s, [id]) => { const p = P(s); if (p) stop(p, id) },
    resume: () => {},
    stop: (v, s, [id]) => { const p = P(s); if (p) stop(p, id) },
    autoPause: (v, s) => { const p = P(s); if (p?.out) p.out.gain.value = 0 },
    autoResume: (v, s) => { const p = P(s); if (p?.out) p.out.gain.value = 1 },
    setVolume: (v, s, [id, l, r]) => { const st = P(s)?.streams.get(id); if (st) { st.gain.gain.value = Math.max(l, r); if (st.pan) st.pan.pan.value = l + r > 0 ? (r - l) / (l + r) : 0 } },
    setPriority: () => {},
    setLoop: (v, s, [id, loop]) => { const st = P(s)?.streams.get(id); if (st) st.src.loop = loop !== 0 },
    setRate: (v, s, [id, rate]) => { const st = P(s)?.streams.get(id); if (st) st.src.playbackRate.value = Math.max(0.5, Math.min(2, rate || 1)) },
    release: (v, s) => { const p = P(s); if (!p) return; for (const id of [...p.streams.keys()]) stop(p, id); p.out?.disconnect(); pools.delete(s.f.mNativeContext) },
    native_finalize: () => {},
  })
}
