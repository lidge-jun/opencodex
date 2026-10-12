import type { TFn } from "./i18n/shared";

/**
 * Mirrors the alias contract both credential routes enforce — src/codex/auth-api/routes.ts
 * and src/server/management/oauth-account-routes.ts each trim the submitted value and then
 * reject it when it exceeds 80 characters or carries a control character.
 *
 * The platform `prompt()` could not check anything, so an over-long or pasted control
 * character reached the route and came back as an opaque 400 the user had to interpret.
 * Checking the same rule in the dialog turns that into a message beside the field, and the
 * rule is stated once here so the two cannot drift apart silently.
 */
export const CREDENTIAL_ALIAS_MAX_LENGTH = 80;

/**
 * Written as a code-point scan rather than a character-class regex, matching
 * `containsDisplayNameControlCharacter` in pages/models-shared.ts. A literal control range
 * in a regex is what `no-control-regex` exists to catch, and the escape form would only
 * hide the same characters from the reader.
 */
function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

/** Returns the message to show, or null when the route would accept the value. */
export function credentialAliasRejection(value: string, t: TFn): string | null {
  const alias = value.trim();
  if (alias.length > CREDENTIAL_ALIAS_MAX_LENGTH || hasControlCharacter(alias)) {
    return t("prov.aliasInvalid");
  }
  return null;
}
