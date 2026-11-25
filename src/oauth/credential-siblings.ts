/**
 * OAuth credential siblings: registry provider rows that sign in through another provider's
 * login instead of owning one.
 *
 * The auth store holds one slot per login. A sibling row has no slot of its own; every store
 * read and write addressed to its name lands in the owner's slot, and token refresh runs under
 * the owner's name. One login therefore serves both rows, a rotating refresh token is never
 * refreshed twice under two names, and logging out of the owner signs out both rows.
 *
 * The map is the registry's `oauthId !== id` rows, restated here as a plain constant so the
 * dashboard can import it without pulling in the provider registry
 * (tests/oauth/oauth-credential-siblings.test.ts pins the two together). Kimi (Responses) is
 * the only sibling: owner decision on #8087. Other OAuth presets keep their own logins.
 */
export const OAUTH_CREDENTIAL_SIBLINGS: Readonly<Record<string, string>> = Object.freeze({
  "kimi-responses": "kimi",
});

/** The auth-store slot that holds this provider row's login: the owner for a sibling, else itself. */
export function oauthCredentialSlot(provider: string): string {
  return Object.hasOwn(OAUTH_CREDENTIAL_SIBLINGS, provider) ? OAUTH_CREDENTIAL_SIBLINGS[provider]! : provider;
}

/** Whether `row` is a sibling row that signs in through `provider`'s login. */
export function isOAuthCredentialSiblingOf(row: string, provider: string): boolean {
  return row !== provider && Object.hasOwn(OAUTH_CREDENTIAL_SIBLINGS, row) && OAUTH_CREDENTIAL_SIBLINGS[row] === provider;
}

/** Sibling rows that sign in through `provider`'s login. */
export function oauthCredentialSiblingsOf(provider: string): string[] {
  return Object.keys(OAUTH_CREDENTIAL_SIBLINGS).filter(row => OAUTH_CREDENTIAL_SIBLINGS[row] === provider);
}
