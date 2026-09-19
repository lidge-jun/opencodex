/**
 * Dictation backend selection: the shared "reserved openai / custom provider / unknown" decision,
 * the provider-endpoint check, and the write-boundary validation for the `dictation` block.
 *
 * `configSchema` is `.passthrough()`, like `images` and `visionSidecar`, so a malformed `dictation`
 * value is accepted at load and only the write boundaries (CLI `config set/import`, management
 * `PUT /api/dictation-settings`) can refuse it. Keeping one resolver here means the CLI, the
 * management route, and the runtime dispatch in `src/server/audio-dictation.ts` cannot drift.
 */
import { getProviderRegistryEntry } from "../providers/registry";
import type { OcxProviderConfig } from "../types";
import { resolveEnvValue } from "./proxy-env";

export const DICTATION_OPENAI_TARGET = "openai";

const DICTATION_KEYS = new Set(["provider", "byModel"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export type DictationTargetResolution =
  | { kind: "openai" }
  | { kind: "custom"; providerName: string; provider: OcxProviderConfig }
  | { kind: "invalid"; target: string; error: string };

/**
 * Resolve one dictation target name against the configured providers.
 *
 * `"openai"` is the only reserved target and always means the built-in ChatGPT stream, even when
 * a provider happens to share the literal name. A registry-managed provider id is refused for the
 * same reason `images.provider` refuses one: built-ins do not carry a custom dictation endpoint.
 */
export function resolveDictationTarget(
  providers: Record<string, OcxProviderConfig> | undefined,
  target: string | undefined,
): DictationTargetResolution {
  const providerName = target ?? DICTATION_OPENAI_TARGET;
  if (providerName === DICTATION_OPENAI_TARGET) return { kind: "openai" };
  if (getProviderRegistryEntry(providerName)) {
    return {
      kind: "invalid",
      target: providerName,
      error: `dictation provider "${providerName}" must name a custom provider; "${DICTATION_OPENAI_TARGET}" selects ChatGPT dictation`,
    };
  }
  const provider = providers && Object.prototype.hasOwnProperty.call(providers, providerName)
    ? providers[providerName]
    : undefined;
  if (!provider) {
    return { kind: "invalid", target: providerName, error: `dictation provider "${providerName}" is not configured` };
  }
  return { kind: "custom", providerName, provider };
}

/**
 * A custom target must actually carry a usable endpoint. Mirrors `selectImagesProvider`'s
 * post-name checks: the name resolves, but the provider is not shaped for this relay.
 */
export function dictationProviderEndpointError(providerName: string, provider: OcxProviderConfig): string | null {
  const label = `dictation provider "${providerName}"`;
  if (typeof provider.dictationUrl !== "string" || provider.dictationUrl.trim() === "") {
    return `${label} has no dictation endpoint (set providers.${providerName}.dictationUrl)`;
  }
  if (provider.dictationHeaders !== undefined) {
    if (!isRecord(provider.dictationHeaders) || Object.values(provider.dictationHeaders).some(value => typeof value !== "string")) {
      return `${label} dictationHeaders must be an object of strings`;
    }
  }
  if (provider.dictationProtocols !== undefined) {
    if (!Array.isArray(provider.dictationProtocols) || !provider.dictationProtocols.every(protocol => typeof protocol === "string")) {
      return `${label} dictationProtocols must be an array of strings`;
    }
  }
  return null;
}

/** Resolve `${ENV_VAR}` references in configured handshake headers; drop unresolvable ones. */
export function resolveDictationHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    const envValue = resolveEnvValue(value);
    if (envValue !== undefined) resolved[name] = envValue;
  }
  return resolved;
}

/** Validate one `dictation` value against the providers it may reference. */
export function dictationConfigValueError(
  value: unknown,
  providers?: Record<string, OcxProviderConfig>,
): string | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) return "schema_invalid: dictation: must be an object";
  const unknown = Object.keys(value).find(key => !DICTATION_KEYS.has(key));
  if (unknown) return `schema_invalid: dictation.${unknown}: unknown key`;

  const targetError = (field: string, target: unknown): string | null => {
    if (target === undefined) return null;
    if (typeof target !== "string") return `schema_invalid: dictation.${field}: must be a string`;
    const resolution = resolveDictationTarget(providers, target);
    if (resolution.kind === "invalid") return `schema_invalid: dictation.${field}: ${resolution.error}`;
    if (resolution.kind === "custom") {
      const endpointError = dictationProviderEndpointError(resolution.providerName, resolution.provider);
      if (endpointError) return `schema_invalid: dictation.${field}: ${endpointError}`;
    }
    return null;
  };
  const providerError = targetError("provider", value.provider);
  if (providerError) return providerError;
  const byModel = value.byModel;
  if (byModel !== undefined) {
    if (!isRecord(byModel)) return "schema_invalid: dictation.byModel: must be an object";
    for (const [model, target] of Object.entries(byModel)) {
      const error = targetError(`byModel.${model}`, target);
      if (error) return error;
    }
  }
  return null;
}

/** Whole-config wrapper mirroring `visionReasoningError` in the CLI config command. */
export function dictationConfigError(value: unknown): string | null {
  if (!isRecord(value)) return null;
  return dictationConfigValueError(value.dictation, value.providers as Record<string, OcxProviderConfig> | undefined);
}
