import { create, fromBinary, toBinary, toJson } from "@bufbuild/protobuf";
import { fromJson, type JsonValue } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import type { OcxAssistantContentPart, OcxMessage, OcxToolResultMessage } from "../../types";
import { namespacedToolName } from "../../types";
import type { CursorRunRequest } from "./types";
import { decodeCursorCallId } from "./call-id";
import { cursorNeedsExternalToolContinuation, isCursorExternalWireModel } from "./discovery";
import { normalizeCursorToolResultText } from "./tool-result-normalize";
import { debugProviderDiagnostic } from "../../lib/debug";
import {
  createCursorBlobRequestScope,
  cursorBlobByteLength,
  cursorBlobMaxEntryBytes,
  releaseCursorBlobRequestScope,
  sealCursorBlobRequestScope,
  storeCursorBlob,
  type CursorBlobRequestScopeToken,
} from "./native-exec";
import { CursorRootEnvelopeLimitError } from "./cursor-errors";
import { buildSelectedContext, CURSOR_VISION_IMAGE_HISTORY_MARKER } from "./images";
import { estimateTokens } from "../../lib/token-estimate";
import { parseDataUrl } from "../image";
import {
  AgentClientMessageSchema,
  AgentConversationTurnStructureSchema,
  AssistantMessageSchema,
  AgentRunRequestSchema,
  ConversationActionSchema,
  ConversationStepSchema,
  ConversationStateStructureSchema,
  type ConversationStateStructure,
  ConversationTurnStructureSchema,
  McpArgsSchema,
  McpSuccessSchema,
  McpTextContentSchema,
  McpImageContentSchema,
  McpToolCallSchema,
  McpToolResultContentItemSchema,
  McpToolResultSchema,
  McpToolsSchema,
  type McpToolDefinition,
  ModelDetailsSchema,
  RequestedModelSchema,
  RequestedModel_ModelParameterbytesSchema,
  ResumeActionSchema,
  RequestContextSchema,
  RequestContextEnvSchema,
  ThinkingMessageSchema,
  ToolCallSchema,
  UserMessageActionSchema,
  UserMessageSchema,
} from "./gen/agent_pb";
import {
  appendCursorGenericToolUseHint,
  cursorToolsForActivePrompt,
  buildCursorToolGuidanceSystemNote,
  buildCursorToolDefinitions,
  cursorToolWireName,
  cursorRequestHasShellAlias,
  CURSOR_SHELL_ALIAS_SYSTEM_NOTE,
  OCX_RESPONSES_TOOL_PROVIDER,
} from "./tool-definitions";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Parameter id advertised by Cursor's `default` model for its Cost/Balance/Intelligence control. */
export const CURSOR_ROUTING_LEVEL_PARAMETER_ID = "optimization";
// Cursor external workers reject oversized root replay sets with a late invalid_argument after
// hydrating every blob (observed at 208 roots with usedTokens=0). Keep headroom below that boundary,
// retaining all system prompts and the newest model-visible history. Cursor IDE similarly bounds /
// compacts long conversations rather than replaying an unbounded message list.
export const CURSOR_EXTERNAL_ROOT_BLOB_LIMIT = 192;
/** Approximate prompt-size guard; tool schemas and protocol framing consume context separately. */
export const CURSOR_EXTERNAL_ROOT_BYTE_LIMIT = 512 * 1024;
/**
 * Byte budget for the serialized arguments named inside ONE replayed tool-result envelope. The
 * invocation identifies the call; the result is the payload. Without an independent cap, a single
 * large-but-legitimate argument (a 600 KiB file write) consumed the whole root history budget and
 * the result output was truncated away instead.
 */
export const CURSOR_INVOCATION_ARGUMENTS_BYTE_LIMIT = 2 * 1024;

/**
 * Action text for external-model tool-result continuations. Native models keep
 * resumeAction; external wire models continue as userMessageAction so the
 * results already stored in history blobs are visible without a ResumeAction.
 */
export const CURSOR_EXTERNAL_TOOL_CONTINUATION_TEXT =
  "Continue: the requested tool results are provided in the conversation history above.";

/** Runtime timezone for protobuf RequestContextEnv (dynamic, never hardcoded). */
function runtimeTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  } catch {
    return "UTC";
  }
}

/** Builds a RequestContext with env.timeZone populated dynamically. */
function buildRequestContext() {
  return create(RequestContextSchema, {
    env: create(RequestContextEnvSchema, {
      timeZone: runtimeTimeZone(),
    }),
  });
}

function jsonBlob(value: unknown): { data: Uint8Array; serialized: string } {
  const serialized = JSON.stringify(value);
  return { data: encoder.encode(serialized), serialized };
}

type RootBlobCandidate = {
  data: Uint8Array;
  byteLength: number;
  /**
   * The exact JSON handed to storeCursorBlob(). Retained so a token estimate can read
   * what the wire actually carries without re-serializing — and without drifting from
   * it after pruning or truncation (#373).
   */
  serialized: string;
  role: "system" | "user" | "assistant" | "toolResult";
  messageIndex?: number;
  /** Original JSON text payload used when an active tool result must be truncated to fit. */
  text?: string;
  /**
   * Set when a tool result was truncated past the point where any of its own output survives — either down
   * to the truncation marker alone, or mid-envelope before the `output:` line. The model reads both as an
   * empty answer to its own call, so a caller deciding whether the result "survived" must be able to tell
   * them apart from a real one (devlog 260829 070).
   */
  outputElided?: true;
};

function rootBlobCandidate(
  value: unknown,
  role: RootBlobCandidate["role"],
  opts?: { messageIndex?: number; text?: string },
): RootBlobCandidate {
  const { data, serialized } = jsonBlob(value);
  return {
    data,
    byteLength: data.byteLength,
    serialized,
    role,
    ...(opts?.messageIndex !== undefined ? { messageIndex: opts.messageIndex } : {}),
    ...(opts?.text !== undefined ? { text: opts.text } : {}),
  };
}

function toolResultRootPayload(text: string): { role: "assistant"; content: [{ type: "text"; text: string }] } {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function truncateToolResultBlob(entry: RootBlobCandidate, maxBytes: number): RootBlobCandidate | null {
  if (entry.byteLength <= maxBytes) return entry;
  if (entry.role !== "toolResult" || entry.text === undefined) return null;
  const marker = "\n…[truncated for Cursor external replay budget]";
  const encoded = encoder.encode(entry.text);
  // Leave headroom for JSON envelope (`role`/`content` wrapper) around the truncated text.
  let keepBytes = Math.min(encoded.byteLength, Math.max(0, maxBytes - encoder.encode(marker).byteLength - 96));
  for (let attempt = 0; attempt < 8; attempt++) {
    let end = keepBytes;
    while (end > 0 && end < encoded.byteLength && (encoded[end]! & 0xc0) === 0x80) end -= 1;
    const truncated = `${decoder.decode(encoded.subarray(0, end))}${marker}`;
    const result = rootBlobCandidate(
      toolResultRootPayload(truncated),
      "toolResult",
      { messageIndex: entry.messageIndex, text: truncated },
    );
    if (result.byteLength <= maxBytes) {
      // `output:` is the last fixed line of the envelope, so a cut landing before it leaves the header
      // and no answer. Flag it: "a result root survived" would otherwise be true of a root that tells the
      // model nothing about what its tool returned.
      const outputStart = truncated.indexOf("\noutput:\n");
      const keptOutput = outputStart >= 0 && truncated.length > outputStart + "\noutput:\n".length + marker.length;
      return keptOutput ? result : { ...result, outputElided: true };
    }
    if (end === 0) break;
    keepBytes = Math.max(0, end - (result.byteLength - maxBytes) - 16);
  }
  const markerOnly = rootBlobCandidate(
    toolResultRootPayload(marker.trimStart()),
    "toolResult",
    { messageIndex: entry.messageIndex, text: marker.trimStart() },
  );
  return markerOnly.byteLength <= maxBytes ? { ...markerOnly, outputElided: true } : null;
}

function systemPromptBlobs(request: CursorRunRequest): RootBlobCandidate[] {
  const prompts = request.system.length > 0 ? [...request.system] : ["You are a helpful assistant."];
  if (cursorRequestHasShellAlias(request.tools)) prompts.push(CURSOR_SHELL_ALIAS_SYSTEM_NOTE);
  const cursorToolGuidance = buildCursorToolGuidanceSystemNote(
    cursorToolsForActivePrompt(request.tools, activePromptText(request), request.toolChoice),
    request.toolChoice,
  );
  if (cursorToolGuidance) prompts.push(cursorToolGuidance);
  return prompts.map(content => rootBlobCandidate({ role: "system", content }, "system"));
}

function assistantRootText(
  message: Extract<OcxMessage, { role: "assistant" }>,
  includeThinking: boolean,
): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map(part => (part.type === "text" ? part.text : includeThinking && part.type === "thinking" ? part.thinking : undefined))
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n");
}

// Cursor builds the actual model prompt from rootPromptMessagesJson (turns[] is UI/display metadata),
// so prior history must be replayed here or a ResumeAction has nothing model-visible to continue from.
// The active user message is excluded because it travels in the action. When the continuation cannot
// rely on native MCP turn state, tool results stay assistant-role text with a [Tool Result] /
// [Tool Error] marker so Cursor does not wrap them as `<user_query>` (#1992). Native resume models
// already carry the paired MCP result on turns[], so that marker is omitted from root replay — Auto
// few-shot-mimics it as chat text otherwise. Each entry is a SHA-256 blob ID.
function rootPromptMessages(
  request: CursorRunRequest,
  requestScope: CursorBlobRequestScopeToken,
  /**
   * Calls indexed from the FULL history. The checkpoint path replays only a suffix of
   * `rawMessages`, so a result in that suffix can have its originating call before the cut; indexing
   * from the slice alone silently dropped the invocation line for every checkpoint continuation,
   * which is where the defect this line prevents actually reappeared in live use.
   */
  knownCalls?: Map<string, Extract<OcxAssistantContentPart, { type: "toolCall" }>>,
  /**
   * Full-history index of `rawMessages[0]` for this call. Non-zero only on the checkpoint path, where
   * only a suffix is replayed but `knownCalls` still spans full history; the positional bound needs
   * both sides in the same space (devlog 260829 060).
   */
  knownCallsOffset = 0,
  /**
   * Roots the decoded checkpoint already carries, which this call's pruning must leave room for.
   *
   * The envelope guard downstream measures checkpoint roots PLUS this suffix and throws a
   * non-retryable 400 when the total exceeds the limit. Pruning against the full limit therefore
   * emitted a suffix that was individually legal and cumulatively fatal — invisible until suffix
   * replay actually grew (devlog 260829 070, audit r8 finding 3).
   */
  carriedRoots: { count: number; byteLength: number } = { count: 0, byteLength: 0 },
): {
  ids: Uint8Array[];
  byteLength: number;
  historyMessageStart: number;
  /** Serialized text of the roots that survived pruning, in wire order. */
  serialized: string[];
  /**
   * Source message index of each HISTORY root that survived pruning (system roots excluded).
   *
   * The checkpoint caller needs to know whether the specific message it is continuing from survived.
   * Neither role nor text can answer that: roles repeat, and matching the result's own output against the
   * serialized root fails on JSON escaping the moment real output contains a newline or a quote — which
   * made live continuations abandon their checkpoint on every turn (devlog 260829 070).
   */
  historyMessageIndexes: number[];
  /**
   * Message indexes whose root survived pruning but lost ALL of its own output to truncation, so only the
   * truncation marker remains. Aligned with nothing — membership is the whole signal (devlog 260829 070).
   */
  historyOutputElided: number[];
  /**
   * Message indexes of the trailing tool-result run as PRUNING saw it — root space, not raw-message space.
   * The two spaces diverge: a bare tool call with no text emits no root, so two sequentially-executed
   * results become adjacent roots while a raw-space scan still sees a trailing run of one. A caller that
   * re-derives the run from `rawMessages` therefore cannot see a result this function dropped for count
   * (audit r10). Emitted so the abandon decision reads the same set pruning acted on.
   */
  activeMessageIndexes: number[];
} {
  const entries = systemPromptBlobs(request);
  const systemEntryCount = entries.length;
  const messages = request.rawMessages;
  if (!messages?.length) {
    return {
      ids: entries.map(entry => storeCursorBlob(entry.data, requestScope)),
      byteLength: entries.reduce((sum, entry) => sum + entry.byteLength, 0),
      historyMessageStart: 0,
      serialized: entries.map(entry => entry.serialized),
      historyMessageIndexes: [],
      historyOutputElided: [],
      activeMessageIndexes: [],
    };
  }

  const externalModel = isCursorExternalWireModel(request.modelId);
  const echoToolResultInRoot = cursorNeedsExternalToolContinuation(request.modelId);
  // Replayed results name the invocation that produced them; without it the result is orphaned
  // (devlog 260829 000_rca). Indexed once per request rather than rescanned per result.
  const replayedCalls = echoToolResultInRoot ? (knownCalls ?? toolCallsByCallId(messages)) : undefined;
  const lastRawIsToolResult = messages.at(-1)?.role === "toolResult";
  const activeUserIndex = lastRawIsToolResult ? -1 : lastActionIndex(messages);
  // Repetition breaker (devlog 260826 gap-9): external full-replay flattens history to text,
  // so N identical assistant/tool-result rounds replay as N identical lines and PRIME the model
  // to emit the same line again (self-reinforcing loop: S2a 180x, identical-probe repetition).
  // Collapse consecutive duplicates into one entry + a count marker, and count collapses so a
  // strategy-change note can be appended when the pattern is severe.
  let lastReplayText: string | undefined;
  let lastReplayEntry: RootBlobCandidate | undefined;
  let collapsedRepeats = 0;
  let maxRunLength = 1;
  let currentRun = 1;
  const pushDeduped = (
    payload: { role: string; content: [{ type: "text"; text: string }] },
    role: RootBlobCandidate["role"],
    opts: { messageIndex: number; text?: string },
    normalized: string,
  ): void => {
    if (externalModel && lastReplayText !== undefined && normalized === lastReplayText && lastReplayEntry) {
      collapsedRepeats++;
      currentRun++;
      if (currentRun > maxRunLength) maxRunLength = currentRun;
      const marked = `${normalized}\n[note: this exact output was produced ${currentRun} times in a row]`;
      const replacement = rootBlobCandidate(
        { role: payload.role, content: [{ type: "text", text: marked }] },
        role,
        opts,
      );
      entries[entries.indexOf(lastReplayEntry)] = replacement;
      lastReplayEntry = replacement;
      return;
    }
    currentRun = 1;
    const entry = rootBlobCandidate(payload, role, opts);
    entries.push(entry);
    lastReplayText = normalized;
    lastReplayEntry = entry;
  };

  for (let i = 0; i < messages.length; i++) {
    if (i === activeUserIndex) break;
    const message = messages[i];
    if (!message) continue;
    if (message.role === "user" || message.role === "developer") {
      const text = historyContentText(message).trim();
      // Cursor root replay expects OpenAI-style content parts for historical user messages.
      // A bare string survives blob hydration but external workers reject the completed replay
      // before tokenization (`usedTokens: 0`, then invalid_argument).
      if (text.length > 0) {
        lastReplayText = undefined;
        lastReplayEntry = undefined;
        currentRun = 1;
        entries.push(rootBlobCandidate({
          role: "user",
          content: [{ type: "text", text }],
        }, "user", { messageIndex: i }));
      }
    } else if (message.role === "assistant") {
      // External Cursor clients do not replay hidden reasoning as assistant-visible prompt text.
      // Native Composer state can preserve it through ThinkingMessage/history structures.
      const text = assistantRootText(message, !externalModel).trim();
      if (text.length > 0) {
        pushDeduped(
          { role: "assistant", content: [{ type: "text", text }] },
          "assistant",
          { messageIndex: i },
          text,
        );
      }
      // Assistant tool CALLS are NOT replayed as a separate visible "[Tool Call]" entry: a model
       // few-shot-mimics that marker and emits later tool calls as inert text (363-B guard in
      // tests/cursor-tool-continuation.test.ts). The invocation is instead named INSIDE the paired
      // "[Tool Result]" envelope below, which carries the same information without a mimickable
      // call template (devlog 260829 002_audit_round2).
    } else if (message.role === "toolResult") {
      // Native resume models already receive the paired MCP result through turns[]. Replaying
      // the same payload as assistant-role "[Tool Result]" / "[tool_result]" text teaches Auto
      // to echo that envelope as chat instead of continuing from the structured result.
      if (!echoToolResultInRoot) continue;
      // #1920: the prefix must reflect the NORMALIZED error state (an empty
      // node_repl result is an error even when the runtime said isError=false).
      const prefix = normalizedToolResult(message, contentToText(message.content)).isError ? "[Tool Error]" : "[Tool Result]";
      // The bound compares in full-history space: this loop's `i` is already full-history on the
      // full-replay path, and `knownCallsOffset` re-bases it when only a suffix is replayed.
      const text = `${prefix}\n${toolResultToText(message, callBefore(replayedCalls, decodeCursorCallId(message.toolCallId), knownCallsOffset + i))}`;
      pushDeduped(toolResultRootPayload(text), "toolResult", { messageIndex: i, text }, text);
    }
  }
  // Severe repetition: tell the model ONCE, imperatively, to change strategy.
  if (externalModel && maxRunLength >= 3) {
    entries.push(rootBlobCandidate({
      role: "user",
      content: [{ type: "text", text: `[context note] The transcript above contains the same output repeated ${maxRunLength} times in a row. Repeating it again is a failure. Take a DIFFERENT action now, or state plainly what is blocking progress.` }],
    }, "user", {}));
  }

  let selected = entries;
  let historyMessageStart = 0;
  // The trailing tool-result run in ROOT space, recorded before pruning can drop from it. Empty for a
  // native model or a non-external one, which never assemble a trailing run here at all.
  let activeMessageIndexes: number[] = [];
  if (externalModel) {
    // A non-zero offset means `rawMessages[0]` is NOT the conversation start: only the checkpoint
    // path passes one, and it passes `suffixStart`, the count of messages the checkpoint carries.
    // Named rather than tested inline because `knownCallsOffset` answers two different questions —
    // where to re-base a position (#2936) and whether this history has a covered predecessor — and
    // collapsing them back into one bare `!== 0` is how the second meaning gets lost again.
    const suffixContinuesCoveredTurn = knownCallsOffset > 0;
    const systemEntries = entries.slice(0, systemEntryCount);
    const history = entries.slice(systemEntryCount);
    const systemBytes = systemEntries.reduce((sum, entry) => sum + entry.byteLength, 0);
    // On the checkpoint path the caller appends ONLY the history roots to what the checkpoint already
    // carries (`suffixHistoryIds` is `ids.slice(suffixSystemCount)`), and the system roots the checkpoint
    // carries are already inside `carriedRoots`. Subtracting `systemEntryCount` there charges for them
    // twice, which cost a slot that was genuinely free: at 190 carried roots the limit came out 1 when 2
    // results fit, and the count bound below then dropped an answered call for no reason (audit r10).
    const chargeableSystemCount = suffixContinuesCoveredTurn ? 0 : systemEntryCount;
    const historyLimit = Math.max(0, CURSOR_EXTERNAL_ROOT_BLOB_LIMIT - chargeableSystemCount - carriedRoots.count);
    // Only the COUNT is relaxed. The byte side keeps charging `systemBytes` on both paths: the same
    // double-charge argument applies in principle, but no configuration could be found where relaxing it
    // changes the assembled payload — 6 crossings of carried bytes against system size against result size
    // in the deciding band produced byte-identical output with and without it. Untested new code on the
    // envelope path is a liability rather than a saving, and charging the bytes twice only ever errs
    // conservative, so the relaxation is deliberately not made here (audit r11).
    const historyBudget = Math.max(0, CURSOR_EXTERNAL_ROOT_BYTE_LIMIT - systemBytes - carriedRoots.byteLength);

    // Retain the active trailing tool-result block when it fits (may truncate text).
    // If even a truncation marker cannot fit the remaining budget, omit it rather than
    // emitting an oversized root blob.
    //
    // Walk past any SYNTHETIC trailing root first. The repetition breaker above appends a
    // `[context note]` user root after the transcript, and it stands for no message, so it carries no
    // `messageIndex`. Without this step the result-run walk stopped dead on that note: `activeStart`
    // came out equal to `history.length`, the trailing run was empty, and the results lost their
    // trailing-run status entirely — they fell through to `prior` and were pruned as ordinary history,
    // with no "keep at least one" guarantee and an empty `activeMessageIndexes` that sent the abandon
    // check back to the raw-message scan it must not use. Measured: a note-armed continuation at 186
    // carried roots was retained where the same shape without the note correctly abandoned, and the
    // note arms on three identical assistant narrations — the runaway-repetition shape this whole unit
    // exists to end, so the one input most likely to hit it (audit r11).
    let activeEnd = history.length;
    while (activeEnd > 0 && history[activeEnd - 1]?.messageIndex === undefined) activeEnd -= 1;
    let activeStart = activeEnd;
    while (activeStart > 0 && history[activeStart - 1]?.role === "toolResult") activeStart -= 1;
    // Reserve the synthetic tail's slots and bytes FIRST, and express every budget below net of it.
    // The tail is appended after all pruning, so a block that spends its room overruns the envelope,
    // and a block that divides the gross budget produces shares that cannot fit once it returns. Both
    // happened: the equal-share pass became structurally unfittable and fell through to deleting a whole
    // result, and the initiator-recovery block committed 51 bytes over the limit (audit r11, r12).
    // Affordability is decided BEFORE the reservation, because the reservation cannot represent a
    // deficit. `Math.max(0, …)` turns "the note cannot be paid for" into "the note costs nothing", and
    // the tail was appended regardless — so an envelope with 26 bytes free emitted a 246-byte note and
    // overran by 220. Holding the tail out of `historyEntries` is what made that unrecoverable: no block
    // below could see it to charge it.
    //
    // A trailing tool result hid this, because the abandon check's survival disjuncts rescue that shape.
    // The exposed shape is a turn that does NOT end in a result — an ordinary user interjection after a
    // repetitive stretch — where nothing else bounds the tail: 13 of 42 positions threw the
    // non-retryable 400 with the note armed and none without it (audit r13).
    //
    // When it does not fit, the note is dropped. That is the unit's own priority order: a missing
    // instruction is recoverable, a missing tool result restarts the loop this unit exists to end.
    const syntheticEntries = history.slice(activeEnd);
    const syntheticCountRaw = syntheticEntries.length;
    const syntheticBytesRaw = syntheticEntries.reduce((sum, entry) => sum + entry.byteLength, 0);
    // BOTH axes. The count conjunct was briefly dropped as inert on the reasoning that the count bound
    // below keeps one result and therefore always leaves a slot — which is exactly wrong at
    // `historyLimit === 1`, where that one free slot is the one the result takes. The note was then judged
    // affordable on bytes, the reservation clamped to 0, and the append pushed full replay to 193 roots:
    // four armed-only `CursorRootEnvelopeLimitError` throws at 191 system prompts, on both tails and both
    // suffix widths, where the same request without the note assembled 192 and succeeded.
    //
    // The sweep that called it inert varied CARRIED roots on the checkpoint path, where the count-full
    // disjunct abandons the checkpoint before `historyLimit` can reach 1. The reachable route is full
    // replay with many system prompts, and full replay has no abandon branch to rescue it (audit r14).
    const syntheticAffordable = historyBudget - syntheticBytesRaw >= 0
      && historyLimit - syntheticCountRaw >= 1;
    const syntheticCount = syntheticAffordable ? syntheticCountRaw : 0;
    const syntheticBytes = syntheticAffordable ? syntheticBytesRaw : 0;
    const historyLimitForReal = Math.max(0, historyLimit - syntheticCount);
    const historyBudgetForReal = Math.max(0, historyBudget - syntheticBytes);
    const active = history
      .slice(activeStart, activeEnd)
      .map(entry => truncateToolResultBlob(entry, historyBudgetForReal))
      .filter((entry): entry is RootBlobCandidate => entry !== null);
    // Record the run BEFORE any pruning below can shrink it, so the abandon decision downstream compares
    // against what pruning was asked to preserve rather than against a raw-message scan that cannot see
    // this run's true width (audit r10).
    activeMessageIndexes = history
      .slice(activeStart, activeEnd)
      .map(entry => entry.messageIndex)
      .filter((index): index is number => index !== undefined);
    let activeBytes = active.reduce((sum, entry) => sum + entry.byteLength, 0);
    // Shrink every active result toward an equal share before dropping any of them. Review found
    // that the previous `active.shift()` loop DELETED whole results: three ~220 KB results emitted
    // only the last two, and `call_0` vanished with its tool call still in the transcript. A
    // missing result is worse than a truncated one — the model sees a call it never got an answer
    // to, which is the pairing break #1527 reports, and the caller cannot tell it happened.
    if (active.length > 1 && activeBytes > historyBudgetForReal) {
      const share = Math.floor(historyBudgetForReal / active.length);
      for (let index = 0; index < active.length; index++) {
        const entry = active[index];
        if (!entry || entry.byteLength <= share) continue;
        const shrunk = truncateToolResultBlob(entry, share);
        if (shrunk) active[index] = shrunk;
      }
      activeBytes = active.reduce((sum, entry) => sum + entry.byteLength, 0);
    }
    // Only when even an equal share cannot fit — the marker alone has a floor, so enough results
    // still overflow — fall back to dropping the oldest.
    while (active.length > 1 && activeBytes > historyBudgetForReal) {
      const dropped = active.shift();
      activeBytes -= dropped?.byteLength ?? 0;
    }
    if (active.length === 1 && active[0] && activeBytes > historyBudgetForReal) {
      const truncated = truncateToolResultBlob(active[0], historyBudgetForReal);
      if (truncated) {
        active[0] = truncated;
        activeBytes = truncated.byteLength;
      } else {
        active.length = 0;
        activeBytes = 0;
      }
    }
    // COUNT-bound the trailing run, not only its bytes. `historyLimit` already subtracts what the
    // checkpoint carries, but until now it was consulted ONLY by the prior-history loop below, and
    // `historyEntries` was assembled as `[...keptPrior, ...active]` with no count check at all. The
    // shrink/drop loops above answer to `historyBudget` alone — `truncateToolResultBlob` makes a
    // result smaller, it never removes one to free a root SLOT — so a parallel tool-call batch
    // arrived unbounded: 190 carried roots plus a 3-result batch assembled 193 and threw the
    // non-retryable 400 this unit exists to remove (audit r9). Sequential pairs hid it, because a
    // trailing run of length 1 is the one case where the abandon test's `+ 1` is exactly right.
    //
    // Drop the OLDEST results first, matching the direction byte pressure already prunes, and keep
    // at least one: a continuation with no result is worthless, and the abandon decision downstream
    // reads `historyMessageIndexes` to notice exactly that and fall back to a full replay.
    while (active.length > 1 && active.length > historyLimitForReal) {
      const dropped = active.shift();
      activeBytes -= dropped?.byteLength ?? 0;
    }

    const prior = history.slice(0, activeStart);
    const keptPrior: RootBlobCandidate[] = [];
    let priorBytes = 0;
    // Take complete turns from the end: a turn starts at a user/developer root entry.
    //
    // Turn-granular admission needs a turn boundary to exist. A checkpoint suffix has NO user root at
    // all — its initiating turn is inside the checkpoint — so `turnStart` walks to 0, the entire prior
    // block becomes one all-or-nothing pseudo-turn, and the first budget overrun drops ALL of it.
    // Measured on the checkpoint path with 8 pairs of 64 KiB results: 2 roots, unchanged by the orphan
    // guard fix, because there was nothing left for that guard to strip. Admitting entry-by-entry keeps
    // as much recent history as fits instead of none (devlog 260829 070, audit r8 finding 2).
    let i = prior.length - 1;
    while (i >= 0 && keptPrior.length + active.length < historyLimitForReal) {
      let turnStart = i;
      if (!suffixContinuesCoveredTurn) {
        // Root-blob roles are a closed set of four (system, user, assistant, toolResult): a
        // developer message is normalized to a user root upstream, so "user" IS the turn start.
        // Review suspected a developer-role gap here; the type says it cannot occur.
        while (turnStart > 0 && prior[turnStart]?.role !== "user") turnStart -= 1;
      }
      const turn = prior.slice(turnStart, i + 1);
      const turnBytes = turn.reduce((sum, entry) => sum + entry.byteLength, 0);
      if (
        keptPrior.length + active.length + turn.length > historyLimitForReal
        || priorBytes + activeBytes + turnBytes > historyBudgetForReal
      ) {
        break;
      }
      keptPrior.unshift(...turn);
      priorBytes += turnBytes;
      i = turnStart - 1;
    }

    const trailingSynthetic = syntheticAffordable ? syntheticEntries : [];
    // Synthetic trailing roots — today only the repetition-breaker note — are held OUT of
    // `historyEntries` while the blocks below decide what survives, and appended once at assembly.
    //
    // They were briefly appended here instead, and every subsequent block then had to recognise a tail
    // it could not identify except by position. The initiator-recovery loop below could not: its floor
    // is "stop when one entry is left", so with `[toolResult, note]` it counted the note as the
    // survivor and shifted off the RESULT — a 600 KB tool output replaced by 193 bytes of note, leaving
    // a prompt that instructs the model to change strategy while showing it nothing its command
    // returned. Measured 166 of 432 byte-pressure configurations losing an answer that way. Keeping the
    // tail out means those blocks stay purely about real history and cannot mistake one for the other;
    // the budgets still charge for it, which is what stops it overrunning the envelope (audit r12).
    const historyEntries = [...keptPrior, ...active];
    // Guard against orphan assistant / toolResult at the start of the retained suffix.
    //
    // Premised on `history` starting where the CONVERSATION starts: only then does a leading
    // assistant/result entry mean its user turn was pruned. A checkpoint suffix breaks that premise —
    // it begins at `suffixStart`, so its first entry is routinely the assistant message whose
    // initiating user turn is inside the checkpoint. Running the loop there strips pair after pair
    // until only `active` survives, because the `break` fires only once the survivors ARE `active`:
    // measured 2 roots for 1, 2, 3 and 4 completed pairs in the suffix, so a growing conversation
    // replayed a constant payload and the model never saw the output of the command it just ran
    // (devlog 260829 070).
    if (!suffixContinuesCoveredTurn) {
      while (historyEntries[0]?.role === "assistant" || historyEntries[0]?.role === "toolResult") {
        // Never drop the sole active tool-result block.
        if (historyEntries.length <= active.length) break;
        historyEntries.shift();
      }
    }
    // #1527: the surviving history must not begin with a tool result. Byte pressure can consume the
    // whole budget with one large active result and drop the user turn that asked for it, and
    // `conversationTurns()` then discards the result too for lack of a current turn — the wire
    // request becomes system roots plus a bare result marker with no instruction, which a model
    // answers in a handful of tokens.
    //
    // Recover the initiating root and pay for it out of the tool-result text instead.
    //
    // This needs no full-replay/checkpoint distinction, which is worth stating because the plan
    // called for one. `activeStart > 0` confines the search to entries present in THIS call's
    // history, so a checkpoint suffix can only ever recover a turn from inside its own uncovered
    // slice — never one the checkpoint already carries. And for a suffix that does contain its
    // initiating turn, recovery is exactly as necessary as it is for a full replay: mode-gating it
    // would have recreated this defect for checkpoint continuations. Mutation testing found that;
    // the mode flag could not be made to fail a test because it was never load-bearing.
    if (
      historyEntries.length > 0
      && historyEntries[0]?.role === "toolResult"
      && activeStart > 0
    ) {
      let initiatorIndex = activeStart - 1;
      while (initiatorIndex >= 0 && history[initiatorIndex]?.role !== "user") {
        initiatorIndex -= 1;
      }
      const initiator = initiatorIndex >= 0 ? history[initiatorIndex] : undefined;
      if (initiator) {
        const withInitiator = [initiator, ...historyEntries];
        const initiatorBytes = withInitiator.reduce((sum, entry) => sum + entry.byteLength, 0);
        if (withInitiator.length <= historyLimitForReal && initiatorBytes <= historyBudgetForReal) {
          historyEntries.length = 0;
          historyEntries.push(...withInitiator);
        } else {
          // Make room for the initiator instead of abandoning it. Review found that gating this on
          // `historyEntries.length === 1` left the defect fully intact for the far more common
          // multi-result shape: one system root plus 191 small trailing results already fills the
          // count limit, so the initiator did not fit, the single-result branch did not apply, and
          // the request went out as 191 bare results with nothing asking for them — inside the new
          // envelope, so the guard could not catch it either.
          //
          // Drop the OLDEST results first, which is the same direction the byte-pressure loop above
          // already prunes, then truncate whatever survives. An instruction with fewer or shorter
          // results is answerable; results with no instruction are not.
          const kept = [...historyEntries];
          while (kept.length > 1 && kept.length + 1 > historyLimitForReal) kept.shift();
          let keptBytes = kept.reduce((sum, entry) => sum + entry.byteLength, 0);
          while (kept.length > 1 && initiator.byteLength + keptBytes > historyBudgetForReal) {
            const dropped = kept.shift();
            keptBytes -= dropped?.byteLength ?? 0;
          }
          if (kept.length === 1 && kept[0] && initiator.byteLength + keptBytes > historyBudgetForReal) {
            const room = historyBudgetForReal - initiator.byteLength;
            const shrunk = room > 0 ? truncateToolResultBlob(kept[0], room) : null;
            if (shrunk) {
              kept[0] = shrunk;
              keptBytes = shrunk.byteLength;
            }
          }
          // Only commit when the initiator genuinely fits alongside what is left. If the system
          // prompt has consumed the budget so completely that not even a truncation marker fits,
          // there is nothing honest to send here; the envelope guard downstream owns that case.
          if (kept.length + 1 <= historyLimitForReal && initiator.byteLength + keptBytes <= historyBudgetForReal) {
            historyEntries.length = 0;
            historyEntries.push(initiator, ...kept);
          }
        }
      }
    }
    // The synthetic tail goes on last, after every pruning decision is made, so telling the model to
    // change strategy is not dropped by the walk that stopped ignoring it — and so no pruning block has
    // to distinguish it from a real result by position. Its slots and bytes were already reserved above.
    selected = [...systemEntries, ...historyEntries, ...trailingSynthetic];
    const firstKept = historyEntries.find(entry => entry.messageIndex !== undefined);
    historyMessageStart = firstKept?.messageIndex ?? (messages.length);
  }

  return {
    ids: selected.map(entry => storeCursorBlob(entry.data, requestScope)),
    byteLength: selected.reduce((sum, entry) => sum + entry.byteLength, 0),
    historyMessageStart,
    serialized: selected.map(entry => entry.serialized),
    historyMessageIndexes: selected
      .slice(systemEntryCount)
      .map(entry => entry.messageIndex)
      .filter((index): index is number => index !== undefined),
    historyOutputElided: selected
      .slice(systemEntryCount)
      .filter(entry => entry.outputElided === true)
      .map(entry => entry.messageIndex)
      .filter((index): index is number => index !== undefined),
    activeMessageIndexes,
  };
}

function contentText(message: OcxMessage): string {
  if (message.role === "toolResult") return toolResultToText(message);
  if (typeof message.content === "string") return message.content;
  return message.content
    .map(part => {
      if (part.type === "text") return part.text;
      if (part.type === "thinking") return part.thinking;
      if (part.type === "image") return undefined;
      return undefined;
    })
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n");
}

function contentToText(content: OcxToolResultMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map(part => {
      if (part.type === "text") return part.text;
      if (part.type === "image") return CURSOR_VISION_IMAGE_HISTORY_MARKER;
      return undefined;
    })
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n");
}

/** History serializer. Replayed turns are text-only; never embed image bytes. */
function historyContentText(message: OcxMessage): string {
  if (message.role === "toolResult" || typeof message.content === "string") return contentText(message);
  return message.content
    .map(part => {
      if (part.type === "text") return part.text;
      if (part.type === "thinking") return part.thinking;
      if (part.type === "image") return CURSOR_VISION_IMAGE_HISTORY_MARKER;
      return undefined;
    })
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n");
}

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Decode a Codex inline image into Cursor wire bytes.
 *
 * `OcxImageContent.imageUrl` is either a `data:` URL or a remote https URL, so this cannot reuse
 * the MCP helper (which takes bare base64 plus a separate mime). It layers strict validation over
 * the shared `parseDataUrl` rather than tightening it, because Anthropic, Google, and Command Code
 * share that parser. `Buffer.from(x, "base64")` accepts many invalid strings silently, so the
 * charset is checked explicitly. Remote URLs are out of scope: `McpImageContent` needs bytes, and
 * fetching here would put network IO inside request construction.
 */
function decodeInlineImage(imageUrl: string): { bytes: Uint8Array; mimeType: string } | undefined {
  const parsed = parseDataUrl(imageUrl);
  if (!parsed) return undefined;
  const base64 = parsed.base64.trim();
  if (base64.length === 0 || base64.length % 4 !== 0 || !BASE64_PATTERN.test(base64)) return undefined;
  try {
    const bytes = Uint8Array.from(Buffer.from(base64, "base64"));
    if (bytes.length === 0) return undefined;
    return { bytes, mimeType: parsed.mediaType || "application/octet-stream" };
  } catch {
    return undefined;
  }
}

/**
 * A degraded image must never make a step LARGER than the legacy encoding did, or this change
 * could fail admission for a request that previously fit. The old placeholder was
 * `[image input unsupported by Cursor adapter phase 3: <detail>]`; anything we emit in its place
 * is truncated to that budget so the zero-image case is byte-bounded by the pre-change behavior.
 */
const LEGACY_IMAGE_PLACEHOLDER_BUDGET =
  "[image input unsupported by Cursor adapter phase 3: auto]".length;

function imagePlaceholder(reason: string): string {
  const text = `[image omitted: ${reason}]`;
  return text.length <= LEGACY_IMAGE_PLACEHOLDER_BUDGET
    ? text
    : `${text.slice(0, LEGACY_IMAGE_PLACEHOLDER_BUDGET - 1)}]`;
}

type DecodedResultPart =
  | { kind: "text"; text: string }
  | { kind: "image"; bytes: Uint8Array; mimeType: string }
  | { kind: "undecodable" };

type NormalizedToolResult = { text: string; isError: boolean };

/**
 * Decode a tool result's parts ONCE. `toolCallStep` may re-serialize a step several times while
 * shrinking it to fit blob admission, and decoding base64 on every attempt made that loop
 * quadratic (an audit measured ~3s for 100 images).
 */
function decodeResultParts(message: OcxToolResultMessage): DecodedResultPart[] | undefined {
  const content = message.content;
  if (typeof content === "string") return undefined;
  return content.map((part): DecodedResultPart => {
    if (part.type === "text") return { kind: "text", text: part.text };
    if (part.type === "video") return { kind: "text", text: "[video]" };
    const decoded = decodeInlineImage(part.imageUrl);
    return decoded ? { kind: "image", ...decoded } : { kind: "undecodable" };
  });
}

function countImages(parts: DecodedResultPart[] | undefined): number {
  return parts ? parts.filter(p => p.kind === "image").length : 0;
}

/**
 * Build the wire content items for a tool result, preserving part order.
 *
 * Images become real `McpImageContent` — the Cursor schema has an image case on
 * `McpToolResultContentItem`, and `native-exec-mcp.ts` already uses it for MCP-invoked tools.
 * Flattening them to placeholder text blinded every screenshot-returning tool (Computer Use,
 * browser QA) that Codex routes through this path.
 */
function toolResultContentItems(
  message: OcxToolResultMessage,
  decoded?: DecodedResultPart[],
  maxImages = Number.POSITIVE_INFINITY,
  normalizedText?: NormalizedToolResult,
) {
  const parts = decoded ?? decodeResultParts(message);
  const textItem = (text: string) => [create(McpToolResultContentItemSchema, {
    content: { case: "text" as const, value: create(McpTextContentSchema, { text }) },
  })];
  if (!parts) {
    const normalized = normalizedText
      ?? normalizedToolResult(message, typeof message.content === "string" ? message.content : "");
    return textItem(normalized.text);
  }
  const normalized = normalizedText ?? normalizedDecodedTextResult(message, parts);
  if (normalized) {
    // #1920/#1866: empty or failure-state Computer Use / node_repl results are
    // normalized before they reach the native wire. Pure-text part arrays use
    // the same newline-joined representation this serializer already emitted;
    // image-bearing and undecodable results stay on the lossless part path.
    return textItem(normalized.text);
  }
  // Images are dropped OLDEST first when the step must shrink: the most recent screenshot is the
  // one the model is reasoning about, so it is the last to go.
  const totalImages = countImages(parts);
  const allowed = Math.max(0, Math.min(totalImages, maxImages));
  let seen = 0;
  // Consecutive text runs are newline-joined into ONE item, exactly as the legacy encoding did.
  // Emitting one protobuf item per part adds per-item framing, which was enough to push a
  // previously admissible step past the blob ceiling (round-3 audit: 1020 -> 1025 bytes at a
  // 1024 limit). A result with no images must serialize identically to before this feature.
  const items: ReturnType<typeof create<typeof McpToolResultContentItemSchema>>[] = [];
  let pendingText: string[] = [];
  const flushText = () => {
    if (pendingText.length === 0) return;
    const text = pendingText.join("\n");
    pendingText = [];
    items.push(create(McpToolResultContentItemSchema, {
      content: { case: "text" as const, value: create(McpTextContentSchema, { text }) },
    }));
  };
  for (const part of parts) {
    if (part.kind === "text") {
      pendingText.push(part.text);
      continue;
    }
    if (part.kind === "undecodable") {
      pendingText.push(imagePlaceholder("no inline data"));
      continue;
    }
    seen++;
    if (seen <= totalImages - allowed) {
      pendingText.push(imagePlaceholder(`${part.bytes.byteLength}B over step limit`));
      continue;
    }
    flushText();
    items.push(create(McpToolResultContentItemSchema, {
      content: { case: "image" as const, value: create(McpImageContentSchema, {
        data: part.bytes,
        mimeType: part.mimeType,
      }) },
    }));
  }
  flushText();
  if (items.length === 0) {
    items.push(create(McpToolResultContentItemSchema, {
      content: { case: "text" as const, value: create(McpTextContentSchema, { text: "" }) },
    }));
  }
  return items;
}

/**
 * Serialize tool-call arguments for the replayed transcript, or `undefined` when they cannot be
 * serialized at all. `OcxToolCall.arguments` is always an object, but it originates in provider
 * JSON, so a cyclic or BigInt-bearing value must degrade instead of throwing inside request
 * encoding. The failure is reported as `undefined` rather than a marker string so callers can tell
 * "these two argument sets are equal" apart from "neither could be read" — collapsing both onto one
 * marker made every unserializable argument set compare equal to every other.
 */
function serializeToolCallArguments(args: Record<string, unknown>): string | undefined {
  try {
    const serialized = JSON.stringify(args);
    return typeof serialized === "string" ? serialized : undefined;
  } catch {
    return undefined;
  }
}

/** Truncate to a byte budget without splitting a UTF-8 sequence. */
function truncateUtf8(text: string, maxBytes: number): string {
  const encoded = encoder.encode(text);
  if (encoded.byteLength <= maxBytes) return text;
  let end = Math.max(0, maxBytes);
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end -= 1;
  return decoder.decode(encoded.subarray(0, end));
}

/**
 * Rendered argument text for one invocation line, bounded independently of the result it describes.
 *
 * The invocation is CONTEXT for a replayed result; the result itself is the payload. Serializing
 * arguments in full inverted that: a legitimate 600 KiB `write_file` argument consumed the entire
 * `CURSOR_EXTERNAL_ROOT_BYTE_LIMIT` history budget, so `truncateToolResultBlob` kept the invocation
 * prefix and cut the actual output away — reproducing the very orphaned-result failure this line
 * exists to prevent. A bounded prefix still identifies the call (tool name plus the head of its
 * arguments) while leaving the output room to survive.
 */
function toolCallArgumentsText(args: Record<string, unknown>): string {
  const serialized = serializeToolCallArguments(args);
  if (serialized === undefined) return "[unserializable arguments]";
  if (encoder.encode(serialized).byteLength <= CURSOR_INVOCATION_ARGUMENTS_BYTE_LIMIT) return serialized;
  // The budget is the size of the RENDERED line, so the marker has to come out of it rather than be
  // added on top: otherwise every truncated invocation exceeds the declared limit by the marker.
  const marker = "…[arguments truncated]";
  const markerBytes = encoder.encode(marker).byteLength;
  const keep = Math.max(0, CURSOR_INVOCATION_ARGUMENTS_BYTE_LIMIT - markerBytes);
  return `${truncateUtf8(serialized, keep)}${marker}`;
}

/**
 * The invocation that produced a replayed tool result, rendered as ONE descriptive line inside the
 * result envelope.
 *
 * Why not a separate "[Tool Call]" entry: a model few-shot-mimics that marker and starts emitting
 * later tool calls as inert text instead of real tool frames, which halts multi-tool continuations
 * (363-B guard, tests/cursor-tool-continuation.test.ts). Why it must exist at all: without any
 * record of the invocation, the replayed result is orphaned — its `call_id` refers to nothing the
 * model can see — and live cursor/grok-4.6 turns re-ran commands that had already succeeded while
 * narrating a phantom interrupt (devlog 260829 000_rca). A prose line inside the result satisfies
 * both: the invocation is visible, but there is no call-shaped template to copy.
 */
function toolInvocationLine(call: Extract<OcxAssistantContentPart, { type: "toolCall" }>): string {
  return `invoked: ${namespacedToolName(call.namespace, call.name)} with ${toolCallArgumentsText(call.arguments)}`;
}

/**
 * History position of each indexed call, keyed by the map `toolCallsByCallId` returned.
 *
 * A side table rather than a wider return type: the map is threaded through two builders and the
 * checkpoint site, and changing its shape would touch every one of them for data only the bound reads.
 */
const callPositions = new WeakMap<
  Map<string, Extract<OcxAssistantContentPart, { type: "toolCall" }>>,
  Map<string, number>
>();

/**
 * The indexed call for `callId`, but only when it appears BEFORE `resultIndex` in history.
 *
 * `toolCallsByCallId` has no ordering constraint, so it would happily name a call that runs LATER than
 * the result being labelled — a result whose own output is `EARLY-OUT` was measured on the shipped tree
 * as `invoked: exec_command with {"cmd":"echo LATER"}`. That is the mislabel the index's own comment
 * calls worse than no label, because nothing downstream can detect it (devlog 260829 060).
 *
 * `resultIndex` MUST be in full-history space. The checkpoint path replays a suffix and the turn
 * builder starts at `historyMessageStart`, so a caller composes `knownCallsOffset + start + local`
 * before calling; comparing a full-history call index against a slice-local result index silently
 * drops legitimate pairings and re-creates the orphan #2910 fixed.
 */
function callBefore(
  calls: Map<string, Extract<OcxAssistantContentPart, { type: "toolCall" }>> | undefined,
  callId: string,
  resultIndex: number,
): Extract<OcxAssistantContentPart, { type: "toolCall" }> | undefined {
  const call = calls?.get(callId);
  if (!call || !calls) return undefined;
  const position = callPositions.get(calls)?.get(callId);
  if (position === undefined || position >= resultIndex) return undefined;
  return call;
}

/**
 * Index assistant tool calls by decoded call id so a replayed result can name its invocation.
 *
 * A call id is supposed to be unique, but nothing upstream guarantees it across a long history, and
 * `decodeCursorCallId` can map distinct wire ids onto the same decoded id. Two calls sharing one id
 * would make the LAST one describe every result bearing it, so an early result could be labelled
 * with a later command — a wrong invocation is worse than none, since it is the kind of mislabel the
 * model cannot detect. Keep the FIRST call for an id (results follow their call, so the first
 * binding is the one an earlier result belongs to) and drop the ambiguous id entirely once a second
 * distinct call claims it, which degrades to the honest no-invocation-line path.
 */
function toolCallsByCallId(messages: readonly OcxMessage[]): Map<string, Extract<OcxAssistantContentPart, { type: "toolCall" }>> {
  const calls = new Map<string, Extract<OcxAssistantContentPart, { type: "toolCall" }>>();
  const ambiguous = new Set<string>();
  const positions = new Map<string, number>();
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (!message || message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type !== "toolCall") continue;
      const callId = decodeCursorCallId(part.id);
      if (ambiguous.has(callId)) continue;
      const existing = calls.get(callId);
      if (!existing) {
        calls.set(callId, part);
        positions.set(callId, index);
        continue;
      }
      // Same id, and not the same invocation: neither claim can be trusted for a given result.
      // Identity is the FULL namespaced name — `one__read` and `two__read` are different tools, and
      // comparing bare `name` labelled both results with the first namespace. Arguments count as
      // different whenever either side cannot be serialized: two distinct unserializable argument
      // sets are not evidence of the same call, so they must not compare equal.
      const existingArgs = serializeToolCallArguments(existing.arguments);
      const partArgs = serializeToolCallArguments(part.arguments);
      const sameInvocation = namespacedToolName(existing.namespace, existing.name) === namespacedToolName(part.namespace, part.name)
        && existingArgs !== undefined
        && partArgs !== undefined
        && existingArgs === partArgs;
      if (!sameInvocation) {
        calls.delete(callId);
        positions.delete(callId);
        ambiguous.add(callId);
      }
    }
  }
  callPositions.set(calls, positions);
  return calls;
}

/**
 * The replayed text of one tool result. When `call` is supplied, the invocation that produced it is
 * named inline so the result is not orphaned; when it is absent (no match, or an ambiguous call id)
 * the envelope is emitted unchanged rather than guessing.
 */
function toolResultToText(
  message: OcxToolResultMessage,
  call?: Extract<OcxAssistantContentPart, { type: "toolCall" }>,
): string {
  const normalized = normalizedToolResult(message, contentToText(message.content));
  return [
    "[tool_result]",
    `call_id: ${decodeCursorCallId(message.toolCallId)}`,
    `name: ${namespacedToolName(message.toolNamespace, message.toolName)}`,
    ...(call ? [toolInvocationLine(call)] : []),
    `is_error: ${normalized.isError}`,
    "output:",
    normalized.text,
  ].join("\n");
}

/**
 * Shared #1920 normalization entry: pure-text results only. Image-bearing or
 * encrypted results pass through untouched (their content is not plain text).
 */
function normalizedToolResult(message: OcxToolResultMessage, text: string): NormalizedToolResult {
  if (message.containsEncryptedContent) return { text, isError: message.isError };
  return normalizeCursorToolResultText(text, {
    toolName: message.toolName,
    toolNamespace: message.toolNamespace,
    isError: message.isError,
  });
}

/**
 * A content-part result is plain text only when every decoded part is text (the empty array is the
 * empty text result). Join it exactly as toolResultContentItems already did, then share the string
 * normalization contract. Any image or undecodable part keeps the existing part-preserving path.
 */
function normalizedDecodedTextResult(
  message: OcxToolResultMessage,
  parts: DecodedResultPart[],
): NormalizedToolResult | undefined {
  if (parts.some(part => part.kind !== "text")) return undefined;
  return normalizedToolResult(message, parts.map(part => part.kind === "text" ? part.text : "").join("\n"));
}

function argBytes(value: unknown): Uint8Array {
  try {
    return toBinary(ValueSchema, fromJson(ValueSchema, value as JsonValue));
  } catch {
    return encoder.encode(JSON.stringify(value));
  }
}

function toolCallStep(
  part: Extract<OcxAssistantContentPart, { type: "toolCall" }>,
  requestScope: CursorBlobRequestScopeToken,
  result?: OcxToolResultMessage,
): Uint8Array {
  const args: Record<string, Uint8Array> = {};
  for (const [key, value] of Object.entries(part.arguments ?? {})) args[key] = argBytes(value);
  // Replay the same provider-isolated identity advertised in this request. Returned calls are
  // restored to the client name, so transcript parts carry the client name again on the next turn.
  const toolName = cursorToolWireName(part);
  const decodedResult = result ? decodeResultParts(result) : undefined;
  const serialize = (maxImages: number): Uint8Array => toBinary(ConversationStepSchema, create(ConversationStepSchema, {
    message: {
      case: "toolCall",
      value: create(ToolCallSchema, {
        tool: {
          case: "mcpToolCall",
          value: create(McpToolCallSchema, {
            args: create(McpArgsSchema, {
              name: toolName,
              toolName,
              toolCallId: decodeCursorCallId(part.id),
              providerIdentifier: OCX_RESPONSES_TOOL_PROVIDER,
              args,
            }),
            ...(result ? { result: toolResultPart(result, decodedResult, maxImages) } : {}),
          }),
        },
      }),
    },
  }));

  // A step is stored as ONE blob, so its images share an entry with the call's arguments, text,
  // mime strings, and protobuf framing. A byte budget over decoded images alone cannot bound that
  // (an audit reproduced a 448-byte-argument call whose 460-byte image pushed a previously
  // admitted step past the ceiling). Measure the real serialized size instead, then drop images —
  // oldest first, so the most recent screenshot survives — until the step fits.
  const limit = cursorBlobMaxEntryBytes();
  const imageCount = countImages(decodedResult);
  let encoded = serialize(imageCount);
  for (let allowed = imageCount - 1; allowed >= 0 && encoded.byteLength > limit; allowed--) {
    encoded = serialize(allowed);
  }
  return storeCursorBlob(encoded, requestScope);
}

function toolResultPart(message: OcxToolResultMessage, decoded?: DecodedResultPart[], maxImages?: number) {
  const parts = decoded ?? decodeResultParts(message);
  const normalized = parts
    ? normalizedDecodedTextResult(message, parts)
    : normalizedToolResult(message, typeof message.content === "string" ? message.content : "");
  return create(McpToolResultSchema, {
    result: {
      case: "success",
      value: create(McpSuccessSchema, {
        isError: normalized?.isError ?? message.isError,
        content: toolResultContentItems(message, parts, maxImages, normalized),
      }),
    },
  });
}

function assistantStep(part: OcxAssistantContentPart, requestScope: CursorBlobRequestScopeToken): Uint8Array | undefined {
  if (part.type === "toolCall") return toolCallStep(part, requestScope);
  if (part.type === "thinking") {
    return storeCursorBlob(toBinary(ConversationStepSchema, create(ConversationStepSchema, {
      message: {
        case: "thinkingMessage",
        value: create(ThinkingMessageSchema, { text: part.thinking }),
      },
    })), requestScope);
  }
  if (part.text.length === 0) return undefined;
  return storeCursorBlob(toBinary(ConversationStepSchema, create(ConversationStepSchema, {
    message: {
      case: "assistantMessage",
      value: create(AssistantMessageSchema, { text: part.text }),
    },
  })), requestScope);
}

function lastActionIndex(messages: readonly OcxMessage[] | undefined): number {
  if (!messages) return -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const role = messages[i]?.role;
    if (role === "user" || role === "developer") return i;
    if (role === "toolResult") continue;
  }
  return -1;
}

function conversationTurns(
  request: CursorRunRequest,
  requestScope: CursorBlobRequestScopeToken,
  historyMessageStart = 0,
  /** Calls indexed from the FULL history; see {@link rootPromptMessages}. */
  knownCalls?: Map<string, Extract<OcxAssistantContentPart, { type: "toolCall" }>>,
  /** Full-history index of `rawMessages[0]`; see {@link rootPromptMessages}. */
  knownCallsOffset = 0,
): Uint8Array[] {
  const messages = request.rawMessages;
  if (!messages?.length) return [];
  const end = lastActionIndex(messages);
  const externalModel = isCursorExternalWireModel(request.modelId);
  const historyEnd = messages.at(-1)?.role === "toolResult" ? messages.length : Math.max(0, end);
  const start = externalModel ? Math.max(0, historyMessageStart) : 0;
  const turnCalls = externalModel ? (knownCalls ?? toolCallsByCallId(messages)) : undefined;
  const turns: Uint8Array[] = [];
  let current: { userMessage: Uint8Array; steps: Uint8Array[] } | undefined;
  const pendingToolCalls = new Map<string, Extract<OcxAssistantContentPart, { type: "toolCall" }>>();
  const flush = () => {
    if (!current) return;
    for (const part of pendingToolCalls.values()) current.steps.push(toolCallStep(part, requestScope));
    turns.push(storeCursorBlob(toBinary(ConversationTurnStructureSchema, create(ConversationTurnStructureSchema, {
      turn: {
        case: "agentConversationTurn",
        value: create(AgentConversationTurnStructureSchema, current),
      },
    })), requestScope));
    current = undefined;
    pendingToolCalls.clear();
  };

  const walked = messages.slice(start, historyEnd);
  for (let w = 0; w < walked.length; w++) {
    const message = walked[w];
    // `for…of` gave this for free; keep it explicit so the indexed loop behaves identically.
    if (!message) continue;
    // Full-history position of this message: the slice offset the caller passed, plus where this
    // loop starts inside `rawMessages`, plus the local step. All three terms are needed — dropping
    // `start` still passes every test except the checkpoint-plus-pruned-root case (devlog 060).
    const fullIndex = knownCallsOffset + start + w;
    if (message.role === "assistant") {
      if (!current) continue;
      for (const part of message.content) {
        if (externalModel) {
          // Working external-model clients replay only assistant text. Native mcpToolCall and
          // ThinkingMessage structures are Composer state and cause external workers to hydrate
          // the blobs, reach stepCompleted, then reject the turn with invalid_argument.
          if (part.type === "text" && part.text.length > 0) {
            current.steps.push(storeCursorBlob(toBinary(ConversationStepSchema, create(ConversationStepSchema, {
              message: {
                case: "assistantMessage",
                value: create(AssistantMessageSchema, { text: part.text }),
              },
            })), requestScope));
          }
          continue;
        }
        if (part.type === "toolCall") {
          pendingToolCalls.set(part.id, part);
          continue;
        }
        const step = assistantStep(part, requestScope);
        if (step) current.steps.push(step);
      }
      continue;
    }
    if (message.role === "toolResult") {
      if (!current) continue;
      if (externalModel) {
        // #1920/#1866: this external-replay site bypasses toolResultToText, so it
        // must consume the normalizer directly — cursor/grok-4.6 is the exact
        // reported repro path for empty Computer Use results.
        const normalized = normalizedToolResult(message, contentToText(message.content));
        const prefix = normalized.isError ? "[Tool Error]" : "[Tool Result]";
        // Name the invocation here as well, for the same reason the root replay does: a result with
        // no visible originating call reads as an interrupted attempt (devlog 260829 000_rca).
        const call = callBefore(turnCalls, decodeCursorCallId(message.toolCallId), fullIndex);
        const invocation = call ? `${toolInvocationLine(call)}\n` : "";
        current.steps.push(storeCursorBlob(toBinary(ConversationStepSchema, create(ConversationStepSchema, {
          message: {
            case: "assistantMessage",
            value: create(AssistantMessageSchema, { text: `${prefix}\n${invocation}${normalized.text}` }),
          },
        })), requestScope));
        continue;
      }
      const priorCall = pendingToolCalls.get(message.toolCallId);
      if (priorCall) {
        current.steps.push(toolCallStep(priorCall, requestScope, message));
        pendingToolCalls.delete(message.toolCallId);
      } else {
        current.steps.push(storeCursorBlob(toBinary(ConversationStepSchema, create(ConversationStepSchema, {
          message: {
            case: "assistantMessage",
            value: create(AssistantMessageSchema, { text: toolResultToText(message) }),
          },
        })), requestScope));
      }
      continue;
    }
    flush();
    current = {
      userMessage: storeCursorBlob(toBinary(UserMessageSchema, create(UserMessageSchema, {
        text: historyContentText(message),
        messageId: crypto.randomUUID(),
        selectedContext: buildSelectedContext([], requestScope),
        mode: 1,
      })), requestScope),
      steps: [],
    };
  }
  flush();
  return turns;
}

export function activePromptText(request: CursorRunRequest): string {
  const last = request.messages.at(-1);
  if (last?.role === "user" || last?.role === "developer") return last.content;
  for (let i = (request.rawMessages?.length ?? 0) - 1; i >= 0; i--) {
    const message = request.rawMessages?.[i];
    if (message?.role === "user" || message?.role === "developer") {
      const text = contentText(message);
      if (text.trim().length > 0) return text;
    }
  }
  return last?.role === "tool" ? last.content : "";
}

/**
 * The model-visible text of one finalized tool definition. The schema travels as
 * packed protobuf bytes, so it is decoded back to JSON to be counted the way the
 * model reads it.
 */
function modelVisibleToolText(definition: McpToolDefinition): string {
  let inputSchema: unknown;
  try {
    inputSchema = toJson(ValueSchema, fromBinary(ValueSchema, definition.inputSchema));
  } catch {
    inputSchema = undefined;
  }
  return JSON.stringify({
    name: definition.toolName || definition.name,
    description: definition.description,
    ...(inputSchema !== undefined ? { inputSchema } : {}),
  });
}

export interface PreparedCursorRunRequest {
  bytes: Uint8Array;
  blobRequestScope: CursorBlobRequestScopeToken;
  /** Only present when the caller asked for it; see prepareCursorRunRequest(). */
  estimatedInputTokens?: number;
}

/**
 * Build the wire payload once, and optionally derive a token estimate from the very
 * same roots, action text, and tool definitions that produced it.
 *
 * Cursor only reports absolute context size in checkpoint frames, which live in a
 * process-local map — so after a restart a turn with no checkpoint reports
 * inputTokens=0 and Codex sees an almost-empty context (#373). The estimate fills
 * that gap. Deriving it here, rather than from the original request, is what keeps
 * it honest: history the pruner dropped and tools the filter removed are already
 * gone by this point.
 */
function buildPreparedCursorRunRequest(
  request: CursorRunRequest,
  requestScope: CursorBlobRequestScopeToken,
  options?: { estimateInputTokens?: boolean },
): PreparedCursorRunRequest {
  const rawText = activePromptText(request);
  const lastRole = request.messages.at(-1)?.role;
  const text = lastRole === "user" || lastRole === "developer"
    ? appendCursorGenericToolUseHint(request.tools, rawText)
    : rawText;
  const lastRawIsToolResult = request.rawMessages?.at(-1)?.role === "toolResult";
  const selectedImages = request.selectedImages ?? [];
  // Native models resume the remembered Cursor conversation. External wire
  // models continue as userMessageAction so history-blob tool results stay
  // visible without a ResumeAction. Some native composer ids are also routed
  // through the external continuation path (cursorNeedsExternalToolContinuation)
  // because a bare resumeAction makes them continue exploring with native tools
  // instead of answering (observed on composer-2.5; see discovery.ts).
  const externalToolContinuation = lastRawIsToolResult && cursorNeedsExternalToolContinuation(request.modelId);
  // Image-only active turns (including soft-omitted images) stay userMessageAction.
  const actionCase = (
    externalToolContinuation
    || (!lastRawIsToolResult && (text.trim().length > 0 || selectedImages.length > 0))
  )
    ? "userMessageAction"
    : "resumeAction";
  const actionText = externalToolContinuation
    ? (request.echoRetryContinuationText ?? CURSOR_EXTERNAL_TOOL_CONTINUATION_TEXT)
    : request.echoRetryContinuationText
      ? `${text}\n\n[correction] ${request.echoRetryContinuationText}`
      : text;
  const action = create(ConversationActionSchema, {
    action: actionCase === "userMessageAction"
      ? {
          case: "userMessageAction",
          value: create(UserMessageActionSchema, {
            userMessage: create(UserMessageSchema, {
              text: actionText,
              messageId: crypto.randomUUID(),
              selectedContext: buildSelectedContext(selectedImages, requestScope),
              // OmniRoute / cursor-agent always send mode=1 on UserMessage.
              mode: 1,
            }),
            requestContext: buildRequestContext(),
          }),
        }
      : {
          case: "resumeAction",
          value: create(ResumeActionSchema, {
            requestContext: buildRequestContext(),
          }),
        },
  });
  let continuationMode: "full-replay" | "checkpoint" = "full-replay";
  let checkpointInvalidationReason = request.checkpointInvalidationReason;
  let conversationState: ConversationStateStructure | undefined;
  let rootPromptMessagesState: ReturnType<typeof rootPromptMessages> | undefined;
  if (request.checkpointBytes && request.checkpointBytes.byteLength > 0) {
    try {
      conversationState = fromBinary(ConversationStateStructureSchema, request.checkpointBytes);
      continuationMode = "checkpoint";
      const suffixStart = request.checkpointSuffixStart;
      if (
        typeof suffixStart === "number"
        && Number.isSafeInteger(suffixStart)
        && suffixStart >= 0
        && request.rawMessages
        && suffixStart < request.rawMessages.length
      ) {
        const suffixRequest: CursorRunRequest = {
          ...request,
          system: [],
          rawMessages: request.rawMessages.slice(suffixStart),
        };
        // Index calls from the FULL history, not the suffix: the cut can fall between a call and
        // its result, and a result replayed without its invocation is the orphaned-result defect.
        const fullHistoryCalls = toolCallsByCallId(request.rawMessages);
        // What the checkpoint already spends against the envelope. An id the local store never held
        // still occupies a root slot, so it counts toward the COUNT budget with a zero byte
        // contribution rather than being skipped entirely.
        let carriedBytes = 0;
        for (const blobId of conversationState.rootPromptMessagesJson) {
          carriedBytes += cursorBlobByteLength(blobId) ?? 0;
        }
        const carriedRoots = {
          count: conversationState.rootPromptMessagesJson.length,
          byteLength: carriedBytes,
        };
        // A checkpoint can be so large that nothing useful is left for the suffix. Pruning to fit then
        // emits the covered prefix and silently drops the uncovered messages — the exact failure this unit
        // exists to remove — while throwing would hand the caller a non-retryable 400. Abandon the
        // checkpoint instead: full replay rebuilds a self-contained prompt and prunes it coherently
        // (devlog 260829 070, audit r8).
        //
        // The decision is made on the RESULT of pruning, not on a byte threshold. A threshold has to
        // predict what pruning will do, and the first attempt mispredicted it: comparing carried bytes
        // against the raw limit left a band of a few hundred bytes below it where the checkpoint was kept,
        // the suffix budget collapsed, and the newest tool result vanished. Adding `systemBytes` moved the
        // band without closing it. Asking pruning what survived cannot drift from what pruning does.
        const suffixRoots = rootPromptMessages(suffixRequest, requestScope, fullHistoryCalls, suffixStart, carriedRoots);
        const suffixSystemCount = systemPromptBlobs(suffixRequest).length;
        // A tool continuation whose own result did not survive is worthless: that result is the whole
        // reason the turn exists. "Kept SOMETHING" is not enough either — inside the band this fix first
        // missed, pruning kept the assistant narration and dropped the result, which is worse than keeping
        // nothing because the model then sees a call it never got an answer to. The test is therefore on
        // the LAST replayed message specifically, identified by its index rather than its content.
        const suffixMessages = suffixRequest.rawMessages ?? [];
        const lastSuffixIndex = suffixMessages.length - 1;
        // Only models whose results are replayed as root text can answer this question. A native resume
        // model gets its result through server-side turn state, so `rootPromptMessages` never emits a
        // toolResult root for it (`echoToolResultInRoot` is false) — asking whether that root survived
        // returns "no" every single time, and an unguarded check therefore threw away the checkpoint of
        // every native continuation, including the default `cursor/auto`. The checkpoint is the only place
        // pendingToolCalls, readPaths and previousWorkspaceUris live, and full replay does not rebuild
        // them, so that was this unit's own defect relocated to the native path (audit r8 round 3).
        const resultReplayedAsRoot = cursorNeedsExternalToolContinuation(request.modelId);
        // Kept, and kept with its output: a root reduced to the truncation marker alone answers the call
        // with nothing, which is the same failure as dropping it. `outputElided` is set at the one place
        // that can produce it, so this needs no threshold to guess at.
        //
        // Every trailing result is checked, not just the last one. Parallel tool calls land as a run of
        // results, and under byte pressure the older ones were the ones getting emptied: measured a prompt
        // carrying three calls and one answer, which is the shape this comment calls worse than keeping
        // nothing. `historyOutputElided` already knew; only the last index was being read (audit r8
        // round 3).
        // The run is read from PRUNING's own report, not re-derived from `suffixMessages`. The two spaces
        // disagree: root space skips an assistant message that emitted no root — a bare tool call with no
        // narration, or whitespace-only text — so two sequentially-executed results sit adjacent as roots
        // while a raw-message scan still sees a trailing run of one. Pruning's count bound acts on the root
        // run, so a raw-space scan could not see the result it dropped: measured at 190 carried roots with
        // bare-call pairs, the older answer vanished from the wire entirely while this check reported
        // "kept" and the checkpoint was retained — an unanswered call, which the comment above rightly
        // calls worse than keeping nothing (audit r10).
        //
        // `activeMessageIndexes` is that run as pruning saw it, recorded before pruning could shrink it.
        // Falling back to the raw-space scan when it is empty keeps the full-replay and native shapes,
        // which never populate it, behaving exactly as before.
        let trailingStart = suffixMessages.length;
        while (trailingStart > 0 && suffixMessages[trailingStart - 1]?.role === "toolResult") trailingStart -= 1;
        const trailingIndexes = suffixRoots.activeMessageIndexes.length > 0
          ? suffixRoots.activeMessageIndexes
          : suffixMessages.slice(trailingStart).map((_, offset) => trailingStart + offset);
        const keptEnough = trailingIndexes.every(index =>
          suffixRoots.historyMessageIndexes.includes(index)
          && !suffixRoots.historyOutputElided.includes(index));
        const suffixKeptItsResult = !resultReplayedAsRoot
          || suffixMessages[lastSuffixIndex]?.role !== "toolResult"
          || keptEnough;
        if (
          carriedRoots.count + suffixSystemCount >= CURSOR_EXTERNAL_ROOT_BLOB_LIMIT
          // Both survival disjuncts are about a REPLAYED root going missing, so both are meaningless for a
          // model whose results never become roots. Gating only the second one still discarded every native
          // checkpoint whose assistant turn was a bare tool call: no text root, no result root, zero history
          // roots, condition true (audit r8 round 4). The count-full disjunct above stays ungated — it is a
          // real envelope fact, independent of who echoes results.
          || (resultReplayedAsRoot && suffixRoots.ids.length <= suffixSystemCount)
          || !suffixKeptItsResult
        ) {
          conversationState = undefined;
          continuationMode = "full-replay";
          checkpointInvalidationReason = "envelope_exhausted";
          // NOT propagated to the checkpoint store, and deliberately so after measuring the attempt.
          // `src/adapters/cursor.ts` drops a dead checkpoint by reading
          // `request.checkpointInvalidationReason`, but `live-transport.ts` prepares a SPREAD COPY of that
          // request, so writing the field here lands on the copy and the caller never sees it — measured
          // inert, `outer.checkpointInvalidationReason` stayed undefined. Reaching the store needs the
          // reason threaded back through `PreparedCursorRunRequest`, which is a signature change on the
          // shared prepare path and belongs to its own phase. The cost of not doing it is bounded: the
          // checkpoint is re-decoded and re-abandoned each turn until TTL, which is wasted work rather
          // than wrong output (audit r8 rounds 3 and 4).
        } else {
        const suffixTurns = conversationTurns(suffixRequest, requestScope, suffixRoots.historyMessageStart, fullHistoryCalls, suffixStart);
        const suffixHistoryIds = suffixRoots.ids.slice(suffixSystemCount);
        const suffixHistorySerialized = suffixRoots.serialized.slice(suffixSystemCount);
        conversationState = create(ConversationStateStructureSchema, {
          ...conversationState,
          rootPromptMessagesJson: [
            ...conversationState.rootPromptMessagesJson,
            ...suffixHistoryIds,
          ],
          turns: [
            ...conversationState.turns,
            ...suffixTurns,
          ],
        });
        rootPromptMessagesState = {
          ids: suffixHistoryIds,
          byteLength: suffixRoots.byteLength,
          historyMessageStart: suffixRoots.historyMessageStart,
          serialized: suffixHistorySerialized,
          historyMessageIndexes: suffixRoots.historyMessageIndexes,
          historyOutputElided: suffixRoots.historyOutputElided,
          activeMessageIndexes: suffixRoots.activeMessageIndexes,
        };
        }
      }
    } catch {
      checkpointInvalidationReason = "decode_failed";
    }
  }
  if (!conversationState) {
    rootPromptMessagesState = rootPromptMessages(request, requestScope);
    conversationState = create(ConversationStateStructureSchema, {
      rootPromptMessagesJson: rootPromptMessagesState.ids,
      turns: conversationTurns(request, requestScope, rootPromptMessagesState.historyMessageStart),
      todos: [],
      pendingToolCalls: [],
      previousWorkspaceUris: [],
      fileStates: {},
      fileStatesV2: {},
      summaryArchives: [],
      turnTimings: [],
      subagentStates: {},
      readPaths: [],
    });
  }
  // Hoisted out of the mcp_tools spread below so the estimate can read the same
  // filtered definitions the wire carries. Both helpers are pure.
  const visibleTools = cursorToolsForActivePrompt(request.tools, rawText, request.toolChoice);
  const mcpToolDefs = buildCursorToolDefinitions(visibleTools, request.toolChoice);
  // The envelope is measured HERE, on the final root set, and nowhere else.
  //
  // `rootPromptMessages` cannot do it: it sees only a checkpoint suffix, so 192 checkpoint roots
  // plus a two-root suffix passed its per-call check and emitted 194 roots; and its empty-history
  // early return skips the pruning branch entirely, which let 193 system prompts through. Both are
  // downstream of this point, which is the first place the wire content is fully known (#1527).
  //
  // The same measurement feeds the diagnostic below, so telemetry cannot disagree with the guard.
  //
  // Roots carried inside a decoded checkpoint need not be in the local store — Cursor minted some
  // of them, and a resumed conversation legitimately references ids this process never wrote. So an
  // unmeasurable root is counted, not fatal: the COUNT limit still binds it (that is the 194-root
  // case), and `unmeasuredRoots` records that the byte total is a floor rather than a total. An
  // earlier fail-closed version broke three passing checkpoint tests, which is the evidence that
  // failing closed here would reject working continuation.
  const measuredRootCount = conversationState.rootPromptMessagesJson.length;
  let measuredRootBytes = 0;
  let unmeasuredRoots = 0;
  for (const blobId of conversationState.rootPromptMessagesJson) {
    const size = cursorBlobByteLength(blobId);
    if (size === null) unmeasuredRoots += 1;
    else measuredRootBytes += size;
  }
  if (
    isCursorExternalWireModel(request.modelId)
    && (measuredRootCount > CURSOR_EXTERNAL_ROOT_BLOB_LIMIT || measuredRootBytes > CURSOR_EXTERNAL_ROOT_BYTE_LIMIT)
  ) {
    throw new CursorRootEnvelopeLimitError(
      measuredRootCount,
      measuredRootBytes,
      CURSOR_EXTERNAL_ROOT_BLOB_LIMIT,
      CURSOR_EXTERNAL_ROOT_BYTE_LIMIT,
    );
  }
  debugProviderDiagnostic("cursor", "run-request", {
    wireModel: request.modelId,
    action: actionCase,
    conversationId: request.conversationId,
    turnType: lastRawIsToolResult ? "tool-continuation" : "initial",
    externalModel: isCursorExternalWireModel(request.modelId),
    rawMessages: request.rawMessages?.length ?? 0,
    continuationMode,
    checkpointPresent: continuationMode === "checkpoint",
    checkpointBytes: continuationMode === "checkpoint" ? request.checkpointBytes?.byteLength : undefined,
    checkpointInvalidationReason,
    rootBlobs: measuredRootCount,
    // Was `rootPromptMessagesState?.byteLength ?? 0`, which reported 0 for a pure checkpoint and,
    // for a suffix, counted a synthetic system root that had already been sliced off.
    rootBytes: measuredRootBytes,
    // Non-zero means rootBytes is a floor: that many roots came from a checkpoint the local store
    // never held. Recorded rather than hidden, so an operator reading the number knows which it is.
    ...(unmeasuredRoots > 0 ? { unmeasuredRoots } : {}),
    turnBlobs: conversationState.turns.length,
    tools: request.tools?.length ?? 0,
  });

  const requestedModelParameters = [
    ...(request.requestedModelParameters ?? []),
    ...(request.routingLevel ? [{ id: CURSOR_ROUTING_LEVEL_PARAMETER_ID, value: request.routingLevel }] : []),
  ];
  const hasExplicitModelParameters = (request.requestedModelParameters?.length ?? 0) > 0;
  const runRequest = create(AgentRunRequestSchema, {
    conversationId: request.conversationId,
    conversationState,
    action,
    // Explicit model-picker parameters follow current Cursor clients and use requested_model alone.
    // Keep legacy model_details for flat model ids and the already-live Router path; sending both for
    // a parameterized external model can resolve conflicting selections and end in invalid_argument.
    ...(!hasExplicitModelParameters ? {
      modelDetails: create(ModelDetailsSchema, {
        modelId: request.modelId,
        displayModelId: request.modelId,
        displayName: request.modelId,
        displayNameShort: request.modelId,
        aliases: [],
        ...(request.maxMode === true ? { maxMode: true } : {}),
      }),
    } : {}),
    ...(requestedModelParameters.length > 0 || request.maxMode === true ? {
      requestedModel: create(RequestedModelSchema, {
        modelId: request.modelId,
        // Max Mode must be raised on BOTH RequestedModel and ModelDetails; missing either
        // can invalid_argument upstream (devlog 260826 070).
        maxMode: request.maxMode === true,
        parameters: requestedModelParameters.map(parameter =>
          create(RequestedModel_ModelParameterbytesSchema, parameter)),
      }),
    } : {}),
    // Mirror the client (Responses) tool definitions into the top-level AgentRunRequest.mcp_tools
    // channel. Advertising them ONLY via native-exec `requestContextArgs` (RequestContext.tools) is
    // insufficient: cursor models report those tools as unavailable and fall back to native tools.
    // Populating mcp_tools registers them into the model's callable catalog (verified live: the
    // model actually calls the injected tool on gpt-5.6-luna and claude-4.5-sonnet). Phase 42 tried
    // this but assigned the field with the wrong shape and crashed Cursor's binary parser ("illegal
    // tag"); the correct `McpTools` wrapper is wire-compatible (verified — no parse crash on either
    // model family). See devlog/260711_cursor_browser_bridge/004.
    //
    // Use the SAME `cursorToolsForActivePrompt`-filtered visible set that RequestContext.tools and
    // the event-state `clientToolNames` use (live-transport.ts). Advertising the raw `request.tools`
    // here would let mcp_tools expose a tool that the event state does not recognize for a generic
    // tool-count prompt, so a call to it would be rejected as an unknown Responses tool.
    // An explicitly empty McpTools wrapper (bare API callers) suppresses Cursor's default
    // native catalog; an absent field lets identified Codex sessions keep it (devlog 260826 040).
    ...(mcpToolDefs.length > 0 || request.suppressDefaultCursorToolCatalog === true
      ? { mcpTools: create(McpToolsSchema, { mcpTools: mcpToolDefs }) }
      : {}),
  });

  const message = create(AgentClientMessageSchema, {
    message: { case: "runRequest", value: runRequest },
  });
  const bytes = toBinary(AgentClientMessageSchema, message);
  if (!options?.estimateInputTokens) return { bytes, blobRequestScope: requestScope };

  // Same instances that produced `bytes`, so the estimate cannot count history or
  // tools the payload dropped — the defect that blocked PR #376.
  const modelVisibleParts = [
    ...(rootPromptMessagesState?.serialized ?? []),
    ...(actionCase === "userMessageAction" ? [actionText] : []),
    ...mcpToolDefs.map(modelVisibleToolText),
  ];
  return {
    bytes,
    blobRequestScope: requestScope,
    estimatedInputTokens: estimateTokens(modelVisibleParts.join("\n"), request.modelId),
  };
}

export function prepareCursorRunRequest(
  request: CursorRunRequest,
  options?: { estimateInputTokens?: boolean },
): PreparedCursorRunRequest {
  const requestScope = createCursorBlobRequestScope();
  try {
    const prepared = buildPreparedCursorRunRequest(request, requestScope, options);
    sealCursorBlobRequestScope(requestScope);
    return prepared;
  } catch (error) {
    releaseCursorBlobRequestScope(requestScope);
    throw error;
  }
}

/** Back-compat wrapper: callers that only need the wire bytes. */
export function encodeCursorRunRequest(request: CursorRunRequest): Uint8Array {
  return prepareCursorRunRequest(request).bytes;
}
