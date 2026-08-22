/**
 * Hard reasoning-effort caps (devlog/260710_subagent_effort_intercept).
 *
 * Prompt-side effort designation (injectionEffort) is advisory only: codex-rs inherits the
 * parent's effective effort when spawn_agent carries no model/effort args
 * (multi_agents_common.rs resolve defaults), rejects overrides on full-history forks, and a
 * non-empty agent-role file rebuilds the child Config and silently drops spawn-time
 * model/effort. So a session whose config default is ultra leaks max-tier children whenever
 * the parent model spawns bare. This module is the enforcement path: it rewrites the effort
 * of proxied turns at the single choke point every HTTP/WS turn passes through
 * (handleResponses), using the same dual-shape rewrite contract as nativeEffortClamp —
 * parsed.options.reasoning feeds routed adapters, _rawBody.reasoning.effort feeds the
 * ChatGPT passthrough serializer.
 */
import type { OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../types";
import { modelInList } from "../types";
import { codexEffortRank, configuredReasoningEfforts, isCodexReasoningEffort, modelRecordValue } from "../reasoning-effort";
import { catalogModelEfforts } from "../codex/catalog";

/**
 * True when the request carries codex-rs's spawned-child markers, matched EXACTLY.
 * Source of truth (openai/codex @ 6138909d): every collab-spawned child turn sends
 * `x-openai-subagent: collab_spawn` (core/src/responses_metadata.rs) and embeds
 * `"subagent_kind":"thread_spawn"` in the JSON `x-codex-turn-metadata` compatibility
 * header. Both are checked: the WS bridge rebuilds internal requests from the
 * FORWARD_HEADERS allowlist, so either header alone is sufficient evidence.
 *
 * Exact matching matters: upstream emits `x-openai-subagent` for OTHER internal
 * turn categories too (review, compact, memory_consolidation, arbitrary "other"
 * sources — responses_metadata.rs subagent_source). Those are maintenance turns,
 * not spawned children, and must never trip subagentEffortCap.
 */
export function isThreadSpawnRequest(headers: Headers): boolean {
  if (headers.get("x-openai-subagent") === "collab_spawn") return true;
  const turnMeta = headers.get("x-codex-turn-metadata");
  if (!turnMeta) return false;
  try {
    const parsed = JSON.parse(turnMeta) as { subagent_kind?: unknown };
    return parsed.subagent_kind === "thread_spawn";
  } catch {
    return false;
  }
}

/** The effective ceiling for this turn, or undefined when no configured cap applies. */
export function effortCapFor(config: OcxConfig, subagent: boolean): string | undefined {
  const caps: string[] = [];
  if (config.effortCap && isCodexReasoningEffort(config.effortCap)) caps.push(config.effortCap);
  if (subagent && config.subagentEffortCap && isCodexReasoningEffort(config.subagentEffortCap)) {
    caps.push(config.subagentEffortCap);
  }
  if (caps.length === 0) return undefined;
  return caps.reduce((low, cap) => (codexEffortRank(cap) < codexEffortRank(low) ? cap : low));
}

/**
 * Whether the effort caps apply to this turn at all. Caps are a V2-surface feature
 * (v1 sub-agents are pinned via explicit spawn args + injectionEffort prompting, so
 * the ultra-default leak this module intercepts is v2-specific):
 *  - compaction turns are maintenance, not agent turns: they bypass caps entirely so
 *    native /v1/responses/compact (forwarded, never enters handleResponses) and routed
 *    compaction (synthesized internal request) get identical cap semantics.
 *  - multiAgentMode "v1" disables caps entirely (mirrors the GUI hiding the panel).
 *  - a main turn qualifies when its own tool list carries the v2 collab surface.
 *  - a CHILD turn is admitted by its spawned-child markers (isThreadSpawnRequest)
 *    REGARDLESS of tool surface: depth-limited leaves carry no collab tools (surface
 *    null) while children below the spawn-depth limit retain collab tools (spec_plan.rs
 *    leaf guard), so tool sniffing alone would cap siblings inconsistently.
 *  - a v1-surface MAIN turn (no child markers) never qualifies.
 */
export function effortCapAppliesTo(
  surface: "v1" | "v2" | null,
  headers: Headers,
  config: OcxConfig,
  compaction = false,
): boolean {
  if (compaction) return false;
  if (config.multiAgentMode === "v1") return false;
  return surface === "v2" || isThreadSpawnRequest(headers);
}

/**
 * The routed model's supported effort ladder for cap resolution, from the ROUTE's
 * registry-merged provider (router.ts routedProviderConfig) — the persisted
 * config.providers entry misses registry seeds, and bare ids can route via
 * defaultModel/model-list/default-provider, so no "/" heuristic anywhere.
 *
 * - `[]`   -> the model intentionally exposes no effort control (noReasoningModels or
 *             an explicitly empty configured ladder): cap resolution strips.
 * - list   -> sanitized + healed ladder (configuredReasoningEfforts).
 * - undefined -> unknown. Includes the raw-nonempty-but-non-rankable case (e.g. a
 *             thinking-toggle ladder of ["enabled"]): sanitizing would flatten it to []
 *             and mis-classify it as "no effort control", so it stays unknown.
 *
 * Catalog fallback fires only for the ChatGPT-backend native passthrough IDENTITY
 * (adapter "openai-responses" + authMode "forward", the fresh-install `openai`
 * provider shape): the injected catalog is authoritative exactly for models Codex
 * validates against that backend. A custom responses provider (key mode) serving a
 * native-looking bare id must NOT inherit the unrelated native ladder.
 */
/**
 * Empty ladders mean "no effort control", not "this model cannot emit reasoning".
 * Drop only `effort` so a Chat Completions `include_reasoning` / `reasoning.summary`
 * request still reaches parseRequest and is not hidden by hideThinkingSummary.
 */
export function stripEmptyLadderEffort(
  reasoning: unknown,
  ladder: readonly string[] | undefined,
): unknown {
  if (ladder === undefined || ladder.length > 0) return reasoning;
  if (reasoning === undefined || reasoning === null || typeof reasoning !== "object" || Array.isArray(reasoning)) {
    return reasoning;
  }
  const next = { ...(reasoning as Record<string, unknown>) };
  delete next.effort;
  return Object.keys(next).length > 0 ? next : undefined;
}

export function supportedLadderFor(route: { provider: OcxProviderConfig; modelId: string }): string[] | undefined {
  const { provider, modelId } = route;
  if (modelInList(provider.noReasoningModels, modelId)) return [];
  const raw = modelRecordValue(provider.modelReasoningEfforts, modelId) ?? provider.reasoningEfforts;
  if (raw !== undefined) {
    const sanitized = configuredReasoningEfforts(provider, modelId) ?? [];
    if (sanitized.length === 0 && raw.length > 0) return undefined;
    return sanitized;
  }
  if (provider.adapter === "openai-responses" && provider.authMode === "forward") {
    const efforts = catalogModelEfforts([modelId]).get(modelId);
    if (efforts && efforts.length > 0) return efforts;
  }
  return undefined;
}

/**
 * Resolve the configured cap against the model's supported ladder. Returns the effective
 * ceiling rung, or null when the turn must be STRIPPED of its effort entirely. The cap
 * NEVER raises: when rankable rungs exist but none sits at or below the cap, the model
 * cannot run within the ceiling, so the effort is stripped and the provider default
 * applies (never a rung above the cap).
 */
export function resolveCappedEffort(cap: string, supported: readonly string[] | undefined): string | null {
  if (supported === undefined) return cap;
  const rankable = supported.filter(isCodexReasoningEffort);
  if (rankable.length === 0) {
    // Nonempty but non-rankable (e.g. ["enabled"]) -> unknown ladder, cap as-is.
    // Genuinely empty -> no effort control at all -> strip.
    return supported.length > 0 ? cap : null;
  }
  const capRank = codexEffortRank(cap);
  let best: string | null = null;
  for (const rung of rankable) {
    const rank = codexEffortRank(rung);
    if (rank <= capRank && (best === null || rank > codexEffortRank(best))) best = rung;
  }
  return best;
}

/**
 * Cap the turn's reasoning effort in BOTH request shapes. Non-strip resolution only
 * lowers: efforts at or below the resolved ceiling (and non-ladder/absent efforts) pass
 * untouched. Strip resolution (model exposes no effort control, or no supported rung
 * fits under the cap) removes whatever effort is present — regardless of its rank —
 * from both shapes while preserving `reasoning.summary`. Returns the applied rewrite
 * for request-log annotation (`to: "none"` on strip), or null when nothing changed.
 */
export function applyEffortCap(
  parsed: OcxParsedRequest,
  headers: Headers,
  config: OcxConfig,
  supported?: readonly string[] | undefined,
): { from: string; to: string; subagent: boolean } | null {
  const subagent = isThreadSpawnRequest(headers);
  const cap = effortCapFor(config, subagent);
  if (!cap) return null;
  const resolved = resolveCappedEffort(cap, supported);
  const requested = parsed.options.reasoning;
  const raw = parsed._rawBody as { reasoning?: { effort?: string } } | undefined;
  if (resolved === null) {
    if (!requested) return null;
    parsed.options.reasoning = undefined;
    if (raw?.reasoning && typeof raw.reasoning === "object") delete raw.reasoning.effort;
    return { from: requested, to: "none", subagent };
  }
  if (!requested || !isCodexReasoningEffort(requested)) return null;
  if (codexEffortRank(requested) <= codexEffortRank(resolved)) return null;
  parsed.options.reasoning = resolved;
  if (raw?.reasoning && typeof raw.reasoning === "object") raw.reasoning.effort = resolved;
  return { from: requested, to: resolved, subagent };
}
