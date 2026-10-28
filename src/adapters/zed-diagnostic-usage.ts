/** Diagnostic terminals carry counters only; opaque usage extensions are untrusted. */
export function zedDiagnosticUsage(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const counters = (record: Record<string, unknown>, keys: string[]): Record<string, number> => Object.fromEntries(
    keys.flatMap(key => {
      const count = record[key];
      return typeof count === "number" && Number.isFinite(count) && count >= 0 ? [[key, count]] : [];
    }),
  );
  const usage: Record<string, unknown> = counters(source, ["input_tokens", "output_tokens", "total_tokens"]);
  for (const [field, keys] of [
    ["input_tokens_details", ["cached_tokens", "cache_write_tokens", "cache_write_1h_tokens"]],
    ["output_tokens_details", ["reasoning_tokens"]],
  ] as const) {
    const details = source[field];
    if (details && typeof details === "object" && !Array.isArray(details)) {
      usage[field] = counters(details as Record<string, unknown>, [...keys]);
    }
  }
  return usage;
}
