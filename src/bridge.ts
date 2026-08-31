import type {
  AdapterEvent,
  OcxMessagePhase,
  OcxProviderContinuationState,
  OcxProviderOpaqueToolCallMetadata,
  OcxReasoningReplayScopeRef,
  OcxUsage,
} from "./types";
import { coerceIntegerToolArguments } from "./lib/tool-argument-integers";
import {
  adapterFailureFromMessage,
  classifyError,
  cyberPolicyErrorType,
  CYBER_POLICY_ERROR_CODE,
  isCyberPolicyCode,
  type OcxErrorPayload,
} from "./lib/errors";
import { redactSecretString } from "./lib/redact";
import { repairFreeformToolInput } from "./responses/apply-patch-envelope";
import { encodeCompactionSummary } from "./responses/compaction";
import { compileCodeModeHelperInput } from "./responses/code-mode-helper-compat";
import { isTruncatedStopReason, truncationReasonFor } from "./responses/truncated-stop-reason";
import { encodeReasoningEnvelope, type ReasoningEnvelope } from "./responses/reasoning-envelope";
import { rememberReasoningForCall } from "./responses/reasoning-replay-cache";
import {
  rememberAndSerializeExtraContent,
  rememberExtraContentForReplay,
  awaitThoughtSignatureDurability,
} from "./responses/thought-signature-replay";
import { resolveStallTimeoutSec } from "./stall-timeout";
import { normalizeDeclaredToolName } from "./types";
import { usageDisplayTotalTokens } from "./usage/totals";
import { appendSafeWebSearchSource, safeWebSearchSources } from "./web-search/sources";
import {
  isTranslatorBudgetExceededError,
  releaseTranslatedEvent,
  createTranslatorBudget,
  type TranslatorBudget,
  type TranslatorBufferKind,
} from "./lib/translator-budget";

function uuid(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

/** Test-only: bound the abandoned-owned-budget watchdog delay (null restores). */
let ownedBudgetAbandonedMs = 10 * 60 * 1000;
const OWNED_BUDGET_ABANDONED_DEFAULT_MS = ownedBudgetAbandonedMs;
export function setOwnedBudgetAbandonedMsForTests(ms: number | null): void {
  ownedBudgetAbandonedMs = ms ?? OWNED_BUDGET_ABANDONED_DEFAULT_MS;
}

function sseEvent(name: string, data: Record<string, unknown>): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

function responsesUsage(usage: OcxUsage | undefined): Record<string, unknown> {
  // input_tokens_details / output_tokens_details are ALWAYS emitted (zero defaults):
  // strict Responses clients deserialize them as required fields — grok-build's pinned
  // async-openai fork (rev 95b52ebd, response_usage.rs) has non-Option InputTokenDetails/
  // OutputTokenDetails, so omitting them turns a successful turn into a hard exit after
  // response.completed ("missing field `input_tokens_details`", verified live 2026-07-23).
  if (!usage) {
    return {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    };
  }
  // inputTokens is already inclusive of cache read/write (types.ts convention). Stateful
  // providers may report an absolute active-context checkpoint separately from their
  // per-attempt usage. Split that checkpoint into input + output without adding output twice.
  const inputTokens = usage.contextTotalTokens !== undefined
    ? Math.max(0, usage.contextTotalTokens - usage.outputTokens)
    : usage.inputTokens;
  const out: Record<string, unknown> = {
    input_tokens: inputTokens,
    output_tokens: usage.outputTokens,
    total_tokens: usage.contextTotalTokens !== undefined
      ? usage.contextTotalTokens
      : usageDisplayTotalTokens(usage) ?? inputTokens + usage.outputTokens,
  };
  // cached_tokens carries cache READS only, matching OpenAI semantics, and is always present
  // (zero default) for strict clients. Clamp to inputTokens so a provider's absolute
  // checkpoint can never report more cache reads than input.
  const inputDetails: Record<string, number> = {
    cached_tokens: Math.min(usage.cachedInputTokens ?? 0, inputTokens),
  };
  if (usage.cacheCreationInputTokens !== undefined) {
    const cacheRead = inputDetails.cached_tokens ?? 0;
    inputDetails.cache_write_tokens = Math.min(
      usage.cacheCreationInputTokens,
      Math.max(0, inputTokens - cacheRead),
    );
  }
  out.input_tokens_details = inputDetails;
  out.output_tokens_details = { reasoning_tokens: usage.reasoningOutputTokens ?? 0 };
  return out;
}

function responseError(status: number, type: string, message: string): OcxErrorPayload {
  return classifyError(status, type, message);
}

/**
 * Whether assembled function-call arguments are usable JSON.
 * An empty buffer is valid (no-arg tools send no deltas). Non-empty must parse —
 * once fragments have been streamed to the client they cannot be repaired the way
 * non-stream adapters degrade a bad payload to `{}`.
 */
function toolCallArgumentsUsable(args: string): boolean {
  if (args.length === 0) return true;
  const trimmed = args.trim();
  if (!trimmed) return false;
  try {
    JSON.parse(args);
    return true;
  } catch {
    return false;
  }
}

function adapterFailureFromEvent(event: Extract<AdapterEvent, { type: "error" }>): { httpStatus: number; error: OcxErrorPayload } {
  const message = redactSecretString(event.message);
  if (event.status === undefined && event.errorType === undefined && event.code === undefined) {
    return adapterFailureFromMessage(message);
  }
  const fallback = adapterFailureFromMessage(message);
  let httpStatus = event.status ?? fallback.httpStatus;
  const error = classifyError(httpStatus, event.errorType ?? fallback.error.type, message);
  if (event.errorType !== undefined) error.type = event.errorType;
  if (event.code !== undefined) error.code = event.code;
  // Codex maps cyber_policy on HTTP 400 (body) or mid-stream code; never leave it as 502.
  if (isCyberPolicyCode(error.code) || isCyberPolicyCode(event.code)) {
    error.code = CYBER_POLICY_ERROR_CODE;
    error.type = cyberPolicyErrorType(event.errorType);
    httpStatus = 400;
  }
  return { httpStatus, error };
}

export { adapterFailureFromMessage } from "./lib/errors";

/**
 * Build the native `WebSearchAction::Search` payload from the queries that ran.
 *
 * Every action carries BOTH keys: `{ query, queries }`, where `query` is the first
 * member. Empty → `{ query: "", queries: [""] }`.
 *
 * Carrying both is load-bearing in both directions. DeepSeek's native Responses parser
 * makes `queries` a required field, and Console Go's upstream validator makes `query` a
 * required field — so a replayed `web_search_call` carried in the history of every
 * subsequent turn fails deserialization with `missing field 'queries'` (#930) or 400s
 * with `missing required field 'query'` unless both keys are present. Carrying both keys
 * in every case satisfies both strict parsers; the trade-off is that a multi-query batch
 * loses the "<first> ..." ellipsis in codex-rs and shows the first query as the label.
 *
 * That trade is deliberate: a cosmetic label against a conversation that 400s on every
 * subsequent turn. Do not restore the old batch-omits-`query` shape to win the ellipsis
 * back — it reopens #3071.
 *
 * This fixes items created from here on. History recorded before it is repaired at the
 * replay boundary by `backfillWebSearchQueries()` in the Responses adapter.
 */
function webSearchAction(queries: string[]): Record<string, unknown> {
  const first = queries[0] ?? "";
  return { type: "search", query: first, queries: queries.length > 0 ? queries : [first] };
}

interface OutputItem {
  type: string;
  id: string;
  [key: string]: unknown;
}

export type ResponsesTerminalStatus = "completed" | "failed" | "incomplete";

export function bridgeToResponsesSSE(
  events: AsyncIterable<AdapterEvent>,
  modelId: string,
  toolNsMap?: Map<string, { namespace: string; name: string; freeform?: true }>,
  freeformToolNames?: Set<string>,
  toolSearchToolNames?: Set<string>,
  onCancel?: () => void,
  heartbeatMs = 2_000,
  options?: {
    responseId?: string;
    stallTimeoutSec?: number;
    hideThinkingSummary?: boolean;
    /**
     * Remote compaction v2 turn: accumulate all assistant text and, on done, emit ONE synthetic
     * `{type:"compaction", encrypted_content:"ocx1:"+base64(text)}` output item before
     * response.completed — codex-rs collect_compaction_output requires exactly one.
     */
    compaction?: boolean;
    /** One-shot: first non-empty text/thinking/raw-reasoning delta observed (WP4 TTFT). */
    onFirstOutput?: () => void;
    onTerminal?: (status: ResponsesTerminalStatus) => void;
    onCompletedResponse?: (response: Record<string, unknown>, providerState?: OcxProviderContinuationState) => void;
    /**
     * Raw adapter-reported usage at the terminal event, BEFORE wire normalization.
     * responsesUsage() always emits token-detail objects with zero defaults for strict
     * clients (grok-build), which makes the wire unusable as a provenance source: the
     * request log must not read synthetic zeros as measured cache/reasoning numbers
     * (cache_detail_missing would be silently suppressed). Callers set logCtx.usage
     * from this callback instead of re-parsing the bridged SSE.
     */
    onUsage?: (usage: OcxUsage | undefined) => void;
    /** Request-visible tool names. When present, an upstream call outside this set fails closed. */
    declaredToolNames?: ReadonlySet<string>;
    /** Declared parameter schema per tool name; repairs integral-float integer args (#1611). */
    toolParameterSchemas?: ReadonlyMap<string, Record<string, unknown>>;
    /**
     * Wire keep-alive shape. Codex-rs parses at the EVENT level (timeout(idle_timeout,
     * stream.next()) over an eventsource_stream), so an SSE comment line dispatches no event
     * and does NOT re-arm its idle timer — the keep-alive must be a typed frame the parser
     * ignores via its catch-all (110 RCA, 30_patch-direction.md). grok-build's strict
     * async-openai fork is the opposite: it dies on the unknown `response.heartbeat`
     * variant but, being eventsource-based at the byte level, its idle handling tolerates
     * comment lines. Default stays the typed frame; the grok surface opts into comments.
     */
    heartbeatStyle?: "typed" | "comment";
    translatorBudget?: TranslatorBudget;
    /**
     * Conversation identity for the reasoning replay cache (issue #950).
     * Provider call ids are not globally unique; scoping by thread keeps one
     * conversation's reasoning out of another's continuations.
     */
    replayCacheScope?: OcxReasoningReplayScopeRef;
    /**
     * Test seam for the wire/stall beat loop. Production omits this and uses the
     * global timers; injecting here must not change scheduling semantics.
     */
    timers?: {
      setInterval: (handler: () => void, ms: number) => unknown;
      clearInterval: (id: unknown) => void;
    };
  },
): ReadableStream<Uint8Array> {
  const replayCacheScope = options?.replayCacheScope;
  const setBeatInterval = options?.timers?.setInterval ?? ((handler: () => void, ms: number) => setInterval(handler, ms));
  const clearBeatInterval = options?.timers?.clearInterval ?? ((id: unknown) => clearInterval(id as ReturnType<typeof setInterval>));
  // Freeform/custom tools (apply_patch, code-mode exec) carry their body in `input`; the
  // model is given a function with `{input:string}`, so unwrap it here when relaying back
  // as a custom_tool_call. Decorated apply_patch envelopes are repaired at this boundary.
  const freeformInput = (
    args: string,
    toolName: string,
    namespace?: string,
    codeModeHelperName?: string,
  ): string => codeModeHelperName
    ? compileCodeModeHelperInput(args, codeModeHelperName)
    : repairFreeformToolInput(args, toolName, namespace);
  // Best-effort unwrap of a PARTIAL freeform arg buffer for live input streaming
  // (`response.custom_tool_call_input.delta` — codex-rs uses it for UI preview only;
  // the completed custom_tool_call item stays authoritative). Compact `{"input":"...`
  // buffers get their string value progressively unescaped; anything else streams raw.
  const FREEFORM_WRAP_PREFIX = '{"input":"';
  const freeformPartialInput = (args: string): string => {
    if (!args.startsWith(FREEFORM_WRAP_PREFIX)) return args;
    const body = args.slice(FREEFORM_WRAP_PREFIX.length);
    let out = "";
    for (let i = 0; i < body.length; i++) {
      const c = body[i];
      if (c === '"') break; // unescaped closing quote: value complete
      if (c === "\\") {
        const n = body[i + 1];
        if (n === undefined) break; // escape split across chunks: wait for more
        i++;
        if (n === "n") out += "\n";
        else if (n === "t") out += "\t";
        else if (n === "r") out += "\r";
        else if (n === "u") {
          const hex = body.slice(i + 1, i + 5);
          if (hex.length === 4 && /^[0-9a-fA-F]{4}$/.test(hex)) { out += String.fromCharCode(parseInt(hex, 16)); i += 4; }
          else break; // incomplete \uXXXX: wait for more
        } else out += n; // \" \\ \/ etc.
      } else out += c;
    }
    return out;
  };
  // tool_search_call carries arguments as a JSON object ({query, limit}); parse the model's arg string.
  const parseArgsObj = (args: string): Record<string, unknown> => {
    try { const o = JSON.parse(args); return o && typeof o === "object" ? o : {}; } catch { return {}; }
  };
  const encoder = new TextEncoder();
  // Default-budget safety net: omission is SAFE (default turn limits), never
  // unbounded. Production callers always pass one; an owned default is disposed
  // at terminal/cancel below.
  const ownsBudget = !options?.translatorBudget;
  const budget = options?.translatorBudget ?? createTranslatorBudget();
  // Idempotent: safe to call at every stream-death path; disposal must come
  // AFTER the final charges (emitDone), never inside reportTerminal.
  const disposeOwnedBudget = () => { if (ownsBudget) budget.dispose(); };
  // A dropped stream (never read, never cancelled) reaches no terminal path,
  // so the owned budget would sit in liveBudgets for the process lifetime.
  // One unref'd watchdog per owned budget bounds that to a timeout and clears
  // itself on any settle (the delay is test-overridable).
  const ownedWatchdog = ownsBudget
    ? setTimeout(() => disposeOwnedBudget(), ownedBudgetAbandonedMs)
    : undefined;
  ownedWatchdog?.unref?.();
  const clearOwnedWatchdog = () => {
    if (ownedWatchdog !== undefined) clearTimeout(ownedWatchdog);
  };
  const bytesOf = (value: string): number => Buffer.byteLength(value);
  const appendString = (
    previous: string,
    previousBytes: number,
    fragment: string,
    kind: TranslatorBufferKind,
    callId?: string,
  ): { value: string; bytes: number } => {
    const fragmentBytes = bytesOf(fragment);
    const nextBytes = previousBytes + fragmentBytes;
    const scope = { kind, ...(callId ? { callId } : {}) };
    const reservation = budget.reserveTransient(nextBytes, scope);
    try {
      const value = previous + fragment;
      reservation.commitRetained();
      budget.releaseRetained(previousBytes, scope);
      return { value, bytes: nextBytes };
    } catch (error) {
      reservation.release();
      throw error;
    }
  };
  const replaceRetainedString = (previousBytes: number, next: string, kind: TranslatorBufferKind): number => {
    const nextBytes = bytesOf(next);
    if (!budget) return nextBytes;
    const reservation = budget.reserveTransient(nextBytes, { kind });
    reservation.commitRetained();
    budget.releaseRetained(previousBytes, { kind });
    return nextBytes;
  };
  const chargeValue = (value: unknown, kind: TranslatorBufferKind): number => {
    const bytes = bytesOf(JSON.stringify(value));
    budget?.chargeRetained(bytes, { kind });
    return bytes;
  };
  const responseId = options?.responseId ?? `resp_${uuid()}`;
  let seq = 0;
  // Set once the client is gone (cancel) or an enqueue throws on a torn-down controller, so we
  // never enqueue again and never throw a second time inside start() — the RC2 double-throw that
  // otherwise surfaced as proxy-side stream noise on every client disconnect.
  let closed = false;
  let clientCancelled = false;
  let terminalReported = false;
  const reportTerminal = (status: ResponsesTerminalStatus) => {
    if (terminalReported || clientCancelled || closed) return;
    terminalReported = true;
    try { options?.onTerminal?.(status); } catch { /* terminal metrics must not break the stream */ }
    clearOwnedWatchdog();
  };
  // RC3 keep-alive: Codex's idle timer is timeout(idle_timeout, stream.next()) over an
  // eventsource_stream, which parses at the EVENT level — a comment-only frame dispatches no
  // event, so it does NOT re-arm the timer (110 RCA). The default keep-alive is therefore a
  // typed `response.heartbeat` frame the codex-rs parser ignores via `_ => Ok(None)`. The
  // grok surface (strict async-openai decoder that dies on unknown variants) opts into SSE
  // comment lines instead via options.heartbeatStyle. Emit whenever the *wire* has been
  // silent, even if invisible adapter heartbeats are still flowing (web-search buffering +
  // raw-byte progress). Upstream activity only resets the stall watchdog.
  let upstreamActivity = false;
  let wireActivity = false;
  let beat: unknown;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let emittedFrames = 0;
  let gated = false;
  let stepping = false;
      let terminateForTranslatorOverflow: ((error: unknown) => void) | undefined;
      const emit = (name: string, data: Record<string, unknown>) => {
        if (closed) return;
        wireActivity = true;
        try {
          const frameText = sseEvent(name, { type: name, sequence_number: seq++, ...data });
          const frameBytes = bytesOf(frameText);
          const reservation = budget?.reserveTransient(frameBytes, { kind: "live_transient" });
          const frame = encoder.encode(frameText);
          reservation?.commitRetained();
          controller.enqueue(frame);
          budget?.releaseRetained(frameBytes, { kind: "live_transient" });
          emittedFrames++;
        } catch (error) {
          if (isTranslatorBudgetExceededError(error)) {
            terminateForTranslatorOverflow?.(error);
            return;
          }
          closed = true;
          disposeOwnedBudget();
        }
      };
      const emitDone = () => {
        if (closed) return;
        try {
          const done = "data: [DONE]\n\n";
          const doneBytes = bytesOf(done);
          const reservation = budget?.reserveTransient(doneBytes, { kind: "live_transient" });
          const frame = encoder.encode(done);
          reservation?.commitRetained();
          controller.enqueue(frame);
          budget?.releaseRetained(doneBytes, { kind: "live_transient" });
          emittedFrames++;
        } catch (error) {
          if (isTranslatorBudgetExceededError(error)) {
            terminateForTranslatorOverflow?.(error);
            return;
          }
          closed = true;
        }
      };

      const createdAt = Math.floor(Date.now() / 1000);
      let outputIndex = 0;
      const finishedItems: OutputItem[] = [];
      const retainFinishedItem = (item: OutputItem, replacedBytes = 0, kind: TranslatorBufferKind = "retained_collectors") => {
        const itemBytes = bytesOf(JSON.stringify(item));
        const reservation = budget?.reserveTransient(itemBytes, { kind });
        finishedItems.push(item);
        reservation?.commitRetained();
        if (replacedBytes > 0) budget?.releaseRetained(replacedBytes, { kind });
      };

      const responseSnapshot = (status: string, output: OutputItem[], endTurn?: boolean) => ({
        id: responseId, object: "response", created_at: createdAt,
        status, model: modelId, output, usage: null,
        ...(endTurn !== undefined ? { end_turn: endTurn } : {}),
      });

      const heartbeatFrame = options?.heartbeatStyle === "comment"
        ? encoder.encode(': opencodex heartbeat\n\n')
        : encoder.encode('event: response.heartbeat\ndata: {"type":"response.heartbeat"}\n\n');
      let stallTicks = 0;
      const stallSec = resolveStallTimeoutSec(options?.stallTimeoutSec);
      const maxStallTicks = Math.ceil((stallSec * 1000) / heartbeatMs);

      let currentMsg: { itemId: string; outputIndex: number; text: string; textBytes: number; phase?: OcxMessagePhase } | null = null;
      let currentReasoning: { itemId: string; outputIndex: number; text: string; textBytes: number } | null = null;
      let currentRawReasoning: { itemId: string; outputIndex: number; text: string; textBytes: number } | null = null;
      // Anthropic extended-thinking round-trip state: the signature signs the CURRENT thinking
      // block; redacted blocks are opaque payloads replayed verbatim. Attached to the reasoning
      // item as an ocxr1 encrypted_content envelope on close. hiddenThinkingText collects the
      // suppressed text under hideThinkingSummary so the signed text still round-trips.
      let pendingSignature: string | undefined;
      let pendingSignatureBytes = 0;
      let pendingRedacted: string[] = [];
      let hiddenThinkingText = "";
      let hiddenThinkingBytes = 0;
      const takeReasoningEnvelope = (hiddenText?: string): string | undefined => {
        if (!pendingSignature && pendingRedacted.length === 0) return undefined;
        const envelope: ReasoningEnvelope = {};
        if (pendingSignature) envelope.sig = pendingSignature;
        if (pendingRedacted.length > 0) envelope.red = pendingRedacted;
        if (hiddenText) envelope.txt = hiddenText;
        const previousBytes = pendingSignatureBytes
          + pendingRedacted.reduce((sum, value) => sum + bytesOf(value), 0)
          + (hiddenText ? hiddenThinkingBytes : 0);
        const encoded = encodeReasoningEnvelope(envelope);
        const reservation = budget?.reserveTransient(bytesOf(encoded), { kind: "reasoning" });
        pendingSignature = undefined;
        pendingSignatureBytes = 0;
        pendingRedacted = [];
        reservation?.commitRetained();
        budget?.releaseRetained(previousBytes, { kind: "reasoning" });
        return encoded;
      };
      // hideThinkingSummary path: no visible reasoning item exists, but a signed thinking block
      // must still round-trip — emit an envelope-only reasoning item (empty summary, no text leak).
      const flushHiddenReasoningEnvelope = () => {
        const encrypted = takeReasoningEnvelope(hiddenThinkingText || undefined);
        hiddenThinkingText = "";
        hiddenThinkingBytes = 0;
        if (!encrypted) return;
        const itemId = `rs_${uuid()}`;
        const item = { type: "reasoning", id: itemId, summary: [] as never[], encrypted_content: encrypted };
        emit("response.output_item.added", { output_index: outputIndex, item });
        emit("response.output_item.done", { output_index: outputIndex, item });
        retainFinishedItem(item as OutputItem, bytesOf(encrypted), "reasoning");
        outputIndex++;
      };
      // hideThinkingSummary for RAW reasoning (openai-chat reasoning_content, kiro tags): no
      // visible reasoning item is emitted — the app renders nothing, so tool cells keep grouping
      // like native models — but the text still round-trips in a txt-only ocxr1 envelope so
      // preserveReasoningContentModels replay (GLM interleaved thinking) keeps working. Direct
      // encodeReasoningEnvelope: takeReasoningEnvelope's sig/red guard would drop txt-only.
      let hiddenRawReasoningText = "";
      let hiddenRawReasoningBytes = 0;
      // Raw reasoning text flushed most recently, waiting for the tool call it
      // preceded. Recorded into the replay cache on tool_call_start so a later
      // continuation can re-attach it when history lost the reasoning item
      // (issue #950). Kept until new reasoning/text arrives: parallel tool
      // calls share the same preceding reasoning block.
      let rawReasoningForNextToolCall = "";
      const flushHiddenRawReasoning = () => {
        if (!hiddenRawReasoningText) return;
        rawReasoningForNextToolCall = hiddenRawReasoningText;
        const previousBytes = hiddenRawReasoningBytes;
        const encrypted = encodeReasoningEnvelope({ txt: hiddenRawReasoningText });
        const reservation = budget?.reserveTransient(bytesOf(encrypted), { kind: "reasoning" });
        hiddenRawReasoningText = "";
        hiddenRawReasoningBytes = 0;
        reservation?.commitRetained();
        budget?.releaseRetained(previousBytes, { kind: "reasoning" });
        const itemId = `rs_${uuid()}`;
        const item = { type: "reasoning", id: itemId, summary: [] as never[], encrypted_content: encrypted };
        emit("response.output_item.added", { output_index: outputIndex, item });
        emit("response.output_item.done", { output_index: outputIndex, item });
        retainFinishedItem(item as OutputItem, bytesOf(encrypted), "reasoning");
        outputIndex++;
      };
      // Kiro reasoning round-trip. Kiro sends its encrypted blob at the END of a turn, while the
      // assistant message is still open, so this CANNOT emit on arrival: the open message still
      // owns `outputIndex` (it only advances on close), and an item emitted here would both reuse
      // that index and land BEFORE the message — where the parser's backwards pairing drops it as
      // orphaned. Stash it and flush after `done` has closed every open item instead.
      let pendingKiroRedacted: string | undefined;
      let pendingKiroRedactedBytes = 0;
      const flushKiroRedactedReasoning = () => {
        if (!pendingKiroRedacted) return;
        const previousBytes = pendingKiroRedactedBytes;
        const encrypted = encodeReasoningEnvelope({ krc: pendingKiroRedacted });
        const reservation = budget?.reserveTransient(bytesOf(encrypted), { kind: "reasoning" });
        pendingKiroRedacted = undefined;
        pendingKiroRedactedBytes = 0;
        reservation?.commitRetained();
        budget?.releaseRetained(previousBytes, { kind: "reasoning" });
        const itemId = `rs_${uuid()}`;
        const item = { type: "reasoning", id: itemId, summary: [] as never[], encrypted_content: encrypted };
        emit("response.output_item.added", { output_index: outputIndex, item });
        emit("response.output_item.done", { output_index: outputIndex, item });
        retainFinishedItem(item as OutputItem, bytesOf(encrypted), "reasoning");
        outputIndex++;
      };
      // Full assistant text of a compaction turn (across message boundaries) — becomes the
      // synthetic compaction item's payload on done.
      let compactionText = "";
      let compactionTextBytes = 0;
      let currentToolCall: { itemId: string; outputIndex: number; callId: string; name: string; args: string; argsBytes: number; namespace?: string; freeform?: boolean; toolSearch?: boolean; inputEmitted?: string; codeModeHelperName?: string; providerMetadata?: OcxProviderOpaqueToolCallMetadata } | null = null;
      // Open native web-search cell (between begin and end). Holds the output index allocated on
      // begin so the matching done reuses it; closed as `failed` if the stream terminates early.
      let currentWebSearch: { itemId: string; eventId: string; outputIndex: number } | null = null;
      // Sources from completed web searches, awaiting the next assistant message. Attached as
      // url_citation annotations on that message (the desktop app's Sources chip), then cleared so
      // they bind to exactly one message. Deduped by URL across multiple searches in the turn.
      let pendingWebSources: { url: string; title?: string }[] = [];
      let pendingWebSourceBytes = 0;
      const releasePendingWebSources = () => {
        if (pendingWebSources.length === 0) return;
        pendingWebSources = [];
        budget?.releaseRetained(pendingWebSourceBytes, { kind: "tool_search_sources" });
        pendingWebSourceBytes = 0;
      };
      const takeWebAnnotations = (): { type: string; url: string; title?: string; start_index: number; end_index: number }[] => {
        if (pendingWebSources.length === 0) return [];
        const anns = pendingWebSources.map(s => ({
          type: "url_citation", url: s.url, ...(s.title ? { title: s.title } : {}), start_index: 0, end_index: 0,
        }));
        const annotationBytes = bytesOf(JSON.stringify(anns));
        const reservation = budget?.reserveTransient(annotationBytes, { kind: "retained_collectors" });
        reservation?.commitRetained();
        releasePendingWebSources();
        return anns;
      };

      const closeCurrentMessage = (inferredPhase?: OcxMessagePhase) => {
        if (!currentMsg) return;
        // Chat Completions has no message-phase field. Keep its live item provisional, then
        // classify it only when the next adapter event proves whether this text led into more
        // work or completed the turn. Explicit adapter phases always outrank this inference.
        const phase = currentMsg.phase ?? inferredPhase;
        // Bind any pending web-search citations to this assistant message (then they clear).
        const annotations = takeWebAnnotations();
        // Finalize the text part (Responses protocol). Without these .done events Codex never
        // commits the content part and renders the message as truncated / cut off.
        emit("response.output_text.done", {
          item_id: currentMsg.itemId, output_index: currentMsg.outputIndex, content_index: 0, text: currentMsg.text,
        });
        emit("response.content_part.done", {
          item_id: currentMsg.itemId, output_index: currentMsg.outputIndex, content_index: 0,
          part: { type: "output_text", text: currentMsg.text, annotations },
        });
        const item = {
          type: "message", id: currentMsg.itemId, status: "completed", role: "assistant",
          content: [{ type: "output_text", text: currentMsg.text, annotations }],
          ...(phase ? { phase } : {}),
        };
        emit("response.output_item.done", { output_index: currentMsg.outputIndex, item });
        retainFinishedItem(item as OutputItem, currentMsg.textBytes + bytesOf(JSON.stringify(annotations)));
        outputIndex++;
        currentMsg = null;
      };

      const closeCurrentReasoning = () => {
        if (!currentReasoning) return;
        emit("response.reasoning_summary_text.done", {
          item_id: currentReasoning.itemId, output_index: currentReasoning.outputIndex, summary_index: 0, text: currentReasoning.text,
        });
        emit("response.reasoning_summary_part.done", {
          item_id: currentReasoning.itemId, output_index: currentReasoning.outputIndex, summary_index: 0,
          part: { type: "summary_text", text: currentReasoning.text },
        });
        const encrypted = takeReasoningEnvelope();
        const item = {
          type: "reasoning", id: currentReasoning.itemId,
          summary: [{ type: "summary_text", text: currentReasoning.text }],
          ...(encrypted ? { encrypted_content: encrypted } : {}),
        };
        emit("response.output_item.done", { output_index: currentReasoning.outputIndex, item });
        retainFinishedItem(item as OutputItem, currentReasoning.textBytes + bytesOf(encrypted ?? ""), "reasoning");
        outputIndex++;
        currentReasoning = null;
      };

      const closeCurrentRawReasoning = () => {
        if (!currentRawReasoning) return;
        rawReasoningForNextToolCall = currentRawReasoning.text;
        emit("response.reasoning_summary_text.done", {
          item_id: currentRawReasoning.itemId, output_index: currentRawReasoning.outputIndex, summary_index: 0, text: currentRawReasoning.text,
        });
        emit("response.reasoning_summary_part.done", {
          item_id: currentRawReasoning.itemId, output_index: currentRawReasoning.outputIndex, summary_index: 0,
          part: { type: "summary_text", text: currentRawReasoning.text },
        });
        const item = {
          type: "reasoning", id: currentRawReasoning.itemId,
          summary: [{ type: "summary_text", text: currentRawReasoning.text }],
        };
        emit("response.output_item.done", { output_index: currentRawReasoning.outputIndex, item });
        retainFinishedItem(item as OutputItem, currentRawReasoning.textBytes, "reasoning");
        outputIndex++;
        currentRawReasoning = null;
      };

      const closeCurrentToolCall = () => {
        if (!currentToolCall) return;
        // Empty input (no-arg tools like computer_use get_app_state / list_apps) must serialize as
        // "{}", never "" — Codex echoes the call back as a function_call next turn, and JSON.parse("")
        // would 400 the whole session ("invalid JSON arguments"), poisoning all later turns.
        // #1611: Grok serializes integer arguments through a float, so `120000.0`
        // reaches Codex and is REJECTED before the tool runs. Repair integral floats
        // against the declared schema; a non-integral value stays an error.
        const argsStr = coerceIntegerToolArguments(
          currentToolCall.args || "{}",
          options?.toolParameterSchemas?.get(currentToolCall.name),
          currentToolCall.namespace === undefined ? currentToolCall.name : undefined,
        );
        // Finalize streamed function-call arguments so Codex commits the call (incl. MCP / computer_use).
        if (!currentToolCall.freeform && !currentToolCall.toolSearch) {
          emit("response.function_call_arguments.done", {
            item_id: currentToolCall.itemId, output_index: currentToolCall.outputIndex, arguments: argsStr,
          });
        }
        if (currentToolCall.freeform) {
          emit("response.custom_tool_call_input.done", {
            item_id: currentToolCall.itemId, output_index: currentToolCall.outputIndex,
            ...(currentToolCall.namespace ? { namespace: currentToolCall.namespace } : {}),
            input: freeformInput(currentToolCall.args, currentToolCall.name, currentToolCall.namespace, currentToolCall.codeModeHelperName),
          });
        }
        // Freeform tools serialize as custom_tool_call without extra_content; remember the
        // signature server-side regardless so the replayed call can be re-signed (#1735).
        void rememberExtraContentForReplay(currentToolCall.callId, currentToolCall.providerMetadata, replayCacheScope);
        const item = currentToolCall.toolSearch
          ? {
              type: "tool_search_call", id: currentToolCall.itemId,
              call_id: currentToolCall.callId, execution: "client",
              arguments: parseArgsObj(currentToolCall.args), status: "completed",
            }
          : currentToolCall.freeform
          ? {
              type: "custom_tool_call", id: currentToolCall.itemId,
              call_id: currentToolCall.callId, name: currentToolCall.name,
              ...(currentToolCall.namespace ? { namespace: currentToolCall.namespace } : {}),
              input: freeformInput(currentToolCall.args, currentToolCall.name, currentToolCall.namespace, currentToolCall.codeModeHelperName), status: "completed",
            }
          : {
              type: "function_call", id: currentToolCall.itemId,
              call_id: currentToolCall.callId, name: currentToolCall.name,
              arguments: argsStr, status: "completed",
              ...(currentToolCall.namespace ? { namespace: currentToolCall.namespace } : {}),
              // Provider-opaque metadata (issue #1735) rides the item so a client that replays
              // this history can hand the signature back on the part it belongs to. The proxy
              // also remembers it server-side for clients that never echo extra_content.
              ...(rememberAndSerializeExtraContent(currentToolCall.callId, currentToolCall.providerMetadata, replayCacheScope).extra ?? {}),
            };
        emit("response.output_item.done", { output_index: currentToolCall.outputIndex, item });
        retainFinishedItem(item as OutputItem);
        budget?.closeCall(currentToolCall.callId);
        outputIndex++;
        currentToolCall = null;
      };

      // Terminal-error / incomplete path for an open tool call (#765 remainder).
      // Closing via closeCurrentToolCall() would emit function_call_arguments.done and
      // status:"completed" BEFORE response.failed — the client still sees an issued call.
      // Cancel instead: no *.done argument frames, status:"incomplete" (same pattern as an
      // in-flight web_search_call closing as "failed"). Args still serialize as "{}" when
      // empty so echoed items cannot poison the next turn with JSON.parse("").
      const failCurrentToolCall = () => {
        if (!currentToolCall) return;
        const argsStr = currentToolCall.args || "{}";
        void rememberExtraContentForReplay(currentToolCall.callId, currentToolCall.providerMetadata, replayCacheScope);
        const item = currentToolCall.toolSearch
          ? {
              type: "tool_search_call", id: currentToolCall.itemId,
              call_id: currentToolCall.callId, execution: "client",
              arguments: parseArgsObj(currentToolCall.args), status: "incomplete",
            }
          : currentToolCall.freeform
          ? {
              type: "custom_tool_call", id: currentToolCall.itemId,
              call_id: currentToolCall.callId, name: currentToolCall.name,
              ...(currentToolCall.namespace ? { namespace: currentToolCall.namespace } : {}),
              input: freeformInput(currentToolCall.args, currentToolCall.name, currentToolCall.namespace, currentToolCall.codeModeHelperName), status: "incomplete",
            }
          : {
              type: "function_call", id: currentToolCall.itemId,
              call_id: currentToolCall.callId, name: currentToolCall.name,
              arguments: argsStr, status: "incomplete",
              ...(currentToolCall.namespace ? { namespace: currentToolCall.namespace } : {}),
              // An incomplete call can still be persisted and replayed (max_output_tokens), so it
              // carries the same metadata as the completed item — otherwise SSE and buffered JSON
              // would disagree about whether the signature survives.
              ...(rememberAndSerializeExtraContent(currentToolCall.callId, currentToolCall.providerMetadata, replayCacheScope).extra ?? {}),
            };
        emit("response.output_item.done", { output_index: currentToolCall.outputIndex, item });
        retainFinishedItem(item as OutputItem);
        budget?.closeCall(currentToolCall.callId);
        outputIndex++;
        currentToolCall = null;
      };

      const abortCurrentToolCallForTranslatorOverflow = () => {
        if (!currentToolCall) return;
        budget?.closeCall(currentToolCall.callId);
        currentToolCall = null;
      };

      // Finalize an open web-search cell. `status` is "completed" on a normal end, or "failed" when
      // the stream terminates (error/incomplete) while a search was still in flight, so Codex never
      // leaves a "Searching the web" spinner spinning forever.
      // `sources` rides on the done item (additive field; codex-rs serde ignores unknown fields) so
      // downstream translators (claude outbound) can fill web_search_tool_result content.
      const closeCurrentWebSearch = (status: "completed" | "failed", queries: string[], sources?: { url: string; title?: string }[]) => {
        if (!currentWebSearch) return;
        const item = {
          type: "web_search_call", id: currentWebSearch.itemId, status,
          action: webSearchAction(queries),
          ...(sources && sources.length > 0 ? { sources } : {}),
        };
        emit("response.output_item.done", { output_index: currentWebSearch.outputIndex, item });
        retainFinishedItem(item as OutputItem);
        outputIndex++;
        currentWebSearch = null;
      };

      // RC1: guarantee the Responses stream always ends with exactly one terminal event. Set true
      // when a done/error/catch terminal is emitted; if the adapter generator returns without one
      // we synthesize a terminal below, so Codex never hits the parser's
      // "stream closed before response.completed" (responses.rs) -> ApiError::Stream.
      // That synthesized terminal is response.incomplete with reason "adapter_eof", NOT
      // response.completed: a generator that returns without a terminal event is a truncated
      // stream, and reporting it as a clean finish is the failure mode this whole path exists
      // to avoid. The comment said "completed" long after the code stopped doing that.
      let terminated = false;
      let firstOutputReported = false;
      const reportFirstOutput = (event: AdapterEvent): void => {
        if (firstOutputReported) return;
        const nonEmpty = event.type === "text_delta"
          ? event.text.length > 0
          : event.type === "thinking_delta"
            ? event.thinking.length > 0
            : event.type === "reasoning_raw_delta"
              ? event.text.length > 0
              : false;
        if (!nonEmpty) return;
        firstOutputReported = true;
        try { options?.onFirstOutput?.(); } catch { /* metrics must not break the stream */ }
      };
      const it = events[Symbol.asyncIterator]();
      let iteratorStarted = false;
      let iteratorReturned = false;
      let upstreamDone = false;
      const returnIterator = () => {
        if (iteratorReturned) return;
        iteratorReturned = true;
        const finishReturn = () => {
          try {
            void it.return?.()?.catch(() => {});
          } catch {
            /* synchronous iterator cleanup failure is also best-effort */
          }
        };
        // Async-generator return() before the first next() does not enter the generator, so its
        // finally blocks cannot cancel prepared upstream bodies. The cancel hook has already
        // aborted the turn; bootstrap one cleanup step, then close the iterator without awaiting it.
        if (!iteratorStarted) {
          iteratorStarted = true;
          try {
            void it.next().then(finishReturn, () => {}).catch(() => {});
          } catch {
            /* synchronous iterator start failure is also best-effort */
          }
          return;
        }
        finishReturn();
      };
      let upstreamCancelled = false;
      const cancelUpstreamOnce = () => {
        if (upstreamCancelled) return;
        upstreamCancelled = true;
        try { onCancel?.(); } catch { /* cancellation must not strand the client stream */ }
        returnIterator();
      };
      let handlingTranslatorOverflow = false;
      terminateForTranslatorOverflow = _error => {
        if (handlingTranslatorOverflow || terminated || clientCancelled || closed) return;
        handlingTranslatorOverflow = true;
        abortCurrentToolCallForTranslatorOverflow();
        currentWebSearch = null;
        releasePendingWebSources();
        const failure = adapterFailureFromEvent({
          type: "error",
          status: 502,
          errorType: "upstream_error",
          code: "translation_buffer_limit",
          message: "upstream translation buffer exceeded the safe limit",
        }).error;
        const failedFrame = sseEvent("response.failed", {
          type: "response.failed",
          sequence_number: seq++,
          response: {
            ...responseSnapshot("failed", finishedItems),
            error: failure,
            last_error: failure,
          },
        });
        try {
          controller.enqueue(encoder.encode(failedFrame));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          emittedFrames += 2;
        } catch {
          /* client already tore down the stream */
        }
        reportTerminal("failed");
        terminated = true;
        cancelUpstreamOnce();
        if (beat !== undefined) clearBeatInterval(beat);
        beat = undefined;
        try { controller.close(); } catch { /* already closed */ }
        closed = true;
        disposeOwnedBudget();
        gated = true;
        stepping = false;
      };
      const step = async () => {
        if (stepping || closed) return;
        stepping = true;
        gated = false;
        const emittedAtStart = emittedFrames;
        try {
        while (!terminated && !closed && emittedFrames === emittedAtStart) {
          iteratorStarted = true;
          const next = await it.next();
          // A cancel during this await disposes the owned budget; a late event
          // must never be processed or charged against it. Exit step() outright:
          // falling into EOF synthesis would let closeCurrentMessage() charge
          // finished-item retention against the disposed budget.
          if (closed || clientCancelled) {
            gated = true;
            stepping = false;
            return;
          }
          if (next.done) { upstreamDone = true; break; }
          const event = next.value;
          let terminalEvent = false;
          // Invisible adapter heartbeats (and buffered web-search progress) count as upstream
          // liveness only — they must not suppress wire keepalives that re-arm Codex idle timers.
          upstreamActivity = true;
          stallTicks = 0;
          reportFirstOutput(event);
          // Compaction turns emit ONLY the synthetic compaction item + response.completed. The
          // summary text is accumulated silently: emitting it as a normal assistant message would
          // duplicate the summary if this response is ever replayed via previous_response_id
          // expansion (rememberResponseState stores input + output). Codex ignores extra items but
          // its compaction UI renders nothing mid-turn, so nothing is lost visually.
          if (options?.compaction) {
            if (event.type === "text_delta") {
              ({ value: compactionText, bytes: compactionTextBytes } = appendString(
                compactionText,
                compactionTextBytes,
                event.text,
                "retained_collectors",
              ));
              continue;
            }
            if (event.type !== "done" && event.type !== "incomplete" && event.type !== "error") continue;
          }
          switch (event.type) {
            case "assistant_boundary": {
              // A guarded continuation starts a fresh assistant output item while keeping the
              // intermediate, suspicious text in the same Responses turn.
              if (currentMsg) closeCurrentMessage("commentary");
              if (currentReasoning) closeCurrentReasoning();
              if (currentRawReasoning) closeCurrentRawReasoning();
              flushHiddenRawReasoning();
              rawReasoningForNextToolCall = "";
              if (currentToolCall) closeCurrentToolCall();
              flushHiddenReasoningEnvelope();
              break;
            }
            case "text_delta": {
              if (currentReasoning) closeCurrentReasoning();
              if (currentRawReasoning) closeCurrentRawReasoning();
              flushHiddenRawReasoning();
              // Reasoning consumed by a REAL text turn, not a tool call: no cache target.
              // Empty text deltas must not wipe reasoning that precedes a tool call
              // (chat-completions providers emit empty content deltas mid-tool-turn).
              if (event.text.length > 0) rawReasoningForNextToolCall = "";
              if (currentToolCall) closeCurrentToolCall();
              // Only flush on an explicit phase change. A later delta that omits `phase` must
              // keep appending to the current message rather than wiping the earlier phase.
              if (currentMsg && event.phase !== undefined && currentMsg.phase !== event.phase) {
                closeCurrentMessage("commentary");
              }
              if (!currentMsg) {
                const itemId = `msg_${uuid()}`;
                const item = {
                  type: "message", id: itemId, status: "in_progress", role: "assistant",
                  content: [] as { type: string; text: string; annotations: never[] }[],
                  ...(event.phase ? { phase: event.phase } : {}),
                };
                emit("response.output_item.added", { output_index: outputIndex, item });
                emit("response.content_part.added", {
                  item_id: itemId, output_index: outputIndex, content_index: 0,
                  part: { type: "output_text", text: "", annotations: [] },
                });
                currentMsg = { itemId, outputIndex, text: "", textBytes: 0, ...(event.phase ? { phase: event.phase } : {}) };
              }
              ({ value: currentMsg.text, bytes: currentMsg.textBytes } = appendString(
                currentMsg.text,
                currentMsg.textBytes,
                event.text,
                "retained_collectors",
              ));
              emit("response.output_text.delta", {
                item_id: currentMsg.itemId, output_index: currentMsg.outputIndex,
                content_index: 0, delta: event.text,
              });
              break;
            }
            case "thinking_delta": {
              if (options?.hideThinkingSummary) {
                // The hidden branch returns early, so flush any raw reasoning
                // that preceded the thinking block and clear the replay-cache
                // candidate — otherwise a stale reasoning_raw_delta would be
                // recorded for a LATER tool call (CodeRabbit on #971).
                flushHiddenRawReasoning();
                rawReasoningForNextToolCall = "";
                ({ value: hiddenThinkingText, bytes: hiddenThinkingBytes } = appendString(
                  hiddenThinkingText,
                  hiddenThinkingBytes,
                  event.thinking,
                  "reasoning",
                ));
                break;
              }
              if (currentMsg) closeCurrentMessage("commentary");
              if (currentRawReasoning) closeCurrentRawReasoning();
              flushHiddenRawReasoning();
              if (event.thinking.length > 0) rawReasoningForNextToolCall = "";
              if (currentToolCall) closeCurrentToolCall();
              if (!currentReasoning) {
                const itemId = `rs_${uuid()}`;
                const item = { type: "reasoning", id: itemId, summary: [] as { type: string; text: string }[] };
                emit("response.output_item.added", { output_index: outputIndex, item });
                emit("response.reasoning_summary_part.added", {
                  item_id: itemId, output_index: outputIndex, summary_index: 0,
                  part: { type: "summary_text", text: "" },
                });
                currentReasoning = { itemId, outputIndex, text: "", textBytes: 0 };
              }
              ({ value: currentReasoning.text, bytes: currentReasoning.textBytes } = appendString(
                currentReasoning.text,
                currentReasoning.textBytes,
                event.thinking,
                "reasoning",
              ));
              emit("response.reasoning_summary_text.delta", {
                item_id: currentReasoning.itemId, output_index: currentReasoning.outputIndex,
                summary_index: 0, delta: event.thinking,
              });
              break;
            }
            case "thinking_signature": {
              pendingSignatureBytes = replaceRetainedString(pendingSignatureBytes, event.signature, "reasoning");
              pendingSignature = event.signature;
              // Signature arrives at the end of the thinking block. With a visible reasoning item
              // open, closeCurrentReasoning attaches the envelope; hidden/suppressed blocks flush
              // an envelope-only reasoning item now.
              if (!currentReasoning) flushHiddenReasoningEnvelope();
              break;
            }
            case "redacted_thinking": {
              budget?.chargeRetained(bytesOf(event.data), { kind: "reasoning" });
              pendingRedacted.push(event.data);
              break;
            }
            case "kiro_redacted_reasoning": {
              // Stash only — see flushKiroRedactedReasoning. One blob per turn, so last wins.
              pendingKiroRedactedBytes = replaceRetainedString(pendingKiroRedactedBytes, event.data, "reasoning");
              pendingKiroRedacted = event.data;
              break;
            }
            case "reasoning_raw_delta": {
              if (options?.hideThinkingSummary) {
                ({ value: hiddenRawReasoningText, bytes: hiddenRawReasoningBytes } = appendString(
                  hiddenRawReasoningText,
                  hiddenRawReasoningBytes,
                  event.text,
                  "reasoning",
                ));
                break;
              }
              if (currentMsg) closeCurrentMessage("commentary");
              if (currentReasoning) closeCurrentReasoning();
              if (currentToolCall) closeCurrentToolCall();
              if (!currentRawReasoning) {
                const itemId = `rs_${uuid()}`;
                const item = { type: "reasoning", id: itemId, summary: [] as { type: string; text: string }[] };
                emit("response.output_item.added", { output_index: outputIndex, item });
                emit("response.reasoning_summary_part.added", {
                  item_id: itemId, output_index: outputIndex, summary_index: 0,
                  part: { type: "summary_text", text: "" },
                });
                currentRawReasoning = { itemId, outputIndex, text: "", textBytes: 0 };
              }
              ({ value: currentRawReasoning.text, bytes: currentRawReasoning.textBytes } = appendString(
                currentRawReasoning.text,
                currentRawReasoning.textBytes,
                event.text,
                "reasoning",
              ));
              emit("response.reasoning_summary_text.delta", {
                item_id: currentRawReasoning.itemId, output_index: currentRawReasoning.outputIndex,
                summary_index: 0, delta: event.text,
              });
              break;
            }
            case "tool_call_start": {
              if (currentMsg) closeCurrentMessage("commentary");
              if (currentReasoning) closeCurrentReasoning();
              if (currentRawReasoning) closeCurrentRawReasoning();
              flushHiddenRawReasoning();
              if (rawReasoningForNextToolCall) {
                rememberReasoningForCall(event.id, rawReasoningForNextToolCall, replayCacheScope);
              }
              if (currentToolCall) closeCurrentToolCall();
              const effectiveName = normalizeDeclaredToolName(event.name, options?.declaredToolNames);
              const codeModeHelperName = effectiveName === "exec" && event.name !== effectiveName
                ? event.name
                : undefined;
              const mapped = toolNsMap?.get(effectiveName);
              const realName = mapped?.name ?? effectiveName;
              if (options?.declaredToolNames && !options.declaredToolNames.has(effectiveName)) {
                const failure = responseError(
                  502,
                  "upstream_error",
                  `routed provider emitted undeclared client tool "${effectiveName}"; only request-declared tools may be called`,
                );
                emit("response.failed", {
                  response: {
                    ...responseSnapshot("failed", finishedItems),
                    error: failure,
                    last_error: failure,
                  },
                });
                reportTerminal("failed");
                terminalEvent = true;
                break;
              }
              const ns = mapped?.namespace;
              const toolSearch = toolSearchToolNames?.has(realName) ?? false;
              const freeform = !toolSearch && (mapped
                ? mapped.freeform === true
                : (freeformToolNames?.has(realName) ?? false));
              const itemId = `${toolSearch ? "tsc" : freeform ? "ctc" : "fc"}_${uuid()}`;
              const item = toolSearch
                ? { type: "tool_search_call", id: itemId, call_id: event.id, execution: "client", arguments: {}, status: "in_progress" }
                : freeform
                ? { type: "custom_tool_call", id: itemId, call_id: event.id, name: realName, ...(ns ? { namespace: ns } : {}), input: "", status: "in_progress" }
                : { type: "function_call", id: itemId, call_id: event.id, name: realName, arguments: "", status: "in_progress", ...(ns ? { namespace: ns } : {}) };
              emit("response.output_item.added", { output_index: outputIndex, item });
              currentToolCall = { itemId, outputIndex, callId: event.id, name: realName, args: "", argsBytes: 0, namespace: ns, freeform, toolSearch, codeModeHelperName, providerMetadata: event.providerMetadata };
              budget?.openCall(event.id);
              break;
            }
            case "tool_call_delta": {
              if (currentToolCall) {
                ({ value: currentToolCall.args, bytes: currentToolCall.argsBytes } = appendString(
                  currentToolCall.args,
                  currentToolCall.argsBytes,
                  event.arguments,
                  "tool_args",
                  currentToolCall.callId,
                ));
                if (!currentToolCall.freeform && !currentToolCall.toolSearch) {
                  emit("response.function_call_arguments.delta", {
                    item_id: currentToolCall.itemId, output_index: currentToolCall.outputIndex,
                    delta: event.arguments,
                  });
                }
                if (currentToolCall.freeform && !currentToolCall.codeModeHelperName) {
                  // Hold while the buffer is still an ambiguous prefix of the JSON wrapper,
                  // then stream only the unwrapped input suffix (never rewind on mode flips).
                  if (!FREEFORM_WRAP_PREFIX.startsWith(currentToolCall.args)) {
                    const full = freeformPartialInput(currentToolCall.args);
                    const emitted = currentToolCall.inputEmitted ?? "";
                    if (full.startsWith(emitted) && full.length > emitted.length) {
                      emit("response.custom_tool_call_input.delta", {
                        item_id: currentToolCall.itemId, output_index: currentToolCall.outputIndex,
                        delta: full.slice(emitted.length),
                      });
                      currentToolCall.inputEmitted = full;
                    }
                  }
                }
              }
              break;
            }
            case "tool_call_end": {
              // Fragments already streamed cannot be repaired. Refuse to complete a function call
              // whose assembled arguments do not parse — cancel the item and fail the turn so the
              // client never sees status:"completed" for unusable args (#765 stream remainder).
              if (
                currentToolCall
                && !currentToolCall.freeform
                && !currentToolCall.toolSearch
                && !toolCallArgumentsUsable(currentToolCall.args)
              ) {
                failCurrentToolCall();
                const failure = responseError(
                  502,
                  "upstream_error",
                  "upstream stream produced malformed tool call arguments",
                );
                emit("response.failed", {
                  response: {
                    ...responseSnapshot("failed", finishedItems),
                    error: failure,
                    last_error: failure,
                  },
                });
                reportTerminal("failed");
                terminalEvent = true;
                break;
              }
              closeCurrentToolCall();
              break;
            }
            case "web_search_call_begin": {
              // Open the native search cell so Codex shows the "Searching the web" spinner WHILE the
              // sidecar runs. Close any other open item first, allocate this item's output index, and
              // hold it open until the matching `web_search_call_end` (or a terminal close).
              if (currentMsg) closeCurrentMessage("commentary");
              if (currentReasoning) closeCurrentReasoning();
              if (currentRawReasoning) closeCurrentRawReasoning();
              flushHiddenRawReasoning();
              if (currentToolCall) closeCurrentToolCall();
              if (currentWebSearch) closeCurrentWebSearch("completed", []);
              const wsItemId = `ws_${uuid()}`;
              emit("response.output_item.added", {
                output_index: outputIndex,
                item: { type: "web_search_call", id: wsItemId, status: "in_progress" },
              });
              currentWebSearch = { itemId: wsItemId, eventId: event.id, outputIndex };
              break;
            }
            case "web_search_call_end": {
              // The sidecar resolved — finalize the cell as "Searched <query>". If no begin opened
              // (defensive), synthesize the added frame first so the done has a matching item.
              if (!currentWebSearch || currentWebSearch.eventId !== event.id) {
                if (currentWebSearch) closeCurrentWebSearch("completed", []);
                const wsItemId2 = `ws_${uuid()}`;
                emit("response.output_item.added", {
                  output_index: outputIndex,
                  item: { type: "web_search_call", id: wsItemId2, status: "in_progress" },
                });
                currentWebSearch = { itemId: wsItemId2, eventId: event.id, outputIndex };
              }
              const safeSources = safeWebSearchSources(event.sources);
              closeCurrentWebSearch(event.status ?? "completed", event.queries, safeSources);
              // Queue this search's sources for the next assistant message (dedup by URL).
              if (safeSources.length > 0) {
                for (const source of safeSources) {
                  if (appendSafeWebSearchSource(pendingWebSources, source)) {
                    pendingWebSourceBytes += chargeValue(source, "tool_search_sources");
                  }
                }
              }
              break;
            }
            case "done": {
              if (currentMsg) closeCurrentMessage(event.stopReason ? undefined : "final_answer");
              if (currentReasoning) closeCurrentReasoning();
              if (currentRawReasoning) closeCurrentRawReasoning();
              flushHiddenRawReasoning();
              if (currentToolCall) closeCurrentToolCall();
              if (currentWebSearch) closeCurrentWebSearch("completed", []);
              releasePendingWebSources();
              // Redacted-only turns (or hidden thinking without a trailing signature event) still
              // need their envelope-only reasoning item so the blocks replay next turn.
              flushHiddenReasoningEnvelope();
              // After every close above, so the blob lands AFTER the assistant message it belongs
              // to and the parser's backwards pairing finds it.
              flushKiroRedactedReasoning();
              // Truncated turns must never install replacement history (#422). The buffered path
              // has always checked this; streaming emitted the item BEFORE reading stopReason, so
              // a max_tokens/content_filter turn shipped a half-written summary and then declared
              // itself incomplete — the same hazard, one branch over.
              if (options?.compaction && !isTruncatedStopReason(event.stopReason)) {
                // Exactly one compaction item per turn; codex-rs takes the first and fatals on 0.
                const item = {
                  type: "compaction", id: `cmp_${uuid()}`,
                  encrypted_content: encodeCompactionSummary(compactionText),
                };
                emit("response.output_item.done", { output_index: outputIndex, item });
                retainFinishedItem(item as OutputItem, compactionTextBytes);
                outputIndex++;
              }
              // Recognize every adapter's truncation vocabulary, not just the canonical pair.
              // Suppression and terminal status must agree: withholding the compaction item while
              // still reporting success hands codex-rs a completed response with zero compaction
              // items, which it treats as fatal.
              if (truncationReasonFor(event.stopReason)) {
                // Upstream stopped before a normal completion. Surface as incomplete so the
                // client can distinguish a truncated/filtered turn from a finished one.
                // #1926 gap 2: bound the window in which a handed-out thought signature is
                // not yet durable before the turn becomes externally terminal.
                await awaitThoughtSignatureDurability();
                const response = {
                  ...responseSnapshot("incomplete", finishedItems, event.endTurn),
                  usage: responsesUsage(event.usage),
                  incomplete_details: {
                    reason: truncationReasonFor(event.stopReason) ?? "content_filter",
                  },
                };
                // Cache max-output partials so previous_response_id replay can continue them;
                // rememberResponseState rejects content-filtered incomplete responses.
                options?.onCompletedResponse?.(response, event.providerState);
                options?.onUsage?.(event.usage);
                emit("response.incomplete", { response });
                reportTerminal("incomplete");
              } else {
                await awaitThoughtSignatureDurability();
                const response = { ...responseSnapshot("completed", finishedItems, event.endTurn), usage: responsesUsage(event.usage) };
                options?.onCompletedResponse?.(response, event.providerState);
                options?.onUsage?.(event.usage);
                emit("response.completed", {
                  response,
                });
                reportTerminal("completed");
              }
              terminalEvent = true;
              break;
            }
            case "incomplete": {
              if (currentMsg) closeCurrentMessage();
              if (currentReasoning) closeCurrentReasoning();
              if (currentRawReasoning) closeCurrentRawReasoning();
              flushHiddenRawReasoning();
              if (currentToolCall) failCurrentToolCall();
              if (currentWebSearch) closeCurrentWebSearch("failed", []);
              releasePendingWebSources();
              flushHiddenReasoningEnvelope();
              options?.onUsage?.(event.usage);
              await awaitThoughtSignatureDurability();
              emit("response.incomplete", {
                response: {
                  ...responseSnapshot("incomplete", finishedItems, event.endTurn),
                  usage: responsesUsage(event.usage),
                  incomplete_details: {
                    reason: event.reason,
                    ...(event.message ? { message: event.message } : {}),
                    ...(event.retryable !== undefined ? { retryable: event.retryable } : {}),
                  },
                },
              });
              reportTerminal("incomplete");
              terminalEvent = true;
              break;
            }
            case "error": {
              if (event.code === "translation_buffer_limit") {
                terminateForTranslatorOverflow(event);
                return;
              }
              if (currentMsg) closeCurrentMessage();
              if (currentReasoning) closeCurrentReasoning();
              if (currentRawReasoning) closeCurrentRawReasoning();
              flushHiddenRawReasoning();
              if (currentToolCall) failCurrentToolCall();
              if (currentWebSearch) closeCurrentWebSearch("failed", []);
              releasePendingWebSources();
              const failure = adapterFailureFromEvent(event);
              if (event.usage) options?.onUsage?.(event.usage);
              await awaitThoughtSignatureDurability();
              emit("response.failed", {
                response: {
                  ...responseSnapshot("failed", finishedItems),
                  // Partial consumption from a mid-stream upstream failure: surfaced so the request
                  // log can record real tokens instead of usageStatus "unreported" with 0.
                  ...(event.usage ? { usage: responsesUsage(event.usage) } : {}),
                  error: failure.error,
                  last_error: failure.error,
                  ...(isCyberPolicyCode(failure.error.code)
                    ? { retryable: false }
                    : event.retryable !== undefined ? { retryable: event.retryable } : {}),
                },
              });
              reportTerminal("failed");
              terminalEvent = true;
              break;
            }
          }
          if (terminalEvent) {
            cancelUpstreamOnce();
            terminated = true;
            break;
          }
        }
      } catch (err) {
        if (isTranslatorBudgetExceededError(err)) {
          terminateForTranslatorOverflow(err);
          return;
        }
        if (!terminated) {
          flushHiddenRawReasoning();
          if (currentToolCall) failCurrentToolCall();
          if (currentWebSearch) closeCurrentWebSearch("failed", []);
          releasePendingWebSources();
          const failure = responseError(
            500,
            "proxy_error",
            redactSecretString(err instanceof Error ? err.message : String(err)),
          );
          emit("response.failed", {
            response: {
              ...responseSnapshot("failed", finishedItems),
              error: failure,
              last_error: failure,
              ...(isCyberPolicyCode(failure.code) ? { retryable: false } : {}),
            },
          });
          reportTerminal("failed");
          cancelUpstreamOnce();
          terminated = true;
        }
      }

      if (!terminated && !upstreamDone) {
        gated = true;
        stepping = false;
        return;
      }
      if (beat !== undefined) { clearBeatInterval(beat); beat = undefined; }

      if (!terminated) {
        // The adapter generator ended without an explicit done/error event. Mark as incomplete
        // rather than completed so Codex can distinguish a clean finish from a truncated stream.
        if (currentMsg) closeCurrentMessage();
        if (currentReasoning) closeCurrentReasoning();
        if (currentRawReasoning) closeCurrentRawReasoning();
        flushHiddenRawReasoning();
        if (currentToolCall) failCurrentToolCall();
        if (currentWebSearch) closeCurrentWebSearch("failed", []);
        releasePendingWebSources();
        options?.onUsage?.(undefined);
        await awaitThoughtSignatureDurability();
        emit("response.incomplete", {
          response: {
            ...responseSnapshot("incomplete", finishedItems),
            usage: responsesUsage(undefined),
            incomplete_details: { reason: "adapter_eof" },
          },
        });
        reportTerminal("incomplete");
        terminated = true;
      }

      emitDone();
      try {
        controller.close();
      } catch {
        /* already closed (e.g. client cancelled) */
      }
      closed = true;
      disposeOwnedBudget();
      gated = true;
      stepping = false;
      };

      const startStream = () => {
        emit("response.created", { response: responseSnapshot("in_progress", []) });
        // Responses spec parity: clients expect an explicit in_progress frame after created.
        emit("response.in_progress", { response: responseSnapshot("in_progress", []) });
        // The default ReadableStream strategy has HWM=1. Once one event's frames fill that
        // queue, pull stepping pauses; no custom FIFO or queuing strategy is layered on top.
        gated = true;
        beat = setBeatInterval(() => {
          if (closed || gated) return;
          if (upstreamActivity) {
            upstreamActivity = false;
            stallTicks = 0;
          } else if (++stallTicks >= maxStallTicks) {
            if (currentMsg) closeCurrentMessage();
            if (currentReasoning) closeCurrentReasoning();
            if (currentRawReasoning) closeCurrentRawReasoning();
            flushHiddenRawReasoning();
            if (currentToolCall) failCurrentToolCall();
            if (currentWebSearch) closeCurrentWebSearch("failed", []);
            releasePendingWebSources();
            // #1926 gap 2 residual: this beat callback is synchronous, so the durability
            // barrier is not awaited on the stall-timeout kill path. The in-memory store is
            // already updated; only a crash between here and the queued write loses it,
            // which is the pre-#1926 status quo for an already-abnormal termination.
            emit("response.incomplete", {
              response: {
                ...responseSnapshot("incomplete", finishedItems),
                incomplete_details: { reason: "upstream_stall_timeout" },
              },
            });
            reportTerminal("incomplete");
            cancelUpstreamOnce();
            terminated = true;
            emitDone();
            if (beat !== undefined) clearBeatInterval(beat);
            beat = undefined;
            try { controller.close(); } catch { /* already closed */ }
            closed = true;
            disposeOwnedBudget();
            return;
          }
          // Wire silence is independent of upstream adapter heartbeats.
          if (wireActivity) {
            wireActivity = false;
            return;
          }
          try {
            controller.enqueue(heartbeatFrame);
            emittedFrames++;
          } catch {
            closed = true;
            disposeOwnedBudget();
          }
        }, heartbeatMs);
      };

  return new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
      startStream();
    },
    pull() {
      return step();
    },
    cancel() {
      // Client (Codex) disconnected. Stop emitting and let the caller abort the upstream fetch so a
      // cancelled turn does not leak the upstream stream or keep draining tokens (RC2).
        clientCancelled = true;
        closed = true;
        clearOwnedWatchdog();
        if (beat !== undefined) clearBeatInterval(beat);
        cancelUpstreamOnce();
        releasePendingWebSources();
        disposeOwnedBudget();
      },
    });
  }

export function buildResponseJSON(
  events: AdapterEvent[],
  modelId: string,
  options?: Parameters<typeof buildResponseJSONWithBudget>[2],
): Record<string, unknown> {
  // Default-budget safety net: a caller that omits the budget gets a bounded
  // default (disposed with the call), never the unbounded append path.
  if (options?.translatorBudget) return buildResponseJSONWithBudget(events, modelId, options);
  const budget = createTranslatorBudget();
  try {
    return buildResponseJSONWithBudget(events, modelId, { ...options, translatorBudget: budget });
  } finally {
    budget.dispose();
  }
}

function buildResponseJSONWithBudget(
  events: AdapterEvent[],
  modelId: string,
  options?: {
    hideThinkingSummary?: boolean;
    toolNsMap?: Map<string, { namespace: string; name: string; freeform?: true }>;
    /** Request-visible tool names. When present, an upstream call outside this set fails closed. */
    declaredToolNames?: ReadonlySet<string>;
    /** Declared parameter schema per tool name; repairs integral-float integer args (#1611). */
    toolParameterSchemas?: ReadonlyMap<string, Record<string, unknown>>;
    freeformToolNames?: Set<string>;
    toolSearchToolNames?: Set<string>;
    /** Remote compaction v2 turn — append one synthetic compaction output item (see bridgeToResponsesSSE). */
    compaction?: boolean;
    onProviderState?: (state: OcxProviderContinuationState) => void;
    /** Raw adapter-reported usage before wire normalization (see bridgeToResponsesSSE onUsage). */
    onUsage?: (usage: OcxUsage | undefined) => void;
    translatorBudget?: TranslatorBudget;
    /** Conversation identity for the reasoning replay cache (issue #950). */
    replayCacheScope?: OcxReasoningReplayScopeRef;
  },
): Record<string, unknown> {
  const responseId = `resp_${uuid()}`;
  const replayCacheScope = options?.replayCacheScope;
  const output: OutputItem[] = [];
  const budget = options?.translatorBudget;
  const encoder = new TextEncoder();
  const bytesOf = (value: string): number => Buffer.byteLength(value);
  const appendBatchString = (
    previous: string,
    previousBytes: number,
    fragment: string,
    kind: TranslatorBufferKind,
    callId?: string,
  ): { value: string; bytes: number } => {
    const nextBytes = previousBytes + bytesOf(fragment);
    if (!budget) return { value: previous + fragment, bytes: nextBytes };
    const scope = { kind, ...(callId ? { callId } : {}) };
    const reservation = budget.reserveTransient(nextBytes, scope);
    try {
      const value = previous + fragment;
      reservation.commitRetained();
      budget.releaseRetained(previousBytes, scope);
      return { value, bytes: nextBytes };
    } catch (error) {
      reservation.release();
      throw error;
    }
  };
  const replaceBatchRetainedString = (previousBytes: number, next: string, kind: TranslatorBufferKind): number => {
    const nextBytes = bytesOf(next);
    if (!budget) return nextBytes;
    const reservation = budget.reserveTransient(nextBytes, { kind });
    reservation.commitRetained();
    budget.releaseRetained(previousBytes, { kind });
    return nextBytes;
  };
  const pushOutput = (item: OutputItem, replacedBytes = 0, kind: TranslatorBufferKind = "retained_collectors") => {
    const reservation = budget?.reserveTransient(bytesOf(JSON.stringify(item)), { kind });
    output.push(item);
    reservation?.commitRetained();
    if (replacedBytes > 0) budget?.releaseRetained(replacedBytes, { kind });
  };
  let usage: OcxUsage | undefined;
  let errorEvent: Extract<AdapterEvent, { type: "error" }> | undefined;
  let incompleteEvent: Extract<AdapterEvent, { type: "incomplete" }> | undefined;
  let endTurn: boolean | undefined;
  let stopReason: string | undefined;
  // The adapter's stop reason exactly as it arrived. `stopReason` above is deliberately narrowed
  // to the two reasons that map onto a Responses `incomplete_details`; the raw value is what the
  // truncation guard needs, because adapters disagree on vocabulary (`length`, `refusal`, ...).
  let rawStopReason: string | undefined;
  let cleanDone = false;
  // Whether the adapter emitted ANY terminal (done/error/incomplete). Distinct from `cleanDone`,
  // which is only true for a `done` without a stop reason. A buffered turn whose adapter simply
  // stopped emitting has no terminal at all, and must not be reported as a success.
  let sawTerminal = false;
  let compactionText = "";
  let compactionTextBytes = 0;

  let currentText = "";
  let currentTextBytes = 0;
  let currentTextPhase: OcxMessagePhase | undefined;
  let currentSummaryReasoning = "";
  let currentSummaryReasoningBytes = 0;
  let currentRawReasoning = "";
  let currentRawReasoningBytes = 0;
  // Same replay-cache handoff as the streaming path (issue #950): the most
  // recently flushed raw reasoning waits for the tool call it preceded.
  let rawReasoningForNextToolCall = "";
  // Anthropic extended-thinking round-trip (batch): see bridgeToResponsesSSE counterpart.
  let batchSignature: string | undefined;
  let batchSignatureBytes = 0;
  let batchRedacted: string[] = [];
  let batchRedactedBytes = 0;
  // Kiro reasoning blob, held until after the trailing flushes so it lands AFTER the assistant
  // message (see the streaming path). Retained because it outlives releaseTranslatedEvent.
  let batchKiroRedacted: string | undefined;
  let batchKiroRedactedBytes = 0;
  let currentToolCallId = "";
  let currentToolCallName = "";
  let currentToolCallCodeModeHelperName: string | undefined;
  let currentToolCallArgs = "";
  let currentToolCallProviderMetadata: OcxProviderOpaqueToolCallMetadata | undefined;
  let currentToolCallArgsBytes = 0;
  // Web-search citations awaiting the next assistant message (attached as url_citation annotations).
  let pendingWebSources: { url: string; title?: string }[] = [];

  const freeformInput = (
    args: string,
    toolName: string,
    namespace?: string,
    codeModeHelperName?: string,
  ): string => codeModeHelperName
    ? compileCodeModeHelperInput(args, codeModeHelperName)
    : repairFreeformToolInput(args, toolName, namespace);
  const parseArgsObj = (args: string): Record<string, unknown> => {
    try { const o = JSON.parse(args); return o && typeof o === "object" ? o : {}; } catch { return {}; }
  };

  const flushText = (inferredPhase?: OcxMessagePhase) => {
    if (!currentText) return;
    const phase = currentTextPhase ?? inferredPhase;
    const sourceBytes = pendingWebSources.reduce((sum, source) => sum + bytesOf(JSON.stringify(source)), 0);
    const annotations = pendingWebSources.map(s => ({
      type: "url_citation", url: s.url, ...(s.title ? { title: s.title } : {}), start_index: 0, end_index: 0,
    }));
    pendingWebSources = [];
    const item = {
      type: "message", id: `msg_${uuid()}`, role: "assistant", status: "completed",
      content: [{ type: "output_text", text: currentText, annotations }],
      ...(phase ? { phase } : {}),
    } as OutputItem;
    pushOutput(item, currentTextBytes);
    budget?.releaseRetained(sourceBytes, { kind: "tool_search_sources" });
    currentText = "";
    currentTextBytes = 0;
    currentTextPhase = undefined;
  };
  const flushSummaryReasoning = () => {
    if (!currentSummaryReasoning && !batchSignature && batchRedacted.length === 0) return;
    const envelope: ReasoningEnvelope = {};
    if (batchSignature) envelope.sig = batchSignature;
    if (batchRedacted.length > 0) envelope.red = batchRedacted;
    const hidden = options?.hideThinkingSummary === true;
    if (hidden && currentSummaryReasoning && (envelope.sig || envelope.red)) envelope.txt = currentSummaryReasoning;
    const encrypted = envelope.sig || envelope.red || envelope.txt ? encodeReasoningEnvelope(envelope) : undefined;
    const sourceBytes = currentSummaryReasoningBytes + batchSignatureBytes + batchRedactedBytes;
    batchSignature = undefined;
    batchSignatureBytes = 0;
    batchRedacted = [];
    batchRedactedBytes = 0;
    if (hidden && !encrypted) {
      budget?.releaseRetained(sourceBytes, { kind: "reasoning" });
      currentSummaryReasoning = "";
      currentSummaryReasoningBytes = 0;
      return;
    }
    const item = {
      type: "reasoning", id: `rs_${uuid()}`,
      summary: !hidden && currentSummaryReasoning ? [{ type: "summary_text", text: currentSummaryReasoning }] : [],
      ...(encrypted ? { encrypted_content: encrypted } : {}),
    } as OutputItem;
    pushOutput(item, sourceBytes, "reasoning");
    currentSummaryReasoning = "";
    currentSummaryReasoningBytes = 0;
  };
  const flushRawReasoning = () => {
    if (!currentRawReasoning) return;
    rawReasoningForNextToolCall = currentRawReasoning;
    if (options?.hideThinkingSummary === true) {
      // Same contract as the streaming path: no visible reasoning, txt-only envelope round-trip.
      pushOutput({
        type: "reasoning", id: `rs_${uuid()}`, summary: [],
        encrypted_content: encodeReasoningEnvelope({ txt: currentRawReasoning }),
      }, currentRawReasoningBytes, "reasoning");
      currentRawReasoning = "";
      currentRawReasoningBytes = 0;
      return;
    }
    pushOutput({
      type: "reasoning", id: `rs_${uuid()}`,
      summary: [{ type: "summary_text", text: currentRawReasoning }],
    }, currentRawReasoningBytes, "reasoning");
    currentRawReasoning = "";
    currentRawReasoningBytes = 0;
  };
  const flushToolCall = (status: "completed" | "incomplete" = "completed") => {
    if (!currentToolCallId) return;
    const mapped = options?.toolNsMap?.get(currentToolCallName);
    const realName = mapped?.name ?? currentToolCallName;
    const ns = mapped?.namespace;
    const toolSearch = options?.toolSearchToolNames?.has(realName) ?? false;
    const freeform = !toolSearch && (mapped
      ? mapped.freeform === true
      : (options?.freeformToolNames?.has(realName) ?? false));
    // #1611: same integral-float repair as the streaming path. Keyed by the wire name
    // the request declared, which is the pre-namespace-mapping `currentToolCallName`.
    const coercedArgs = coerceIntegerToolArguments(
      currentToolCallArgs,
      options?.toolParameterSchemas?.get(currentToolCallName),
      ns === undefined ? realName : undefined,
    );
    // Freeform tools serialize as custom_tool_call without extra_content; remember the
    // signature server-side regardless so the replayed call can be re-signed (#1735).
    void rememberExtraContentForReplay(currentToolCallId, currentToolCallProviderMetadata, replayCacheScope);
    if (toolSearch) {
      pushOutput({
        type: "tool_search_call", id: `tsc_${uuid()}`,
        call_id: currentToolCallId, execution: "client",
        arguments: parseArgsObj(coercedArgs), status,
      });
    } else if (freeform) {
      pushOutput({
        type: "custom_tool_call", id: `ctc_${uuid()}`,
        call_id: currentToolCallId, name: realName,
        ...(ns ? { namespace: ns } : {}),
        input: freeformInput(currentToolCallArgs, realName, ns, currentToolCallCodeModeHelperName), status,
      });
    } else {
      pushOutput({
        type: "function_call", id: `fc_${uuid()}`,
        call_id: currentToolCallId, name: realName,
        arguments: coercedArgs || "{}", status,
        ...(ns ? { namespace: ns } : {}),
        ...(rememberAndSerializeExtraContent(currentToolCallId, currentToolCallProviderMetadata, replayCacheScope).extra ?? {}),
      });
    }
    budget?.closeCall(currentToolCallId);
    currentToolCallId = "";
    currentToolCallName = "";
    currentToolCallCodeModeHelperName = undefined;
    currentToolCallProviderMetadata = undefined;
    currentToolCallArgs = "";
    currentToolCallArgsBytes = 0;
  };

  for (const e of events) {
    if (errorEvent) {
      // Match streaming: once the turn fails, later parallel calls must not become executable
      // completed output. Still release every retained event in order and preserve terminal usage.
      if (e.type === "error" || e.type === "incomplete" || e.type === "done") {
        usage = e.usage ?? usage;
      }
      if (budget) releaseTranslatedEvent(e, budget);
      continue;
    }
    switch (e.type) {
      case "assistant_boundary":
        flushText("commentary");
        flushSummaryReasoning();
        flushRawReasoning();
        rawReasoningForNextToolCall = "";
        flushToolCall();
        break;
      case "text_delta":
        // Only flush on an explicit phase change. A later delta that omits `phase` must keep
        // appending under the previously established phase.
        if (currentText && e.phase !== undefined && currentTextPhase !== e.phase) flushText("commentary");
        if (currentSummaryReasoning) flushSummaryReasoning();
        if (currentRawReasoning) flushRawReasoning();
        // Empty text deltas (batch chat responses always carry content, often "") must
        // not wipe reasoning that precedes a tool call (#950 non-streaming path).
        if (e.text.length > 0) rawReasoningForNextToolCall = "";
        if (currentToolCallId) flushToolCall();
        // Compaction turns keep the summary out of normal message output (replay dedup — see
        // bridgeToResponsesSSE); it ships only inside the synthetic compaction item below.
        if (options?.compaction) {
          ({ value: compactionText, bytes: compactionTextBytes } = appendBatchString(
            compactionText, compactionTextBytes, e.text, "retained_collectors",
          ));
        }
        else {
          if (e.phase !== undefined) currentTextPhase = e.phase;
          ({ value: currentText, bytes: currentTextBytes } = appendBatchString(
            currentText, currentTextBytes, e.text, "retained_collectors",
          ));
        }
        break;
      case "thinking_delta":
        if (currentText) flushText("commentary");
        if (currentRawReasoning) flushRawReasoning();
        if (e.thinking.length > 0) rawReasoningForNextToolCall = "";
        if (currentToolCallId) flushToolCall();
        {
          ({ value: currentSummaryReasoning, bytes: currentSummaryReasoningBytes } = appendBatchString(
            currentSummaryReasoning, currentSummaryReasoningBytes, e.thinking, "reasoning",
          ));
        }
        break;
      case "thinking_signature":
        // End of the current thinking block — flush it WITH the signature envelope so the
        // block/signature pairing survives multi-block turns.
        batchSignatureBytes = replaceBatchRetainedString(batchSignatureBytes, e.signature, "reasoning");
        batchSignature = e.signature;
        flushSummaryReasoning();
        break;
      case "redacted_thinking":
        {
          const dataBytes = bytesOf(e.data);
          budget?.chargeRetained(dataBytes, { kind: "reasoning" });
          batchRedactedBytes += dataBytes;
        }
        batchRedacted.push(e.data);
        break;
      case "kiro_redacted_reasoning":
        // Stash only — pushed after the trailing flushes. One blob per turn, so last wins.
        {
          const dataBytes = bytesOf(e.data);
          budget?.chargeRetained(dataBytes, { kind: "reasoning" });
          if (batchKiroRedactedBytes > 0) budget?.releaseRetained(batchKiroRedactedBytes, { kind: "reasoning" });
          batchKiroRedactedBytes = dataBytes;
        }
        batchKiroRedacted = e.data;
        break;
      case "reasoning_raw_delta":
        if (currentText) flushText("commentary");
        if (currentSummaryReasoning) flushSummaryReasoning();
        if (currentToolCallId) flushToolCall();
        {
          ({ value: currentRawReasoning, bytes: currentRawReasoningBytes } = appendBatchString(
            currentRawReasoning, currentRawReasoningBytes, e.text, "reasoning",
          ));
        }
        break;
      case "tool_call_start": {
        if (currentText) flushText("commentary");
        if (currentSummaryReasoning) flushSummaryReasoning();
        if (currentRawReasoning) flushRawReasoning();
        if (rawReasoningForNextToolCall) {
          rememberReasoningForCall(e.id, rawReasoningForNextToolCall, replayCacheScope);
        }
        flushToolCall();
        const effectiveName = normalizeDeclaredToolName(e.name, options?.declaredToolNames);
        if (options?.declaredToolNames && !options.declaredToolNames.has(effectiveName)) {
          errorEvent = {
            type: "error",
            message: `routed provider emitted undeclared client tool "${effectiveName}"; only request-declared tools may be called`,
            status: 502,
            errorType: "upstream_error",
          };
          break;
        }
        currentToolCallId = e.id;
        budget?.openCall(e.id);
        currentToolCallName = effectiveName;
        currentToolCallCodeModeHelperName = effectiveName === "exec" && e.name !== effectiveName
          ? e.name
          : undefined;
        currentToolCallArgs = "";
        currentToolCallArgsBytes = 0;
        currentToolCallProviderMetadata = e.providerMetadata;
        break;
      }
      case "tool_call_delta":
        {
          ({ value: currentToolCallArgs, bytes: currentToolCallArgsBytes } = appendBatchString(
            currentToolCallArgs, currentToolCallArgsBytes, e.arguments, "tool_args", currentToolCallId,
          ));
        }
        break;
      case "tool_call_end":
        if (!toolCallArgumentsUsable(currentToolCallArgs) && currentToolCallId) {
          // Mirror the streaming path: refuse to complete unusable arguments.
          const mapped = options?.toolNsMap?.get(currentToolCallName);
          const realName = mapped?.name ?? currentToolCallName;
          const toolSearch = options?.toolSearchToolNames?.has(realName) ?? false;
          const freeform = !toolSearch && (mapped
            ? mapped.freeform === true
            : (options?.freeformToolNames?.has(realName) ?? false));
          if (!freeform && !toolSearch) {
            flushToolCall("incomplete");
            errorEvent = {
              type: "error",
              message: "upstream stream produced malformed tool call arguments",
              status: 502,
              errorType: "upstream_error",
            };
            break;
          }
        }
        flushToolCall();
        break;
      case "web_search_call_begin":
        // Batch/non-streaming output has no in_progress phase to animate — the search cell is a
        // single finalized item, emitted on `end`. Begin is a no-op here.
        break;
      case "web_search_call_end": {
        if (currentText) flushText("commentary");
        if (currentSummaryReasoning) flushSummaryReasoning();
        if (currentRawReasoning) flushRawReasoning();
        flushToolCall();
        const safeSources = safeWebSearchSources(e.sources);
        pushOutput({
          type: "web_search_call", id: `ws_${uuid()}`, status: e.status ?? "completed",
          action: webSearchAction(e.queries),
          ...(safeSources.length > 0 ? { sources: safeSources } : {}),
        });
        if (safeSources.length > 0) {
          for (const source of safeSources) {
            if (appendSafeWebSearchSource(pendingWebSources, source)) {
              budget?.chargeRetained(bytesOf(JSON.stringify(source)), { kind: "tool_search_sources" });
            }
          }
        }
        break;
      }
      case "error":
        errorEvent = e;
        sawTerminal = true;
        usage = e.usage ?? usage;
        break;
      case "incomplete":
        incompleteEvent = e;
        sawTerminal = true;
        endTurn = e.endTurn;
        if (e.providerState) options?.onProviderState?.(e.providerState);
        break;
      case "done":
        usage = e.usage;
        sawTerminal = true;
        endTurn = e.endTurn;
        cleanDone = e.stopReason === undefined;
        rawStopReason = e.stopReason;
        if (e.providerState) options?.onProviderState?.(e.providerState);
        // Match streaming: max_tokens and content_filter both terminate as incomplete.
        // Normalize every adapter's truncation vocabulary to the canonical pair, so a raw
        // `length` or `refusal` reaches the status/incomplete_details logic below instead of
        // silently reading as a clean stop.
        {
          const truncation = truncationReasonFor(e.stopReason);
          if (truncation) stopReason = truncation === "max_output_tokens" ? "max_tokens" : "content_filter";
        }
        break;
    }
    if (budget) releaseTranslatedEvent(e, budget);
  }
  flushText(cleanDone && !errorEvent && !incompleteEvent ? "final_answer" : undefined);
  if (pendingWebSources.length > 0) {
    const sourceBytes = pendingWebSources.reduce((sum, source) => sum + bytesOf(JSON.stringify(source)), 0);
    pendingWebSources = [];
    budget?.releaseRetained(sourceBytes, { kind: "tool_search_sources" });
  }
  flushSummaryReasoning();
  flushRawReasoning();
  // Open tool call on a failed/incomplete turn must not land as status:"completed" — and neither
  // must one left open by a stream that stopped without any terminal at all. That case previously
  // fell through to "completed", handing back a function_call whose arguments were half-written
  // JSON, inside a turn also marked completed.
  if (currentToolCallId) flushToolCall(errorEvent || incompleteEvent || !sawTerminal ? "incomplete" : "completed");
  if (batchKiroRedacted) {
    // pushOutput reserves the item itself and releases the retained raw blob it replaces.
    pushOutput({
      type: "reasoning", id: `rs_${uuid()}`, summary: [],
      encrypted_content: encodeReasoningEnvelope({ krc: batchKiroRedacted }),
    }, batchKiroRedactedBytes, "reasoning");
    batchKiroRedacted = undefined;
    batchKiroRedactedBytes = 0;
  }
  // A truncated turn must never be installed as replacement history: emit the
  // compaction item only when the turn actually completed (#422).
  if (
    options?.compaction
    && !errorEvent
    && !incompleteEvent
    // A stream that stopped without any terminal did not complete either. The original guard
    // could only see explicit failure events, so an adapter EOF slipped past it and installed a
    // truncated summary as replacement history — the exact #422 hazard, reached by a route that
    // did not exist when the guard was written.
    && sawTerminal
    && !isTruncatedStopReason(rawStopReason)
  ) {
    pushOutput({ type: "compaction", id: `cmp_${uuid()}`, encrypted_content: encodeCompactionSummary(compactionText) }, compactionTextBytes);
  }

  const failure = errorEvent ? adapterFailureFromEvent(errorEvent) : undefined;
  const status = errorEvent
    ? "failed"
    : incompleteEvent || stopReason === "max_tokens" || stopReason === "content_filter"
      ? "incomplete"
      : sawTerminal
        ? "completed"
        // The adapter stopped emitting without any terminal, so the turn was cut short. Streaming
        // already reports this as response.incomplete / adapter_eof (see the !terminated branch);
        // defaulting the buffered path to "completed" handed callers a truncated turn — including
        // one carrying a never-closed tool call with half-written JSON arguments — as a success.
        : "incomplete";
  options?.onUsage?.(incompleteEvent?.usage ?? usage);
  return {
    id: responseId, object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status,
    model: modelId, output,
    ...(endTurn !== undefined ? { end_turn: endTurn } : {}),
    ...(failure ? { error: failure.error, last_error: failure.error } : {}),
    ...(failure && isCyberPolicyCode(failure.error.code)
      ? { retryable: false }
      : errorEvent?.retryable !== undefined ? { retryable: errorEvent.retryable } : {}),
    ...(incompleteEvent ? {
      incomplete_details: {
        reason: incompleteEvent.reason,
        ...(incompleteEvent.message ? { message: incompleteEvent.message } : {}),
        ...(incompleteEvent.retryable !== undefined ? { retryable: incompleteEvent.retryable } : {}),
      },
    } : stopReason === "max_tokens" ? {
      incomplete_details: { reason: "max_output_tokens" },
    } : stopReason === "content_filter" ? {
      incomplete_details: { reason: "content_filter" },
    } : !sawTerminal ? {
      // Same reason string the streaming path uses, so a caller sees one signal for one condition
      // regardless of which surface it asked for.
      incomplete_details: { reason: "adapter_eof" },
    } : {}),
    usage: responsesUsage(incompleteEvent?.usage ?? usage),
  };
}

export function formatErrorResponse(
  status: number,
  type: string,
  message: string,
  options?: { code?: string | null; retryAfter?: string | null },
): Response {
  const error = classifyError(status, type, message);
  if (isCyberPolicyCode(options?.code)) {
    error.code = CYBER_POLICY_ERROR_CODE;
    error.type = cyberPolicyErrorType(type);
  }
  const finalStatus = error.code === CYBER_POLICY_ERROR_CODE ? 400 : status;
  const headers = new Headers({ "Content-Type": "application/json" });
  const retryAfter = options?.retryAfter?.trim();
  if (error.code !== CYBER_POLICY_ERROR_CODE
    && retryAfter
    && retryAfter.length > 0
    && retryAfter.length <= 128) {
    headers.set("Retry-After", retryAfter);
  }
  return new Response(JSON.stringify({ error }), {
    status: finalStatus,
    headers,
  });
}
