import { join } from 'node:path';
import { json } from '../http.ts';
import { SECURITY_HEADERS, distDir } from '../constants.ts';
import type { Context } from '../http.ts';

/**
 * Vite content-hashes everything under /assets/, so those are immutable. The
 * service worker, the manifest and the HTML shell must always be revalidated —
 * a stale sw.js would pin an old build indefinitely.
 */
function cacheControl(path: string): string {
  if (path.startsWith('/assets/')) return 'public, max-age=31536000, immutable';
  if (path === '/sw.js' || path === '/manifest.webmanifest' || path.endsWith('.html')) return 'no-cache';
  return 'public, max-age=3600';
}

export async function handleStatic({ path }: Context): Promise<Response> {
  const relativePath = path.startsWith('/') ? path.slice(1) : path;
  const resolved = join(distDir, relativePath);

  // Guard against path traversal
  if (!resolved.startsWith(distDir + '/') && resolved !== distDir) {
    return json({ error: 'Not found' }, 404);
  }

  const file = Bun.file(resolved);
  if (await file.exists()) {
    return new Response(file, { headers: { ...SECURITY_HEADERS, 'Cache-Control': cacheControl(path) } });
  }

  // SPA fallback for non-file, non-API paths
  if (!path.startsWith('/api/') && !path.includes('.')) {
    const indexFile = Bun.file(join(distDir, 'index.html'));
    if (await indexFile.exists()) {
      return new Response(indexFile, { headers: { ...SECURITY_HEADERS, 'Cache-Control': 'no-cache' } });
    }
  }

  return json({ error: 'Not found' }, 404);
}
