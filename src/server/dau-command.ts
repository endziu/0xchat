import { Database } from 'bun:sqlite';

/** Read-only local access: no HTTP endpoint or identity-level output. */
export function readDailyActivityTotals(path = 'chat.db'): Array<{ day: string; identities: number }> {
  const db = new Database(path, { readonly: true });
  try {
    if (!db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'daily_activity_totals'").get()) {
      return [];
    }
    return db.query('SELECT day, identities FROM daily_activity_totals ORDER BY day').all() as Array<{
      day: string; identities: number;
    }>;
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  console.log(JSON.stringify(readDailyActivityTotals(), null, 2));
}
