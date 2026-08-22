import type { ModelRow } from "./models-shared";

export type FrontierRouteShortcutId = "xai-grok" | "cursor-grok" | "opus-5" | "fable-5";

export interface FrontierRouteShortcut {
  id: FrontierRouteShortcutId;
  provider: string;
  query: string;
  route: string | null;
  providerConfigured: boolean;
}

interface ShortcutDefinition {
  id: FrontierRouteShortcutId;
  providers: readonly string[];
  query: string;
  matches: (model: ModelRow) => boolean;
}

const SHORTCUTS: readonly ShortcutDefinition[] = [
  {
    id: "xai-grok",
    providers: ["xai"],
    query: "grok-",
    matches: model => model.provider === "xai" && /^grok-\d/.test(model.id),
  },
  {
    id: "cursor-grok",
    providers: ["cursor"],
    query: "grok-",
    matches: model => model.provider === "cursor" && /^grok-\d/.test(model.id),
  },
  {
    id: "opus-5",
    providers: ["anthropic", "cursor", "kiro"],
    query: "claude-opus-5",
    matches: model => model.id === "claude-opus-5",
  },
  {
    id: "fable-5",
    providers: ["anthropic", "cursor", "kiro"],
    query: "claude-fable-5",
    matches: model => model.id === "claude-fable-5",
  },
] as const;

function compareCandidates(
  providers: readonly string[],
  left: ModelRow,
  right: ModelRow,
): number {
  const providerOrder = providers.indexOf(left.provider) - providers.indexOf(right.provider);
  if (providerOrder !== 0) return providerOrder;
  const leftFast = left.id.endsWith("-fast");
  const rightFast = right.id.endsWith("-fast");
  if (leftFast !== rightFast) return leftFast ? 1 : -1;
  return right.id.localeCompare(left.id, undefined, { numeric: true, sensitivity: "base" });
}

/**
 * Resolve the four focused frontend shortcuts against the catalog that is actually loaded.
 * Provider preference is deterministic, but never hides an available Cursor/Kiro Claude route
 * merely because the direct Anthropic provider is absent.
 */
export function buildFrontierRouteShortcuts(
  models: readonly ModelRow[],
  configuredProviders: ReadonlySet<string>,
): FrontierRouteShortcut[] {
  return SHORTCUTS.map(definition => {
    const candidates = models
      .filter(definition.matches)
      .filter(model => definition.providers.includes(model.provider))
      .toSorted((left, right) => compareCandidates(definition.providers, left, right));
    const candidate = candidates[0];
    const provider = candidate?.provider
      ?? definition.providers.find(configured => configuredProviders.has(configured))
      ?? definition.providers[0];

    return {
      id: definition.id,
      provider,
      query: definition.query,
      route: candidate?.namespaced ?? null,
      providerConfigured: configuredProviders.has(provider),
    };
  });
}
