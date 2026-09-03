import type { KiroOAuthMetadata } from "../oauth/types";
import type { OcxTool, OcxToolChoice } from "./tools";
import type { TierDecision, TierObservationContext } from "./provider";

/** Exact provider/credential namespace for process-local reasoning replay. */
export interface OcxReasoningReplayIdentity {
  providerName: string;
  /** Opaque process-local digest of the exact upstream destination. */
  providerDestinationIdentity: string;
  /**
   * The same destination, digested WITHOUT the process-local random key, so it can key a
   * durable store. Absent when no base URL was resolvable.
   */
  providerDestinationDurableIdentity?: string;
  adapterName: string;
  modelId: string;
  /** Opaque process-local credential identity; never a raw token or API key. */
  credentialIdentity: string;
  /**
   * Salted-HMAC credential identity that survives restarts, for the durable
   * thought-signature store (#1926). Absent when no durable identity could be
   * derived — the durable store then refuses to key the entry (fail closed).
   */
  credentialDurableIdentity?: string;
}

/**
 * Stable holder shared by parsed-request copies and already-created bridges.
 * Credential/provider rotation replaces `current` atomically without replacing
 * the holder, so late tool-call cache writes see the active physical identity.
 */
export interface OcxReasoningReplayScopeRef {
  /**
   * Conversation namespace for replay state. Historically this was always the Codex parent-thread
   * id; headerless Responses callers use a raw sanitized thread/Cursor/session fallback, never the
   * hashed request-log conversation id.
   */
  readonly clientThreadId: string;
  current?: Readonly<OcxReasoningReplayIdentity>;
}

export interface OcxParsedRequest {
  modelId: string;
  /** Client-facing model selector retained for Anthropic routes after wire-model normalization. */
  _responseModelId?: string;
  /** Selected OpenAI API virtual-model id retained after it rewrites the upstream wire model. */
  _openAiVirtualSelectedModelId?: string;
  previousResponseId?: string;
  context: OcxContext;
  stream: boolean;
  options: OcxRequestOptions;
  _rawBody?: unknown;
  /**
   * Boundary between replayed history and this turn's newly appended input. Usually the
   * items the proxy restored from local previous_response_id state; also set when the
   * CLIENT already carried that history verbatim and the proxy skipped the prepend.
   */
  _replayPrefixLen?: number;
  /** Parsed-message index before the first conversational item in a continuation's current delta. */
  _continuationConversationMessageIndex?: number;
  /**
   * True when the full history for a previous_response_id request is present in the input —
   * whether the proxy expanded it or the client already sent it. Consumers read this as
   * "this request is self-contained", never as "the proxy mutated it".
   */
  _previousResponseInputExpanded?: boolean;
  /** Provider-private stable Cursor conversation id resolved from the Responses previous_response_id chain. */
  _cursorConversationId?: string;
  /** Stable upstream client thread identity, used only to derive provider-scoped continuation ids. */
  _clientThreadId?: string;
  /** Cursor-only thread owner; may be an opaque process-local Desktop session/thread identity. */
  _cursorClientThreadId?: string;
  /** Conversation/provider/account/model-bound namespace for reasoning replay state. */
  _reasoningReplayScope?: OcxReasoningReplayScopeRef;
  /**
   * Set by bindRouteReasoningReplayScope after a proven serving-identity change, or by
   * prepareOpaqueBlobRecovery after an authoritative rejection; consumers strip replayed blobs.
   */
  _stripReasoningEncryptedContent?: boolean;
  /**
   * Optional authenticated tenant/operator namespace for Cursor thread→conversation derivation.
   * When absent (single-operator local proxy), derivation stays local-scoped.
   */
  _cursorIdentityScope?: string;
  /**
   * True for helper/shadow/compaction turns that must not append into the main Cursor conversation
   * derived from the parent thread id.
   */
  _cursorIsolateConversation?: boolean;
  /** Account-scoped, non-secret Kiro request metadata selected with the OAuth access token. */
  _kiroAuthContext?: Pick<KiroOAuthMetadata, "profileArn" | "apiRegion" | "ssoRegion" | "authType">;
  /** Provider-private continuation metadata resolved from the Responses previous_response_id chain. */
  _providerContinuation?: OcxProviderContinuationState;
  /** Persisted continuation considered only after the final physical route is known. */
  _providerContinuationCandidate?: OcxProviderContinuationState;
  /** Exact process-local route owner attached to newly persisted provider state. */
  _providerContinuationOwner?: OcxProviderContinuationOwner;
  /**
   * The hosted `{type:"web_search", ...}` tool config, stashed when Codex enables web search. Routed
   * (non-OpenAI) providers can't run it server-side, so the proxy re-exposes it as a function tool and
   * executes searches via the gpt-5.4-mini sidecar (see src/web-search). Absent when not requested.
   */
  _webSearch?: Record<string, unknown>;
  /** Hosted image_generation tool config stashed for the image bridge sidecar (see src/images). */
  _imageGeneration?: { toolNames: Set<string>; originalTool?: Record<string, unknown> };
  /**
   * True when Codex requested structured output (`text.format` = json_schema/json_object). The
   * web-search tool_result is then rendered as compact JSON instead of markdown prose, so its
   * answer/"Sources:" text can't bleed into and corrupt the model's schema-constrained output.
   */
  _structuredOutput?: boolean;
  /**
   * True when the input carried `{type:"compaction_trigger"}` — Codex remote compaction v2 asking
   * this turn to produce a `{type:"compaction"}` output item. Routed adapters can't natively;
   * the server runs the model as a summarizer and the bridge emits a synthetic compaction item
   * (see src/responses/compaction.ts).
   */
  _compactionRequest?: boolean;
  /**
   * True when the current request newly introduced a stored compaction summary/marker. Historical
   * markers restored by previous_response_id expansion were already acknowledged and do not reset
   * provider-private continuation caches again on every later turn.
   */
  _contextCompactionBoundary?: boolean;
}

export interface OcxContext {
  systemPrompt?: string[];
  messages: OcxMessage[];
  tools?: OcxTool[];
}

export type OcxMessage =
  | OcxUserMessage
  | OcxAssistantMessage
  | OcxDeveloperMessage
  | OcxToolResultMessage;

export interface OcxUserMessage {
  role: "user";
  content: string | OcxContentPart[];
  timestamp: number;
}

export interface OcxAssistantMessage {
  role: "assistant";
  content: OcxAssistantContentPart[];
  /** Responses message phase, preserved when replaying translated provider output. */
  phase?: OcxMessagePhase;
  model?: string;
  timestamp: number;
  /**
   * Kiro `reasoningContent.redactedContent` for THIS assistant turn — an opaque encrypted blob
   * Kiro replays to preserve model reasoning across turns. Provider-specific and unrenderable, so
   * it rides the message rather than a content part: any other adapter simply ignores it.
   */
  kiroRedactedReasoning?: string;
}

export interface OcxDeveloperMessage {
  role: "developer";
  content: string | OcxContentPart[];
  timestamp: number;
}

export interface OcxToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  /** MCP namespace from the originating tool call, if any. */
  toolNamespace?: string;
  /** Text, or content parts when a tool (e.g. Codex view_image) returns an image in its output. */
  content: string | OcxContentPart[];
  /** True when the Responses result contained opaque encrypted output Kiro cannot translate. */
  containsEncryptedContent?: boolean;
  isError: boolean;
  timestamp: number;
}

export interface OcxTextContent {
  type: "text";
  text: string;
}

export interface OcxImageContent {
  type: "image";
  /** A `data:` URL (base64) or a remote https URL — passed through from Codex verbatim, NEVER inlined as text. */
  imageUrl: string;
  /** Fidelity hint from Codex: "low" | "high" | "auto". */
  detail?: string;
}

export interface OcxVideoContent {
  type: "video";
  /** A base64 `data:` URL from an OpenAI-compatible `video_url` part. */
  videoUrl: string;
}

/** A user/developer message content part: text or native media. */
export type OcxContentPart = OcxTextContent | OcxImageContent | OcxVideoContent;

export interface OcxThinkingContent {
  type: "thinking";
  thinking: string;
  signature?: string;
  itemId?: string;
  /** Raw Anthropic redacted_thinking block payloads to replay verbatim (order preserved). */
  redacted?: string[];
}

export interface OcxToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  customWireName?: string;
  thoughtSignature?: string;
  /**
   * Provider-issued opaque metadata that must survive the whole round trip unchanged
   * (issue #1735). A signed Gemini part is only valid when its signature comes back on the
   * SAME part it was issued for, so this travels with the individual tool call rather than
   * being matched by name/arguments after the fact.
   */
  providerMetadata?: OcxProviderOpaqueToolCallMetadata;
  /** MCP namespace (e.g. "mcp__context7") when this call targets a namespaced tool. */
  namespace?: string;
}

/**
 * Opaque, provider-scoped tool-call metadata. Values are never parsed, merged, re-encoded, or
 * synthesized — they are carried verbatim or not at all.
 */
export interface OcxProviderOpaqueToolCallMetadata {
  google?: {
    thoughtSignature?: string;
  };
}

export type OcxAssistantContentPart = OcxTextContent | OcxThinkingContent | OcxToolCall;
export interface OcxRequestOptions {
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
  toolChoice?: OcxToolChoice;
  parallelToolCalls?: boolean;
  reasoning?: string;
  hideThinkingSummary?: boolean;
  serviceTier?: string;
  /** Final outbound tier action, resolved after the provider/model wire is settled. */
  tierDecision?: TierDecision;
  /** Internal B0 observation inputs; adapters combine these with the wire they actually serialize. */
  tierObservation?: TierObservationContext;
  presencePenalty?: number;
  frequencyPenalty?: number;
  /** Responses prompt-cache affinity key. Passthrough preserves it via _rawBody; routed adapters do not consume it unless their upstream wire supports it. */
  promptCacheKey?: string;
  /**
   * Responses `text.format` (json_schema / json_object), preserved for adapters whose
   * upstream wire has an equivalent. The openai-chat adapter re-nests it as chat
   * `response_format`, the exact inverse of responseFormatToText in src/chat/inbound.ts.
   * The native passthrough ignores it (it forwards `_rawBody.text` verbatim) and Kiro
   * keeps rejecting structured output via `_structuredOutput`.
   */
  textFormat?: {
    type: "json_schema" | "json_object";
    name?: string;
    description?: string;
    schema?: Record<string, unknown>;
    strict?: boolean;
  };
}

export type OcxMessagePhase = "commentary" | "final_answer";

/** Non-secret, process-local owner fence for provider-private continuation state. */
export interface OcxProviderContinuationOwner {
  [field: string]: string | number;
  version: 1;
  providerName: string;
  providerDestinationIdentity: string;
  adapterName: string;
  modelId: string;
  credentialIdentity: string;
}

/**
 * Provider-private state that must follow a locally expanded `previous_response_id` chain.
 * Kept out of public Responses output and persisted only in the bounded local continuation cache.
 */
export interface OcxProviderContinuationState {
  /** Proxy-authored owner metadata; stripped before provider adapters receive the state. */
  __ocxOwner?: OcxProviderContinuationOwner;
  cursor?: {
    [field: string]: unknown;
    conversationId?: string;
    checkpointUsable?: boolean;
    /** Opaque process-local Cursor ConversationStateStructure snapshot ref. Never raw protobuf. */
    checkpointRef?: string;
  };
  kiro?: {
    [field: string]: unknown;
    conversationId?: string;
  };
  [provider: string]: Record<string, unknown> | undefined;
}

export type AdapterEvent =
  | { type: "heartbeat" }
  | { type: "text_delta"; text: string; phase?: OcxMessagePhase }
  | { type: "thinking_delta"; thinking: string }
  // Anthropic extended-thinking round-trip: signature_delta for the current thinking block, and
  // opaque redacted_thinking blocks. Both must be replayed verbatim or tool-use turns 400.
  | { type: "thinking_signature"; signature: string }
  | { type: "redacted_thinking"; data: string }
  // Kiro reasoning round-trip: the encrypted `redactedContent` blob for the CURRENT assistant turn.
  // Never rendered — it only rides the reasoning item's envelope so the next request can replay it.
  | { type: "kiro_redacted_reasoning"; data: string }
  | { type: "reasoning_raw_delta"; text: string }
  | { type: "tool_call_start"; id: string; name: string; providerMetadata?: OcxProviderOpaqueToolCallMetadata }
  | { type: "tool_call_delta"; arguments: string }
  | { type: "tool_call_end" }
  /** Internal boundary between a guarded first pass and its one-shot continuation. */
  | { type: "assistant_boundary" }
  // Native web-search activity surfaced by the web-search sidecar so Codex renders a "Searched the
  // web" cell. Emitted as a lifecycle PAIR at real wall-clock moments by src/web-search/loop.ts
  // (routed adapters never emit these): `begin` right before the sidecar runs so Codex shows the
  // "Searching the web" spinner, then `end` once it resolves. The bridge maps begin → an
  // output_item.added(in_progress) and end → the matching output_item.done(completed|failed) under
  // the SAME output index, so the activity animates instead of flashing completed instantly.
  | { type: "web_search_call_begin"; id: string }
  | { type: "web_search_call_end"; id: string; queries: string[]; status?: "completed" | "failed"; sources?: OcxUrlCitation[] }
  | {
      type: "done";
      usage?: OcxUsage;
      /** Native opaque compaction ciphertext returned by a Responses backend. */
      compactionEncryptedContent?: string;
      stopReason?: string;
      endTurn?: boolean;
      providerState?: OcxProviderContinuationState;
    }
  | {
      type: "incomplete";
      reason: string;
      message?: string;
      usage?: OcxUsage;
      retryable?: boolean;
      endTurn?: boolean;
      providerState?: OcxProviderContinuationState;
    }
  // `usage` carries best-effort partial consumption when a turn dies before a clean done
  // (e.g. cursor upstream 502 mid-stream), so failed requests can log real token counts.
  | {
      type: "error";
      message: string;
      usage?: OcxUsage;
      /** Authoritative upstream/proxy status when known; avoids message-based classification. */
      status?: number;
      /** Responses error type and code when the adapter has a structured provider failure. */
      errorType?: string;
      code?: string;
      retryable?: boolean;
    };

/**
 * A web source backing a search answer. Surfaced on the search-end event and rendered by the bridge
 * as a `url_citation` annotation on the following assistant message (the desktop app's Sources chip
 * reads these; the TUI ignores annotations, so this is additive).
 */
export interface OcxUrlCitation {
  url: string;
  title?: string;
}

/**
 * Canonical usage convention (devlog/260711_claude_inbound/070):
 * - `inputTokens` is the TOTAL prompt size, INCLUDING cache reads and cache writes
 *   (OpenAI Responses convention). Anthropic parse sites normalize into this shape.
 * - `cachedInputTokens` is cache READ tokens only (a subset of `inputTokens`).
 * - `cacheReadInputTokens`/`cacheCreationInputTokens` carry the read/write split when
 *   the provider reports both; reads mirror `cachedInputTokens`.
 * - `totalTokens` = inputTokens + outputTokens. Never re-add cache detail on top.
 */
export interface OcxUsage {
  inputTokens: number;
  outputTokens: number;
  /**
   * Absolute active-context size after the response. Stateful providers can expose this separately
   * from their per-attempt usage. Responses serialization derives the input side from
   * `contextTotalTokens - outputTokens` so output is never added to an absolute checkpoint twice.
   */
  contextTotalTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  reasoningOutputTokens?: number;
  estimated?: boolean;
  /**
   * The raw upstream usage object for Responses-shaped upstreams (openai/codex#41980 parity):
   * codex-rs preserves the complete `response.usage` object through its own pipeline, so fields
   * the proxy does not model (subscription metadata, future counters) must survive the bridged /
   * rebuilt `response.completed` too. Accounting paths read only the canonical fields above; the
   * wire rebuild merges this object's unknown keys back under the normalized values.
   */
  rawUsage?: Record<string, unknown>;
}
