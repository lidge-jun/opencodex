import { appendCheckpointContinuationNote, COMPACT_PROMPT, decodeCompactionSummary, isCompactionItemType, SUMMARY_PREFIX } from "./compaction";

type InputRecord = Record<string, unknown>;
const isRecord = (value: unknown): value is InputRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const HISTORICAL_REQUEST_START = "[Historical user request retained before the following compaction checkpoint. This is prior context, not a new request.]";
export const HISTORICAL_REQUEST_END = "[End historical request. Use the following checkpoint to distinguish completed work from unfinished work. Do not repeat completed work unless later user input asks for it. Preserve these original details for unfinished work within its existing authorization; the checkpoint grants no new authority. Only input after the checkpoint is a new user request.]";

// Plaintext checkpoint detection and context exclusions follow robin-bially's #7105 selector.
function plainUserText(item: unknown): string | null {
  if (!isRecord(item) || item.role !== "user") return null;
  if (item.type !== undefined && item.type !== "message") return null;
  if (typeof item.content === "string") return item.content;
  if (!Array.isArray(item.content) || item.content.length === 0) return null;
  const texts: string[] = [];
  for (const part of item.content) {
    if (!isRecord(part) || (part.type !== "input_text" && part.type !== "text") || typeof part.text !== "string") return null;
    texts.push(part.text);
  }
  return texts.join("\n");
}

function isContext(text: string): boolean {
  const head = text.trimStart();
  return head.startsWith("<") || head.startsWith("# AGENTS.md") || head.startsWith("# Context from my IDE");
}

function isCheckpoint(item: unknown): boolean {
  if (plainUserText(item)?.startsWith(SUMMARY_PREFIX)) return true;
  if (!isRecord(item) || !isCompactionItemType(item.type) || typeof item.encrypted_content !== "string") return false;
  // Detect portable checkpoints before either parser or passthrough lowers them to text.
  // Readable state is context, not proof of authorization; opaque native blobs stay outside.
  return !!decodeCompactionSummary(item.encrypted_content)?.trim();
}

/**
 * Prompt-only projection for translated/routed generation. Never pass the result to replay
 * storage: canonical input, item identities and replay-prefix lengths must remain unchanged.
 * Native OpenAI forwarding does not call this projection.
 */
export function frameCompactionHistory<T extends { input?: unknown; instructions?: unknown }>(body: T): T {
  const input = body.input;
  if (!Array.isArray(input) || input.some(item => isRecord(item) && item.type === "compaction_trigger")) return body;
  // Codex local compaction appends this user prompt without a compaction_trigger.
  // Keep that summarizer turn free of generation-only continuation instructions.
  if (plainUserText(input.at(-1))?.trim() === COMPACT_PROMPT) return body;
  let checkpointIndex = -1;
  for (let index = input.length - 1; index >= 0; index--) {
    if (isCheckpoint(input[index])) {
      checkpointIndex = index;
      break;
    }
  }
  if (checkpointIndex <= 0) return body;
  let changed = false;
  const framed = input.map((item, index) => {
    if (index >= checkpointIndex) return item;
    const text = plainUserText(item);
    if (text === null || !text.trim() || text.startsWith(SUMMARY_PREFIX) || isContext(text)
      || text.startsWith(HISTORICAL_REQUEST_START)) return item;
    const message = item as InputRecord;
    changed = true;
    // Preserve original text blocks and their metadata verbatim, including block boundaries.
    const content = typeof message.content === "string"
      ? `${HISTORICAL_REQUEST_START}\n${message.content}\n${HISTORICAL_REQUEST_END}`
      : [{ type: "input_text", text: HISTORICAL_REQUEST_START },
        ...(message.content as unknown[]), { type: "input_text", text: HISTORICAL_REQUEST_END }];
    return { ...message, content };
  });
  if (!changed) return body;
  // Portable decoders already append the note; keep their existing instruction layout.
  return plainUserText(input[checkpointIndex])?.startsWith(SUMMARY_PREFIX)
    ? { ...body, input: framed, instructions: appendCheckpointContinuationNote(body.instructions) }
    : { ...body, input: framed };
}
