import { parseAddress } from '../../shared/address'
import { getPubkey } from '../db.ts';
import { json } from '../http.ts';
import type { Context } from '../http.ts';

export async function handleGetPubkey({ path }: Context): Promise<Response> {
  const address = parseAddress(path.split('/')[3]);
  if (!address) return json({ error: 'Invalid address format' }, 400);
  const pubkey = getPubkey(address);
  return json({ pubkey: pubkey ? `0x${pubkey}` : null });
}
