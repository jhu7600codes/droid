// shared helpers for both activities (an es module, imported relatively)
export async function load() { return (await droid.prefs.get('notes', [])) }
export async function save(notes) { await droid.prefs.set('notes', notes) }
export const preview = (t) => (t || '').split('\n')[0].slice(0, 60) || '(empty)'
