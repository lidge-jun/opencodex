import type { KiroOAuthMetadata } from "./oauth/types";

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
  /** Number of leading raw input items restored from local previous_response_id state. */
  _replayPrefixLen?: number;
  /** True when the proxy expanded a previous_response_id request into a full input replay. */
  _previousResponseInputExpanded?: boolean;
  /** Provider-private stable Cursor conversation id resolved from the Responses previous_response_id chain. */
  _cursorConversationId?: string;
  /** Stable upstream client thread identity, used only to derive provider-scoped continuation ids. */
  _clientThreadId?: string;
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
  _kiroAuthContext?: Pick<KiroOAuthMetadata, "profileArn" | "apiRegion" | "ssoRegion">;
  /** Provider-private continuation metadata resolved from the Responses previous_response_id chain. */
  _providerContinuation?: OcxProviderContinuationState;
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

/** A user/developer message content part: text or an image (vision). */
export type OcxContentPart = OcxTextContent | OcxImageContent;

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
  /** MCP namespace (e.g. "mcp__context7") when this call targets a namespaced tool. */
  namespace?: string;
}

export type OcxAssistantContentPart = OcxTextContent | OcxThinkingContent | OcxToolCall;

export interface OcxTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict?: boolean;
  /** MCP namespace (e.g. "mcp__context7") for tools flattened out of a Responses "namespace" tool. */
  namespace?: string;
  /** Freeform/custom tool (e.g. apply_patch): the model's call must be relayed as a custom_tool_call. */
  freeform?: boolean;
  /** Client-executed tool discovery (tool_search): the model's call must be relayed as a tool_search_call. */
  toolSearch?: boolean;
  /** Tool definition restored from a prior tool_search output; transports may prioritize it when catalogs are bounded. */
  loadedFromToolSearch?: boolean;
  /** Cursor-only synthetic exact-match edit tool; never inferred from the wire name. */
  cursorStructuredEdit?: true;
  /** Synthetic web_search tool: the model's call is executed by the gpt-5.4-mini sidecar, not relayed to Codex. */
  webSearch?: boolean;
  /** Synthetic image_gen tool: the model's call is executed by the xAI image bridge sidecar, not relayed to Codex. */
  imageGeneration?: boolean;
  /** Synthetic video_gen tool: executed by the xAI video bridge sidecar. */
  videoGeneration?: boolean;
}

/**
 * Wire name a chat model sees for a tool. Namespaced (MCP) tools are flattened to
 * "<namespace>__<name>" so they survive the chat-completions function-tool format;
 * the proxy maps this back to {namespace, name} on the return trip (Codex routes MCP
 * calls by an explicit `namespace` field, not by parsing the name).
 */
export function namespacedToolName(namespace: string | undefined, name: string): string {
  return namespace ? `${namespace}__${name}` : name;
}

export function toolChoiceAliases(tool: Pick<OcxTool, "namespace" | "name">): string[] {
  const wireName = namespacedToolName(tool.namespace, tool.name);
  return tool.namespace ? [wireName, `${tool.namespace}.${tool.name}`] : [wireName];
}

export function toolAllowedByChoice(tool: Pick<OcxTool, "namespace" | "name">, allowedTools: ReadonlySet<string>): boolean {
  return toolChoiceAliases(tool).some(name => allowedTools.has(name));
}

export function resolveToolChoiceWireName(tools: readonly Pick<OcxTool, "namespace" | "name">[] | undefined, name: string): string {
  const match = tools?.find(tool => toolChoiceAliases(tool).includes(name));
  return match ? namespacedToolName(match.namespace, match.name) : name;
}

/**
 * Whether `modelId` is in a per-provider classification list (e.g. `noVisionModels`). Matches the full
 * id, OR — for Ollama-style ids — the family before the ":size" tag, so a `gpt-oss` entry covers
 * `gpt-oss:120b`/`gpt-oss:20b`. Colon-less ids (e.g. `grok-build-0.1`) still match exactly only.
 */
export function modelInList(list: string[] | undefined, modelId: string): boolean {
  if (!list || list.length === 0) return false;
  if (list.includes(modelId)) return true;
  const colon = modelId.indexOf(":");
  return colon > 0 && list.includes(modelId.slice(0, colon));
}

export type OcxToolChoice =
  | "auto"
  | "none"
  | "required"
  | { name: string }
  | { allowedTools: string[]; mode: "auto" | "required" };

export function isAllowedToolChoice(value: OcxToolChoice | undefined): value is { allowedTools: string[]; mode: "auto" | "required" } {
  return typeof value === "object" && value !== null && "allowedTools" in value;
}

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

/**
 * Provider-private state that must follow a locally expanded `previous_response_id` chain.
 * Kept out of public Responses output and persisted only in the bounded local continuation cache.
 */
export interface OcxProviderContinuationState {
  cursor?: {
    conversationId?: string;
    checkpointUsable?: boolean;
  };
  kiro?: {
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
  | { type: "tool_call_start"; id: string; name: string }
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
}

/**
 * Claude Code inbound settings (devlog/260711_claude_inbound). Consumed by the
 * /v1/messages surface, the `ocx claude` launcher, and the GUI Claude page.
 */
export interface OcxClaudeCodeConfig {
  /** Kill switch for the /v1/messages inbound (GUI "Claude ON" toggle). Default: enabled. */
  enabled?: boolean;
  /**
   * Verbatim passthrough of unmapped claude/anthropic models to api.anthropic.com with the
   * caller's own sk-ant-* credential (Claude Code subscription OAuth). Default: enabled.
   */
  nativePassthrough?: boolean;
  /** Upstream for the native passthrough (tests/enterprise gateways). Default: https://api.anthropic.com */
  anthropicBaseUrl?: string;
  /**
   * Native passthrough body inactivity budget in SECONDS — raw upstream-byte silence
   * while a read is pending, NOT total duration (slow-but-alive streams never trip it;
   * devlog 260716_passthrough_followups/010). Default 90. Min 1. Exactly 0 disables;
   * negative/non-finite values fall back to the default.
   */
  bodyStallSec?: number;
  /**
   * Native passthrough cumulative body byte cap (streamed SSE and buffered non-stream
   * alike) — an OOM/occupancy guard, not a correctness limit. Default 67108864 (64 MiB).
   * Exactly 0 disables; negative/non-finite values fall back to the default.
   */
  bodyMaxBytes?: number;
  /** Default model slot injected as ANTHROPIC_MODEL by `ocx claude`. */
  model?: string;
  /** Haiku/small-fast slot injected as ANTHROPIC_DEFAULT_HAIKU_MODEL (+ legacy SMALL_FAST). */
  smallFastModel?: string;
  /** Inbound model id remaps: exact id first, then date-stripped (`-\d{8}$`). */
  modelMap?: Record<string, string>;
  /**
  * Inject ANTHROPIC_BASE_URL etc. into the macOS user domain via `launchctl setenv`
  * so plain `claude` commands route through the proxy without `ocx claude`. Reverted
   * on stop/shutdown. Default: false (opt-in). macOS only.
   */
  systemEnv?: boolean;
  /**
   * Auth mode for Claude Code inbound requests — a THREE-state intent.
   *
   * "proxy": inject the dummy ANTHROPIC_AUTH_TOKEN so Claude Code routes through the
   * proxy without a real Anthropic key. "subscription": never inject it. UNSET means
   * AUTO: the mode is resolved from detected Claude auth on every launch and every
   * status read (src/claude/auth-mode.ts), so registering a Claude login switches the
   * behaviour with no migration and no stored state.
   *
   * An explicit value always wins over detection and is never rewritten by the auto
   * logic — that is what makes a manual choice stick (devlog 260726_claude_auth_auto).
   */
  authMode?: "proxy" | "subscription";
  /**
   * ISO timestamp of the one-time authMode migration. Before auto existed, choosing
   * "Subscription" DELETED the key, so a pre-upgrade config cannot distinguish an
   * explicit subscription choice from "never chose". Its ABSENCE identifies a
   * pre-upgrade block; the migration writes it once and never re-runs, so a user who
   * later picks Auto (which deletes authMode) is not silently converted back.
   */
  authModeMigratedAt?: string;
  /**
   * Context-window override for Claude Code/Desktop clients (devlog 136 B6):
   * injected as CLAUDE_CODE_MAX_CONTEXT_TOKENS + DISABLE_COMPACT=1 (the official
   * env pair — recognized claude-shaped ids need both). WARNING: DISABLE_COMPACT
   * turns off auto-compaction. Unset = client defaults.
   */
  maxContextTokens?: number;
  /**
   * Opt-in CLAUDE_CODE_ALWAYS_ENABLE_EFFORT=1 injection. Default OFF: opus-shaped
   * aliases already carry output_config.effort on the wire (devlog 136 실측), and
   * forcing effort on every request can leak reasoning params to non-reasoning routes.
   */
  alwaysEnableEffort?: boolean;
  /**
   * Subagent tier slots (devlog 260712 B2): injected as ANTHROPIC_DEFAULT_*_MODEL so
   * Claude Code's Agent-tool aliases (opus/sonnet/haiku/fable + parent-inherit) route
   * to proxy models. haiku falls back to smallFastModel (one effective value feeds
   * both ANTHROPIC_DEFAULT_HAIKU_MODEL and legacy ANTHROPIC_SMALL_FAST_MODEL).
   */
  tierModels?: { opus?: string; sonnet?: string; haiku?: string; fable?: string };
  /**
   * Auto-context (devlog 260712 020): when not false, routed/native models whose
   * authoritative window is > 200k AND >= the compact window get the [1m] marker
   * (Claude Code then accounts 1M) and CLAUDE_CODE_AUTO_COMPACT_WINDOW is injected
   * so compaction fires at the real budget. 2.1.207 semantics (binary-verified):
   * effective compact window = min(believed window, env) — one global env behaves
   * like a per-model floor. Default: enabled. Inert while maxContextTokens is set
   * (the legacy DISABLE_COMPACT pair takes rule-1 precedence in the CLI).
   */
  autoContext?: boolean;
  /** Compact-window tokens for auto-context. Default 350_000. */
  autoCompactWindow?: number;
  /**
   * Bundled-skill content elision for ROUTED (non-Anthropic) models (devlog 260712
   * 060): Skill-tool results whose skill name matches an entry here are replaced
   * with a short stub in the anthropic->responses translation. Third-party models
   * are not trained on these Anthropic doc bundles, and claude-api alone injects
   * ~136k tokens (GitHub anthropics/claude-code#74473). Native Anthropic
   * passthrough never goes through the translation, so Claude models keep the
   * full content. Default: ["claude-api"]. Empty array = explicitly off.
   */
  blockedSkills?: string[];
  /**
   * Sync the featured subagent roster (config.subagentModels + main model) into
   * ~/.claude/agents/ocx-*.md custom agent definitions at launch (devlog 260712
   * 070) so any routed model is dispatchable as a subagent_type — the Agent
   * tool's model argument is a hard 4-alias enum, but definition frontmatter is
   * free. Only ocx-*.md files are owned/pruned. Default: enabled.
   */
  injectAgents?: boolean;
  /**
   * Optional Claude Code effort pinned in every generated ocx-* subagent
   * definition. Unset inherits the parent session effort.
   */
  subagentEffort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Claude-originated web-search override. Unset fields inherit the global sidecar settings. */
  webSearchSidecar?: { backend?: "openai" | "anthropic"; model?: string };
  /** Claude-originated vision override. Unset fields inherit the global sidecar settings. */
  visionSidecar?: { backend?: "openai" | "anthropic"; model?: string };
  /** Persisted Claude Desktop four-family routing profile. */
  desktopProfile?: OcxClaudeDesktopProfile;
  /** Auto-reconcile Desktop 3P config when provider catalog changes. Default: enabled. */
  desktopAutoApply?: boolean;
  /**
   * When false, omit `native/*` rows from Claude Desktop show/export/apply. Default: enabled.
   * Routing-sidecar alias decoding is unchanged — only the Desktop model list writer.
   */
  desktopNativeModels?: boolean;
}

export type OcxClaudeDesktopFamily = "opus" | "fable" | "sonnet" | "haiku";

export interface OcxClaudeDesktopAssignment {
  family: OcxClaudeDesktopFamily;
  alias: string;
}

export interface OcxClaudeDesktopProfile {
  version: 1;
  assignments: Record<string, OcxClaudeDesktopAssignment>;
  defaults: Record<OcxClaudeDesktopFamily, string | null>;
  /** SHA-256 fingerprint of the last successfully applied 3P config content. */
  appliedFingerprint?: string;
  /** ISO timestamp of the last successful apply. */
  appliedAt?: string;
}

/**
 * Opt-in archived-session auto-cleanup policy (issue #42 Phase 3).
 * Persisted under `OcxConfig.storageCleanupPolicy`. Default `enabled: false`.
 */
export interface StorageCleanupPolicy {
  /** When false/unset, the engine never mutates. Default false. */
  enabled: boolean;
  /** Run when archived session bytes exceed this threshold. */
  trigger: { archivedBytesOver: number };
  /** Either shrink archives toward a byte floor, or remove the oldest N%. */
  target: { reduceToBytes?: number } | { removeOldestPercent?: number };
  schedule: "startup" | "daily" | "weekly" | "manual";
  /** Default quarantine. Permanent only when explicitly set. */
  mode: "quarantine" | "permanent";
  lastRun?: { at: number; freedBytes: number; removed: number };
  /** Epoch ms when the next scheduled evaluation is due. */
  nextRun?: number;
}

/** 사용자가 대시보드에서 직접 추가한 커스텀 모델 정의. */
export interface OcxCustomModel {
  /** 고유 ID (crypto.randomUUID()) */
  id: string;
  /** 프로바이더 키 (기존 providers[name]) */
  provider: string;
  /** 모델 슬러그 (프로바이더 접두사 없는 bare id) */
  modelId: string;
  /** 인간 가독 표시명 (선택, 슬래시 불가) */
  displayName?: string;
  /** 컨텍스트 윈도우 (토큰) */
  contextWindow?: number;
  /** 입력 모달리티 (선택, 기본 ["text"]) */
  inputModalities?: string[];
  /** 추가 시각 (ISO 8601) */
  addedAt?: string;
}

/**
 * A generated `ocx_` data-plane key. `key` is the secret itself and never leaves
 * the server except in the one-time POST /api/keys response; every other surface
 * sees only the masked prefix.
 */
export interface OcxApiKeyEntry {
  id: string;
  name: string;
  key: string;
  createdAt: string;
}

/**
 * Durable per-client intent. One key today, deliberately.
 *
 * A top-level `codexEnabled` would force every later client to invent an
 * unrelated name and its own helpers; a ten-key union recreated the coupling
 * that failed two audits, because every phase then had to touch every client's
 * write path. A one-key object keeps the extension point without letting this
 * phase claim ownership over a client it does not implement.
 */
export interface OcxClientIntegrationsConfig {
  /** Durable desired state for native Codex. MISSING MEANS ON. */
  codex?: boolean;
  /** Durable desired state for Grok Build. MISSING MEANS ON. */
  grok?: boolean;
  /** Durable desired state for Claude Desktop. MISSING MEANS ON. */
  "claude-desktop"?: boolean;
}

export interface OcxConfig {
  port: number;
  /** Maximum usage-log bytes read for one management snapshot. */
  managementUsageMaxReadBytes?: number;
  providers: Record<string, OcxProviderConfig>;
  defaultProvider: string;
  /** OpenAI provider-contract migration marker (v2 = single `openai` provider with account mode). */
  openaiProviderTierVersion?: 1 | 2;
  /** One-time migration marker for Antigravity's static catalog default. */
  googleAntigravityStaticCatalogVersion?: 1;
  /** Claude Code inbound + launcher settings. */
  claudeCode?: OcxClaudeCodeConfig;
  /**
   * Per-client durable intent. This phase owns only `codex`; later phases extend
   * one key at a time rather than widening a shared union.
   */
  clientIntegrations?: OcxClientIntegrationsConfig;
  /**
   * Up to 5 Codex-facing catalog ids to feature first. Values may be bare catalog ids,
   * exact account-qualified "<selector>/<native-openai-model>" ids, or routed
   * "<provider>/<model>" ids. With account selectors, one bare native choice can expand
   * into a selector-qualified group; Codex still advertises only the first 5 visible rows.
   */
  subagentModels?: string[];
  /**
   * Priority-ordered fallback models for spawned sub-agents. When the requested
   * model is quota-exhausted or recently failed, opencodex rewrites the child
   * turn to the next available entry before routing.
   */
  subagentModelFallback?: string[];
  /**
   * TTL (ms) for cached sub-agent model availability probes. Default 60_000.
   */
  subagentModelFallbackPollMs?: number;
  injectionModel?: string;
  /**
   * Opt in to synchronizing the selected injection model into Codex's native
   * sub-agent defaults. Only meaningful while `injectionModel` is set.
   */
  syncCodexSubagentDefaults?: boolean;
  /**
   * Optional reasoning effort the delegation prompt tells the agent to pass in spawn_agent calls
   * (`reasoning_effort` argument). Only meaningful while `injectionModel` is set; validated against
   * the Codex ladder (src/reasoning-effort.ts CODEX_REASONING_LEVELS) at the API boundary.
   */
  injectionEffort?: string;
  /**
   * Explicit sideband websocket base for realtime/live joins, mirroring upstream's
   * `experimental_realtime_ws_base_url`. The value is a ROOT (or a recognized
   * `/realtime`, `/realtime/calls/<id>`, `/live/<id>` endpoint form, which is
   * stripped back to the root); `/v1` is appended during normalization. Intended
   * for local development against a fake realtime server — plaintext `http`/`ws`
   * is accepted only for loopback hosts, and URL userinfo is rejected; both
   * failures close to the canonical `https://api.openai.com/v1`. Configured by
   * editing this file; there is deliberately no management-API or GUI surface.
   */
  experimentalRealtimeWsBaseUrl?: string;
  /**
   * Model ids the user has EXCLUDED from the Grok Build managed block. Absent or empty
   * means "everything visible", which is the historical behaviour — so an existing
   * config keeps the fence it already had.
   *
   * Exclusion list rather than an inclusion list on purpose: a newly added provider
   * model should appear in Grok by default, exactly as it does today. An inclusion list
   * would silently hide every future model behind a switch nobody knew to flip.
   */
  grokExcludedModels?: string[];
  /**
   * When true, OpenAI-routed requests include `service_tier: "priority"` (fast inference).
   * When false, service_tier is stripped so requests use default speed.
   * Undefined = passthrough (don't modify what the client sends).
   */
  fastMode?: boolean;
  /**
   * Windows/macOS SSE passthrough stream shape (#314 mitigation).
   * On Windows, "auto" (default) selects eager relay only on a runtime proven
   * to carry the Bun#32111 fix. On macOS, "auto" always stays on legacy tee and
   * eager relay is explicit-only. "eager-relay" opts into the new relay (and
   * accepts #32111 crash risk on Bun 1.3.14); "legacy-tee" pins the tee path.
   * Persisted in config.json so service users can select the stream shape.
   * See src/lib/bun-stream-caps.ts.
   */
  streamMode?: "auto" | "legacy-tee" | "eager-relay";
  /**
   * Custom override for the injected v2 multi-agent guidance body (the text inside
   * the <multi_agent_mode> tags). After guidance is enabled and the v2 surface and
   * catalog-state gates pass, a configured injectionModel is sufficient to render it;
   * otherwise an eligible roster or fallback is required. Placeholders: `{{model}}` -> the
   * effective preferred model for the request (a bare native model is account-qualified
   * only when the request targets an explicit account selector; unresolved or ambiguous
   * bare values become "", while unresolved explicit routed or account-qualified values
   * remain unchanged),
   * `{{effort}}` -> injectionEffort, `{{roster}}` -> the resolved sub-agent roster
   * block ("" when nothing resolves), `{{fallback}}` -> the configured subagent
   * model fallback guidance block ("" when unset).
   */
  injectionPrompt?: string;
  /**
   * Proxy-authored multi-agent developer guidance. Undefined/true = enabled for
   * backward compatibility; false suppresses both v1 and v2 guidance injection.
   */
  multiAgentGuidanceEnabled?: boolean;
  /**
   * Global hard ceiling for the reasoning effort of EVERY proxied turn (main agent AND
   * sub-agents). Ladder value "low".."max"; incoming efforts ranking above it are rewritten
   * in both request shapes before any adapter or clamp. Unset = no cap. codex-rs converts
   * ultra -> max client-side, so e.g. a "high" cap sends ultra/max-tier turns as high.
   */
  effortCap?: string;
  /**
   * Hard ceiling applied ONLY to sub-agent turns — requests carrying codex-rs's spawned-child
   * markers (`x-openai-subagent` header, or `subagent_kind` inside `x-codex-turn-metadata`).
   * Lets the main agent keep its tier while delegated children are capped. When both caps are
   * set, the lower one wins for sub-agents. See src/server/effort-policy.ts.
   */
  subagentEffortCap?: string;
  /**
   * Models hidden from Codex discovery without blocking direct proxy calls. Routed provider ids
   * are excluded from the catalog + /v1/models entirely. Account-qualified native ids hide only
   * their generated selector row and are omitted from raw /v1/models. BARE native GPT ids hide
   * the bare row plus every generated selector row and omit that model family from raw discovery.
   */
  disabledModels?: string[];
  /** 사용자가 대시보드에서 직접 추가한 커스텀 모델 목록. */
  customModels?: OcxCustomModel[];
  /**
   * Internal, versioned evidence for reconciling custom-model deletions with
   * pre-marker Codex catalog rows. Consumers must parse this defensively so a
   * future state written by a newer binary survives older whole-config saves.
   */
  customModelCatalogMigration?: unknown;
  /**
   * Shadow call intercept: redirect Codex's hard-coded helper calls (title generation,
   * commit messages, skill orchestration) to a user-chosen model. Default intercepted
   * source models: gpt-5.4-mini (older clients) and gpt-5.6-luna (Codex 0.145.0+).
   * Opt-in; disabled by default. Matching maintenance/helper requests are forced to low.
   * Normal Codex turns identified by request_kind=turn are never rewritten.
   */
  shadowCallIntercept?: {
    /** When true, requests for known shadow/helper source models are rewritten to the configured model. */
    enabled?: boolean;
    /** Replacement model id (e.g. "gpt-5.5"). */
    model?: string;
    /** Optional override of intercepted source-model prefixes (default: gpt-5.4-mini, gpt-5.6-luna). */
    sourceModels?: string[];
  };
  /**
   * 3-state multi-agent surface override:
   * - "v1": force ALL models to v1 surface (override upstream pins)
   * - "default" | undefined: respect upstream model pins (sol/terra=v2, luna=v1, rest=codex flag)
   * - "v2": force ALL models to v2 surface (override upstream pins)
   */
  multiAgentMode?: "v1" | "default" | "v2";
  /** Provider-level Codex-visible context caps. Values only lower known model context windows. */
  providerContextCaps?: Record<string, number>;
  /** Global Codex-visible context cap value (tokens). Falls back to DEFAULT_PROVIDER_CONTEXT_CAP. */
  contextCapValue?: number;
  /** Bind hostname. Default "127.0.0.1" (loopback only). Set "0.0.0.0" to expose on all interfaces. */
  hostname?: string;
  /**
   * Optional second listener bound to 127.0.0.1 that admits data-plane requests without a
   * credential (issue #1102).
   *
   * Why a separate listener rather than an exemption on the main one: when `hostname` is a
   * wildcard, every caller needs `x-opencodex-api-key`, but a `codex app-server` spawned
   * directly from the resolved entrypoint never goes through the generated shim and so never
   * inherits the token. Exempting "loopback-looking peers" on the public listener would be
   * unsound — `requestIP()` only proves the last transport hop, and Docker Desktop port
   * forwarding, host-network containers, WSL mirrored networking and tunnels all terminate
   * remote connections locally. Binding a second socket to 127.0.0.1 makes the kernel refuse
   * remote connections outright, so there is no address to judge.
   *
   * The public listener's admission policy is unchanged. This adds an explicit local trust
   * surface: every process on the machine can reach it, spend account quota, and consume paid
   * provider credentials. Off by default; not for multi-tenant hosts.
   *
   * The port is required when enabled and must differ from the proxy port. An OS-assigned port
   * would change across restarts, which would break already-running app-servers holding the
   * previous `base_url` — the exact symptom #1102 reported and we disproved for token rotation.
   */
  unauthenticatedLoopbackListener?:
    | { enabled: false }
    | { enabled: true; port: number };
  /**
   * Outbound HTTP(S) proxy URL for provider requests (e.g. "http://user:pass@proxy:8080", or
   * "${HTTPS_PROXY}"-style env reference). Mirrored into HTTP_PROXY/HTTPS_PROXY at startup when
   * those are unset — Bun's fetch honors them for all outbound calls; localhost is excluded.
   */
  proxy?: string;
  /**
   * Upstream stall timeout (seconds). After this many seconds of no upstream data, emits
   * response.incomplete. Default 300. Min 1.
   */
  stallTimeoutSec?: number;
  /** Connect timeout (ms) for upstream fetch — covers DNS, TCP, TLS, and response header. Default 200000. */
  connectTimeoutMs?: number;
  /** Graceful shutdown drain timeout (ms). Active turns are aborted after this deadline. Default 5000. */
  shutdownTimeoutMs?: number;
  /** Advertise supports_websockets so Codex opens the WS endpoint. Default false; set true to opt in. */
  websockets?: boolean;
  /**
   * Opt-in auto-cleanup policy for archived Codex sessions (issue #42 Phase 3).
   * Default OFF (`enabled` false / unset). Never enabled implicitly.
   * See `src/storage/policy.ts`.
   */
  storageCleanupPolicy?: StorageCleanupPolicy;
  /** Generated API keys for external access to the proxy's /v1/responses endpoint. */
  apiKeys?: OcxApiKeyEntry[];
  /** Auto-start/sync the proxy from the Codex shim before launching Codex. Default true. */
  codexAutoStart?: boolean;
  /** Restore an installed shim after a stable external Codex update replaces it. Default true. */
  codexShimAutoRestore?: boolean;
  /**
   * Compatibility mode: temporarily rewrite Codex resume-history metadata while the proxy is active
   * so Codex App can show old OpenAI chats and opencodex-created exec chats under its default
   * interactive-source/provider filters. Default true; originals are backed up and restored by
   * `ocx stop` / `ocx restore`. Set false to opt out of history remapping.
   */
  syncResumeHistory?: boolean;
  /** Freshness window (ms) for the per-provider live `/models` cache. Defaults to 5 min. */
  modelCacheTtlMs?: number;
  /** Evictable retained app-state budget in MiB. Default 256; valid 64..4096. */
  appOwnedMemoryBudgetMb?: number;
  /** Anthropic prompt-cache retention: "short" = 5-min ephemeral (default), "long" = 1-hour extended, "none" = disabled. */
  cacheRetention?: "none" | "short" | "long";
  /** Web-search sidecar: route web_search for non-OpenAI models through a gpt-mini via ChatGPT passthrough. */
  webSearchSidecar?: OcxWebSearchSidecarConfig;
  /** Vision sidecar: describe images via a gpt vision model so text-only models can "see" them. */
  visionSidecar?: OcxVisionSidecarConfig;
  /** /v1/images relay for codex's built-in image_gen tool. */
  images?: OcxImagesConfig;
  /** /v1/alpha/search relay for codex's built-in web search client. */
  search?: OcxSearchConfig;
  /** Codex multi-account pool. */
  codexAccounts?: CodexAccount[];
  /** Account ids administratively excluded from future pool selection until resumed. */
  pausedCodexAccountIds?: string[];
  /**
   * Selection order per account id, higher used earlier; absent = 0. Keyed by id
   * rather than stored on `codexAccounts` rows so the Desktop login (`__main__`),
   * which has no row, can be ordered too. Range -100..100.
   */
  codexAccountPriorities?: Record<string, number>;
  /**
   * Account id the operator last selected by hand. Suppresses upward priority
   * preemption until that account crosses the auto-switch threshold. Stores the
   * id (not a flag) so a stale pin cannot outlive the selection it described.
   */
  activeCodexAccountPinned?: string;
  /**
   * Public model-selector namespaces bound to one Codex account. Values are stored account ids;
   * `"@main"` selects the Codex Desktop/main auth.json account. Account display aliases
   * are intentionally separate from these selectors.
   */
  codexAccountNamespaces?: Record<string, string>;
  /**
   * Picker visibility override for account-qualified native models. When omitted, a non-empty
   * selector map remains visible for compatibility with hand-written configurations.
   */
  codexAccountPickerEnabled?: boolean;
  /** Active pool account id for next session. undefined = main (passthrough as-is). */
  activeCodexAccountId?: string;
  /** Auto-switch threshold (0-100). Default 80. 0 = disabled. */
  autoSwitchThreshold?: number;
  /** New-session account rotation strategy for the Codex pool. Default quota (today's behaviour). */
  accountPoolStrategy?: OcxAccountPoolRotationStrategy;
  /** Successful new-session binds retained on one round-robin selection. Default 1; range 1..100. */
  accountPoolStickyLimit?: number;
  /** Consecutive non-2xx upstream responses before switching future new threads. Default 3. 0 = disabled. */
  upstreamFailoverThreshold?: number;
  /**
   * Opt-in provider-origin circuit threshold for proven pre-connection reachability failures.
   * Default 0 (disabled); range 0..20. The circuit never counts timeouts or HTTP responses.
   */
  upstreamHostCircuitThreshold?: number;
  /**
   * Opt-in Anthropic OAuth account pool (#294). Default OFF.
   * Failover on 429 + sticky affinity; new sessions may pick lowest known 5h usage.
   * Experimental — see docs and GUI warning before enabling.
   */
  anthropicAccountPool?: {
    enabled?: boolean;
    /** Usage % threshold for new-session auto-pick. Default 80. 0 = disabled (affinity/active only). */
    autoSwitchThreshold?: number;
    /** New-session rotation strategy. Default quota (today's behaviour). */
    strategy?: OcxAccountPoolRotationStrategy;
    /** Successful new-session binds retained on one round-robin selection. Default 1; range 1..100. */
    stickyLimit?: number;
  };
  /** Virtual `combo/<id>` models spanning concrete provider/model targets (issue #133). */
  combos?: Record<string, OcxComboConfig>;
  /**
   * Routing policy profiles (Router Intelligence, RI-04+): explicitly requested
   * `policy/<id>` (or configured alias) models select among an explicit
   * candidate allowlist using hard capability requirements and deterministic
   * scoring. Existing model ids are never routed through profiles implicitly.
   */
  routingProfiles?: Record<string, OcxRoutingProfileConfig>;
  /** Background proactive token refresh ("Token Guardian"). Off by default; see OcxTokenGuardianConfig. */
  tokenGuardian?: OcxTokenGuardianConfig;
  /** Additional exact origins allowed for CORS (e.g. HTTPS or chrome-extension://<id>). Loopback origins are always allowed. */
  corsAllowOrigins?: string[];
}

export type OcxAccountPoolRotationStrategy = "quota" | "round-robin" | "fill-first";

export type OcxComboStrategy = "failover" | "round-robin";
export type OcxComboDefaultEffort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export interface OcxComboTarget {
  provider: string;
  model: string;
  /** Relative SWRR batch weight. Default 1; valid range 1..10000. */
  weight?: number;
}

export interface OcxComboConfig {
  targets: OcxComboTarget[];
  /** Ordered failover (default) or deterministic smooth weighted round-robin. */
  strategy?: OcxComboStrategy;
  /** Successful requests retained on one RR selection batch. Default 1; range 1..100. */
  stickyLimit?: number;
  /** Used when the client omits reasoning.effort. null/omitted leaves the target default unchanged. */
  defaultEffort?: OcxComboDefaultEffort | null;
  /**
   * Optional public model name replacing the default `combo/<id>` slug. Bare names
   * without "/" are allowed (e.g. "deepseek-v4-flash") so the combo can answer to a
   * mandated model id; exact-match requests route here before any provider resolution.
   */
  alias?: string;
  /**
   * Explicitly allow a bare OpenAI-native alias (for example `gpt-5.6-sol`) to
   * be represented by this routed combo. Never inferred from `alias`.
   */
  nativeAlias?: boolean;
  /** Display-only label for the public catalog row. Required for native aliases. */
  displayName?: string;
}

export type OcxRoutingUnknownEvidenceMode = "allow" | "penalize" | "exclude";

export interface OcxRoutingProfileCandidate {
  provider: string;
  model: string;
}

export interface OcxRoutingProfileRequirements {
  /** Minimum model context window in tokens. */
  minContextWindow?: number;
  /** Minimum remaining quota headroom fraction (0..1). */
  minQuotaHeadroom?: number;
  tools?: boolean;
  imageInput?: boolean;
  structuredOutput?: boolean;
  reasoningEffort?: string;
  serviceTier?: string;
  localOnly?: boolean;
  remoteAllowed?: boolean;
  /** Special encrypted Codex task readability (ChatGPT forward pool). */
  encryptedCodexTasks?: boolean;
}

export interface OcxRoutingProfileOptimize {
  latency?: number;
  health?: number;
  cost?: number;
  quota?: number;
}

export interface OcxRoutingProfileLimits {
  /** Hard per-request estimated-cost ceiling in USD. */
  maxEstimatedCostUsd?: number;
}

export interface OcxRoutingProfileUnknownEvidence {
  capability?: OcxRoutingUnknownEvidenceMode;
  health?: OcxRoutingUnknownEvidenceMode;
  quota?: OcxRoutingUnknownEvidenceMode;
  cost?: OcxRoutingUnknownEvidenceMode;
}

export interface OcxRoutingProfileConfig {
  /**
   * Explicit candidate allowlist (`provider/model` refs). No implicit
   * expansion in v1.
   */
  candidates: OcxRoutingProfileCandidate[];
  /** Optional public model name replacing the default `policy/<id>` slug. */
  alias?: string;
  /** Hard requirements evaluated before scoring. */
  require?: OcxRoutingProfileRequirements;
  /** Optimization weights; normalized deterministically. */
  optimize?: OcxRoutingProfileOptimize;
  limits?: OcxRoutingProfileLimits;
  /** How unknown evidence is handled per dimension. */
  unknownEvidence?: OcxRoutingProfileUnknownEvidence;
}

/**
 * Per-provider proactive-refresh policy. The guardian only ever touches a provider whose EFFECTIVE
 * policy is "proactive"; "lazy-only" keeps today's on-demand refresh, "disabled" forbids the
 * guardian entirely (used for providers whose ToS actively enforces against non-official-client
 * token traffic, e.g. Anthropic subscription OAuth). See devlog 260703_oauth-multi-account-refresh-and-tos.
 */
export type RefreshPolicy = "proactive" | "lazy-only" | "disabled";

export interface OcxTokenGuardianConfig {
  /** Global kill-switch. Default false — the guardian does nothing unless explicitly enabled. */
  enabled?: boolean;
  /** Seconds between refresh sweeps. Default 21600 (6h). Min 60. */
  tickSeconds?: number;
  /** Random 0..jitterSeconds added before each sweep to de-synchronize. Default 300. */
  jitterSeconds?: number;
  /** Max concurrent refreshes per sweep. Default 3. Min 1. */
  concurrency?: number;
  /** Extra lead (seconds) beyond one tick when deciding a token is "expiring soon". Default 900. */
  leadSeconds?: number;
  /** First backoff (seconds) after a permanent refresh failure. Default 300. */
  failureBackoffBaseSeconds?: number;
  /** Backoff ceiling (seconds). Default 3600. */
  failureBackoffMaxSeconds?: number;
  /** Optional Codex pool session warmup sweep. Default false to avoid background synthetic traffic. */
  codexWarmupEnabled?: boolean;
  /** Max age before a Codex pool account is revalidated via `/codex/responses`. Default 691200 (8d). */
  codexWarmupMaxAgeSeconds?: number;
  /** Model used for optional Codex pool warmup. Default gpt-5.4-mini. */
  codexWarmupModel?: string;
}

export interface OcxImagesConfig {
  /** Optional custom API-key provider for /v1/images relays. Built-in OpenAI tiers remain automatic. */
  provider?: string;
  /** Upstream timeout (ms) for one image generation/edit call (bridge xAI + /v1/images relay). Default 60000 for the bridge; relay may use a higher default (300000). */
  timeoutMs?: number;
  /** Master switch for the image bridge. Default false — set true to enable paid xAI Grok Imagine generation. */
  bridgeEnabled?: boolean;
  /** xAI image model id. Default "grok-imagine-image-quality" (see DEFAULT_MODEL in images/plan.ts). */
  bridgeModel?: string;
  /** Max image-generation loop iterations before forced-final. Default 3; clamped to [0, 10]. */
  maxRounds?: number;
  /** Max files retained under artifacts/. Oldest deleted when exceeded. Default 200. */
  artifactsKeepCount?: number;
  /** Master switch for the video bridge. Default false — must be explicitly opted in. */
  videoBridgeEnabled?: boolean;
  /** Model for xAI video generation. Default "grok-imagine-video". */
  videoBridgeModel?: string;
  /** Max video-gen rounds before forced-final. Default 2 (video is slower than image). */
  videoMaxRounds?: number;
  /** Per-video generation timeout (ms) including polling. Default 300000 (5 min). */
  videoTimeoutMs?: number;
}

export interface OcxSearchConfig {
  /**
   * Total upstream deadline (ms) for one /v1/alpha/search relay. Default 200000. The endpoint
   * is non-streaming JSON (headers arrive only when the search completes), so this is a whole-
   * request budget — deliberately NOT connectTimeoutMs, which is a header-arrival budget.
   */
  timeoutMs?: number;
}

export interface OcxVisionSidecarConfig {
  /** Master switch. Default: enabled when the selected backend has a usable credential. */
  enabled?: boolean;
  /** Description backend. Unset prefers a usable stored Anthropic OAuth credential, else OpenAI. */
  backend?: "openai" | "anthropic";
  /** Vision model that describes images. */
  model?: string;
  /** Max description cache misses admitted in one main-model turn. Zero disables description calls. */
  maxDescriptionsPerTurn?: number;
  /** Sidecar fetch timeout (ms). */
  timeoutMs?: number;
}

export interface OcxWebSearchSidecarConfig {
  /** Master switch. Default: enabled when a forward (ChatGPT) provider exists and the caller is logged in. */
  enabled?: boolean;
  /**
   * Which backend actually runs the server-side search. "openai" replays the hosted web_search via
   * the ChatGPT forward provider (gpt-mini sidecar); "anthropic" runs web_search_20250305 on a Claude
   * model authenticated by the STORED anthropic OAuth credential. Unset resolves to "anthropic" when a
   * usable anthropic OAuth credential exists, else "openai".
   */
  backend?: "openai" | "anthropic";
  /** Sidecar model that runs the real server-side web_search (must be a native ChatGPT model). */
  model?: string;
  /** Reasoning effort for the sidecar — "minimal" (non-thinking) keeps it fast/cheap. */
  reasoning?: string;
  /** Max searches executed per main-model turn (loop guard). */
  maxSearchesPerTurn?: number;
  /** Sidecar fetch timeout (ms). */
  timeoutMs?: number;
  /**
   * Config-file-only deadline (ms) for continuous routed-model response-body raw-byte inactivity
   * during a web-search turn. Default 200000. Must be an integer from 1 through 2147483647.
   */
  routedModelStallTimeoutMs?: number;
}

export interface OpenRouterProviderRouting {
  /** OpenRouter provider slugs to try first, in priority order. */
  order?: string[];
  /** Restrict routing to these OpenRouter provider slugs. */
  only?: string[];
  /** Whether OpenRouter may use providers outside `order`. Defaults to OpenRouter's policy. */
  allowFallbacks?: boolean;
}

export interface ResponsesItemIdRepairConfig {
  /** Exact `message` item ids that the proxy should rewrite to request-local canonical ids. */
  message?: string[];
  /** Exact `reasoning` item ids that the proxy should rewrite to request-local canonical ids. */
  reasoning?: string[];
  /** Backfill missing `output_item.done` / terminal snapshot ids from the matching output_index. */
  repairMissingTerminalIds?: boolean;
  /**
   * Treat existing message/reasoning ids without the canonical `msg_`/`rs_` prefix (e.g. bare
   * UUIDs from DeepSeek's Responses route) as invalid and mint canonical replacements (#938).
   * function_call ids and call_id pairing are never rewritten.
   */
  repairInvalidIds?: boolean;
}

/**
 * Same-target 429 wait-and-retry policy (`providers.<name>.retryOn429`). When present and not
 * explicitly disabled, the proxy waits and replays the identical request on the same key before
 * any key failover. All fields optional; the runtime applies defaults (attempts=3,
 * intervalMs=5000, maxIntervalMs=60000, respectRetryAfter=true, enabled=true).
 */
export interface RateLimitRetryPolicy {
  /** Master switch. The presence of the object also enables the policy (default true). */
  enabled?: boolean;
  /** Extra replay attempts after the first 429 (1..20, default 3). */
  attempts?: number;
  /** Fixed wait between attempts when the upstream sends no usable Retry-After (default 5000). */
  intervalMs?: number;
  /** Cap for any single wait, including an upstream Retry-After (default 60000). */
  maxIntervalMs?: number;
  /** Prefer the upstream Retry-After header when present and parseable (default true). */
  respectRetryAfter?: boolean;
}

/**
 * One configured provider entry. `authMode` (default `"key"`) decides whether same-target 429
 * retries are allowed; OAuth/forward credentials and local runtimes are never replayed.
 */
export interface OcxProviderConfig {
  adapter: string;
  /** Cursor MCP compatibility bounds; positive integers when configured. */
  mcpMaxTools?: number;
  mcpMaxSchemaBytes?: number;
  mcpMaxResultBytes?: number;
  /**
   * Per-model wire override, keyed by the upstream native model id (after namespace
   * and combo resolution). A single gateway can front models that speak different
   * wires — Grok needs the Responses API for hosted web_search while a sibling model
   * is fine on chat completions (#404).
   *
   * Only OpenAI-shaped wires may be selected; see MODEL_ADAPTER_OVERRIDE_ALLOWED.
   * Absent or empty means the provider-wide `adapter` applies to everything, exactly
   * as before.
   */
  modelAdapters?: Record<string, string>;
  baseUrl: string;
  /**
   * Optional relative resource path for key-auth openai-responses requests. Must start with `/`
   * and must not include a URL scheme, query string, or fragment. When omitted, the adapter keeps
   * the legacy `/v1/responses` construction.
   */
  responsesPath?: string;
  /**
   * Command Code protocol version sent as `x-command-code-version` on /alpha/generate requests.
   * The internal endpoint's schema drifts with the CLI version; operators can pin a known-good
   * version here instead of waiting for a code change. Absent uses the adapter's current default.
   */
  commandCodeVersion?: string;
  /**
   * Responses upstream that stores nothing server-side (DeepSeek documents "the API
   * is stateless"). Stateful request parameters are dropped, `store` is pinned false,
   * and orphaned tool results left by a replay miss are repaired rather than
   * forwarded to an upstream that cannot resolve their pair.
   */
  statelessResponses?: boolean;
  /**
   * Whether this provider's Responses route honours the OpenAI `service_tier`
   * parameter. Tri-state: `true` lets fast mode inject/remove the field (an unset
   * fast mode preserves a caller-supplied value); `false` strips the field and
   * never injects, because an upstream documented as not supporting the parameter
   * must not receive it; absent (`undefined`) leaves the provider unclassified —
   * caller-supplied values are preserved untouched, and fast mode never injects.
   * An explicit config value always wins over the registry default.
   */
  supportsServiceTier?: boolean;
  /**
   * Responses upstream whose native contract accepts plaintext reasoning replay
   * (DeepSeek documents reasoning items with plaintext content). When set, the
   * passthrough serializer keeps `reasoning_text` content on replayed reasoning
   * items instead of blanking it the way the ChatGPT backend requires; proxy-minted
   * `ocxr1` envelopes are still stripped because no upstream can decrypt them.
   */
  preserveResponsesReasoningContent?: boolean;
  /**
   * Explicit opt-in for non-registry private-network destinations such as localhost, RFC1918,
   * link-local, or unique-local upstreams. Metadata endpoints remain blocked.
   */
  allowPrivateNetwork?: boolean;
  /** Keep provider settings on disk but exclude it from routing and model/catalog listings. */
  disabled?: boolean;
  /**
   * Codex account-selection mode. Valid ONLY on the canonical built-in `openai` forward provider.
   * "pool" (default) rotates main + added Codex accounts through the affinity/quota/cooldown/
   * failover engine; "direct" pins the caller's main Codex login and never touches pool state.
   */
  codexAccountMode?: CodexAccountMode;
  apiKey?: string;
  /**
   * Key-auth header style for Anthropic-compatible providers.
   * Defaults to the native Anthropic `x-api-key`; gateways may require
   * `Authorization: Bearer <key>` instead.
   */
  apiKeyTransport?: "x-api-key" | "bearer";
  /**
   * Multi-key pool (API-key twin of OAuth multiauth). `apiKey` always mirrors the ACTIVE
   * entry so routing stays single-key; managed via /api/providers/keys. A legacy bare
   * `apiKey` seeds a one-entry pool on first management touch.
   */
  apiKeyPool?: Array<{ id: string; key: string; label?: string; addedAt?: number }>;
  defaultModel?: string;
  models?: string[];
  /**
   * Fetch the provider's live `/models` endpoint. Defaults to true.
   * Set false when `models` is an intentional allowlist or a provider's live catalog is too large
   * or too flaky for startup/catalog sync.
   */
  liveModels?: boolean;
  /**
   * Per-provider catalog allowlist. When non-empty, ONLY these model ids are emitted to Codex's
   * catalog and `/v1/models` — live discovery still runs, this just narrows what ships (so a proxy
   * exposing thousands of models, or an aggregator like OpenRouter, doesn't bloat the catalog).
   * Empty/undefined = expose all. The admin `/api/models` list is unaffected (it always shows the
   * full set so the user can pick). See devlog issue_052_provider-model-allowlist.
   */
  selectedModels?: string[];
  /** Provider-wide fallback when context metadata is absent; otherwise caps the reported window. */
  contextWindow?: number;
  /** Per-model fallback when context metadata is absent; otherwise caps the reported window. */
  modelContextWindows?: Record<string, number>;
  /** Model-specific Codex catalog input modalities, e.g. ["text"] or ["text", "image"]. */
  modelInputModalities?: Record<string, string[]>;
  /** Model-specific max input token limits. Values cap auto_compact_token_limit. */
  modelMaxInputTokens?: Record<string, number>;
  /**
   * Provider-wide fallback for chat-completions `max_tokens` when the caller omits
   * Responses `max_output_tokens`. Adapters still let an explicit request win.
   */
  defaultMaxOutputTokens?: number;
  /** Model-specific fallback output token budgets. Exact/model-pattern entries beat the provider default. */
  modelMaxOutputTokens?: Record<string, number>;
  headers?: Record<string, string>;
  /** Default provider-routing preferences for models sent through the canonical OpenRouter API. */
  openRouterRouting?: OpenRouterProviderRouting;
  /** Exact model-id overrides for `openRouterRouting`. Each matching entry replaces the default. */
  modelOpenRouterRouting?: Record<string, OpenRouterProviderRouting>;
  /**
   * "key" (default): authenticate upstream with `apiKey`.
   * "forward": relay the caller's incoming auth headers verbatim (OAuth passthrough; gpt only).
   * "oauth": resolve a stored OAuth access token (auto-refreshed) and use it as the Bearer key.
   * Only the openai-responses adapter implements "forward"; openai-chat uses its own key/token.
   * "local": local runtime (Ollama etc.) — no remote key required. Valid only for
   * providers whose registry entry declares authKind "local" (management API enforces).
   */
  authMode?: "key" | "forward" | "oauth" | "local";
  /** Allow an explicitly key/oauth provider to run without a credential (for keyless local proxies). */
  keyOptional?: boolean;
  /**
   * Free-tier pricing flag for UI/catalog (Free badge, Free filter). Not the same as
   * `keyOptional` — free tiers may still require an API key (e.g. NVIDIA NIM free credits).
   */
  freeTier?: boolean;
  /** Optional human note shown in the providers UI (not used for routing). */
  note?: string;
  /** Strip one trailing bracketed suffix from model ids before sending them upstream. */
  modelSuffixBracketStrip?: boolean;
  /**
   * Override the guardian's proactive-refresh policy for this provider. When unset, the provider's
   * built-in risk-tiered default applies (see OAUTH_PROVIDERS in src/oauth/index.ts). Set "proactive"
   * to opt this provider into background refresh; "disabled"/"lazy-only" to forbid/limit it.
   */
  refreshPolicy?: RefreshPolicy;
  /**
   * Provider-wide Codex-visible reasoning tiers for routed models. Use only Codex-supported labels
   * here (`low`, `medium`, `high`, `xhigh`, `max`); translate provider aliases with
   * `reasoningEffortMap` / `modelReasoningEffortMap` below.
   */
  reasoningEfforts?: string[];
  /** Model-specific Codex-visible reasoning tiers. An empty array means “do not expose effort”. */
  modelReasoningEfforts?: Record<string, string[]>;
  /** Model-specific default Codex reasoning tier; must also be present in the visible tier list. */
  modelDefaultReasoningEfforts?: Record<string, string>;
  /**
   * Model-specific Codex reasoning-summary capability. Set false when an OpenAI-compatible
   * Responses backend rejects Codex summary-delivery fields for that model.
   */
  modelSupportsReasoningSummaries?: Record<string, boolean>;
  /**
   * Per-model wire value for Responses `stream_options.reasoning_summary_delivery`.
   * Presence also advertises reasoning-summary support for that routed model.
   */
  modelReasoningSummaryDelivery?: Record<string, ReasoningSummaryDelivery>;
  /**
   * Exact-model hosted tools that win collisions with Codex client tool declarations.
   * Use for non-forward Responses gateways that reserve a hosted tool namespace server-side.
   */
  modelPreferHostedTools?: Record<string, string[]>;
  /**
   * Provider-local repair for Responses gateways whose lifecycle snapshots omit canonical
   * fields or closing events (#893). Disabled by default and applied only to client-facing
   * SSE/JSON; raw inspection state remains authoritative.
   */
  responsesSnapshotRepair?: boolean;
  /** Provider-wide mapping from Codex effort labels to upstream `reasoning_effort` values. */
  reasoningEffortMap?: Record<string, string>;
  /** Model-specific mapping from Codex effort labels to upstream `reasoning_effort` values. */
  modelReasoningEffortMap?: Record<string, Record<string, string>>;
  /** OpenAI-compatible gateway reasoning wire shape. Default sends `reasoning_effort`. */
  reasoningWireFormat?: "gateway-object";
  /**
   * Model ids that do NOT support a reasoning/thinking parameter. The openai-chat adapter drops
   * reasoning_effort for these even when Codex selects a reasoning level (e.g. xAI grok-build-0.1).
   */
  noReasoningModels?: string[];
  /** Model ids that reject caller-specified temperature. */
  noTemperatureModels?: string[];
  /** Model ids that reject caller-specified top_p. */
  noTopPModels?: string[];
  /** Model ids that reject caller-specified presence/frequency penalty values. */
  noPenaltyModels?: string[];
  /**
   * Allow multiple tool calls per completion. DEFAULT-ON for openai-chat providers (the
   * buffered stream parser assembles interleaved/fragmented multi-call turns safely);
   * set `false` to force `parallel_tool_calls:false` upstream and drop the catalog's
   * `supports_parallel_tool_calls` bit for that provider. Non-chat adapters advertise
   * only on explicit `true`. See devlog/_plan/260709_parallel_tool_calls.
   */
  parallelToolCalls?: boolean;
  /**
   * Opt-in: forward `prompt_cache_key` to the upstream `/chat/completions` body.
   * OpenAI-specific extension; strict backends (Groq, Cerebras, etc.) reject unknown
   * fields. Default off; only enable for providers that document this parameter.
   */
  promptCacheKey?: boolean;
  /**
   * Provider-local passthrough SSE repair for broken openai-responses gateways that reuse exact
   * placeholder message/reasoning ids or omit the terminal id after a stable added event.
   * Disabled by default; function_call ids and call_id pairing are never rewritten.
   */
  responsesItemIdRepair?: ResponsesItemIdRepairConfig;
  /** Model ids whose tool_choice only accepts `auto` or `none`; forced/named choices are downgraded. */
  autoToolChoiceOnlyModels?: string[];
  /** Model ids that expect prior assistant `reasoning_content` to be preserved in chat history. */
  preserveReasoningContentModels?: string[];
  /**
   * Opt-in same-target 429 retry policy. Codex itself never retries 429 (it retries 5xx only,
   * openai/codex#30471), and single-key pools have no failover, so the proxy waits and replays
   * the identical request on the same key before any failover. Pre-stream only: a 429 arrives
   * before any response bytes are relayed, so the replay is lossless.
   */
  retryOn429?: RateLimitRetryPolicy;
  /**
   * Model ids whose OpenAI-compatible chat endpoint accepts `reasoning_split: true` and returns
   * thinking separately in `reasoning_content` / `reasoning_details` instead of visible content.
   */
  reasoningSplitModels?: string[];
  /**
   * Model ids whose reasoning is a vendor `thinking: {type}` toggle on the
   * chat-completions wire (MiMo v2.x, GLM 5/5.1 style), NOT an OpenAI `reasoning_effort` ladder.
   * The openai-chat adapter translates the mapped effort into the thinking toggle for these.
   */
  thinkingToggleModels?: string[];
  /**
   * Model ids whose reasoning is a `thinking_budget` integer on the chat-completions wire
   * (Qwen3.x style), NOT an OpenAI `reasoning_effort` ladder. The openai-chat adapter maps the
   * Codex effort to a budget fraction.
   */
  thinkingBudgetModels?: string[];
  /** Anthropic-compatible gateways that need custom tool names escaped on the wire. */
  escapeBuiltinToolNames?: boolean;
  /**
   * Anthropic-compatible gateways (e.g. AgentRouter) that may close the stream before
   * `message_stop`. With this enabled the adapter completes an otherwise-clean EOF only when
   * visible text was received or an open tool call has complete JSON-object arguments; all
   * other EOFs remain truncation errors. Absent = strict default behavior.
   */
  anthropicEofTolerance?: boolean;
  /**
   * Model ids that do NOT accept image inputs. The proxy gives them "eyes" via the vision sidecar:
   * attached images are described by a gpt vision model and replaced with text before the call.
   */
  noVisionModels?: string[];
  /**
   * Google adapter mode. "ai-studio" (default) = Generative Language API + x-goog-api-key.
   * "vertex" = Vertex AI project/location endpoints with GCP ADC (or x-goog-api-key).
   * "cloud-code-assist" = Google Antigravity (Cloud Code Assist) OAuth + CCA envelope.
   */
  googleMode?: "ai-studio" | "vertex" | "cloud-code-assist";
  /** Vertex AI GCP project id (or GOOGLE_CLOUD_PROJECT / GCLOUD_PROJECT env). */
  project?: string;
  /** Vertex AI location, e.g. "us-central1" or "global" (or GOOGLE_CLOUD_LOCATION env). */
  location?: string;
  /**
   * Cursor adapter only: MCP servers opencodex starts/connects and exposes to the Cursor agent
   * as callable tools. Each entry is spawned (stdio `command`) or connected (`url`) lazily per
   * stream; their tools are advertised to the Cursor server and executed against the live server.
   */
  mcpServers?: Record<string, import("./adapters/cursor/mcp-config").CursorMcpServerConfig>;
  /**
   * Cursor adapter only: opt-in external executor for computer-use / record-screen. opencodex is
   * headless and cannot control a screen itself; provide commands here only when running on a host
   * that can. With no executor, these tools honestly report "not supported".
   */
  desktopExecutor?: import("./adapters/cursor/native-exec-desktop").DesktopExecutorConfig;
  /**
   * Cursor adapter only: unsafe opt-in escape hatch for Cursor server-driven built-in local
   * read/write/delete/ls/grep/shell/fetch execution. Prefer `nativeLocalExec: "on"` for new
   * configs; this legacy boolean remains a server-local explicit opt-in for existing operators.
   * Defaults to false so remote Cursor messages cannot bypass Codex approval/sandbox semantics.
   * Explicit MCP and desktop executors remain controlled by their own opt-in config.
   */
  unsafeAllowNativeLocalExec?: boolean;
  /**
   * Cursor adapter only: native local exec policy mode (exec-policy.ts).
   * "off" (default) rejects server-driven local exec; "on" always allows it for this
   * provider and should be used only for a trusted local experiment on a host where every
   * data-plane caller is trusted. "codex-sandbox" is accepted for backwards compatibility
   * but is fail-closed like "off": Responses instructions/system/developer text is
   * caller-controlled prose, and opencodex has no trustworthy per-request attestation that it
   * reflects a real Codex sandbox state. The default loopback bind admits ANY local process
   * without auth (including other local users on multi-user machines), and
   * isAllowedRequestOrigin blocks non-loopback browser origins by default but not
   * loopback-origin or origin-less callers.
   */
  nativeLocalExec?: "off" | "codex-sandbox" | "on";
}

export const REASONING_SUMMARY_DELIVERY_VALUES = [
  "sequential",
  "sequential_cutoff",
  "concurrent",
  "concurrent_cutoff",
] as const;

export type ReasoningSummaryDelivery = typeof REASONING_SUMMARY_DELIVERY_VALUES[number];

/** Trusted runtime ownership for Codex-account credentials. Never persisted per provider. */
export type CodexAccountMode = "direct" | "pool";

export const OPENAI_PROVIDER_TIER_VERSION = 2 as const;

/**
 * Wires that a per-model `modelAdapters` override may select.
 *
 * Deliberately narrow: provider-specific adapters (cursor, kiro, google, ...) carry
 * their own credential and base-URL semantics, so exposing them here would widen the
 * auth boundary rather than pick a wire. Widening this set needs a per-adapter
 * credential threat model first (#404).
 */
export const MODEL_ADAPTER_OVERRIDE_ALLOWED: ReadonlySet<string> = new Set([
  "openai-chat",
  "openai-responses",
]);

/**
 * Providers whose listed model ids must be driven over the Anthropic wire even when
 * the provider's configured adapter says otherwise — the upstream only speaks
 * Anthropic for these models.
 */
const ANTHROPIC_WIRE_MODELS: Record<string, ReadonlySet<string>> = {
  "opencode-go": new Set(["minimax-m2.5", "minimax-m2.7", "minimax-m3"]),
};

/**
 * True when the upstream speaks exactly one wire for this model, so a configured
 * override must not apply.
 *
 * Deliberately independent of the provider's current adapter: the wire resolver runs
 * more than once per request, and a check phrased as "pin differs from the current
 * adapter" would pass on the first pass and then let the override win on the second.
 */
export function isWirePinnedModel(providerName: string, modelId: string): boolean {
  return ANTHROPIC_WIRE_MODELS[providerName]?.has(modelId) ?? false;
}

/** The wire a pinned model must use, or undefined when the model is not pinned. */
export function pinnedWireAdapter(providerName: string, modelId: string): string | undefined {
  return isWirePinnedModel(providerName, modelId) ? "anthropic" : undefined;
}

export interface CodexAccount {
  id: string;
  email: string;
  /** User-owned display label; never participates in routing or identity checks. */
  alias?: string;
  plan?: string;
  chatgptAccountId?: string;
  logLabel?: string;
  isMain: boolean;
}

export interface CodexAccountCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  chatgptAccountId: string;
}

export interface CodexAccountCredentialRecord {
  credential?: CodexAccountCredentials;
  generation: number;
  refreshGrantFingerprint?: string;
  deletedAt?: number;
  replacedAt?: number;
  lastCodexValidatedAt?: number;
  lastCodexValidationStatus?: "ok" | "failed";
  lastCodexValidationError?: string;
}
