import { Database } from 'bun:sqlite';

let db: Database;

export function initDb(path = 'chat.db'): void {
  db = new Database(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS pubkeys (
      address TEXT PRIMARY KEY,
      pubkey  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY,
      address    TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_expires
      ON sessions(expires_at);

    CREATE TABLE IF NOT EXISTS messages (
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
}

export function registerPubkey(address: string, pubkey: string): void {
  db.query(
    'INSERT OR REPLACE INTO pubkeys (address, pubkey) VALUES (?, ?)',
  ).run(address, pubkey);
}

export function getPubkey(address: string): string | null {
  const row = db
    .query('SELECT pubkey FROM pubkeys WHERE address = ?')
    .get(address) as { pubkey: string } | null;
  return row?.pubkey ?? null;
}

export function createSession(
  token: string,
  address: string,
  expiresAt: number,
): void {
  db.query(
    'INSERT INTO sessions (token, address, created_at, expires_at) VALUES (?, ?, ?, ?)',
  ).run(token, address, Date.now(), expiresAt);
}

export interface SessionRow {
  address: string;
  expires_at: number;
}

export function getSession(token: string): SessionRow | null {
  const row = db
    .query(
      'SELECT address, expires_at FROM sessions WHERE token = ?',
    )
    .get(token) as SessionRow | null;
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.query('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return row;
}

export function deleteExpiredSessions(): void {
  db.query('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}

export function createMessage(
  id: string,
  sender: string,
  recipient: string,
  ctRecipient: string,
  ephPubRecipient: string,
  ivRecipient: string,
  ctSender: string,
  ephPubSender: string,
  ivSender: string,
  ttlSeconds: number,
): void {
  const now = Date.now();
  const expiresAt = now + ttlSeconds * 1000;
  db.query(
    `INSERT INTO messages (
      id, sender, recipient,
      ct_recipient, ephemeral_pub_recipient, iv_recipient,
      ct_sender, ephemeral_pub_sender, iv_sender,
      ttl_seconds, created_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, sender, recipient,
    ctRecipient, ephPubRecipient, ivRecipient,
    ctSender, ephPubSender, ivSender,
    ttlSeconds, now, expiresAt,
  );
}

export interface MessageRow {
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
  created_at: number;
  expires_at: number;
}

export function getConversationMessages(
  addr1: string,
  addr2: string,
  limit = 50,
  before?: number,
): MessageRow[] {
  const now = Date.now();
  const cutoff = before ?? Number.MAX_SAFE_INTEGER;
  return db
    .query(
      `SELECT * FROM messages
       WHERE expires_at > ?
         AND created_at < ?
         AND (
           (sender = ? AND recipient = ?)
           OR (sender = ? AND recipient = ?)
         )
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(now, cutoff, addr1, addr2, addr2, addr1, limit) as MessageRow[];
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
  db.query('DELETE FROM sessions WHERE address = ?').run(address);
}

export function deleteAddressConversations(address: string): void {
  db.query('DELETE FROM messages WHERE sender = ? OR recipient = ?').run(address, address);
}

export function deleteAddress(address: string): void {
  db.query('DELETE FROM pubkeys WHERE address = ?').run(address);
}

export function getConversationPartners(address: string): string[] {
  const rows = db
    .query(
      `SELECT DISTINCT CASE WHEN sender = ? THEN recipient ELSE sender END AS partner
       FROM messages
       WHERE sender = ? OR recipient = ?`,
    )
    .all(address, address, address) as Array<{ partner: string }>;
  return rows.map(r => r.partner);
}

export function getDb(): Database {
  return db;
}
