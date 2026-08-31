import { describe, expect, test } from 'bun:test';
import {
  addClient,
  notify,
  removeClient,
} from './sse.ts';

function makeCtrl(): {
  ctrl: ReadableStreamDefaultController;
  chunks: Uint8Array[];
} {
  const chunks: Uint8Array[] = [];
  let ctrl!: ReadableStreamDefaultController;
  new ReadableStream({
    start(c) {
      ctrl = c;
    },
  });
  const original = ctrl.enqueue.bind(ctrl);
  ctrl.enqueue = (chunk: Uint8Array) => {
    chunks.push(chunk);
    original(chunk);
  };
  return { ctrl, chunks };
}

describe('SSE', () => {
  test('addClient and removeClient', () => {
    const { ctrl, chunks } = makeCtrl();
    const addr = `0xsse-${Date.now()}`;
    addClient(addr, ctrl);
    notify(addr, 'message', { id: 'test' });
    expect(chunks).toHaveLength(1);
    removeClient(addr, ctrl);
    notify(addr, 'message', { id: 'after-removal' });
    expect(chunks).toHaveLength(1);
  });

  test('notify sends data to clients', () => {
    const { ctrl, chunks } = makeCtrl();
    const addr = `0xsse2-${Date.now()}`;
    addClient(addr, ctrl);
    notify(addr, 'message', { id: 'test' });
    expect(chunks).toHaveLength(1);
    const text = new TextDecoder().decode(chunks[0]!);
    expect(text).toContain('event: message');
    expect(text).toContain('"id":"test"');
    removeClient(addr, ctrl);
  });

  test('notify to unknown address is a no-op', () => {
    notify('0xnobody', 'ping', {});
  });

});
