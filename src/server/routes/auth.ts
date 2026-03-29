import { randomBytes } from 'node:crypto';
import { ChallengeStore } from '../challenge.ts';
import { createSession } from '../db.ts';
import { json } from '../http.ts';
import { isRateLimited } from '../rate-limit.ts';
import { isValidAddress, isValidSig } from '../validation.ts';
import { verifySig } from '../verify.ts';
import { log, warn, SESSION_TTL_MS } from '../constants.ts';
import type { Context } from '../http.ts';

export const authStore = new ChallengeStore();

export async function handleAuthChallenge({ req, ip }: Context): Promise<Response> {
  if (isRateLimited(`${ip}:auth`)) {
    warn('[rate-limit] auth-challenge', ip);
    return json({ error: 'Too many requests' }, 429);
  }

  let body: { address?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    warn('[invalid] auth-challenge malformed JSON');
    return json({ error: 'Invalid JSON' }, 400);
  }

  const address = typeof body.address === 'string' ? body.address.trim().toLowerCase() : '';
  if (!isValidAddress(address)) {
    warn('[invalid] auth-challenge bad address', address);
    return json({ error: 'invalid address' }, 400);
  }

  const { challenge, nonce } = authStore.issue(
    address,
    (n) => `ETH-Chat session request\nAddress: ${address}\nNonce: ${n}`,
  );

  return json({ challenge, nonce });
}

export async function handleAuthSession({ req, ip }: Context): Promise<Response> {
  if (isRateLimited(`${ip}:session`)) {
    warn('[rate-limit] auth-session', ip);
    return json({ error: 'Too many requests' }, 429);
  }

  let body: { nonce?: unknown; signature?: unknown; address?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    warn('[invalid] auth-session malformed JSON');
    return json({ error: 'Invalid JSON' }, 400);
  }

  const nonce = typeof body.nonce === 'string' ? body.nonce : '';
  const signature = typeof body.signature === 'string' ? body.signature : '';
  const address = typeof body.address === 'string' ? body.address.trim().toLowerCase() : '';

  if (!isValidAddress(address)) {
    warn('[invalid] auth-session bad address', address);
    return json({ error: 'invalid address' }, 400);
  }
  if (!isValidSig(signature)) {
    warn('[invalid] auth-session bad signature format');
    return json({ error: 'invalid signature format' }, 400);
  }

  const challenge = authStore.consume(nonce, address);
  if (!challenge) {
    warn('[invalid] auth-session challenge not found/expired', nonce);
    return json({ error: 'Challenge expired or not found' }, 401);
  }

  const valid = await verifySig(challenge, signature, address);
  if (!valid) {
    warn('[invalid] auth-session signature verification failed', address);
    return json({ error: 'Signature verification failed' }, 401);
  }

  const token = randomBytes(32).toString('hex');
  const expiresAt = Date.now() + SESSION_TTL_MS;
  createSession(token, address, expiresAt);
  log('[auth]', address, 'session created');
  return json({ token, expires_at: expiresAt });
}
