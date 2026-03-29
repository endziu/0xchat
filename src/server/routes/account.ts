import { deleteAddress, deleteAddressConversations, deleteAddressSessions, getConversationPartners } from '../db.ts';
import { json, getSessionAddress } from '../http.ts';
import { notify } from '../sse.ts';
import { isValidAddress } from '../validation.ts';
import { log, warn } from '../constants.ts';
import type { Context } from '../http.ts';

export async function handleDeleteAddress({ req, path, ip }: Context): Promise<Response> {
  const address = getSessionAddress(req);
  if (!address) {
    warn('[unauth] delete address no session', ip);
    return json({ error: 'Unauthorized' }, 401);
  }

  const match = path.match(/^\/api\/addresses\/(.+)$/);
  const targetAddr = match![1]!.toLowerCase();

  if (!isValidAddress(targetAddr)) return json({ error: 'Invalid address format' }, 400);
  if (address !== targetAddr) {
    warn('[forbidden] delete address', address, 'tried to delete', targetAddr);
    return json({ error: 'Forbidden' }, 403);
  }

  const partners = getConversationPartners(address);
  deleteAddressSessions(address);
  deleteAddressConversations(address);
  deleteAddress(address);

  for (const partner of partners) {
    notify(partner, 'user:disconnected', { address });
  }

  log('[del]', address, 'deleted account, notified', partners.length, 'partners');
  return json({ success: true });
}
