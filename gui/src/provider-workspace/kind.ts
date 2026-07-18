/**
 * provider-workspace/kind.ts — pure provider-type classification for the rail
 * filter (WP080a). Distinct from the pricing/ownership TIER in catalog.ts:
 * the `login` kind covers ALL oauth/forward providers, while the accounts tier
 * is the canonical openai provider only.
 */
import { hasLoopbackBaseUrl, type WorkspaceProvider } from "./catalog";

export type ProviderKind = "cloud" | "local" | "selfHosted" | "login";

/** Local runtime: explicit local auth mode or a loopback base URL. */
export function isLocalProvider(item: WorkspaceProvider): boolean {
  return item.authMode === "local" || hasLoopbackBaseUrl(item.baseUrl);
}

export const SELF_HOSTED_HINTS = ["ollama", "vllm", "lm-studio", "lmstudio", "litellm", "localai"];

export function providerKind(item: WorkspaceProvider & { name?: string }): ProviderKind {
  const mode = (item.authMode ?? "").toLowerCase();
  if (mode === "oauth" || mode === "forward") return "login";
  if (isLocalProvider(item)) return "local";
  const haystack = `${item.name ?? ""} ${item.adapter} ${item.baseUrl}`.toLowerCase();
  if (SELF_HOSTED_HINTS.some(hint => haystack.includes(hint))) return "selfHosted";
  return "cloud";
}
