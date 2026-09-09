const clients = new Map<
  string,
  Map<ReadableStreamDefaultController, boolean>
>();

export function addClient(
  address: string,
  ctrl: ReadableStreamDefaultController,
  supportsOpening = false,
): void {
  let set = clients.get(address);
  if (!set) {
    set = new Map();
    clients.set(address, set);
  }
  set.set(ctrl, supportsOpening);
}

/** Number of live SSE streams currently registered for an address. */
export function connectionCount(
  address: string,
): number {
  return clients.get(address)?.size ?? 0;
}

export function removeClient(
  address: string,
  ctrl: ReadableStreamDefaultController,
): void {
  const set = clients.get(address);
  if (!set) return;
  set.delete(ctrl);
  if (set.size === 0) clients.delete(address);
}

export function notify(
  address: string,
  event: string,
  data: object,
): void {
  const set = clients.get(address);
  if (!set) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
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

/** Dormant rollout detection; admission and delivery remain unenforced. */
export function openingConnectionCount(address: string): number {
  return [...(clients.get(address)?.values() ?? [])].filter(Boolean).length;
}
