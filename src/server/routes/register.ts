import { ChallengeStore } from '../challenge.ts';
import { registerPubkey } from '../db.ts';
import { json } from '../http.ts';
import { registerChallengeLimiter, registerLimiter } from '../rate-limiters.ts';
import { isValidAddress, isValidSig, normalizeAddressBoundPubkey } from '../validation.ts';
import { verifySig } from '../verify.ts';
import { log, warn } from '../constants.ts';
import { buildRegistrationChallenge } from '../../shared/registration-challenge.ts';
import type { Context } from '../http.ts';

export const regStore = new ChallengeStore();

function registrationSubject(address: string, pubkey: string): string {
  return `${address}:${pubkey}`;
}

function requestOrigin(req: Request): string | null {
  const value = req.headers.get('Origin') ?? new URL(req.url).origin;
  try {
    const url = new URL(value);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.origin !== value) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export async function handleRegisterChallenge({ req, ip }: Context): Promise<Response> {
  if (registerChallengeLimiter.hit(ip)) {
    warn('[rate-limit] register-challenge', ip);
    return json({ error: 'Too many requests' }, 429);
  }

  let body: { address?: unknown; pubkey?: unknown };
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

  const pubkey = normalizeAddressBoundPubkey(address, body.pubkey);
  if (!pubkey) {
    warn('[invalid]', '/api/register/challenge', 'bad or mismatched pubkey');
    return json({ error: 'Invalid public key for address' }, 400);
  }

  const origin = requestOrigin(req);
  if (!origin) return json({ error: 'Invalid origin' }, 400);

  const { challenge, nonce } = regStore.issue(
    registrationSubject(address, pubkey),
    (n) => buildRegistrationChallenge(origin, address, pubkey, n),
  );

  return json({ challenge, nonce });
}

export async function handleRegister({ req, ip }: Context): Promise<Response> {
  if (registerLimiter.hit(ip)) {
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
  const signature = typeof body.signature === 'string' ? body.signature : '';
  const nonce = typeof body.nonce === 'string' ? body.nonce : '';

  if (!isValidAddress(address)) {
    warn('[invalid] register bad address', address);
    return json({ error: 'invalid address' }, 400);
  }
  const pubkey = normalizeAddressBoundPubkey(address, body.pubkey);
  if (!pubkey) {
    warn('[invalid] register bad or mismatched pubkey');
    return json({ error: 'invalid public key for address' }, 400);
  }
  if (!isValidSig(signature)) {
    warn('[invalid] register bad signature format');
    return json({ error: 'invalid signature format' }, 400);
  }

  const challenge = regStore.consume(nonce, registrationSubject(address, pubkey));
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
