/**
 * Provider ids that were renamed and still have to resolve.
 *
 * `claude-cli` shipped in 2.65.0 and became `claude-agent-sdk` on 2026-09-24, when the row moved from
 * a hand-built `claude -p` turn onto Anthropic's Claude Agent SDK. Saved rows and references are
 * rewritten by `claude-provider-rename-migration`, but three paths read an id before or outside that
 * pass: a config read that happens first, `ocx provider test claude-cli` typed by hand, and any row
 * the projection refused to move because the destination was taken. Same shape as
 * `DEPRECATED_OAUTH_PROVIDER_ALIASES` in `src/oauth/index.ts`, and deliberately not a second registry
 * row: one row per mechanism is what the registry means.
 *
 * It sits beside `./registry` rather than inside it because that file runs at its size cap, and this
 * table is a self-contained lookup with two consumers: `getProviderRegistryEntry` for the provider
 * id, and `getAdapterDefinition` (`../adapters/registry`) for the adapter string a saved row
 * still carries after a refused projection.
 */
export const DEPRECATED_PROVIDER_ALIASES: Readonly<Record<string, string>> = {
  "claude-cli": "claude-agent-sdk",
};

export function resolveDeprecatedProviderId(id: string): string {
  return DEPRECATED_PROVIDER_ALIASES[id] ?? id;
}
