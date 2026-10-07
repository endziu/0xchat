export const UNSUPPORTED_PUSH_SERVICE_CODE = 'unsupported_push_service';
/** The server no longer accepts this client's delivery protocol; retrying cannot help. */
export const CLIENT_UPDATE_REQUIRED_CODE = 'client_update_required';

const API_ERROR_CODES = [UNSUPPORTED_PUSH_SERVICE_CODE, 'registration_required', 'invalid_request',
  'unauthorized', 'rate_limited', 'payload_too_large', CLIENT_UPDATE_REQUIRED_CODE] as const;

export type ApiErrorCode = typeof API_ERROR_CODES[number];

export function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return typeof value === 'string' && API_ERROR_CODES.some(code => code === value);
}
