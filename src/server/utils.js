/* global window */

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes) {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function walletErrorMessage(e) {
  const msg = e?.message ?? String(e);
  if (/disconnected/i.test(msg)) return 'Wallet disconnected — please reconnect.';
  if (/not initialized/i.test(msg)) return 'Wallet not ready — please connect first.';
  if (/does not match/i.test(msg)) return 'Wallet account changed — please reload.';
  return 'Signature rejected.';
}

if (typeof window !== 'undefined') {
  window.hexToBytes = hexToBytes;
  window.bytesToHex = bytesToHex;
  window.walletErrorMessage = walletErrorMessage;
}
