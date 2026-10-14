/**
 * Opt-in `compactionDropRetainedRequests` (#6764 follow-up to #7003).
 *
 * After a compaction, Codex's replacement history keeps recent user requests verbatim in front of
 * one `SUMMARY_PREFIX` checkpoint message (codex-rs `build_compacted_history`, mirrored for routed
 * models by `buildCompactV1Output`). Some routed models read those retained requests as open
 * orders and redo a request the checkpoint already reports as finished. With the option on, the
 * plain-text user requests that sit before the latest checkpoint are removed from the outbound
 * input; the checkpoint itself already records them.
 *
 * Deliberately narrow:
 * - only a plaintext checkpoint (a user message starting with `SUMMARY_PREFIX`) qualifies; an
 *   opaque native compaction blob has no readable summary, so nothing is dropped in front of it;
 * - only user messages made entirely of text parts are dropped; images, files, assistant turns,
 *   tool items and earlier checkpoints are kept;
 * - contextual wrappers Codex injects as user messages (environment context, AGENTS.md, IDE
 *   context) are kept;
 * - a compaction (summarizer) turn is never touched, because it must see the whole history.
 */
import { SUMMARY_PREFIX } from "./compaction";
import { previousResponseReplayPrefixLength, shrinkPreviousResponseReplayPrefix } from "./state";

type InputRecord = Record<string, unknown>;

function isRecord(value: unknown): value is InputRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Text of a user message whose content is only text parts; null for anything else. */
function plainUserText(item: unknown): string | null {
  if (!isRecord(item) || item.role !== "user") return null;
  if (item.type !== undefined && item.type !== "message") return null;
  const content = item.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content) || content.length === 0) return null;
  const texts: string[] = [];
  for (const part of content) {
    if (!isRecord(part) || (part.type !== "input_text" && part.type !== "text") || typeof part.text !== "string") return null;
    texts.push(part.text);
  }
  return texts.join("\n");
}

/** Codex-injected context rides as user messages; these are not requests and stay. */
function isContextualUserText(text: string): boolean {
  const head = text.trimStart();
  return head.startsWith("<") || head.startsWith("# AGENTS.md") || head.startsWith("# Context from my IDE");
}

function isCheckpointText(text: string): boolean {
  return text.startsWith(SUMMARY_PREFIX);
}

export type RetainedRequestsDrop = { input: unknown[]; removedIndices: number[] };

/**
 * Returns the input without the retained requests in front of the latest plaintext checkpoint,
 * plus the original indices removed; null when nothing qualifies (including compaction turns).
 */
export function dropRequestsRetainedBeforeCheckpoint(input: unknown): RetainedRequestsDrop | null {
  if (!Array.isArray(input)) return null;
  if (input.some(item => isRecord(item) && item.type === "compaction_trigger")) return null;
  let checkpointIndex = -1;
  for (let index = input.length - 1; index >= 0; index--) {
    const text = plainUserText(input[index]);
    if (text !== null && isCheckpointText(text)) {
      checkpointIndex = index;
      break;
    }
  }
  if (checkpointIndex <= 0) return null;
  const removedIndices: number[] = [];
  for (let index = 0; index < checkpointIndex; index++) {
    const text = plainUserText(input[index]);
    if (text === null || text.trim().length === 0 || isCheckpointText(text) || isContextualUserText(text)) continue;
    removedIndices.push(index);
  }
  if (removedIndices.length === 0) return null;
  const removed = new Set(removedIndices);
  return { input: input.filter((_, index) => !removed.has(index)), removedIndices };
}

/**
 * Applies the drop to a raw request body in place. When the input starts with items replayed from
 * previous_response_id state, the recorded replay prefix shrinks by the removals inside it, so the
 * parser's prefix boundary still points at the first client-carried item. True when items were removed.
 */
export function dropRetainedRequestsInBody(body: unknown): boolean {
  if (!isRecord(body)) return false;
  const dropped = dropRequestsRetainedBeforeCheckpoint(body.input);
  if (!dropped) return false;
  const prefixLength = previousResponseReplayPrefixLength(body);
  body.input = dropped.input;
  shrinkPreviousResponseReplayPrefix(body, dropped.removedIndices.filter(index => index < prefixLength).length);
  return true;
}
