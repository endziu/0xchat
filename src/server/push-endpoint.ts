// The ownership key must match the URL sent to the provider, not its spelling.
// Legacy rows may contain components the transport ignores; retain those rows
// but key and send their canonical destination. New input rejects such components.
export function pushEndpointDestination(endpoint: string): string {
  const url = new URL(endpoint);
  url.hash = '';
  url.username = '';
  url.password = '';
  // URL already normalizes host casing, dot segments, and default ports.
  return url.href;
}
