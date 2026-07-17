import { CANONICAL_EFFORT_SUFFIXES, cursorModelEffortLadder } from "./effort-map";

export interface CursorModelInfo {
  id: string;
  contextWindow?: number;
  supportsReasoningEffort?: boolean;
  inputModalities?: string[];
}

export const CURSOR_DEFAULT_CONTEXT_WINDOW = 128_000;

const CURSOR_REASONING_EFFORTS = ["low", "medium", "high"] as const;
const CURSOR_DEFAULT_INPUT_MODALITIES = ["text", "image"] as const;
const CONTEXT_1M = 1_000_000;
const CONTEXT_GEMINI = 1_048_576;
const CONTEXT_272K = 272_000;
const CONTEXT_262K = 262_144;
const CONTEXT_256K = 256_000;
const CONTEXT_200K = 200_000;

export function inferCursorContextWindow(modelId: string): number {
  const id = modelId.trim().toLowerCase();
  if (id.includes("1m")) return CONTEXT_1M;
  if (id.startsWith("gemini-")) return CONTEXT_1M;
  if (id === "glm-5.2") return CONTEXT_1M;
  if (id.startsWith("gpt-5.6-")) return CONTEXT_1M;
  if (id.startsWith("gpt-5") || id === "gpt-5-codex") return CONTEXT_272K;
  if (id.startsWith("grok-4.5")) return 500_000;
  if (id.startsWith("grok-")) return CONTEXT_256K;
  if (id.includes("claude")) return CONTEXT_200K;
  return CURSOR_DEFAULT_CONTEXT_WINDOW;
}

function normalizeInputModalities(input: string[] | undefined): string[] {
  const values = (input ?? [...CURSOR_DEFAULT_INPUT_MODALITIES])
    .flatMap(item => {
      const v = item.trim();
      return v ? [v] : [];
    });
  return values.length > 0 ? [...new Set(values)] : [...CURSOR_DEFAULT_INPUT_MODALITIES];
}

export function normalizeCursorModels(models: readonly CursorModelInfo[]): CursorModelInfo[] {
  const byId = new Map<string, CursorModelInfo>();
  for (const model of models) {
    const id = model.id.trim();
    if (!id || byId.has(id)) continue;
    byId.set(id, {
      id,
      contextWindow: typeof model.contextWindow === "number" && model.contextWindow > 0
        ? model.contextWindow
        : inferCursorContextWindow(id),
      supportsReasoningEffort: model.supportsReasoningEffort === true,
      inputModalities: normalizeInputModalities(model.inputModalities),
    });
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Strip the `cursor-` wire prefix that some Cursor GetUsableModels responses prepend to model ids
 * (e.g. `cursor-grok-4.5-high` instead of `grok-4.5-high`). Applied at the comparison boundary
 * so upstream wire ids stay verbatim everywhere else (issue #117).
 */
function stripCursorWirePrefix(id: string): string {
  return id.startsWith("cursor-") ? id.slice("cursor-".length) : id;
}

/**
 * True when a configured Cursor base model should remain exposed after live GetUsableModels filtering.
 * Live ids are full effort-suffixed variants (`claude-4.6-opus-high`); base ids match exactly or by prefix.
 */
export function isCursorModelAvailableForAccount(modelId: string, liveIds: readonly string[]): boolean {
  return liveIds.some(raw => {
    const id = stripCursorWirePrefix(raw);
    if (id === modelId) return true;
    const effortPrefix = `${modelId}-`;
    return id.startsWith(effortPrefix) && CANONICAL_EFFORT_SUFFIXES.has(id.slice(effortPrefix.length));
  });
}

/** Codex-facing id for Cursor's auto-router. Always kept in the catalog even when live discovery omits it. */
export const CURSOR_AUTO_MODEL_ID = "auto";

/** Wire id Cursor Connect expects for the auto-router (GetUsableModels returns `default`, not `auto`). */
export const CURSOR_AUTO_WIRE_MODEL_ID = "default";

/** Map a Codex-facing Cursor model id to the upstream wire id. */
export function cursorCodexToWireModelId(modelId: string): string {
  const normalized = modelId.startsWith("cursor/") ? modelId.slice("cursor/".length) : modelId;
  return normalized === CURSOR_AUTO_MODEL_ID ? CURSOR_AUTO_WIRE_MODEL_ID : normalized;
}

/** Filter the static Cursor seed to models this account can use. */
export function filterCursorConfiguredModelsByLiveDiscovery<T extends { id: string }>(
  configured: readonly T[],
  liveIds: readonly string[],
): T[] {
  return configured.filter(model =>
    model.id === CURSOR_AUTO_MODEL_ID || isCursorModelAvailableForAccount(model.id, liveIds),
  );
}

export const CURSOR_STATIC_MODELS: readonly CursorModelInfo[] = normalizeCursorModels([
  // Context windows and the model lineup mirror Cursor's public models/pricing docs plus the jawcode
  // SOT (../jawcode/packages/ai/src/models.json, `cursor` provider), which mirrors the real
  // GetUsableModels catalog. Live discovery is the preferred path when logged in; these ids seed the
  // routed Codex catalog and provide a static fallback. Cursor base ids carry no effort suffix here —
  // the request builder appends the per-model suffix (see effort-map.ts) and reasoning models
  // advertise effort so Codex exposes the tier picker. `supportsReasoningEffort` tracks whether the
  // model has *selectable effort tiers* (CURSOR_MODEL_EFFORT_TIERS), NOT merely whether it reasons:
  // gemini/grok/kimi/gpt-5-mini are reasoning models in the SOT but are sent bare (no tier picker).
  { id: "auto", contextWindow: CONTEXT_200K, supportsReasoningEffort: false },

  { id: "claude-sonnet-5", contextWindow: CONTEXT_200K, supportsReasoningEffort: true },
  { id: "claude-4-sonnet", contextWindow: CONTEXT_200K },
  { id: "claude-4-sonnet-1m", contextWindow: CONTEXT_1M },
  { id: "claude-4.5-haiku", contextWindow: CONTEXT_200K },
  { id: "claude-4.5-sonnet", contextWindow: CONTEXT_200K },
  { id: "claude-4.5-opus", contextWindow: CONTEXT_200K, supportsReasoningEffort: true },
  { id: "claude-4.6-opus", contextWindow: CONTEXT_200K, supportsReasoningEffort: true },
  { id: "claude-4.6-sonnet", contextWindow: CONTEXT_200K, supportsReasoningEffort: true },
  { id: "claude-opus-4-7", contextWindow: CONTEXT_200K, supportsReasoningEffort: true },
  // opus-4-7-fast: effort-suffix tiers unverified -> no tier picker; sent bare like live-only ids.
  { id: "claude-opus-4-7-fast", contextWindow: CONTEXT_200K },
  { id: "claude-opus-4-8", contextWindow: CONTEXT_200K, supportsReasoningEffort: true },
  { id: "claude-fable-5", contextWindow: CONTEXT_200K, supportsReasoningEffort: true },

  { id: "composer-1", contextWindow: CONTEXT_200K },
  { id: "composer-2.5", contextWindow: CONTEXT_200K },
  { id: "composer-2.5-fast", contextWindow: CONTEXT_200K },

  { id: "gemini-2.5-flash", contextWindow: CONTEXT_GEMINI },
  { id: "gemini-3-flash", contextWindow: CONTEXT_GEMINI },
  { id: "gemini-3-pro", contextWindow: CONTEXT_GEMINI },
  { id: "gemini-3-pro-image-preview", contextWindow: CONTEXT_200K },
  { id: "gemini-3.1-pro", contextWindow: CONTEXT_GEMINI },
  { id: "gemini-3.5-flash", contextWindow: CONTEXT_200K },

  { id: "gpt-5-codex", contextWindow: CONTEXT_272K },
  { id: "gpt-5-fast", contextWindow: CONTEXT_272K },
  { id: "gpt-5-mini", contextWindow: CONTEXT_272K },
  { id: "gpt-5.1", contextWindow: CONTEXT_272K, supportsReasoningEffort: true },
  { id: "gpt-5.1-codex", contextWindow: CONTEXT_272K },
  { id: "gpt-5.1-codex-max", contextWindow: CONTEXT_272K, supportsReasoningEffort: true },
  { id: "gpt-5.1-codex-mini", contextWindow: CONTEXT_272K, supportsReasoningEffort: true },
  { id: "gpt-5.2", contextWindow: CONTEXT_272K, supportsReasoningEffort: true },
  { id: "gpt-5.2-codex", contextWindow: CONTEXT_272K, supportsReasoningEffort: true },
  { id: "gpt-5.3-codex", contextWindow: CONTEXT_272K, supportsReasoningEffort: true },
  { id: "gpt-5.4", contextWindow: CONTEXT_272K, supportsReasoningEffort: true },
  { id: "gpt-5.4-mini", contextWindow: CONTEXT_272K, supportsReasoningEffort: true },
  { id: "gpt-5.4-nano", contextWindow: CONTEXT_272K, supportsReasoningEffort: true },
  { id: "gpt-5.5", contextWindow: CONTEXT_272K, supportsReasoningEffort: true },
  // gpt-5.5-extra: absent from cursor.com docs but SURVIVES the live GetUsableModels filter
  // (account-verified 260709, devlog/model_update/260709_model_refresh/004_live_snapshot.md).
  { id: "gpt-5.5-extra", contextWindow: CONTEXT_200K, supportsReasoningEffort: true },
  { id: "gpt-5.6-sol", contextWindow: CONTEXT_1M, supportsReasoningEffort: true },
  { id: "gpt-5.6-terra", contextWindow: CONTEXT_1M, supportsReasoningEffort: true },
  { id: "gpt-5.6-luna", contextWindow: CONTEXT_1M, supportsReasoningEffort: true },

  // 260709 refresh: stale grok/composer/kimi/gpt ids dropped per current cursor.com docs; the
  // 260709 note: grok-4.5 was deferred; confirmed live 260708 (cursor.com/models, xAI launch).

  // Conflict resolution (260709): keep the refreshed 1M context + kimi-k2.7-code from de12fc8,
  // take PR #73's supportsReasoningEffort for glm-5.2 (its effort-map tiers landed with the PR).
  { id: "glm-5.2", contextWindow: CONTEXT_1M, supportsReasoningEffort: true },
  { id: "kimi-k2.7-code", contextWindow: CONTEXT_262K },

  { id: "grok-4.5", contextWindow: 500_000, supportsReasoningEffort: true },
  { id: "grok-4.5-fast", contextWindow: 500_000 },
]);

export function cursorModelIds(models: readonly CursorModelInfo[] = CURSOR_STATIC_MODELS): string[] {
  return normalizeCursorModels(models).map(model => model.id);
}

export function cursorModelContextWindows(
  models: readonly CursorModelInfo[] = CURSOR_STATIC_MODELS,
): Record<string, number> {
  return Object.fromEntries(
    normalizeCursorModels(models).map(model => [model.id, model.contextWindow ?? inferCursorContextWindow(model.id)]),
  );
}

export function cursorModelInputModalities(
  models: readonly CursorModelInfo[] = CURSOR_STATIC_MODELS,
): Record<string, string[]> {
  return Object.fromEntries(
    normalizeCursorModels(models).map(model => [model.id, normalizeInputModalities(model.inputModalities)]),
  );
}

export function cursorModelReasoningEfforts(
  models: readonly CursorModelInfo[] = CURSOR_STATIC_MODELS,
): Record<string, string[]> {
  return Object.fromEntries(
    normalizeCursorModels(models).map(model => [
      model.id,
      model.supportsReasoningEffort === true
        ? cursorModelEffortLadder(model.id) ?? [...CURSOR_REASONING_EFFORTS]
        : [],
    ]),
  );
}
