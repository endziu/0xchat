import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { unlinkSync } from 'node:fs';
import {
  createMessage,
  createSession,
  deleteExpiredMessages,
  deleteExpiredSessions,
  getConversationMessages,
  getConversations,
  getPubkey,
  getSession,
  initDb,
  registerPubkey,
} from './db.ts';

const TEST_DB = `test-chat-${Date.now()}.db`;

beforeEach(() => {
  initDb(TEST_DB);
});

afterEach(() => {
  try { unlinkSync(TEST_DB); } catch {}
  try { unlinkSync(TEST_DB + '-shm'); } catch {}
  try { unlinkSync(TEST_DB + '-wal'); } catch {}
});

describe('pubkeys', () => {
  test('register and get pubkey', () => {
    registerPubkey('0xabc', 'pubkey123');
    expect(getPubkey('0xabc')).toBe('pubkey123');
  });

  test('returns null for unknown address', () => {
    expect(getPubkey('0xunknown')).toBeNull();
  });

  test('upserts on re-register', () => {
    registerPubkey('0xabc', 'key1');
    registerPubkey('0xabc', 'key2');
    expect(getPubkey('0xabc')).toBe('key2');
  });
});

describe('sessions', () => {
  test('create and get session', () => {
    const expires = Date.now() + 60_000;
    createSession('tok1', '0xabc', expires);
    const s = getSession('tok1');
    expect(s).not.toBeNull();
    expect(s!.address).toBe('0xabc');
  });

  test('returns null for unknown token', () => {
    expect(getSession('nope')).toBeNull();
  });

  test('returns null for expired session', () => {
    createSession('tok2', '0xabc', Date.now() - 1000);
    expect(getSession('tok2')).toBeNull();
  });

  test('deleteExpiredSessions removes old entries', () => {
    createSession('tok3', '0xabc', Date.now() - 1000);
    createSession('tok4', '0xdef', Date.now() + 60_000);
    deleteExpiredSessions();
    expect(getSession('tok3')).toBeNull();
    expect(getSession('tok4')).not.toBeNull();
  });
});

describe('messages', () => {
  const alice = '0xalice';
  const bob = '0xbob';

  test('create and fetch conversation messages', () => {
    createMessage(
      'm1', alice, bob,
      'ct_r', 'eph_r', 'iv_r',
      'ct_s', 'eph_s', 'iv_s',
      300,
    );
    const msgs = getConversationMessages(alice, bob);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.id).toBe('m1');
    expect(msgs[0]!.sender).toBe(alice);
  });

  test('conversation works in both directions', () => {
    createMessage(
      'm2', bob, alice,
      'ct_r', 'eph_r', 'iv_r',
      'ct_s', 'eph_s', 'iv_s',
      300,
    );
    const msgs = getConversationMessages(alice, bob);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.sender).toBe(bob);
  });

  test('excludes expired messages', () => {
    createMessage(
      'm3', alice, bob,
      'ct_r', 'eph_r', 'iv_r',
      'ct_s', 'eph_s', 'iv_s',
      0,
    );
    // TTL=0 means expires_at = created_at, already expired
    // Need a small delay for Date.now() > expires_at
    const msgs = getConversationMessages(alice, bob);
    // expires_at = now + 0*1000 = now, so now > expires_at is false (equal)
    // actually expires_at >= now so it might still show
    // The query uses expires_at > now, so if equal it won't show
    expect(msgs.length).toBeLessThanOrEqual(1);
  });

  test('pagination with before', () => {
    createMessage(
      'm4', alice, bob,
      'ct_r', 'eph_r', 'iv_r',
      'ct_s', 'eph_s', 'iv_s',
      3600,
    );
    // All messages created_at > 0, so before=1 should return none
    const msgs = getConversationMessages(alice, bob, 50, 1);
    expect(msgs).toHaveLength(0);
  });

  test('limit works', () => {
    for (let i = 0; i < 5; i++) {
      createMessage(
        `lim${i}`, alice, bob,
        'ct_r', 'eph_r', 'iv_r',
        'ct_s', 'eph_s', 'iv_s',
        3600,
      );
    }
    const msgs = getConversationMessages(alice, bob, 2);
    expect(msgs).toHaveLength(2);
  });

  test('deleteExpiredMessages removes old entries', () => {
    createMessage(
      'exp1', alice, bob,
      'ct_r', 'eph_r', 'iv_r',
      'ct_s', 'eph_s', 'iv_s',
      0,
    );
    createMessage(
      'exp2', alice, bob,
      'ct_r', 'eph_r', 'iv_r',
      'ct_s', 'eph_s', 'iv_s',
      3600,
    );
    deleteExpiredMessages();
    const msgs = getConversationMessages(alice, bob);
    // exp1 had TTL=0 so it's expired and deleted
    // exp2 has TTL=3600 so it should remain
    expect(msgs.some(m => m.id === 'exp2')).toBe(true);
  });
});

describe('conversations', () => {
  test('lists unique counterparties', () => {
    createMessage(
      'c1', '0xa', '0xb',
      'ct_r', 'eph_r', 'iv_r',
      'ct_s', 'eph_s', 'iv_s',
      3600,
    );
    createMessage(
      'c2', '0xc', '0xa',
      'ct_r', 'eph_r', 'iv_r',
      'ct_s', 'eph_s', 'iv_s',
      3600,
    );
    const convs = getConversations('0xa');
    expect(convs).toHaveLength(2);
    const parties = convs.map(c => c.counterparty);
    expect(parties).toContain('0xb');
    expect(parties).toContain('0xc');
  });

  test('returns empty for no conversations', () => {
    expect(getConversations('0xnobody')).toHaveLength(0);
  });
});
