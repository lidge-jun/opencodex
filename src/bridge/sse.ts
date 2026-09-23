import type {
  AdapterEvent,
  OcxMessagePhase,
  OcxProviderContinuationState,
  OcxProviderOpaqueToolCallMetadata,
  OcxReasoningReplayScopeRef,
  OcxUsage,
} from "../types";
import { coerceIntegerToolArguments } from "../lib/tool-argument-integers";
import {
  adapterFailureFromMessage,
  classifyError,
  cyberPolicyErrorType,
  CYBER_POLICY_ERROR_CODE,
  isCyberPolicyCode,
  type OcxErrorPayload,
} from "../lib/errors";
import { redactSecretString } from "../lib/redact";
import { attemptDeliveryRecorder, classifyRelayedResponseEvent } from "../usage/attempt-delivery";
import {
  mayBecomePatchEnvelope,
  repairFreeformToolInput,
} from "../responses/apply-patch-envelope";
import { progressiveFreeformInput } from "../responses/progressive-freeform-input";
import { encodeCompactionSummary } from "../responses/compaction";
import { compileCodeModeHelperInput, resolveCodeModeHelperName } from "../responses/code-mode-helper-compat";
import { mayBecomeCodeModeShellInput } from "../responses/code-mode-shell-input";
import { isTruncatedStopReason, truncationReasonFor } from "../responses/truncated-stop-reason";
import { encodeReasoningEnvelope, type ReasoningEnvelope } from "../responses/reasoning-envelope";
import { rememberReasoningForCall } from "../responses/reasoning-replay-cache";
import {
  rememberAndSerializeExtraContent,
  rememberExtraContentForReplay,
  awaitThoughtSignatureDurability,
} from "../responses/thought-signature-replay";
import { resolveStallTimeoutSec } from "../stall-timeout";
import {
  createCitationMarkerFilter,
  stripCitationMarkers,
  type CitationMarkerFilter,
} from "../responses/citation-markers";
import { declaresCodeModeExec, normalizeDeclaredToolName } from "../types";
import { appendSafeWebSearchSource, safeWebSearchSources } from "../web-search/sources";
import {
  isTranslatorBudgetExceededError,
  releaseTranslatedEvent,
  createTranslatorBudget,
  type TranslatorBudget,
  type TranslatorBufferKind,
} from "../lib/translator-budget";
import { adapterFailureFromEvent, emptyChunks, joinChunks, ownedBudgetAbandonedMs, responsesUsage, toolCallArgumentsCouldBeJson, toolCallArgumentsUsable, uuid, webSearchAction } from "./internal";
import type { OutputItem, StringChunks } from "./internal";

function sseEvent(name: string, data: Record<string, unknown>): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

function responseError(status: number, type: string, message: string): OcxErrorPayload {
  return classifyError(status, type, message);
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
    /**
     * Whether `declaredToolNames` is an authorization boundary this proxy enforces, or only the
     * catalog used to normalize provider-invented names back to declared ones.
     *
     * Defaults to enforcing. The chat and Anthropic inbound wires set it false: those specs make
     * the server relay a tool call and leave execution or refusal to the client's own runner, and
     * harnesses on them legitimately defer part of their catalog (#4735).
     *
     * It is a separate flag rather than simply withholding `declaredToolNames`, because the set
     * also drives `normalizeDeclaredToolName` and `declaresCodeModeExec`. Passing `undefined`
     * turns those off too, so a provider that invents `default.lookup` for a declared `lookup`
     * would reach the client under the invented name instead of the normalized one.
     */
    enforceDeclaredToolNames?: boolean;
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
  ): string => {
    const helper = resolveCodeModeHelperName(codeModeHelperName, toolName, args, namespace, options?.declaredToolNames);
    return helper
      ? compileCodeModeHelperInput(args, helper, codeModeHelperName ?? toolName)
      : repairFreeformToolInput(args, toolName, namespace);
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
  // Resolved from the CALLER's budget only. A bridge that owns its budget is not serving a
  // logged request -- there is no attempt to count against, and a locally created scope would
  // never have had a recorder bound to it.
  const delivery = attemptDeliveryRecorder(options?.translatorBudget);
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
    previous: StringChunks,
    fragment: string,
    kind: TranslatorBufferKind,
    callId?: string,
  ): StringChunks => {
    const fragmentBytes = bytesOf(fragment);
    if (fragmentBytes === 0) return previous;
    const nextBytes = previous.bytes + fragmentBytes;
    const scope = { kind, ...(callId ? { callId } : {}) };
    const reservation = budget.reserveTransient(nextBytes, scope);
    try {
      previous.chunks.push(fragment);
      const result: StringChunks = { chunks: previous.chunks, bytes: nextBytes };
      reservation.commitRetained();
      budget.releaseRetained(previous.bytes, scope);
      return result;
    } catch (error) {
      reservation.release();
      throw error;
    }
  };
  // Tool-call arguments deliberately use plain string concatenation because
  // downstream parsers and intermediate inspectors perform incremental JSON reads mid-stream.
  // Converting tool args to StringChunks would require frequent join operations.
  const appendStringDirect = (
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
          // After a SUCCESSFUL enqueue, never before it. A frame that threw on the way to the
          // transport did not reach the caller, and counting it here would make the relayed
          // total equal the adapter total by construction -- erasing the one discrepancy these
          // counters exist to expose (#3983).
          delivery?.noteRelayedEvent(classifyRelayedResponseEvent(name, data));
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

      let currentMsg: {
        itemId: string;
        outputIndex: number;
        text: StringChunks;
        citationFilter: CitationMarkerFilter;
        phase?: OcxMessagePhase;
      } | null = null;
      let currentReasoning: { itemId: string; outputIndex: number; text: StringChunks } | null = null;
      let currentRawReasoning: { itemId: string; outputIndex: number; text: StringChunks } | null = null;
      // Anthropic extended-thinking round-trip state: the signature signs the CURRENT thinking
      // block; redacted blocks are opaque payloads replayed verbatim. Attached to the reasoning
      // item as an ocxr1 encrypted_content envelope on close. hiddenThinkingText collects the
      // suppressed text under hideThinkingSummary so the signed text still round-trips.
      let pendingSignature: string | undefined;
      let pendingSignatureBytes = 0;
      let pendingRedacted: string[] = [];
      let hiddenThinking = emptyChunks();
      const takeReasoningEnvelope = (hiddenText?: string): string | undefined => {
        if (!pendingSignature && pendingRedacted.length === 0) return undefined;
        const envelope: ReasoningEnvelope = {};
        if (pendingSignature) envelope.sig = pendingSignature;
        if (pendingRedacted.length > 0) envelope.red = pendingRedacted;
        if (hiddenText) envelope.txt = hiddenText;
        const previousBytes = pendingSignatureBytes
          + pendingRedacted.reduce((sum, value) => sum + bytesOf(value), 0)
          + (hiddenText ? hiddenThinking.bytes : 0);
        const encoded = encodeReasoningEnvelope(envelope, budget);
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
        const hiddenText = joinChunks(hiddenThinking);
        const encrypted = takeReasoningEnvelope(hiddenText || undefined);
        hiddenThinking = emptyChunks();
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
      let hiddenRawReasoning = emptyChunks();
      // Raw reasoning text flushed most recently, waiting for the tool call it
      // preceded. Recorded into the replay cache on tool_call_start so a later
      // continuation can re-attach it when history lost the reasoning item
      // (issue #950). Kept until new reasoning/text arrives: parallel tool
      // calls share the same preceding reasoning block.
      let rawReasoningForNextToolCall = "";
      const flushHiddenRawReasoning = () => {
        const hiddenRawText = joinChunks(hiddenRawReasoning);
        if (!hiddenRawText) return;
        rawReasoningForNextToolCall = hiddenRawText;
        const previousBytes = hiddenRawReasoning.bytes;
        const encrypted = encodeReasoningEnvelope({ txt: hiddenRawText }, budget);
        const reservation = budget?.reserveTransient(bytesOf(encrypted), { kind: "reasoning" });
        hiddenRawReasoning = emptyChunks();
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
        const encrypted = encodeReasoningEnvelope({ krc: pendingKiroRedacted }, budget);
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
      let compaction = emptyChunks();
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
        // Release anything the citation filter was holding for this message, then strip the
        // accumulated text: closeCurrentMessage re-sends it in output_text.done and
        // output_item.done, so filtering only the deltas would leave the markers in both.
        const trailing = currentMsg.citationFilter.flush();
        if (trailing) {
          emit("response.output_text.delta", {
            item_id: currentMsg.itemId, output_index: currentMsg.outputIndex,
            content_index: 0, delta: trailing,
          });
        }
        const messageText = stripCitationMarkers(joinChunks(currentMsg.text));
        // Chat Completions has no message-phase field. Keep its live item provisional, then
        // classify it only when the next adapter event proves whether this text led into more
        // work or completed the turn. Explicit adapter phases always outrank this inference.
        const phase = currentMsg.phase ?? inferredPhase;
        // Bind any pending web-search citations to this assistant message (then they clear).
        const annotations = takeWebAnnotations();
        // Finalize the text part (Responses protocol). Without these .done events Codex never
        // commits the content part and renders the message as truncated / cut off.
        emit("response.output_text.done", {
          item_id: currentMsg.itemId, output_index: currentMsg.outputIndex, content_index: 0, text: messageText,
        });
        emit("response.content_part.done", {
          item_id: currentMsg.itemId, output_index: currentMsg.outputIndex, content_index: 0,
          part: { type: "output_text", text: messageText, annotations },
        });
        const item = {
          type: "message", id: currentMsg.itemId, status: "completed", role: "assistant",
          content: [{ type: "output_text", text: messageText, annotations }],
          ...(phase ? { phase } : {}),
        };
        emit("response.output_item.done", { output_index: currentMsg.outputIndex, item });
        retainFinishedItem(item as OutputItem, currentMsg.text.bytes + bytesOf(JSON.stringify(annotations)));
        outputIndex++;
        currentMsg = null;
      };

      const closeCurrentReasoning = () => {
        if (!currentReasoning) return;
        const reasoningText = joinChunks(currentReasoning.text);
        emit("response.reasoning_summary_text.done", {
          item_id: currentReasoning.itemId, output_index: currentReasoning.outputIndex, summary_index: 0, text: reasoningText,
        });
        emit("response.reasoning_summary_part.done", {
          item_id: currentReasoning.itemId, output_index: currentReasoning.outputIndex, summary_index: 0,
          part: { type: "summary_text", text: reasoningText },
        });
        const encrypted = takeReasoningEnvelope();
        const item = {
          type: "reasoning", id: currentReasoning.itemId,
          summary: [{ type: "summary_text", text: reasoningText }],
          ...(encrypted ? { encrypted_content: encrypted } : {}),
        };
        emit("response.output_item.done", { output_index: currentReasoning.outputIndex, item });
        retainFinishedItem(item as OutputItem, currentReasoning.text.bytes + bytesOf(encrypted ?? ""), "reasoning");
        outputIndex++;
        currentReasoning = null;
      };

      const closeCurrentRawReasoning = () => {
        if (!currentRawReasoning) return;
        const rawText = joinChunks(currentRawReasoning.text);
        rawReasoningForNextToolCall = rawText;
        emit("response.reasoning_text.done", {
          item_id: currentRawReasoning.itemId, output_index: currentRawReasoning.outputIndex, content_index: 0, text: rawText,
        });
        const item = {
          type: "reasoning", id: currentRawReasoning.itemId,
          summary: [] as never[],
          content: [{ type: "reasoning_text", text: rawText }],
        };
        emit("response.output_item.done", { output_index: currentRawReasoning.outputIndex, item });
        retainFinishedItem(item as OutputItem, currentRawReasoning.text.bytes, "reasoning");
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
      const attemptTerminationCleanup = (action: () => void): boolean => {
        try {
          action();
          return !terminated && !closed;
        } catch (error) {
          if (!isTranslatorBudgetExceededError(error)) throw error;
          terminateForTranslatorOverflow(error);
          return false;
        }
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
              compaction = appendString(
                compaction,
                event.text,
                "retained_collectors",
              );
              continue;
            }
            if (event.type !== "done" && event.type !== "incomplete" && event.type !== "error") continue;
          }
          // Anthropic signature_delta supplies the latest signature, not an append-only
          // fragment (anthropic-sdk-typescript MessageStream). Keep consecutive updates
          // together; the next semantic event belongs to the following block.
          if (pendingSignature !== undefined && event.type !== "thinking_signature" && event.type !== "heartbeat") {
            if (currentReasoning) closeCurrentReasoning();
            else flushHiddenReasoningEnvelope();
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
                currentMsg = {
                  itemId, outputIndex, text: emptyChunks(),
                  citationFilter: createCitationMarkerFilter(),
                  ...(event.phase ? { phase: event.phase } : {}),
                };
              }
              currentMsg.text = appendString(
                currentMsg.text,
                event.text,
                "retained_collectors",
              );
              // A citation span can straddle a delta boundary, so the filter withholds an
              // unterminated tail and releases it at close (#3150). The accumulator above
              // keeps the raw text; it is stripped once in closeCurrentMessage.
              const visible = currentMsg.citationFilter.push(event.text);
              if (visible) {
                emit("response.output_text.delta", {
                  item_id: currentMsg.itemId, output_index: currentMsg.outputIndex,
                  content_index: 0, delta: visible,
                });
              }
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
                hiddenThinking = appendString(
                  hiddenThinking,
                  event.thinking,
                  "reasoning",
                );
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
                currentReasoning = { itemId, outputIndex, text: emptyChunks() };
              }
              currentReasoning.text = appendString(
                currentReasoning.text,
                event.thinking,
                "reasoning",
              );
              emit("response.reasoning_summary_text.delta", {
                item_id: currentReasoning.itemId, output_index: currentReasoning.outputIndex,
                summary_index: 0, delta: event.thinking,
              });
              break;
            }
            case "thinking_signature": {
              pendingSignatureBytes = replaceRetainedString(pendingSignatureBytes, event.signature, "reasoning");
              pendingSignature = event.signature;
              // Delay closing until the next semantic event so a signature update cannot
              // create another block or become attached to the following thinking text.
              break;
            }
            case "redacted_thinking": {
              if (currentMsg) closeCurrentMessage("commentary");
              if (currentReasoning) closeCurrentReasoning();
              if (currentRawReasoning) closeCurrentRawReasoning();
              flushHiddenRawReasoning();
              if (currentToolCall) closeCurrentToolCall();
              budget?.chargeRetained(bytesOf(event.data), { kind: "reasoning" });
              pendingRedacted.push(event.data);
              // A redacted block is complete at content_block_start. Emit it here,
              // not with a later thinking block or after a tool call at turn end.
              flushHiddenReasoningEnvelope();
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
                hiddenRawReasoning = appendString(
                  hiddenRawReasoning,
                  event.text,
                  "reasoning",
                );
                break;
              }
              if (currentMsg) closeCurrentMessage("commentary");
              if (currentReasoning) closeCurrentReasoning();
              if (currentToolCall) closeCurrentToolCall();
              if (!currentRawReasoning) {
                const itemId = `rs_${uuid()}`;
                const item = { type: "reasoning", id: itemId, summary: [] as { type: string; text: string }[] };
                emit("response.output_item.added", { output_index: outputIndex, item });
                currentRawReasoning = { itemId, outputIndex, text: emptyChunks() };
              }
              currentRawReasoning.text = appendString(
                currentRawReasoning.text,
                event.text,
                "reasoning",
              );
              // Raw reasoning (openai-chat reasoning_content, kiro tags) rides the CONTENT
              // channel. Clients control raw-reasoning display; this text is not a
              // provider-authored summary.
              emit("response.reasoning_text.delta", {
                item_id: currentRawReasoning.itemId, output_index: currentRawReasoning.outputIndex,
                content_index: 0, delta: event.text,
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
              if (
                options?.declaredToolNames
                && options.enforceDeclaredToolNames !== false
                && !options.declaredToolNames.has(effectiveName)
              ) {
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
                ({ value: currentToolCall.args, bytes: currentToolCall.argsBytes } = appendStringDirect(
                  currentToolCall.args,
                  currentToolCall.argsBytes,
                  event.arguments,
                  "tool_args",
                  currentToolCall.callId,
                ));
                if (!currentToolCall.freeform && !currentToolCall.toolSearch) {
                  // Hold fragments whose accumulated buffer can never parse as JSON. Fragments
                  // already streamed are retained by the client as history even when the item
                  // fails at completion (the poisoned-replay loop behind inbound "non-JSON
                  // arguments" warnings); holding costs nothing for healthy streams because the
                  // completed item still carries the full arguments.
                  if (toolCallArgumentsCouldBeJson(currentToolCall.args)) {
                    emit("response.function_call_arguments.delta", {
                      item_id: currentToolCall.itemId, output_index: currentToolCall.outputIndex,
                      delta: event.arguments,
                    });
                  }
                }
                if (currentToolCall.freeform && !currentToolCall.codeModeHelperName) {
                  // `progressiveFreeformInput` holds while the buffer is still an ambiguous prefix
                  // of a JSON wrapper; otherwise stream only the unwrapped input suffix, never
                  // rewinding on a mode flip.
                  //
                  // The name is dropped for a namespaced tool that does not own the apply-patch
                  // grammar, because `repairFreeformToolInput` drops it at completion for the
                  // same reason. Streaming under a vocabulary the completed item does not use
                  // is the same disagreement in the other direction.
                  const ownsFreeformGrammar = currentToolCall.namespace === undefined
                    || currentToolCall.namespace === "functions";
                  const full = progressiveFreeformInput(
                    currentToolCall.args,
                    ownsFreeformGrammar ? currentToolCall.name : "",
                  );
                  if (full !== null) {
                    const emitted = currentToolCall.inputEmitted ?? "";
                    // Also hold a buffer that could still become a complete patch envelope:
                    // at completion such a body is recompiled into an apply_patch helper call,
                    // and streaming the envelope bytes first would be that same rewind.
                    const mayCompile = declaresCodeModeExec(options?.declaredToolNames)
                      && !currentToolCall.namespace
                      && currentToolCall.name === "exec";
                    // `apply_patch` holds for a different reason with the same shape:
                    // `normalizeApplyPatchDelimiters` rewrites a decorated `*** Begin Patch ***`
                    // envelope at completion, so streaming the decorated markers would be
                    // replaced by the normalized ones.
                    const mayNormalize = ownsFreeformGrammar && currentToolCall.name === "apply_patch";
                    if (!((mayCompile || mayNormalize) && mayBecomePatchEnvelope(full))
                      && !(mayCompile && mayBecomeCodeModeShellInput(currentToolCall.args, full))
                      && full.startsWith(emitted) && full.length > emitted.length) {
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
              if (currentMsg) closeCurrentMessage(isTruncatedStopReason(event.stopReason) ? undefined : "final_answer");
              if (currentReasoning) closeCurrentReasoning();
              if (currentRawReasoning) closeCurrentRawReasoning();
              flushHiddenRawReasoning();
              if (currentToolCall) {
                if (isTruncatedStopReason(event.stopReason)) failCurrentToolCall();
                else closeCurrentToolCall();
              }
              // A search still in flight when upstream truncates never returned results, so it
              // takes the same "failed" status as the error/incomplete terminals below.
              if (currentWebSearch) closeCurrentWebSearch(isTruncatedStopReason(event.stopReason) ? "failed" : "completed", []);
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
                  encrypted_content: event.compactionEncryptedContent ?? encodeCompactionSummary(joinChunks(compaction)),
                };
                emit("response.output_item.done", { output_index: outputIndex, item });
                retainFinishedItem(item as OutputItem, event.compactionEncryptedContent
                  ? bytesOf(event.compactionEncryptedContent)
                  : compaction.bytes);
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
          if (!attemptTerminationCleanup(() => {
            flushHiddenRawReasoning();
            if (currentToolCall) failCurrentToolCall();
            if (currentWebSearch) closeCurrentWebSearch("failed", []);
            releasePendingWebSources();
          })) return;
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
        if (!attemptTerminationCleanup(() => {
          if (currentMsg) closeCurrentMessage();
          if (currentReasoning) closeCurrentReasoning();
          if (currentRawReasoning) closeCurrentRawReasoning();
          flushHiddenRawReasoning();
          if (currentToolCall) failCurrentToolCall();
          if (currentWebSearch) closeCurrentWebSearch("failed", []);
          releasePendingWebSources();
        })) return;
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
            if (!attemptTerminationCleanup(() => {
              if (currentMsg) closeCurrentMessage();
              if (currentReasoning) closeCurrentReasoning();
              if (currentRawReasoning) closeCurrentRawReasoning();
              flushHiddenRawReasoning();
              if (currentToolCall) failCurrentToolCall();
              if (currentWebSearch) closeCurrentWebSearch("failed", []);
              releasePendingWebSources();
            })) return;
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
