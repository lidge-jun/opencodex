/**
 * Data-driven reasoning ladders for routed providers (2026-09-12 local patch).
 *
 * Routed providers rarely publish per-model effort ladders: OpenCode Zen Go answers /models
 * with ids only (id/object/created/owned_by), so opencodex had to hardcode ladders in
 * registry.ts and synthesise max/ultra for codex-rs catalog membership. The public models.dev
 * catalogue DOES publish them per model:
 *   reasoning: true
 *   reasoning_options: [{type:"effort",values:["low","high","max"]}, {type:"toggle"},
 *                       {type:"budget_tokens"}]
 * This module snapshots that catalogue to disk and hands configuredReasoningEfforts() a
 * fallback ladder, so the Codex catalog AND the wire clamp agree with the model instead of a
 * hand-written guess.
 *
 * Failure policy: the network is never on the critical path. A missing, stale or corrupt
 * snapshot yields undefined, which leaves every hand-written contract untouched. The second
 * cache records rungs the upstream actually rejected (400/403 naming reasoning_effort), so an
 * entitlement gap (muse-spark max needs an active Muse Code subscription) costs one rejected
 * request instead of failing every turn that selects that rung.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
// Leaf modules on purpose: this file is imported from reasoning-effort.ts, which combos/types.ts
// already imports. Going through the ../config barrel closes a cycle back into account-namespaces.ts
// and leaves COMBO_NAMESPACE in its temporal dead zone for entry points that start at combos/types.ts.
import { atomicWriteFile } from "../config/atomic-write";
import { getConfigDir } from "../config/paths";
import type { OcxProviderConfig } from "../types";

const FILENAME = "reasoning-metadata-cache.json";
const SUPPORT_FILENAME = "reasoning-support-cache.json";
const SOURCE_URL = "https://models.dev/api.json";
const USER_AGENT = "opencodex-reasoning-metadata/1.0 (+https://github.com/lidge-jun/opencodex)";
/** Snapshot age that triggers a background refresh. Older snapshots still serve reads. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** A learned "this rung is refused" fact expires: entitlements change. */
const SUPPORT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PERSIST_DEBOUNCE_MS = 250;

/** Canonical Codex ladder order; mirrors reasoning-effort.ts CODEX_REASONING_LEVELS. */
const LADDER_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
/** Ranked rungs used for downgrade planning; ultra is client-only and folds to max. */
const RANKED = ["low", "medium", "high", "xhigh", "max"];
/** Mirror of registry.ts THINKING_TOGGLE_EFFORTS / THINKING_BUDGET_EFFORTS. */
const CLASSIFIED_STYLE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/**
 * models.dev provider key for a provider config. OcxProviderConfig carries no id, so the
 * destination URL is the stable handle. Only destinations this patch has evidence for are
 * listed; an unlisted provider simply keeps its current behaviour.
 */
const BASE_URL_TO_METADATA_PROVIDER: Record<string, string> = {
  "https://opencode.ai/zen/go/v1": "opencode-go",
  "https://opencode.ai/zen/v1": "opencode",
};

/**
 * Both sides of the mapping are compared after this normalisation, so a trailing slash or a
 * `/v1` suffix never decides whether a destination resolves. models.dev publishes each
 * provider's own `api` URL; the snapshot keeps it (v2) so the mapping can be checked against
 * published data instead of trusted blindly.
 */
export function normalizeDestinationUrl(url: string | undefined): string | undefined {
  if (typeof url !== "string" || url.trim() === "") return undefined;
  try {
    const parsed = new URL(url.trim());
    const path = parsed.pathname.replace(/\/+$/, "").replace(/\/v1$/i, "");
    return (parsed.protocol + "//" + parsed.host + path).toLowerCase();
  } catch {
    return undefined;
  }
}

export type ReasoningMetadataOption = { type: string; values?: string[] };
export type ReasoningMetadataModel = { reasoning: boolean; options: ReasoningMetadataOption[] };

interface MetadataSnapshot {
  version: 1 | 2;
  fetchedAt: number;
  source: string;
  providers: Record<string, Record<string, ReasoningMetadataModel>>;
  /**
   * v2: models.dev provider key -> that provider's published api URL (normalised). v1 snapshots
   * predate the field and keep working through BASE_URL_TO_METADATA_PROVIDER.
   */
  apis?: Record<string, string>;
}

interface SupportSnapshot {
  version: 1;
  rows: Record<string, { effort: string; at: number; evidence?: string }>;
}

let snapshotMemo: MetadataSnapshot | null | undefined;
let supportMemo: Map<string, number> | undefined;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let refreshInFlight: Promise<unknown> | null = null;

function readJsonFile<T>(filename: string): T | null {
  try {
    const path = join(getConfigDir(), filename);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    // A corrupt cache must never break routing, the catalog, or the dashboard.
    return null;
  }
}

/** Canonical order + dedupe. Local mirror of sanitizeCodexReasoningEfforts (import cycle). */
function sanitizeLadder(values: readonly string[] | undefined): string[] | undefined {
  if (!Array.isArray(values)) return undefined;
  const seen = new Set(values.filter((value): value is string => typeof value === "string"));
  const ordered = LADDER_ORDER.filter(effort => seen.has(effort));
  return ordered.length > 0 ? ordered : undefined;
}

function metadataProviderKey(provider: OcxProviderConfig): string | undefined {
  const normalized = normalizeDestinationUrl(typeof provider.baseUrl === "string" ? provider.baseUrl : undefined);
  if (!normalized) return undefined;
  for (const [destination, key] of Object.entries(BASE_URL_TO_METADATA_PROVIDER)) {
    if (normalizeDestinationUrl(destination) === normalized) return key;
  }
  return undefined;
}

/** Opaque row key: providerKey|modelId|effort. None of the three may contain a pipe. */
const KEY_SEP = "|";

function supportKey(providerKey: string, modelId: string, effort: string): string {
  return providerKey + KEY_SEP + modelId + KEY_SEP + effort;
}

function loadSnapshot(): MetadataSnapshot | null {
  if (snapshotMemo !== undefined) return snapshotMemo;
  const parsed = readJsonFile<MetadataSnapshot>(FILENAME);
  snapshotMemo = parsed && (parsed.version === 1 || parsed.version === 2) && parsed.providers && typeof parsed.providers === "object"
    ? parsed
    : null;
  return snapshotMemo;
}

/**
 * Mapping report for diagnostics and tests: every gated destination, the models.dev provider it
 * resolves to, and whether the snapshot (v2) publishes an `api` URL that confirms it. The gate is
 * deliberate -- 36 of the registry's 83 destinations match a models.dev provider, so resolving by
 * URL alone would silently move ladders for providers this change has no evidence for.
 */
export function reasoningMetadataMapping(): Array<{
  destination: string;
  provider: string;
  publishedApi?: string;
  confirmed?: boolean;
  models: number;
}> {
  const snapshot = loadSnapshot();
  return Object.entries(BASE_URL_TO_METADATA_PROVIDER).map(([destination, provider]) => {
    const normalized = normalizeDestinationUrl(destination);
    const publishedApi = snapshot?.apis?.[provider];
    const row = {
      destination,
      provider,
      ...(publishedApi ? { publishedApi } : {}),
      ...(publishedApi ? { confirmed: publishedApi === normalized } : {}),
      models: Object.keys(snapshot?.providers?.[provider] ?? {}).length,
    };
    return row;
  });
}

function loadSupport(): Map<string, number> {
  if (supportMemo) return supportMemo;
  const rows = new Map<string, number>();
  const parsed = readJsonFile<SupportSnapshot>(SUPPORT_FILENAME);
  if (parsed && parsed.version === 1 && parsed.rows && typeof parsed.rows === "object") {
    const now = Date.now();
    for (const [key, row] of Object.entries(parsed.rows)) {
      if (!row || typeof row.at !== "number") continue;
      if (now - row.at > SUPPORT_TTL_MS) continue;
      rows.set(key, row.at);
    }
  }
  supportMemo = rows;
  return rows;
}

/** Snapshot health for ocx status / diagnostics. */
export function reasoningMetadataStatus(): { fetchedAt?: number; ageMs?: number; stale: boolean; models: number } {
  const snapshot = loadSnapshot();
  if (!snapshot) return { stale: false, models: 0 };
  const ageMs = Date.now() - snapshot.fetchedAt;
  let models = 0;
  for (const provider of Object.values(snapshot.providers)) models += Object.keys(provider).length;
  return { fetchedAt: snapshot.fetchedAt, ageMs, stale: ageMs > CACHE_TTL_MS, models };
}

export function reasoningMetadataModel(provider: OcxProviderConfig, modelId: string): ReasoningMetadataModel | undefined {
  const key = metadataProviderKey(provider);
  if (!key) return undefined;
  const models = loadSnapshot()?.providers?.[key];
  if (!models) return undefined;
  const model = models[modelId];
  return model && typeof model === "object" ? model : undefined;
}

/** Raw models.dev effort values for a model, canonicalised; undefined when not published. */
export function metadataEffortValues(provider: OcxProviderConfig, modelId: string): string[] | undefined {
  const model = reasoningMetadataModel(provider, modelId);
  if (!model) return undefined;
  const options = Array.isArray(model.options) ? model.options : [];
  const effort = options.find(option => option && option.type === "effort");
  const ladder = sanitizeLadder(effort?.values);
  // none/minimal are sentinels, not picker rungs (mapReasoningEffort folds minimal to low), and
  // advertising them would trip the Codex runtime clamp for no user-visible gain.
  const rungs = ladder?.filter(value => value !== "none" && value !== "minimal");
  return rungs && rungs.length > 0 ? rungs : undefined;
}

/** True when models.dev publishes the named option type (toggle / budget_tokens) for a model. */
export function metadataDeclaresType(provider: OcxProviderConfig, modelId: string, type: string): boolean {
  const model = reasoningMetadataModel(provider, modelId);
  if (!model) return false;
  const options = Array.isArray(model.options) ? model.options : [];
  return options.some(option => option?.type === type);
}

export function isReasoningEffortLearnedUnsupported(provider: OcxProviderConfig, modelId: string, effort: string): boolean {
  const key = metadataProviderKey(provider);
  if (!key) return false;
  return loadSupport().has(supportKey(key, modelId, effort));
}

/**
 * After the ladder is chosen (registry config or models.dev metadata), remove the rungs this
 * account actually had refused. Applied at the configuredReasoningEfforts() exit so a
 * registry-pinned ladder learns exactly like a metadata-derived one; without it a pinned rung
 * the upstream rejects would replay-and-fail on every request. An all-refused ladder keeps the
 * original list: turning "some rungs" into "no effort control" would silently drop the picker.
 */
export function dropLearnedUnsupportedReasoningEfforts(
  provider: OcxProviderConfig,
  modelId: string,
  efforts: readonly string[],
): string[] {
  if (efforts.length === 0) return [...efforts];
  const key = metadataProviderKey(provider);
  if (!key) return [...efforts];
  const support = loadSupport();
  if (support.size === 0) return [...efforts];
  const kept = efforts.filter(effort => !support.has(supportKey(key, modelId, effort)));
  return kept.length === 0 ? [...efforts] : kept;
}

/**
 * Metadata fallback ladder for a provider/model.
 *
 * - Published effort values win.
 * - A model the provider already classifies as thinking-toggle / thinking-budget keeps the
 *   provider's own effort list; a toggle-only entry never invents wire semantics here.
 * - Rungs the upstream actually refused are removed; a ladder emptied by that learning
 *   returns undefined (status quo) rather than advertising "no effort control".
 */
export function reasoningEffortsFromMetadata(provider: OcxProviderConfig, modelId: string): string[] | undefined {
  const published = metadataEffortValues(provider, modelId);
  let ladder = published;
  if (!ladder) {
    const classified = (provider.thinkingToggleModels ?? []).includes(modelId)
      || (provider.thinkingBudgetModels ?? []).includes(modelId);
    ladder = classified ? CLASSIFIED_STYLE_EFFORTS : undefined;
  }
  if (!ladder || ladder.length === 0) return undefined;
  const kept = ladder.filter(effort => !isReasoningEffortLearnedUnsupported(provider, modelId, effort));
  if (kept.length === 0) return undefined;
  return kept;
}

const supportEvidence = new Map<string, string>();

/**
 * Record that the upstream refused a rung. Persisted (debounced) so the next catalog sync and
 * every later request clamp before dispatch. Returns true when this is new information.
 */
export function recordUnsupportedReasoningEffort(
  provider: OcxProviderConfig,
  modelId: string,
  effort: string,
  evidence?: string,
): boolean {
  const key = metadataProviderKey(provider);
  if (!key || !effort) return false;
  const rowKey = supportKey(key, modelId, effort);
  const rows = loadSupport();
  if (rows.has(rowKey)) return false;
  rows.set(rowKey, Date.now());
  if (evidence) supportEvidence.set(rowKey, evidence.slice(0, 240));
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      const out: SupportSnapshot["rows"] = {};
      for (const [rowKey, at] of rows) {
        const parts = rowKey.split(KEY_SEP);
        const evidenceText = supportEvidence.get(rowKey);
        out[rowKey] = {
          effort: parts[2] ?? "",
          at,
          ...(evidenceText ? { evidence: evidenceText } : {}),
        };
      }
      atomicWriteFile(join(getConfigDir(), SUPPORT_FILENAME), JSON.stringify({ version: 1, rows: out }) + "\n");
    } catch {
      // Best-effort persistence only.
    }
  }, PERSIST_DEBOUNCE_MS);
  return true;
}

/** Test seam: flush a pending support write so a script sees the snapshot immediately. */
export function flushReasoningSupportCache(): void {
  if (!persistTimer) return;
  clearTimeout(persistTimer);
  persistTimer = null;
  try {
    const rows = loadSupport();
    const out: SupportSnapshot["rows"] = {};
    for (const [rowKey, at] of rows) {
      const parts = rowKey.split(KEY_SEP);
      const evidenceText = supportEvidence.get(rowKey);
      out[rowKey] = { effort: parts[2] ?? "", at, ...(evidenceText ? { evidence: evidenceText } : {}) };
    }
    atomicWriteFile(join(getConfigDir(), SUPPORT_FILENAME), JSON.stringify({ version: 1, rows: out }) + "\n");
  } catch {
    // Best-effort persistence only.
  }
}

/** Evidence test for a rejection body: does it blame reasoning effort? */
export function isReasoningEffortRejection(text: string | undefined): boolean {
  if (!text) return false;
  if (text.includes("reasoning.effort") || text.includes("reasoning_effort")) return true;
  return /reasoning effort|thinking budget|reasoning_parameters|unsupported.{0,24}effort/i.test(text);
}

/**
 * Plan a single-rung downgrade for a rejected request: records the refusal (so later turns
 * clamp before dispatch) and returns the next lower rung the model does publish.
 */
export function planReasoningEffortDowngrade(args: {
  provider: OcxProviderConfig;
  modelId: string;
  requested?: string;
  rejectionText?: string;
}): { effort: string; recorded: boolean } | undefined {
  const requested = args.requested === "ultra" ? "max" : args.requested;
  if (!requested || !RANKED.includes(requested)) return undefined;
  const recorded = recordUnsupportedReasoningEffort(args.provider, args.modelId, requested, args.rejectionText);
  const effective = metadataEffortValues(args.provider, args.modelId)
    ?? sanitizeLadder(args.provider.modelReasoningEfforts?.[args.modelId])
    ?? sanitizeLadder(args.provider.reasoningEfforts);
  const ladder = (effective ?? []).filter(effort => RANKED.includes(effort));
  if (ladder.length === 0) return undefined;
  const candidates = ladder
    .filter(effort => RANKED.indexOf(effort) < RANKED.indexOf(requested))
    .filter(effort => !isReasoningEffortLearnedUnsupported(args.provider, args.modelId, effort));
  if (candidates.length === 0) return undefined;
  return { effort: candidates[candidates.length - 1], recorded };
}

/**
 * Refresh the models.dev snapshot. Best-effort and idempotent: never throws, never blocks a
 * request, keeps the previous snapshot on failure. Ladders are stored for the gated destinations
 * only (OpenCode Zen + Zen Go: about 130 models), while every published provider `api` URL is
 * kept so the gate can be checked against real data and widened without another format change.
 * Non-reasoning models carry no ladder and are dropped.
 */
export async function refreshReasoningMetadata(options: { force?: boolean } = {}): Promise<{
  ok: boolean;
  reason: string;
  providers?: number;
  models?: number;
}> {
  const snapshot = loadSnapshot();
  if (!options.force && snapshot && Date.now() - snapshot.fetchedAt <= CACHE_TTL_MS) {
    return { ok: true, reason: "fresh" };
  }
  if (refreshInFlight) {
    await refreshInFlight;
    return { ok: true, reason: "coalesced" };
  }
  const job = (async () => {
    const response = await fetch(SOURCE_URL, {
      headers: { "user-agent": USER_AGENT, accept: "application/json" },
      // A hanging connection must not pin refreshInFlight for the life of the process.
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error("models.dev HTTP " + response.status);
    const raw = await response.json() as Record<string, { api?: unknown; models?: Record<string, unknown> }>;
    const providers: MetadataSnapshot["providers"] = {};
    const apis: Record<string, string> = {};
    const gated = new Set(Object.values(BASE_URL_TO_METADATA_PROVIDER));
    let models = 0;
    for (const [providerKey, entry] of Object.entries(raw ?? {})) {
      const api = normalizeDestinationUrl(typeof entry?.api === "string" ? entry.api : undefined);
      if (api) apis[providerKey] = api;
      if (!gated.has(providerKey)) continue;
      const out: Record<string, ReasoningMetadataModel> = {};
      for (const [modelId, value] of Object.entries(entry?.models ?? {})) {
        const model = value as { reasoning?: unknown; reasoning_options?: unknown };
        if (model?.reasoning !== true) continue;
        const options: ReasoningMetadataOption[] = [];
        if (Array.isArray(model?.reasoning_options)) {
          for (const option of model.reasoning_options) {
            if (!option || typeof option !== "object") continue;
            const type = (option as { type?: unknown }).type;
            if (typeof type !== "string") continue;
            const values = (option as { values?: unknown }).values;
            options.push({
              type,
              ...(Array.isArray(values)
                ? { values: values.filter((v): v is string => typeof v === "string").slice(0, 12) }
                : {}),
            });
          }
        }
        out[modelId] = { reasoning: model?.reasoning === true, options };
        models += 1;
      }
      if (Object.keys(out).length === 0) continue;
      providers[providerKey] = out;
    }
    const next: MetadataSnapshot = { version: 2, fetchedAt: Date.now(), source: SOURCE_URL, providers, apis };
    atomicWriteFile(join(getConfigDir(), FILENAME), JSON.stringify(next) + "\n");
    snapshotMemo = next;
    return { ok: true, reason: "refreshed", providers: Object.keys(providers).length, models };
  })();
  refreshInFlight = job.catch(() => undefined).finally(() => { refreshInFlight = null; });
  try {
    return await job;
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Kick a background refresh when the snapshot is missing or stale. Called from the ladder read
 * path so both the long-lived proxy and short-lived ocx sync self-heal without a new CLI
 * surface. One refresh per process at a time; failures are ignored on purpose.
 */
export function ensureReasoningMetadataSnapshot(): void {
  const snapshot = loadSnapshot();
  if (snapshot && Date.now() - snapshot.fetchedAt <= CACHE_TTL_MS) return;
  if (refreshInFlight) return;
  void refreshReasoningMetadata().catch(() => undefined);
}
