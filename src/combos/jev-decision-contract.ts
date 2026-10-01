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

/** Whether a self-hosted decision endpoint follows the documented Jev `/systemone` path. */
export function isSystemOneEndpoint(baseUrl: string): boolean {
  try {
    return new URL(baseUrl.trim()).pathname.replace(/\/+$/, "").endsWith("/systemone");
  } catch {
    return false;
  }
}
