/**
 * Registry- and config-aware Anthropic instance checks. See `./anthropic-instance-id.ts` for the IDs and
 * the pure row-shape rule; this module adds the registry declaration and the configured-row lookup.
 *
 * Instance membership is never inferred from `adapter === "anthropic"` (the API-key provider and
 * Anthropic-compatible gateways share that adapter) or from a name prefix.
 */
import type { OcxConfig, OcxProviderConfig } from "../types";
import { getProviderRegistryEntry } from "./registry";
import { anthropicInstanceRowShapeMatches, isAnthropicInstanceId, type AnthropicInstanceId } from "./anthropic-instance-id";

export * from "./anthropic-instance-id";

/** Exact registry check: one of the two IDs, declared as an Anthropic-family OAuth entry with its own OAuth ID. */
export function isAnthropicOAuthInstance(id: string | undefined): id is AnthropicInstanceId {
  if (!isAnthropicInstanceId(id)) return false;
  const entry = getProviderRegistryEntry(id);
  return entry !== undefined
    && entry.authKind === "oauth"
    && entry.oauthId === id
    && entry.oauthFamily === "anthropic";
}

export function isBuiltinAnthropicInstanceRow(
  name: string,
  row?: Partial<Pick<OcxProviderConfig, "adapter" | "authMode" | "baseUrl" | "anthropicOAuthInstance">>,
): boolean {
  return isAnthropicOAuthInstance(name) && anthropicInstanceRowShapeMatches(name, row);
}

/**
 * The instance a configured provider name runs as, or undefined.
 *
 * For `anthropic` this is a compatibility identity result: it returns the instance whenever the name is
 * `anthropic`, and callers keep every auth-mode, enabled-provider and eligibility check they already
 * apply. For `anthropic2` the row must exist, must not be disabled and must pass the builtin row-shape
 * rule, so an orphan `anthropic2` auth row or a custom provider of that name never activates the pool.
 */
export function configuredAnthropicInstance(
  config: Pick<OcxConfig, "providers">,
  name: string | undefined,
): AnthropicInstanceId | undefined {
  if (!isAnthropicOAuthInstance(name)) return undefined;
  if (name === "anthropic") return "anthropic";
  const row = config.providers?.[name];
  if (!row || row.disabled === true) return undefined;
  return anthropicInstanceRowShapeMatches(name, row) ? name : undefined;
}
