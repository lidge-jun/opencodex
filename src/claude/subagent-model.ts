import type { OcxConfig } from "../types";
import { claudeCodeAlias, claudeCodeNativeAlias, resolveAlias } from "./alias";
import { AUTO_CONTEXT_OFF, shouldMarkOneMillion, stripOneMillionMarker, withOneMillionMarker } from "./context-windows";
import { hasOwnProvider } from "../config";
import { knownModelIdsForProvider } from "../router";
import { decodeRoutedModelIdOrThrow } from "../providers/slug-codec";
import { SAFE_AGENT_MODEL_ID } from "../config/subagent-models";
import { resolveDesktop3pAlias } from "./desktop-3p";
export { SAFE_AGENT_MODEL_ID } from "../config/subagent-models";

/** Roster entry -> alias + display parts. Entries are bare native slugs or "provider/id".
 * Codex-facing encoded ids (`provider/vendor-model`) decode to the native slash id first
 * so the alias joins the raw-native context-window map (context-windows.ts). */

/**
 * Generated subagent defs cannot rely on the parent's auto-context compaction
 * pairing, so their [1m] marker follows the AUTHORITATIVE window only: mark when
 * the effective window (exact selector, then the canonical [1m] form, then bare)
 * is genuinely >= 1M; strip an inherited unsafe marker back to the bare selector;
 * with no window information, keep the selector as it was. Genuine routed [1m]
 * ids are preserved through the canonical-exact lookup. (#854)
 */
export function withSubagentContextMarker(selector: string, windows: Record<string, number>): string {
  const bare = stripOneMillionMarker(selector);
  const wasMarked = selector !== bare;
  const canonicalExact = wasMarked ? `${bare}[1m]` : selector;
  const authoritativeWindow = windows[selector] ?? windows[canonicalExact] ?? windows[bare];
  if (typeof authoritativeWindow === "number" && authoritativeWindow > 0) {
    return shouldMarkOneMillion(authoritativeWindow, AUTO_CONTEXT_OFF)
      ? (withOneMillionMarker(selector, windows) ?? selector)
      : bare;
  }
  return wasMarked ? selector : bare;
}
export function entryParts(entry: string, config: OcxConfig): { alias: string; id: string; provider: string } {
  const slash = entry.indexOf("/");
  if (slash > 0) {
    const provider = entry.slice(0, slash);
    const prov = hasOwnProvider(config.providers, provider) ? config.providers[provider] : undefined;
    const id = prov
      ? decodeRoutedModelIdOrThrow(entry.slice(slash + 1), knownModelIdsForProvider(provider, prov, config))
      : entry.slice(slash + 1);
    return { alias: claudeCodeAlias(provider, id), id, provider };
  }
  return { alias: claudeCodeNativeAlias(entry), id: entry, provider: "native" };
}

export type SubagentForceExposure = { entries: readonly string[] } | { selectors: readonly string[] };

function fullSelectorIdentity(selector: string): string {
  const route = resolveAlias(selector) ?? resolveDesktop3pAlias(selector) ?? selector;
  return (route.startsWith("native/") ? route.slice("native/".length) : route).replace(/\[1m\]$/i, "[1m]");
}

function selectorIdentity(selector: string): string {
  return fullSelectorIdentity(stripOneMillionMarker(selector));
}

/** Resolve only currently exposed entries; retained roster rows are not exposure proof. */
export function resolveSubagentForceModel(config: OcxConfig, windows: Record<string, number>, available: SubagentForceExposure): string | null {
  const entry = config.claudeCode?.subagentModelForce;
  if (typeof entry !== "string" || !SAFE_AGENT_MODEL_ID.test(entry)) return null;
  try {
    const parts = entryParts(entry, config);
    if ((config.disabledModels ?? []).some(disabled => {
      try { return selectorIdentity(entryParts(disabled, config).alias) === selectorIdentity(parts.alias); } catch { return false; }
    })) return null;
    const selectors = "selectors" in available ? available.selectors : available.entries.flatMap(candidate => {
      try { return [entryParts(candidate, config).alias]; } catch { return []; }
    });
    const exposed = selectors.some(candidate => selectorIdentity(candidate) === selectorIdentity(parts.alias));
    if (!exposed) return null;
    const bare = stripOneMillionMarker(parts.alias);
    const requestedMarker = bare !== parts.alias;
    const exactMarkedExposure = requestedMarker && selectors.some(candidate =>
      fullSelectorIdentity(candidate) === fullSelectorIdentity(parts.alias));
    const window = windows[parts.alias] ?? windows[`${bare}[1m]`] ?? windows[bare];
    // Identity admission must not let an appended context promise ride on an
    // ordinary exposed model. Exact catalog ids such as kimi/k3[1m] remain literal.
    if (requestedMarker && !exactMarkedExposure && !(typeof window === "number" && Number.isFinite(window) && window >= 1_000_000)) return null;
    const marked = exactMarkedExposure ? parts.alias : withSubagentContextMarker(parts.alias, windows);
    // Bare Anthropic names are indistinguishable from the old CLI's fallback.
    // Encode only the force selector; handlers restore native identity before
    // their existing credential/model-map checks. Roster generation is unchanged.
    if (parts.alias.startsWith("claude-") && !resolveAlias(parts.alias) && !resolveDesktop3pAlias(parts.alias)) {
      const native = claudeCodeNativeAlias(stripOneMillionMarker(marked));
      return marked === stripOneMillionMarker(marked) ? native : `${native}[1m]`;
    }
    return marked;
  } catch {
    return null;
  }
}
