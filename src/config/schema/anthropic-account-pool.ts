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
      if (backend !== undefined && backend !== "anthropic") {
        return `schema_invalid: ${path}: requires an anthropic backend`;
      }
    }
  }
  return undefined;
}
