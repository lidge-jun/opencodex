/**
 * Claude Desktop picker candidates use the gateway's profile order and labels, while
 * publishing aliases that the first-party Messages ingress can resolve.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { nativeOpenAiContextWindow, type NativeContextLimitsInput } from "../../codex/catalog";
import type { OcxClaudeDesktopProfile } from "../../types";
import { aliasForRoute, claudeCodeNativeAlias } from "../alias";
import { AUTO_CONTEXT_OFF, stripOneMillionMarker, UNPAIRED_AUTO_CONTEXT, withOneMillionMarker } from "../context-windows";
import { isAnthropicClaudeRoute } from "../long-context";
import { activeDesktop3pAlias, displayModelId, resolveDesktop3pAlias, type Desktop3pRoutedModel } from "../desktop-3p";
import { reconcileDesktopProfile, renderDesktopProfile, type DesktopProfileModel } from "../desktop-profile";
import type { PickerModelEntry } from "./picker-bootstrap";

export interface PickerRouteInput {
  nativeSlugs: string[];
  routedModels: Desktop3pRoutedModel[];
  profile?: OcxClaudeDesktopProfile;
  nativeContextCap?: NativeContextLimitsInput;
}

/** Candidate routes in the gateway profile's order and with its labels. */
function renderPickerCandidates(input: PickerRouteInput): DesktopProfileModel[] {
  const candidates: DesktopProfileModel[] = [
    ...input.nativeSlugs.map(id => {
      const contextWindow = nativeOpenAiContextWindow(id, input.nativeContextCap);
      return {
        route: `native/${id}`,
        label: `${displayModelId(id)} (native)`,
        ...(contextWindow === undefined ? {} : { contextWindow }),
      };
    }),
    ...input.routedModels.map(({ provider, id, contextWindow }) => ({
      route: `${provider}/${id}`,
      label: `${displayModelId(id)} (${provider})`,
      ...(contextWindow === undefined ? {} : { contextWindow }),
    })),
  ];
  return input.profile
    ? renderDesktopProfile(reconcileDesktopProfile(input.profile, candidates), candidates)
    : candidates;
}

function splitRoute(route: string): { provider: string; id: string } {
  const slash = route.indexOf("/");
  return { provider: route.slice(0, slash), id: route.slice(slash + 1) };
}

/**
 * Desktop runners do not inherit the proxy's compaction env, so a long window (>= the default
 * compact window) is marked on the strength of the `prompt is too long` recovery instead
 * (devlog/_plan/261009_claude_1m_default/020). Real Anthropic models need a genuine 1M.
 */
function pickerSelector(alias: string, contextWindow: number | undefined, provider: string, id: string): string {
  const mode = isAnthropicClaudeRoute(provider, id) ? AUTO_CONTEXT_OFF : UNPAIRED_AUTO_CONTEXT;
  return withOneMillionMarker(alias, contextWindow === undefined ? {} : { [alias]: contextWindow }, mode)!;
}

export function buildPickerModels(input: PickerRouteInput): PickerModelEntry[] {
  const rendered = renderPickerCandidates(input);
  const out: PickerModelEntry[] = [];
  const seen = new Set<string>();
  for (const model of rendered) {
    const { provider, id } = splitRoute(model.route);
    if (provider === "anthropic" && id.startsWith("claude-")) continue;
    const alias = provider === "native" ? claudeCodeNativeAlias(id) : aliasForRoute(provider, id);
    if (!alias || seen.has(alias)) continue;
    seen.add(alias);
    out.push({ id: pickerSelector(alias, model.contextWindow, provider, id), name: model.label,
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }) });
  }
  return out;
}

/**
 * Rows for the Claude Code CLI's `cc` catalog. The CLI only offers Claude-shaped ids, so each route
 * uses its Desktop 3P registry alias, and only one the registry decodes back to the same route: an
 * id the router cannot resolve is never advertised. Real Anthropic rows are already in the catalog.
 */
export function buildCliPickerModels(input: PickerRouteInput): PickerModelEntry[] {
  const out: PickerModelEntry[] = [];
  const seen = new Set<string>();
  for (const model of renderPickerCandidates(input)) {
    const { provider, id } = splitRoute(model.route);
    if (provider === "anthropic" && id.startsWith("claude-")) continue;
    const alias = activeDesktop3pAlias(provider, id);
    if (seen.has(alias) || resolveDesktop3pAlias(alias) !== model.route) continue;
    seen.add(alias);
    out.push({ id: pickerSelector(alias, model.contextWindow, provider, id), name: model.label,
      description: `opencodex · ${model.route}`, route: model.route,
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }) });
  }
  return out;
}

/** Rows whose alias still decodes to the route it was minted for: the registry can be rebuilt after a snapshot was taken. */
export function routableCliPickerModels(models: readonly PickerModelEntry[]): PickerModelEntry[] {
  return models.filter(model => model.route !== undefined
    && resolveDesktop3pAlias(stripOneMillionMarker(model.id)) === model.route);
}

export interface PickerModelSnapshot {
  current(): { models: PickerModelEntry[]; builtAt: number } | null;
  refresh(): Promise<void>;
  refreshIfStale(maxAgeMs: number): void;
}

function parseSnapshot(value: unknown): { models: PickerModelEntry[]; builtAt: number } | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { models?: unknown; builtAt?: unknown };
  if (typeof candidate.builtAt !== "number" || !Number.isFinite(candidate.builtAt) || !Array.isArray(candidate.models)) return null;
  if (!candidate.models.every(model => model && typeof model === "object"
    && typeof model.id === "string" && typeof model.name === "string"
    && (model.contextWindow === undefined || typeof model.contextWindow === "number")
    && (model.description === undefined || typeof model.description === "string")
    && (model.route === undefined || typeof model.route === "string"))) return null;
  return { models: candidate.models as PickerModelEntry[], builtAt: candidate.builtAt };
}

export function createPickerModelSnapshot(
  load: () => Promise<PickerRouteInput>,
  persistPath?: string,
  build: (input: PickerRouteInput) => PickerModelEntry[] = buildPickerModels,
): PickerModelSnapshot {
  let snapshot: { models: PickerModelEntry[]; builtAt: number } | null = null;
  if (persistPath) {
    try { snapshot = parseSnapshot(JSON.parse(readFileSync(persistPath, "utf8")) as unknown); } catch { /* No usable prior snapshot. */ }
  }
  let pending: Promise<void> | null = null;
  const refresh = (): Promise<void> => {
    if (pending) return pending;
    pending = (async () => {
      try {
        const models = build(await load());
        const next = { models, builtAt: Date.now() };
        if (persistPath) {
          mkdirSync(dirname(persistPath), { recursive: true, mode: 0o700 });
          writeFileSync(persistPath, JSON.stringify(next), { encoding: "utf8", mode: 0o600 });
          chmodSync(persistPath, 0o600);
        }
        snapshot = next;
      } catch { /* Keep the last good snapshot when discovery or persistence fails. */ }
    })().finally(() => { pending = null; });
    return pending;
  };
  return {
    current: () => snapshot,
    refresh,
    refreshIfStale(maxAgeMs) {
      if (!pending && (!snapshot || Date.now() - snapshot.builtAt >= maxAgeMs)) void refresh();
    },
  };
}
