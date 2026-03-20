/* global window, localStorage, fetch */

const TOKEN_KEY = 'eth-chat-token';
const EXPIRES_KEY = 'eth-chat-expires';

function getToken() {
  const token = localStorage.getItem(TOKEN_KEY);
  const expires = localStorage.getItem(EXPIRES_KEY);
  if (!token || !expires) return null;
  if (Date.now() >= Number(expires)) {
    clearToken();
    return null;
  }
  return token;
}

function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(EXPIRES_KEY);
}

async function authenticate(wallet, address) {
  const existing = getToken();
  if (existing) return existing;

  const challengeRes = await fetch('/api/auth/challenge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address }),
  });
  if (!challengeRes.ok) {
    const err = await challengeRes.json();
    throw new Error(err.error || 'Challenge request failed');
  }
  const { challenge, nonce } = await challengeRes.json();

  const signature = await wallet.signMessage(challenge, address);

  const sessionRes = await fetch('/api/auth/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nonce, signature, address }),
  });
  if (!sessionRes.ok) {
    const err = await sessionRes.json();
    throw new Error(err.error || 'Session creation failed');
  }
  const { token, expires_at } = await sessionRes.json();

  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(EXPIRES_KEY, String(expires_at));
  return token;
}

async function authedFetch(url, options) {
  const token = getToken();
  if (!token) throw new Error('Not authenticated');

  const headers = new Headers(options?.headers);
  headers.set('Authorization', 'Bearer ' + token);

  const res = await fetch(url, { ...options, headers });
  if (res.status === 401) {
    clearToken();
    throw new Error('Session expired');
  }
  return res;
}

if (typeof window !== 'undefined') {
  window.chatSession = {
    authenticate,
    authedFetch,
    getToken,
    clearToken,
  };
}
