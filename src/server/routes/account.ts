import { parseAddress } from '../../shared/address.ts';
import { deleteRegistration, getConversationPartners } from '../db.ts';
import { json, getSessionAddress } from '../http.ts';
import { publish } from '../sse.ts';
import { log, warn } from '../constants.ts';
import type { Context } from '../http.ts';

export async function handleDeleteAddress({ req, path, ip }: Context): Promise<Response> {
  const address = getSessionAddress(req);
  if (!address) {
    warn('[unauth] delete address no session', ip);
    return json({ error: 'Unauthorized' }, 401);
  }

  const targetAddr = parseAddress(path.slice('/api/addresses/'.length));
  if (!targetAddr) return json({ error: 'Invalid address format' }, 400);

  if (address !== targetAddr) {
    warn('[forbidden] delete address', address, 'tried to delete', targetAddr);
    return json({ error: 'Forbidden' }, 403);
  }

  const partners = getConversationPartners(address);
  deleteRegistration(address);

  for (const partner of partners) {
    publish(partner, { type: 'user:disconnected', data: { address } });
  }

  log('[del]', address, 'deleted account, notified', partners.length, 'partners');
  return json({ success: true });
}
