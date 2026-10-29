export type CursorClaudeSpelling = "anthropic" | "version-first";

export interface NormalizedCursorClaudeId {
  /** The sole key used by CURSOR_CAPABILITIES and pricing metadata. */
  canonicalBaseId: string;
  /** Exact input stem, preserving `5-1` versus `5.1` for wire round-trips. */
  sourceBaseId: string;
  spelling: CursorClaudeSpelling;
  thinking: boolean;
  fast: boolean;
  level?: string;
}

const CLAUDE_LEVELS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "extra-high"]);

/** Existing picker bases whose canonical key stays version-first (saved configs). */
const VERSION_FIRST_CANONICAL_BASES = new Set([
  "claude-4.5-haiku", "claude-4.5-opus", "claude-4.6-opus", "claude-4.5-sonnet", "claude-4.6-sonnet", "claude-4-sonnet",
]);

function parseClaudeBase(raw: string): { canonicalBaseId: string; sourceBaseId: string; spelling: CursorClaudeSpelling } | undefined {
  const anthropic = /^claude-(fable|haiku|opus|sonnet)-(\d+(?:[.-]\d+)*)$/.exec(raw);
  if (anthropic) {
    const family = anthropic[1]!;
    const version = anthropic[2]!.replaceAll(".", "-");
    const versionFirst = `claude-${version.replaceAll("-", ".")}-${family}`;
    return {
      canonicalBaseId: VERSION_FIRST_CANONICAL_BASES.has(versionFirst) ? versionFirst : `claude-${family}-${version}`,
      sourceBaseId: raw,
      spelling: "anthropic",
    };
  }
  const versionFirst = /^claude-(\d+(?:\.\d+)*)-(fable|haiku|opus|sonnet)$/.exec(raw);
  if (!versionFirst) return undefined;
  const sourceBaseId = `claude-${versionFirst[1]!}-${versionFirst[2]!}`;
  return {
    canonicalBaseId: VERSION_FIRST_CANONICAL_BASES.has(sourceBaseId) ? sourceBaseId : `claude-${versionFirst[2]!}-${versionFirst[1]!.replaceAll(".", "-")}`,
    sourceBaseId,
    spelling: "version-first",
  };
}

export function normalizeCursorClaudeId(raw: string): NormalizedCursorClaudeId | undefined {
  const id = raw.trim().toLowerCase();
  // Recognize the numeric base first; suffix parsing never searches backwards
  // through arbitrary repetitions of model-name delimiters.
  const match = /^(claude-(?:fable|haiku|opus|sonnet)-\d+(?:[.-]\d+)*|claude-\d+(?:\.\d+)*-(?:fable|haiku|opus|sonnet))(?=-|$)/.exec(id);
  if (!match) return undefined;
  const base = parseClaudeBase(match[1]!);
  if (!base) return undefined;
  let suffix = id.slice(match[1]!.length);
  if (!suffix) return { ...base, thinking: false, fast: false };
  const fast = suffix.endsWith("-fast");
  if (fast) suffix = suffix.slice(0, -"-fast".length);
  let thinking = false;
  let level: string | undefined;
  if (suffix === "-thinking") {
    thinking = true;
  } else if (suffix.startsWith("-thinking-")) {
    thinking = true;
    level = suffix.slice("-thinking-".length);
  } else if (suffix.endsWith("-thinking")) {
    thinking = true;
    level = suffix.slice(1, -"-thinking".length);
    // The legacy greedy prefix leaves only the final hyphen-delimited token.
    if (level.includes("-")) return undefined;
  } else if (fast && suffix) {
    level = suffix.slice(1);
    if (level.includes("-")) return undefined;
  } else if (suffix) {
    return undefined;
  }
  if (level !== undefined && !CLAUDE_LEVELS.has(level)) return undefined;
  const parsed = { base: base.sourceBaseId, thinking, fast, ...(level !== undefined ? { level } : {}) };
  return { ...base, ...parsed };
}

export function composeCursorClaudeWireId(
  identity: Pick<NormalizedCursorClaudeId, "sourceBaseId" | "spelling">,
  options: { thinking: boolean; fast: boolean; effort?: string; bareThinking?: boolean },
): string {
  const { sourceBaseId: base, spelling } = identity;
  const fast = options.fast ? "-fast" : "";
  if (!options.thinking) return options.effort ? `${base}-${options.effort}${fast}` : `${base}${fast}`;
  if (options.bareThinking || !options.effort) return `${base}-thinking${fast}`;
  return spelling === "version-first" ? `${base}-${options.effort}-thinking${fast}` : `${base}-thinking-${options.effort}${fast}`;
}
