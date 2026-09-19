// The ownership key must match the URL sent to the provider, not its spelling.
// Legacy rows may contain components the transport ignores; retain those rows
// but key and send their canonical destination. New input rejects such components.
export function pushEndpointDestination(endpoint: string): string {
  const url = new URL(endpoint);
  url.hash = '';
  url.username = '';
  url.password = '';
  // Remove default ports so :443 and no port match the same destination.
  if ((url.protocol === 'https:' && url.port === '443')
    || (url.protocol === 'https:' && !url.port)) {
    url.port = '';
  }
  return url.href;
}