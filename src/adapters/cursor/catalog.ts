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
    window: CONTEXT_200K,
    defaultVariant: "thinking",
    variants: {
      regular: { levels: ["high"] },
      thinking: { levels: ["high"], order: E },
    },
  },
  "claude-4.6-opus": {
    window: CONTEXT_1M,
    defaultVariant: "thinking",
    variants: {
      regular: { levels: ["high", "max"] },
      thinking: { levels: ["high", "max"], order: E },
    },
  },
  "claude-4.6-sonnet": {
    window: CONTEXT_1M,
    defaultVariant: "thinking",
    variants: {
      regular: { levels: ["medium"] },
      thinking: { levels: ["medium"], order: E },
    },
  },
  "claude-4.5-sonnet": {
    window: CONTEXT_200K,
    defaultVariant: "thinking",
    variants: {
      regular: { levels: [] },
      thinking: { levels: [], order: "bare" },
    },
  },
  "claude-4-sonnet": {
    window: CONTEXT_200K,
    defaultVariant: "thinking",
    variants: {
      regular: { levels: [] },
      thinking: { levels: [], order: "bare" },
    },
  },
  "claude-fable-5": {
    window: CONTEXT_1M,
    defaultVariant: "thinking",
    variants: {
      regular: { levels: FULL },
      thinking: { levels: FULL, order: T },
    },
  },
  "claude-sonnet-5": {
    window: CONTEXT_1M,
    defaultVariant: "thinking",
    variants: {
      regular: { levels: FULL },
      thinking: { levels: FULL, order: T },
    },
  },
  "claude-opus-4-7": {
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
    window: CONTEXT_1M,
    defaultVariant: "regular",
    variants: { regular: { levels: ["high", "max"] } },
  },
  "glm-5.3": {
    window: CONTEXT_1M,
    defaultVariant: "regular",
    variants: { regular: { levels: ["low", "high", "max"] } },
  },
  "gemini-3.6-flash": {
    window: CONTEXT_1M,
    defaultVariant: "regular",
    variants: { regular: { levels: ["minimal", "low", "medium", "high"] } },
  },
  "gemini-3.7-flash": {
    window: CONTEXT_1M,
    defaultVariant: "regular",
    variants: { regular: { levels: ["low", "medium", "high"] } },
  },
  "kimi-k3": {
    window: CONTEXT_1M,
    defaultVariant: "regular",
    maxModeVerified: true,
    variants: { regular: { levels: ["low", "high", "max"] } },
  },
  "grok-4.5": {
    window: CONTEXT_500K,
    defaultVariant: "regular",
    wirePrefix: "cursor-",
    variants: {
      regular: { levels: ["low", "medium", "high"] },
      fast: { levels: ["low", "medium", "high"] },
    },
  },
  "grok-4.6": {
    window: CONTEXT_500K,
    defaultVariant: "regular",
    wirePrefix: "cursor-",
    variants: {
      regular: { levels: ["low", "medium", "high", "xhigh"] },
      fast: { levels: ["low", "medium", "high", "xhigh"] },
    },
  },
  "gpt-5.1": {
    window: CONTEXT_272K,
    defaultVariant: "regular",
    variants: { regular: { levels: ["low", "high"] } },
  },
  "gpt-5.1-codex-max": {
    window: CONTEXT_272K,
    defaultVariant: "regular",
    variants: { regular: { levels: ["low", "medium", "high", "xhigh"] } },
  },
  "gpt-5.1-codex-mini": {
    window: CONTEXT_272K,
    defaultVariant: "regular",
    variants: { regular: { levels: ["low", "high"] } },
  },
  "gpt-5.2": {
    window: CONTEXT_272K,
    defaultVariant: "regular",
    variants: { regular: { levels: ["low", "high", "xhigh"] } },
  },
  "gpt-5.2-codex": {
    window: CONTEXT_272K,
    defaultVariant: "regular",
    variants: { regular: { levels: ["low", "high", "xhigh"] } },
  },
  "gpt-5.3-codex": {
    window: CONTEXT_272K,
    defaultVariant: "regular",
    variants: { regular: { levels: ["low", "high", "xhigh"] } },
  },
  "gpt-5.4": {
    window: CONTEXT_272K,
    defaultVariant: "regular",
    variants: { regular: { levels: ["low", "medium", "high", "xhigh"] } },
  },
  "gpt-5.4-mini": {
    window: CONTEXT_272K,
    defaultVariant: "regular",
    variants: { regular: { levels: ["low", "medium", "high", "xhigh"] } },
  },
  "gpt-5.4-nano": {
    window: CONTEXT_272K,
    defaultVariant: "regular",
    variants: { regular: { levels: ["low", "medium", "high", "xhigh"] } },
  },
  "gpt-5.5": {
    window: CONTEXT_272K,
    defaultVariant: "regular",
    variants: { regular: { levels: ["low", "medium", "high"] } },
  },
  "gpt-5.5-extra": {
    window: CONTEXT_272K,
    defaultVariant: "regular",
    variants: { regular: { levels: ["high"] } },
  },
  "gpt-5.6-sol": {
    window: CONTEXT_1M,
    defaultVariant: "regular",
    variants: { regular: { levels: FULL } },
  },
  "gpt-5.6-terra": {
    window: CONTEXT_1M,
    defaultVariant: "regular",
    variants: { regular: { levels: FULL } },
  },
  "gpt-5.6-luna": {
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
  // 1. Exact base identity.
  if (CURSOR_CAPABILITIES[id]) {
    return { baseId: id, kind: defaultKindFor(id), ultra: false, known: true };
  }
  if (REAL_1M_WIRE_IDS.has(id)) {
    return { baseId: id, kind: "regular", ultra: false, known: false };
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

/**
 * Compose a variant's flattened wire id, reproducing the legacy effort-map
 * order rules exactly (thinking-then-effort / effort-then-thinking / bare;
 * fast marker terminal; wrong order is ERROR_BAD_MODEL_NAME on the wire).
 */
function composeWireId(baseId: string, kind: CursorVariantKind, effort: string | undefined): string {
  const capability = CURSOR_CAPABILITIES[baseId];
  const spec = capability?.variants[kind];
  if (!capability || !spec) return baseId;
  const thinking = kind === "thinking" || kind === "thinkingFast";
  const fast = kind === "fast" || kind === "thinkingFast";
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
): CursorResolvedSelection {
  const parsed = parseCursorVariantId(pickedId);
  if (!parsed.known) {
    return { wireId: pickedId, canonicalId: pickedId, maxMode: false, known: false };
  }
  const capability = CURSOR_CAPABILITIES[parsed.baseId]!;
  const spec = capability.variants[parsed.kind] ?? capability.variants.regular;
  if (!spec) {
    return { wireId: parsed.baseId, canonicalId: parsed.baseId, maxMode: false, known: true };
  }
  const requested = parsed.level ?? reasoning;
  const effort = cursorVariantEffort(spec, requested);
  const canonicalId = composeWireId(parsed.baseId, parsed.kind, effort);
  const wireId = capability.wirePrefix && parsed.kind === "regular"
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
): { wireBaseId: string; effort: string } | undefined {
  const parsed = parseCursorVariantId(pickedId);
  if (!parsed.known || parsed.kind !== "fast") return undefined;
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
      efforts: spec.levels,
      window: capability.window,
      maxModeVerified: capability.maxModeVerified === true,
    });
  }
  return rows;
}
