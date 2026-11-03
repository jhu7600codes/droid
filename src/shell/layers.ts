// the screen layers, bottom to top. created once by main.ts.
export const LAYERS = ['wallpaper', 'windows', 'statusbar', 'navbar', 'shade', 'recents', 'lock', 'overlay', 'boot'] as const
export type LayerName = (typeof LAYERS)[number]
export const layers = {} as Record<LayerName, HTMLElement>
export let screenEl: HTMLElement

export function createLayers(screen: HTMLElement) {
  screenEl = screen
  for (const n of LAYERS) {
    const el = document.createElement('div')
    el.id = n
    el.className = 'layer'
    // every layer is its own stacking context, so window z-indexes never escape above the bars
    el.style.zIndex = String(LAYERS.indexOf(n))
    screen.appendChild(el)
    layers[n] = el
  }
}
