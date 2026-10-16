/**
 * Dependency-free JEV decision-service contract shared by the server and the dashboard bundle.
 * Keep it import-free: `gui/` imports it directly, so anything added here ships to the browser.
 */

/** Canonical TypeSafe decision service; valid as `decisionProvider` even without a provider row. */
export const CANONICAL_JEV_DECISION_PROVIDER = "jev";
export const JEV_DECISION_TIMEOUT_MIN_MS = 1_000;
export const JEV_DECISION_TIMEOUT_MAX_MS = 120_000;
/** Decision deadline when a combo sets no `decisionTimeoutMs`. */
export const JEV_DECISION_TIMEOUT_DEFAULT_MS = 4_000;

/** HTTPS decision services may use any path; local cleartext keeps the `/systemone` contract. */
export function isSystemOneEndpoint(baseUrl: string): boolean {
  try {
    const raw = baseUrl.trim();
    // URL drops empty delimiters ("?", "#", "@") and strips tab/CR/LF, so check the raw text first.
    if (/[\u0000-\u001f\u007f]/.test(raw)) return false;
    const authority = raw.replace(/^[a-z][a-z\d+.-]*:[/\\]*/i, "").split(/[/\\]/, 1)[0] ?? "";
    if (/[?#]/.test(raw) || authority.includes("@")) return false;
    const url = new URL(raw);
    if (url.username || url.password || url.search || url.hash) return false;
    // URL canonicalizes address literals; keep this import-free for the dashboard bundle.
    const host = url.hostname;
    const local = host === "localhost" || host === "[::1]"
      || /^(?:(?:127|10)\.\d+|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d+\.\d+$/.test(host)
      || /^\[f[cd][\da-f]{2}:/.test(host) || /^\[::ffff:7f[\da-f]{2}:/.test(host);
    return url.protocol === "https:"
      || url.protocol === "http:" && local && url.pathname.replace(/\/+$/, "").endsWith("/systemone");
  } catch {
    return false;
  }
}

/**
 * The URL a decision row is sent to. A `/systemone` path keeps its historical trailing-slash
 * normalization; any other HTTPS path is the operator's exact endpoint.
 */
export function jevDecisionEndpointUrl(baseUrl: string): string {
  const raw = baseUrl.trim();
  const stripped = raw.replace(/\/+$/, "");
  return stripped.endsWith("/systemone") ? stripped : raw;
}
