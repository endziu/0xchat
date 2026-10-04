import { requireAddress } from '../../shared/address.ts';
import { getPubkey } from '../db.ts';
import { json } from '../http.ts';
import type { Context } from '../http.ts';

export async function handleGetPubkey({ path }: Context): Promise<Response> {
  const address = requireAddress(path.split('/')[3]);
  const pubkey = getPubkey(address);
  return json({ pubkey: pubkey ? `0x${pubkey}` : null });
}
