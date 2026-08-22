/** Case-insensitive credential/auth transport header names stripped on pair replacement. */
export const REPLIT_CREDENTIAL_HEADER_NAMES = new Set([
  "api-key",
  "authorization",
  "cookie",
  "proxy-authorization",
  "set-cookie",
  "x-api-key",
  "x-api-token",
  "x-auth-token",
  "x-goog-api-key",
]);

export function isReplitCredentialHeader(name: string): boolean {
  return REPLIT_CREDENTIAL_HEADER_NAMES.has(name.trim().toLowerCase());
}

export function preserveReplitCustomHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const next: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (isReplitCredentialHeader(name)) continue;
    next[name] = value;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}
