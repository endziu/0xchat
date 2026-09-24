export const UNSUPPORTED_PUSH_SERVICE_CODE = 'unsupported_push_service';

const API_ERROR_CODES = [UNSUPPORTED_PUSH_SERVICE_CODE, 'ownership_conflict', 'slot_cap',
  'revoked', 'revision_conflict', 'repair_needed', 'registration_required', 'invalid_request',
  'unauthorized', 'rate_limited', 'payload_too_large', 'client_update_required'] as const;

export type ApiErrorCode = typeof API_ERROR_CODES[number];

export function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return typeof value === 'string' && API_ERROR_CODES.some(code => code === value);
}
