/**
 * Claude Desktop picker candidates use the gateway's profile order and labels, while
 * publishing aliases that the first-party Messages ingress can resolve.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { nativeOpenAiContextWindow, type NativeContextLimitsInput } from "../../codex/catalog";
import type { OcxClaudeDesktopProfile } from "../../types";
import { aliasForRoute, claudeCodeNativeAlias } from "../alias";
import { displayModelId, type Desktop3pRoutedModel } from "../desktop-3p";
import { reconcileDesktopProfile, renderDesktopProfile, type DesktopProfileModel } from "../desktop-profile";
import type { PickerModelEntry } from "./picker-bootstrap";

export interface PickerRouteInput {
  nativeSlugs: string[];
  routedModels: Desktop3pRoutedModel[];
  profile?: OcxClaudeDesktopProfile;
  nativeContextCap?: NativeContextLimitsInput;
}

export function buildPickerModels(input: PickerRouteInput): PickerModelEntry[] {
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
  const rendered = input.profile
    ? renderDesktopProfile(reconcileDesktopProfile(input.profile, candidates), candidates)
    : candidates;
  const out: PickerModelEntry[] = [];
  const seen = new Set<string>();
  for (const model of rendered) {
    const slash = model.route.indexOf("/");
    const provider = model.route.slice(0, slash);
    const id = model.route.slice(slash + 1);
    if (provider === "anthropic" && id.startsWith("claude-")) continue;
    const alias = provider === "native" ? claudeCodeNativeAlias(id) : aliasForRoute(provider, id);
    if (!alias || seen.has(alias)) continue;
    seen.add(alias);
    out.push({ id: alias, name: model.label,
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }) });
  }
  return out;
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
    && (model.contextWindow === undefined || typeof model.contextWindow === "number"))) return null;
  return { models: candidate.models as PickerModelEntry[], builtAt: candidate.builtAt };
}

export function createPickerModelSnapshot(load: () => Promise<PickerRouteInput>, persistPath?: string): PickerModelSnapshot {
  let snapshot: { models: PickerModelEntry[]; builtAt: number } | null = null;
  if (persistPath) {
    try { snapshot = parseSnapshot(JSON.parse(readFileSync(persistPath, "utf8")) as unknown); } catch { /* No usable prior snapshot. */ }
  }
  let pending: Promise<void> | null = null;
  const refresh = (): Promise<void> => {
    if (pending) return pending;
    pending = (async () => {
      try {
        const models = buildPickerModels(await load());
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
