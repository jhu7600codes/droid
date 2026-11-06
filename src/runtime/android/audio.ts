// android.media.AudioTrack on web audio: pcm (8 / 16-bit or float, mono / stereo) written by the app
// is queued as audio buffers on a shared AudioContext. write() blocks (the calling green thread
// waits) while more than the track's buffer is queued, the way it does on a phone: audio engines
// (fmod, openal) drive their mixing loop with it. AudioManager bits engines ask for are here too.
import { VM, JObject, JArray, type NativeFn } from './dalvik.ts'
import { Block } from './threads.ts'

const OBJ = 'Ljava/lang/Object;'
let ctx: AudioContext | null = null
function audio(): AudioContext | null {
  if (ctx) return ctx
  const C = (globalThis as any).AudioContext || (globalThis as any).webkitAudioContext
  if (!C) return null
  try { ctx = new C() as AudioContext } catch { return null }
  // browsers start audio only after a tap: resume on the first one
  const resume = () => { ctx?.resume().catch(() => {}) }
  for (const ev of ['pointerdown', 'touchstart', 'keydown']) (globalThis as any).addEventListener?.(ev, resume, { passive: true })
  return ctx
}

interface Track { rate: number; channels: number; format: number; bufBytes: number; state: 'stopped' | 'paused' | 'playing'; at: number; written: number; volume: [number, number]; gain: GainNode | null; nodes: Set<AudioBufferSourceNode> }

export function registerAudio(vm: VM) {
  const tr = (s: JObject) => s.f.track as Track
  const bytesPer = (fmt: number) => (fmt === 3 ? 1 : fmt === 4 ? 4 : 2) // ENCODING_PCM_8BIT 3, 16BIT 2, FLOAT 4
  const channelsOf = (cfg: number) => (cfg === 12 || cfg === 3 ? 2 : cfg === 2 || cfg === 4 || cfg === 1 ? 1 : Math.max(1, popcount(cfg >>> 2)))
  // seconds of audio waiting to play
  const queued = (t: Track) => { const a = audio(); return a ? Math.max(0, t.at - a.currentTime) : 0 }
  const bufSeconds = (t: Track) => t.bufBytes / (t.rate * t.channels * bytesPer(t.format))

  const push = (t: Track, samples: Float32Array[]) => {
    const a = audio()
    const frames = samples[0].length
    t.written += frames
    if (!a || !frames) return
    if (!t.gain) { t.gain = a.createGain(); t.gain.connect(a.destination) }
    t.gain.gain.value = Math.max(t.volume[0], t.volume[1])
    const b = a.createBuffer(t.channels, frames, t.rate)
    samples.forEach((ch, i) => b.copyToChannel(ch as Float32Array<ArrayBuffer>, i))
    const src = a.createBufferSource()
    src.buffer = b
    src.connect(t.gain)
    // a small lead so the first buffers do not click; after a gap, start again just ahead
    const start = Math.max(t.at, a.currentTime + 0.02)
    src.start(start)
    t.at = start + frames / t.rate
    t.nodes.add(src)
    src.onended = () => t.nodes.delete(src)
  }
  // pcm from a java array -> per-channel floats
  const decode = (t: Track, arr: JArray, off: number, len: number, kind: 'B' | 'S' | 'F') => {
    const d = arr.data as any
    const ch = t.channels
    let floats: Float32Array
    if (kind === 'S') { floats = new Float32Array(len); for (let i = 0; i < len; i++) floats[i] = d[off + i] / 32768 }
    else if (kind === 'F') floats = Float32Array.from(d.subarray ? d.subarray(off, off + len) : d.slice(off, off + len))
    else if (t.format === 3) { floats = new Float32Array(len); for (let i = 0; i < len; i++) floats[i] = ((d[off + i] & 0xff) - 128) / 128 }
    else { // 16-bit little endian in a byte array
      const n = len >> 1
      floats = new Float32Array(n)
      for (let i = 0; i < n; i++) floats[i] = (((d[off + 2 * i] & 0xff) | (d[off + 2 * i + 1] << 8)) << 16 >> 16) / 32768
    }
    const frames = Math.floor(floats.length / ch)
    const out = Array.from({ length: ch }, () => new Float32Array(frames))
    for (let f = 0; f < frames; f++) for (let c = 0; c < ch; c++) out[c][f] = floats[f * ch + c]
    return out
  }
  // write(): queue now if there is room; otherwise wait until there is, then queue
  const write = (kind: 'B' | 'S' | 'F') => (v: VM, s: JObject, [arr, off, len]: any[]) => {
    const t = tr(s)
    if (!t) return -3 // ERROR_INVALID_OPERATION
    const go = () => { push(t, decode(t, arr, off, len, kind)); return len }
    if (t.state !== 'playing' || !audio() || audio()!.state !== 'running') {
      if (!vm.current || vm.current === vm.main) return len // the ui thread never waits here
      // not playing (or the browser has not allowed sound yet): pretend to play in real time
      const secs = len / (kind === 'B' ? bytesPer(t.format) : 1) / t.channels / t.rate
      t.written += Math.floor(secs * t.rate)
      throw new Block(() => true, performance.now() + secs * 1000, 'audio').then(() => len)
    }
    // (a wait inside a nested call is fine: the scheduler runs the others meanwhile)
    if (queued(t) < bufSeconds(t) || !vm.current || vm.current === vm.main) return go()
    const room = () => queued(t) < bufSeconds(t) || t.state !== 'playing'
    throw new Block(room, performance.now() + (queued(t) - bufSeconds(t)) * 1000 + 1, 'audio').then(go)
  }
  const methods: Record<string, NativeFn> = {
    '<init>(IIIIII)V': (v, s, [, rate, cfg, fmt, size]) => {
      s.f.track = { rate: rate || 44100, channels: channelsOf(cfg), format: fmt || 2, bufBytes: Math.max(size, 1024), state: 'stopped', at: 0, written: 0, volume: [1, 1], gain: null, nodes: new Set() } satisfies Track
    },
    '<init>(IIIIIII)V': (v, s, [a, b, c, d, e, f]) => methods['<init>(IIIIII)V'](v, s, [a, b, c, d, e, f]),
    'play()V': (v, s) => { const t = tr(s); t.state = 'playing'; audio()?.resume().catch(() => {}) },
    'pause()V': (v, s) => { tr(s).state = 'paused' },
    'stop()V': (v, s) => { const t = tr(s); t.state = 'stopped'; for (const n of t.nodes) try { n.stop() } catch { /* already done */ } t.nodes.clear(); t.at = 0 },
    'flush()V': (v, s) => { const t = tr(s); for (const n of t.nodes) try { n.stop() } catch { /* already done */ } t.nodes.clear(); t.at = 0 },
    'release()V': (v, s) => { const t = tr(s); if (t) { methods['stop()V'](v, s, []); t.gain?.disconnect() } },
    'write([BII)I': write('B'),
    'write([SII)I': write('S'),
    'write([FIII)I': write('F'),
    'getState()I': () => 1, // STATE_INITIALIZED
    'getPlayState()I': (v, s) => ({ stopped: 1, paused: 2, playing: 3 })[tr(s).state],
    'getSampleRate()I': (v, s) => tr(s).rate,
    'getPlaybackRate()I': (v, s) => tr(s).rate,
    'getChannelCount()I': (v, s) => tr(s).channels,
    'getAudioFormat()I': (v, s) => tr(s).format,
    'getPlaybackHeadPosition()I': (v, s) => { const t = tr(s); return Math.max(0, Math.floor(t.written - queued(t) * t.rate)) | 0 },
    'setStereoVolume(FF)I': (v, s, [l, r]) => { const t = tr(s); t.volume = [l, r]; if (t.gain) t.gain.gain.value = Math.max(l, r); return 0 },
    'setVolume(F)I': (v, s, [x]) => methods['setStereoVolume(FF)I'](v, s, [x, x]),
    'setPlaybackRate(I)I': () => 0,
    'setPositionNotificationPeriod(I)I': () => 0,
    'setPlaybackPositionUpdateListener(Landroid/media/AudioTrack$OnPlaybackPositionUpdateListener;)V': () => {},
    'getMinBufferSize(III)I': (v, s, [rate, cfg, fmt]) => Math.ceil(((rate || 44100) * channelsOf(cfg) * bytesPer(fmt) * 0.05) / 4) * 4, // 50 ms
    'getNativeOutputSampleRate(I)I': () => audio()?.sampleRate ?? 44100,
    'getMinVolume()F': () => 0,
    'getMaxVolume()F': () => 1,
  }
  const old = vm.shims.get('Landroid/media/AudioTrack;')
  vm.shim('Landroid/media/AudioTrack;', { super: OBJ, methods: { ...(old?.methods || {}), ...methods }, statics: { ...(old?.statics || {}),
    MODE_STATIC: 0, MODE_STREAM: 1, PLAYSTATE_STOPPED: 1, PLAYSTATE_PAUSED: 2, PLAYSTATE_PLAYING: 3, STATE_UNINITIALIZED: 0, STATE_INITIALIZED: 1, STATE_NO_STATIC_DATA: 2, SUCCESS: 0, ERROR: -1, ERROR_BAD_VALUE: -2, ERROR_INVALID_OPERATION: -3 } })
  const fmt = vm.shims.get('Landroid/media/AudioFormat;')
  vm.shim('Landroid/media/AudioFormat;', { super: OBJ, methods: fmt?.methods || {}, statics: { ...(fmt?.statics || {}),
    ENCODING_DEFAULT: 1, ENCODING_PCM_16BIT: 2, ENCODING_PCM_8BIT: 3, ENCODING_PCM_FLOAT: 4, ENCODING_INVALID: 0,
    CHANNEL_OUT_MONO: 4, CHANNEL_OUT_STEREO: 12, CHANNEL_CONFIGURATION_MONO: 2, CHANNEL_CONFIGURATION_STEREO: 3, CHANNEL_IN_MONO: 16, CHANNEL_IN_STEREO: 12, CHANNEL_OUT_DEFAULT: 1 } })
  const am = vm.shims.get('Landroid/media/AudioManager;')
  vm.shim('Landroid/media/AudioManager;', { super: OBJ, methods: { ...(am?.methods || {}),
    'getProperty(Ljava/lang/String;)Ljava/lang/String;': (v, s, [k]) => (/SAMPLE_RATE/.test(k) ? String(audio()?.sampleRate ?? 44100) : /FRAMES_PER_BUFFER/.test(k) ? '256' : null),
  }, statics: am?.statics || {} })
  void JObject
}
function popcount(x: number) { let n = 0; while (x) { n += x & 1; x >>>= 1 } return n }

// java.net.URL and HttpURLConnection, offline: apps see a phone without a connection (their
// network threads get UnknownHostException and give up the normal way)
export function registerNet(vm: VM) {
  const sh = (name: string, sup: string, methods: Record<string, NativeFn>) => { const old = vm.shims.get(name); vm.shim(name, { super: old?.super ?? sup, methods: { ...(old?.methods || {}), ...methods }, statics: old?.statics }) }
  const ex = (cls: string, msg: string) => vm.error(cls, msg)
  for (const e of ['Ljava/net/UnknownHostException;', 'Ljava/net/MalformedURLException;', 'Ljava/net/SocketTimeoutException;', 'Ljava/net/ConnectException;'])
    if (!vm.shims.has(e)) vm.shim(e, { super: 'Ljava/io/IOException;', methods: { '<init>(Ljava/lang/String;)V': (v, s, [m]) => { s.f.message = m }, '<init>()V': () => {} } })
  const parse = (s: JObject, u: string) => {
    const m = /^([a-z][a-z0-9+.-]*):\/\/([^/:?#]*)(?::(\d+))?([^?#]*)(\?[^#]*)?(#.*)?$/i.exec(u)
    if (!m) throw ex('Ljava/net/MalformedURLException;', 'no protocol: ' + u)
    Object.assign(s.f, { url: u, protocol: m[1].toLowerCase(), host: m[2], port: m[3] ? Number(m[3]) : -1, path: m[4] || '', query: m[5] ? m[5].slice(1) : null, ref: m[6] ? m[6].slice(1) : null })
  }
  const offline = (s: JObject) => { throw ex('Ljava/net/UnknownHostException;', `Unable to resolve host "${s.f.host ?? ''}": No address associated with hostname`) }
  sh('Ljava/net/URL;', 'Ljava/lang/Object;', {
    '<init>(Ljava/lang/String;)V': (v, s, [u]) => parse(s, String(u)),
    '<init>(Ljava/net/URL;Ljava/lang/String;)V': (v, s, [base, rel]) => { try { parse(s, new URL(String(rel), base?.f?.url).href) } catch { parse(s, String(rel)) } },
    '<init>(Ljava/lang/String;Ljava/lang/String;ILjava/lang/String;)V': (v, s, [p, h, port, f]) => parse(s, `${p}://${h}${port >= 0 ? ':' + port : ''}${f}`),
    '<init>(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V': (v, s, [p, h, f]) => parse(s, `${p}://${h}${f}`),
    'toString()Ljava/lang/String;': (v, s) => s.f.url, 'toExternalForm()Ljava/lang/String;': (v, s) => s.f.url,
    'getProtocol()Ljava/lang/String;': (v, s) => s.f.protocol, 'getHost()Ljava/lang/String;': (v, s) => s.f.host,
    'getPort()I': (v, s) => s.f.port, 'getDefaultPort()I': (v, s) => (s.f.protocol === 'https' ? 443 : 80),
    'getPath()Ljava/lang/String;': (v, s) => s.f.path, 'getQuery()Ljava/lang/String;': (v, s) => s.f.query, 'getRef()Ljava/lang/String;': (v, s) => s.f.ref,
    'getFile()Ljava/lang/String;': (v, s) => s.f.path + (s.f.query ? '?' + s.f.query : ''),
    'getAuthority()Ljava/lang/String;': (v, s) => s.f.host + (s.f.port >= 0 ? ':' + s.f.port : ''), 'getUserInfo()Ljava/lang/String;': () => null,
    'sameFile(Ljava/net/URL;)Z': (v, s, [o]) => (String(o?.f?.url).split('#')[0] === String(s.f.url).split('#')[0] ? 1 : 0),
    'equals(Ljava/lang/Object;)Z': (v, s, [o]) => (o?.f?.url === s.f.url ? 1 : 0), 'hashCode()I': (v, s) => [...String(s.f.url)].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) | 0, 0),
    'openConnection()Ljava/net/URLConnection;': (v, s) => { const c = new JObject(vm.cls(s.f.protocol === 'https' ? 'Ljavax/net/ssl/HttpsURLConnection;' : 'Ljava/net/HttpURLConnection;')); c.f.url = s; c.f.host = s.f.host; c.f.headers = new Map(); return c },
    'openStream()Ljava/io/InputStream;': (v, s) => offline(s),
  })
  const conn: Record<string, NativeFn> = {
    'connect()V': (v, s) => offline(s), 'getInputStream()Ljava/io/InputStream;': (v, s) => offline(s), 'getOutputStream()Ljava/io/OutputStream;': (v, s) => offline(s),
    'getResponseCode()I': (v, s) => offline(s), 'getResponseMessage()Ljava/lang/String;': (v, s) => offline(s), 'getContent()Ljava/lang/Object;': (v, s) => offline(s),
    'getErrorStream()Ljava/io/InputStream;': () => null, 'getContentLength()I': () => -1, 'getContentType()Ljava/lang/String;': () => null,
    'getHeaderField(Ljava/lang/String;)Ljava/lang/String;': () => null, 'getURL()Ljava/net/URL;': (v, s) => s.f.url,
    'setRequestProperty(Ljava/lang/String;Ljava/lang/String;)V': (v, s, [k, x]) => { s.f.headers.set(k, x) }, 'addRequestProperty(Ljava/lang/String;Ljava/lang/String;)V': (v, s, [k, x]) => { s.f.headers.set(k, x) },
    'getRequestProperty(Ljava/lang/String;)Ljava/lang/String;': (v, s, [k]) => s.f.headers.get(k) ?? null,
    'setRequestMethod(Ljava/lang/String;)V': (v, s, [m]) => { s.f.method = m }, 'getRequestMethod()Ljava/lang/String;': (v, s) => s.f.method ?? 'GET',
    'setDoOutput(Z)V': () => {}, 'setDoInput(Z)V': () => {}, 'setUseCaches(Z)V': () => {}, 'setConnectTimeout(I)V': () => {}, 'setReadTimeout(I)V': () => {},
    'setInstanceFollowRedirects(Z)V': () => {}, 'setChunkedStreamingMode(I)V': () => {}, 'setFixedLengthStreamingMode(I)V': () => {}, 'setAllowUserInteraction(Z)V': () => {},
    'disconnect()V': () => {},
  }
  sh('Ljava/net/URLConnection;', 'Ljava/lang/Object;', conn)
  sh('Ljava/net/HttpURLConnection;', 'Ljava/net/URLConnection;', {})
  sh('Ljavax/net/ssl/HttpsURLConnection;', 'Ljava/net/HttpURLConnection;', { 'setSSLSocketFactory(Ljavax/net/ssl/SSLSocketFactory;)V': () => {}, 'setHostnameVerifier(Ljavax/net/ssl/HostnameVerifier;)V': () => {} })
}
