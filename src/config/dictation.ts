/**
 * Boundary validation for the optional `dictation` block.
 *
 * `configSchema` is `.passthrough()`, like `images` and `visionSidecar`, so a malformed
 * `dictation` value is accepted at load and only the write boundaries (CLI `config set/import`,
 * management `PUT /api/dictation-settings`) can refuse it. This module is the single copy of
 * that policy so the two writers cannot drift.
 */
export const DICTATION_OPENAI_TARGET = "openai";

const DICTATION_KEYS = new Set(["default", "byModel", "providers"]);
const DICTATION_PROVIDER_KEYS = new Set(["url", "headers", "protocols"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function providerError(name: string, provider: unknown): string | null {
  const where = `dictation.providers.${name}`;
  if (!isRecord(provider)) return `schema_invalid: ${where}: must be an object`;
  const unknown = Object.keys(provider).find(key => !DICTATION_PROVIDER_KEYS.has(key));
  if (unknown) return `schema_invalid: ${where}.${unknown}: unknown key`;
  if (typeof provider.url !== "string" || provider.url.trim() === "") {
    return `schema_invalid: ${where}.url: must be a non-empty string`;
  }
  if (provider.headers !== undefined) {
    if (!isRecord(provider.headers)) return `schema_invalid: ${where}.headers: must be an object`;
    for (const [header, value] of Object.entries(provider.headers)) {
      if (typeof value !== "string") return `schema_invalid: ${where}.headers.${header}: must be a string`;
    }
  }
  if (provider.protocols !== undefined) {
    if (!Array.isArray(provider.protocols) || !provider.protocols.every(protocol => typeof protocol === "string")) {
      return `schema_invalid: ${where}.protocols: must be an array of strings`;
    }
  }
  return null;
}

/** Validate one `dictation` value. Returns a message, or null when acceptable. */
export function dictationConfigValueError(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) return "schema_invalid: dictation: must be an object";
  const unknown = Object.keys(value).find(key => !DICTATION_KEYS.has(key));
  if (unknown) return `schema_invalid: dictation.${unknown}: unknown key`;

  const providers = value.providers;
  if (providers !== undefined) {
    if (!isRecord(providers)) return "schema_invalid: dictation.providers: must be an object";
    for (const [name, provider] of Object.entries(providers)) {
      const error = providerError(name, provider);
      if (error) return error;
    }
  }
  const providerNames = new Set(isRecord(providers) ? Object.keys(providers) : []);
  // "openai" is the only reserved target: it always names the existing ChatGPT stream and
  // never a user provider, even if someone defines a provider literally called "openai".
  const targetError = (field: string, target: unknown): string | null => {
    if (target === undefined) return null;
    if (typeof target !== "string") return `schema_invalid: dictation.${field}: must be a string`;
    if (target === DICTATION_OPENAI_TARGET) return null;
    if (!providerNames.has(target)) {
      return `schema_invalid: dictation.${field}: "${target}" is not a configured provider (expected "${DICTATION_OPENAI_TARGET}" or a key in dictation.providers)`;
    }
    return null;
  };
  const defaultError = targetError("default", value.default);
  if (defaultError) return defaultError;
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
  return dictationConfigValueError(value.dictation);
}
