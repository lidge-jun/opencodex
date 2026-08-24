const DAILY_HOSTNAME = "daily-cloudcode-pa.googleapis.com";
const PROD_HOSTNAME = "cloudcode-pa.googleapis.com";
export const DAILY_ANTIGRAVITY_HOST = `https://${DAILY_HOSTNAME}`;
export const PROD_ANTIGRAVITY_HOST = `https://${PROD_HOSTNAME}`;

function knownAntigravityHttpsHost(origin: string): string | undefined {
  try {
    const url = new URL(origin.replace(/\/+$/, ""));
    if (url.hostname === DAILY_HOSTNAME) return DAILY_ANTIGRAVITY_HOST;
    if (url.hostname === PROD_HOSTNAME) return PROD_ANTIGRAVITY_HOST;
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * When a configured origin is a known Google daily/prod host (http or https), return the
 * canonical HTTPS origin. Custom hosts are left unchanged.
 */
export function canonicalAntigravityHttpsHost(origin: string): string | undefined {
  return knownAntigravityHttpsHost(origin);
}

/**
 * Return the configured Antigravity endpoint and, for Google's known daily/prod hosts
 * only, its daily/production peer. Custom baseUrl values stay single-host.
 */
export function antigravityHostCandidates(configuredBase: string): string[] {
  const trimmed = configuredBase.replace(/\/+$/, "");
  const known = knownAntigravityHttpsHost(trimmed);
  if (known === DAILY_ANTIGRAVITY_HOST) {
    return [DAILY_ANTIGRAVITY_HOST, PROD_ANTIGRAVITY_HOST];
  }
  if (known === PROD_ANTIGRAVITY_HOST) {
    return [PROD_ANTIGRAVITY_HOST, DAILY_ANTIGRAVITY_HOST];
  }
  return [trimmed];
}

/** OAuth bearer requests must not use a cleartext host, even if generic baseUrl config allows http. */
export function isAntigravityHttpsHost(host: string): boolean {
  try {
    return new URL(host).protocol === "https:";
  } catch {
    return false;
  }
}
