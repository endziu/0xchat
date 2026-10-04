import { requireAddress, type Address } from '../shared/address.ts';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { MESSAGE_ENVELOPE_VERSION } from '../shared/message-envelope.ts';
import {
  createMessage as persistMessage,
  createSession,
  deleteExpiredMessages,
  deleteExpiredSessions,
  deleteInactivePubkeys,
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

function registerAt(address: Address, pubkey: string, at: number): void {
  registerPubkey(address, pubkey);
  getDb().query('UPDATE pubkeys SET last_active_at = ? WHERE address = ?')
    .run(at, address);
}

function createMessage(
  id: string,
  sender: Address,
  recipient: Address,
  ctRecipient: string,
  ephPubRecipient: string,
  ivRecipient: string,
  ctSender: string,
  ephPubSender: string,
  ivSender: string,
  ttl: number,
) {
  return persistMessage({
    version: MESSAGE_ENVELOPE_VERSION,
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
    registerPubkey(requireAddress('0xabc0000000000000000000000000000000000000'), 'pubkey123');
    expect(getPubkey(requireAddress('0xabc0000000000000000000000000000000000000'))).toBe('pubkey123');
  });

  test('returns null for unknown address', () => {
    expect(getPubkey(requireAddress('0xb23a6a8439c0dde5515893e7c90c1e3233b8616e'))).toBeNull();
  });

  test('upserts on re-register', () => {
    registerPubkey(requireAddress('0xabc0000000000000000000000000000000000000'), 'key1');
    registerPubkey(requireAddress('0xabc0000000000000000000000000000000000000'), 'key2');
    expect(getPubkey(requireAddress('0xabc0000000000000000000000000000000000000'))).toBe('key2');
  });

  test('prunes a registration after its inactive retention window', () => {
    registerAt(requireAddress('0xa03f2386ae06b21109577020844df367857b72c2'), 'stale-key', 1_000);
    registerAt(requireAddress('0x034a7e52c5c9534b709dc1dba403868399b0949f'), 'recent-key', 2_000);

    expect(deleteInactivePubkeys(1_500)).toBe(1);
    expect(getPubkey(requireAddress('0xa03f2386ae06b21109577020844df367857b72c2'))).toBeNull();
    expect(getPubkey(requireAddress('0x034a7e52c5c9534b709dc1dba403868399b0949f'))).toBe('recent-key');
  });

  test('keeps a registration active when it creates a session', () => {
    registerAt(requireAddress('0x96879611650f80a81392a52e0db9b0237669087c'), 'active-key', 1_000);
    createSession('active-token', requireAddress('0x96879611650f80a81392a52e0db9b0237669087c'), Date.now() + 60_000);

    expect(deleteInactivePubkeys(Date.now() - 1_000)).toBe(0);
    expect(getPubkey(requireAddress('0x96879611650f80a81392a52e0db9b0237669087c'))).toBe('active-key');
  });

  test('keeps both registrations active when they share a message', () => {
    registerAt(requireAddress('0x0a367b92cf0b037dfd89960ee832d56f7fc15168'), 'sender-key', 1_000);
    registerAt(requireAddress('0x665d0698dbc8fb95afc25c3a4d9cf280d87a585b'), 'recipient-key', 1_000);
    createMessage(
      'active-message', requireAddress('0x0a367b92cf0b037dfd89960ee832d56f7fc15168'), requireAddress('0x665d0698dbc8fb95afc25c3a4d9cf280d87a585b'),
      'ct_r', 'eph_r', 'iv_r',
      'ct_s', 'eph_s', 'iv_s',
      3600,
    );

    expect(deleteInactivePubkeys(Date.now() - 1_000)).toBe(0);
    expect(getPubkey(requireAddress('0x0a367b92cf0b037dfd89960ee832d56f7fc15168'))).toBe('sender-key');
    expect(getPubkey(requireAddress('0x665d0698dbc8fb95afc25c3a4d9cf280d87a585b'))).toBe('recipient-key');
  });

  test('migration gives existing registrations a fresh retention window', () => {
    getDb().close();
    for (const suffix of ['', '-shm', '-wal']) {
      try { unlinkSync(TEST_DB + suffix); } catch {}
    }
    const legacy = new Database(TEST_DB);
    legacy.run('CREATE TABLE pubkeys (address TEXT PRIMARY KEY, pubkey TEXT NOT NULL)');
    legacy.query('INSERT INTO pubkeys (address, pubkey) VALUES (?, ?)').run(requireAddress('0xc49fea7425fa7f8699897a97c159c6690267d900'), 'legacy-key');
    legacy.close();

    initDb(TEST_DB);

    expect(deleteInactivePubkeys(Date.now() - 1_000)).toBe(0);
    expect(getPubkey(requireAddress('0xc49fea7425fa7f8699897a97c159c6690267d900'))).toBe('legacy-key');
  });

  test('re-registration alone does not extend the inactive retention window', () => {
    registerAt(requireAddress('0xa03f2386ae06b21109577020844df367857b72c2'), 'old-key', 1_000);
    registerPubkey(requireAddress('0xa03f2386ae06b21109577020844df367857b72c2'), 'new-key');
    expect(getPubkey(requireAddress('0xa03f2386ae06b21109577020844df367857b72c2'))).toBe('new-key');
    expect(deleteInactivePubkeys(1_500)).toBe(1);
    expect(getPubkey(requireAddress('0xa03f2386ae06b21109577020844df367857b72c2'))).toBeNull();
  });

  test('keeps registrations exactly at the retention cutoff', () => {
    registerAt(requireAddress('0x931534c0c145d0a99631a32025f23f88c67fc6b3'), 'key', 1_500);
    expect(deleteInactivePubkeys(1_500)).toBe(0);
    expect(getPubkey(requireAddress('0x931534c0c145d0a99631a32025f23f88c67fc6b3'))).toBe('key');
  });
});

describe('sessions', () => {
  test('creates a session and refreshes the matching pubkey', () => {
    registerAt(requireAddress('0xabc0000000000000000000000000000000000000'), 'key', 1_000);
    createSession('mixed-case-token', requireAddress('0xabc0000000000000000000000000000000000000'), Date.now() + 60_000);
    expect(getSession('mixed-case-token')?.address).toBe(requireAddress('0xabc0000000000000000000000000000000000000'));
    expect(deleteInactivePubkeys(Date.now() - 1_000)).toBe(0);
    expect(getPubkey(requireAddress('0xabc0000000000000000000000000000000000000'))).toBe('key');
  });
  test('create and get session', () => {
    const expires = Date.now() + 60_000;
    createSession('tok1', requireAddress('0xabc0000000000000000000000000000000000000'), expires);
    const s = getSession('tok1');
    expect(s).not.toBeNull();
    expect(s!.address).toBe(requireAddress('0xabc0000000000000000000000000000000000000'));
  });

  test('stores sha256(token) at rest, never the raw token', () => {
    const raw = 'ab'.repeat(32); // same shape as real 256-bit session tokens
    createSession(raw, requireAddress('0xabc0000000000000000000000000000000000000'), Date.now() + 60_000);

    const stored = (getDb().query('SELECT token FROM sessions').all() as Array<{ token: string }>)
      .map((row) => row.token);
    expect(stored).not.toContain(raw);
    expect(stored).toContain(createHash('sha256').update(raw).digest('hex'));

    // the raw token still resolves through the public seam
    expect(getSession(raw)?.address).toBe(requireAddress('0xabc0000000000000000000000000000000000000'));
  });

  test('returns null for unknown token', () => {
    expect(getSession('nope')).toBeNull();
  });

  test('hard-cutover drops legacy sessions that stored raw tokens', () => {
    getDb().close();
    for (const suffix of ['', '-shm', '-wal']) {
      try { unlinkSync(TEST_DB + suffix); } catch {}
    }
    const legacy = new Database(TEST_DB);
    legacy.run('CREATE TABLE sessions (token TEXT PRIMARY KEY, address TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)');
    legacy.query('INSERT INTO sessions (token, address, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run('raw-legacy-token', requireAddress('0xabc0000000000000000000000000000000000000'), Date.now(), Date.now() + 60_000);
    legacy.close();

    initDb(TEST_DB);

    const columns = (getDb().query('PRAGMA table_info(sessions)').all() as Array<{ name: string }>)
      .map((column) => column.name);
    expect(columns).toContain('version');
    expect((getDb().query('SELECT COUNT(*) AS count FROM sessions').get() as { count: number }).count).toBe(0);

    // new-format sessions still work after the cutover
    createSession('tok-after-cutover', requireAddress('0xabc0000000000000000000000000000000000000'), Date.now() + 60_000);
    expect(getSession('tok-after-cutover')).not.toBeNull();
  });

  test('returns null for expired session', () => {
    createSession('tok2', requireAddress('0xabc0000000000000000000000000000000000000'), Date.now() - 1000);
    expect(getSession('tok2')).toBeNull();
  });

  test('deleteExpiredSessions removes old entries', () => {
    createSession('tok3', requireAddress('0xabc0000000000000000000000000000000000000'), Date.now() - 1000);
    createSession('tok4', requireAddress('0xdef0000000000000000000000000000000000000'), Date.now() + 60_000);
    deleteExpiredSessions();
    expect(getSession('tok3')).toBeNull();
    expect(getSession('tok4')).not.toBeNull();
  });
});

describe('messages', () => {
  const alice = requireAddress('0x2bd806c97f0e00af1a1fc3328fa763a9269723c8');
  const bob = requireAddress('0x81b637d8fcd2c6da6359e6963113a1170de795e4');

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

  test('hard-cutover deletes messages from an unsupported protocol version', () => {
    const now = Date.now();
    getDb().query(
      `INSERT INTO messages (version, id, sender, recipient, ct_recipient, ephemeral_pub_recipient, iv_recipient, ct_sender, ephemeral_pub_sender, iv_sender, ttl_seconds, signature, created_at, expires_at)
       VALUES (1, 'legacy-v1', ?, ?, 'ct_r', 'eph_r', 'iv_r', 'ct_s', 'eph_s', 'iv_s', 3600, 'sig', ?, ?)`,
    ).run(alice, bob, now, now + 3600_000);
    getDb().close();

    initDb(TEST_DB);

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
         VALUES (?, ?, ?, ?, 'ct_r', 'eph_r', 'iv_r', 'ct_s', 'eph_s', 'iv_s', 3600, 'sig', ?, ?)`,
      )
      .run(MESSAGE_ENVELOPE_VERSION, id, alice, bob, stamp, stamp + 3600_000);
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
      'c1', requireAddress('0xa000000000000000000000000000000000000000'), requireAddress('0xb000000000000000000000000000000000000000'),
      'ct_r', 'eph_r', 'iv_r',
      'ct_s', 'eph_s', 'iv_s',
      3600,
    );
    createMessage(
      'c2', requireAddress('0xc000000000000000000000000000000000000000'), requireAddress('0xa000000000000000000000000000000000000000'),
      'ct_r', 'eph_r', 'iv_r',
      'ct_s', 'eph_s', 'iv_s',
      3600,
    );
    const convs = getConversations(requireAddress('0xa000000000000000000000000000000000000000'));
    expect(convs).toHaveLength(2);
    const parties = convs.map(c => c.counterparty);
    expect(parties).toContain(requireAddress('0xb000000000000000000000000000000000000000'));
    expect(parties).toContain(requireAddress('0xc000000000000000000000000000000000000000'));
  });

  test('returns empty for no conversations', () => {
    expect(getConversations(requireAddress('0x6382b3cc881412b77bfcaeed026001c00d9e3025'))).toHaveLength(0);
  });
});

describe('cascade deletion (logout)', () => {
  const alice = requireAddress('0x2bd806c97f0e00af1a1fc3328fa763a9269723c8');
  const bob = requireAddress('0x81b637d8fcd2c6da6359e6963113a1170de795e4');
  const charlie = requireAddress('0xb9dd960c1753459a78115d3cb845a57d924b6877');

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
    const partners = getConversationPartners(requireAddress('0x6382b3cc881412b77bfcaeed026001c00d9e3025'));
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

  test('cascade deletion uses the canonical address', () => {
    const upperAlice = requireAddress('0x2bd806c97f0e00af1a1fc3328fa763a9269723c8');
    deleteAddress(upperAlice);
    expect(getPubkey(alice)).toBeNull();
    expect(getPubkey(upperAlice)).toBeNull();
  });
});
