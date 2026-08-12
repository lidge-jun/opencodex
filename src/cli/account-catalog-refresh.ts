export const CODEX_CATALOG_REFRESH_PENDING_WARNING =
  "Warning: the account change was saved, but the Codex model catalog refresh is pending. Run 'ocx sync' to retry.";

/** Read only the public completion flag from an account mutation response. */
export function codexCatalogRefreshPending(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const descriptor = Object.getOwnPropertyDescriptor(value, "catalogRefreshPending");
  return descriptor !== undefined && "value" in descriptor && descriptor.value === true;
}

/** Print fixed recovery guidance without reflecting server or account details. */
export function warnIfCodexCatalogRefreshPending(value: unknown): void {
  if (codexCatalogRefreshPending(value)) console.error(CODEX_CATALOG_REFRESH_PENDING_WARNING);
}
