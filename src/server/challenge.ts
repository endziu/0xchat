import { randomBytes } from 'node:crypto';

interface ChallengeEntry {
  challenge: string;
  subject: string;
  expiresAt: number;
}

interface ChallengeStoreOptions {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

const DEFAULT_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 10_000;

export class ChallengeStore {
  private readonly entries = new Map<string, ChallengeEntry>();
  private readonly subjectToNonce = new Map<string, string>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: ChallengeStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_CHALLENGE_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.now = options.now ?? Date.now;
  }

  /** Issue one challenge per subject, evicting the oldest entry at the hard limit. */
  issue(subject: string, buildChallenge: (nonce: string) => string): { challenge: string; nonce: string } {
    const nonce = randomBytes(16).toString('hex');
    const challenge = buildChallenge(nonce);

    const oldNonce = this.subjectToNonce.get(subject);
    if (oldNonce) this.entries.delete(oldNonce);

    if (!oldNonce && this.entries.size >= this.maxEntries) {
      const oldestNonce = this.entries.keys().next().value as string | undefined;
      if (oldestNonce) {
        const oldest = this.entries.get(oldestNonce)!;
        this.entries.delete(oldestNonce);
        this.subjectToNonce.delete(oldest.subject);
      }
    }

    this.subjectToNonce.set(subject, nonce);
    this.entries.set(nonce, { challenge, subject, expiresAt: this.now() + this.ttlMs });

    return { challenge, nonce };
  }

  /** Consume once by nonce + exact subject. */
  consume(nonce: string, subject: string): string | null {
    const entry = this.entries.get(nonce);
    if (!entry || entry.expiresAt <= this.now()) {
      if (entry) this.subjectToNonce.delete(entry.subject);
      this.entries.delete(nonce);
      return null;
    }
    if (entry.subject !== subject) return null;

    this.entries.delete(nonce);
    this.subjectToNonce.delete(subject);
    return entry.challenge;
  }

  cleanup(): void {
    const now = this.now();
    for (const [nonce, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(nonce);
        this.subjectToNonce.delete(entry.subject);
      }
    }
  }
}
