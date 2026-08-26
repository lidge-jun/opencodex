import type { OcxConfig } from "../types";

/**
 * Whether a login should open a browser on the machine running the proxy.
 *
 * Both login routes share this so the two surfaces cannot drift: a per-request
 * `openBrowser` beats the persisted setting, and the persisted setting beats
 * the historical default. It lives in `src/oauth/` rather than beside either
 * route because `src/codex/auth-api.ts` and
 * `src/server/management/oauth-account-routes.ts` both already import from
 * here, so no new edge is added to the import graph.
 *
 * The default is the important part. An operator who upgrades and configures
 * nothing must see exactly what they saw before, so only an explicit `false`
 * declines — `undefined`, `true`, and a malformed value all open.
 *
 * A malformed request field is ignored rather than rejected on purpose: this is
 * a display preference, and no login should fail because of one.
 */
export function shouldOpenBrowserForLogin(
  requested: unknown,
  config: Pick<OcxConfig, "oauthOpenBrowser">,
): boolean {
  if (typeof requested === "boolean") return requested;
  return config.oauthOpenBrowser !== false;
}
