import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { MESSAGE_ENVELOPE_VERSION, type MessageEnvelope } from '../shared/message-envelope.ts';

// Session tokens are stored as sha256 hex digests so a copy of the database
// never yields a valid bearer token. Callers keep using the raw token; the
// digest is computed here, at the only place that writes or reads the column.
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

let db: Database;

export function initDb(path = 'chat.db'): void {
  db = new Database(path);
  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA foreign_keys = ON');
  const sessionColumns = db.query('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
  if (sessionColumns.length > 0
    && !sessionColumns.some((column) => column.name === 'version')) {
    // Legacy sessions stored the raw bearer token; the digest format cannot upgrade them.
    db.run('DROP TABLE sessions');
  }
  db.run(`
    CREATE TABLE IF NOT EXISTS pubkeys (
      address TEXT PRIMARY KEY,
      pubkey  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY, -- sha256 hex digest of the bearer token, never the raw token
      address    TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      version    INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_expires
      ON sessions(expires_at);

    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint   TEXT PRIMARY KEY,
      address    TEXT NOT NULL,
      p256dh     TEXT NOT NULL,
      auth       TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_push_address
      ON push_subscriptions(address);
  `);

  const messageColumns = db.query('PRAGMA table_info(messages)').all() as Array<{ name: string }>;
  const requiredMessageColumns = [
    'version', 'id', 'sender', 'recipient', 'ct_recipient', 'ephemeral_pub_recipient',
    'iv_recipient', 'ct_sender', 'ephemeral_pub_sender', 'iv_sender', 'ttl_seconds',
    'signature', 'created_at', 'expires_at',
  ];
  const existingMessageColumns = new Set(messageColumns.map((column) => column.name));
  if (messageColumns.length > 0
    && requiredMessageColumns.some((column) => !existingMessageColumns.has(column))) {
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
  // Cipher and canonicalization changes cannot be upgraded without plaintext.
  db.query('DELETE FROM messages WHERE version != ?').run(MESSAGE_ENVELOPE_VERSION);
}

export function registerPubkey(address: string, pubkey: string): void {
  const normalized = address.toLowerCase();
  db.query(
    'INSERT OR REPLACE INTO pubkeys (address, pubkey) VALUES (?, ?)',
  ).run(normalized, pubkey);
}

export function getPubkey(address: string): string | null {
  const normalized = address.toLowerCase();
  const row = db
    .query('SELECT pubkey FROM pubkeys WHERE address = ?')
    .get(normalized) as { pubkey: string } | null;
  return row?.pubkey ?? null;
}

export function createSession(
  token: string,
  address: string,
  expiresAt: number,
): void {
  db.query(
    'INSERT INTO sessions (token, address, created_at, expires_at) VALUES (?, ?, ?, ?)',
  ).run(hashToken(token), address, Date.now(), expiresAt);
}

export interface SessionRow {
  address: string;
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
  db.query('DELETE FROM sessions WHERE token = ?').run(token);
}

export function deleteExpiredSessions(): void {
  db.query('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}

export function createMessage(
  envelope: MessageEnvelope,
): { createdAt: number; expiresAt: number } | null {
  const createdAt = Date.now();
  const expiresAt = createdAt + envelope.ttl * 1000;
  const result = db.query(
    `INSERT OR IGNORE INTO messages (
      version, id, sender, recipient,
      ct_recipient, ephemeral_pub_recipient, iv_recipient,
      ct_sender, ephemeral_pub_sender, iv_sender,
      ttl_seconds, signature, created_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    envelope.version, envelope.id, envelope.sender, envelope.recipient,
    envelope.ct_recipient, envelope.ephemeral_pub_recipient, envelope.iv_recipient,
    envelope.ct_sender, envelope.ephemeral_pub_sender, envelope.iv_sender,
    envelope.ttl, envelope.signature, createdAt, expiresAt,
  );
  return result.changes === 1 ? { createdAt, expiresAt } : null;
}

export interface MessageRow {
  version: number;
  id: string;
  sender: string;
  recipient: string;
  ct_recipient: string;
  ephemeral_pub_recipient: string;
  iv_recipient: string;
  ct_sender: string;
  ephemeral_pub_sender: string;
  iv_sender: string;
  ttl_seconds: number;
  signature: string;
  created_at: number;
  expires_at: number;
}

export interface ConversationPage {
  rows: Array<MessageRow & { seq: number }>;
  next_before: number | null;
  next_before_rowid: number | null;
}

// Cursor is (created_at, rowid). created_at alone is ambiguous: the server
// stamps Date.now() per message, so a strict created_at cutoff would skip
// (or endlessly re-return) messages sharing a millisecond. rowid makes the
// cursor total and strictly advancing.
export function getConversationMessages(
  addr1: string,
  addr2: string,
  limit = 50,
  before?: number,
  beforeRowid?: number,
): ConversationPage {
  const now = Date.now();
  let cutoffSql = '1=1';
  const cutoffParams: number[] = [];
  if (before != null) {
    if (beforeRowid != null) {
      cutoffSql = '(created_at < ? OR (created_at = ? AND rowid < ?))';
      cutoffParams.push(before, before, beforeRowid);
    } else {
      cutoffSql = 'created_at < ?';
      cutoffParams.push(before);
    }
  }
  const rows = db
    .query(
      `SELECT *, rowid AS seq FROM messages
       WHERE expires_at > ?
         AND ${cutoffSql}
         AND (
           (sender = ? AND recipient = ?)
           OR (sender = ? AND recipient = ?)
         )
       ORDER BY created_at DESC, rowid DESC
       LIMIT ?`,
    )
    .all(now, ...cutoffParams, addr1, addr2, addr2, addr1, limit) as Array<MessageRow & { seq: number }>;
  const oldest = rows[rows.length - 1];
  return {
    rows,
    next_before: oldest ? oldest.created_at : null,
    next_before_rowid: oldest ? oldest.seq : null,
  };
}

export interface ConversationSummary {
  counterparty: string;
  last_message_at: number;
}

export function getConversations(
  address: string,
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
  db.query('DELETE FROM messages WHERE expires_at < ?').run(Date.now());
}

export function deleteAddressSessions(address: string): void {
  const normalized = address.toLowerCase();
  db.query('DELETE FROM sessions WHERE address = ?').run(normalized);
}

export function deleteAddressConversations(address: string): void {
  const normalized = address.toLowerCase();
  db.query('DELETE FROM messages WHERE sender = ? OR recipient = ?').run(normalized, normalized);
}

export function deleteAddress(address: string): void {
  const normalized = address.toLowerCase();
  db.query('DELETE FROM pubkeys WHERE address = ?').run(normalized);
}

export function upsertPushSubscription(
  address: string,
  endpoint: string,
  p256dh: string,
  auth: string,
): void {
  const normalized = address.toLowerCase();
  db.query(
    'INSERT OR REPLACE INTO push_subscriptions (endpoint, address, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(endpoint, normalized, p256dh, auth, Date.now());
}

export function deletePushSubscription(endpoint: string): void {
  db.query('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
}

export function deletePushSubscriptionForAddress(address: string, endpoint: string): void {
  const normalized = address.toLowerCase();
  db.query('DELETE FROM push_subscriptions WHERE endpoint = ? AND address = ?').run(endpoint, normalized);
}

export function deletePushSubscriptionsForAddress(address: string): void {
  const normalized = address.toLowerCase();
  db.query('DELETE FROM push_subscriptions WHERE address = ?').run(normalized);
}

export interface PushSubscriptionRow {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export function getPushSubscriptionsForAddress(address: string): PushSubscriptionRow[] {
  const normalized = address.toLowerCase();
  return db
    .query('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE address = ?')
    .all(normalized) as PushSubscriptionRow[];
}

export function getConversationPartners(address: string): string[] {
  const normalized = address.toLowerCase();
  const rows = db
    .query(
      `SELECT DISTINCT CASE WHEN sender = ? THEN recipient ELSE sender END AS partner
       FROM messages
       WHERE sender = ? OR recipient = ?`,
    )
    .all(normalized, normalized, normalized) as Array<{ partner: string }>;
  return rows.map(r => r.partner);
}

export function getDb(): Database {
  return db;
}
