import { issueRecoveryCursor, readRecoveryCursor } from '../recovery-cursor.ts';
import { createMessage, getMessageStates, recoverMessages, openMessages, getConversationMessages, getConversations, getPubkey, type MessageRow } from '../db.ts';
import { json, getSessionAddress } from '../http.ts';
import { stateIpLimiter, stateLimiter, openingIpLimiter, openingLimiter, messageIpLimiter, messageLimiter } from '../rate-limiters.ts';
import { notify } from '../sse.ts';
import { pushNotify } from '../push.ts';
import { log, warn, error, VALID_TTLS } from '../constants.ts';
import {
  MESSAGE_ENVELOPE_VERSION,
  parseMessageEnvelope,
  verifyMessageEnvelope,
  type DeliveredMessage,
  type OpeningResponse,
  type MessageLifecycle,
  type MessageEnvelope,
} from '../../shared/message-envelope.ts';
import type { Context } from '../http.ts';

function delivered(envelope: MessageEnvelope, lifecycle: MessageLifecycle): DeliveredMessage {
  return { ...envelope, delivery_policy: lifecycle.delivery_policy, created_at: lifecycle.created_at,
    opened_at: lifecycle.opened_at, expires_at: lifecycle.expires_at };
}

function deliveredRow(row: MessageRow): Record<string, unknown> {
  return {
    version: row.version,
    id: row.id,
    sender: row.sender,
    recipient: row.recipient,
    ttl: row.ttl_seconds,
    ct_recipient: row.ct_recipient,
    ephemeral_pub_recipient: row.ephemeral_pub_recipient,
    iv_recipient: row.iv_recipient,
    ct_sender: row.ct_sender,
    ephemeral_pub_sender: row.ephemeral_pub_sender,
    iv_sender: row.iv_sender,
    signature: row.signature,
    delivery_policy: row.delivery_policy,
    opened_at: row.opened_at,
    created_at: row.created_at,
    expires_at: row.expires_at,
  };
}

export async function handleSendMessage({ req, ip, testDeliveryPolicy }: Context): Promise<Response> {
  const sessionAddress = getSessionAddress(req);
  if (!sessionAddress) {
    warn('[unauth] message no session', ip);
    return json({ error: 'Unauthorized' }, 401);
  }

  if (messageIpLimiter.hit(ip) || messageLimiter.hit(`${ip}:${sessionAddress}`)) {
    warn('[rate-limit] msg', sessionAddress, ip);
    return json({ error: 'Too many requests' }, 429);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    warn('[invalid] message malformed JSON');
    return json({ error: 'Invalid JSON' }, 400);
  }

  if (typeof body === 'object' && body !== null
    && (body as Record<string, unknown>)['version'] !== MESSAGE_ENVELOPE_VERSION) {
    return json({ error: 'unsupported message envelope version' }, 400);
  }
  const parsed = parseMessageEnvelope(body);
  if (!parsed) return json({ error: 'malformed message envelope' }, 400);
  if (parsed.sender !== sessionAddress) {
    warn('[invalid] message sender/session mismatch', parsed.sender, sessionAddress);
    return json({ error: 'envelope sender does not match session' }, 403);
  }
  if (parsed.recipient === sessionAddress) {
    return json({ error: 'cannot message yourself' }, 400);
  }
  if (!VALID_TTLS.has(parsed.ttl)) return json({ error: 'invalid TTL' }, 400);
  if (!getPubkey(parsed.recipient)) return json({ error: 'Recipient not registered' }, 400);

  const envelope = await verifyMessageEnvelope(parsed);
  if (!envelope) {
    warn('[invalid] message signature', sessionAddress);
    return json({ error: 'invalid envelope signature' }, 400);
  }

  const stored = createMessage(envelope, testDeliveryPolicy);
  if (!stored) {
    warn('[invalid] message replay', envelope.id, sessionAddress);
    return json({ error: 'duplicate message ID' }, 409);
  }

  const event = delivered(envelope, stored);
  notify(envelope.recipient, 'message', event);
  notify(envelope.sender, 'message', event);
  pushNotify(envelope.recipient, envelope.ttl).catch((err) => error('[push] notify failed', envelope.recipient, err));

  log('[msg]', envelope.id, envelope.sender, '→', envelope.recipient, `ttl=${envelope.ttl}s`,
    `ct_r=${(envelope.ct_recipient.length - 2) / 2}B`, `ct_s=${(envelope.ct_sender.length - 2) / 2}B`);
  return json(event, 201);
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
  const beforeRowidParam = url.searchParams.get('before_rowid');
  const beforeRowidNum = beforeRowidParam ? Number(beforeRowidParam) : null;
  if (beforeRowidParam != null && (!Number.isSafeInteger(beforeRowidNum) || (beforeRowidNum ?? 0) <= 0)) {
    return json({ error: 'Invalid before_rowid parameter: must be a positive integer' }, 400);
  }
  const beforeRowid = beforeRowidNum && beforeRowidNum > 0 ? beforeRowidNum : undefined;
  const limitParam = url.searchParams.get('limit');
  const limitNum = limitParam ? Number(limitParam) : null;
  if (limitParam != null && (!Number.isSafeInteger(limitNum) || (limitNum ?? 0) <= 0)) {
    return json({ error: 'Invalid limit parameter: must be a positive integer' }, 400);
  }
  const limit = limitNum && limitNum > 0 ? Math.min(limitNum, 100) : 50;

  const page = getConversationMessages(address, counterparty, limit, before, beforeRowid);
  return json({
    messages: page.rows.map(deliveredRow),
    // Server-issued cursor for the next older page; null when exhausted.
    next_before: page.next_before,
    next_before_rowid: page.next_before_rowid,
    recovery_cursor: issueRecoveryCursor(address, counterparty, page.recovery_sequence),
  });
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

export async function handleOpenMessages({ req, path, ip }: Context): Promise<Response> {
  const address = getSessionAddress(req);
  if (!address) {
    warn('[unauth] open messages no session', ip);
    return json({ error: 'Unauthorized' }, 401);
  }
  if (openingIpLimiter.hit(ip) || openingLimiter.hit(address)) {
    warn('[rate-limit] open messages', address, ip);
    return json({ error: 'Too many requests' }, 429);
  }
  const ids = await readMessageIds(req);
  if (ids instanceof Response) return ids;
  const counterparty = path.split('/')[3]!.toLowerCase();
  const { updates, server_time, results } = openMessages(address, counterparty, ids);
  const response: OpeningResponse = { server_time, results };
  for (const update of updates) {
    notify(update.sender, 'expiry-update', update);
    notify(update.recipient, 'expiry-update', update);
  }
  log('[open]', address, counterparty, `requested=${ids.length}`, `opened=${updates.length}`);
  return json(response);
}

export async function handleRecoverMessages({ req, url, path }: Context): Promise<Response> {
  const address = getSessionAddress(req);
  if (!address) return json({ error: 'Unauthorized' }, 401);
  const counterparty = path.split('/')[3]!.toLowerCase();
  const after = url.searchParams.get('after');
  const continuation = url.searchParams.get('cursor');
  if ((after === null) === (continuation === null)
    || [...url.searchParams.keys()].some(key => key !== 'after' && key !== 'cursor')
    || url.searchParams.size !== 1) return json({ error: 'Supply one recovery cursor' }, 400);
  const cursor = readRecoveryCursor((after ?? continuation)!, address, counterparty);
  if (!cursor || (after !== null ? cursor.upper !== null : cursor.upper === null)) {
    return json({ error: 'Invalid recovery cursor' }, 400);
  }
  const page = recoverMessages(address, counterparty, cursor.lower, cursor.upper ?? undefined);
  return json({
    messages: page.rows.map(deliveredRow),
    server_time: page.server_time,
    exhausted: page.exhausted,
    next_cursor: page.exhausted ? null : issueRecoveryCursor(address, counterparty, page.rows.at(-1)!.acceptance_seq, page.upper),
    recovery_cursor: page.exhausted ? issueRecoveryCursor(address, counterparty, page.upper) : null,
  });
}

async function readMessageIds(req: Request): Promise<string[] | Response> {
  // Bound streaming bodies too; Content-Length is neither required nor trusted.
  const reader = req.body?.getReader();
  if (!reader) return json({ error: 'Invalid message ID request' }, 400);
  let body: unknown;
  try {
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8192) {
        await reader.cancel();
        return json({ error: 'Message ID request too large' }, 413);
      }
      chunks.push(new Uint8Array(value));
    }
    body = JSON.parse(await new Blob(chunks).text());
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  } finally {
    reader.releaseLock();
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).join(',') !== 'ids') return json({ error: 'Invalid message ID request' }, 400);
  const ids = (body as { ids: unknown }).ids;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100
    || ids.some(id => typeof id !== 'string' || !/^0x[0-9a-f]{32}$/.test(id))
    || new Set(ids).size !== ids.length) return json({ error: 'Invalid message IDs' }, 400);
  return ids;
}

export async function handleMessageStates({ req, path, ip }: Context): Promise<Response> {
  const address = getSessionAddress(req);
  if (!address) return json({ error: 'Unauthorized' }, 401);
  if (stateIpLimiter.hit(ip) || stateLimiter.hit(address)) return json({ error: 'Too many requests' }, 429);
  const ids = await readMessageIds(req);
  if (ids instanceof Response) return ids;
  return json(getMessageStates(address, path.split('/')[3]!.toLowerCase(), ids));
}
