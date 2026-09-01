// `catch` binds `unknown`, and a rejected fetch/JSON path can throw anything.
// Narrow to a real Error before touching `.message`, so a non-Error throw
// degrades to the caller's fallback instead of rendering "undefined".
export function errorMessage(err: unknown, fallback: string): string {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  return message.trim() || fallback
}
