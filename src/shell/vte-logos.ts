// the five VTE carriers' logos (96x96 svg): used by their pages in the Browser, by Messaging, and as
// the icons of their apps in the store (tools/vte/carrier-apps.mjs copies them).
export const LOGOS: Record<string, string> = {
  // Fastline: two speed chevrons on orange
  fastline: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect x="6" y="6" width="84" height="84" rx="20" fill="#ff6d00"/><path d="M26 30 L46 48 L26 66" fill="none" stroke="#fff" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/><path d="M48 30 L68 48 L48 66" fill="none" stroke="#ffd0a8" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  // OMVTE: a calm ring with a dot, purple
  omvte: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect x="6" y="6" width="84" height="84" rx="42" fill="#7c4dff"/><circle cx="48" cy="48" r="22" fill="none" stroke="#fff" stroke-width="7"/><circle cx="48" cy="48" r="7" fill="#e0d4ff"/><path d="M48 14 v8 M48 74 v8 M14 48 h8 M74 48 h8" stroke="#b39dff" stroke-width="4" stroke-linecap="round"/></svg>`,
  // Bumble Line: a honeycomb cell with signal stripes, yellow
  bumble: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect x="6" y="6" width="84" height="84" rx="18" fill="#ffc107"/><path d="M48 16 L76 32 L76 64 L48 80 L20 64 L20 32 Z" fill="#3e2723"/><path d="M31 42 h34 M27 52 h42 M31 62 h34" stroke="#ffc107" stroke-width="6" stroke-linecap="round"/><circle cx="48" cy="30" r="4" fill="#ffe082"/></svg>`,
  // Transfer: two arrows passing each other, teal
  transfer: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect x="6" y="6" width="84" height="84" rx="14" fill="#00bfa5"/><path d="M22 38 H70 M58 26 L70 38 L58 50" fill="none" stroke="#fff" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/><path d="M74 60 H26 M38 48 L26 60 L38 72" fill="none" stroke="#a7ffeb" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  // Line Carrier: one long line with a pulse, blue
  line: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect x="6" y="6" width="84" height="84" rx="8" fill="#2979ff"/><path d="M16 52 H36 L42 36 L50 66 L56 48 H80" fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
}
export const logoUrl = (id: string) => 'data:image/svg+xml;utf8,' + encodeURIComponent(LOGOS[id] || '')
