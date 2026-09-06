import { describe, expect, test } from 'bun:test';
import { ChallengeStore } from './challenge.ts';

describe('ChallengeStore', () => {
  test('expires challenges and permits no replay', () => {
    let now = 1_000;
    const store = new ChallengeStore({ ttlMs: 100, now: () => now });
    const issued = store.issue('subject', 'https://app.example', (nonce) => `challenge:${nonce}`);

    expect(store.consume(issued.nonce, 'subject', 'https://app.example')).toBe(issued.challenge);
    expect(store.consume(issued.nonce, 'subject', 'https://app.example')).toBeNull();

    const expiring = store.issue('subject', 'https://app.example', (nonce) => `challenge:${nonce}`);
    now = 1_100;
    expect(store.consume(expiring.nonce, 'subject', 'https://app.example')).toBeNull();
  });

  test('never retains more than its hard limit', () => {
    const store = new ChallengeStore({ maxEntries: 2 });
    const first = store.issue('first', 'https://app.example', (nonce) => nonce);
    const second = store.issue('second', 'https://app.example', (nonce) => nonce);
    const third = store.issue('third', 'https://app.example', (nonce) => nonce);

    expect(store.consume(first.nonce, 'first', 'https://app.example')).toBeNull();
    expect(store.consume(second.nonce, 'second', 'https://app.example')).toBe(second.challenge);
    expect(store.consume(third.nonce, 'third', 'https://app.example')).toBe(third.challenge);
  });

  test('consumes challenges only for the exact issuing origin', () => {
    const store = new ChallengeStore();
    const issued = store.issue('subject', 'https://app.example', (nonce) => `challenge:${nonce}`);

    expect(store.consume(issued.nonce, 'subject', 'https://evil.example')).toBeNull();
    // A cross-origin attempt must not burn the pending challenge.
    expect(store.consume(issued.nonce, 'subject', 'https://app.example')).toBe(issued.challenge);
  });
});
