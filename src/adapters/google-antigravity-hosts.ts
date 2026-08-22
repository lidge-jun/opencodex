const DAILY_ANTIGRAVITY_HOST = "https://daily-cloudcode-pa.googleapis.com";
const PROD_ANTIGRAVITY_HOST = "https://cloudcode-pa.googleapis.com";

/**
 * Return the configured Antigravity endpoint and, for Google's known daily/prod hosts
 * only, its daily/production peer. Custom baseUrl values stay single-host.
 */
export function antigravityHostCandidates(configuredBase: string): string[] {
  const configured = configuredBase.replace(/\/+$/, "");
  if (configured === DAILY_ANTIGRAVITY_HOST) {
    return [DAILY_ANTIGRAVITY_HOST, PROD_ANTIGRAVITY_HOST];
  }
  if (configured === PROD_ANTIGRAVITY_HOST) {
    return [PROD_ANTIGRAVITY_HOST, DAILY_ANTIGRAVITY_HOST];
  }
  return [configured];
}

/** OAuth bearer requests must not use a cleartext host, even if generic baseUrl config allows http. */
export function isAntigravityHttpsHost(host: string): boolean {
  try {
    return new URL(host).protocol === "https:";
  } catch {
    return false;
  }
}
