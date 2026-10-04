import type { Address } from '../shared/address.ts';
import type { LiveEvent } from '../shared/live-events.ts';

const clients = new Map<
  Address,
  Map<ReadableStreamDefaultController, { suppressPush: boolean; tracksAttention: boolean; attentionAt: number; sequence: number }>
>();

const ATTENTION_TTL_MS = 45_000;

export function addClient(
  address: Address,
  ctrl: ReadableStreamDefaultController,
  suppressPush = true,
  tracksAttention = false,
): void {
  let set = clients.get(address);
  if (!set) {
    set = new Map();
    clients.set(address, set);
  }
  set.set(ctrl, { suppressPush, tracksAttention, attentionAt: Date.now(), sequence: 0 });
}

/** Only an attentive browser or a live terminal stream suppresses push. */
export function pushSuppressingConnectionCount(address: Address): number {
  const now = Date.now();
  return [...(clients.get(address)?.values() ?? [])].filter(client =>
    client.suppressPush && (!client.tracksAttention || now - client.attentionAt < ATTENTION_TTL_MS)
  ).length;
}

export function updateClientAttention(
  address: Address,
  ctrl: ReadableStreamDefaultController,
  attentive: boolean,
  sequence: number,
): boolean {
  const client = clients.get(address)?.get(ctrl);
  if (!client) return false;
  if (sequence <= client.sequence) return true;
  client.sequence = sequence;
  client.suppressPush = attentive;
  client.attentionAt = Date.now();
  return true;
}

/** Number of live SSE streams currently registered for an address. */
export function connectionCount(
  address: Address,
): number {
  return clients.get(address)?.size ?? 0;
}

export function removeClient(
  address: Address,
  ctrl: ReadableStreamDefaultController,
): void {
  const set = clients.get(address);
  if (!set) return;
  set.delete(ctrl);
  if (set.size === 0) clients.delete(address);
}

export function publish(address: Address, event: LiveEvent): void {
  const set = clients.get(address);
  if (!set) return;
  const payload = `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
  const encoded = new TextEncoder().encode(payload);
  for (const ctrl of set.keys()) {
    try {
      ctrl.enqueue(encoded);
    } catch {
      set.delete(ctrl);
    }
  }
  if (set.size === 0) clients.delete(address);
}
