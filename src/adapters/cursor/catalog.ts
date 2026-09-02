import {
  composeCursorClaudeWireId,
  normalizeCursorClaudeId,
  type NormalizedCursorClaudeId,
} from "./claude-id";

/**
 * Cursor umbrella catalog — the single source of truth for cursor model
 * identities (devlog 260828_cursor_umbrella_catalog).
 *
 * Design (003_design.md, audited): one capability record per BASE model.
 * Thinking / fast / thinking-fast are DIMENSIONS of the base, each with its
 * own effort ladder and wire order, because the live wire really does differ
 * per variant (claude-opus-5-fast stops at high while its thinking-fast runs
 * to max). The umbrella picker row defaults to the thinking variant when one
 * exists; every legacy variant id keeps resolving through the alias grammar.
 *
 * Max Mode is evidence-gated and separate from context-window size: prior
 * live probes (devlog 260822_senpi_cursor_transfer/210+310) found maxMode
 * only on specific variants, so `maxModeVerified` marks bases with proven
 * support (kimi-k3, user-verified) and live `maxModeModels` extends it.
 */

export type CursorVariantKind = "regular" | "thinking" | "fast" | "thinkingFast";

export type CursorThinkingOrder = "thinking-then-effort" | "effort-then-thinking" | "bare";

export interface CursorVariantSpec {
  /** Ascending canonical effort rungs the wire lists for this variant; empty = bare id. */
  readonly levels: readonly string[];
  /** Where the thinking marker sits relative to the effort rung (thinking variants only). */
  readonly order?: CursorThinkingOrder;
  /** Variant-specific quarantine (base-wide quarantine would erase healthy siblings). */
  readonly quarantined?: boolean;
}

export interface CursorCapability {
  readonly variants: Partial<Record<CursorVariantKind, CursorVariantSpec>>;
  /** Which variant the umbrella picker row selects (thinking merges into the base). */
  readonly defaultVariant: CursorVariantKind;
  /**
   * Human picker label, in Cursor's own spelling. Codex would otherwise show the raw
   * routed slug (`cursor/kimi-k3`), because `routedDisplayName` passes it through
   * unchanged for every provider (codex/catalog/sync.ts).
   */
  readonly displayName: string;
  /** Context-window metadata (display/routing only — never implies maxMode). */
  readonly window: number;
  /** Max Mode proven on the wire for this base (static evidence; live maxModeModels unions in). */
  readonly maxModeVerified?: boolean;
  /** Wire prefix required by AgentService/Run for the regular variant (grok families). */
  readonly wirePrefix?: "cursor-";
}

const K = 1_000;
const CONTEXT_200K = 200 * K;
const CONTEXT_256K = 256 * K;
const CONTEXT_272K = 272 * K;
const CONTEXT_500K = 500 * K;
const CONTEXT_1M = 1_000 * K;
/** Gemini publishes the exact power-of-two window, not a rounded 1M. */
const CONTEXT_GEMINI = 1_048_576;

const FULL = ["low", "medium", "high", "xhigh", "max"] as const;
const T = "thinking-then-effort" as const;
const E = "effort-then-thinking" as const;

/**
 * One entry per base model. Ladders mirror the live GetUsableModels roster the
 * retired effort-map recorded (260813-260825 captures); windows follow the
 * per-family table verified against senpi's AvailableModels capture
 * (001_reference_analysis.md).
 */
export const CURSOR_CAPABILITIES: Record<string, CursorCapability> = {
  "claude-4.5-opus": {
    displayName: "Claude Opus 4.5",
    window: CONTEXT_200K,
    defaultVariant: "thinking",
    variants: {
      regular: { levels: ["high"] },
      thinking: { levels: ["high"], order: E },
    },
  },
  "claude-4.6-opus": {
    displayName: "Claude Opus 4.6",
    window: CONTEXT_1M,
    defaultVariant: "thinking",
    variants: {
      regular: { levels: ["high", "max"] },
      thinking: { levels: ["high", "max"], order: E },
    },
  },
  "claude-4.6-sonnet": {
    displayName: "Claude Sonnet 4.6",
    window: CONTEXT_1M,
    defaultVariant: "thinking",
    variants: {
      regular: { levels: ["medium"] },
      thinking: { levels: ["medium"], order: E },
    },
  },
  "claude-4.5-sonnet": {
    displayName: "Claude Sonnet 4.5",
    window: CONTEXT_200K,
    defaultVariant: "thinking",
    variants: {
      regular: { levels: [] },
      thinking: { levels: [], order: "bare" },
    },
  },
  "claude-4-sonnet": {
    displayName: "Claude Sonnet 4",
    window: CONTEXT_200K,
    defaultVariant: "thinking",
    variants: {
      regular: { levels: [] },
      thinking: { levels: [], order: "bare" },
    },
  },
  "claude-fable-5": {
    displayName: "Claude Fable 5",
    window: CONTEXT_1M,
    defaultVariant: "thinking",
    variants: {
      regular: { levels: FULL },
      thinking: { levels: FULL, order: T },
    },
  },
  // Claude Fable 5.1 has one canonical capability row. Saved aliases and the live roster's
  // exact spelling are normalized and round-tripped at the adapter boundary.
  "claude-fable-5-1": {
    displayName: "Claude Fable 5.1",
    window: CONTEXT_1M,
    defaultVariant: "thinking",
    variants: {
      regular: { levels: FULL },
      thinking: { levels: FULL, order: T },
    },
  },
  "claude-sonnet-5": {
    displayName: "Claude Sonnet 5",
    window: CONTEXT_1M,
    defaultVariant: "thinking",
    variants: {
      regular: { levels: FULL },
      thinking: { levels: FULL, order: T },
    },
  },
  "claude-opus-4-7": {
    displayName: "Claude Opus 4.7",
    window: CONTEXT_1M,
    defaultVariant: "thinking",
    variants: {
      regular: { levels: FULL },
      thinking: { levels: FULL, order: T },
      fast: { levels: FULL },
      thinkingFast: { levels: FULL, order: T },
    },
  },
  "claude-opus-4-8": {
    displayName: "Claude Opus 4.8",
    window: CONTEXT_1M,
    defaultVariant: "thinking",
    variants: {
      regular: { levels: FULL },
      thinking: { levels: FULL, order: T },
      fast: { levels: FULL },
      thinkingFast: { levels: FULL, order: T },
    },
  },
  "claude-opus-5": {
    displayName: "Claude Opus 5",
    window: CONTEXT_1M,
    defaultVariant: "thinking",
    variants: {
      // Regular stays quarantined (devlog 260826: dead-model quarantine) while
      // the thinking/fast siblings remain live — quarantine is per-variant.
      regular: { levels: FULL, quarantined: true },
      thinking: { levels: FULL, order: T },
      fast: { levels: ["low", "medium", "high"] },
      thinkingFast: { levels: FULL, order: T },
    },
  },
  "glm-5.2": {
    displayName: "GLM 5.2",
    window: CONTEXT_1M,
    defaultVariant: "regular",
    variants: { regular: { levels: ["high", "max"] } },
  },
  "glm-5.3": {
    displayName: "GLM 5.3",
    window: CONTEXT_1M,
    defaultVariant: "regular",
    variants: { regular: { levels: ["low", "high", "max"] } },
  },
  "gemini-3.6-flash": {
    displayName: "Gemini 3.6 Flash",
    window: CONTEXT_GEMINI,
    defaultVariant: "regular",
    variants: { regular: { levels: ["minimal", "low", "medium", "high"] } },
  },
  "gemini-3.7-flash": {
    displayName: "Gemini 3.7 Flash",
    window: CONTEXT_GEMINI,
    defaultVariant: "regular",
    variants: { regular: { levels: ["low", "medium", "high"] } },
  },
  "gemini-3.8-flash": {
    displayName: "Gemini 3.8 Flash",
    window: CONTEXT_GEMINI,
    defaultVariant: "regular",
    variants: { regular: { levels: ["low", "medium", "high"] } },
  },
  "kimi-k3": {
    displayName: "Kimi K3",
    window: CONTEXT_1M,
    defaultVariant: "regular",
    maxModeVerified: true,
    variants: { regular: { levels: ["low", "high", "max"] } },
  },
  "grok-4.5": {
    displayName: "Cursor Grok 4.5",
    window: CONTEXT_500K,
    defaultVariant: "regular",
    wirePrefix: "cursor-",
    variants: {
      regular: { levels: ["low", "medium", "high"] },
      fast: { levels: ["low", "medium", "high"] },
    },
  },
  "grok-4.6": {
    displayName: "Cursor Grok 4.6",
    window: CONTEXT_500K,
    defaultVariant: "regular",
    wirePrefix: "cursor-",
    variants: {
      regular: { levels: ["low", "medium", "high", "xhigh"] },
      fast: { levels: ["low", "medium", "high", "xhigh"] },
    },
  },
  "gpt-5.1": {
    displayName: "GPT-5.1",
    window: CONTEXT_272K,
    defaultVariant: "regular",
    variants: { regular: { levels: ["low", "high"] } },
  },
  "gpt-5.1-codex-max": {
    displayName: "GPT-5.1 Codex Max",
    window: CONTEXT_272K,
    defaultVariant: "regular",
    variants: { regular: { levels: ["low", "medium", "high", "xhigh"] } },
  },
  "gpt-5.1-codex-mini": {
    displayName: "GPT-5.1 Codex Mini",
    window: CONTEXT_272K,
    defaultVariant: "regular",
    variants: { regular: { levels: ["low", "high"] } },
  },
  "gpt-5.2": {
    displayName: "GPT-5.2",
    window: CONTEXT_272K,
    defaultVariant: "regular",
    variants: { regular: { levels: ["low", "high", "xhigh"] } },
  },
  "gpt-5.2-codex": {
    displayName: "GPT-5.2 Codex",
    window: CONTEXT_272K,
    defaultVariant: "regular",
    variants: { regular: { levels: ["low", "high", "xhigh"] } },
  },
  "gpt-5.3-codex": {
    displayName: "Codex 5.3",
    window: CONTEXT_272K,
    defaultVariant: "regular",
    variants: { regular: { levels: ["low", "high", "xhigh"] } },
  },
  "gpt-5.4": {
    displayName: "GPT-5.4",
    window: CONTEXT_272K,
    defaultVariant: "regular",
    variants: { regular: { levels: ["low", "medium", "high", "xhigh"] } },
  },
  "gpt-5.4-mini": {
    displayName: "GPT-5.4 Mini",
    window: CONTEXT_272K,
    defaultVariant: "regular",
    variants: { regular: { levels: ["low", "medium", "high", "xhigh"] } },
  },
  "gpt-5.4-nano": {
    displayName: "GPT-5.4 Nano",
    window: CONTEXT_272K,
    defaultVariant: "regular",
    variants: { regular: { levels: ["low", "medium", "high", "xhigh"] } },
  },
  "gpt-5.5": {
    displayName: "GPT-5.5",
    window: CONTEXT_272K,
    defaultVariant: "regular",
    variants: { regular: { levels: ["low", "medium", "high"] } },
  },
  "gpt-5.5-extra": {
    displayName: "GPT-5.5 Extra",
    // Live GetUsableModels reports 200K for this row, not the gpt-5 family's 272K
    // (account-verified 260709). The seed carried the measured number; the capability
    // table was approximating from the family.
    window: CONTEXT_200K,
    defaultVariant: "regular",
    variants: { regular: { levels: ["high"] } },
  },
  "gpt-5.6-sol": {
    displayName: "GPT-5.6 Sol",
    window: CONTEXT_1M,
    defaultVariant: "regular",
    variants: { regular: { levels: FULL } },
  },
  "gpt-5.6-terra": {
    displayName: "GPT-5.6 Terra",
    window: CONTEXT_1M,
    defaultVariant: "regular",
    variants: { regular: { levels: FULL } },
  },
  "gpt-5.6-luna": {
    displayName: "GPT-5.6 Luna",
    window: CONTEXT_1M,
    defaultVariant: "regular",
    variants: { regular: { levels: FULL } },
  },
};

const LEVEL_TOKENS = ["extra-high", "minimal", "low", "medium", "high", "xhigh", "max", "none"] as const;

export interface ParsedCursorVariantId {
  readonly baseId: string;
  readonly kind: CursorVariantKind;
  readonly level?: string;
  /** True for synthetic big-context marker ids (`<base>-1m`). */
  readonly ultra: boolean;
  /** True when the id resolved through the capability table (else passthrough). */
  readonly known: boolean;
}

function stripLevelSuffix(id: string): { stem: string; level?: string } {
  // Prefer the parse whose stem is a KNOWN capability, and among known stems
  // the most specific (longest) one: "gpt-5.5-extra-high" must parse as
  // gpt-5.5-extra + high (its real single-rung wire id), not gpt-5.5 +
  // extra-high (A-gate blocker 2 family).
  let fallback: { stem: string; level?: string } | undefined;
  let best: { stem: string; level?: string } | undefined;
  for (const token of LEVEL_TOKENS) {
    if (!id.endsWith(`-${token}`)) continue;
    const candidate = { stem: id.slice(0, -(token.length + 1)), level: token };
    fallback ??= candidate;
    if (CURSOR_CAPABILITIES[candidate.stem] && (best === undefined || candidate.stem.length > best.stem.length)) {
      best = candidate;
    }
  }
  return best ?? fallback ?? { stem: id };
}

/**
 * Parse any cursor-facing id (picker slug tail, legacy variant id, or wire id)
 * into its base + dimensions. Precedence is exact-identity-first so ids like
 * `gpt-5.1-codex-max` and `gpt-5.5-extra` — whose tails collide with effort
 * tokens — never mis-parse (A-gate round-1 blocker 2).
 */
/**
 * Real wire ids that merely END in "-1m" — they are distinct catalog rows the
 * wire serves verbatim, never the synthetic ultra marker (A-gate blocker 2:
 * a real legacy wire identity must not parse as `<base>-1m`).
 */
const REAL_1M_WIRE_IDS: ReadonlySet<string> = new Set(["claude-4-sonnet-1m"]);

export function parseCursorVariantId(rawId: string): ParsedCursorVariantId {
  const id = rawId.trim();
  if (REAL_1M_WIRE_IDS.has(id)) {
    return { baseId: id, kind: "regular", ultra: false, known: false };
  }
  const claude = normalizeCursorClaudeId(id);
  if (claude && CURSOR_CAPABILITIES[claude.canonicalBaseId]) {
    const explicitVariant = claude.thinking || claude.fast || claude.level !== undefined;
    return {
      baseId: claude.canonicalBaseId,
      kind: explicitVariant
        ? claude.thinking ? (claude.fast ? "thinkingFast" : "thinking") : claude.fast ? "fast" : "regular"
        : defaultKindFor(claude.canonicalBaseId),
      ...(claude.level ? { level: claude.level } : {}),
      ultra: false,
      known: true,
    };
  }
  // 1. Exact base identity.
  if (CURSOR_CAPABILITIES[id]) {
    return { baseId: id, kind: defaultKindFor(id), ultra: false, known: true };
  }
  // 2. cursor- wire prefix (regular grok wire forms).
  if (id.startsWith("cursor-")) {
    const inner = parseCursorVariantId(id.slice("cursor-".length));
    if (inner.known) return inner;
  }
  // 3. Synthetic big-context marker.
  if (id.endsWith("-1m")) {
    const baseId = id.slice(0, -"-1m".length);
    if (CURSOR_CAPABILITIES[baseId]) {
      return { baseId, kind: "regular", ultra: true, known: true };
    }
  }
  // 4. Suffix grammar: strip -fast, then thinking/effort markers.
  let stem = id;
  let fast = false;
  if (stem.endsWith("-fast")) {
    fast = true;
    stem = stem.slice(0, -"-fast".length);
  }
  let thinking = false;
  let level: string | undefined;
  const thinkingLevel = /^(.*)-thinking-([a-z-]+)$/.exec(stem);
  if (thinkingLevel && CURSOR_CAPABILITIES[thinkingLevel[1]!] && (LEVEL_TOKENS as readonly string[]).includes(thinkingLevel[2]!)) {
    return finishParse(thinkingLevel[1]!, true, fast, thinkingLevel[2]!);
  }
  const levelThinking = stem.endsWith("-thinking") ? stripLevelSuffix(stem.slice(0, -"-thinking".length)) : undefined;
  if (levelThinking && CURSOR_CAPABILITIES[levelThinking.stem]) {
    return finishParse(levelThinking.stem, true, fast, levelThinking.level);
  }
  if (stem.endsWith("-thinking") && CURSOR_CAPABILITIES[stem.slice(0, -"-thinking".length)]) {
    return finishParse(stem.slice(0, -"-thinking".length), true, fast, undefined);
  }
  const plain = stripLevelSuffix(stem);
  if (plain.level !== undefined && CURSOR_CAPABILITIES[plain.stem]) {
    return finishParse(plain.stem, false, fast, plain.level);
  }
  if (fast && CURSOR_CAPABILITIES[stem]) {
    return finishParse(stem, false, true, undefined);
  }
  void thinking;
  void level;
  // Unknown: passthrough (adapter sends the id unchanged).
  return { baseId: id, kind: "regular", ultra: false, known: false };
}

function finishParse(baseId: string, thinking: boolean, fast: boolean, level: string | undefined): ParsedCursorVariantId {
  const kind: CursorVariantKind = thinking ? (fast ? "thinkingFast" : "thinking") : fast ? "fast" : "regular";
  return { baseId, kind, ...(level !== undefined ? { level } : {}), ultra: false, known: true };
}

function defaultKindFor(baseId: string): CursorVariantKind {
  return CURSOR_CAPABILITIES[baseId]?.defaultVariant ?? "regular";
}

/**
 * Promote a variant to its fast sibling when the base declares one, else leave it alone.
 *
 * Thinking must map to thinkingFast rather than to the plain fast variant: the umbrella row
 * for a Claude base routes THINKING, and its regular-fast sibling is a different product
 * with a shorter ladder (claude-opus-5-fast stops at high) whose regular family is
 * quarantined. A base with no fast dimension keeps its kind, so Fast degrades to today's
 * behavior instead of erroring.
 */
export function upgradeToFast(baseId: string, kind: CursorVariantKind): CursorVariantKind {
  const variants = CURSOR_CAPABILITIES[baseId]?.variants;
  if (!variants) return kind;
  if (kind === "thinking" || kind === "thinkingFast") {
    return variants.thinkingFast ? "thinkingFast" : kind;
  }
  return variants.fast ? "fast" : kind;
}

/** Bases whose capability declares a fast or thinking-fast variant. */
export function cursorFastCapableBases(): string[] {
  return Object.entries(CURSOR_CAPABILITIES)
    .filter(([, capability]) => capability.variants.fast !== undefined
      || capability.variants.thinkingFast !== undefined)
    .map(([baseId]) => baseId);
}

/**
 * The id to LIST for a base when the global fast switch is on, for clients that have no
 * Fast toggle of their own. Undefined when the base has no fast dimension, so a caller
 * cannot advertise an id that would not route.
 *
 * Composed from the base's defaultVariant rather than a bare `-fast` suffix. Measured: for a
 * thinking-default base, `claude-opus-5-fast` parses back as the REGULAR-fast sibling and
 * resolves to `claude-opus-5-high-fast` — a shorter ladder, in the quarantined regular
 * family, and a different wire from what the Codex toggle sends. The mirror case is equally
 * wrong: grok has no thinkingFast spec, so `grok-4.6-thinking-fast` would fall back to the
 * regular spec and emit a bare `grok-4.6` with no effort and no fast marker at all.
 */
export function cursorFastIdFor(baseId: string): string | undefined {
  const capability = CURSOR_CAPABILITIES[baseId];
  if (!capability) return undefined;
  const kind = upgradeToFast(baseId, capability.defaultVariant);
  if (kind === "thinkingFast") return `${baseId}-thinking-fast`;
  if (kind === "fast") return `${baseId}-fast`;
  return undefined;
}

function normalizeRequestedEffort(reasoning: string | undefined): string | undefined {
  const normalized = reasoning?.toLowerCase();
  return normalized === "ultra" ? "max" : normalized;
}

function codexEffortRank(reasoning: string | undefined): "low" | "medium" | "high" {
  switch (normalizeRequestedEffort(reasoning) ?? "") {
    case "none":
    case "minimal":
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
    case "max":
    case "xhigh":
      return "high";
    default:
      return "high";
  }
}

/** Pick this variant's effort rung for a Codex reasoning label: literal-first, else rank clamp. */
export function cursorVariantEffort(spec: CursorVariantSpec, reasoning: string | undefined): string | undefined {
  if (spec.levels.length === 0) return undefined;
  const requested = normalizeRequestedEffort(reasoning);
  if (requested && spec.levels.includes(requested)) return requested;
  switch (codexEffortRank(reasoning)) {
    case "low":
      return spec.levels[0];
    case "high":
      return spec.levels[spec.levels.length - 1];
    case "medium":
      return spec.levels[Math.floor((spec.levels.length - 1) / 2)];
  }
}

export interface CursorResolvedSelection {
  /** Flattened wire id for AgentService/Run (with any required cursor- prefix). */
  readonly wireId: string;
  /** Canonical prefix-free id for discovery/catalog comparison. */
  readonly canonicalId: string;
  /** True when the request should raise the Max Mode wire flag (evidence-gated). */
  readonly maxMode: boolean;
  readonly known: boolean;
}

type CursorLiveClaudeWireIdentity = Pick<NormalizedCursorClaudeId, "sourceBaseId" | "spelling">;

/**
 * Compose a variant's flattened wire id, reproducing the legacy effort-map
 * order rules exactly (thinking-then-effort / effort-then-thinking / bare;
 * fast marker terminal; wrong order is ERROR_BAD_MODEL_NAME on the wire).
 */
function composeWireId(
  baseId: string,
  kind: CursorVariantKind,
  effort: string | undefined,
  claudeIdentity?: CursorLiveClaudeWireIdentity,
): string {
  const capability = CURSOR_CAPABILITIES[baseId];
  const spec = capability?.variants[kind];
  if (!capability || !spec) return baseId;
  const thinking = kind === "thinking" || kind === "thinkingFast";
  const fast = kind === "fast" || kind === "thinkingFast";
  if (claudeIdentity) {
    return composeCursorClaudeWireId(claudeIdentity, {
      thinking,
      fast,
      effort,
      bareThinking: spec.order === "bare",
    });
  }
  if (thinking) {
    const order = spec.order ?? "thinking-then-effort";
    if (order === "bare" || effort === undefined) return `${baseId}-thinking`;
    if (order === "effort-then-thinking") return `${baseId}-${effort}-thinking`;
    return fast ? `${baseId}-thinking-${effort}-fast` : `${baseId}-thinking-${effort}`;
  }
  if (effort === undefined) return fast ? `${baseId}-fast` : baseId;
  return fast ? `${baseId}-${effort}-fast` : `${baseId}-${effort}`;
}

/**
 * Resolve any picked cursor id + Codex reasoning effort to the wire identity.
 * Legacy slugs (thinking/fast/-1m variants) keep resolving forever — picker
 * rows shrink, routability does not (alias-retention contract, 003).
 *
 * `liveMaxModeIds` optionally extends the static maxMode evidence with the
 * bases the live GetUsableModels roster flags (union semantics).
 */
export function resolveCursorSelection(
  pickedId: string,
  reasoning: string | undefined,
  liveMaxModeIds?: ReadonlySet<string>,
  options: { fast?: boolean } = {},
): CursorResolvedSelection {
  const parsed = parseCursorVariantId(pickedId);
  if (!parsed.known) {
    return { wireId: pickedId, canonicalId: pickedId, maxMode: false, known: false };
  }
  const capability = CURSOR_CAPABILITIES[parsed.baseId]!;
  // Codex's Fast toggle is a variant switch here; every later read must use the upgraded
  // kind, not parsed.kind, or the wire id loses its -fast marker (or keeps the cursor-
  // prefix that only the regular variant takes).
  const kind = options.fast === true ? upgradeToFast(parsed.baseId, parsed.kind) : parsed.kind;
  const spec = capability.variants[kind] ?? capability.variants.regular;
  if (!spec) {
    return { wireId: parsed.baseId, canonicalId: parsed.baseId, maxMode: false, known: true };
  }
  const requested = parsed.level ?? reasoning;
  const effort = cursorVariantEffort(spec, requested);
  const requestedClaude = normalizeCursorClaudeId(pickedId);
  const claudeIdentity = liveCursorClaudeWireIdentities.get(parsed.baseId)
    ?? (requestedClaude
      ? { sourceBaseId: requestedClaude.sourceBaseId, spelling: requestedClaude.spelling }
      : undefined);
  const canonicalId = composeWireId(parsed.baseId, kind, effort, claudeIdentity);
  const wireId = capability.wirePrefix && kind === "regular"
    ? `${capability.wirePrefix}${canonicalId}`
    : canonicalId;
  const ultraRequested = parsed.ultra || reasoning?.toLowerCase() === "ultra";
  const evidence = liveMaxModeIds ?? liveCursorMaxModeBases;
  const maxModeArmed = capability.maxModeVerified === true || evidence.has(parsed.baseId);
  return { wireId, canonicalId, maxMode: ultraRequested && maxModeArmed, known: true };
}

/**
 * Live Max-Mode evidence (GetUsableModels maxModeModels). Provider discovery
 * records the BASES the live roster flags; the resolver unions this with the
 * static `maxModeVerified` gate so ultra generalizes automatically as evidence
 * arrives — never from window size (devlog 260828 blocker-4 fold).
 */
let liveCursorMaxModeBases: ReadonlySet<string> = new Set();
let liveCursorClaudeWireIdentities: ReadonlyMap<string, CursorLiveClaudeWireIdentity> = new Map();

export function recordLiveCursorClaudeModels(liveIds: readonly string[]): void {
  const next = new Map<string, CursorLiveClaudeWireIdentity>();
  for (const rawId of liveIds) {
    const n = normalizeCursorClaudeId(rawId.startsWith("cursor-") ? rawId.slice(7) : rawId);
    if (!n || !CURSOR_CAPABILITIES[n.canonicalBaseId]) continue;
    if (!next.has(n.canonicalBaseId)) next.set(n.canonicalBaseId, { sourceBaseId: n.sourceBaseId, spelling: n.spelling });
  }
  liveCursorClaudeWireIdentities = next;
}

export function liveCursorClaudeWireIdentitiesForTests(): ReadonlyMap<string, CursorLiveClaudeWireIdentity> {
  return liveCursorClaudeWireIdentities;
}

export function resetLiveCursorClaudeWireIdentitiesForTests(): void {
  liveCursorClaudeWireIdentities = new Map();
}

export function recordLiveCursorMaxModeModels(liveIds: readonly string[]): void {
  const bases = new Set<string>();
  for (const id of liveIds) {
    const parsed = parseCursorVariantId(id);
    if (parsed.known) bases.add(parsed.baseId);
  }
  liveCursorMaxModeBases = bases;
}

export function liveCursorMaxModeBasesForTests(): ReadonlySet<string> {
  return liveCursorMaxModeBases;
}

export interface CursorUmbrellaRow {
  readonly id: string;
  readonly displayName: string;
  readonly efforts: readonly string[];
  readonly window: number;
  /** Max Mode evidence present: the ultra rung maps to maxMode on the wire. */
  readonly maxModeVerified: boolean;
}

/**
 * Grok Fast keeps the parameterized wire shape (base id + effort/fast
 * parameters) rather than a flattened -fast id — current Cursor clients send
 * it that way and the flat form is rejected. Returns undefined for every
 * other id.
 */
export function cursorGrokFastSelection(
  pickedId: string,
  reasoning: string | undefined,
  fast?: boolean,
): { wireBaseId: string; effort: string } | undefined {
  const parsed = parseCursorVariantId(pickedId);
  // Both call paths must learn the flag together: if only resolveCursorSelection did, a
  // toggled Grok pick would emit a flattened grok-4.6-high-fast id, which the wire rejects.
  const kind = fast === true ? upgradeToFast(parsed.baseId, parsed.kind) : parsed.kind;
  if (!parsed.known || kind !== "fast") return undefined;
  const capability = CURSOR_CAPABILITIES[parsed.baseId];
  if (capability?.wirePrefix !== "cursor-") return undefined;
  const spec = capability.variants.fast;
  if (!spec) return undefined;
  const effort = cursorVariantEffort(spec, parsed.level ?? reasoning);
  if (effort === undefined) return undefined;
  return { wireBaseId: parsed.baseId, effort };
}

/**
 * The umbrella picker rows: one per base whose default variant is selectable.
 * Thinking merges into the base row; fast/thinking-fast/legacy slugs stay
 * routable as aliases but add no rows. Router ids stay in discovery.
 */
export function cursorUmbrellaRows(): CursorUmbrellaRow[] {
  const rows: CursorUmbrellaRow[] = [];
  for (const [baseId, capability] of Object.entries(CURSOR_CAPABILITIES)) {
    const spec = capability.variants[capability.defaultVariant];
    if (!spec || spec.quarantined) continue;
    rows.push({
      id: baseId,
      displayName: capability.displayName,
      efforts: spec.levels,
      window: capability.window,
      maxModeVerified: capability.maxModeVerified === true,
    });
  }
  return rows;
}
