import { getDb, getPubkey, transferPushWorkRevision } from './db.ts';
import { pushEndpointDestination } from './push-endpoint.ts';
import type { PushEnableRequest, PushSlotCondition, PushSlotHandle, PushSlotList } from '../shared/push-slot.ts';
import type { ApiErrorCode } from '../shared/api-error.ts';

export class PushSlotError extends Error {
  constructor(readonly code: ApiErrorCode, message: string) { super(message); }
}

interface Slot extends PushSlotHandle {
  address: string;
  endpoint: string | null;
  p256dh: string | null;
  auth: string | null;
  legacy: number;
  state: string;
}

function toHandle(row: PushSlotHandle): PushSlotHandle {
  return { slot_id: row.slot_id, installation_id: row.installation_id, revision: row.revision };
}
function fail(code: ApiErrorCode, message: string): never { throw new PushSlotError(code, message); }

export function listPushSlots(address: string): PushSlotList {
  const db = getDb();
  address = address.toLowerCase();
  return db.transaction(() => ({
    slots: db.query(`SELECT slot_id, installation_id, revision, 'Browser' AS label, state, created_at, updated_at
      FROM push_slots WHERE address = ? ORDER BY created_at, slot_id`).all(address),
    revocations: db.query('SELECT slot_id, installation_id, revision FROM push_revocations WHERE address = ?').all(address),
  }))() as PushSlotList;
}

export function enablePushSlot(address: string, input: PushEnableRequest, reconcile = false): PushSlotHandle {
  const db = getDb();
  address = address.toLowerCase();
  return db.transaction(() => {
    if (!getPubkey(address)) fail('registration_required', 'Register this identity again before enabling notifications.');
    const canonical = pushEndpointDestination(input.subscription.endpoint);
    const { keys } = input.subscription;
    // Migration can retain several quarantined reservations for one destination.
    // Check every owner, not an arbitrary first row, before allowing any mutation.
    const endpointOwners = db.query('SELECT * FROM push_slots WHERE endpoint = ?').all(canonical) as Slot[];
    const endpointOwner = endpointOwners[0];
    if (endpointOwners.some(owner => owner.address !== address)) {
      fail('ownership_conflict', 'Remove this browser subscription from its previous identity before enabling it here.');
    }
    const byInstallation = db.query('SELECT * FROM push_slots WHERE address = ? AND installation_id = ?')
      .get(address, input.installation_id) as Slot | null;
    const revoked = db.query('SELECT * FROM push_revocations WHERE address = ? AND installation_id = ?')
      .get(address, input.installation_id) as PushSlotHandle | null;
    if (revoked) {
      if (reconcile || !input.slot_id) fail('revoked', 'Notifications were removed. Explicitly enable them again.');
      if (input.slot_id !== revoked.slot_id || input.expected_revision !== revoked.revision) {
        fail('revision_conflict', 'Notification state changed. Refresh before trying again.');
      }
    }
    let slot = byInstallation;
    if (!slot && !revoked && !input.slot_id && input.expected_revision === 0 && !reconcile && endpointOwner?.legacy) {
      // Only the authenticated legacy owner with the same destination can claim it.
      if (endpointOwner.state !== 'active') {
        fail('repair_needed', 'Conflicting legacy subscriptions need removal before enabling notifications again.');
      }
      slot = endpointOwner;
      const revision = slot.revision + 1;
      db.query(`UPDATE push_slots SET installation_id = ?, p256dh = ?, auth = ?, legacy = 0,
        revision = ?, updated_at = ? WHERE slot_id = ?`)
        .run(input.installation_id, keys.p256dh, keys.auth, revision, Date.now(), slot.slot_id);
      transferPushWorkRevision(slot.slot_id, slot.revision, revision);
      return { slot_id: slot.slot_id, installation_id: input.installation_id, revision };
    }
    if (slot) {
      if (input.slot_id !== slot.slot_id || input.expected_revision !== slot.revision) {
        fail('revision_conflict', 'Notification state changed. Refresh before trying again.');
      }
      if (slot.legacy && slot.state === 'repair_needed' && slot.endpoint !== null) {
        fail('repair_needed', 'Conflicting legacy subscriptions need removal before enabling notifications again.');
      }
      const replacingEndpoint = reconcile && slot.endpoint !== canonical;
      if (!replacingEndpoint && (slot.legacy || slot.state !== 'active' || slot.endpoint !== canonical || slot.p256dh !== keys.p256dh || slot.auth !== keys.auth)) {
        fail('repair_needed', 'This subscription needs repair. Remove it and explicitly enable notifications again.');
      }
      if (replacingEndpoint && endpointOwners.some(owner => owner.slot_id !== slot.slot_id)) {
        fail('ownership_conflict', 'This endpoint already belongs to another browser slot. Remove that binding first.');
      }
      if (replacingEndpoint) {
        const revision = slot.revision + 1;
        db.query(`UPDATE push_slots SET endpoint = ?, p256dh = ?, auth = ?, legacy = 0, state = 'active',
          revision = ?, updated_at = ? WHERE slot_id = ? AND revision = ?`)
          .run(canonical, keys.p256dh, keys.auth, revision, Date.now(), slot.slot_id, slot.revision);
        transferPushWorkRevision(slot.slot_id, slot.revision, revision);
        return { ...toHandle(slot), revision };
      }
      return toHandle(slot);
    }
    if (reconcile || (input.slot_id && !revoked)) fail('repair_needed', 'Ownership is unknown. Explicitly enable notifications again.');
    if (!revoked && input.expected_revision !== 0) fail('revision_conflict', 'Refresh notification state before enabling.');
    if (endpointOwner) fail('ownership_conflict', 'This endpoint already belongs to another browser slot. Remove that binding first.');
    const count = db.query('SELECT COUNT(*) AS count FROM push_slots WHERE address = ?').get(address) as { count: number };
    if (count.count >= 5) fail('slot_cap', 'Five notification slots are in use. Remove an old subscription before adding one.');
    const now = Date.now();
    const result = { slot_id: revoked?.slot_id ?? crypto.randomUUID(), installation_id: input.installation_id,
      revision: revoked ? revoked.revision + 1 : 1 };
    db.query(`INSERT INTO push_slots (slot_id, address, installation_id, revision, endpoint, p256dh, auth, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(result.slot_id, address, result.installation_id, result.revision, canonical, keys.p256dh, keys.auth, now, now);
    if (revoked) db.query('DELETE FROM push_revocations WHERE slot_id = ?').run(revoked.slot_id);
    return result;
  }).immediate();
}

export function removePushSlot(address: string, input: PushSlotCondition): PushSlotHandle {
  const db = getDb();
  address = address.toLowerCase();
  return db.transaction(() => {
    const slot = db.query('SELECT * FROM push_slots WHERE address = ? AND slot_id = ? AND installation_id = ?')
      .get(address, input.slot_id!, input.installation_id) as Slot | null;
    if (!slot) {
      const revoked = db.query('SELECT * FROM push_revocations WHERE address = ? AND slot_id = ? AND installation_id = ?')
        .get(address, input.slot_id!, input.installation_id) as PushSlotHandle | null;
      if (revoked && (input.expected_revision === revoked.revision || input.expected_revision + 1 === revoked.revision)) return toHandle(revoked);
      fail('repair_needed', 'Subscription ownership is unknown. Refresh notification state.');
    }
    if (input.expected_revision !== slot.revision) fail('revision_conflict', 'Notification state changed. Refresh before removing it.');
    const result = { ...toHandle(slot), revision: slot.revision + 1 };
    db.query('INSERT INTO push_revocations (slot_id, address, installation_id, revision) VALUES (?, ?, ?, ?)')
      .run(result.slot_id, address, result.installation_id, result.revision);
    db.query('DELETE FROM push_slots WHERE slot_id = ?').run(slot.slot_id);
    return result;
  }).immediate();
}
