// push for apps through web push (spec section 19): the subscription is stored on the danen backend,
// which sends to it. needs the backend's vapid key.
import { danenApi } from './danen-remote'

const b64ToBytes = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0))

export async function subscribe(pkg: string) {
  if (!('PushManager' in window) || !('serviceWorker' in navigator)) return null
  const { key } = await danenApi.vapid().catch(() => ({ key: null }))
  if (!key) return null
  const reg = await navigator.serviceWorker.ready
  const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) }))
  await danenApi.subscribe(pkg, sub.toJSON())
  return { endpoint: sub.endpoint }
}
