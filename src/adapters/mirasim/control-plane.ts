import type { OcxProviderConfig } from "../../types";
import type { ProviderQuota, ProviderQuotaWindow } from "../../providers/quota-types";
import {
  isValidModelDiscoveryModelId,
  MODEL_DISCOVERY_MAX_MODELS,
  MODEL_DISCOVERY_MAX_RESPONSE_BYTES,
  readBoundedDiscoveryJson,
} from "../../providers/model-discovery";
import { fetchMirasimControl, mirasimCredentialCacheScope } from "./transport";

const ROSTER_SUCCESS_TTL_MS = 10 * 60_000;
const ROSTER_FAILURE_TTL_MS = 60_000;
const CONTROL_TIMEOUT_MS = 8_000;
const ALLOWED_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);
const DATED_MODEL_SUFFIX = /-20\d{6}$/;
const RESERVED_MODEL_IDS = new Set(["*", "gpt-4o-mini", "gpt-4o-mini-openrouter"]);

export interface MirasimRosterSpec {
  id: string;
  label?: string;
  contextWindow: number;
  maxOutput?: number;
  autoCompactRatio?: number;
  effort: string[];
  adaptive: boolean;
}

export interface MirasimRoster {
  version: string;
  agents: {
    claude: MirasimRosterSpec[];
    codex: MirasimRosterSpec[];
  };
}

export interface MirasimDiscoveredModel {
  id: string;
  object?: string;
  created?: number;
  ownedBy?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  displayName?: string;
  reasoningEfforts?: string[];
  adaptiveThinking?: boolean;
  autoCompactRatio?: number;
}

export type MirasimLiveCatalogResult =
  | { ok: true; models: MirasimDiscoveredModel[]; roster?: MirasimRoster }
  | { ok: false; reason: "auth" | "http" | "invalid_response" | "transport"; status?: number };

interface RosterCacheEntry {
  roster?: MirasimRoster;
  nextCheckAt: number;
}

const rosterCache = new Map<string, RosterCacheEntry>();

function credentialCacheKey(accessToken: string): string {
  return mirasimCredentialCacheScope(accessToken);
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function finitePositive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function parseEfforts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const normalized = item.trim().toLowerCase();
    if (!ALLOWED_EFFORTS.has(normalized) || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function parseRosterSpec(value: unknown, family: "claude" | "codex"): MirasimRosterSpec | undefined {
  const row = plainRecord(value);
  if (!row || typeof row.id !== "string") return undefined;
  const id = row.id.trim().toLowerCase();
  const expectedPrefix = family === "claude" ? "claude-" : "gpt-";
  const contextWindow = finitePositive(row.contextWindow);
  if (!id.startsWith(expectedPrefix) || id.endsWith("-paid") || !contextWindow) return undefined;
  const maxOutput = finitePositive(row.maxOutput);
  const autoCompactRatio = typeof row.autoCompactRatio === "number"
    && Number.isFinite(row.autoCompactRatio)
    && row.autoCompactRatio > 0
    && row.autoCompactRatio <= 1
      ? row.autoCompactRatio
      : undefined;
  const label = typeof row.label === "string" && row.label.trim() ? row.label.trim() : undefined;
  return {
    id,
    ...(label ? { label } : {}),
    contextWindow,
    ...(maxOutput ? { maxOutput } : {}),
    ...(autoCompactRatio ? { autoCompactRatio } : {}),
    effort: parseEfforts(row.effort),
    adaptive: row.adaptive === true,
  };
}

export function parseMirasimRoster(value: unknown): MirasimRoster | undefined {
  const envelope = plainRecord(value);
  const agents = plainRecord(envelope?.agents);
  if (!envelope || typeof envelope.version !== "string" || !envelope.version.trim() || !agents) return undefined;

  const parseFamily = (family: "claude" | "codex"): MirasimRosterSpec[] => {
    const rows = Array.isArray(agents[family]) ? agents[family] as unknown[] : [];
    const out: MirasimRosterSpec[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const spec = parseRosterSpec(row, family);
      if (!spec || seen.has(spec.id)) continue;
      seen.add(spec.id);
      out.push(spec);
      if (out.length >= MODEL_DISCOVERY_MAX_MODELS) break;
    }
    return out;
  };

  const claude = parseFamily("claude");
  const codex = parseFamily("codex");
  if (claude.length === 0 && codex.length === 0) return undefined;
  return {
    version: envelope.version.trim(),
    agents: { claude, codex },
  };
}

function rosterSpec(roster: MirasimRoster | undefined, modelId: string): MirasimRosterSpec | undefined {
  if (!roster) return undefined;
  const id = modelId.trim().toLowerCase().replace(/\[1m\]$/i, "");
  return [...roster.agents.claude, ...roster.agents.codex].find(spec => spec.id === id);
}

export function cachedMirasimThinkingShape(
  accessToken: string,
  modelId: string,
): "adaptive" | "budget" | undefined {
  const spec = rosterSpec(rosterCache.get(credentialCacheKey(accessToken))?.roster, modelId);
  return spec ? (spec.adaptive ? "adaptive" : "budget") : undefined;
}

export function cachedMirasimRoster(accessToken: string): MirasimRoster | undefined {
  return rosterCache.get(credentialCacheKey(accessToken))?.roster;
}

async function fetchRoster(
  providerName: string,
  provider: OcxProviderConfig,
  accessToken: string,
  signal?: AbortSignal,
): Promise<MirasimRoster | undefined> {
  const key = credentialCacheKey(accessToken);
  const now = Date.now();
  const cached = rosterCache.get(key);
  if (cached && now < cached.nextCheckAt) return cached.roster;

  try {
    const response = await fetchMirasimControl(providerName, provider, accessToken, "/v1/model-roster", {
      // The current relay authenticates roster discovery against the login credential itself.
      // A device-session bearer is valid for inference and /models, but /model-roster rejects it.
      credentialMode: "access-token",
      signal,
      timeoutMs: CONTROL_TIMEOUT_MS,
    });
    if (!response.ok) {
      try { await response.body?.cancel(); } catch { /* already closed */ }
      rosterCache.set(key, { roster: cached?.roster, nextCheckAt: now + ROSTER_FAILURE_TTL_MS });
      return cached?.roster;
    }
    const bounded = await readBoundedDiscoveryJson(response, MODEL_DISCOVERY_MAX_RESPONSE_BYTES);
    const roster = bounded.ok ? parseMirasimRoster(bounded.value) : undefined;
    if (!roster) {
      rosterCache.set(key, { roster: cached?.roster, nextCheckAt: now + ROSTER_FAILURE_TTL_MS });
      return cached?.roster;
    }
    rosterCache.set(key, { roster, nextCheckAt: now + ROSTER_SUCCESS_TTL_MS });
    return roster;
  } catch {
    rosterCache.set(key, { roster: cached?.roster, nextCheckAt: now + ROSTER_FAILURE_TTL_MS });
    return cached?.roster;
  }
}

interface RawCatalogModel {
  id: string;
  object?: string;
  created?: number;
  ownedBy?: string;
  maxInputTokens?: number;
}

function parseRawCatalog(value: unknown): RawCatalogModel[] | undefined {
  const envelope = plainRecord(value);
  const source = Array.isArray(envelope?.data)
    ? envelope!.data as unknown[]
    : Array.isArray(envelope?.models)
      ? envelope!.models as unknown[]
      : undefined;
  if (!source || source.length === 0 || source.length > MODEL_DISCOVERY_MAX_MODELS) return undefined;

  const parsed: RawCatalogModel[] = [];
  for (const item of source) {
    if (typeof item === "string") {
      const id = item.trim();
      if (isValidModelDiscoveryModelId(id)) parsed.push({ id });
      continue;
    }
    const row = plainRecord(item);
    if (!row || typeof row.id !== "string") continue;
    const id = row.id.trim();
    if (!isValidModelDiscoveryModelId(id)) continue;
    parsed.push({
      id,
      ...(typeof row.object === "string" && row.object ? { object: row.object } : {}),
      ...(typeof row.created === "number" && Number.isFinite(row.created) ? { created: row.created } : {}),
      ...(typeof row.owned_by === "string" && row.owned_by.trim() ? { ownedBy: row.owned_by.trim() } : {}),
      ...(finitePositive(row.max_input_tokens) ? { maxInputTokens: finitePositive(row.max_input_tokens) } : {}),
    });
  }
  if (parsed.length === 0) return undefined;

  const undated = new Set(
    parsed
      .map(model => model.id)
      .filter(id => !id.includes("/") && !DATED_MODEL_SUFFIX.test(id)),
  );
  const seen = new Set<string>();
  return parsed.filter(model => {
    const id = model.id;
    const normalized = id.toLowerCase();
    if (seen.has(id) || RESERVED_MODEL_IDS.has(normalized) || id.includes("/") || normalized.endsWith("-paid")) return false;
    if (DATED_MODEL_SUFFIX.test(id) && undated.has(id.replace(DATED_MODEL_SUFFIX, ""))) return false;
    if (
      !normalized.startsWith("claude-")
      && !normalized.startsWith("gpt-")
      && normalized !== "kimi-k3"
    ) return false;
    seen.add(id);
    return true;
  });
}

function overlayRoster(models: RawCatalogModel[], roster: MirasimRoster | undefined): MirasimDiscoveredModel[] {
  const overlaid = models.map(model => {
    const spec = rosterSpec(roster, model.id);
    return {
      id: model.id,
      ...(model.object ? { object: model.object } : {}),
      ...(model.created !== undefined ? { created: model.created } : {}),
      ...(model.ownedBy ? { ownedBy: model.ownedBy } : {}),
      ...(spec?.contextWindow
        ? { contextWindow: spec.contextWindow }
        : model.maxInputTokens
          ? { contextWindow: model.maxInputTokens }
          : {}),
      ...(spec?.maxOutput ? { maxOutputTokens: spec.maxOutput } : {}),
      ...(spec?.label ? { displayName: spec.label } : {}),
      ...(spec?.effort.length ? { reasoningEfforts: [...spec.effort] } : {}),
      ...(spec ? { adaptiveThinking: spec.adaptive } : {}),
      ...(spec?.autoCompactRatio ? { autoCompactRatio: spec.autoCompactRatio } : {}),
    };
  });
  const out = [...overlaid];
  const seen = new Set(overlaid.map(model => model.id.toLowerCase()));
  for (const model of overlaid) {
    if (
      !model.id.toLowerCase().startsWith("claude-")
      || model.id.includes("[")
      || (model.contextWindow ?? 0) < 1_000_000
    ) continue;
    const id = `${model.id}[1m]`;
    if (seen.has(id.toLowerCase())) continue;
    out.push({
      ...model,
      id,
      ...(model.displayName ? { displayName: `${model.displayName} [1m]` } : {}),
    });
    seen.add(id.toLowerCase());
  }
  return out;
}

export async function fetchMirasimLiveCatalog(
  providerName: string,
  provider: OcxProviderConfig,
  accessToken: string,
  signal?: AbortSignal,
): Promise<MirasimLiveCatalogResult> {
  try {
    const response = await fetchMirasimControl(providerName, provider, accessToken, "/v1/models", {
      signal,
      timeoutMs: CONTROL_TIMEOUT_MS,
    });
    if (!response.ok) {
      const status = response.status;
      try { await response.body?.cancel(); } catch { /* already closed */ }
      return { ok: false, reason: status === 401 || status === 403 ? "auth" : "http", status };
    }
    const bounded = await readBoundedDiscoveryJson(response, MODEL_DISCOVERY_MAX_RESPONSE_BYTES);
    if (!bounded.ok) return { ok: false, reason: "invalid_response" };
    const models = parseRawCatalog(bounded.value);
    if (!models?.length) return { ok: false, reason: "invalid_response" };
    const roster = await fetchRoster(providerName, provider, accessToken, signal);
    return { ok: true, models: overlayRoster(models, roster), ...(roster ? { roster } : {}) };
  } catch {
    return { ok: false, reason: "transport" };
  }
}

function normalizeResetAt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const millis = value > 1e12 ? value : value * 1000;
    return Number.isFinite(new Date(millis).getTime()) ? millis : undefined;
  }
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return normalizeResetAt(numeric);
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

function oneDecimalPercent(value: number): number {
  const rounded = Math.round(value * 10) / 10;
  return rounded >= 99 ? 100 : Math.max(0, Math.min(100, rounded));
}

export function parseMirasimLimits(value: unknown): ProviderQuota | null {
  const envelope = plainRecord(value);
  if (!envelope || !Array.isArray(envelope.windows)) return null;
  const customWindows: ProviderQuotaWindow[] = [];
  let fiveHourPercent: number | undefined;
  let fiveHourResetAt: number | undefined;
  let weeklyPercent: number | undefined;
  let weeklyResetAt: number | undefined;

  for (const item of envelope.windows) {
    const row = plainRecord(item);
    if (!row || typeof row.name !== "string" || !row.name.trim()) continue;
    const budget = typeof row.budget === "number" && Number.isFinite(row.budget) && row.budget >= 0
      ? row.budget
      : undefined;
    const used = typeof row.used === "number" && Number.isFinite(row.used)
      ? row.used
      : undefined;
    if (budget === undefined || used === undefined) continue;
    const percent = budget > 0 ? oneDecimalPercent((used / budget) * 100) : 0;
    const resetAt = normalizeResetAt(row.reset_at);
    const name = row.name.trim();
    const modelScoped = row.model_scoped === true;
    const normalized = name.toLowerCase().replace(/[\s_-]+/g, "");
    if (!modelScoped && (normalized === "5h" || normalized === "5hour" || normalized === "5hours")) {
      fiveHourPercent = percent;
      fiveHourResetAt = resetAt;
      continue;
    }
    if (!modelScoped && (normalized === "7d" || normalized === "7day" || normalized === "7days")) {
      weeklyPercent = percent;
      weeklyResetAt = resetAt;
      continue;
    }
    customWindows.push({
      label: modelScoped ? `Model · ${name}` : name,
      percent,
      ...(resetAt ? { resetAt } : {}),
    });
  }

  if (customWindows.length === 0 && fiveHourPercent === undefined && weeklyPercent === undefined) return null;
  return {
    ...(fiveHourPercent !== undefined ? { fiveHourPercent } : {}),
    ...(fiveHourResetAt !== undefined ? { fiveHourResetAt } : {}),
    ...(weeklyPercent !== undefined ? { weeklyPercent } : {}),
    ...(weeklyResetAt !== undefined ? { weeklyResetAt } : {}),
    customWindows,
    updatedAt: Date.now(),
  };
}

export async function fetchMirasimQuota(
  providerName: string,
  provider: OcxProviderConfig,
  accessToken: string,
  signal?: AbortSignal,
): Promise<ProviderQuota | null> {
  const response = await fetchMirasimControl(providerName, provider, accessToken, "/v1/limits", {
    signal,
    timeoutMs: CONTROL_TIMEOUT_MS,
    providerHeaders: { "x-mirasim-probe": "usage" },
  });
  if (response.status === 404 || response.status === 405) {
    try { await response.body?.cancel(); } catch { /* already closed */ }
    return null;
  }
  if (!response.ok) {
    try { await response.body?.cancel(); } catch { /* already closed */ }
    return null;
  }
  const bounded = await readBoundedDiscoveryJson(response, MODEL_DISCOVERY_MAX_RESPONSE_BYTES);
  return bounded.ok ? parseMirasimLimits(bounded.value) : null;
}

export function resetMirasimControlPlaneStateForTests(): void {
  rosterCache.clear();
}

/** Tests only: seeds one credential-scoped signed-roster observation. */
export function setCachedMirasimRosterForTests(
  accessToken: string,
  roster: MirasimRoster,
): void {
  rosterCache.set(credentialCacheKey(accessToken), {
    roster,
    nextCheckAt: Date.now() + ROSTER_SUCCESS_TTL_MS,
  });
}
