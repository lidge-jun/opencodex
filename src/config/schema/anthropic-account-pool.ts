import * as z from "zod/v4";
import { parseAnthropicModelRoutes } from "../../oauth/anthropic-model-routes";
import { isAnthropicInstanceId } from "../../providers/anthropic-instance-id";
import { redactSecretString } from "../../lib/redact";

/** Historical A load contract, shared verbatim with B: recover only the native preference. */
export const anthropicAccountPoolSchema = z.object({
  nativeMessages: z.boolean().optional().catch(false),
}).passthrough().optional().catch(undefined);

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Write/diagnostic contract preserves A's historical nativeMessages and route validation. */
function poolError(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  const pool = record(value);
  if (!pool) return `schema_invalid: ${path}: must be an object`;
  if (Object.hasOwn(pool, "nativeMessages") && typeof pool.nativeMessages !== "boolean") {
    return `schema_invalid: ${path}.nativeMessages: must be a boolean`;
  }
  if (pool.routes !== undefined) {
    const parsed = parseAnthropicModelRoutes(pool.routes);
    if (!parsed.ok) return `schema_invalid: ${path}.routes: ${parsed.error}`;
  }
  return undefined;
}

/** Inspect raw locations before the tolerant load schema can discard a malformed field. */
export function anthropicAccountPoolConfigError(value: unknown): string | undefined {
  const config = record(value);
  const primaryError = poolError(config?.anthropicAccountPool, "anthropicAccountPool");
  if (primaryError) return primaryError;
  for (const [name, raw] of Object.entries(record(config?.providers) ?? {})) {
    const provider = record(raw);
    if (!provider || !Object.hasOwn(provider, "anthropicAccountPool")) continue;
    const path = `providers.${redactSecretString(name)}.anthropicAccountPool`;
    if (name !== "anthropic2") {
      return `schema_invalid: ${path}: misplaced field; provider-local anthropicAccountPool is valid only on anthropic2 (anthropic uses the top-level field)`;
    }
    const error = poolError(provider.anthropicAccountPool, path);
    if (error) return error;
  }
  return undefined;
}

/** Raw provenance validation runs before tolerant parsing and never adopts or edits a row. */
export function anthropicOAuthInstanceConfigError(value: unknown): string | undefined {
  const seen = new WeakSet<object>();
  const inspect = (raw: unknown, location: string[]): string | undefined => {
    if (!raw || typeof raw !== "object" || seen.has(raw)) return undefined;
    seen.add(raw);
    for (const [field, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(raw))) {
      const path = [...location, field];
      if (field === "anthropicOAuthInstance") {
        const label = redactSecretString(path.join("."));
        if (!("value" in descriptor)) return `schema_invalid: ${label}: must be an own data property`;
        if (location.length !== 2 || location[0] !== "providers" || location[1] !== "anthropic2") {
          return `schema_invalid: ${label}: misplaced field; valid only on providers.anthropic2`;
        }
        if (descriptor.value !== "anthropic2") return `schema_invalid: ${label}: must be anthropic2`;
        const row = Object.getOwnPropertyDescriptors(raw);
        if (row.adapter?.value !== "anthropic" || row.authMode?.value !== "oauth") {
          return `schema_invalid: ${label}: requires Anthropic adapter and OAuth authMode`;
        }
      }
      if (!("value" in descriptor)) continue;
      const error = inspect(descriptor.value, path);
      if (error) return error;
    }
    seen.delete(raw);
    return undefined;
  };
  return inspect(value, []);
}

/** Validate explicit helper identity without materializing an absent instance preference. */
export function anthropicSidecarConfigError(value: unknown): string | undefined {
  const config = record(value);
  const claude = record(config?.claudeCode);
  for (const [prefix, owner] of [["", config], ["claudeCode.", claude]] as const) {
    for (const field of ["webSearchSidecar", "visionSidecar"] as const) {
      const rawSidecar = record(owner?.[field]);
      if (!rawSidecar) continue;
      // Claude overrides inherit individual global fields, just like buildClaudeReplayConfig.
      const sidecar = prefix ? { ...record(config?.[field]), ...rawSidecar } : rawSidecar;
      if (!Object.hasOwn(sidecar, "anthropicInstance")) continue;
      const path = `${prefix}${field}.anthropicInstance`;
      if (!isAnthropicInstanceId(sidecar.anthropicInstance)) {
        return `schema_invalid: ${path}: must be anthropic or anthropic2`;
      }
      // Web search defaults to OpenAI; vision's absent backend keeps its credential-based auto mode.
      const backend = sidecar.backend === undefined
        ? (field === "webSearchSidecar" ? "openai" : undefined) : sidecar.backend;
      // An instance inherited from the global block is inert once the override's effective backend
      // leaves Anthropic (the helper resolver only reads it for the Anthropic family), so it is not
      // a conflict. An instance the override sets itself is still validated in full.
      if (prefix && !Object.hasOwn(rawSidecar, "anthropicInstance") && backend !== undefined && backend !== "anthropic") continue;
      const modelProvider = typeof sidecar.model === "string" && sidecar.model.includes("/")
        ? sidecar.model.slice(0, sidecar.model.indexOf("/")) : undefined;
      if (modelProvider && isAnthropicInstanceId(modelProvider) && modelProvider !== sidecar.anthropicInstance) {
        return `schema_invalid: ${path}: conflicts with the model's Anthropic instance`;
      }
      if (backend !== undefined && backend !== "anthropic") {
        return `schema_invalid: ${path}: requires an anthropic backend`;
      }
    }
  }
  return undefined;
}

/** Validate the effective settings before either management route mutates live state. */
export function anthropicSidecarPatchError(
  config: unknown,
  patches: Record<string, unknown>,
  claude = false,
): string | undefined {
  const source = record(config) ?? {};
  const next = { ...source };
  const owner = claude ? { ...record(source.claudeCode) } : next;
  for (const field of ["webSearchSidecar", "visionSidecar"] as const) {
    if (!Object.hasOwn(patches, field)) continue;
    const patch = patches[field];
    if (patch === null) { delete owner[field]; continue; }
    const section = record(patch);
    if (!section) continue; // Shape validation belongs to the route.
    if (section.anthropicInstance !== undefined && section.anthropicInstance !== null
      && !isAnthropicInstanceId(section.anthropicInstance)) {
      return `${field}.anthropicInstance must be anthropic, anthropic2, or null`;
    }
    const settings = { ...record(owner[field]) };
    for (const key of ["backend", "model", "anthropicInstance"] as const) {
      if (section[key] === null || (key === "model" && section[key] === "")) delete settings[key];
      else if (section[key] !== undefined) settings[key] = section[key];
    }
    if (claude && (Object.keys(section).length === 0 || Object.keys(settings).length === 0)) delete owner[field];
    else owner[field] = settings;
  }
  if (claude) next.claudeCode = owner;
  return anthropicSidecarConfigError(next);
}
