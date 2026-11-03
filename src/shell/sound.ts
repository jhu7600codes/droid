// ui sounds (aosp sounds arrive in milestone 9; until then this stays quiet when files are missing)
import { settings } from './settings'

const cache = new Map<string, HTMLAudioElement>()
export const sound = {
  play(name: string) {
    if (settings.get('sound.muted')) return
    let a = cache.get(name)
    if (!a) { a = new Audio(`assets/aosp/sounds/${name}.ogg`); cache.set(name, a) }
    a.volume = (settings.get('sound.volume') as number) ?? 0.8
    a.currentTime = 0
    a.play().catch(() => {})
  },
}
