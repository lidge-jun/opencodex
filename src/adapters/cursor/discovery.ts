import {
  CANONICAL_EFFORT_SUFFIXES,
  cursorModelEffortLadder,
  cursorModelHasEffortTiers,
  cursorWireModelIdWithEffort,
  CURSOR_THINKING_MODEL_IDS,
} from "./effort-map";
import { parseCursorVariantId } from "./catalog";

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
  if (id === "glm-5.3" || id === "glm-5.2") return CONTEXT_1M;
  if (id.startsWith("gpt-5.6-")) return CONTEXT_1M;
  if (id.startsWith("gpt-5") || id === "gpt-5-codex") return CONTEXT_272K;
  if (id.startsWith("grok-4.5") || id.startsWith("grok-4.6")) return 500_000;
  if (id.startsWith("grok-")) return CONTEXT_256K;
  if (id.includes("claude")) return CONTEXT_200K;
  return CURSOR_DEFAULT_CONTEXT_WINDOW;
}

function normalizeInputModalities(input: string[] | undefined): string[] {
  const values = (input ?? [...CURSOR_DEFAULT_INPUT_MODALITIES])
    .map(item => item.trim())
    .filter(Boolean);
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
 * Live ids are full effort-suffixed variants (`claude-4.6-opus-high`); base ids match exactly, the
 * ordinary `{base}-{effort}` form, or Cursor's current `{base-without-fast}-{effort}-fast` form.
 */
export function isCursorModelAvailableForAccount(modelId: string, liveIds: readonly string[]): boolean {
  // Umbrella matching (devlog 260828_cursor_umbrella_catalog): a live suffix
  // id counts toward its BASE — any variant dimension (thinking/fast/effort)
  // proves the account can reach the umbrella. Unknown ids fall back to the
  // legacy exact/suffix comparison so non-cataloged rows keep matching.
  const parsedTarget = parseCursorVariantId(modelId);
  return liveIds.some(raw => {
    const id = stripCursorWirePrefix(raw);
    if (id === modelId) return true;
    const parsedLive = parseCursorVariantId(id);
    if (parsedLive.known && parsedTarget.known && parsedLive.baseId === parsedTarget.baseId) return true;
    for (const effort of CANONICAL_EFFORT_SUFFIXES) {
      if (
        id === `${modelId}-${effort}` ||
        id === cursorWireModelIdWithEffort(modelId, effort)
      ) return true;
    }
    return false;
  });
}

/** Codex-facing id for Cursor's auto-router. Always kept in the catalog even when live discovery omits it. */
export const CURSOR_AUTO_MODEL_ID = "auto";

/** Cursor Router's public optimization modes (cost -> intelligence Pareto frontier). */
export const CURSOR_ROUTING_LEVELS = ["cost", "balance", "intelligence"] as const;
export type CursorRoutingLevel = typeof CURSOR_ROUTING_LEVELS[number];

/**
 * Codex cannot render Cursor's model-specific parameter control, so expose each optimization mode
 * as a first-class routed model next to the backwards-compatible `cursor/auto` entry.
 */
export const CURSOR_ROUTER_MODEL_IDS = [
  CURSOR_AUTO_MODEL_ID,
  ...CURSOR_ROUTING_LEVELS.map(level => `${CURSOR_AUTO_MODEL_ID}-${level}`),
] as const;

/**
 * Cursor models that cannot see images natively. OpenCodex routes them through the vision
 * sidecar (the catalog still advertises image so Codex can attach). Evidence:
 * - Composer family: Cursor staff — text-only; "Model does not support images"
 * - Auto / router modes: Cursor docs omit Images for Auto Cost; staff — pick Claude/GPT for images
 * - glm-5.2: Cursor docs omit Images; Z.ai GLM-5.2 is text-only (vision is GLM-5V)
 * - glm-5.3: same family; seeded as text-only ahead of Cursor's lineup update
 *
 * Composer ids are enumerated explicitly — prefix wildcard matching is deliberately out of
 * scope here; a live-discovered new Composer slug stays native-path until curated. Everyone
 * else in the static seed (Claude, Gemini, GPT, Kimi, Grok) takes SelectedImage. Other
 * live-discovered ids stay unclassified (native path) until curated.
 */
export const CURSOR_NO_VISION_MODELS = [
  ...CURSOR_ROUTER_MODEL_IDS,
  "composer-1",
  "composer-2.5",
  "composer-2.5-fast",
  "glm-5.2",
  "glm-5.3",
] as const;

/** Wire id Cursor Connect expects for the auto-router (GetUsableModels returns `default`, not `auto`). */
export const CURSOR_AUTO_WIRE_MODEL_ID = "default";

export interface CursorWireModelSelection {
  modelId: string;
  routingLevel?: CursorRoutingLevel;
}

/** Resolve a Codex-facing model id into Cursor's wire model plus optional router parameter. */
export function cursorWireModelSelection(modelId: string): CursorWireModelSelection {
  const normalized = modelId.startsWith("cursor/") ? modelId.slice("cursor/".length) : modelId;
  if (normalized === CURSOR_AUTO_MODEL_ID) return { modelId: CURSOR_AUTO_WIRE_MODEL_ID };
  const prefix = `${CURSOR_AUTO_MODEL_ID}-`;
  if (normalized.startsWith(prefix)) {
    const level = normalized.slice(prefix.length);
    if ((CURSOR_ROUTING_LEVELS as readonly string[]).includes(level)) {
      return { modelId: CURSOR_AUTO_WIRE_MODEL_ID, routingLevel: level as CursorRoutingLevel };
    }
  }
  return { modelId: normalized };
}

/** Map a Codex-facing Cursor model id to the upstream wire id. */
export function cursorCodexToWireModelId(modelId: string): string {
  return cursorWireModelSelection(modelId).modelId;
}

/**
 * Synthetic ultra/big-context picker marker (devlog 260826 070). A `cursor/<base>-1m` row is a
 * picker-only variant: the wire request keeps `<base>` (plus effort suffix) and turns on Cursor
 * Max Mode instead. Only ids listed here are treated as synthetic — a real upstream wire id that
 * happens to end in `-1m` never collides because it will not be in this set.
 */
export const CURSOR_ULTRA_1M_MODEL_IDS: ReadonlySet<string> = new Set([
  "kimi-k3-1m",
]);

const CURSOR_ULTRA_1M_SUFFIX = "-1m";

/** Resolve a synthetic ultra marker id to its wire base, or undefined for ordinary ids. */
export function cursorUltraBaseModelId(modelId: string): string | undefined {
  const normalized = modelId.startsWith("cursor/") ? modelId.slice("cursor/".length) : modelId;
  if (!CURSOR_ULTRA_1M_MODEL_IDS.has(normalized)) return undefined;
  return normalized.slice(0, -CURSOR_ULTRA_1M_SUFFIX.length);
}

/**
 * Cursor-native wire models keep server-side conversation state reliably.
 * External models (gpt/claude/gemini/grok families and similar) are more brittle on resumeAction.
 */
export function isCursorNativeWireModel(modelId: string): boolean {
  const wire = cursorCodexToWireModelId(modelId).trim().toLowerCase();
  const bare = stripCursorEffortSuffix(wire);
  if (bare === CURSOR_AUTO_WIRE_MODEL_ID || bare === CURSOR_AUTO_MODEL_ID) return true;
  return bare.startsWith("composer-");
}

/** Inverse of {@link isCursorNativeWireModel}. */
export function isCursorExternalWireModel(modelId: string): boolean {
  return !isCursorNativeWireModel(modelId);
}

/**
 * Native composer models whose tool-result continuation must still be sent as a
 * userMessageAction with the plain "Continue:" text instead of a bare resumeAction.
 *
 * Observed on live Cursor Connect traffic (2026-08-20): `composer-2.5` (the
 * standard, non-fast build) resumes a tool-result turn with server-side native
 * tool calls (read/grep/exec) instead of answering, or completes with zero text
 * (empty `content` + `stop`). `composer-2.5-fast` answers correctly on the same
 * resumeAction path, so only the affected id is listed here. Sending the same
 * continuation as an explicit user message (external path) makes the model
 * answer reliably.
 */
export function cursorNeedsExternalToolContinuation(modelId: string): boolean {
  if (isCursorExternalWireModel(modelId)) return true;
  const wire = cursorCodexToWireModelId(modelId).trim().toLowerCase();
  return wire === "composer-2.5";
}

function stripCursorEffortSuffix(wireModelId: string): string {
  const suffixes = [...CANONICAL_EFFORT_SUFFIXES].sort((a, b) => b.length - a.length);
  for (const suffix of suffixes) {
    const marker = `-${suffix}`;
    if (wireModelId.endsWith(marker)) return wireModelId.slice(0, -marker.length);
  }
  return wireModelId;
}

/** Compare Cursor wire models without effort suffix or the grok cursor- request prefix. */
export function cursorCheckpointModelAffinityId(modelId: string): string {
  const wire = cursorCodexToWireModelId(modelId).trim().toLowerCase();
  const withoutPrefix = wire.startsWith("cursor-") ? wire.slice("cursor-".length) : wire;
  return stripCursorEffortSuffix(withoutPrefix);
}

export function isCursorRouterModelId(modelId: string): boolean {
  return (CURSOR_ROUTER_MODEL_IDS as readonly string[]).includes(modelId);
}

/** Filter the static Cursor seed to models this account can use. */
export function filterCursorConfiguredModelsByLiveDiscovery<T extends { id: string }>(
  configured: readonly T[],
  liveIds: readonly string[],
): T[] {
  return configured.filter(model =>
    !CURSOR_KNOWN_UNCALLABLE_MODEL_IDS.has(model.id)
    && (
      isCursorRouterModelId(model.id)
      // Synthetic ultra rows ride their base model's account availability.
      || isCursorModelAvailableForAccount(cursorUltraBaseModelId(model.id) ?? model.id, liveIds)
    ),
  );
}

/**
 * Models GetUsableModels advertises but whose every Run returns not_found (catalog honesty,
 * devlog 260826_cursor_responses_gap 060). The claude-opus-5 REGULAR wire family is the known
 * case (probes 2026-08-26: 100% not_found while -fast/-thinking succeed) — under the umbrella
 * catalog (devlog 260828) that quarantine moved to the RESOLVER level: the capability marks the
 * regular VARIANT quarantined, the bare slug routes the healthy thinking variant, and the base
 * row stays in the seed. This row-level set stays for future whole-base quarantines.
 */
export const CURSOR_KNOWN_UNCALLABLE_MODEL_IDS: ReadonlySet<string> = new Set([]);

export const CURSOR_STATIC_MODELS: readonly CursorModelInfo[] = normalizeCursorModels([
  // Context windows and the model lineup mirror Cursor's public models/pricing docs plus the jawcode
  // SOT (../jawcode/packages/ai/src/models.json, `cursor` provider), which mirrors the real
  // GetUsableModels catalog. Live discovery is the preferred path when logged in; these ids seed the
  // routed Codex catalog and provide a static fallback. Cursor base ids carry no effort suffix here —
  // the request builder appends the per-model suffix (see effort-map.ts) and reasoning models
  // advertise effort so Codex exposes the tier picker. `supportsReasoningEffort` tracks whether the
  // model has *selectable effort tiers* (CURSOR_MODEL_EFFORT_TIERS), NOT merely whether it reasons:
  // gemini/grok/kimi-k2.7/gpt-5-mini are reasoning models in the SOT but are sent bare (no tier picker).
  ...CURSOR_ROUTER_MODEL_IDS.map(id => ({ id, contextWindow: CONTEXT_200K, supportsReasoningEffort: false })),

  // Umbrella seed (devlog 260828_cursor_umbrella_catalog): one row per BASE
  // model. Thinking merges into the base (the resolver routes the thinking
  // variant); fast / thinking-fast / -1m stay routable as aliases but add no
  // rows. Windows follow CURSOR_CAPABILITIES where the base is cataloged.
  { id: "claude-sonnet-5", contextWindow: CONTEXT_1M, supportsReasoningEffort: true },
  { id: "claude-4-sonnet", contextWindow: CONTEXT_200K },
  { id: "claude-4-sonnet-1m", contextWindow: CONTEXT_1M },
  { id: "claude-4.5-haiku", contextWindow: CONTEXT_200K },
  { id: "claude-4.5-sonnet", contextWindow: CONTEXT_200K },
  { id: "claude-4.5-opus", contextWindow: CONTEXT_200K, supportsReasoningEffort: true },
  { id: "claude-4.6-opus", contextWindow: CONTEXT_1M, supportsReasoningEffort: true },
  { id: "claude-4.6-sonnet", contextWindow: CONTEXT_1M, supportsReasoningEffort: true },
  { id: "claude-opus-4-7", contextWindow: CONTEXT_1M, supportsReasoningEffort: true },
  { id: "claude-opus-4-8", contextWindow: CONTEXT_1M, supportsReasoningEffort: true },
  // claude-opus-5: regular variant is quarantined (not_found on every Run) but
  // the umbrella row routes the THINKING variant, which is live — so the base
  // row returns to the seed under the umbrella (resolver never sends the
  // quarantined regular wire id for the bare slug).
  { id: "claude-opus-5", contextWindow: CONTEXT_1M, supportsReasoningEffort: true },
  { id: "claude-fable-5", contextWindow: CONTEXT_1M, supportsReasoningEffort: true },

  { id: "composer-1", contextWindow: CONTEXT_200K },
  { id: "composer-2.5", contextWindow: CONTEXT_200K },
  { id: "composer-2.5-fast", contextWindow: CONTEXT_200K },

  { id: "gemini-2.5-flash", contextWindow: CONTEXT_GEMINI },
  { id: "gemini-3-flash", contextWindow: CONTEXT_GEMINI },
  { id: "gemini-3-pro", contextWindow: CONTEXT_GEMINI },
  { id: "gemini-3-pro-image-preview", contextWindow: CONTEXT_200K },
  { id: "gemini-3.1-pro", contextWindow: CONTEXT_GEMINI },
  { id: "gemini-3.5-flash", contextWindow: CONTEXT_200K },
  // 260825 live GetUsableModels: both ship only as effort-suffixed ids, so each exposes a tier
  // picker. 3.6 is the only Cursor model with a `minimal` rung.
  { id: "gemini-3.6-flash", contextWindow: CONTEXT_GEMINI, supportsReasoningEffort: true },
  { id: "gemini-3.7-flash", contextWindow: CONTEXT_GEMINI, supportsReasoningEffort: true },

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
  // 260814 preemptive: glm-5.3 seeded ahead of Cursor's lineup update (mirrors glm-5.2).
  { id: "glm-5.3", contextWindow: CONTEXT_1M, supportsReasoningEffort: true },
  { id: "kimi-k2.7-code", contextWindow: CONTEXT_262K },
  // kimi-k3: cursor.com/docs/models/kimi-k3; account-verified via GetUsableModels (2026-07-28) —
  // ships only as effort-suffixed kimi-k3-{low,high,max}, so the tier picker is exposed.
  // kimi-k3 folds the old synthetic kimi-k3-1m row into the umbrella: the base
  // is maxModeVerified (user-verified 1M on the Ultra plan, devlog 260826/025),
  // so the ultra effort rung arms Max Mode on the wire and the separate picker
  // row is gone. cursor/kimi-k3-1m stays routable as an alias.
  { id: "kimi-k3", contextWindow: CONTEXT_1M, supportsReasoningEffort: true },

  { id: "grok-4.5", contextWindow: 500_000, supportsReasoningEffort: true },
  // 260813 preemptive: grok-4.6 seeded ahead of Cursor's lineup update (mirrors grok-4.5).
  { id: "grok-4.6", contextWindow: 500_000, supportsReasoningEffort: true },
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
        ? cursorModelEffortLadder(model.id) ?? []
        : [],
    ]),
  );
}
