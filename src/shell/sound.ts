// ui sounds from aosp (frameworks/base/data/sounds, apache 2.0). ogg: browsers without ogg stay quiet
import { settings } from './settings'

const cache = new Map<string, HTMLAudioElement>()
export const sound = {
  // name: file under assets/aosp/sounds without .ogg (e.g. 'Lock', 'notifications/Tejat')
  play(name: string, gain = 1) {
    if (settings.get('sound.muted')) return
    // never throws: a browser that cannot play ogg (safari) may refuse currentTime or play()
    try {
      let a = cache.get(name)
      if (!a) { a = new Audio(`assets/aosp/sounds/${name}.ogg`); cache.set(name, a) }
      a.volume = Math.min(1, ((settings.get('sound.volume') as number) ?? 0.8) * gain)
      if (a.readyState > 0) a.currentTime = 0
      a.play()?.catch?.(() => {})
    } catch { /* quiet */ }
  },
}
