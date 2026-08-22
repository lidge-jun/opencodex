/** Classify SQLite lock contention consistently across Log Guard mutation paths. */
export function isSqliteBusy(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
  const message = error instanceof Error ? error.message : String(error);
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED"
    || /database (?:is|table is) locked/i.test(message);
}
