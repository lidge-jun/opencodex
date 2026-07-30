export function logsFromApiBody<T extends Record<string, unknown> = Record<string, unknown>>(body: unknown): T[] {
  if (Array.isArray(body)) return body as T[];
  if (body && typeof body === "object" && Array.isArray((body as { logs?: unknown }).logs)) {
    return (body as { logs: T[] }).logs;
  }
  return [];
}
