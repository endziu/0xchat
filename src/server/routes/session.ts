import { deleteSession } from '../db.ts'
import { SECURITY_HEADERS, log, warn } from '../constants.ts'
import { getBearerToken, json } from '../http.ts'
import type { Context } from '../http.ts'

export async function handleDeleteSession({ req, ip }: Context): Promise<Response> {
  const token = getBearerToken(req)
  if (!token) {
    warn('[unauth] delete session no bearer token', ip)
    return json({ error: 'Unauthorized' }, 401)
  }

  deleteSession(token)
  log('[auth] session revoked')
  return new Response(null, { status: 204, headers: SECURITY_HEADERS })
}
