import { isCanonicalAddress, type Address } from './address'
import { parseDeliveredMessage, parseExpiryUpdate } from './message-envelope'

/** A conversation's messages were deleted through `cleared_at`; `address` is the conversation partner. */
export interface ConversationCleared {
  address: Address
  cleared_at: number
}

/** A conversation partner deleted their registration. */
export interface RegistrationDeleted {
  address: Address
}

function parseConversationCleared(input: unknown): ConversationCleared | null {
  if (typeof input !== 'object' || input === null) return null
  const { address, cleared_at } = input as { address?: unknown; cleared_at?: unknown }
  if (!isCanonicalAddress(address)) return null
  if (!Number.isSafeInteger(cleared_at) || (cleared_at as number) < 0) return null
  return { address, cleared_at: cleared_at as number }
}

function parseRegistrationDeleted(input: unknown): RegistrationDeleted | null {
  if (typeof input !== 'object' || input === null) return null
  const { address } = input as { address?: unknown }
  return isCanonicalAddress(address) ? { address } : null
}

/**
 * Every live event, by its name on the wire, with the parser of its JSON
 * payload. The server publishes exactly these payload types; browser and CLI
 * accept exactly what these parsers accept.
 */
const CATALOGUE = {
  /** A message was accepted; sent to both identities. Its signature is unverified until the consumer verifies it. */
  'message': parseDeliveredMessage,
  /** Message opening set a message's final deadline. */
  'expiry-update': parseExpiryUpdate,
  /** Either participant cleared the conversation; sent to both identities. */
  'conversation-cleared': parseConversationCleared,
  /** A conversation partner deleted their registration. */
  'user:disconnected': parseRegistrationDeleted,
}

type Catalogue = typeof CATALOGUE
export type LiveEventType = keyof Catalogue
export type LiveEvent = { [K in LiveEventType]: { type: K; data: NonNullable<ReturnType<Catalogue[K]>> } }[LiveEventType]

export const LIVE_EVENT_TYPES = Object.keys(CATALOGUE) as readonly LiveEventType[]

/** The live event named `type` with JSON payload `data`; null for an unknown name or a malformed payload. Never throws. */
export function parseLiveEvent(type: string, data: string): LiveEvent | null {
  if (!Object.hasOwn(CATALOGUE, type)) return null
  let input: unknown
  try {
    input = JSON.parse(data)
  } catch {
    return null
  }
  const payload = CATALOGUE[type as LiveEventType](input)
  return payload && { type, data: payload } as LiveEvent
}
