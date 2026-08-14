import { describe, expect, test } from 'bun:test';
import { ChallengeStore } from './challenge.ts';

describe('ChallengeStore', () => {
  test('expires challenges and permits no replay', () => {
    let now = 1_000;
    const store = new ChallengeStore({ ttlMs: 100, now: () => now });
    const issued = store.issue('subject', (nonce) => `challenge:${nonce}`);

    expect(store.consume(issued.nonce, 'subject')).toBe(issued.challenge);
    expect(store.consume(issued.nonce, 'subject')).toBeNull();

    const expiring = store.issue('subject', (nonce) => `challenge:${nonce}`);
    now = 1_100;
    expect(store.consume(expiring.nonce, 'subject')).toBeNull();
  });

  test('never retains more than its hard limit', () => {
    const store = new ChallengeStore({ maxEntries: 2 });
    const first = store.issue('first', (nonce) => nonce);
    const second = store.issue('second', (nonce) => nonce);
    const third = store.issue('third', (nonce) => nonce);

    expect(store.consume(first.nonce, 'first')).toBeNull();
    expect(store.consume(second.nonce, 'second')).toBe(second.challenge);
    expect(store.consume(third.nonce, 'third')).toBe(third.challenge);
  });
});
