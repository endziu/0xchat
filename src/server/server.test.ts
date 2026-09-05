import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import * as secp from '@noble/secp256k1';
import { bytesToHex, hexToBytes } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { decrypt } from '../client/lib/crypto.ts';
import { createSignedMessageEnvelope } from '../client/lib/message-envelope.ts';
import {
  canonicalMessageAad,
  verifyDeliveredMessage,
  type MessageEnvelope,
} from '../shared/message-envelope.ts';

function registrationIdentity(byte: string) {
  const privateKey = `0x${byte.repeat(64)}` as `0x${string}`;
  return {
    privateKey,
    address: privateKeyToAccount(privateKey).address.toLowerCase(),
    pubkey: bytesToHex(secp.getPublicKey(hexToBytes(privateKey), true)),
  };
}

function registrationPayload(
  identity: ReturnType<typeof registrationIdentity>,
  signature: string,
  nonce: string,
) {
  return { address: identity.address, pubkey: identity.pubkey, signature, nonce };
}

async function issueRegistration(base: string, identity: ReturnType<typeof registrationIdentity>) {
  const response = await fetch(base + '/api/register/challenge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: identity.address, pubkey: identity.pubkey }),
  });
  return {
    response,
    data: (await response.json()) as { challenge: string; nonce: string; error?: string },
  };
}

const messageSender = registrationIdentity('7');
const messageRecipient = registrationIdentity('8');
const senderToken = 'message-sender-token';
const recipientToken = 'message-recipient-token';

async function authenticatedEnvelope(plaintext = 'authenticated hello', ttl = 300) {
  return createSignedMessageEnvelope(
    plaintext,
    ttl,
    {
      privateKey: messageSender.privateKey,
      publicKey: messageSender.pubkey,
      address: messageSender.address,
    },
    messageRecipient.address,
    messageRecipient.pubkey,
  );
}

const PORT = 9876 + Math.floor(Math.random() * 100);
let baseUrl: string;
let proc: import('bun').Subprocess;

beforeAll(async () => {
  baseUrl = `http://localhost:${PORT}`;
  proc = Bun.spawn(['bun', 'run', 'server.ts'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      WALLETCONNECT_PROJECT_ID: 'test-project-id',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  // Wait for server to be ready
  for (let i = 0; i < 30; i++) {
    try {
      await fetch(baseUrl + '/');
      break;
    } catch {
      await Bun.sleep(100);
    }
  }

  // Seed test data directly via DB. Session rows mirror the at-rest format:
  // the token column holds the sha256 hex digest of the raw bearer token.
  const db = new Database('chat.db');
  const seedSession = (token: string, address: string) =>
    db.query(
      'INSERT OR REPLACE INTO sessions (token, address, created_at, expires_at) VALUES (?, ?, ?, ?)',
    ).run(
      createHash('sha256').update(token).digest('hex'),
      address,
      Date.now(),
      Date.now() + 3600_000,
    );
  db.query(
    'INSERT OR REPLACE INTO pubkeys (address, pubkey) VALUES (?, ?)',
  ).run('0x' + 'a'.repeat(40), 'cc'.repeat(33));
  db.query(
    'INSERT OR REPLACE INTO pubkeys (address, pubkey) VALUES (?, ?)',
  ).run('0x' + 'b'.repeat(40), 'dd'.repeat(33));
  seedSession('test-token-integration', '0x' + 'a'.repeat(40));
  for (const identity of [messageSender, messageRecipient]) {
    db.query('INSERT OR REPLACE INTO pubkeys (address, pubkey) VALUES (?, ?)')
      .run(identity.address, identity.pubkey.slice(2));
  }
  for (const [token, address] of [
    [senderToken, messageSender.address],
    [recipientToken, messageRecipient.address],
  ]) {
    seedSession(token, address);
  }
  db.close();
});

afterAll(() => {
  proc?.kill();
});

describe('public routes', () => {
  test('GET / returns HTML', async () => {
    const res = await fetch(baseUrl + '/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  test('GET /chat returns HTML (SPA fallback)', async () => {
    const res = await fetch(baseUrl + '/chat');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  test('GET /chat/:address returns HTML (SPA fallback)', async () => {
    const addr = '0x' + 'a'.repeat(40);
    const res = await fetch(baseUrl + '/chat/' + addr);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  test('GET /api/pubkey returns null for unknown', async () => {
    const addr = '0x' + '0'.repeat(40);
    const res = await fetch(baseUrl + '/api/pubkey/' + addr);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { pubkey: string | null };
    expect(data.pubkey).toBe(null);
  });

  test('GET /api/pubkey returns pubkey for known', async () => {
    const addr = '0x' + 'a'.repeat(40);
    const res = await fetch(baseUrl + '/api/pubkey/' + addr);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { pubkey: string };
    expect(data.pubkey).toBe('0x' + 'cc'.repeat(33));
  });

  test('unknown API routes return 404 JSON', async () => {
    const res = await fetch(baseUrl + '/api/nonexistent');
    expect(res.status).toBe(404);
    const data = (await res.json()) as { error: string };
    expect(data.error).toBe('Not found');
  });
});

describe('auth routes', () => {
  test('POST /api/auth/challenge returns challenge + nonce', async () => {
    const addr = '0x' + '2'.repeat(40);
    const res = await fetch(baseUrl + '/api/auth/challenge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: addr }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      challenge: string; nonce: string;
    };
    expect(data.challenge).toContain('0xChat session request');
    expect(data.nonce).toBeTruthy();
  });

  test('POST /api/auth/challenge binds the request origin into the challenge', async () => {
    const addr = '0x' + '4'.repeat(40);
    const res = await fetch(baseUrl + '/api/auth/challenge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: addr }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { challenge: string; nonce: string };
    expect(data.challenge).toBe(
      `0xChat session request\nOrigin: ${baseUrl}\nAddress: ${addr}\nNonce: ${data.nonce}`,
    );
  });

  test('POST /api/auth/challenge honors an explicit Origin header', async () => {
    const addr = '0x' + '5'.repeat(40);
    const res = await fetch(baseUrl + '/api/auth/challenge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://chat.example' },
      body: JSON.stringify({ address: addr }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { challenge: string; nonce: string };
    expect(data.challenge).toContain('Origin: https://chat.example');
  });

  test('session signature covering a different origin is rejected', async () => {
    const identity = registrationIdentity('d');
    const challengeRes = await fetch(baseUrl + '/api/auth/challenge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: identity.address }),
    });
    const { challenge, nonce } = (await challengeRes.json()) as { challenge: string; nonce: string };
    const altered = challenge.replace(`Origin: ${baseUrl}`, 'Origin: https://evil.example');
    expect(altered).not.toBe(challenge);
    const signature = await privateKeyToAccount(identity.privateKey).signMessage({ message: altered });

    const res = await fetch(baseUrl + '/api/auth/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nonce, signature, address: identity.address }),
    });
    expect(res.status).toBe(401);
  });

  test('POST /api/auth/session rejects invalid nonce', async () => {
    const addr = '0x' + '3'.repeat(40);
    const res = await fetch(baseUrl + '/api/auth/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nonce: 'fake',
        signature: '0x' + 'a'.repeat(130),
        address: addr,
      }),
    });
    expect(res.status).toBe(401);
  });

  test('full login flow: returned token authenticates and stores only sha256', async () => {
    const identity = registrationIdentity('9');
    const challengeRes = await fetch(baseUrl + '/api/auth/challenge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: identity.address }),
    });
    expect(challengeRes.status).toBe(200);
    const { challenge, nonce } = (await challengeRes.json()) as { challenge: string; nonce: string };

    const signature = await privateKeyToAccount(identity.privateKey).signMessage({ message: challenge });
    const sessionRes = await fetch(baseUrl + '/api/auth/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nonce, signature, address: identity.address }),
    });
    expect(sessionRes.status).toBe(200);
    const { token } = (await sessionRes.json()) as { token: string };
    expect(token).toBeTruthy();

    // The raw token authenticates a protected route end to end.
    const res = await fetch(baseUrl + '/api/conversations', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);

    // At rest the database holds the sha256 digest, never the raw token.
    const db = new Database('chat.db');
    const stored = (db.query('SELECT token FROM sessions').all() as Array<{ token: string }>)
      .map((row) => row.token);
    db.close();
    expect(stored).not.toContain(token);
    expect(stored).toContain(createHash('sha256').update(token).digest('hex'));
  });
});

describe('registration routes', () => {
  test('registers an address-bound key with a canonical challenge', async () => {
    const identity = registrationIdentity('1');
    const { response, data } = await issueRegistration(baseUrl, identity);

    expect(response.status).toBe(200);
    expect(data.challenge).toBe(
      `0xChat key registration v1\nOrigin: ${baseUrl}\nAddress: ${identity.address}\nPublic key: ${identity.pubkey}\nNonce: ${data.nonce}`,
    );

    const signature = await privateKeyToAccount(identity.privateKey).signMessage({ message: data.challenge });
    const registered = await fetch(baseUrl + '/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(registrationPayload(identity, signature, data.nonce)),
    });
    expect(registered.status).toBe(200);

    const fetched = await fetch(baseUrl + `/api/pubkey/${identity.address}`);
    expect(await fetched.json()).toEqual({ pubkey: identity.pubkey });

    const second = await issueRegistration(baseUrl, identity);
    const secondSignature = await privateKeyToAccount(identity.privateKey).signMessage({
      message: second.data.challenge,
    });
    const reregistered = await fetch(baseUrl + '/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(registrationPayload(identity, secondSignature, second.data.nonce)),
    });
    expect(reregistered.status).toBe(200);
  });

  test('rejects malformed, off-curve, and address-mismatched keys at challenge issuance', async () => {
    const identity = registrationIdentity('2');
    for (const pubkey of ['0x1234', `0x02${'00'.repeat(32)}`, registrationIdentity('3').pubkey]) {
      const challengeResponse = await fetch(baseUrl + '/api/register/challenge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: identity.address, pubkey }),
      });
      expect(challengeResponse.status).toBe(400);
    }
  });

  test('consumes challenges only for the exact address and key', async () => {
    const first = registrationIdentity('4');
    const other = registrationIdentity('5');
    const { data } = await issueRegistration(baseUrl, first);
    const otherSignature = await privateKeyToAccount(other.privateKey).signMessage({ message: data.challenge });

    const mismatch = await fetch(baseUrl + '/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(registrationPayload(other, otherSignature, data.nonce)),
    });
    expect(mismatch.status).toBe(401);

    const signature = await privateKeyToAccount(first.privateKey).signMessage({ message: data.challenge });
    const exact = await fetch(baseUrl + '/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(registrationPayload(first, signature, data.nonce)),
    });
    expect(exact.status).toBe(200);
  });

  test('rejects altered challenge fields and challenge replay', async () => {
    const identity = registrationIdentity('6');
    const { data } = await issueRegistration(baseUrl, identity);
    const altered = data.challenge.replace('0xChat key registration v1', '0xChat key registration v2');
    const alteredSignature = await privateKeyToAccount(identity.privateKey).signMessage({ message: altered });

    const rejected = await fetch(baseUrl + '/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(registrationPayload(identity, alteredSignature, data.nonce)),
    });
    expect(rejected.status).toBe(401);

    const replay = await fetch(baseUrl + '/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(registrationPayload(identity, alteredSignature, data.nonce)),
    });
    expect(replay.status).toBe(401);
  });
});

describe('authenticated routes', () => {
  const token = 'test-token-integration';

  test('GET /api/conversations with auth returns list', async () => {
    const res = await fetch(baseUrl + '/api/conversations', {
      headers: { Authorization: 'Bearer ' + token },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      conversations: unknown[];
    };
    expect(Array.isArray(data.conversations)).toBe(true);
  });

  test('persists, fetches, streams, verifies, and decrypts both copies', async () => {
    const sseTokenResponse = await fetch(baseUrl + '/api/events/token', {
      method: 'POST',
      headers: { Authorization: `Bearer ${recipientToken}` },
    });
    const { sse_token: sseToken } = await sseTokenResponse.json() as { sse_token: string };
    const sseAbort = new AbortController();
    const sseResponsePromise = fetch(`${baseUrl}/api/events?token=${sseToken}`, { signal: sseAbort.signal });

    const envelope = await authenticatedEnvelope();
    const sent = await fetch(baseUrl + '/api/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${senderToken}`,
      },
      body: JSON.stringify(envelope),
    });
    expect(sent.status).toBe(201);
    const delivered = await verifyDeliveredMessage(await sent.json());
    expect(delivered).not.toBeNull();

    const fetchedForRecipient = await fetch(`${baseUrl}/api/messages/${messageSender.address}`, {
      headers: { Authorization: `Bearer ${recipientToken}` },
    });
    const recipientMessages = await fetchedForRecipient.json() as { messages: unknown[] };
    const recipientCopy = await verifyDeliveredMessage(recipientMessages.messages[0]);
    expect(recipientCopy).not.toBeNull();

    const fetchedForSender = await fetch(`${baseUrl}/api/messages/${messageRecipient.address}`, {
      headers: { Authorization: `Bearer ${senderToken}` },
    });
    const senderMessages = await fetchedForSender.json() as { messages: unknown[] };
    const senderCopy = await verifyDeliveredMessage(senderMessages.messages[0]);
    expect(senderCopy).not.toBeNull();

    expect(await decrypt(
      recipientCopy!.ct_recipient,
      recipientCopy!.ephemeral_pub_recipient,
      recipientCopy!.iv_recipient,
      messageRecipient.privateKey,
      canonicalMessageAad(recipientCopy!),
    )).toBe('authenticated hello');
    expect(await decrypt(
      senderCopy!.ct_sender,
      senderCopy!.ephemeral_pub_sender,
      senderCopy!.iv_sender,
      messageSender.privateKey,
      canonicalMessageAad(senderCopy!),
    )).toBe('authenticated hello');

    const sseResponse = await sseResponsePromise;
    const reader = sseResponse.body!.getReader();
    const decoder = new TextDecoder();
    let sseText = '';
    for (let i = 0; i < 3 && !sseText.includes('event: message'); i++) {
      sseText += decoder.decode((await reader.read()).value);
    }
    sseAbort.abort();
    const eventData = sseText.match(/event: message\ndata: (.+)\n/)?.[1];
    expect(eventData).toBeTruthy();
    expect(await verifyDeliveredMessage(JSON.parse(eventData!))).not.toBeNull();
  });

  test('rejects forged sender/recipient/signature, legacy version, and replay', async () => {
    const original = await authenticatedEnvelope('mutation test');
    const otherIdentity = registrationIdentity('9');
    const mutations: Array<Partial<MessageEnvelope>> = [
      { sender: messageRecipient.address },
      { recipient: otherIdentity.address },
      { signature: `0x${'00'.repeat(65)}` },
    ];
    for (const mutation of mutations) {
      const response = await fetch(baseUrl + '/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${senderToken}` },
        body: JSON.stringify({ ...original, ...mutation }),
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
    }

    const wrongSignerEnvelope = await createSignedMessageEnvelope(
      'wrong signer',
      300,
      { privateKey: otherIdentity.privateKey, publicKey: otherIdentity.pubkey, address: otherIdentity.address },
      messageRecipient.address,
      messageRecipient.pubkey,
    );
    const wrongSigner = await fetch(baseUrl + '/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${senderToken}` },
      body: JSON.stringify({ ...wrongSignerEnvelope, sender: messageSender.address }),
    });
    expect(wrongSigner.status).toBe(400);

    const legacy = await fetch(baseUrl + '/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${senderToken}` },
      body: JSON.stringify({ ...original, version: 1 }),
    });
    expect(legacy.status).toBe(400);

    const accepted = await fetch(baseUrl + '/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${senderToken}` },
      body: JSON.stringify(original),
    });
    expect(accepted.status).toBe(201);
    const replay = await fetch(baseUrl + '/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${senderToken}` },
      body: JSON.stringify(original),
    });
    expect(replay.status).toBe(409);
  });
});

describe('rate limiting', () => {
  test('sustained fast chat never 429s (30-message burst)', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 30; i++) {
      const envelope = await authenticatedEnvelope(`burst ${i}`);
      const res = await fetch(baseUrl + '/api/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${senderToken}`,
        },
        body: JSON.stringify(envelope),
      });
      statuses.push(res.status);
    }
    expect(statuses.filter((s) => s === 429)).toEqual([]);
    expect(statuses.every((s) => s === 201)).toBe(true);
  });
});

describe('CSP headers', () => {
  test('HTML responses include CSP header', async () => {
    const res = await fetch(baseUrl + '/');
    const csp = res.headers.get('content-security-policy');
    expect(csp).toBeTruthy();
    expect(csp).toContain("script-src 'self'");
  });

  test('CSP allows no external font hosts', async () => {
    const res = await fetch(baseUrl + '/');
    const csp = res.headers.get('content-security-policy')!;
    expect(csp).not.toContain('fonts.googleapis.com');
    expect(csp).not.toContain('fonts.gstatic.com');
  });

  test('CSP restricts form-action to same-origin', async () => {
    const res = await fetch(baseUrl + '/');
    const csp = res.headers.get('content-security-policy')!;
    expect(csp).toContain("form-action 'self'");
  });

  test('responses include a Permissions-Policy header that denies unused features', async () => {
    const res = await fetch(baseUrl + '/');
    const policy = res.headers.get('permissions-policy');
    expect(policy).toBeTruthy();
    expect(policy).toContain('geolocation=()');
    expect(policy).toContain('microphone=()');
    expect(policy).toContain('payment=()');
    // The camera is used for QR scanning, so it must stay allowed.
    expect(policy).toContain('camera=(self)');
  });
});

describe('input validation', () => {
  test('GET /api/messages rejects non-positive or non-integer limit with 400', async () => {
    const addr = '0x' + 'a'.repeat(40);
    for (const limit of ['abc', '0', '-5', '1.5']) {
      const res = await fetch(`${baseUrl}/api/messages/${addr}?limit=${limit}`, {
        headers: { Authorization: 'Bearer test-token-integration' },
      });
      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: string };
      expect(data.error).toContain('limit');
    }
  });

  test('POST /api/register rejects invalid JSON', async () => {
    const res = await fetch(baseUrl + '/api/register', {
      method: 'POST',
      body: 'not json',
    });
    expect(res.status).toBe(400);
  });

  test('POST /api/register rejects invalid address', async () => {
    const res = await fetch(baseUrl + '/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        address: 'invalid',
        pubkey: 'aa'.repeat(33),
        signature: '0x' + 'ab'.repeat(65),
      }),
    });
    expect(res.status).toBe(400);
  });
});

describe('trusted-proxy X-Forwarded-For rate limiting', () => {
  // Disjoint from the existing server test's 9876-9975 range and from each other.
  const trustedPort = 10051 + Math.floor(Math.random() * 50);
  const untrustedPort = 10101 + Math.floor(Math.random() * 50);
  let trustedProc: import('bun').Subprocess;
  let untrustedProc: import('bun').Subprocess;

  async function waitReady(port: number) {
    for (let i = 0; i < 30; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/`)).status === 200) return;
      } catch {
        // server not up yet
      }
      await Bun.sleep(100);
    }
    throw new Error(`server on port ${port} did not become ready`);
  }

  function spawnServer(port: number, extraEnv: Record<string, string>) {
    return Bun.spawn(['bun', 'run', 'server.ts'], {
      env: { ...process.env, PORT: String(port), ...extraEnv },
      stdout: 'pipe',
      stderr: 'pipe',
    });
  }

  beforeAll(async () => {
    trustedProc = spawnServer(trustedPort, { TRUSTED_PROXY_IPS: '127.0.0.1, ::1' });
    untrustedProc = spawnServer(untrustedPort, { TRUSTED_PROXY_IPS: '' });
    await waitReady(trustedPort);
    await waitReady(untrustedPort);
  });

  afterAll(() => {
    trustedProc?.kill();
    untrustedProc?.kill();
  });

  // Invalid-address payload: 400 when allowed through, 429 when rate limited.
  async function authChallenge(port: number, forwardedFor: string | null): Promise<number> {
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/challenge`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(forwardedFor ? { 'X-Forwarded-For': forwardedFor } : {}),
      },
      body: JSON.stringify({}),
    });
    return res.status;
  }

  test('with TRUSTED_PROXY_IPS set, each X-Forwarded-For client gets its own bucket', async () => {
    for (let i = 0; i < 10; i++) {
      expect(await authChallenge(trustedPort, '203.0.113.7')).toBe(400);
    }
    expect(await authChallenge(trustedPort, '203.0.113.7')).toBe(429);
    // A different XFF client is unaffected by the first client's 429.
    expect(await authChallenge(trustedPort, '203.0.113.8')).toBe(400);
  });

  test('without TRUSTED_PROXY_IPS, spoofed X-Forwarded-For shares the proxy bucket', async () => {
    for (let i = 0; i < 10; i++) {
      expect(await authChallenge(untrustedPort, '203.0.113.7')).toBe(400);
    }
    expect(await authChallenge(untrustedPort, '203.0.113.7')).toBe(429);
    // Spoofed XFF must not open a fresh bucket: still limited on the peer IP.
    expect(await authChallenge(untrustedPort, '203.0.113.8')).toBe(429);
  });
});
