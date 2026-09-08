import { constants } from 'node:fs'
import { mkdir, open } from 'node:fs/promises'
import { dirname } from 'node:path'
import { deriveKeypair, generateKeypair, type Keypair } from '../client/lib/burner'

export function parsePrivateKey(value: string): Keypair {
  const privateKey = value.trim().replace(/^0x/i, '')
  if (!/^[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error('Expected a 32-byte hexadecimal private key')
  return deriveKeypair(`0x${privateKey.toLowerCase()}`)
}

export async function loadIdentity(path: string): Promise<Keypair> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) {
      throw new Error('Identity must be a regular file accessible only by its owner (chmod 600)')
    }
    if (stat.size > 4096) throw new Error('Invalid identity file')
    const value: unknown = JSON.parse(await file.readFile('utf8'))
    if (!value || typeof value !== 'object' || !('privateKey' in value) || typeof value.privateKey !== 'string') {
      throw new Error('Invalid identity file')
    }
    return parsePrivateKey(value.privateKey)
  } finally {
    await file.close()
  }
}

export async function createIdentity(path: string, privateKey?: string): Promise<Keypair> {
  const identity = privateKey === undefined ? generateKeypair() : parsePrivateKey(privateKey)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  // Exclusive creation also refuses symlinks and never overwrites an identity.
  const file = await open(path, 'wx', 0o600)
  try {
    await file.writeFile(JSON.stringify({ version: 1, privateKey: identity.privateKey }) + '\n')
    await file.sync()
  } finally {
    await file.close()
  }
  return identity
}
