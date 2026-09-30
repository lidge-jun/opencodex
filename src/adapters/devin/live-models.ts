/**
 * Live Devin / Cognition model discovery via GetCascadeModelConfigs.
 *
 * The live catalog is the source of truth for the model roster. The endpoint
 * returns one row per variant (e.g. `gpt-5-6-sol-high`), grouped into families;
 * the picker shows one id per family and the adapter picks the family member
 * for the requested effort at request time. `DEVIN_STATIC_MODELS` is only a degraded-mode
 * fallback for when there is no API key or discovery fails.
 */
import { getCachedCatalog, type CacheEntry, type ModelCatalogEntry } from "./cloud-direct";

const DEFAULT_HOST = "https://server.codeium.com";

/**
 * Degraded-mode fallback shown when there is no API key or live discovery
 * fails. The live catalog overrides this whenever discovery succeeds.
 */
export const DEVIN_STATIC_MODELS = [
  "swe-1-7",
  "swe-1-7-lightning",
  "gpt-5-6-sol",
  "gpt-5-6-luna",
  "gpt-5-6-terra",
  // 260923 preemptive: GPT-6 Sol and Luna (OpenAI announced 2026-09-22) added ahead of this provider's own catalog; mirrors the GPT-5.6 Sol/Luna rows.
  "gpt-6-sol",
  "gpt-6-luna",
  // 260930 preemptive: GPT-6.1 Sol (devin.ai/blog/gpt-6-1-sol says it is live; the uid is not published).
  // Spelled the way Devin spells gpt-5.6-sol; live discovery replaces this seed once a credential is present.
  "gpt-6-1-sol",
  "claude-opus-4-8",
  "claude-fable-5-1",
  "claude-sonnet-5",
  "glm-5-2",
  "kimi-k2-7",
  "grok-4-5",
  "grok-4-7",
] as const;

/**
 * Degraded-mode context windows, used only when live discovery cannot run.
 *
 * Every number here was read from a live `GetCascadeModelConfigs` response
 * (`ClientModelConfig` field #18) rather than from documentation, because
 * Cognition publishes none: the Devin CLI and Desktop model pages, the SWE-2
 * and SWE-1.7 announcements, and the Windsurf model reference all state model
 * names without a context window. The only published numbers are long-context
 * pricing thresholds, which are a different quantity and were not used.
 *
 * The previous copy of this table was wrong for nine of its eleven rows — the
 * three Claude models were listed at 200k against an actual 1M, `grok-4-5` at
 * 256k against 500k, and the GPT rows at 1.05M against 1M — because it was
 * assembled from each model's upstream vendor window instead of what Cognition
 * actually serves. Measure the catalog when updating this; do not carry a
 * number over from the model's original vendor.
 */
export const DEVIN_MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "swe-2": 262_000,
  "swe-1-7": 262_000,
  "swe-1-7-lightning": 202_752,
  "swe-1-6": 200_000,
  "gpt-5-6-sol": 1_000_000,
  "gpt-5-6-luna": 1_000_000,
  "gpt-5-6-terra": 1_000_000,
  "gpt-6-astra": 1_000_000,
  "gpt-6-sol": 1_000_000,
  "gpt-6-luna": 1_000_000,
  // 260930 preemptive: unmeasured; mirrors the GPT-6 Sol row Cognition serves.
  "gpt-6-1-sol": 1_000_000,
  "claude-opus-4-8": 1_000_000,
  // 260923: read from the live catalog (devin/claude-opus-5-5 context_length 1_000_000).
  "claude-opus-5-5": 1_000_000,
  "claude-opus-5": 1_000_000,
  "claude-fable-5-1": 1_000_000,
  // 260929 preemptive: Claude Sonnet 5.5 (1M per Anthropic) seeded before Devin's live catalog lists it.
  "claude-sonnet-5-5": 1_000_000,
  "claude-sonnet-5": 1_000_000,
  "glm-5-2": 200_000,
  "glm-5-3": 1_048_576,
  "kimi-k2-7": 262_144,
  "kimi-k3": 1_048_576,
  "gemini-3-8-flash": 1_048_576,
  "grok-4-5": 500_000,
  "grok-4-6": 500_000,
  // Live Devin catalog context_length, 2026-09-23:
  // devlog/_plan/260923_grok47_parity/010_probe-evidence.md.
  "grok-4-7": 500_000,
};

/**
 * Trailing tokens that the Cognition catalog appends as effort/variant
 * suffixes. Stripped to collapse suffixed UIDs to their base id.
 */
export const EFFORT_TOKENS = new Set([
  "low", "medium", "high", "xhigh", "max", "none", "fast", "priority", "1m",
]);

/** Collapse an effort-suffixed UID to its base id (e.g. `gpt-5-6-sol-high` → `gpt-5-6-sol`). */
export function collapseDevinModelUid(uid: string): string {
  const parts = uid.split("-");
  while (parts.length > 1 && EFFORT_TOKENS.has(parts[parts.length - 1]!)) {
    parts.pop();
  }
  return parts.join("-");
}

/**
 * The subset of catalog suffix tokens that are reasoning rungs.
 *
 * `fast`, `priority` and `1m` are service tiers and context variants, not effort.
 * Offering them on a reasoning control would name a setting that does something
 * else, so the collapse keeps stripping them while the ladder ignores them.
 */
const REASONING_RUNG_TOKENS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

/**
 * The reasoning rungs a catalog UID carries, in ladder order.
 *
 * Cognition spells effort as a suffix on the model id, so the variants an account
 * actually has ARE its ladder — and collapseDevinModelUid() was throwing exactly
 * that evidence away. Reading it back is what lets every model advertise the rungs
 * it can really run instead of inheriting the generic six-rung default.
 */
export function devinReasoningRungsOf(uid: string): string[] {
  const parts = uid.split("-");
  const rungs: string[] = [];
  while (parts.length > 1 && EFFORT_TOKENS.has(parts[parts.length - 1]!)) {
    const token = parts.pop()!;
    if (REASONING_RUNG_TOKENS.has(token)) rungs.push(token);
  }
  return rungs;
}

/** Ladder order for display, matching the Codex rung order. */
const RUNG_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
export function sortDevinRungs(rungs: Iterable<string>): string[] {
  return [...new Set(rungs)].sort((a, b) => RUNG_ORDER.indexOf(a) - RUNG_ORDER.indexOf(b));
}

/**
 * Effort rungs a catalog family axis can name, in ladder order.
 * The catalog spells `Minimal` (Gemini Flash) and `No Thinking` (GLM), which
 * resolution and the picker place alongside the usual Codex rungs.
 */
const FAMILY_EFFORT_LADDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const EFFORT_AXES = ["Effort", "Reasoning Effort"];
const FAST_AXIS = "Fast Mode";
const LONG_CONTEXT_AXIS = "1M Context";
const THINKING_AXIS = "Thinking";

/** The picker id of a catalog family: its uid with dotted versions hyphenated, as the row uids spell it. */
export function devinFamilyBaseId(familyUid: string): string {
  return familyUid.replace(/\./g, "-");
}

function isEffortAxis(axis: string): boolean {
  return EFFORT_AXES.includes(axis);
}

/** The effort rung a family member sits on, read from its axis value name rather than its uid. */
export function devinFamilyEffortOf(entry: ModelCatalogEntry): string | undefined {
  const axes = entry.familyAxes;
  if (!axes) return undefined;
  for (const axis of EFFORT_AXES) {
    const name = axes[axis]?.name?.toLowerCase();
    if (!name) continue;
    const rung = name === "no thinking" ? "none" : name;
    if (FAMILY_EFFORT_LADDER.includes(rung)) return rung;
  }
  return undefined;
}

const familyCache = new WeakMap<CacheEntry, Map<string, ModelCatalogEntry[]>>();

/**
 * Group catalog rows by family, keyed by the family's picker id. Only rows
 * that carry family metadata take part; legacy `MODEL_*` rows are internal
 * enum names and never form a picker family.
 */
export function devinFamiliesOf(catalog: CacheEntry): Map<string, ModelCatalogEntry[]> {
  let families = familyCache.get(catalog);
  if (families) return families;
  families = new Map();
  for (const entry of catalog.byUid.values()) {
    if (!entry.familyUid || !entry.familyAxes || entry.modelUid.startsWith("MODEL_")) continue;
    const base = devinFamilyBaseId(entry.familyUid);
    const members = families.get(base);
    if (members) members.push(entry);
    else families.set(base, [entry]);
  }
  familyCache.set(catalog, families);
  return families;
}

/** What a caller asked for, independent of how the catalog spells it. */
export interface DevinVariantRequest {
  effort?: string;
  fast?: boolean;
  longContext?: boolean;
}

function lexicallyLess(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! < b[i]!;
  return false;
}

function effortIndex(rung: string | undefined): number {
  return rung === undefined ? -1 : FAMILY_EFFORT_LADDER.indexOf(rung);
}

/**
 * The member closest to `targets` on the non-effort axes, then the lowest rung
 * at or above `effort`, falling back to the highest rung below it. A missing
 * rung never quietly turns reasoning down: `high` on SWE-1.7 (Medium, Max)
 * selects Max, `xhigh` on SWE-2 selects Max, and `medium` on Kimi K3 (Low,
 * High, Max) selects High.
 *
 * Not lowering a requested effort outranks the non-effort axes: in a family
 * whose Fast rows stop at Medium, `high` plus Fast selects the regular High row
 * rather than dropping to Medium to keep Fast. A member with no effort rung
 * cannot prove it is not lower, so it ranks behind any rung at or above the
 * request. `none` (the bottom of the ladder) is never "lowered", which leaves
 * the Thinking-off target in charge of that request.
 */
function closestMember(
  members: ModelCatalogEntry[],
  targets: Record<string, number>,
  effort: string | undefined,
): ModelCatalogEntry | undefined {
  const want = effortIndex(effort);
  let best: ModelCatalogEntry | undefined;
  let bestScore: number[] | undefined;
  for (const member of members) {
    const axes = member.familyAxes ?? {};
    const mismatches = Object.entries(targets).filter(([axis, order]) => (axes[axis]?.order ?? 0) !== order).length;
    const have = effortIndex(devinFamilyEffortOf(member));
    const lowered = want > 0 && have < want ? 1 : 0;
    const distance = want < 0 ? 0
      : have < 0 ? 2 * FAMILY_EFFORT_LADDER.length
      : have >= want ? have - want : FAMILY_EFFORT_LADDER.length + (want - have);
    const score = [lowered, mismatches, distance, -have];
    if (!bestScore || lexicallyLess(score, bestScore)) {
      best = member;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Pick the family member for a request. Axes the caller did not ask about
 * (`Fast Mode`, `1M Context`, `Thinking`, `Prompt Cache Retention`, ...) stay
 * where the anchor has them; the anchor is the member the caller named, else
 * the family's catalog default, else the neutral member (every toggle off,
 * effort nearest Medium) for the few families that mark no default. Disabled
 * members are passed over while any enabled one remains, so the pre-flight
 * only reports a tier refusal when the whole family is refused. `includeDisabled`
 * ranks every member, which tells a caller whether a disabled row is itself the
 * best match for the request.
 */
export function selectDevinFamilyMember(
  members: ModelCatalogEntry[],
  request: DevinVariantRequest,
  anchor?: ModelCatalogEntry,
  options: { includeDisabled?: boolean } = {},
): ModelCatalogEntry | undefined {
  const axisNames = new Set(members.flatMap((m) => Object.keys(m.familyAxes ?? {})).filter((a) => !isEffortAxis(a)));
  const base = anchor
    ?? members.find((m) => m.isFamilyDefault)
    ?? closestMember(members, Object.fromEntries([...axisNames].map((a) => [a, 0])), "medium");
  if (!base) return undefined;
  const targets: Record<string, number> = {};
  for (const axis of axisNames) targets[axis] = base.familyAxes?.[axis]?.order ?? 0;
  if (request.fast && axisNames.has(FAST_AXIS)) targets[FAST_AXIS] = 1;
  if (request.longContext && axisNames.has(LONG_CONTEXT_AXIS)) targets[LONG_CONTEXT_AXIS] = 1;
  // `none` means no reasoning. Families like Claude Sonnet 4.6 express that as
  // Thinking off rather than as an effort rung.
  if (request.effort === "none" && axisNames.has(THINKING_AXIS)) targets[THINKING_AXIS] = 0;
  const enabled = options.includeDisabled ? members : members.filter((m) => !m.disabled);
  return closestMember(enabled.length > 0 ? enabled : members, targets, request.effort ?? devinFamilyEffortOf(base));
}

/**
 * Degraded-mode ladders, used only before the account catalog is readable.
 *
 * Only measured entries belong here. SWE-2 ships exactly three native lanes
 * (see SWE2_EFFORT in src/adapters/devin.ts); inventing ladders for the rest
 * would advertise rungs nobody verified, and the live catalog replaces this
 * table as soon as a credential is present.
 */
export const DEVIN_MODEL_EFFORTS: Record<string, string[]> = {
  "swe-2": ["medium", "high", "max"],
  // Live Devin catalog, 2026-09-23:
  // devlog/_plan/260923_grok47_parity/010_probe-evidence.md.
  "grok-4-7": ["low", "medium", "high", "xhigh", "max"],
};

/**
 * Provider-level fallback ladder. No `ultra`: Cognition has no such lane, and
 * the Codex catalog re-adds its own top rungs anyway (src/codex/catalog/effort.ts).
 * Clients that key an effort control off this list — the Pi-shaped exports — get
 * a control instead of none.
 */
export const DEVIN_DEFAULT_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

export type DevinUsableModelsResult =
  | {
      ok: true;
      models: string[];
      contextWindows: Record<string, number>;
      efforts: Record<string, string[]>;
      /** Per base, the effort of the family's catalog default member, when it is on the ladder. */
      defaultEfforts: Record<string, string>;
      inputModalities: Record<string, string[]>;
    }
  | { ok: false; error: "auth" | "http" | "empty" | "unknown"; detail?: string };

/**
 * Fetch the live model roster from Cognition's `GetCascadeModelConfigs` and
 * collapse variants to base ids. Rows that carry family metadata collapse to
 * their family and read their effort from the family's effort axis; only rows
 * without it (older catalogs) fall back to reading suffixes off the uid. The
 * returned list is the authoritative model roster for the signed-in account.
 */
export async function fetchDevinUsableModels(opts: {
  apiKey: string;
  baseUrl?: string;
  signal?: AbortSignal;
}): Promise<DevinUsableModelsResult> {
  try {
    const host = (opts.baseUrl || DEFAULT_HOST).replace(/\/$/, "");
    const catalog = await getCachedCatalog(opts.apiKey, host, opts.signal);
    if (!catalog) return { ok: false, error: "empty" };
    const bases = new Set<string>();
    const contextWindows: Record<string, number> = {};
    // Effort rungs per base, recovered from the suffixes the collapse strips.
    const rungs = new Map<string, Set<string>>();
    // supportsImages votes per base; only rows that asserted field #5 vote.
    const imageVotes = new Map<string, { sawTrue: boolean; sawFalse: boolean }>();
    for (const entry of catalog.byUid.values()) {
      if (entry.disabled) continue;
      // Skip internal enum constants (e.g. MODEL_GPT_5_2_LOW, MODEL_PRIVATE_*).
      // Real chat model UIDs are lowercase dashed strings (swe-1-7, gpt-5-6-sol).
      if (entry.modelUid.startsWith("MODEL_")) continue;
      const family = entry.familyUid && entry.familyAxes ? devinFamilyBaseId(entry.familyUid) : undefined;
      const base = family ?? collapseDevinModelUid(entry.modelUid);
      bases.add(base);
      const familyRung = family ? devinFamilyEffortOf(entry) : undefined;
      const found = family
        ? (familyRung && REASONING_RUNG_TOKENS.has(familyRung) ? [familyRung] : [])
        : devinReasoningRungsOf(entry.modelUid);
      if (found.length > 0) {
        let set = rungs.get(base);
        if (!set) { set = new Set(); rungs.set(base, set); }
        for (const rung of found) set.add(rung);
      }
      if (entry.contextWindow && entry.contextWindow > 0) {
        // Variants of one base can disagree: the opt-in `-1m` rows report a
        // larger window than the plain row of the same base, and both collapse
        // here because `1m` is an effort token. Keep the smallest, because the
        // base id routes to the plain variant — advertising the long-context
        // number would promise a window the request the picker actually sends
        // cannot use.
        const seen = contextWindows[base];
        contextWindows[base] = seen === undefined ? entry.contextWindow : Math.min(seen, entry.contextWindow);
      }
      if (entry.supportsImages !== undefined) {
        let votes = imageVotes.get(base);
        if (!votes) {
          votes = { sawTrue: false, sawFalse: false };
          imageVotes.set(base, votes);
        }
        if (entry.supportsImages) votes.sawTrue = true;
        else votes.sawFalse = true;
      }
    }
    if (bases.size === 0) return { ok: false, error: "empty" };
    const efforts: Record<string, string[]> = {};
    for (const [base, set] of rungs) {
      // A single rung is not a choice, so it is not a control. Advertising one
      // would draw a picker whose only option is the value already in effect.
      if (set.size > 1) efforts[base] = sortDevinRungs(set);
    }
    const defaultEfforts: Record<string, string> = {};
    for (const [base, members] of devinFamiliesOf(catalog)) {
      if (!members.some((member) => member.isFamilyDefault)) continue;
      const selected = selectDevinFamilyMember(members, {});
      const rung = selected && devinFamilyEffortOf(selected);
      if (rung && efforts[base]?.includes(rung)) defaultEfforts[base] = rung;
    }
    // supportsImages arrives tri-state per catalog row, so the collapse votes:
    // a row that never asserted field #5 abstains, which keeps an unsuffixed
    // unknown row from poisoning a base whose effort variants were measured
    // image-capable. Unanimous measured rows advertise; measured disagreement
    // advertises nothing, because a single measured false is not outvoted by
    // its siblings. One accepted mismatch, only for rows without family
    // metadata: resolveWireModelUid prefers the plain UID when the catalog
    // lists it, so a base advertised
    // ["text","image"] on variant evidence can still route a no-effort request
    // to a plain row that never asserted the field.
    const inputModalities: Record<string, string[]> = {};
    for (const [base, votes] of imageVotes) {
      if (votes.sawTrue && votes.sawFalse) continue;
      inputModalities[base] = votes.sawTrue ? ["text", "image"] : ["text"];
    }
    return { ok: true, models: [...bases].sort(), contextWindows, efforts, defaultEfforts, inputModalities };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/unauth|401|invalid token|login/i.test(message)) return { ok: false, error: "auth", detail: message };
    return { ok: false, error: "unknown", detail: message };
  }
}
