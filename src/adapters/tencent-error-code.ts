/**
 * The Tencent chat gateway reports a business code in one of two shapes: a flat
 * `{"code":14018}` for channel and account refusals, and a nested
 * `{"error":{"data":{"code":14018}}}` for billing refusals. A reader that only
 * looks at the top level turns every credits-exhausted response into a generic
 * HTTP status, which is what the WorkBuddy and CodeBuddy adapters used to do.
 */
export function tencentBusinessCode(payloadText: string): number | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadText);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  const error = record.error;
  const nested = typeof error === "object" && error !== null
    ? (error as Record<string, unknown>).data
    : undefined;
  const candidates = [
    record.code,
    typeof nested === "object" && nested !== null ? (nested as Record<string, unknown>).code : undefined,
  ];
  for (const candidate of candidates) {
    const code = Number(candidate);
    if (Number.isFinite(code) && code > 0) return code;
  }
  return undefined;
}
