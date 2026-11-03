// push for apps through web push (spec section 19). needs the danen backend's vapid key (milestone 6).
import { settings } from './settings'

export async function subscribe(pkg: string) {
  const key = settings.get('danen.vapid') as string | undefined
  if (!key || !('PushManager' in window)) return null
  const reg = await navigator.serviceWorker.ready
  const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }))
  return { endpoint: sub.endpoint, pkg }
}
