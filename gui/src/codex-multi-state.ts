export type CodexAccountModeState = "pool" | "direct" | "disabled" | "absent";

export function codexAccountModeState(config: unknown): CodexAccountModeState {
  if (!config || typeof config !== "object") return "absent";
  const providers = (config as { providers?: unknown }).providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers) || !Object.hasOwn(providers, "openai")) return "absent";
  const provider = (providers as Record<string, unknown>).openai;
  if (!provider || typeof provider !== "object" || Array.isArray(provider)) return "absent";
  const value = provider as { disabled?: unknown; codexAccountMode?: unknown };
  if (value.disabled === true) return "disabled";
  if (value.codexAccountMode === "direct") return "direct";
  if (value.codexAccountMode === undefined || value.codexAccountMode === "pool") return "pool";
  return "absent";
}
