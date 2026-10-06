import { afterEach, expect, spyOn, test } from 'bun:test'
import { requireAddress } from '../../shared/address'
import * as envelopes from '../../shared/message-envelope'
import type { Keypair } from '../../shared/keypair'
import { decryptFor } from './useMessages'

const self = requireAddress('0x' + '11'.repeat(20))
const partner = requireAddress('0x' + '22'.repeat(20))
const stranger = requireAddress('0x' + '33'.repeat(20))
const identity = { address: self } as Keypair

afterEach(() => {
  spyOn(envelopes, 'verifyDeliveredMessage').mockRestore()
  spyOn(console, 'error').mockRestore()
})

test('unrelated live messages skip signature verification', async () => {
  const verify = spyOn(envelopes, 'verifyDeliveredMessage').mockResolvedValue(null)
  spyOn(console, 'error').mockImplementation(() => {})
  const decrypt = decryptFor(identity, partner)

  expect(await decrypt({ sender: stranger, recipient: self })).toBeNull()
  expect(verify).not.toHaveBeenCalled()

  expect(await decrypt({ sender: partner, recipient: self })).toBeNull()
  expect(verify).toHaveBeenCalledTimes(1)
})
