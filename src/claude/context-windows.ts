/**
 * Claude-surface context-window map + effective model-env computation
 * (devlog/260712_cli_context_cache/010 B2, audit R2#1/R3#1/R3#4/R4#3).
 *
 * The map registers EVERY selector form a Claude Code model slot might store —
 * bare native slug, provider/id, desktop3p alias, legacy claude-ocx-* alias —
 * with first-wins dedupe (mirrors the desktop3p registry collision policy).
 * Values are authoritative context windows only (native override table /
 * adapter-reported CatalogModel.contextWindow); nothing is guessed.
 */
import { aliasForNative, aliasForRoute } from "./alias";
import { desktop3pAlias } from "./desktop-3p";
import { nativeOpenAiContextWindow, type CatalogModel, type NativeContextLimitsInput } from "../codex/catalog";

const ONE_MILLION = 1_000_000;

/**
 * Auto-context defaults (devlog 260712 020, user-approved).
 *
 * The compact window is the token count at which Claude Code starts compacting, and it is
 * also the floor `shouldMarkOneMillion` uses — a model may only carry the marker if it can
 * host this window. 350,000 was chosen when the widest native row advertised 372,000.
 *
 * It now matches the auto-compaction limit the Codex catalog ships for the same models
 * (`nativeAutoCompactLimit`: 829,800 against the 922,000 native window). Leaving the two
 * apart meant one model compacting at 350k under Claude Code and at 829,800 under Codex.
 * The value stays clear of the measured 922,000 ceiling by ~92k, so compaction still has
 * room to run before the upstream refuses.
 */
export const AUTO_COMPACT_WINDOW_DEFAULT = 829_800;
export const AUTO_CONTEXT_FLOOR = 200_000;
/** Binary-verified accepted range for CLAUDE_CODE_AUTO_COMPACT_WINDOW (2.1.207: pSo=1e5, yDs=1e6). */
export const AUTO_COMPACT_WINDOW_MIN = 100_000;
export const AUTO_COMPACT_WINDOW_MAX = ONE_MILLION;

/** Case-insensitive [1m] marker helpers — the CLI matches /\[1m\]/i (audit 021 #7). */
const ONE_M_MARKER_RE = /\[1m\]$/i;
export function hasOneMillionMarker(value: string): boolean {
  return ONE_M_MARKER_RE.test(value);
}
export function stripOneMillionMarker(value: string): string {
  return value.replace(ONE_M_MARKER_RE, "");
}

export interface AutoContextMode {
  enabled: boolean;
  /** Effective CLAUDE_CODE_AUTO_COMPACT_WINDOW value (tokens). */
  compactWindow: number;
}

export const AUTO_CONTEXT_OFF: AutoContextMode = { enabled: false, compactWindow: AUTO_COMPACT_WINDOW_DEFAULT };

interface AutoContextConfigSlice {
  autoContext?: boolean;
  autoCompactWindow?: number;
  maxContextTokens?: number;
}

function inAutoCompactRange(value: number): boolean {
  return Number.isInteger(value) && value >= AUTO_COMPACT_WINDOW_MIN && value <= AUTO_COMPACT_WINDOW_MAX;
}

/**
 * Resolve the auto-context mode from claudeCode config. Disabled when the user
 * turned it off OR when the legacy maxContextTokens override is set — that pair
 * (MAX_CONTEXT_TOKENS + DISABLE_COMPACT) takes rule-1 precedence inside the CLI,
 * making both AUTO_COMPACT_WINDOW and [1m] accounting inert.
 *
 * `envOverride` is the raw CLAUDE_CODE_AUTO_COMPACT_WINDOW the USER already
 * exported (user-wins injection keeps it): a valid value drives the marking
 * predicate so marker and threshold never separate (audit 021 #2); an invalid
 * value disables auto marking entirely (the CLI would ignore it, leaving marked
 * sub-1M models without their safety net). Out-of-range CONFIG values fall back
 * to AUTO_COMPACT_WINDOW_DEFAULT (the management API rejects them; this guards hand-edits).
 */
export function resolveAutoContext(claudeCode: AutoContextConfigSlice | undefined, envOverride?: string): AutoContextMode {
  if (claudeCode?.autoContext === false) return AUTO_CONTEXT_OFF;
  const maxCtx = claudeCode?.maxContextTokens;
  if (typeof maxCtx === "number" && Number.isFinite(maxCtx) && maxCtx > 0) return AUTO_CONTEXT_OFF;
  if (typeof envOverride === "string" && envOverride !== "") {
    const parsed = Number(envOverride);
    return inAutoCompactRange(parsed) ? { enabled: true, compactWindow: parsed } : AUTO_CONTEXT_OFF;
  }
  const raw = claudeCode?.autoCompactWindow;
  const compactWindow = typeof raw === "number" && inAutoCompactRange(raw) ? raw : AUTO_COMPACT_WINDOW_DEFAULT;
  return { enabled: true, compactWindow };
}

/**
 * [1m]-marking predicate. Windows >= 1M always mark (CLI accounts exactly 1M).
 * Auto-context additionally marks windows > 200k that can safely host the compact
 * window — marking a model whose real window is BELOW the compact window would put
 * the compaction safety net behind the real API limit (mid-session 400s).
 */
export function shouldMarkOneMillion(window: number | undefined, auto: AutoContextMode): boolean {
  if (typeof window !== "number" || window <= 0) return false;
  if (window >= ONE_MILLION) return true;
  return auto.enabled && window > AUTO_CONTEXT_FLOOR && window >= auto.compactWindow;
}

export function buildClaudeContextWindows(
  nativeSlugs: readonly string[],
  routedModels: readonly CatalogModel[],
  // A configured providerContextCaps.openai has to reach the native rows here too. Without
  // it the Claude surface keeps advertising the uncapped authoritative window while the
  // Codex catalog advertises the capped one, and the two disagree about the same model.
  nativeContextCap?: NativeContextLimitsInput,
): Record<string, number> {
  const out: Record<string, number> = {};
  const put = (key: string | null, value: number) => {
    if (!key) return;
    if (out[key] === undefined) out[key] = value; // first-wins (registry policy)
  };
  for (const slug of nativeSlugs) {
    const window = nativeOpenAiContextWindow(slug, nativeContextCap);
    if (typeof window !== "number" || window <= 0) continue;
    put(slug, window);
    put(desktop3pAlias("native", slug), window);
    put(aliasForNative(slug), window);
  }
  // Anthropic passthrough guard (audit 021 #3): canonical claude ids ride the
  // subscription passthrough — marking a sub-1M one would strap [1m]/1M-beta onto
  // a model that cannot host it. Register anthropic rows only at >=1M.
  const registrable = routedModels.filter(
    m =>
      typeof m.contextWindow === "number" &&
      m.contextWindow > 0 &&
      !(m.provider === "anthropic" && m.contextWindow < ONE_MILLION),
  );
  // Bare routed ids are registered only when unambiguous across providers (audit
  // 021 #5) — natives are registered first, so a native slug always wins the bare
  // key. Counted over the rows that can actually claim the key: a row this loop
  // skips contributes no window, so letting it veto the bare key withholds an
  // answer that was never in doubt.
  const bareCounts = new Map<string, number>();
  for (const m of registrable) bareCounts.set(m.id, (bareCounts.get(m.id) ?? 0) + 1);
  for (const m of registrable) {
    const window = m.contextWindow as number;
    put(`${m.provider}/${m.id}`, window);
    put(desktop3pAlias(m.provider, m.id), window);
    put(aliasForRoute(m.provider, m.id), window);
    if (bareCounts.get(m.id) === 1) put(m.id, window);
  }
  return out;
}

/** Strip a trailing [1m] marker before map lookup (selector may already carry it). */
function bareSelector(value: string): string {
  return stripOneMillionMarker(value);
}

/**
 * Apply the [1m] context-variant marker to a model selector when its authoritative
 * window is >= 1M (Claude Code accounts exactly 1M for the marker; compaction stays
 * alive) — or, in auto-context mode, when the window clears the marking predicate
 * above. Already-marked selectors pass through; unknown selectors stay untouched.
 */
export function withOneMillionMarker(selector: string | undefined, windows: Record<string, number>, auto: AutoContextMode = AUTO_CONTEXT_OFF): string | undefined {
  if (!selector) return selector;
  if (hasOneMillionMarker(selector)) return selector;
  const window = windows[bareSelector(selector)];
  return shouldMarkOneMillion(window, auto) ? `${selector}[1m]` : selector;
}

export interface ClaudeTierModels {
  opus?: string;
  sonnet?: string;
  haiku?: string;
  fable?: string;
}

/**
 * The exact env map Claude Code consumes for model slots (audit R4#4):
 * ANTHROPIC_MODEL + the four tier defaults + the legacy small-fast alias.
 * effective-haiku contract (audit R1#8): tierModels.haiku ?? smallFastModel, one
 * value injected into BOTH haiku variables.
 */
export function effectiveModelEnv(
  claudeCode: { model?: string; smallFastModel?: string; tierModels?: ClaudeTierModels; autoContext?: boolean; autoCompactWindow?: number; maxContextTokens?: number } | undefined,
  windows: Record<string, number>,
  autoOverride?: AutoContextMode,
): Record<string, string> {
  const out: Record<string, string> = {};
  const auto = autoOverride ?? resolveAutoContext(claudeCode);
  const set = (name: string, value: string | undefined) => {
    const marked = withOneMillionMarker(value, windows, auto);
    if (marked) out[name] = marked;
  };
  set("ANTHROPIC_MODEL", claudeCode?.model);
  set("ANTHROPIC_DEFAULT_OPUS_MODEL", claudeCode?.tierModels?.opus);
  set("ANTHROPIC_DEFAULT_SONNET_MODEL", claudeCode?.tierModels?.sonnet);
  set("ANTHROPIC_DEFAULT_FABLE_MODEL", claudeCode?.tierModels?.fable);
  const effectiveHaiku = claudeCode?.tierModels?.haiku ?? claudeCode?.smallFastModel;
  set("ANTHROPIC_DEFAULT_HAIKU_MODEL", effectiveHaiku);
  set("ANTHROPIC_SMALL_FAST_MODEL", effectiveHaiku);
  return out;
}

/** Shared 3s bounded acquisition (audit R4#3) for context-window sources. */
export async function boundedContextWindows(
  acquire: () => Promise<Record<string, number>>,
  timeoutMs = 3_000,
): Promise<Record<string, number> | null> {
  try {
    return await Promise.race([
      acquire(),
      new Promise<null>(resolve => setTimeout(() => resolve(null), timeoutMs)),
    ]);
  } catch {
    return null;
  }
}
