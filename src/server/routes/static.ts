import { join } from 'node:path';
import { json } from '../http.ts';
import { SECURITY_HEADERS, distDir } from '../constants.ts';
import type { Context } from '../http.ts';

export async function handleStatic({ path }: Context): Promise<Response> {
  const relativePath = path.startsWith('/') ? path.slice(1) : path;
  const resolved = join(distDir, relativePath);

  // Guard against path traversal
  if (!resolved.startsWith(distDir + '/') && resolved !== distDir) {
    return json({ error: 'Not found' }, 404);
  }

  const file = Bun.file(resolved);
  if (await file.exists()) {
    return new Response(file, { headers: SECURITY_HEADERS });
  }

  // SPA fallback for non-file, non-API paths
  if (!path.startsWith('/api/') && !path.includes('.')) {
    const indexFile = Bun.file(join(distDir, 'index.html'));
    if (await indexFile.exists()) {
      return new Response(indexFile, { headers: SECURITY_HEADERS });
    }
  }

  return json({ error: 'Not found' }, 404);
}
