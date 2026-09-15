/** Shared, initialization-independent shape check for provider send-path overrides. */
export function providerRelativeSendPathConfigError(
  field: "responsesPath" | "chatCompletionsPath",
  value: unknown,
): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string") return `${field} must be a string`;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) || value.includes("://")) {
    return `${field} must be a relative path without a URL scheme`;
  }
  if (!value.startsWith("/")) return `${field} must start with /`;
  if (value.includes("?") || value.includes("#")) {
    return `${field} must not include query strings or fragments`;
  }
  return null;
}
