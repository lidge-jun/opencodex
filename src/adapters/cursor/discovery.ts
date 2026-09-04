import {
  CANONICAL_EFFORT_SUFFIXES,
  cursorModelEffortLadder,
  cursorModelHasEffortTiers,
  cursorWireModelIdWithEffort,
  CURSOR_THINKING_MODEL_IDS,
} from "./effort-map";
import { cursorUmbrellaRows, parseCursorVariantId } from "./catalog";

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
  // 260902: every Fable is a 1M model; catch live spellings the seed does not carry.
  if (id.includes("fable")) return CONTEXT_1M;
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

/**
 * Cursor products that are NOT a dimension of any capability base. Each carries its own
 * label because there is no capability record to read one from. A row belongs here only
 * when Cursor ships it as a distinct product; a variant of a cataloged base does not.
 */
export const CURSOR_PRODUCT_MODELS: readonly (CursorModelInfo & { displayName: string })[] = [
  { id: "claude-4.5-haiku", displayName: "Claude Haiku 4.5", contextWindow: CONTEXT_200K },
  { id: "composer-1", displayName: "Composer 1", contextWindow: CONTEXT_200K },
  { id: "composer-2.5", displayName: "Composer 2.5", contextWindow: CONTEXT_200K },
  { id: "gemini-2.5-flash", displayName: "Gemini 2.5 Flash", contextWindow: CONTEXT_GEMINI },
  { id: "gemini-3-flash", displayName: "Gemini 3 Flash", contextWindow: CONTEXT_GEMINI },
  { id: "gemini-3-pro", displayName: "Gemini 3 Pro", contextWindow: CONTEXT_GEMINI },
  { id: "gemini-3-pro-image-preview", displayName: "Gemini 3 Pro Image", contextWindow: CONTEXT_200K },
  { id: "gemini-3.1-pro", displayName: "Gemini 3.1 Pro", contextWindow: CONTEXT_GEMINI },
  { id: "gemini-3.5-flash", displayName: "Gemini 3.5 Flash", contextWindow: CONTEXT_200K },
  { id: "gpt-5-codex", displayName: "GPT-5 Codex", contextWindow: CONTEXT_272K },
  { id: "gpt-5-mini", displayName: "GPT-5 Mini", contextWindow: CONTEXT_272K },
  { id: "gpt-5.1-codex", displayName: "GPT-5.1 Codex", contextWindow: CONTEXT_272K },
  { id: "kimi-k2.7-code", displayName: "Kimi K2.7 Code", contextWindow: CONTEXT_262K },
];

/**
 * Real upstream wire ids that LOOK like a dimension of a cataloged base but are served as
 * their own catalog row by Cursor, so they stay rows rather than folding into a base.
 *
 * - `claude-4-sonnet-1m`: a distinct 1M-window row upstream, not `claude-4-sonnet` + ultra.
 *   claude-4-sonnet carries no maxMode evidence, so folding it would invent a capability.
 *   `REAL_1M_WIRE_IDS` in catalog.ts already stops the parser reading it as the synthetic
 *   marker.
 * - `gpt-5-fast`: there is no `gpt-5` capability base for it to be a dimension of.
 * - `composer-2.5-fast`: composer-2.5 has no effort or variant dimensions at all.
 */
export const CURSOR_REAL_ID_EXCEPTIONS: readonly (CursorModelInfo & { displayName: string })[] = [
  { id: "claude-4-sonnet-1m", displayName: "Claude Sonnet 4 (1M)", contextWindow: CONTEXT_1M },
  { id: "gpt-5-fast", displayName: "GPT-5 Fast", contextWindow: CONTEXT_272K },
  { id: "composer-2.5-fast", displayName: "Composer 2.5 Fast", contextWindow: CONTEXT_200K },
];

/** Picker labels for the auto-router rows, which have no capability record. */
const CURSOR_ROUTER_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  auto: "Auto",
  "auto-cost": "Auto (Cost)",
  "auto-balance": "Auto (Balanced)",
  "auto-intelligence": "Auto (Intelligence)",
};

/**
 * The published Cursor row set. DERIVED from CURSOR_CAPABILITIES via cursorUmbrellaRows()
 * (devlog 260902_cursor_unified_identity) so the capability table and the picker can no
 * longer disagree: one row per base, with thinking / fast / synthetic -1m remaining
 * routable aliases that add no rows.
 *
 * Before this, the seed was a hand-maintained list that drifted from the capability table —
 * `cursorUmbrellaRows()` existed but only tests called it, so collapsing a variant changed
 * routing without changing what Codex listed.
 *
 * Windows and effort ladders come from the capability record; the two lists below carry the
 * ids that have no capability record, each with its own label and window.
 */
export const CURSOR_STATIC_MODELS: readonly CursorModelInfo[] = normalizeCursorModels([
  ...CURSOR_ROUTER_MODEL_IDS.map(id => ({ id, contextWindow: CONTEXT_200K, supportsReasoningEffort: false })),
  ...cursorUmbrellaRows().map(row => ({
    id: row.id,
    contextWindow: row.window,
    supportsReasoningEffort: row.efforts.length > 0,
  })),
  ...CURSOR_PRODUCT_MODELS,
  ...CURSOR_REAL_ID_EXCEPTIONS,
]);

/**
 * Picker labels for providers.cursor.modelDisplayNames.
 *
 * Only labels that carry Cursor's own product name ("Cursor Grok 4.6") are published. Every
 * other row keeps the routed `cursor/<id>` slug that the rest of the picker uses, so a Cursor
 * row reads like its siblings from other providers instead of an unprefixed marketing name.
 * #3222 labeled every row and that dropped the `cursor/` prefix from the picker.
 */
export function cursorModelDisplayNames(): Record<string, string> {
  const labels: (readonly [string, string])[] = [
    ...CURSOR_ROUTER_MODEL_IDS.map(id => [id, CURSOR_ROUTER_DISPLAY_NAMES[id] ?? id] as const),
    ...cursorUmbrellaRows().map(row => [row.id, row.displayName] as const),
    ...CURSOR_PRODUCT_MODELS.map(model => [model.id, model.displayName] as const),
    ...CURSOR_REAL_ID_EXCEPTIONS.map(model => [model.id, model.displayName] as const),
  ];
  return Object.fromEntries(labels.filter(([, label]) => isCursorBrandedLabel(label)));
}

/** A label Cursor itself brands with its name, e.g. "Cursor Grok 4.6". */
export function isCursorBrandedLabel(label: string): boolean {
  return /^cursor\b/i.test(label.trim());
}

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
