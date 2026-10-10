import { join } from 'node:path';
import { json } from '../http.ts';
import { SECURITY_HEADERS, distDir } from '../constants.ts';
import type { Context } from '../http.ts';

/**
 * Vite and VitePress content-hash everything under /assets/ and /docs/assets/,
 * so those are immutable. The service worker, the manifest and the HTML shell
 * must always be revalidated — a stale sw.js would pin an old build indefinitely.
 */
function cacheControl(path: string): string {
  if (path.startsWith('/assets/') || path.startsWith('/docs/assets/')) return 'public, max-age=31536000, immutable';
  if (path === '/sw.js' || path === '/manifest.webmanifest' || path.endsWith('.html')) return 'no-cache';
  return 'public, max-age=3600';
}

export async function handleStatic({ path, url }: Context): Promise<Response> {
  // The router strips trailing slashes, so check the raw URL: the docs site
  // lives at /docs/, and its client router does not recognise /docs.
  if (path === '/docs') {
    if (url.pathname === '/docs') {
      return new Response(null, { status: 301, headers: { ...SECURITY_HEADERS, Location: '/docs/' } });
    }
    path = '/docs/index.html';
  }
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

  // The docs are their own site: an unknown docs page gets the docs 404, not the app.
  if (path.startsWith('/docs/')) {
    const notFound = Bun.file(join(distDir, 'docs', '404.html'));
    if (await notFound.exists()) {
      return new Response(notFound, { status: 404, headers: { ...SECURITY_HEADERS, 'Cache-Control': 'no-cache' } });
    }
    return json({ error: 'Not found' }, 404);
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
