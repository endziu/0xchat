import type { PushManagerLike, PushSubscriptionLike } from './push-ops'

// Native push calls run in the service worker, not in this page (#85). The
// worker outlives a reload, so a browser call started by a tab that has since
// closed still holds the worker's native lock until it really settles, and
// every later call queues behind it instead of racing it. See public/sw.js.
//
// `timeLeft` reports the caller's remaining budget when each call is sent; the
// worker never starts a call that is still queued once it has run out.

type NativeRequest =
  | { op: 'get' }
  | { op: 'subscribe'; applicationServerKey: PushSubscriptionOptionsInit['applicationServerKey'] }
  | { op: 'unsubscribe'; endpoint: string }

type NativeReply =
  | { status: 'done'; subscription?: PushSubscriptionJSON | null; removed?: boolean }
  | { status: 'expired' }
  | { status: 'failed'; message: string }

export const NATIVE_EXPIRED = 'The notification change ran out of time before the browser could start it.'

export function workerPushManager(registration: Pick<ServiceWorkerRegistration, 'active'>,
  timeLeft: () => number): PushManagerLike {
  const call = (request: NativeRequest) => new Promise<Extract<NativeReply, { status: 'done' }>>((resolve, reject) => {
    const worker = registration.active
    if (!worker) {
      reject(new Error('No active service worker'))
      return
    }
    const { port1, port2 } = new MessageChannel()
    port1.onmessage = ({ data }: MessageEvent<NativeReply>) => {
      port1.close()
      if (data.status === 'done') resolve(data)
      else reject(new Error(data.status === 'failed' ? data.message : NATIVE_EXPIRED))
    }
    worker.postMessage({ type: 'push-native', timeLeft: timeLeft(), ...request }, [port2])
  })

  const wrap = (json: PushSubscriptionJSON | null | undefined): PushSubscriptionLike | null => {
    const endpoint = json?.endpoint
    if (!json || !endpoint) return null
    return {
      toJSON: () => json,
      unsubscribe: async () => (await call({ op: 'unsubscribe', endpoint })).removed === true,
    }
  }

  return {
    async subscribe({ applicationServerKey }) {
      const sub = wrap((await call({ op: 'subscribe', applicationServerKey })).subscription)
      if (!sub) throw new Error('The browser returned no push subscription')
      return sub
    },
    getSubscription: async () => wrap((await call({ op: 'get' })).subscription),
  }
}
