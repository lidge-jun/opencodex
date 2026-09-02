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
  const patterns: ReadonlyArray<readonly [RegExp, (m: RegExpExecArray) => { base: string; thinking: boolean; fast: boolean; level?: string }]> = [
    [/^(.*)-thinking-([a-z-]+)-fast$/, m => ({ base: m[1]!, thinking: true, fast: true, level: m[2]! })],
    [/^(.*)-([a-z-]+)-thinking-fast$/, m => ({ base: m[1]!, thinking: true, fast: true, level: m[2]! })],
    [/^(.*)-thinking-([a-z-]+)$/, m => ({ base: m[1]!, thinking: true, fast: false, level: m[2]! })],
    [/^(.*)-([a-z-]+)-thinking$/, m => ({ base: m[1]!, thinking: true, fast: false, level: m[2]! })],
    [/^(.*)-([a-z-]+)-fast$/, m => ({ base: m[1]!, thinking: false, fast: true, level: m[2]! })],
    [/^(.*)-thinking-fast$/, m => ({ base: m[1]!, thinking: true, fast: true })],
    [/^(.*)-thinking$/, m => ({ base: m[1]!, thinking: true, fast: false })],
    [/^(.*)-fast$/, m => ({ base: m[1]!, thinking: false, fast: true })],
  ];
  for (const [pattern, dims] of patterns) {
    const match = pattern.exec(id);
    if (!match) continue;
    const parsed = dims(match);
    if (parsed.level && !CLAUDE_LEVELS.has(parsed.level)) continue;
    const base = parseClaudeBase(parsed.base);
    if (base) return { ...base, ...parsed, sourceBaseId: base.sourceBaseId };
  }
  const base = parseClaudeBase(id);
  return base ? { ...base, thinking: false, fast: false } : undefined;
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
