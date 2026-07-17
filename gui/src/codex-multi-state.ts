export type CodexMultiProviderState = "absent" | "enabled" | "disabled";

export function codexMultiProviderState(config: unknown): CodexMultiProviderState {
  if (!config || typeof config !== "object") return "absent";
  const providers = (config as { providers?: unknown }).providers;
  if (!providers || typeof providers !== "object" || !Object.hasOwn(providers, "openai-multi")) return "absent";
  const provider = (providers as Record<string, unknown>)["openai-multi"];
  return provider && typeof provider === "object" && (provider as { disabled?: unknown }).disabled === true
    ? "disabled"
    : "enabled";
}
