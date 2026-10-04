import { requireAddress, type Address } from '../shared/address'
import { describe, expect, spyOn, test } from 'bun:test';
import {
  addClient,
  publish,
  pushSuppressingConnectionCount,
  removeClient,
  updateClientAttention,
} from './sse.ts';
import type { LiveEvent } from '../shared/live-events.ts';

const partnerLeft = (address: Address): LiveEvent => ({ type: 'user:disconnected', data: { address } });

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
    const addr = requireAddress('0x0000000000000000000000000000000000000001');
    addClient(addr, ctrl);
    publish(addr, partnerLeft(requireAddress('0x7f3fa48ca885678134842fa7456f3ece53a97f84')));
    expect(chunks).toHaveLength(1);
    removeClient(addr, ctrl);
    publish(addr, partnerLeft(requireAddress('0x' + 'e'.repeat(40))));
    expect(chunks).toHaveLength(1);
  });

  test('publish sends the event to clients', () => {
    const { ctrl, chunks } = makeCtrl();
    const addr = requireAddress('0x0000000000000000000000000000000000000002');
    addClient(addr, ctrl);
    publish(addr, partnerLeft(requireAddress('0x7f3fa48ca885678134842fa7456f3ece53a97f84')));
    expect(chunks).toHaveLength(1);
    const text = new TextDecoder().decode(chunks[0]!);
    expect(text).toBe('event: user:disconnected\ndata: {"address":"0x7f3fa48ca885678134842fa7456f3ece53a97f84"}\n\n');
    removeClient(addr, ctrl);
  });

  test('publish to unknown address is a no-op', () => {
    publish(requireAddress('0x6382b3cc881412b77bfcaeed026001c00d9e3025'), partnerLeft(requireAddress('0x7f3fa48ca885678134842fa7456f3ece53a97f84')));
  });

  test('an attentive browser must renew push suppression while a terminal stream does not', () => {
    const clock = spyOn(Date, 'now').mockReturnValue(1_000);
    const address = requireAddress('0x' + 'f'.repeat(40));
    const browser = makeCtrl().ctrl;
    const terminal = makeCtrl().ctrl;
    try {
      addClient(address, browser, true, true);
      expect(pushSuppressingConnectionCount(address)).toBe(1);
      clock.mockReturnValue(47_000);
      expect(pushSuppressingConnectionCount(address)).toBe(0);
      expect(updateClientAttention(address, browser, true, 1)).toBe(true);
      expect(pushSuppressingConnectionCount(address)).toBe(1);
      addClient(address, terminal);
      clock.mockReturnValue(93_000);
      expect(pushSuppressingConnectionCount(address)).toBe(1);
    } finally {
      removeClient(address, browser);
      removeClient(address, terminal);
      clock.mockRestore();
    }
  });

});
