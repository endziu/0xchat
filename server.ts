import { initDb, deleteExpiredMessages, deleteExpiredSessions } from './src/server/db.ts';
import { PORT, error } from './src/server/constants.ts';
import { json } from './src/server/http.ts';
import { createFetch, regStore, authStore, cleanupSseTokens } from './src/server/router.ts';

initDb();

setInterval(() => {
  deleteExpiredMessages();
  deleteExpiredSessions();
}, 30_000).unref();

setInterval(() => {
  regStore.cleanup();
  authStore.cleanup();
  cleanupSseTokens();
}, 60_000).unref();

Bun.serve({
  port: PORT,
  idleTimeout: 60,
  fetch: createFetch(),
  error(err: Error) {
    error('[error]', err.message);
    return json({ error: 'Internal server error' }, 500);
  },
});

console.log(`eth-chat server running on http://localhost:${PORT}`);
