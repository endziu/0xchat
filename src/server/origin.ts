/**
 * Resolve the origin a request came from. Browsers send the `Origin` header
 * on POST; requests without one fall back to the request URL's origin.
 * A present but unparseable or non-http(s) Origin is rejected (null).
 */
export function requestOrigin(req: Request): string | null {
  const value = req.headers.get('Origin') ?? new URL(req.url).origin;
  try {
    const url = new URL(value);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.origin !== value) return null;
    return url.origin;
  } catch {
    return null;
  }
}
