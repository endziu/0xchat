/* global crypto, window, TextEncoder, TextDecoder */

let _cachedKeypair = null;

async function deriveKeypair(wallet, address) {
  if (_cachedKeypair && _cachedKeypair.address === address) {
    return _cachedKeypair;
  }

  const sig = await wallet.signMessage('ETH-Gate keypair v1', address);
  const sigBytes = window.hexToBytes(sig.slice(2));
  const seed = new Uint8Array(
    await crypto.subtle.digest('SHA-256', sigBytes),
  );

  const secp = await import('/secp256k1.js');
  const pubkey = window.bytesToHex(secp.getPublicKey(seed, true));

  _cachedKeypair = { seed, pubkey, address };
  return _cachedKeypair;
}

async function encrypt(plaintext, recipientPubkeyHex) {
  const secp = await import('/secp256k1.js');

  const messageBytes = new TextEncoder().encode(plaintext);
  const recipientPubBytes = window.hexToBytes(recipientPubkeyHex);

  const ephemPriv = crypto.getRandomValues(new Uint8Array(32));
  const ephemPub = secp.getPublicKey(ephemPriv, true);

  const sharedSecret = secp.getSharedSecret(
    ephemPriv, recipientPubBytes, true,
  );

  const baseKey = await crypto.subtle.importKey(
    'raw', sharedSecret, { name: 'HKDF' }, false, ['deriveKey'],
  );
  const aesKey = await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: ephemPub,
      info: new TextEncoder().encode('ETH-Gate AES-GCM v1'),
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ctBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, aesKey, messageBytes,
  );

  return {
    ciphertext: window.bytesToHex(new Uint8Array(ctBuf)),
    ephemeral_pubkey: window.bytesToHex(ephemPub),
    iv: window.bytesToHex(iv),
  };
}

async function decrypt(ciphertextHex, ephemeralPubkeyHex, ivHex, seed) {
  const secp = await import('/secp256k1.js');

  const ephemPubBytes = window.hexToBytes(ephemeralPubkeyHex);
  const sharedSecret = secp.getSharedSecret(seed, ephemPubBytes, true);

  const baseKey = await crypto.subtle.importKey(
    'raw', sharedSecret, { name: 'HKDF' }, false, ['deriveKey'],
  );
  const aesKey = await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: ephemPubBytes,
      info: new TextEncoder().encode('ETH-Gate AES-GCM v1'),
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  );

  const iv = window.hexToBytes(ivHex);
  const ciphertextBytes = window.hexToBytes(ciphertextHex);
  const plaintextBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv }, aesKey, ciphertextBytes,
  );

  return new TextDecoder().decode(plaintextBuf);
}

if (typeof window !== 'undefined') {
  window.chatCrypto = { deriveKeypair, encrypt, decrypt };
}
