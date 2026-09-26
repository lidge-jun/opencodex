/**
 * Model routing for Codex's own memory pipeline.
 *
 * Codex writes memories in two background phases, and both ask the provider for a bare native
 * model: Phase 1 ("extract") summarizes one finished thread per call and asks for
 * `gpt-5.6-luna` at effort `low`; Phase 2 ("consolidation") is one agent run that merges those
 * summaries into the files under `$CODEX_HOME/memories` and asks for `gpt-5.6-terra` at effort
 * `medium`. Without a configured target both resolve through the canonical OpenAI route even when
 * every ordinary turn is routed elsewhere — and Phase 1 additionally looks like the app's
 * title/commit helper traffic, because the app uses the same model id for those.
 *
 * A phase is therefore recognized from Codex's own turn metadata, never inferred from the model
 * id, the timing, or the token counts. Phase 1 sends `request_kind: "memory"`; both phases carry
 * `thread_source: "memory_consolidation"`, and Phase 2 additionally arrives with
 * `x-openai-subagent: memory_consolidation` (codex-rs `core/src/responses_metadata.rs`).
 */
import type { OcxConfig, OcxParsedRequest } from "../../types";
import { isDeclaredReasoningEffort } from "../../reasoning-effort";

/** The two phases Codex runs, in the order it runs them. */
export type MemoryModelPhase = "extract" | "consolidation";

/** codex-rs serializes both keys below into the JSON `x-codex-turn-metadata` header. */
const TURN_METADATA_HEADER = "x-codex-turn-metadata";
const REQUEST_KIND_KEY = "request_kind";
const THREAD_SOURCE_KEY = "thread_source";
/** `CodexResponsesRequestKind::Memory` (codex-rs `core/src/responses_metadata.rs`). */
const MEMORY_REQUEST_KIND = "memory";
/** `ThreadSource::MemoryConsolidation` / `InternalSessionSource::MemoryConsolidation`. */
const MEMORY_THREAD_SOURCE = "memory_consolidation";
const SUBAGENT_HEADER = "x-openai-subagent";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** One metadata copy's verdict. `"none"` is a well-formed copy that is not a memory turn. */
type CopyVerdict = MemoryModelPhase | "none";

function verdictOf(parsed: Record<string, unknown>): CopyVerdict {
  // Phase 1's detached request names the memory kind explicitly. Phase 2 is an ordinary turn
  // inside the `memory_consolidation` thread, so its thread source is the only signal there.
  if (parsed[REQUEST_KIND_KEY] === MEMORY_REQUEST_KIND) return "extract";
  if (parsed[THREAD_SOURCE_KEY] === MEMORY_THREAD_SOURCE) return "consolidation";
  return "none";
}

/**
 * Recognize a memory-pipeline turn, or null.
 *
 * Every copy of the turn metadata the request carries must agree — the same rule
 * `applyCompactionRoutingOverride` applies to compaction turns: a request that contradicts itself
 * is not a memory turn, so neither copy can widen what the setting covers. On HTTP the sub-agent
 * header is accepted on its own because Codex may deliver only that copy; on websocket it is not,
 * because the bridge re-attaches the handshake's header to every frame, so there it marks the
 * connection rather than the turn and the per-frame metadata decides alone.
 */
export function detectMemoryModelPhase(
  body: unknown,
  headers: Headers,
  options: { transport?: "websocket" } = {},
): MemoryModelPhase | null {
  const metadata: unknown[] = [];
  const header = headers.get(TURN_METADATA_HEADER);
  if (options.transport !== "websocket" && header !== null) metadata.push(header);
  const client = record(record(body)?.["client_metadata"]);
  if (client && Object.hasOwn(client, TURN_METADATA_HEADER)) metadata.push(client[TURN_METADATA_HEADER]);

  let verdict: CopyVerdict | null = null;
  for (const value of metadata) {
    if (typeof value !== "string") return null;
    let parsed: Record<string, unknown> | undefined;
    try {
      parsed = record(JSON.parse(value));
    } catch {
      return null;
    }
    if (!parsed) return null;
    const copy = verdictOf(parsed);
    if (verdict !== null && verdict !== copy) return null;
    verdict = copy;
  }
  if (verdict === "extract" || verdict === "consolidation") return verdict;
  // The websocket bridge rebuilds internal requests from a header allowlist and re-attaches the
  // handshake's sub-agent header to every frame. Trusting it here would sweep the connection's
  // later ordinary turns into the consolidation phase, so websocket frames rely on the per-frame
  // turn metadata above and nothing else.
  if (options.transport === "websocket") return null;
  return headers.get(SUBAGENT_HEADER) === MEMORY_THREAD_SOURCE ? "consolidation" : null;
}

/** The configured destination for one phase, or undefined while the phase keeps Codex's choice. */
export function configuredMemoryModel(
  config: Pick<OcxConfig, "memoryModels"> | undefined,
  phase: MemoryModelPhase,
): { model: string; reasoningEffort?: string } | undefined {
  const setting = config?.memoryModels?.[phase];
  if (!setting) return undefined;
  const model = typeof setting.model === "string" ? setting.model.trim() : "";
  if (!model) return undefined;
  const effort = typeof setting.reasoningEffort === "string" ? setting.reasoningEffort : undefined;
  return { model, ...(effort ? { reasoningEffort: effort } : {}) };
}

/**
 * Force the configured effort onto a memory turn.
 *
 * Codex hard-codes the phase effort (`low` for Phase 1, `medium` for Phase 2) and has no config
 * key for it, so this is the only place the operator's choice can land. Both wire shapes are
 * written: `parsed.options.reasoning` feeds the routed adapters, `_rawBody.reasoning.effort` feeds
 * the ChatGPT passthrough serializer — the same dual-shape contract `applyPinnedEffort` uses.
 */
export function applyMemoryModelEffort(
  parsed: OcxParsedRequest,
  config: Pick<OcxConfig, "memoryModels"> | undefined,
  phase: MemoryModelPhase,
): { from: string | undefined; to: string } | null {
  const effort = configuredMemoryModel(config, phase)?.reasoningEffort;
  if (!effort || !isDeclaredReasoningEffort(effort)) return null;
  const requested = parsed.options.reasoning;
  if (requested === effort) return null;
  parsed.options.reasoning = effort;
  const raw = parsed._rawBody as { reasoning?: { effort?: string } } | undefined;
  if (raw && typeof raw === "object") {
    raw.reasoning = { ...(record(raw.reasoning) ?? {}), effort } as { effort?: string };
  }
  return { from: requested, to: effort };
}

/** Route reason recorded for a routed memory turn, so the request log names the phase. */
export function memoryModelRouteReason(phase: MemoryModelPhase): string {
  return phase === "extract" ? "memory-extract" : "memory-consolidation";
}

/** Non-retryable: the target stays unavailable until the operator changes the setting. */
export const MEMORY_MODEL_TARGET_UNAVAILABLE_CODE = "memory_model_target_unavailable";
export const MEMORY_MODEL_TARGET_UNAVAILABLE_STATUS = 409;

const warnedTargets = new Set<string>();

/**
 * A configured phase destination that stopped resolving fails its call once, clearly, instead of
 * silently falling back to the native model the operator routed away from — the same contract the
 * shadow intercept uses for its single target.
 */
export function memoryModelTargetUnavailableResponse(
  phase: MemoryModelPhase,
  model: string,
  detail: string,
): Response {
  const message = `Memory ${phase} model "${model}" is unavailable: ${detail}. `
    + "Choose another model in the Memory Models settings or re-enable its provider.";
  const key = `${phase}\u0000${model}\u0000${detail}`;
  if (!warnedTargets.has(key)) {
    warnedTargets.add(key);
    console.warn(`memory-models: ${message}`);
  }
  return new Response(
    JSON.stringify({ error: { message, type: "invalid_request_error", code: MEMORY_MODEL_TARGET_UNAVAILABLE_CODE } }),
    { status: MEMORY_MODEL_TARGET_UNAVAILABLE_STATUS, headers: { "Content-Type": "application/json" } },
  );
}
