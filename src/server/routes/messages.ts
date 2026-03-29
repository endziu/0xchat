import { randomBytes } from 'node:crypto';
import { createMessage, getConversationMessages, getConversations, getPubkey } from '../db.ts';
import { json, getSessionAddress } from '../http.ts';
import { isRateLimited } from '../rate-limit.ts';
import { isValidAddress, isHex, normalizeHex } from '../validation.ts';
import { notify } from '../sse.ts';
import { log, warn, VALID_TTLS } from '../constants.ts';
import type { Context } from '../http.ts';

export async function handleSendMessage({ req, ip }: Context): Promise<Response> {
  const sender = getSessionAddress(req);
  if (!sender) {
    warn('[unauth] message no session', ip);
    return json({ error: 'Unauthorized' }, 401);
  }

  if (isRateLimited(`${ip}:${sender}:msg`)) {
    warn('[rate-limit] msg', sender, ip);
    return json({ error: 'Too many requests' }, 429);
  }

  let body: {
    recipient?: unknown;
    ct_recipient?: unknown; ephemeral_pub_recipient?: unknown; iv_recipient?: unknown;
    ct_sender?: unknown; ephemeral_pub_sender?: unknown; iv_sender?: unknown;
    ttl?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    warn('[invalid] message malformed JSON');
    return json({ error: 'Invalid JSON' }, 400);
  }

  const recipient = typeof body.recipient === 'string' ? body.recipient.trim().toLowerCase() : '';
  const ctRecipient = normalizeHex(body.ct_recipient);
  const ephPubRecipient = normalizeHex(body.ephemeral_pub_recipient);
  const ivRecipient = normalizeHex(body.iv_recipient);
  const ctSender = normalizeHex(body.ct_sender);
  const ephPubSender = normalizeHex(body.ephemeral_pub_sender);
  const ivSender = normalizeHex(body.iv_sender);
  const ttl = typeof body.ttl === 'number' ? body.ttl : 300;

  if (!isValidAddress(recipient)) {
    warn('[invalid] message bad recipient', recipient);
    return json({ error: 'invalid recipient address' }, 400);
  }
  if (recipient === sender) {
    warn('[invalid] message self-message', sender);
    return json({ error: 'cannot message yourself' }, 400);
  }
  if (!VALID_TTLS.has(ttl)) {
    warn('[invalid] message bad ttl', ttl);
    return json({ error: 'invalid TTL' }, 400);
  }
  if (!isHex(ctRecipient) || ctRecipient.length > 2_000_000) {
    return json({ error: 'ct_recipient must be non-empty hex (max 1 MB)' }, 400);
  }
  if (!isHex(ephPubRecipient, 33)) {
    return json({ error: 'ephemeral_pub_recipient must be 33-byte hex' }, 400);
  }
  if (!isHex(ivRecipient, 12)) {
    return json({ error: 'iv_recipient must be 12-byte hex' }, 400);
  }
  if (!isHex(ctSender) || ctSender.length > 2_000_000) {
    return json({ error: 'ct_sender must be non-empty hex (max 1 MB)' }, 400);
  }
  if (!isHex(ephPubSender, 33)) {
    return json({ error: 'ephemeral_pub_sender must be 33-byte hex' }, 400);
  }
  if (!isHex(ivSender, 12)) {
    return json({ error: 'iv_sender must be 12-byte hex' }, 400);
  }
  if (!getPubkey(recipient)) {
    warn('[invalid] message recipient not registered', recipient);
    return json({ error: 'Recipient not registered' }, 400);
  }

  const id = randomBytes(8).toString('hex');
  createMessage(id, sender, recipient, ctRecipient, ephPubRecipient, ivRecipient, ctSender, ephPubSender, ivSender, ttl);

  const now = Date.now();
  const expiresAt = now + ttl * 1000;
  const event = {
    id, sender, recipient,
    ct_recipient: ctRecipient, ephemeral_pub_recipient: ephPubRecipient, iv_recipient: ivRecipient,
    ct_sender: ctSender, ephemeral_pub_sender: ephPubSender, iv_sender: ivSender,
    ttl, created_at: now, expires_at: expiresAt,
  };
  notify(recipient, 'message', event);
  notify(sender, 'message', event);

  log('[msg]', id, sender, '→', recipient, `ttl=${ttl}s`, `ct_r=${ctRecipient.length / 2}B`, `ct_s=${ctSender.length / 2}B`);
  return json({ id, created_at: now, expires_at: expiresAt }, 201);
}

export async function handleGetMessages({ req, url, path, ip }: Context): Promise<Response> {
  const address = getSessionAddress(req);
  if (!address) {
    warn('[unauth] get messages no session', ip);
    return json({ error: 'Unauthorized' }, 401);
  }

  const match = path.match(/^\/api\/messages\/(0x[0-9a-fA-F]{40})$/);
  const counterparty = match![1]!.toLowerCase();

  const beforeParam = url.searchParams.get('before');
  const beforeNum = beforeParam ? Number(beforeParam) : null;
  if (beforeParam != null && (!Number.isSafeInteger(beforeNum) || (beforeNum ?? 0) <= 0)) {
    return json({ error: 'Invalid before parameter: must be a positive integer' }, 400);
  }
  const before = beforeNum && beforeNum > 0 ? beforeNum : undefined;
  const limitParam = url.searchParams.get('limit');
  const limit = limitParam ? Math.min(Math.max(Number(limitParam), 1), 100) : 50;

  const msgs = getConversationMessages(address, counterparty, limit, before);
  const prefixedMsgs = msgs.map((m) => ({
    ...m,
    ct_recipient: `0x${m.ct_recipient}`,
    ephemeral_pub_recipient: `0x${m.ephemeral_pub_recipient}`,
    iv_recipient: `0x${m.iv_recipient}`,
    ct_sender: `0x${m.ct_sender}`,
    ephemeral_pub_sender: `0x${m.ephemeral_pub_sender}`,
    iv_sender: `0x${m.iv_sender}`,
  }));

  return json({ messages: prefixedMsgs });
}

export async function handleGetConversations({ req, ip }: Context): Promise<Response> {
  const address = getSessionAddress(req);
  if (!address) {
    warn('[unauth] get conversations no session', ip);
    return json({ error: 'Unauthorized' }, 401);
  }

  const convs = getConversations(address);
  return json({
    conversations: convs.map((c) => ({ address: c.counterparty, last_message_at: c.last_message_at })),
  });
}
