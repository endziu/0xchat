import { describe, expect, test } from 'bun:test'
import { reuploadExistingSubscription } from './push-reupload'

function makeSub(endpoint: string): PushSubscription {
  const json: PushSubscriptionJSON = { endpoint, expirationTime: null, keys: {} }
  return { toJSON: () => json } as unknown as PushSubscription
}

describe('reuploadExistingSubscription', () => {
  test('uploads the existing subscription while still current', async () => {
    const uploads: PushSubscriptionJSON[] = []
    const result = await reuploadExistingSubscription({
      getSubscription: async () => makeSub('ep-a'),
      upload: async (sub) => { uploads.push(sub) },
      isStale: () => false,
    })

    expect(uploads).toEqual([{ endpoint: 'ep-a', expirationTime: null, keys: {} }])
    expect(result).toEqual({ handled: true, subscribed: true })
  })

  test('does not upload when superseded before the write', async () => {
    let uploads = 0
    let stale = false
    const result = await reuploadExistingSubscription({
      // An identity switch / unsubscribe lands as the read resolves.
      getSubscription: async () => { stale = true; return makeSub('ep-a') },
      upload: async () => { uploads++ },
      isStale: () => stale,
    })

    expect(uploads).toBe(0)
    expect(result).toEqual({ handled: false, subscribed: false })
  })

  test('does not upload when superseded during the write', async () => {
    let stale = false
    const result = await reuploadExistingSubscription({
      getSubscription: async () => makeSub('ep-a'),
      upload: async () => { stale = true },
      isStale: () => stale,
    })

    // The write may have started, but the operation is superseded so callers
    // must not trust it to update local state.
    expect(result).toEqual({ handled: false, subscribed: false })
  })

  test('no existing subscription is a no-op upload but still current', async () => {
    let uploads = 0
    const result = await reuploadExistingSubscription({
      getSubscription: async () => null,
      upload: async () => { uploads++ },
      isStale: () => false,
    })

    expect(uploads).toBe(0)
    expect(result).toEqual({ handled: true, subscribed: false })
  })
})
