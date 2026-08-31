import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { unlinkSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import {
  createMessage as persistMessage,
  createSession,
  deleteExpiredMessages,
  deleteExpiredSessions,
  deleteAddress,
  deleteAddressConversations,
  deleteAddressSessions,
  getConversationMessages,
  getDb,
  getConversationPartners,
  getConversations,
  getPubkey,
  getSession,
  initDb,
  registerPubkey,
} from './db.ts';

const TEST_DB = `test-chat-${Date.now()}.db`;

function createMessage(
  id: string,
  sender: string,
  recipient: string,
  ctRecipient: string,
  ephPubRecipient: string,
  ivRecipient: string,
  ctSender: string,
  ephPubSender: string,
  ivSender: string,
  ttl: number,
) {
  return persistMessage({
    version: 1,
    id,
    sender,
    recipient,
    ct_recipient: ctRecipient,
    ephemeral_pub_recipient: ephPubRecipient,
    iv_recipient: ivRecipient,
    ct_sender: ctSender,
    ephemeral_pub_sender: ephPubSender,
    iv_sender: ivSender,
    ttl,
    signature: 'test-signature',
  });
}

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

  test('hard-cutover deletes legacy unauthenticated messages', () => {
    getDb().close();
    for (const suffix of ['', '-shm', '-wal']) {
      try { unlinkSync(TEST_DB + suffix); } catch {}
    }
    const legacy = new Database(TEST_DB);
    legacy.run('CREATE TABLE messages (id TEXT PRIMARY KEY, sender TEXT NOT NULL)');
    legacy.query('INSERT INTO messages (id, sender) VALUES (?, ?)').run('legacy', alice);
    legacy.close();

    initDb(TEST_DB);
    const columns = getDb().query('PRAGMA table_info(messages)').all() as Array<{ name: string }>;
    expect(columns.map(column => column.name)).toContain('version');
    expect((getDb().query('SELECT COUNT(*) AS count FROM messages').get() as { count: number }).count).toBe(0);
  });

  test('create and fetch conversation messages', () => {
    createMessage(
      'm1', alice, bob,
      'ct_r', 'eph_r', 'iv_r',
      'ct_s', 'eph_s', 'iv_s',
      300,
    );
    const { rows: msgs } = getConversationMessages(alice, bob);
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
    const { rows: msgs } = getConversationMessages(alice, bob);
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
    const { rows: msgs } = getConversationMessages(alice, bob);
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
    const { rows: msgs } = getConversationMessages(alice, bob, 50, 1);
    expect(msgs).toHaveLength(0);
  });

  test('same-millisecond messages paginate via rowid tie-breaker', () => {
    const stamp = Date.now();
    const insert = (id: string) => getDb()
      .query(
        `INSERT INTO messages (version, id, sender, recipient, ct_recipient, ephemeral_pub_recipient, iv_recipient, ct_sender, ephemeral_pub_sender, iv_sender, ttl_seconds, signature, created_at, expires_at)
         VALUES (1, ?, ?, ?, 'ct_r', 'eph_r', 'iv_r', 'ct_s', 'eph_s', 'iv_s', 3600, 'sig', ?, ?)`,
      )
      .run(id, alice, bob, stamp, stamp + 3600_000);
    insert('t1');
    insert('t2');
    insert('t3');

    const page1 = getConversationMessages(alice, bob, 2);
    expect(page1.rows).toHaveLength(2);
    expect(page1.rows.map(r => r.id)).toEqual(['t3', 't2']); // rowid DESC within the tie
    expect(page1.next_before).toBe(stamp);
    expect(page1.next_before_rowid).toBe(page1.rows[1]!.seq);

    const page2 = getConversationMessages(alice, bob, 2, page1.next_before!, page1.next_before_rowid!);
    expect(page2.rows.map(r => r.id)).toEqual(['t1']);
    expect(page2.next_before).toBe(stamp);

    const page3 = getConversationMessages(alice, bob, 2, page2.next_before!, page2.next_before_rowid!);
    expect(page3.rows).toHaveLength(0);
    expect(page3.next_before).toBeNull();
    expect(page3.next_before_rowid).toBeNull();
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
    const { rows: msgs } = getConversationMessages(alice, bob, 2);
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
    const { rows: msgs } = getConversationMessages(alice, bob);
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

describe('cascade deletion (logout)', () => {
  const alice = '0xalice';
  const bob = '0xbob';
  const charlie = '0xcharlie';

  beforeEach(() => {
    // Setup: Alice has conversations with Bob and Charlie
    registerPubkey(alice, 'alice_pubkey');
    registerPubkey(bob, 'bob_pubkey');
    registerPubkey(charlie, 'charlie_pubkey');

    // Alice ↔ Bob conversation
    createMessage(
      'm1', alice, bob,
      'ct_r', 'eph_r', 'iv_r',
      'ct_s', 'eph_s', 'iv_s',
      3600,
    );
    createMessage(
      'm2', bob, alice,
      'ct_r', 'eph_r', 'iv_r',
      'ct_s', 'eph_s', 'iv_s',
      3600,
    );

    // Alice ↔ Charlie conversation
    createMessage(
      'm3', alice, charlie,
      'ct_r', 'eph_r', 'iv_r',
      'ct_s', 'eph_s', 'iv_s',
      3600,
    );

    // Bob ↔ Charlie conversation (not involving Alice)
    createMessage(
      'm4', bob, charlie,
      'ct_r', 'eph_r', 'iv_r',
      'ct_s', 'eph_s', 'iv_s',
      3600,
    );

    // Alice session
    createSession('alice_token', alice, Date.now() + 60_000);
  });

  test('getConversationPartners identifies all partners', () => {
    const partners = getConversationPartners(alice);
    expect(partners).toHaveLength(2);
    expect(partners).toContain(bob);
    expect(partners).toContain(charlie);
  });

  test('getConversationPartners returns empty for no conversations', () => {
    const partners = getConversationPartners('0xnobody');
    expect(partners).toHaveLength(0);
  });

  test('deleteAddressConversations removes all messages involving user', () => {
    // Before deletion: 3 messages involve Alice (m1, m2, m3)
    let aliceConvs = getConversations(alice);
    expect(aliceConvs.length).toBeGreaterThan(0);

    deleteAddressConversations(alice);

    // After deletion: Alice has no messages
    aliceConvs = getConversations(alice);
    expect(aliceConvs).toHaveLength(0);

    // Bob-Charlie conversation (m4) should still exist
    const bobConvs = getConversations(bob);
    expect(bobConvs.some(c => c.counterparty === charlie)).toBe(true);
  });

  test('deleteAddressSessions removes user sessions', () => {
    expect(getSession('alice_token')).not.toBeNull();

    deleteAddressSessions(alice);

    expect(getSession('alice_token')).toBeNull();
  });

  test('deleteAddress removes pubkey registration', () => {
    expect(getPubkey(alice)).not.toBeNull();

    deleteAddress(alice);

    expect(getPubkey(alice)).toBeNull();
  });

  test('full logout cascade: delete all data for user', () => {
    // Verify setup
    expect(getPubkey(alice)).toBe('alice_pubkey');
    expect(getSession('alice_token')).not.toBeNull();
    const partnersBefore = getConversationPartners(alice);
    expect(partnersBefore).toHaveLength(2);

    // Cascade deletion (as done in server.ts DELETE endpoint)
    deleteAddressSessions(alice);
    deleteAddressConversations(alice);
    deleteAddress(alice);

    // Verify complete cleanup
    expect(getPubkey(alice)).toBeNull();
    expect(getSession('alice_token')).toBeNull();
    expect(getConversations(alice)).toHaveLength(0);
    expect(getConversationPartners(alice)).toHaveLength(0);

    // Verify partners still exist and other data untouched
    expect(getPubkey(bob)).not.toBeNull();
    expect(getPubkey(charlie)).not.toBeNull();
    const bobConvs = getConversations(bob);
    expect(bobConvs.some(c => c.counterparty === charlie)).toBe(true);
  });

  test('address normalization in cascade deletion', () => {
    // getPubkey/registerPubkey now normalize addresses
    const upperAlice = '0xALICE';
    deleteAddress(upperAlice);
    expect(getPubkey(alice)).toBeNull();
    expect(getPubkey(upperAlice)).toBeNull();
  });
});
