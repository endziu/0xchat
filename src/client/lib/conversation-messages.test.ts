import { afterEach, expect, spyOn, test } from 'bun:test'
import { ConversationMessages, type DecryptedMessage } from './conversation-messages'
import { UNOPENED_RETENTION_MS, type MessageLifecycle } from '../../shared/message-envelope'

// This store receives envelopes only after signature verification and decryption.
const message: DecryptedMessage = {
  version: 2, id: 'one', sender: 'alice', recipient: 'bob', ttl: 5,
  ct_recipient: '', ephemeral_pub_recipient: '', iv_recipient: '',
  ct_sender: '', ephemeral_pub_sender: '', iv_sender: '', signature: '',
  plaintext: 'confirmed content', delivery_policy: 'recipient-opening',
  created_at: 1_000, opened_at: null, expires_at: 1_000 + UNOPENED_RETENTION_MS,
}
const opened: MessageLifecycle = {
  delivery_policy: 'recipient-opening', created_at: 1_000, opened_at: 2_000, expires_at: 7_000,
}
const conditions = { eligible: true, synchronized: true }
const response = (lifecycle: MessageLifecycle, serverTime = 2_000) => ({
  server_time: serverTime, results: [{ id: message.id, status: 'available', ...lifecycle }],
})

afterEach(() => { spyOn(Date, 'now').mockRestore(); spyOn(performance, 'now').mockRestore() })

test('confirmation expires on server time plus elapsed time despite wall-clock skew and response delay', () => {
  let elapsed = 100
  spyOn(performance, 'now').mockImplementation(() => elapsed)
  spyOn(Date, 'now').mockReturnValue(10 ** 12)
  const store = new ConversationMessages('bob')
  store.add([message])
  store.sweep(store.now(), conditions)
  expect(store.takePending()).toEqual([message.id])
  elapsed = 1_100
  store.confirmOpening([message.id], response(opened), 100)
  expect(store.now()).toBe(3_000)
  expect(store.display(store.now(), conditions).map(item => item.plaintext)).toEqual(['confirmed content'])
  spyOn(Date, 'now').mockReturnValue(0)
  elapsed = 5_100
  expect(store.display(store.now(), conditions)).toEqual([])
  store.sweep(store.now(), conditions)
  store.add([message])
  expect(store.ids()).toEqual([])
})

test('malformed confirmation time and conflicting final deadlines require retry', () => {
  for (const invalid of [
    { ...response(opened), server_time: undefined },
    { ...response(opened), server_time: -1 },
    response({ ...opened, opened_at: 2_001, expires_at: 7_001 }, 2_001),
  ]) {
    const store = new ConversationMessages('bob')
    store.add([{ ...message, ...opened }])
    store.takePending()
    store.confirmOpening([message.id], invalid)
    expect(store.hasFailedOpenings()).toBe(true)
    expect(store.display(store.now(), conditions)).toEqual([])
    store.retryFailed()
    store.takePending()
    store.confirmOpening([message.id], response(opened))
    expect(store.display(store.now(), conditions)).toHaveLength(1)
  }
})

test('state refresh rejects inconsistent metadata and malformed server time', () => {
  const store = new ConversationMessages('alice')
  store.add([message])
  expect(store.applyStates([message.id], response({ ...opened, created_at: 999 }))).toBe(false)
  expect(store.applyStates([message.id], response({
    delivery_policy: 'legacy', created_at: 1_000, opened_at: null, expires_at: 6_000,
  }))).toBe(false)
  expect(store.applyStates([message.id], { ...response(opened), server_time: '2000' })).toBe(false)
  expect(store.applyStates([message.id], response(opened))).toBe(true)
  expect(store.applyStates([message.id], response({ ...opened, opened_at: 2_001, expires_at: 7_001 }, 2_001))).toBe(false)
})

test('stale unopened state preserves the final deadline and later samples never extend availability', () => {
  let elapsed = 100
  spyOn(performance, 'now').mockImplementation(() => elapsed)
  const store = new ConversationMessages('alice')
  store.add([message])
  expect(store.applyStates([message.id], response(opened), 100)).toBe(true)
  elapsed = 200
  expect(store.applyStates([message.id], response(message), 200)).toBe(true)
  expect(store.now()).toBe(2_100)
  store.applyLifecycle(message.id, message)
  expect(store.display(store.now(), conditions)[0]?.expires_at).toBe(7_000)
  elapsed = 5_100
  expect(store.display(store.now(), conditions)).toEqual([])
})
