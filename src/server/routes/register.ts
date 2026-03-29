import { ChallengeStore } from '../challenge.ts';
import { registerPubkey } from '../db.ts';
import { json } from '../http.ts';
import { isRateLimited } from '../rate-limit.ts';
import { isValidAddress, isHex, isValidSig } from '../validation.ts';
import { verifySig } from '../verify.ts';
import { log, warn } from '../constants.ts';
import type { Context } from '../http.ts';

export const regStore = new ChallengeStore();

export async function handleRegisterChallenge({ req }: Context): Promise<Response> {
  let body: { address?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const address = typeof body.address === 'string' ? body.address.trim().toLowerCase() : '';
  if (!isValidAddress(address)) {
    warn('[invalid]', '/api/register/challenge', 'bad address', address);
    return json({ error: 'Invalid address' }, 400);
  }

  const { challenge, nonce } = regStore.issue(
    address,
    (n) => `ETH-Gate keypair v1\nAddress: ${address}\nNonce: ${n}`,
  );

  return json({ challenge, nonce });
}

export async function handleRegister({ req, ip }: Context): Promise<Response> {
  if (isRateLimited(`${ip}:register`)) {
    warn('[rate-limit] register', ip);
    return json({ error: 'Too many requests' }, 429);
  }

  let body: { address?: unknown; pubkey?: unknown; signature?: unknown; nonce?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    warn('[invalid] register malformed JSON');
    return json({ error: 'Invalid JSON' }, 400);
  }

  const address = typeof body.address === 'string' ? body.address.trim().toLowerCase() : '';
  let pubkey = typeof body.pubkey === 'string' ? body.pubkey.trim().toLowerCase() : '';
  if (pubkey.startsWith('0x')) pubkey = pubkey.slice(2);
  const signature = typeof body.signature === 'string' ? body.signature : '';
  const nonce = typeof body.nonce === 'string' ? body.nonce : '';

  if (!isValidAddress(address)) {
    warn('[invalid] register bad address', address);
    return json({ error: 'invalid address' }, 400);
  }
  if (!isHex(pubkey, 33)) {
    warn('[invalid] register bad pubkey', pubkey);
    return json({ error: 'pubkey must be 33-byte compressed hex' }, 400);
  }
  if (!isValidSig(signature)) {
    warn('[invalid] register bad signature format');
    return json({ error: 'invalid signature format' }, 400);
  }

  const challenge = regStore.consume(nonce, address);
  if (!challenge) {
    warn('[invalid] register challenge not found/expired', nonce);
    return json({ error: 'Invalid or expired challenge' }, 401);
  }

  const valid = await verifySig(challenge, signature, address);
  if (!valid) {
    warn('[invalid] register signature verification failed', address);
    return json({ error: 'signature verification failed' }, 401);
  }

  registerPubkey(address, pubkey);
  log('[reg]', address, 'pubkey:', `0x${pubkey}`);
  return json({ ok: true });
}
