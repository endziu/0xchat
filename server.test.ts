import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';
import { Database } from 'bun:sqlite';

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

  // Seed test data directly via DB
  const db = new Database('chat.db');
  db.query(
    'INSERT OR REPLACE INTO pubkeys (address, pubkey) VALUES (?, ?)',
  ).run('0x' + 'a'.repeat(40), 'cc'.repeat(33));
  db.query(
    'INSERT OR REPLACE INTO pubkeys (address, pubkey) VALUES (?, ?)',
  ).run('0x' + 'b'.repeat(40), 'dd'.repeat(33));
  db.query(
    'INSERT OR REPLACE INTO sessions (token, address, created_at, expires_at) VALUES (?, ?, ?, ?)',
  ).run(
    'test-token-integration',
    '0x' + 'a'.repeat(40),
    Date.now(),
    Date.now() + 3600_000,
  );
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
    expect(data.pubkey).toBe('cc'.repeat(33));
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
    expect(data.challenge).toContain('ETH-Chat session request');
    expect(data.nonce).toBeTruthy();
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
});

describe('authenticated routes', () => {
  const sender = '0x' + 'a'.repeat(40);
  const recipient = '0x' + 'b'.repeat(40);
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

  test('POST /api/messages sends a message', async () => {
    const res = await fetch(baseUrl + '/api/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + token,
      },
      body: JSON.stringify({
        recipient,
        ct_recipient: 'aa'.repeat(32),
        ephemeral_pub_recipient: 'bb'.repeat(33),
        iv_recipient: 'cc'.repeat(12),
        ct_sender: 'dd'.repeat(32),
        ephemeral_pub_sender: 'ee'.repeat(33),
        iv_sender: 'ff'.repeat(12),
        ttl: 300,
      }),
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as {
      id: string; created_at: number; expires_at: number;
    };
    expect(data.id).toBeTruthy();
  });
});

describe('CSP headers', () => {
  test('HTML responses include CSP header', async () => {
    const res = await fetch(baseUrl + '/');
    const csp = res.headers.get('content-security-policy');
    expect(csp).toBeTruthy();
    expect(csp).toContain("script-src 'self'");
  });
});

describe('input validation', () => {
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
