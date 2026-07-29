/** Canonical persisted Codex pool-account id format. */
export const CODEX_ACCOUNT_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

// Account credentials are persisted in JSON object maps. These names have
// special meaning on ordinary JavaScript objects and must never be admitted as
// user-controlled keys.
const RESERVED_CODEX_ACCOUNT_IDS = new Set(["__proto__", "prototype", "constructor"]);

/**
 * Stable internal id under which the Codex Desktop login participates in account rotation.
 * It is reserved and must never be used as a public namespace target or pool-account id.
 */
export const MAIN_CODEX_ACCOUNT_ID = "__main__";

export function isValidCodexAccountId(accountId: unknown): accountId is string {
  return typeof accountId === "string"
    && accountId !== MAIN_CODEX_ACCOUNT_ID
    && CODEX_ACCOUNT_ID_RE.test(accountId)
    && !RESERVED_CODEX_ACCOUNT_IDS.has(accountId.toLowerCase());
}

type CodexAccountIdentityRow = { id: string; isMain: boolean };

/** Legacy invalid rows remain loadable for cleanup, but never participate in routing. */
export function isSelectableCodexPoolAccount(account: CodexAccountIdentityRow): boolean {
  return !account.isMain && isValidCodexAccountId(account.id);
}

/** A pre-validation pool row that collides with the internal Desktop-account sentinel. */
export function hasLegacyMainCodexPoolAccount(
  accounts: readonly CodexAccountIdentityRow[] | undefined,
): boolean {
  return accounts?.some(account => !account.isMain && account.id === MAIN_CODEX_ACCOUNT_ID) ?? false;
}
