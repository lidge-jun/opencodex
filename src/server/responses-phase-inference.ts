import type { OcxMessagePhase } from "../types";
import { Buffer } from "node:buffer";
import type { TranslatorBudget } from "../lib/translator-budget";
import type { SseBlockRewrite } from "./sse-payload-rewrite";
import { replaceSseDataPayload, sseDataPayload } from "./sse-payload-rewrite";

/**
 * Opt-in per-provider phase inference for Responses passthrough streams.
 *
 * OpenAI models annotate assistant messages with a commentary/final_answer
 * phase; the Codex desktop UI collapses commentary into progress rows and
 * only fully renders the final answer. Third-party gateways forward plain
 * Responses items without that field, so every narration chunk renders
 * expanded. The wire has no phase field, so phase is inferred from what
 * follows each completed message, mirroring the openai-chat bridge strategy:
 * a message followed by tool-call work is commentary; a message at turn end
 * is the final answer. Messages already carrying commentary or final_answer
 * are left untouched and forwarded without buffering; a null or unknown phase
 * is inferred like a missing one. Each rewritten message stays
 * buffered until the next protocol event (SSE keepalives keep it pending).
 * Live text deltas are not buffered, but message completion waits for that
 * event. Snapshots reuse each item decision when their phase is absent,
 * matched by item id or, when either side lacks an id, by output index;
 * explicit snapshot phases take precedence, and failed snapshots are untouched.
 */

const TERMINAL_EVENT_TYPES = new Set([
  "response.completed",
  "response.incomplete",
  "response.failed",
]);
const TOOL_CALL_ITEM_TYPES = new Set([
  "function_call",
  "custom_tool_call",
  "local_shell_call",
  "shell_call",
  "apply_patch_call",
  "mcp_call",
  "tool_search_call",
  "web_search_call",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Only these two values are decisions; null or unknown phases count as missing. */
function isMessagePhase(value: unknown): value is OcxMessagePhase {
  return value === "commentary" || value === "final_answer";
}

function isToolCallItem(item: unknown): boolean {
  if (!isPlainObject(item)) return false;
  const type = item.type;
  return typeof type === "string"
    && (TOOL_CALL_ITEM_TYPES.has(type)
      // Unknown hosted/extension call shapes still prove the turn continued.
      || (type.endsWith("_call") && !type.endsWith("_call_output")));
}

function parseDataPayload(block: string): Record<string, unknown> | null {
  const payload = sseDataPayload(block);
  if (payload === null) return null;
  try {
    const parsed = JSON.parse(payload) as unknown;
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isDoneSentinel(block: string): boolean {
  return sseDataPayload(block)?.trim() === "[DONE]";
}

function isMessageDoneBlock(block: string): boolean {
  const parsed = parseDataPayload(block);
  return parsed?.type === "response.output_item.done"
    && isPlainObject(parsed.item) && parsed.item.type === "message";
}

function withMessagePhase(block: string, phase: OcxMessagePhase): string {
  const parsed = parseDataPayload(block);
  if (!parsed || parsed.type !== "response.output_item.done") return block;
  if (!isPlainObject(parsed.item) || isMessagePhase(parsed.item.phase)) return block;
  const patched = { ...parsed, item: { ...parsed.item, phase } };
  return replaceSseDataPayload(block, JSON.stringify(patched));
}

/** One per-item decision, findable by item id and by output index. */
interface PhaseDecision {
  readonly id: string | null;
  readonly index: number | null;
  readonly phase: OcxMessagePhase;
}

interface PhaseDecisions {
  readonly byId: ReadonlyMap<string, PhaseDecision>;
  readonly byIndex: ReadonlyMap<number, PhaseDecision>;
}

function outputIndexOf(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * The phase already emitted on the wire for the snapshot item at `position`.
 * An id match wins. A position match is used only when the event or the
 * snapshot item lacks an id, so two different ids never share a decision.
 */
function decidedPhase(decisions: PhaseDecisions, id: string | null, position: number): OcxMessagePhase | undefined {
  const byId = id !== null ? decisions.byId.get(id) : undefined;
  if (byId) return byId.phase;
  const byIndex = decisions.byIndex.get(position);
  return byIndex && (byIndex.id === null || id === null) ? byIndex.phase : undefined;
}

function withSnapshotPhases(block: string, decisions: PhaseDecisions): string {
  const parsed = parseDataPayload(block);
  if (!parsed) return block;
  const response = parsed.response;
  if (!isPlainObject(response) || !Array.isArray(response.output)) return block;
  let changed = false;
  const output = response.output.map((item: unknown, position: number) => {
    if (isPlainObject(item) && item.type === "message" && !isMessagePhase(item.phase)) {
      // Mirror the decision already emitted for this item on the wire, so
      // clients reconciling the final snapshot never re-expand a message
      // whose output_item.done said commentary. Items the rewrite never saw
      // (joined mid-stream, no buffered decision) fall back to final_answer.
      const id = typeof item.id === "string" ? item.id : null;
      const phase = decidedPhase(decisions, id, position) ?? "final_answer";
      changed = true;
      return { ...item, phase };
    }
    return item;
  });
  if (!changed) return block;
  const patched = { ...parsed, response: { ...response, output } };
  return replaceSseDataPayload(block, JSON.stringify(patched));
}

export function createResponsesPhaseInferenceBlockRewrite(budget: TranslatorBudget): SseBlockRewrite {
  // At most one message-done block is held at a time; the next block decides
  // its phase and is then processed itself. Malformed blocks pass through
  // without consuming the pending decision. Per-item decisions fill missing
  // snapshot phases. Both pending blocks and decisions share the request
  // retention budget and are released at a terminal event or teardown.
  let pending: string | null = null;
  let pendingBytes = 0;
  let decisionBytes = 0;
  const byId = new Map<string, PhaseDecision>();
  const byIndex = new Map<number, PhaseDecision>();
  const decisions: PhaseDecisions = { byId, byIndex };
  const scope = { kind: "retained_collectors" as const };

  const clearState = (): void => {
    budget.releaseRetained(pendingBytes + decisionBytes, scope);
    pending = null;
    pendingBytes = 0;
    decisionBytes = 0;
    byId.clear();
    byIndex.clear();
  };

  const decisionSize = (decision: PhaseDecision): number =>
    Buffer.byteLength(JSON.stringify([decision.id, decision.index, decision.phase]));

  const rememberPhase = (item: unknown, outputIndex: unknown, phase: OcxMessagePhase): void => {
    const id = isPlainObject(item) && typeof item.id === "string" ? item.id : null;
    const index = outputIndexOf(outputIndex);
    if (id === null && index === null) return;
    const next: PhaseDecision = { id, index, phase };
    const replaced = new Set<PhaseDecision>();
    const previousById = id !== null ? byId.get(id) : undefined;
    const previousByIndex = index !== null ? byIndex.get(index) : undefined;
    if (previousById) replaced.add(previousById);
    if (previousByIndex) replaced.add(previousByIndex);
    let delta = decisionSize(next);
    for (const previous of replaced) delta -= decisionSize(previous);
    // Charge before mutating, so a budget rejection leaves state consistent.
    if (delta > 0) budget.chargeRetained(delta, scope);
    else if (delta < 0) budget.releaseRetained(-delta, scope);
    for (const previous of replaced) {
      if (previous.id !== null && byId.get(previous.id) === previous) byId.delete(previous.id);
      if (previous.index !== null && byIndex.get(previous.index) === previous) byIndex.delete(previous.index);
    }
    if (id !== null) byId.set(id, next);
    if (index !== null) byIndex.set(index, next);
    decisionBytes += delta;
  };

  const releasePending = (phase: OcxMessagePhase): readonly string[] => {
    if (pending === null) return [];
    const block = pending;
    const parsed = parseDataPayload(block);
    rememberPhase(parsed?.item, parsed?.output_index, phase);
    const patched = withMessagePhase(block, phase);
    budget.releaseRetained(pendingBytes, scope);
    pending = null;
    pendingBytes = 0;
    return [patched];
  };

  const rewrite = (block: string): readonly string[] => {
    const parsed = parseDataPayload(block);
    const type = typeof parsed?.type === "string" ? parsed.type : null;
    if (TERMINAL_EVENT_TYPES.has(type!)) {
      // Turn end: any still-buffered message is the final answer, and the
      // terminal snapshot mirrors the same per-item decisions for consistency.
      const released = releasePending("final_answer");
      const snapshot = type === "response.failed" ? block : withSnapshotPhases(block, decisions);
      clearState();
      return [...released, snapshot];
    }
    if (type === "response.output_item.done" && isMessageDoneBlock(block)) {
      const item = parsed?.item;
      if (isPlainObject(item) && isMessagePhase(item.phase)) {
        // An explicit upstream phase needs no inference: forward immediately
        // instead of buffering a message that an abnormal teardown would
        // otherwise drop before it was ever emitted.
        const released = releasePending("commentary");
        rememberPhase(item, parsed?.output_index, item.phase);
        return [...released, block];
      }
      // A following message done means the turn continued past the buffered
      // one (a phase change or a guarded continuation): commentary. Buffer
      // the current block for classification by whatever comes next.
      const released = releasePending("commentary");
      const bytes = Buffer.byteLength(block);
      budget.chargeRetained(bytes, scope);
      pending = block;
      pendingBytes = bytes;
      return released;
    }
    if (type === null) {
      // Comment keepalives and other non-JSON data blocks carry no
      // classification evidence in either direction, so a still-buffered
      // message stays pending across them. The [DONE] sentinel closes the
      // stream cleanly, which proves the buffered message was the turn's
      // final answer.
      if (isDoneSentinel(block)) {
        const released = releasePending("final_answer");
        clearState();
        return [...released, block];
      }
      return [block];
    }
    // Any other protocol event after a completed message proves the turn
    // continued past it (tool calls, reasoning, a new item): commentary.
    return [...releasePending("commentary"), block];
  };

  return Object.assign((block: string): readonly string[] => {
    try { return rewrite(block); }
    catch (error) {
      clearState();
      throw error;
    }
  }, {
    dispose: () => {
      // Relay teardown after a terminal event leaves nothing pending. An
      // abnormal teardown before classification drops the retained block,
      // since the stream is failing anyway and no phase was ever proven.
      clearState();
    },
  });
}
