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
 * is the final answer. Messages already carrying an explicit phase are left
 * untouched and forwarded without buffering. Each rewritten message stays
 * buffered until the next protocol event (SSE keepalives keep it pending).
 * Live text deltas are not buffered, but message completion waits for that
 * event. Snapshots reuse each item decision when their phase is absent;
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
  if (!isPlainObject(parsed.item) || parsed.item.phase !== undefined) return block;
  const patched = { ...parsed, item: { ...parsed.item, phase } };
  return replaceSseDataPayload(block, JSON.stringify(patched));
}

function withSnapshotPhases(block: string, inferred: ReadonlyMap<string, OcxMessagePhase>): string {
  const parsed = parseDataPayload(block);
  if (!parsed) return block;
  const response = parsed.response;
  if (!isPlainObject(response) || !Array.isArray(response.output)) return block;
  let changed = false;
  const output = response.output.map((item: unknown) => {
    if (isPlainObject(item) && item.type === "message" && item.phase === undefined) {
      // Mirror the decision already emitted for this item on the wire, so
      // clients reconciling the final snapshot never re-expand a message
      // whose output_item.done said commentary. Items the rewrite never saw
      // (joined mid-stream, no buffered decision) fall back to final_answer.
      const id = typeof item.id === "string" ? item.id : null;
      const phase = (id !== null ? inferred.get(id) : undefined) ?? "final_answer";
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
  let inferredBytes = 0;
  const inferred = new Map<string, OcxMessagePhase>();
  const scope = { kind: "retained_collectors" as const };

  const clearState = (): void => {
    budget.releaseRetained(pendingBytes + inferredBytes, scope);
    pending = null;
    pendingBytes = 0;
    inferredBytes = 0;
    inferred.clear();
  };

  const rememberPhase = (id: string, phase: OcxMessagePhase): void => {
    const previous = inferred.get(id);
    const bytes = Buffer.byteLength(JSON.stringify([id, phase]));
    const previousBytes = previous === undefined ? 0 : Buffer.byteLength(JSON.stringify([id, previous]));
    const delta = bytes - previousBytes;
    if (delta > 0) budget.chargeRetained(delta, scope);
    else if (delta < 0) budget.releaseRetained(-delta, scope);
    inferred.set(id, phase);
    inferredBytes += delta;
  };

  const messageIdOf = (block: string): string | null => {
    const parsed = parseDataPayload(block);
    const item = parsed?.item;
    return isPlainObject(item) && typeof item.id === "string" ? item.id : null;
  };

  const releasePending = (phase: OcxMessagePhase): readonly string[] => {
    if (pending === null) return [];
    const block = pending;
    const id = messageIdOf(block);
    if (id !== null) rememberPhase(id, phase);
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
      const snapshot = type === "response.failed" ? block : withSnapshotPhases(block, inferred);
      clearState();
      return [...released, snapshot];
    }
    if (type === "response.output_item.done" && isMessageDoneBlock(block)) {
      const item = parsed?.item;
      if (isPlainObject(item) && item.phase !== undefined) {
        // An explicit upstream phase needs no inference: forward immediately
        // instead of buffering a message that an abnormal teardown would
        // otherwise drop before it was ever emitted.
        const released = releasePending("commentary");
        if (typeof item.id === "string" && (item.phase === "commentary" || item.phase === "final_answer")) {
          rememberPhase(item.id, item.phase);
        }
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
