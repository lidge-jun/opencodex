const DAILY_ANTIGRAVITY_HOST = "https://daily-cloudcode-pa.googleapis.com";
const PROD_ANTIGRAVITY_HOST = "https://cloudcode-pa.googleapis.com";

/**
 * Return the configured Antigravity endpoint followed by its daily/production peer.
 * The configured value is preserved so tests and future pinned environments keep their
 * explicit first choice; the fallback is always one of Google's two known hosts.
 */
export function antigravityHostCandidates(configuredBase: string): string[] {
  const configured = configuredBase.replace(/\/+$/, "");
  const other = configured === DAILY_ANTIGRAVITY_HOST
    ? PROD_ANTIGRAVITY_HOST
    : DAILY_ANTIGRAVITY_HOST;
  return [...new Set([configured, other])];
}

/** OAuth bearer requests must not use a cleartext host, even if generic baseUrl config allows http. */
export function isAntigravityHttpsHost(host: string): boolean {
  try {
    return new URL(host).protocol === "https:";
  } catch {
    return false;
  }
}
