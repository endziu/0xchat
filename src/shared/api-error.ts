export const UNSUPPORTED_PUSH_SERVICE_CODE = 'unsupported_push_service';

export type ApiErrorCode = typeof UNSUPPORTED_PUSH_SERVICE_CODE;

export function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return value === UNSUPPORTED_PUSH_SERVICE_CODE;
}
