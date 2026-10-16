import type { OcxMessagePhase } from "../types";
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
 * untouched, and each rewritten message stays buffered exactly one event, so
 * this adds no end-to-end latency, only one event of retention.
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

function withSnapshotPhases(block: string, phase: OcxMessagePhase): string {
  const parsed = parseDataPayload(block);
  if (!parsed) return block;
  const response = parsed.response;
  if (!isPlainObject(response) || !Array.isArray(response.output)) return block;
  let changed = false;
  const output = response.output.map((item: unknown) => {
    if (isPlainObject(item) && item.type === "message" && item.phase === undefined) {
      changed = true;
      return { ...item, phase };
    }
    return item;
  });
  if (!changed) return block;
  const patched = { ...parsed, response: { ...response, output } };
  return replaceSseDataPayload(block, JSON.stringify(patched));
}

export function createResponsesPhaseInferenceBlockRewrite(): SseBlockRewrite {
  // At most one message-done block is held at a time; the next block decides
  // its phase and is then processed itself. A malformed block releases the
  // buffer unchanged rather than rewriting data we could not validate.
  let pending: string | null = null;

  const releasePending = (): readonly string[] => {
    if (pending === null) return [];
    const block = pending;
    pending = null;
    return [block];
  };

  const rewrite = (block: string): readonly string[] => {
    const parsed = parseDataPayload(block);
    const type = typeof parsed?.type === "string" ? parsed.type : null;
    if (TERMINAL_EVENT_TYPES.has(type!)) {
      // Turn end: any still-buffered message is the final answer, and the
      // terminal snapshot mirrors the same phase for consistency.
      return [
        ...releasePending().map(b => withMessagePhase(b, "final_answer")),
        type === "response.failed" ? block : withSnapshotPhases(block, "final_answer"),
      ];
    }
    if (type === "response.output_item.done" && isMessageDoneBlock(block)) {
      // A following message done means the turn continued past the buffered
      // one (a phase change or a guarded continuation): commentary. Buffer
      // the current block for classification by whatever comes next.
      const released = releasePending().map(b => withMessagePhase(b, "commentary"));
      pending = block;
      return released;
    }
    if (type === null) {
      // Unparseable / non-JSON blocks (e.g. the [DONE] sentinel) carry no
      // classification evidence; release the buffer unchanged.
      return [...releasePending(), block];
    }
    // Any other protocol event after a completed message proves the turn
    // continued past it (tool calls, reasoning, a new item): commentary.
    return [...releasePending().map(b => withMessagePhase(b, "commentary")), block];
  };

  return Object.assign(rewrite, {
    dispose: () => {
      // Relay teardown after a terminal event leaves nothing pending. An
      // abnormal teardown before classification drops the retained block,
      // since the stream is failing anyway and no phase was ever proven.
      pending = null;
    },
  });
}
