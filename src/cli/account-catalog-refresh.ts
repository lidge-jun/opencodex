export const CODEX_CATALOG_REFRESH_PENDING_WARNING =
  "Warning: the account change was saved, but the Codex model catalog refresh is pending. Run 'ocx sync' to retry.";

export function codexCatalogRefreshPending(value: unknown): boolean {
  return value !== null
    && typeof value === "object"
    && (value as Record<string, unknown>).catalogRefreshPending === true;
}

export function warnIfCodexCatalogRefreshPending(value: unknown): void {
  if (codexCatalogRefreshPending(value)) console.error(CODEX_CATALOG_REFRESH_PENDING_WARNING);
}
