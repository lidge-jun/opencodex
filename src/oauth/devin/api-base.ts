/**
 * Allowlist for the Cognition/Devin api-server origin.
 *
 * RegisterUser returns the tenant's api-server host, and that host then receives
 * GetUserJwt, GetCascadeModelConfigs and GetChatMessage - the first of which
 * carries the long-lived api_key. A host taken from the network without
 * validation turns a spoofed or compromised RegisterUser response into
 * credential exfiltration, so every value that reaches a request URL or the
 * credential store passes through here first.
 *
 * This lives in its own module rather than in `../devin.ts` because the
 * credential store imports the validator and `../devin.ts` imports the store's
 * sibling types; a shared leaf keeps that from becoming a cycle.
 */

export const DEVIN_DEFAULT_API_SERVER = "https://server.codeium.com";

/**
 * Return the normalized api-server base URL, or undefined when the input is not
 * an allowlisted Cognition host.
 *
 * Unlike the Copilot equivalent this keeps the path. EU and FedStart tenants are
 * reached at `https://eu.windsurf.com/_route/api_server`, so the path prefix is
 * part of the address rather than decoration, and normalizing to the origin
 * would silently point those accounts at the wrong service.
 */
export function validateDevinApiBaseUrl(raw: string | undefined | null): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const trimmed = String(raw).trim();
  if (!trimmed) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:") return undefined;
  if (parsed.username || parsed.password) return undefined;
  if (parsed.port && parsed.port !== "443") return undefined;
  if (parsed.search || parsed.hash) return undefined;
  const host = parsed.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return undefined;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) return undefined;
  const allowed =
    host === "server.codeium.com" ||
    // The shipped client (Devin Desktop 3.9.19,
    // Contents/Resources/app/extensions/windsurf/dist/extension.js) also names
    // these two, and a beta account's RegisterUser can return one.
    host === "server-staging.codeium.com" ||
    host === "server-beta.codeium.com" ||
    host === "windsurf.com" ||
    host.endsWith(".windsurf.com") ||
    host === "windsurf.fedstart.com";
  if (!allowed) return undefined;
  const path = parsed.pathname.replace(/\/+$/, "");
  if (path && !/^(\/[A-Za-z0-9._-]+)+$/.test(path)) return undefined;
  return `https://${host}${path}`;
}

/** Same check, falling back to the default US host when the input is unusable. */
export function resolveDevinApiBaseUrl(raw: string | undefined | null): string {
  return validateDevinApiBaseUrl(raw) ?? DEVIN_DEFAULT_API_SERVER;
}
