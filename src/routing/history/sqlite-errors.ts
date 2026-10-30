/** Only structural SQLite damage justifies discarding the derived index. */
export function isHistoryIndexCorruption(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { code, errno } = error as { code?: unknown; errno?: unknown };
  // Bun exposes extended result codes too; the low byte is the primary code.
  if (typeof errno === "number" && ((errno & 0xff) === 11 || (errno & 0xff) === 26)) return true;
  return typeof code === "string"
    && /^(SQLITE_CORRUPT(?:_[A-Z]+)?|SQLITE_NOTADB)$/.test(code);
}
