/**
 * In-memory provider drafts, scoped to the dashboard server target that owns them.
 *
 * The Providers page can be pointed at another dashboard server while it stays mounted
 * (`apiBase` changes after target discovery). A provider name is only unique within one
 * server, so a draft keyed by name alone can either be reset by the next server's config
 * or be submitted through that server's save callback. Every entry here carries the
 * target it was started on, and the baseline (saved values) it was derived from, so a
 * returning target can restore the draft or report that its saved values moved.
 *
 * This store is deliberately memory-only. Provider settings can include an API key in a
 * future field, and a browser-persisted draft would outlive the tab and the server it was
 * written for. Nothing here touches localStorage or sessionStorage.
 */
import { canConfigureResponsesReasoningReplay } from "../responses-reasoning-replay";
import { isCatalogProviderId } from "../provider-icons";
import { isVertexProvider, providerSupportsLiveModelDiscovery, type WorkspaceItem } from "./catalog";
import type { ProviderUpdatePatch } from "../components/provider-workspace/types";

export type ProviderSettingsPacingRule = {
  requestsPerMinute?: number;
  minIntervalMs?: number;
  maxConcurrentRequests?: number;
};

export type ProviderSettingsKeyPacing = {
  keySelection?: "active" | "round-robin";
  keys?: ProviderSettingsPacingRule;
};

/** Every editable field of the Settings tab, including raw numeric text as typed. */
export interface ProviderSettingsDraft {
  adapter: string;
  baseUrl: string;
  project: string;
  location: string;
  defaultModel: string;
  authMode: string;
  apiKeyTransport: "x-api-key" | "bearer";
  note: string;
  allowPrivateNetwork: boolean;
  preserveReasoningReplay: boolean;
  liveModels: boolean;
  cursorHttpVersion: "http2" | "http1.1";
  pacingEnabled: boolean;
  keyPacing: ProviderSettingsKeyPacing;
  pacingRpm: string;
  pacingDelay: string;
  pacingConcurrency: string;
  pacingModels: Record<string, ProviderSettingsPacingRule>;
}

export interface ProviderSettingsDraftEntry {
  draft: ProviderSettingsDraft;
  /** Saved values the draft was derived from; a later saved change is a conflict. */
  baseline: ProviderSettingsDraft;
  /** The mounted form instance that currently owns this entry. */
  owner?: symbol;
}

export interface ProviderDraftStore {
  read(target: string, provider: string): ProviderSettingsDraftEntry | undefined;
  write(target: string, provider: string, entry: ProviderSettingsDraftEntry): void;
  clear(target: string, provider: string): void;
  /** Claim the entry for one mounted form; a newer mount supersedes an older one. */
  claim(target: string, provider: string, owner: symbol, initial: ProviderSettingsDraftEntry): ProviderSettingsDraftEntry;
  /** Write only while this owner still owns the entry; stale completions return false. */
  writeOwned(target: string, provider: string, owner: symbol, entry: ProviderSettingsDraftEntry): boolean;
  clearOwned(target: string, provider: string, owner: symbol): boolean;
}

export function createProviderDraftStore(): ProviderDraftStore {
  const entries = new Map<string, ProviderSettingsDraftEntry>();
  const key = (target: string, provider: string) => `${target}\u0000${provider}`;
  return {
    read: (target, provider) => entries.get(key(target, provider)),
    write: (target, provider, entry) => { entries.set(key(target, provider), entry); },
    clear: (target, provider) => { entries.delete(key(target, provider)); },
    claim: (target, provider, owner, initial) => {
      const existing = entries.get(key(target, provider));
      const next = existing ? { ...existing, owner } : { ...initial, owner };
      entries.set(key(target, provider), next);
      return next;
    },
    writeOwned: (target, provider, owner, entry) => {
      const existing = entries.get(key(target, provider));
      if (!existing || existing.owner !== owner) return false;
      entries.set(key(target, provider), { ...entry, owner });
      return true;
    },
    clearOwned: (target, provider, owner) => {
      const existing = entries.get(key(target, provider));
      if (!existing || existing.owner !== owner) return false;
      entries.delete(key(target, provider));
      return true;
    },
  };
}

export function effectiveCursorHttpVersion(value: WorkspaceItem["upstreamHttpVersion"]): "http2" | "http1.1" {
  return value === "http1.1" || value === "h1" ? "http1.1" : "http2";
}

export function positiveRpm(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 / 60 ? parsed : undefined;
}

export function positiveInteger(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function numberDraft(value: number | undefined): string {
  return value === undefined ? "" : String(value);
}

/** The pacing object the Settings form would save for this draft. */
export function draftRequestPacing(draft: ProviderSettingsDraft): NonNullable<WorkspaceItem["requestPacing"]> {
  const rpm = positiveRpm(draft.pacingRpm);
  const delay = positiveInteger(draft.pacingDelay);
  const concurrency = positiveInteger(draft.pacingConcurrency);
  return {
    enabled: draft.pacingEnabled,
    ...draft.keyPacing,
    ...(rpm !== undefined ? { requestsPerMinute: rpm } : {}),
    ...(delay !== undefined ? { minIntervalMs: delay } : {}),
    ...(concurrency !== undefined ? { maxConcurrentRequests: concurrency } : {}),
    ...(Object.keys(draft.pacingModels).length > 0 ? { models: draft.pacingModels } : {}),
  };
}

/** Stable comparison for pacing objects; model and key order never changes the answer. */
export function pacingSignature(value: WorkspaceItem["requestPacing"] | undefined): string {
  const models = Object.entries(value?.models ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([model, rule]) => [model, rule.requestsPerMinute ?? null, rule.minIntervalMs ?? null, rule.maxConcurrentRequests ?? null]);
  return JSON.stringify([
    value?.enabled === true,
    value?.requestsPerMinute ?? null,
    value?.minIntervalMs ?? null,
    value?.maxConcurrentRequests ?? null,
    value?.keySelection ?? "active",
    [value?.keys?.requestsPerMinute ?? null, value?.keys?.minIntervalMs ?? null, value?.keys?.maxConcurrentRequests ?? null],
    models,
  ]);
}

export function providerSettingsDraftFromItem(item: WorkspaceItem): ProviderSettingsDraft {
  const liveModelDiscoverySupported = providerSupportsLiveModelDiscovery(item.name, item);
  return {
    adapter: item.adapter,
    baseUrl: item.baseUrl,
    project: item.project ?? "",
    location: item.location ?? "",
    defaultModel: item.defaultModel ?? "",
    authMode: String(item.authMode ?? (item.keyOptional ? "local" : "key")),
    apiKeyTransport: item.apiKeyTransport ?? "x-api-key",
    note: item.note ?? "",
    allowPrivateNetwork: item.allowPrivateNetwork ?? false,
    preserveReasoningReplay: item.preserveResponsesReasoningContent === true,
    liveModels: liveModelDiscoverySupported ? item.liveModels !== false : false,
    cursorHttpVersion: effectiveCursorHttpVersion(item.upstreamHttpVersion),
    pacingEnabled: item.requestPacing?.enabled === true,
    keyPacing: {
      ...(item.requestPacing?.keySelection !== undefined ? { keySelection: item.requestPacing.keySelection } : {}),
      ...(item.requestPacing?.keys !== undefined ? { keys: { ...item.requestPacing.keys } } : {}),
    },
    pacingRpm: numberDraft(item.requestPacing?.requestsPerMinute),
    pacingDelay: numberDraft(item.requestPacing?.minIntervalMs),
    pacingConcurrency: numberDraft(item.requestPacing?.maxConcurrentRequests),
    pacingModels: Object.fromEntries(Object.entries(item.requestPacing?.models ?? {}).map(([model, rule]) => [model, { ...rule }])),
  };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort()
      .map(key => [key, stableValue((value as Record<string, unknown>)[key])]));
  }
  return value;
}

export function providerSettingsDraftSignature(draft: ProviderSettingsDraft): string {
  return JSON.stringify(stableValue(draft));
}

export function providerSettingsValueSignature(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

/**
 * Merge pacing field-by-field. The user's changed subfields win; untouched subfields take
 * the latest saved value. Different models and key rules merge independently.
 */
export function mergeProviderPacing(
  baseline: ProviderSettingsDraft,
  draft: ProviderSettingsDraft,
  latest: WorkspaceItem["requestPacing"],
): NonNullable<WorkspaceItem["requestPacing"]> {
  const base = draftRequestPacing(baseline);
  const next = draftRequestPacing(draft);
  const merged = structuredClone(latest ?? { enabled: false });
  const take = <K extends keyof NonNullable<WorkspaceItem["requestPacing"]>>(key: K) => {
    if (providerSettingsValueSignature(next[key]) === providerSettingsValueSignature(base[key])) return;
    if (next[key] === undefined) delete merged[key];
    else (merged as Record<string, unknown>)[key] = next[key];
  };
  for (const key of ["enabled", "requestsPerMinute", "minIntervalMs", "maxConcurrentRequests", "keySelection"] as const) take(key);

  const mergeRule = (
    baseRule: ProviderSettingsPacingRule | undefined,
    nextRule: ProviderSettingsPacingRule | undefined,
    latestRule: ProviderSettingsPacingRule | undefined,
  ): ProviderSettingsPacingRule | undefined => {
    if (!nextRule && !baseRule) return latestRule;
    if (!nextRule) return undefined;
    const out = { ...(latestRule ?? {}) };
    for (const field of ["requestsPerMinute", "minIntervalMs", "maxConcurrentRequests"] as const) {
      if (nextRule[field] === baseRule?.[field]) continue;
      if (nextRule[field] === undefined) delete out[field];
      else out[field] = nextRule[field];
    }
    return Object.keys(out).length > 0 ? out : undefined;
  };
  const keys = mergeRule(base.keys, next.keys, merged.keys);
  if (keys) merged.keys = keys; else delete merged.keys;

  const modelNames = new Set([
    ...Object.keys(base.models ?? {}),
    ...Object.keys(next.models ?? {}),
    ...Object.keys(merged.models ?? {}),
  ]);
  const models: Record<string, ProviderSettingsPacingRule> = Object.create(null);
  for (const model of modelNames) {
    const baseRule = base.models?.[model];
    const nextRule = next.models?.[model];
    const latestRule = merged.models?.[model];
    if (!nextRule && !baseRule) { if (latestRule) models[model] = latestRule; continue; }
    if (!nextRule) continue; // the user removed this model
    if (!baseRule) { models[model] = nextRule; continue; } // the user added this model
    const rule = mergeRule(baseRule, nextRule, latestRule);
    if (rule) models[model] = rule;
  }
  if (Object.keys(models).length > 0) merged.models = models; else delete merged.models;
  return merged;
}

/** Paths where the user and the latest saved pacing both changed the same value. */
export function providerPacingConflicts(
  baseline: ProviderSettingsDraft,
  draft: ProviderSettingsDraft,
  latest: WorkspaceItem["requestPacing"],
): string[] {
  const base = draftRequestPacing(baseline);
  const next = draftRequestPacing(draft);
  const saved = latest ?? { enabled: false };
  const conflicts: string[] = [];
  const changed = (a: unknown, b: unknown) => providerSettingsValueSignature(a) !== providerSettingsValueSignature(b);
  for (const field of ["enabled", "requestsPerMinute", "minIntervalMs", "maxConcurrentRequests", "keySelection"] as const) {
    if (changed(next[field], base[field]) && changed(saved[field], base[field]) && changed(next[field], saved[field])) {
      conflicts.push(`pacing.${field}`);
    }
  }
  for (const field of ["requestsPerMinute", "minIntervalMs", "maxConcurrentRequests"] as const) {
    if (changed(next.keys?.[field], base.keys?.[field]) && changed(saved.keys?.[field], base.keys?.[field])
      && changed(next.keys?.[field], saved.keys?.[field])) conflicts.push(`pacing.keys.${field}`);
  }
  const models = new Set([...Object.keys(base.models ?? {}), ...Object.keys(next.models ?? {}), ...Object.keys(saved.models ?? {})]);
  for (const model of models) {
    for (const field of ["requestsPerMinute", "minIntervalMs", "maxConcurrentRequests"] as const) {
      if (changed(next.models?.[model]?.[field], base.models?.[model]?.[field])
        && changed(saved.models?.[model]?.[field], base.models?.[model]?.[field])
        && changed(next.models?.[model]?.[field], saved.models?.[model]?.[field])) {
        conflicts.push(`pacing.models.${model}.${field}`);
      }
    }
  }
  return conflicts;
}

/**
 * Does this draft differ from the saved provider in a field the Settings tab can write?
 *
 * Fields that do not apply to the current adapter/auth pair are ignored, matching what the
 * form actually saves: a Vertex project on a non-Vertex provider, or an Anthropic-only key
 * transport, must not make an otherwise clean form dirty.
 */
export function providerSettingsFieldsDirty(draft: ProviderSettingsDraft, saved: WorkspaceItem): boolean {
  const adapter = draft.adapter.trim();
  const vertexSettings = isVertexProvider(saved) && (saved.name === "google-vertex" || adapter === "google");
  const liveModelDiscoverySupported = providerSupportsLiveModelDiscovery(saved.name, saved);
  const savedLiveModels = liveModelDiscoverySupported ? saved.liveModels !== false : false;
  const savedCursorHttpVersion = effectiveCursorHttpVersion(saved.upstreamHttpVersion);
  const supportsReasoningReplay = !isCatalogProviderId(saved.name)
    && canConfigureResponsesReasoningReplay({ adapter, baseUrl: draft.baseUrl, authMode: draft.authMode });
  return (supportsReasoningReplay && draft.preserveReasoningReplay !== (saved.preserveResponsesReasoningContent === true))
    || adapter !== saved.adapter
    || draft.baseUrl.trim() !== saved.baseUrl
    || (vertexSettings && (draft.project.trim() !== (saved.project ?? "") || draft.location.trim() !== (saved.location ?? "")))
    || draft.defaultModel.trim() !== (saved.defaultModel ?? "")
    || draft.authMode !== String(saved.authMode ?? (saved.keyOptional ? "local" : "key"))
    || (adapter === "anthropic" && draft.authMode === "key" && draft.apiKeyTransport !== (saved.apiKeyTransport ?? "x-api-key"))
    || draft.note.trim() !== (saved.note ?? "")
    || draft.allowPrivateNetwork !== (saved.allowPrivateNetwork ?? false)
    || draft.liveModels !== savedLiveModels
    || (adapter === "cursor" && draft.cursorHttpVersion !== savedCursorHttpVersion);
}

export function providerSettingsPacingDirty(draft: ProviderSettingsDraft, saved: WorkspaceItem): boolean {
  return pacingSignature(draftRequestPacing(draft)) !== pacingSignature(saved.requestPacing);
}

/** Any Settings-tab change, including request pacing. */
export function providerSettingsDirty(draft: ProviderSettingsDraft, saved: WorkspaceItem): boolean {
  return providerSettingsFieldsDirty(draft, saved) || providerSettingsPacingDirty(draft, saved);
}

/**
 * The PATCH for the fields the user actually changed, relative to the saved values the
 * draft started from. A field the user did not touch is omitted, so a saved change that
 * landed while the draft was parked survives a keep-draft save.
 */
export function providerSettingsDeltaPatch(
  draft: ProviderSettingsDraft,
  baseline: ProviderSettingsDraft,
  saved: WorkspaceItem,
  nextBaseUrl: string,
): { patch: ProviderUpdatePatch; fieldsDirty: boolean; pacingDirty: boolean } {
  const patch: ProviderUpdatePatch = {};
  const adapter = draft.adapter.trim();
  const baselineAdapter = baseline.adapter.trim();
  const vertexSettings = isVertexProvider(saved) && (saved.name === "google-vertex" || adapter === "google");
  const liveModelDiscoverySupported = providerSupportsLiveModelDiscovery(saved.name, saved);
  const supportsReasoningReplay = !isCatalogProviderId(saved.name)
    && canConfigureResponsesReasoningReplay({ adapter, baseUrl: draft.baseUrl, authMode: draft.authMode });

  if (adapter !== baselineAdapter) patch.adapter = adapter;
  if (nextBaseUrl !== baseline.baseUrl.trim()) patch.baseUrl = nextBaseUrl;
  if (draft.defaultModel.trim() !== baseline.defaultModel.trim()) patch.defaultModel = draft.defaultModel.trim();
  if (draft.authMode !== baseline.authMode) patch.authMode = draft.authMode;
  if (draft.note.trim() !== baseline.note.trim()) patch.note = draft.note.trim();
  if (draft.allowPrivateNetwork !== baseline.allowPrivateNetwork) patch.allowPrivateNetwork = draft.allowPrivateNetwork;
  if (vertexSettings) {
    if (draft.project.trim() !== baseline.project.trim()) patch.project = draft.project.trim();
    if (draft.location.trim() !== baseline.location.trim()) patch.location = draft.location.trim();
  }
  if (liveModelDiscoverySupported && draft.liveModels !== baseline.liveModels) patch.liveModels = draft.liveModels;
  if (supportsReasoningReplay && draft.preserveReasoningReplay !== baseline.preserveReasoningReplay) {
    patch.preserveResponsesReasoningContent = draft.preserveReasoningReplay;
  }
  if (adapter === "cursor" && draft.cursorHttpVersion !== baseline.cursorHttpVersion) {
    patch.upstreamHttpVersion = draft.cursorHttpVersion === "http1.1" ? "http1.1" : null;
  }
  const wasApiKeyTransportApplicable = baselineAdapter === "anthropic" && baseline.authMode === "key";
  if (adapter === "anthropic" && draft.authMode === "key") {
    if (draft.apiKeyTransport !== baseline.apiKeyTransport) patch.apiKeyTransport = draft.apiKeyTransport;
  } else if (wasApiKeyTransportApplicable && saved.apiKeyTransport !== undefined) {
    // Leaving the Anthropic key mode is the user's change; clear the now-inapplicable value.
    patch.apiKeyTransport = "";
  }
  const pacingDirty = pacingSignature(draftRequestPacing(draft)) !== pacingSignature(draftRequestPacing(baseline));
  if (pacingDirty) patch.requestPacing = draftRequestPacing(draft);
  const fieldsDirty = Object.keys(patch).some(key => key !== "requestPacing");
  return { patch, fieldsDirty, pacingDirty };
}

/**
 * Rebase a kept draft onto the latest saved values: fields the user changed keep their
 * draft value, and fields the user did not touch adopt the saved change.
 */
export function rebaseProviderSettingsDraft(
  oldBaseline: ProviderSettingsDraft,
  draft: ProviderSettingsDraft,
  latest: ProviderSettingsDraft,
): ProviderSettingsDraft {
  const pick = <K extends keyof ProviderSettingsDraft>(key: K): ProviderSettingsDraft[K] =>
    providerSettingsValueSignature(draft[key]) === providerSettingsValueSignature(oldBaseline[key]) ? latest[key] : draft[key];
  const rebased: ProviderSettingsDraft = {
    adapter: pick("adapter"),
    baseUrl: pick("baseUrl"),
    project: pick("project"),
    location: pick("location"),
    defaultModel: pick("defaultModel"),
    authMode: pick("authMode"),
    apiKeyTransport: pick("apiKeyTransport"),
    note: pick("note"),
    allowPrivateNetwork: pick("allowPrivateNetwork"),
    preserveReasoningReplay: pick("preserveReasoningReplay"),
    liveModels: pick("liveModels"),
    cursorHttpVersion: pick("cursorHttpVersion"),
    pacingEnabled: pick("pacingEnabled"),
    keyPacing: pick("keyPacing"),
    pacingRpm: pick("pacingRpm"),
    pacingDelay: pick("pacingDelay"),
    pacingConcurrency: pick("pacingConcurrency"),
    pacingModels: pick("pacingModels"),
  };
  const pacing = mergeProviderPacing(oldBaseline, draft, draftRequestPacing(latest));
  return {
    ...rebased,
    pacingEnabled: pacing.enabled === true,
    keyPacing: {
      ...(pacing.keySelection !== undefined ? { keySelection: pacing.keySelection } : {}),
      ...(pacing.keys !== undefined ? { keys: { ...pacing.keys } } : {}),
    },
    pacingRpm: numberDraft(pacing.requestsPerMinute),
    pacingDelay: numberDraft(pacing.minIntervalMs),
    pacingConcurrency: numberDraft(pacing.maxConcurrentRequests),
    pacingModels: Object.fromEntries(Object.entries(pacing.models ?? {}).map(([model, rule]) => [model, { ...rule }])),
  };
}

/** Human-readable target label for the draft banner; never a credential. */
export function providerDraftTargetLabel(target: string): string {
  // A composite logical key never reaches the DOM; only its display prefix does.
  const display = target.split("\u0000", 1)[0]!;
  if (display) return display;
  return typeof window === "undefined" ? "same-origin" : window.location.origin;
}
