/**
 * Identity of the two builtin Anthropic OAuth account-pool instances.
 *
 * This module has no imports on purpose: the provider registry and config types depend on it, and
 * `./anthropic-instance.ts` (which reads the registry) builds on top of it. Keep it that way, or the
 * registry and its lookup helper import each other.
 *
 * `anthropic` is the original pool. `anthropic2` is a second, independent pool that runs the same
 * Anthropic implementation with its own credentials, pool settings and runtime state. Exactly these two
 * IDs exist; a prefix such as `anthropic3` is never an instance.
 */
export const ANTHROPIC_INSTANCE_IDS = ["anthropic", "anthropic2"] as const;
export type AnthropicInstanceId = typeof ANTHROPIC_INSTANCE_IDS[number];

/** The canonical pool. Bare `claude-*` inference, Claude Code caller-forward and CLI import stay here. */
export const ANTHROPIC_PRIMARY_INSTANCE: AnthropicInstanceId = "anthropic";
/** The second, independent pool ("Anthropic · Pool 2"). Browser OAuth only. */
export const ANTHROPIC_POOL2_INSTANCE: AnthropicInstanceId = "anthropic2";

const ANTHROPIC_FIRST_PARTY_ORIGIN = "https://api.anthropic.com";

export function isAnthropicInstanceId(value: unknown): value is AnthropicInstanceId {
  return value === "anthropic" || value === "anthropic2";
}

/**
 * Whether a configured provider row may be treated as the builtin instance of that name.
 *
 * `anthropic` keeps its historical meaning: the row named `anthropic` is the instance. A row named
 * `anthropic2` may predate the builtin as a user's custom provider, so it is the builtin only when it is
 * an Anthropic OAuth row pointed at the first-party API (no `baseUrl` property, or exactly that origin).
 * Anything else keeps its custom meaning and is never pinned, enriched or routed as the builtin pool.
 */
export function anthropicInstanceRowShapeMatches(
  name: string,
  row: { adapter?: string; authMode?: string; baseUrl?: string } | undefined,
): boolean {
  if (name === "anthropic") return true;
  if (name !== "anthropic2" || !row) return false;
  if (row.adapter !== "anthropic" || row.authMode !== "oauth") return false;
  if (!Object.hasOwn(row, "baseUrl") || row.baseUrl === undefined) return true;
  return typeof row.baseUrl === "string" && row.baseUrl.trim().replace(/\/+$/, "") === ANTHROPIC_FIRST_PARTY_ORIGIN;
}
