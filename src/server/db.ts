import type { Address } from '../shared/address.ts';
import { Database } from 'bun:sqlite';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { MESSAGE_ENVELOPE_VERSION, UNOPENED_RETENTION_MS, type MessageLifecycle, type OpeningResult, type ExpiryUpdate, type MessageEnvelope } from '../shared/message-envelope.ts';

// Session tokens are stored as sha256 hex digests so a copy of the database
// never yields a valid bearer token. Callers keep using the raw token; the
// digest is computed here, at the only place that writes or reads the column.
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

let db: Database;

function tableColumns(table: 'pubkeys' | 'sessions' | 'messages'): Set<string> {
  const columns = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(columns.map((column) => column.name));
}

function markAddressesActive(addresses: Address[], at: number): void {
  const placeholders = addresses.map(() => '?').join(', ');
  db.query(`UPDATE pubkeys SET last_active_at = ? WHERE address IN (${placeholders})`)
    .run(at, ...addresses);
}

export function initDb(path = 'chat.db'): void {
  db = new Database(path);
  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA foreign_keys = ON');
  const pubkeyColumns = tableColumns('pubkeys');
  if (pubkeyColumns.size > 0 && !pubkeyColumns.has('last_active_at')) {
    db.run('ALTER TABLE pubkeys ADD COLUMN last_active_at INTEGER NOT NULL DEFAULT 0');
    db.query('UPDATE pubkeys SET last_active_at = ? WHERE last_active_at = 0').run(Date.now());
  }
  const sessionColumns = tableColumns('sessions');
  if (sessionColumns.size > 0 && !sessionColumns.has('version')) {
    // Legacy sessions stored the raw bearer token; the digest format cannot upgrade them.
    db.run('DROP TABLE sessions');
  }
  db.run(`
    CREATE TABLE IF NOT EXISTS pubkeys (
      address        TEXT PRIMARY KEY,
      pubkey         TEXT NOT NULL,
      last_active_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pubkeys_last_active
      ON pubkeys(last_active_at);

    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY, -- sha256 hex digest of the bearer token, never the raw token
      address    TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      version    INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_expires
      ON sessions(expires_at);

    CREATE TABLE IF NOT EXISTS daily_activity_totals (
      day TEXT PRIMARY KEY,
      identities INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS daily_activity_keys (
      day TEXT PRIMARY KEY,
      key TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS daily_activity_seen (
      day TEXT NOT NULL REFERENCES daily_activity_keys(day) ON DELETE CASCADE,
      identity_hash TEXT NOT NULL,
      PRIMARY KEY (day, identity_hash)
    );

    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint   TEXT PRIMARY KEY,
      address    TEXT NOT NULL,
      p256dh     TEXT NOT NULL,
      auth       TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_push_address ON push_subscriptions(address);
  `);

  // The slot/revision schema (#82–#90) collapses back to one row per endpoint;
  // live endpoints carry over so opted-in browsers keep receiving alerts.
  db.transaction(() => {
    if (!db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'push_slots'").get()) return;
    db.run(`INSERT OR IGNORE INTO push_subscriptions (endpoint, address, p256dh, auth, created_at)
      SELECT endpoint, address, p256dh, auth, created_at FROM push_slots
      WHERE state = 'active' AND endpoint IS NOT NULL AND p256dh IS NOT NULL AND auth IS NOT NULL`);
    db.run('DROP TABLE IF EXISTS push_work');
    db.run('DROP TABLE IF EXISTS push_revocations');
    db.run('DROP TABLE push_slots');
  }).immediate();

  const messageColumns = tableColumns('messages');
  const requiredMessageColumns = [
    'version', 'id', 'sender', 'recipient', 'ct_recipient', 'ephemeral_pub_recipient',
    'iv_recipient', 'ct_sender', 'ephemeral_pub_sender', 'iv_sender', 'ttl_seconds',
    'signature', 'created_at', 'expires_at',
  ];
  if (messageColumns.size > 0
    && requiredMessageColumns.some((column) => !messageColumns.has(column))) {
    // Protocol v1 cutover: legacy messages have no authenticated envelope and cannot be upgraded safely.
    db.run('DROP TABLE messages');
  }
  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      version                 INTEGER NOT NULL,
      id                      TEXT PRIMARY KEY,
      sender                  TEXT NOT NULL,
      recipient               TEXT NOT NULL,
      ct_recipient            TEXT NOT NULL,
      ephemeral_pub_recipient TEXT NOT NULL,
      iv_recipient            TEXT NOT NULL,
      ct_sender               TEXT NOT NULL,
      ephemeral_pub_sender    TEXT NOT NULL,
      iv_sender               TEXT NOT NULL,
      ttl_seconds             INTEGER NOT NULL,
      signature               TEXT NOT NULL,
      created_at              INTEGER NOT NULL,
      expires_at              INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_msg_conv
      ON messages(sender, recipient, created_at);
    CREATE INDEX IF NOT EXISTS idx_msg_recip
      ON messages(recipient, created_at);
    CREATE INDEX IF NOT EXISTS idx_msg_expires
      ON messages(expires_at);
  `);
  // Separate from the envelope cutover: adds the opening lifecycle columns.
  db.transaction(() => {
    const columns = tableColumns('messages');
    if (!columns.has('delivery_policy')) {
      db.run("ALTER TABLE messages ADD COLUMN delivery_policy TEXT NOT NULL DEFAULT 'legacy'");
    }
    if (!columns.has('opened_at')) db.run('ALTER TABLE messages ADD COLUMN opened_at INTEGER');
    db.run('DROP INDEX IF EXISTS idx_msg_opening_expires');
    // Legacy acceptance-based expiry is retired; such messages lived at most 24 hours.
    db.run("DELETE FROM messages WHERE delivery_policy = 'legacy'");
  }).immediate();
  db.transaction(() => {
    db.run(`CREATE TABLE IF NOT EXISTS message_recovery (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      high_water INTEGER NOT NULL,
      cursor_key TEXT NOT NULL
    )`);
    db.query('INSERT OR IGNORE INTO message_recovery VALUES (1, 0, ?)')
      .run(randomBytes(32).toString('hex'));
    if (!tableColumns('messages').has('acceptance_seq')) {
      db.run('ALTER TABLE messages ADD COLUMN acceptance_seq INTEGER');
      db.run(`WITH ordered AS (
        SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, rowid) AS seq FROM messages
      ) UPDATE messages SET acceptance_seq =
        (SELECT seq FROM ordered WHERE ordered.id = messages.id)`);
      db.run(`UPDATE message_recovery SET high_water =
        MAX(high_water, COALESCE((SELECT MAX(acceptance_seq) FROM messages), 0))`);
    }
    db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_acceptance ON messages(acceptance_seq);
      CREATE INDEX IF NOT EXISTS idx_msg_conv_acceptance ON messages(sender, recipient, acceptance_seq);
      CREATE TRIGGER IF NOT EXISTS message_acceptance AFTER INSERT ON messages BEGIN
        UPDATE message_recovery SET high_water = high_water + 1 WHERE singleton = 1;
        UPDATE messages SET acceptance_seq = (SELECT high_water FROM message_recovery WHERE singleton = 1)
          WHERE id = NEW.id;
      END`);
  }).immediate();
  // Cipher and canonicalization changes cannot be upgraded without plaintext.
  db.query('DELETE FROM messages WHERE version != ?').run(MESSAGE_ENVELOPE_VERSION);
  pruneDailyActivity();
}

/** Keep only today's deduplication material; historical totals contain no identities. */
export function pruneDailyActivity(day = new Date(Date.now()).toISOString().slice(0, 10)): void {
  db.query('DELETE FROM daily_activity_keys WHERE day < ?').run(day);
}

/** One count per authenticated identity/UTC day, across sessions and server restarts. */
export function recordDailyActivity(address: Address): void {
  db.transaction(() => {
    const day = new Date(Date.now()).toISOString().slice(0, 10);
    pruneDailyActivity(day);
    db.query('INSERT OR IGNORE INTO daily_activity_keys (day, key) VALUES (?, ?)')
      .run(day, randomBytes(32).toString('hex'));
    const { key } = db.query('SELECT key FROM daily_activity_keys WHERE day = ?')
      .get(day) as { key: string };
    const hash = createHmac('sha256', Buffer.from(key, 'hex')).update(address.toLowerCase()).digest('hex');
    const inserted = db.query('INSERT OR IGNORE INTO daily_activity_seen (day, identity_hash) VALUES (?, ?)')
      .run(day, hash);
    if (inserted.changes > 0) {
      db.query(`INSERT INTO daily_activity_totals (day, identities) VALUES (?, 1)
        ON CONFLICT(day) DO UPDATE SET identities = identities + 1`).run(day);
    }
  }).immediate();
}

export function registerPubkey(address: Address, pubkey: string): void {
  db.query(
    `INSERT INTO pubkeys (address, pubkey, last_active_at) VALUES (?, ?, ?)
     ON CONFLICT(address) DO UPDATE SET pubkey = excluded.pubkey`,
  ).run(address, pubkey, Date.now());
}

export function getPubkey(address: Address): string | null {
  const row = db
    .query('SELECT pubkey FROM pubkeys WHERE address = ?')
    .get(address) as { pubkey: string } | null;
  return row?.pubkey ?? null;
}

export function deleteInactivePubkeys(cutoff: number): number {
  return db.transaction(() => {
    db.query('DELETE FROM push_subscriptions WHERE address IN (SELECT address FROM pubkeys WHERE last_active_at < ?)').run(cutoff);
    return db.query('DELETE FROM pubkeys WHERE last_active_at < ?').run(cutoff).changes;
  }).immediate();
}

export function createSession(
  token: string,
  address: Address,
  expiresAt: number,
): void {
  const createdAt = Date.now();
  db.query(
    'INSERT INTO sessions (token, address, created_at, expires_at) VALUES (?, ?, ?, ?)',
  ).run(hashToken(token), address, createdAt, expiresAt);
  markAddressesActive([address], createdAt);
}

export interface SessionRow {
  address: Address;
  expires_at: number;
}

export function getSession(token: string): SessionRow | null {
  const hash = hashToken(token);
  const row = db
    .query(
      'SELECT address, expires_at FROM sessions WHERE token = ?',
    )
    .get(hash) as SessionRow | null;
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.query('DELETE FROM sessions WHERE token = ?').run(hash);
    return null;
  }
  return row;
}

export function deleteSession(token: string): void {
  db.query('DELETE FROM sessions WHERE token = ?').run(hashToken(token));
}

export function deleteExpiredSessions(): void {
  db.query('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}

export function createMessage(envelope: MessageEnvelope): MessageLifecycle | null {
  return db.transaction(() => {
    const createdAt = Date.now();
    const expiresAt = createdAt + UNOPENED_RETENTION_MS;
    const result = db.query(
      `INSERT OR IGNORE INTO messages (
        version, id, sender, recipient,
        ct_recipient, ephemeral_pub_recipient, iv_recipient,
        ct_sender, ephemeral_pub_sender, iv_sender,
        ttl_seconds, signature, created_at, expires_at, delivery_policy
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      envelope.version, envelope.id, envelope.sender, envelope.recipient,
      envelope.ct_recipient, envelope.ephemeral_pub_recipient, envelope.iv_recipient,
      envelope.ct_sender, envelope.ephemeral_pub_sender, envelope.iv_sender,
      envelope.ttl, envelope.signature, createdAt, expiresAt, 'recipient-opening',
    );
    // Bun includes the acceptance trigger's updates in changes; only zero means an ignored insert.
    if (result.changes === 0) return null;
    markAddressesActive([envelope.sender, envelope.recipient], createdAt);
    recordDailyActivity(envelope.sender);
    return { delivery_policy: 'recipient-opening' as const, created_at: createdAt, opened_at: null, expires_at: expiresAt };
  }).immediate();
}

export interface MessageRow extends MessageLifecycle {
  version: number;
  id: string;
  sender: Address;
  recipient: Address;
  ct_recipient: string;
  ephemeral_pub_recipient: string;
  iv_recipient: string;
  ct_sender: string;
  ephemeral_pub_sender: string;
  iv_sender: string;
  ttl_seconds: number;
  signature: string;
}

export interface ConversationPage {
  rows: Array<MessageRow & { acceptance_seq: number }>;
  next_before_seq: number | null;
}

// acceptance_seq is unique and only increases, so it is a total order that
// pages without skipping or repeating messages that share a created_at.
function readConversationMessages(
  addr1: Address,
  addr2: Address,
  limit = 50,
  beforeSeq?: number,
): ConversationPage {
  const rows = db
    .query(
      `SELECT * FROM messages
       WHERE expires_at > ?
         AND acceptance_seq < ?
         AND (
           (sender = ? AND recipient = ?)
           OR (sender = ? AND recipient = ?)
         )
       ORDER BY acceptance_seq DESC
       LIMIT ?`,
    )
    .all(Date.now(), beforeSeq ?? Number.MAX_SAFE_INTEGER, addr1, addr2, addr2, addr1, limit) as Array<MessageRow & { acceptance_seq: number }>;
  return { rows, next_before_seq: rows.at(-1)?.acceptance_seq ?? null };
}

// Capture the initial recovery checkpoint in the same SQLite snapshot as history.
export function getConversationMessages(
  addr1: Address, addr2: Address, limit = 50, beforeSeq?: number,
): ConversationPage & { recovery_sequence: number } {
  return db.transaction(() => ({
    recovery_sequence: recoveryMetadata().high_water,
    ...readConversationMessages(addr1, addr2, limit, beforeSeq),
  }))();
}

export function recoveryMetadata(): { high_water: number; cursor_key: string } {
  return db.query('SELECT high_water, cursor_key FROM message_recovery WHERE singleton = 1')
    .get() as { high_water: number; cursor_key: string };
}

export function recoverMessages(address: Address, counterparty: Address, lower: number, upper?: number) {
  return db.transaction(() => {
    const bound = upper ?? recoveryMetadata().high_water;
    const now = Date.now();
    const rows = db.query(`SELECT * FROM messages
      WHERE acceptance_seq > ? AND acceptance_seq <= ? AND expires_at > ?
      AND ((sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?))
      ORDER BY acceptance_seq LIMIT 101`)
      .all(lower, bound, now, address, counterparty, counterparty, address) as Array<MessageRow & { acceptance_seq: number }>;
    const exhausted = rows.length <= 100;
    return { rows: rows.slice(0, 100), upper: bound, exhausted, server_time: now };
  })();
}

export interface ConversationSummary {
  counterparty: Address;
  last_message_at: number;
}

export function getConversations(
  address: Address,
): ConversationSummary[] {
  const now = Date.now();
  return db
    .query(
      `SELECT
         CASE WHEN sender = ? THEN recipient ELSE sender END AS counterparty,
         MAX(created_at) AS last_message_at
       FROM messages
       WHERE expires_at > ?
         AND (sender = ? OR recipient = ?)
       GROUP BY counterparty
       ORDER BY last_message_at DESC`,
    )
    .all(address, now, address, address) as ConversationSummary[];
}

export function deleteExpiredMessages(): void {
  db.query('DELETE FROM messages WHERE expires_at <= ?').run(Date.now());
}

/**
 * Deletes every message between two identities accepted up to now, in both
 * directions. Clients drop what they hold through the returned time.
 */
export function clearConversation(address: Address, counterparty: Address): { cleared_at: number; deleted: number } {
  return db.transaction(() => {
    const now = Date.now();
    const { changes } = db.query(`DELETE FROM messages WHERE created_at <= ?
      AND ((sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?))`)
      .run(now, address, counterparty, counterparty, address);
    return { cleared_at: now, deleted: changes };
  }).immediate();
}

export function deleteAddressSessions(address: Address): void {
  db.query('DELETE FROM sessions WHERE address = ?').run(address);
}

export function deleteAddressConversations(address: Address): void {
  db.query('DELETE FROM messages WHERE sender = ? OR recipient = ?').run(address, address);
}

export function deleteAddress(address: Address): void {
  db.transaction(() => {
    deletePushSubscriptionsForAddress(address);
    db.query('DELETE FROM pubkeys WHERE address = ?').run(address);
  }).immediate();
}

export function deleteRegistration(address: Address): void {
  db.transaction(() => {
    deleteAddressSessions(address);
    deleteAddressConversations(address);
    deleteAddress(address);
  }).immediate();
}

function deletePushSubscriptionsForAddress(address: Address): void {
  db.query('DELETE FROM push_subscriptions WHERE address = ?').run(address);
}

export interface PushSubscriptionRow {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export const MAX_PUSH_SUBSCRIPTIONS = 5;

/**
 * An endpoint belongs to the identity that uploaded it last. Past the cap the
 * oldest subscriptions of that identity are dropped rather than refusing a new one.
 */
export function savePushSubscription(address: Address, subscription: PushSubscriptionRow): void {
  db.transaction(() => {
    db.query(`INSERT INTO push_subscriptions (endpoint, address, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET address = excluded.address, p256dh = excluded.p256dh,
        auth = excluded.auth, created_at = excluded.created_at`)
      .run(subscription.endpoint, address, subscription.p256dh, subscription.auth, Date.now());
    db.query(`DELETE FROM push_subscriptions WHERE address = ? AND endpoint NOT IN (
      SELECT endpoint FROM push_subscriptions WHERE address = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)`)
      .run(address, address, MAX_PUSH_SUBSCRIPTIONS);
  }).immediate();
}

export function deletePushSubscription(endpoint: string, address?: Address): void {
  if (address === undefined) db.query('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
  else db.query('DELETE FROM push_subscriptions WHERE endpoint = ? AND address = ?').run(endpoint, address);
}

export function getPushSubscriptionsForAddress(address: Address): PushSubscriptionRow[] {
  return db.query('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE address = ?')
    .all(address) as PushSubscriptionRow[];
}

export function getConversationPartners(address: Address): Address[] {
  const rows = db
    .query(
      `SELECT DISTINCT CASE WHEN sender = ? THEN recipient ELSE sender END AS partner
       FROM messages
       WHERE sender = ? OR recipient = ?`,
    )
    .all(address, address, address) as Array<{ partner: Address }>;
  return rows.map(r => r.partner);
}

export function getDb(): Database {
  return db;
}

/** The write lock covers the clock read, availability check and transition. */
export function openMessages(recipient: Address, sender: Address, ids: string[]): {
  server_time: number; results: OpeningResult[]; updates: ExpiryUpdate[];
} {
  return db.transaction(() => {
    const now = Date.now();
    const updates: ExpiryUpdate[] = [];
    const results = ids.map((id): OpeningResult => {
      const row = db.query(`SELECT * FROM messages
        WHERE id = ? AND recipient = ? AND sender = ? AND expires_at > ?`)
        .get(id, recipient, sender, now) as MessageRow | null;
      if (!row) return { id, status: 'unavailable' };
      if (row.opened_at === null) {
        row.opened_at = now;
        row.expires_at = now + row.ttl_seconds * 1000;
        db.query('UPDATE messages SET opened_at = ?, expires_at = ? WHERE id = ?')
          .run(row.opened_at, row.expires_at, id);
        updates.push({ id, sender, recipient, delivery_policy: row.delivery_policy,
          created_at: row.created_at, opened_at: row.opened_at, expires_at: row.expires_at });
      }
      return { id, status: 'available', delivery_policy: row.delivery_policy,
        created_at: row.created_at, opened_at: row.opened_at, expires_at: row.expires_at };
    });
    if (results.some(result => result.status === 'available')) recordDailyActivity(recipient);
    return { server_time: now, results, updates };
  }).immediate();
}

/** Read a consistent lifecycle snapshot without acknowledging opening. */
export function getMessageStates(address: Address, counterparty: Address, ids: string[]): {
  server_time: number; results: OpeningResult[];
} {
  return db.transaction(() => {
    const now = Date.now();
    const results = ids.map((id): OpeningResult => {
      const row = db.query(`SELECT delivery_policy, created_at, opened_at, expires_at FROM messages
        WHERE id = ? AND expires_at > ?
        AND ((sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?))`)
        .get(id, now, address, counterparty, counterparty, address) as MessageLifecycle | null;
      return row ? { id, status: 'available', ...row } : { id, status: 'unavailable' };
    });
    return { server_time: now, results };
  })();
}
