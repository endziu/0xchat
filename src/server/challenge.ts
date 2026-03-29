import { randomBytes } from 'node:crypto';

interface ChallengeEntry {
  challenge: string;
  address: string;
  expiresAt: number;
}

const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export class ChallengeStore {
  private readonly entries = new Map<string, ChallengeEntry>();
  private readonly addressToNonce = new Map<string, string>();

  /**
   * Issue a new challenge for `address`.
   * `buildChallenge` receives the generated nonce and returns the challenge string.
   * Replaces any existing outstanding challenge for this address.
   */
  issue(address: string, buildChallenge: (nonce: string) => string): { challenge: string; nonce: string } {
    const nonce = randomBytes(16).toString('hex');
    const challenge = buildChallenge(nonce);

    const oldNonce = this.addressToNonce.get(address);
    if (oldNonce) this.entries.delete(oldNonce);

    this.addressToNonce.set(address, nonce);
    this.entries.set(nonce, { challenge, address, expiresAt: Date.now() + CHALLENGE_TTL_MS });

    return { challenge, nonce };
  }

  /**
   * Consume a challenge by nonce + address. Returns the challenge string on success,
   * or null if not found, expired, or address mismatch.
   */
  consume(nonce: string, address: string): string | null {
    const entry = this.entries.get(nonce);
    if (!entry || entry.expiresAt < Date.now()) {
      this.entries.delete(nonce);
      return null;
    }
    if (entry.address !== address) return null;

    this.entries.delete(nonce);
    this.addressToNonce.delete(address);
    return entry.challenge;
  }

  cleanup(): void {
    const now = Date.now();
    for (const [nonce, entry] of this.entries) {
      if (entry.expiresAt < now) {
        this.entries.delete(nonce);
        this.addressToNonce.delete(entry.address);
      }
    }
  }
}
