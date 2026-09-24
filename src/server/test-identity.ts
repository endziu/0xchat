import * as secp from '@noble/secp256k1';
import { bytesToHex, hexToBytes } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

/** Deterministic test identity whose private key repeats `byte`. */
export function identity(byte: string) {
  const privateKey = `0x${byte.repeat(32)}` as const;
  return {
    privateKey,
    address: privateKeyToAccount(privateKey).address.toLowerCase(),
    publicKey: bytesToHex(secp.getPublicKey(hexToBytes(privateKey), true)),
  };
}
