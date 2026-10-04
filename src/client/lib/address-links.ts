import { parseAddress, checksumAddress, type Address } from '../../shared/address'

export function conversationPath(address: Address): string {
  return `/chat/${checksumAddress(address)}`
}

export function parseConversationPath(path: string): Address | null {
  return path.startsWith('/chat/') ? parseAddress(path.slice(6)) : null
}

export function parseScannedAddress(text: string): Address | null {
  const candidate = text.trim()
  try {
    return parseConversationPath(new URL(candidate).pathname)
  } catch {
    return parseAddress(candidate)
  }
}
