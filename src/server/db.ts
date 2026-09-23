import { Database } from 'bun:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { pushEndpointDestination } from './push-endpoint.ts';
import { MESSAGE_ENVELOPE_VERSION, UNOPENED_RETENTION_MS, type DeliveryPolicy, type MessageLifecycle, type OpeningResult, type ExpiryUpdate, type MessageEnvelope } from '../shared/message-envelope.ts';

// Session tokens are stored as sha256 hex digests so a copy of the database
// never yields a valid bearer token. Callers keep using the raw token; the
// digest is computed here, at the only place that writes or reads the column.
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

let db: Database;

function tableColumns(table: 'pubkeys' | 'sessions' | 'messages' | 'push_work'): Set<string> {
  const columns = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(columns.map((column) => column.name));
}

function markAddressesActive(addresses: string[], at: number): void {
  const placeholders = addresses.map(() => '?').join(', ');
  db.query(`UPDATE pubkeys SET last_active_at = ? WHERE address IN (${placeholders})`)
    .run(at, ...addresses.map((address) => address.toLowerCase()));
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

    CREATE TABLE IF NOT EXISTS push_slots (
      slot_id TEXT PRIMARY KEY,
      address TEXT NOT NULL,
      installation_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'active',
      endpoint TEXT,
      p256dh TEXT,
      auth TEXT,
      legacy INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(address, installation_id)
    );
    CREATE INDEX IF NOT EXISTS idx_push_endpoint ON push_slots(endpoint);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_push_active_endpoint ON push_slots(endpoint) WHERE state = 'active';
    CREATE TABLE IF NOT EXISTS push_revocations (
      slot_id TEXT PRIMARY KEY,
      address TEXT NOT NULL,
      installation_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      UNIQUE(address, installation_id)
    );
    CREATE TABLE IF NOT EXISTS push_work (
      slot_id             TEXT PRIMARY KEY REFERENCES push_slots(slot_id) ON DELETE CASCADE,
      revision            INTEGER NOT NULL,
      generation          INTEGER NOT NULL,
      deadline            INTEGER NOT NULL,
      attempt_count       INTEGER NOT NULL,
      due_at              INTEGER NOT NULL,
      provider_not_before INTEGER,
      claim_token         TEXT,
      claim_until         INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_push_work_due ON push_work(due_at);
  `);

  const pushWorkColumns = tableColumns('push_work');
  if (!pushWorkColumns.has('claim_token')) db.run('ALTER TABLE push_work ADD COLUMN claim_token TEXT');
  if (!pushWorkColumns.has('claim_until')) db.run('ALTER TABLE push_work ADD COLUMN claim_until INTEGER');

  db.transaction(() => {
    if (db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'push_subscriptions'").get()) {
      // Older pruning removed registrations without their subscriptions. Do not
      // resurrect those reservations: there is no registered owner to retain.
      const rows = (db.query(`SELECT s.* FROM push_subscriptions s
        JOIN pubkeys p ON p.address = lower(s.address)`).all() as Array<{
        address: string; endpoint: string; p256dh: string; auth: string; created_at: number;
      }>).map(row => ({ ...row, endpoint: pushEndpointDestination(row.endpoint) }));
      const destinations = new Map<string, number>();
      for (const row of rows) destinations.set(row.endpoint, (destinations.get(row.endpoint) ?? 0) + 1);
      const insert = db.query(`INSERT INTO push_slots
        (slot_id, address, installation_id, revision, endpoint, p256dh, auth, legacy, state, created_at, updated_at)
        VALUES (?, ?, ?, 1, ?, ?, ?, 1, ?, ?, ?)`);
      for (const row of rows) {
        // Preserve every conflicting legacy slot without selecting a winner or
        // sending with ambiguous keys. All reservations must be removed before reuse.
        const state = destinations.get(row.endpoint)! > 1 ? 'repair_needed' : 'active';
        insert.run(crypto.randomUUID(), row.address.toLowerCase(), crypto.randomUUID(),
          row.endpoint, row.p256dh, row.auth, state, row.created_at, row.created_at);
      }
      db.run('DROP TABLE push_subscriptions');
    }
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
  // Separate from the envelope cutover: preserve every existing payload and deadline.
  db.transaction(() => {
    const columns = tableColumns('messages');
    if (!columns.has('delivery_policy')) {
      db.run("ALTER TABLE messages ADD COLUMN delivery_policy TEXT NOT NULL DEFAULT 'legacy'");
    }
    if (!columns.has('opened_at')) db.run('ALTER TABLE messages ADD COLUMN opened_at INTEGER');
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
      // Leave rowids untouched: deployed clients may still hold older-page cursors.
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
}

export function registerPubkey(address: string, pubkey: string): void {
  const normalized = address.toLowerCase();
  db.query(
    `INSERT INTO pubkeys (address, pubkey, last_active_at) VALUES (?, ?, ?)
     ON CONFLICT(address) DO UPDATE SET pubkey = excluded.pubkey`,
  ).run(normalized, pubkey, Date.now());
}

export function getPubkey(address: string): string | null {
  const normalized = address.toLowerCase();
  const row = db
    .query('SELECT pubkey FROM pubkeys WHERE address = ?')
    .get(normalized) as { pubkey: string } | null;
  return row?.pubkey ?? null;
}

export function deleteInactivePubkeys(cutoff: number): number {
  return db.transaction(() => {
    db.query('DELETE FROM push_slots WHERE address IN (SELECT address FROM pubkeys WHERE last_active_at < ?)').run(cutoff);
    db.query('DELETE FROM push_revocations WHERE address IN (SELECT address FROM pubkeys WHERE last_active_at < ?)').run(cutoff);
    return db.query('DELETE FROM pubkeys WHERE last_active_at < ?').run(cutoff).changes;
  }).immediate();
}

export function createSession(
  token: string,
  address: string,
  expiresAt: number,
): void {
  const normalized = address.toLowerCase();
  const createdAt = Date.now();
  db.query(
    'INSERT INTO sessions (token, address, created_at, expires_at) VALUES (?, ?, ?, ?)',
  ).run(hashToken(token), normalized, createdAt, expiresAt);
  markAddressesActive([normalized], createdAt);
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
  db.query('DELETE FROM sessions WHERE token = ?').run(hashToken(token));
}

export function deleteExpiredSessions(): void {
  db.query('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}

export function createMessage(
  envelope: MessageEnvelope,
  policy: DeliveryPolicy = 'legacy',
): MessageLifecycle | null {
  return db.transaction(() => {
    const createdAt = Date.now();
    const expiresAt = createdAt + (policy === 'legacy' ? envelope.ttl * 1000 : UNOPENED_RETENTION_MS);
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
      envelope.ttl, envelope.signature, createdAt, expiresAt, policy,
    );
    // Bun includes the acceptance trigger's updates in changes; only zero means an ignored insert.
    if (result.changes === 0) return null;
    markAddressesActive([envelope.sender, envelope.recipient], createdAt);
    // Until lifecycle activation reaches push delivery (#91), wake-ups retain
    // the signed legacy message lifetime even for dormant new-policy tests.
    const pushDeadline = createdAt + envelope.ttl * 1000;
    const slots = db.query("SELECT slot_id, revision FROM push_slots WHERE address = ? AND state = 'active'")
      .all(envelope.recipient.toLowerCase()) as Array<{ slot_id: string; revision: number }>;
    const enqueue = db.query(`INSERT INTO push_work
      (slot_id, revision, generation, deadline, attempt_count, due_at, provider_not_before)
      VALUES (?, ?, 1, ?, 0, ?, NULL)
      ON CONFLICT(slot_id) DO UPDATE SET
        revision = excluded.revision,
        generation = push_work.generation + 1,
        deadline = MAX(push_work.deadline, excluded.deadline)`);
    for (const slot of slots) enqueue.run(slot.slot_id, slot.revision, pushDeadline, createdAt);
    return { delivery_policy: policy, created_at: createdAt, opened_at: null, expires_at: expiresAt };
  }).immediate();
}

export interface MessageRow extends MessageLifecycle {
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
function readConversationMessages(
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

// Capture the initial recovery checkpoint in the same SQLite snapshot as history.
export function getConversationMessages(
  addr1: string, addr2: string, limit = 50, before?: number, beforeRowid?: number,
): ConversationPage & { recovery_sequence: number } {
  return db.transaction(() => ({
    recovery_sequence: recoveryMetadata().high_water,
    ...readConversationMessages(addr1, addr2, limit, before, beforeRowid),
  }))();
}

export function recoveryMetadata(): { high_water: number; cursor_key: string } {
  return db.query('SELECT high_water, cursor_key FROM message_recovery WHERE singleton = 1')
    .get() as { high_water: number; cursor_key: string };
}

export function recoverMessages(address: string, counterparty: string, lower: number, upper?: number) {
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
  db.query('DELETE FROM messages WHERE expires_at <= ?').run(Date.now());
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
  db.transaction(() => {
    deletePushSubscriptionsForAddress(normalized);
    db.query('DELETE FROM pubkeys WHERE address = ?').run(normalized);
  }).immediate();
}

export function deleteRegistration(address: string): void {
  db.transaction(() => {
    deleteAddressSessions(address);
    deleteAddressConversations(address);
    deleteAddress(address);
  }).immediate();
}

function deletePushSubscriptionsForAddress(address: string): void {
  const normalized = address.toLowerCase();
  db.query('DELETE FROM push_slots WHERE address = ?').run(normalized);
  db.query('DELETE FROM push_revocations WHERE address = ?').run(normalized);
}

export function markPushSubscriptionDead(slotId: string, revision: number): void {
  db.transaction(() => {
    const changed = db.query(`UPDATE push_slots SET state = 'repair_needed', endpoint = NULL, p256dh = NULL,
      auth = NULL, revision = revision + 1, updated_at = ? WHERE slot_id = ? AND revision = ?`)
      .run(Date.now(), slotId, revision).changes;
    if (changed > 0) db.query('DELETE FROM push_work WHERE slot_id = ? AND revision = ?').run(slotId, revision);
  }).immediate();
}

export interface PendingPushWork extends PushSubscriptionRow {
  address: string;
  generation: number;
  deadline: number;
  attempt_count: number;
  due_at: number;
  provider_not_before: number | null;
}

export function cleanupInvalidPushWork(now: number): void {
  db.query(`DELETE FROM push_work WHERE deadline <= ? OR NOT EXISTS (
    SELECT 1 FROM push_slots s
    WHERE s.slot_id = push_work.slot_id AND s.revision = push_work.revision AND s.state = 'active'
  )`).run(now);
}

export function getDuePushWork(now: number, limit: number): PendingPushWork[] {
  return db.query(`SELECT w.*, s.address, s.endpoint, s.p256dh, s.auth
    FROM push_work w JOIN push_slots s ON s.slot_id = w.slot_id AND s.revision = w.revision
    WHERE s.state = 'active' AND w.deadline > ? AND w.due_at <= ?
      AND (w.provider_not_before IS NULL OR w.provider_not_before <= ?)
      AND (w.claim_until IS NULL OR w.claim_until <= ?)
    ORDER BY w.due_at, w.slot_id LIMIT ?`).all(now, now, now, now, limit) as PendingPushWork[];
}

export function claimPushWork(
  work: Pick<PendingPushWork, 'slot_id' | 'revision' | 'generation'>,
  now: number,
  leaseMs: number,
): string | null {
  const claimToken = crypto.randomUUID();
  const changed = db.query(`UPDATE push_work
    SET attempt_count = attempt_count + 1, claim_token = ?, claim_until = ?
    WHERE slot_id = ? AND revision = ? AND generation = ?
      AND (claim_until IS NULL OR claim_until <= ?)`)
    .run(claimToken, now + leaseMs, work.slot_id, work.revision, work.generation, now).changes;
  return changed > 0 ? claimToken : null;
}

export function completePushWork(
  work: Pick<PendingPushWork, 'slot_id' | 'revision' | 'generation'>,
  claimToken: string,
): void {
  const removed = db.query(`DELETE FROM push_work
    WHERE slot_id = ? AND revision = ? AND generation = ? AND claim_token = ?`)
    .run(work.slot_id, work.revision, work.generation, claimToken).changes;
  // When nothing was removed, newer work coalesced into this claim while the
  // attempt ran. That attempt did not fail temporarily, so it must not inflate
  // the retained work's temporary backoff; its failure count restarts.
  if (removed === 0) {
    db.query(`UPDATE push_work SET attempt_count = 0
      WHERE slot_id = ? AND revision = ? AND claim_token = ?`)
      .run(work.slot_id, work.revision, claimToken);
  }
}

/**
 * Schedule a durable temporary retry after a failed attempt. Matched by claim
 * token, not generation, so a failure also applies its backoff to newer work
 * that coalesced into this slot while the attempt was in flight. A replaced or
 * removed slot (different revision or no row) leaves the failure unmatched and
 * never resurfaces its work.
 */
export function recordPushTemporaryFailure(
  work: Pick<PendingPushWork, 'slot_id' | 'revision'>,
  claimToken: string,
  dueAt: number,
  providerNotBefore: number | null,
): number {
  return db.query(`UPDATE push_work
    SET due_at = ?, provider_not_before = ?, claim_token = NULL, claim_until = NULL
    WHERE slot_id = ? AND revision = ? AND claim_token = ?`)
    .run(dueAt, providerNotBefore, work.slot_id, work.revision, claimToken).changes;
}

export function releasePushClaim(slotId: string, claimToken: string): void {
  db.query(`UPDATE push_work SET claim_token = NULL, claim_until = NULL
    WHERE slot_id = ? AND claim_token = ?`).run(slotId, claimToken);
}

export function transferPushWorkRevision(slotId: string, oldRevision: number, newRevision: number): void {
  db.query('UPDATE push_work SET revision = ?, generation = generation + 1 WHERE slot_id = ? AND revision = ?')
    .run(newRevision, slotId, oldRevision);
}

export interface PushSubscriptionRow {
  slot_id: string;
  revision: number;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export function getPushSubscriptionsForAddress(address: string): PushSubscriptionRow[] {
  const normalized = address.toLowerCase();
  return db
    .query("SELECT slot_id, revision, endpoint, p256dh, auth FROM push_slots WHERE address = ? AND state = 'active'")
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

/** The write lock covers the clock read, availability check and transition. */
export function openMessages(recipient: string, sender: string, ids: string[]): {
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
      if (row.delivery_policy === 'recipient-opening' && row.opened_at === null) {
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
    return { server_time: now, results, updates };
  }).immediate();
}

/** Read a consistent lifecycle snapshot without acknowledging opening. */
export function getMessageStates(address: string, counterparty: string, ids: string[]): {
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
