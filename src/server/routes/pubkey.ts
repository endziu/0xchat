import { getPubkey } from '../db.ts';
import { json } from '../http.ts';
import type { Context } from '../http.ts';

export async function handleGetPubkey({ path }: Context): Promise<Response> {
  const match = path.match(/^\/api\/pubkey\/(0x[0-9a-fA-F]{40})$/);
  const address = match![1]!.toLowerCase();
  const pubkey = getPubkey(address);
  return json({ pubkey: pubkey ? `0x${pubkey}` : null });
}
