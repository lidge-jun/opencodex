/**
 * Shared types for the OAuth login flow + persisted credentials.
 *
 * Two distinct token shapes appear in this codebase:
 *
 *  - `firebaseIdToken` — the short-lived JWT minted by Auth0 / Firebase Auth
 *    during browser sign-in. Lives in the OAuth callback URL fragment/query.
 *    Treated as opaque and discarded once exchanged.
 *
 *  - `apiKey` — the long-lived credential returned by
 *    `SeatManagementService.RegisterUser`. Used inside every Cascade RPC's
 *    `Metadata.api_key` field. Format is provider-defined:
 *      * Cognition era:  `devin-session-token$<JWT>`
 *      * Codeium classic: bare UUID v4
 *      * Older Windsurf:  `sk-ws-01-<...>` / `cog_<...>`
 *    The plugin treats it as an opaque string — only the cloud cares about format.
 */

export interface OAuthLoginResult {
  /** The opaque API key used as `Metadata.api_key` in every Cascade RPC. */
  apiKey: string;
  /** Human-readable account name (`Satvik Kapoor`). */
  name: string;
  /**
   * Cloud API server (`https://server.codeium.com`, `https://eu.windsurf.com/_route/api_server`,
   * `https://windsurf.fedstart.com/_route/api_server`). Driven by the user's
   * tenant — language_server needs this as `--api_server_url`.
   */
  apiServerUrl: string;
  /** Optional cleanup redirect URL returned by RegisterUser. Informational. */
  redirectUrl?: string;
}

export interface PersistedCredentials extends OAuthLoginResult {
  /** ISO timestamp the credentials were minted at — purely informational. */
  issuedAt: string;
  /** Optional tag tracking the OAuth client id used (so a future client rotation can invalidate). */
  oauthClientId: string;
  /**
   * True when these credentials were written as part of the
   * `opencode auth login` → authorize() flow (so opencode's auth.json is the
   * authoritative copy and `opencode auth logout windsurf` should mirror-clear
   * this file). False / absent for credentials written by our standalone
   * `opencode-windsurf-auth login` CLI; those survive opencode auth state
   * changes.
   */
  syncedViaOpencodeAuth?: boolean;
}

export interface WindsurfRegion {
  /** Where to send users for browser sign-in. */
  website: string;
  /** Where to POST RegisterUser. */
  registerApiServerUrl: string;
  /** Auth0 client id passed in the OAuth URL. */
  oauthClientId: string;
}

/**
 * The single tenant (free / personal) configuration. EU, FedStart, and arbitrary
 * portal URLs override `website` + `registerApiServerUrl` at runtime when the
 * user passes `--portal-url` to the login command.
 */
export const DEFAULT_REGION: WindsurfRegion = {
  website: 'https://windsurf.com',
  registerApiServerUrl: 'https://register.windsurf.com',
  // From /Applications/Windsurf.app/.../extension.js — the public Windsurf
  // Auth0 client. If Windsurf rotates this, sign-in will start failing until
  // we re-extract it.
  oauthClientId: '3GUryQ7ldAeKEuD2obYnppsnmj58eP5u',
};
