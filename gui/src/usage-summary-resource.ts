/** Positive diagnostics only: an older response without the flag proves no completeness. */
export interface UsageReadMetadata {
  usageIncomplete?: true;
  usageIncompleteReason?: "oversized_rows";
}

export function readUsageMetadata(value: unknown): UsageReadMetadata {
  if (!value || typeof value !== "object" || !("usageIncomplete" in value) || value.usageIncomplete !== true) return {};
  return {
    usageIncomplete: true,
    ...("usageIncompleteReason" in value && value.usageIncompleteReason === "oversized_rows"
      ? { usageIncompleteReason: "oversized_rows" as const } : {}),
  };
}

/** Older daemons returned this failure as HTTP 200; never admit that envelope as usage data. */
export function isUsageReadFailure(value: unknown): boolean {
  return !!value && typeof value === "object" && "error" in value && value.error === "read_failed";
}

export class UsageReadFailedError extends Error {
  constructor() {
    super("usage ledger read failed");
    this.name = "UsageReadFailedError";
  }
}

/** Admit usage data only after recognizing both current HTTP errors and legacy HTTP-200 failures. */
export async function readUsageResponseJson<T>(response: Response, fallbackMessage?: string): Promise<T> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error(fallbackMessage ?? `${response.status} ${response.statusText}`.trim());
  }
  if (isUsageReadFailure(value)) throw new UsageReadFailedError();
  if (!response.ok) throw new Error(fallbackMessage ?? `${response.status} ${response.statusText}`.trim());
  return value as T;
}

export function usageSummary30dResourceKey(apiBase: string, surface: "all" | "codex" = "all"): string {
  return surface === "codex"
    ? ["usage-summary-30d", apiBase, "codex"].join(":")
    : ["usage-summary-30d", apiBase, "all"].join(":");
}
