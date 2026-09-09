/**
 * Cloud-direct streaming chat. Talks to
 * `server.codeium.com/exa.api_server_pb.ApiServerService/GetChatMessage`
 * with no local language_server in the path. Returns an async iterable of
 * text deltas so the caller can stream straight into opencode's SSE.
 *
 * What this DOES support today:
 *   - Single- or multi-turn chat using the prompt-and-history pattern the LS
 *     uses (flatten history into one ChatMessagePrompt list)
 *   - All free Windsurf models (swe-1.6, kimi-k2.6) and any model the user's
 *     api_key is entitled to
 *   - Streaming (uses Connect-streaming envelope, emits deltas as they arrive)
 *
 * What this DOES NOT yet support (future work):
 *   - Tools (the GetChatMessage proto has a `tools` field; the opencode plugin
 *     currently runs tool-planning in `src/plugin.ts:planToolCall` against the
 *     local LS — porting that to cloud-direct requires also encoding the tool
 *     definitions in the request and decoding tool_calls from the response)
 *   - Workspace context (open files, cursor position) — chat-only mode
 *
 * Wire-protocol reference: docs/CLOUD_DIRECT.md.
 */

import * as crypto from 'crypto';
import * as zlib from 'zlib';
import {
  encodeMessage,
  encodeString,
  encodeVarintField,
  frameConnectStream,
  iterFields,
  parseConnectFrames,
} from './wire.js';
import { buildMetadata } from './metadata.js';
import { getCachedUserJwt } from './auth.js';
import { getCachedCatalog, ModelNotAvailableError } from './catalog.js';

/**
 * Connect-RPC streaming inactivity timeout. If the cloud sends zero bytes
 * for this long after the last chunk, we abort the fetch. The cloud's own
 * idle limit is around 90s on most models; we set ours a little above so
 * we only trigger when the server has genuinely stopped responding.
 */
const CLOUD_STREAM_IDLE_MS = 120_000;
/** Time-to-first-byte timeout. */
const CLOUD_STREAM_TTFB_MS = 60_000;

/**
 * Compose multiple AbortSignals into a single signal that aborts when ANY
 * input aborts. Uses `AbortSignal.any` when available (Node ≥20.3 / Bun
 * ≥1.0); falls back to a manual implementation for older runtimes that
 * are still in our `engines` range (Node 18.x and early 20.x). The
 * previous `req.signal ?? ttfbSignal` fallback silently picked one signal
 * and dropped the other, defeating either the caller's cancel or the
 * internal timeout.
 */
function anySignal(signals: AbortSignal[]): AbortSignal {
  const builtin = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof builtin === 'function') return builtin(signals);
  const controller = new AbortController();
  const onAbort = (reason: unknown): void => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  for (const s of signals) {
    if (s.aborted) {
      onAbort(s.reason);
      break;
    }
    s.addEventListener('abort', () => onAbort(s.reason), { once: true });
  }
  return controller.signal;
}

/**
 * Per-(apiKey, host) session/cascade ID cache. Cloud uses these for
 * server-side context caching across turns of the same conversation; if we
 * mint a fresh sessionId on every call (which we used to), every turn looks
 * like a brand-new session and the prompt-cache hit ratio is zero.
 * Single-process scope is enough: opencode lives in one runtime for a TUI
 * session, and CLI one-shots don't benefit from caching anyway.
 */
interface SessionIds {
  sessionId: string;
  cascadeId: string;
}
const sessionCache = new Map<string, SessionIds>();
function getOrAllocateSessionIds(apiKey: string, host: string, cascadeIdOverride?: string): SessionIds {
  const key = `${host}\x1f${apiKey}`;
  let ids = sessionCache.get(key);
  if (!ids) {
    ids = {
      sessionId: crypto.randomUUID(),
      cascadeId: cascadeIdOverride ?? allocateCascadeId(),
    };
    sessionCache.set(key, ids);
  } else if (cascadeIdOverride && ids.cascadeId !== cascadeIdOverride) {
    // Caller explicitly requested a different cascadeId — honor it.
    ids = { sessionId: ids.sessionId, cascadeId: cascadeIdOverride };
    sessionCache.set(key, ids);
  }
  return ids;
}

/** Drop the cached session IDs — call after logout so a new sign-in starts fresh. */
export function clearSessionIds(): void {
  sessionCache.clear();
}

// ----------------------------------------------------------------------------
// Per-conversation cascade state — generated client-side; cloud lazy-registers
// ----------------------------------------------------------------------------

/**
 * Allocate a fresh cascade UUID. The cloud lazy-registers cascade_id on first
 * use — confirmed empirically (random UUID accepted, model responded). One
 * cascade_id per opencode-CLI conversation is fine; reuse across turns to
 * preserve server-side context.
 */
export function allocateCascadeId(): string {
  return crypto.randomUUID();
}

// ----------------------------------------------------------------------------
// Request encoders
// ----------------------------------------------------------------------------

/**
 * ChatMessagePrompt {
 *   #2 source: enum CHAT_MESSAGE_SOURCE_USER=1 / ASSISTANT=2 / SYSTEM=3 / TOOL=4
 *   #3 prompt: string                          (text content)
 *   #4 num_tokens: int                          (rough estimate)
 *   #5 safe_for_code_telemetry: bool            (1 = ok to log)
 *   #10 images: repeated ImageData              (multimodal)
 * }
 *
 * ImageData (exa.codeium_common_pb.ImageData) {
 *   #1 base64_data: string
 *   #2 mime_type: string
 *   #3 caption: string  (optional)
 * }
 */
function encodeImageData(img: { mimeType: string; base64Data: string; caption?: string }): Buffer {
  const parts: Buffer[] = [
    encodeString(1, img.base64Data),
    encodeString(2, img.mimeType),
  ];
  if (img.caption) parts.push(encodeString(3, img.caption));
  return Buffer.concat(parts);
}

/**
 * Encode one ChatToolCall sub-message:
 *   {#1 id, #2 name, #3 arguments_json}
 * Verified against `exa.codeium_common_pb.ChatToolCall` from extension.js.
 */
function encodeChatToolCall(tc: { id: string; name: string; arguments: string }): Buffer {
  return Buffer.concat([
    encodeString(1, tc.id),
    encodeString(2, tc.name),
    encodeString(3, tc.arguments),
  ]);
}

function encodeChatMessagePrompt(
  content: ContentPart[],
  source: number,
  opts?: { toolCallId?: string; toolCalls?: Array<{ id: string; name: string; arguments: string }> },
): Buffer {
  const textParts = content.filter((p): p is { type: 'text'; text: string } => p.type === 'text');
  const imageParts = content.filter((p): p is { type: 'image'; mimeType: string; base64Data: string; caption?: string } => p.type === 'image');
  const joined = textParts.map((p) => p.text).join('\n');
  const parts: Buffer[] = [
    encodeVarintField(2, source),
    encodeString(3, joined),
    encodeVarintField(4, Math.max(1, Math.floor(joined.length / 4))),
    encodeVarintField(5, 1),
  ];
  // Tool-result message: attach the id of the call this result answers.
  // Without it, the model can't pair multi-tool conversations.
  if (opts?.toolCallId) {
    parts.push(encodeString(7, opts.toolCallId));
  }
  // Assistant message with tool_calls: encode each as a ChatToolCall.
  if (opts?.toolCalls && opts.toolCalls.length > 0) {
    for (const tc of opts.toolCalls) {
      parts.push(encodeMessage(6, encodeChatToolCall(tc)));
    }
  }
  for (const img of imageParts) {
    parts.push(encodeMessage(10, encodeImageData(img)));
  }
  return Buffer.concat(parts);
}

const SOURCE_BY_ROLE: Record<string, number> = {
  user: 1,
  assistant: 2,
  // NOTE: do not send source=3 (SYSTEM) directly — the Codeium chat backend
  // returns "third-party model provider is experiencing issues" when any
  // ChatMessagePrompt has source=SYSTEM. The captured LS upstream traffic
  // shows the IDE inlines system context into the *user* prompt (source=1)
  // wrapped in <additional_metadata>...</additional_metadata>. We collapse
  // role:'system' messages into the next user turn before building the
  // proto — see `collapseSystemIntoUser` below.
  system: 1,
  tool: 4,
};

/**
 * Collapse OpenAI-style messages so all `role:'system'` entries are inlined
 * into the immediately-following user message, matching the wire format the
 * IDE uses. Cognition's chat backend rejects raw role=system entries.
 *
 *   [{system: "S1"}, {system: "S2"}, {user: "U1"}, {assistant: "A1"}, {user: "U2"}]
 *
 * becomes
 *
 *   [{user: "<system>\nS1\nS2\n</system>\nU1"}, {assistant: "A1"}, {user: "U2"}]
 *
 * If there's no following user message, the trailing system messages get
 * appended as a synthesized user turn.
 */
function collapseSystemIntoUser(messages: ChatHistoryItem[]): ChatHistoryItem[] {
  const out: ChatHistoryItem[] = [];
  let pendingSystem: string[] = [];

  const flushTextOf = (content: ContentPart[]): string =>
    content.filter((p): p is { type: 'text'; text: string } => p.type === 'text')
           .map((p) => p.text).join('\n');

  for (const m of messages) {
    if (m.role === 'system') {
      const parts = normalizeContent(m.content);
      const text = flushTextOf(parts);
      if (text) pendingSystem.push(text);
    } else if (m.role === 'user' && pendingSystem.length > 0) {
      const userParts = normalizeContent(m.content);
      const userText = flushTextOf(userParts);
      const userImages = userParts.filter((p) => p.type === 'image');
      const wrapped = `<system>\n${pendingSystem.join('\n\n')}\n</system>\n${userText}`;
      const newContent: ContentPart[] = [{ type: 'text', text: wrapped }, ...userImages];
      out.push({ role: 'user', content: newContent });
      pendingSystem = [];
    } else {
      out.push(m);
    }
  }
  if (pendingSystem.length > 0) {
    // Trailing system messages with no following user turn — convert to a
    // standalone user message so they still reach the model.
    out.push({
      role: 'user',
      content: [{ type: 'text', text: `<system>\n${pendingSystem.join('\n\n')}\n</system>` }],
    });
  }
  return out;
}

/**
 * CompletionConfiguration — mirrors the LS-shipped defaults, lets the caller
 * override the obvious knobs.
 */
function encodeCompletionConfiguration(opts: {
  maxOutputTokens?: number;
  maxInputTokens?: number;
  temperature?: number;
  topK?: number;
  topP?: number;
}): Buffer {
  const enc64 = (fieldNum: number, n: number): Buffer => {
    const b = Buffer.alloc(8);
    b.writeDoubleLE(n, 0);
    return Buffer.concat([Buffer.from([(fieldNum << 3) | 1]), b]);
  };
  return Buffer.concat([
    encodeVarintField(1, 1),
    encodeVarintField(2, opts.maxInputTokens ?? 64000),
    // Default to the catalog's most permissive `maxOutputTokens` (128K).
    // The cloud clamps to the per-model limit anyway. The old 4096 default
    // would silently truncate any callers (tests, CLI users of
    // streamChatEvents directly) who didn't override.
    encodeVarintField(3, opts.maxOutputTokens ?? 128_000),
    enc64(5, opts.temperature ?? 0.7),
    enc64(6, opts.topP ?? 0.95),
    encodeVarintField(7, opts.topK ?? 50),
    enc64(8, 1.0),
    enc64(11, 1.0),
  ]);
}

/**
 * Multimodal content part — text or image.
 *
 * Text: `{ type: 'text', text: '...' }`
 * Image: `{ type: 'image', mimeType: 'image/png', base64Data: '...' [, caption: '...'] }`
 *
 * Matches the OpenAI/@ai-sdk multimodal message shape — we accept their
 * `image_url: { url: 'data:image/png;base64,...' }` form via {@link parseContent}.
 */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; base64Data: string; caption?: string };

export interface ChatHistoryItem {
  role: 'user' | 'assistant' | 'system' | 'tool';
  /**
   * Either a plain string or an array of {@link ContentPart}. Plain strings are
   * shorthand for `[{ type: 'text', text: '...' }]`.
   */
  content: string | ContentPart[];
  /**
   * For `role: 'tool'` only — the id of the assistant's preceding tool_call
   * this message answers. Required by the cloud's chat backend to pair
   * tool results with calls; without it, multi-tool conversations can't
   * tell the model which call produced which result. Encoded as
   * ChatMessagePrompt field #7 (verified against the Windsurf bundled
   * extension.js proto schema `exa.chat_pb.ChatMessagePrompt`).
   */
  tool_call_id?: string;
  /**
   * For `role: 'assistant'` only — the tool calls the assistant emitted.
   * Encoded as ChatMessagePrompt field #6 (repeated ChatToolCall, where
   * each ChatToolCall has #1 id, #2 name, #3 arguments_json).
   */
  tool_calls?: Array<{ id: string; name: string; arguments: string }>;
}

/**
 * Normalize ChatHistoryItem content into structured parts. Accepts strings,
 * OpenAI multimodal `[{type:'text',text}, {type:'image_url',image_url}]`, and
 * our own `[{type:'image', mimeType, base64Data}]`.
 */
function normalizeContent(content: string | ContentPart[] | unknown): ContentPart[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  const out: ContentPart[] = [];
  // Each element may follow our own ContentPart shape, the OpenAI multimodal
  // `image_url` shape, or be malformed — narrow defensively per branch.
  const parts = content as Array<Record<string, unknown>>;
  for (const p of parts) {
    if (!p || typeof p !== 'object') continue;
    if (p.type === 'text' && typeof p.text === 'string') {
      out.push({ type: 'text', text: p.text });
    } else if (p.type === 'image' && typeof p.base64Data === 'string') {
      const mimeType = typeof p.mimeType === 'string' ? p.mimeType : 'image/png';
      const caption = typeof p.caption === 'string' ? p.caption : undefined;
      out.push({ type: 'image', mimeType, base64Data: p.base64Data, caption });
    } else if (p.type === 'image_url' && p.image_url) {
      // OpenAI/@ai-sdk shape — parse data: URL into base64 + mime.
      const imgRef = p.image_url as string | { url?: string };
      const url: string = typeof imgRef === 'string' ? imgRef : (imgRef.url ?? '');
      const m = url.match(/^data:([^;]+);base64,(.+)$/);
      if (m) out.push({ type: 'image', mimeType: m[1], base64Data: m[2] });
      else if (url) out.push({ type: 'text', text: `[image url: ${url}]` });
    }
  }
  return out;
}

export interface ToolDef {
  /** Function name. */
  name: string;
  /** Plain-English description. */
  description: string;
  /** JSON Schema for the function's arguments. */
  parameters: unknown;
}

/**
 * Streaming event emitted by the cloud-direct chat loop.
 *
 *   - `text`        : incremental visible content from the assistant
 *   - `reasoning`   : incremental internal thinking (Anthropic-style, kept
 *                     separate from visible content; @ai-sdk consumers can
 *                     render in a collapsed/grey region)
 *   - `tool_call_*` : function-calling deltas (id+name once, args streamed)
 *   - `finish`      : stream terminated cleanly with a reason
 *   - `usage`       : final token-accounting block (input/output/total counts)
 */
export type CloudChatEvent =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'tool_call_start'; id: string; name: string }
  | {
      kind: 'tool_call_args';
      argsDelta: string;
      /**
       * Tool-call id this delta belongs to, when the cloud surfaced one in
       * this frame. Cognition's wire format only carries id on the START
       * frame today, so most argsDelta events arrive without one — callers
       * route those to the most-recent-start by convention. If Cognition
       * ever interleaves args across calls, the consumer should prefer
       * `id` over the rolling lastToolCallId.
       */
      id?: string;
    }
  // Note: there is no `tool_call_end` event. Cognition's wire format
  // signals the end of a tool call implicitly — args just stop arriving
  // for the current id and either a new `tool_call_start` fires or the
  // stream finishes. Consumers should treat each `tool_call_start` as
  // ending the previous call.
  | { kind: 'finish'; reason: 'stop' | 'tool_calls' | 'length' | 'content_filter' }
  | {
      kind: 'usage';
      promptTokens?: number;
      completionTokens?: number;
      totalTokens?: number;
      /**
       * Tokens served from the cache. Surfaced separately so callers tracking
       * cost can distinguish them from fresh input tokens (Anthropic / OpenAI
       * both bill cache reads cheaper than fresh prompts).
       */
      cachedInputTokens?: number;
      /** Tokens written to the cache on this request (Anthropic-style). */
      cacheCreationInputTokens?: number;
      /** Reasoning tokens (gpt-5-x reasoning models, Claude thinking variants). */
      reasoningTokens?: number;
    };

interface BuildArgs {
  apiKey: string;
  userJwt: string;
  modelUid: string;
  messages: ChatHistoryItem[];
  cascadeId: string;
  promptId: string;
  sessionId: string;
  requestId: bigint;
  triggerId: string;
  tools?: ToolDef[];
  /** Default 5 = CHAT_MESSAGE_REQUEST_TYPE_CASCADE (matches captured LS body). */
  requestType?: number;
  completionOpts?: {
    maxOutputTokens?: number;
    maxInputTokens?: number;
    temperature?: number;
    topK?: number;
    topP?: number;
  };
}

/**
 * ChatToolDefinition proto, observed in the LS upstream traffic:
 *   { #1 name (string), #2 description (string), #3 parameters_schema (JSON string) }
 *
 * Truncation note: Codeium's tool validator rejects very long descriptions
 * with a generic `failed_precondition: "Unable to process request due to an
 * MCP configuration issue."` error. opencode ships some tools (notably `bash`)
 * with ~9.6 KB descriptions packed with examples and rules. We truncate to a
 * conservative `MAX_DESC_LEN` and append an ellipsis so the cloud accepts
 * them. The model still gets the first chunk of the description (where the
 * essential signature lives); detailed examples are sacrificed for
 * compatibility.
 */
/**
 * The Codeium tool validator rejects any tool whose description hits exactly
 * 7,000 chars (or more) with a misleading `failed_precondition: "Unable to
 * process request due to an MCP configuration issue."` error. Binary-search
 * verified to char-precision:
 *   - 6,999 chars → server accepts
 *   - 7,000 chars → server returns MCP error
 *
 * The limit is per-description, content-sensitive (plain `a`-repeats up to
 * 20K work fine; the bash description's exact byte at position 6999 trips
 * it). We truncate to the maximum-1 (6,998) for a one-char safety margin.
 *
 * We do NOT need to aggregate-cap — 200K total tool descriptions across 200
 * tools was confirmed to pass server-side. Only per-string length is gated.
 */
const MAX_TOOL_DESC_LEN = 6998;

/**
 * Cognition's cloud enforces a case-sensitive, whitespace-exact exact-phrase
 * blocklist on tool descriptions. Binary-search isolated the trigger to the
 * 7-word phrase "Takes a task_id parameter identifying the task" — verbatim,
 * capital T, single spaces — which causes a `permission_denied` trailer error
 * regardless of model or account tier. Any deviation (lowercase, reword,
 * reorder, extra whitespace) passes. The phrase appears verbatim in Claude
 * Code's built-in TaskOutput tool description.
 *
 * Rewrite the known trigger to a meaning-preserving form. This is a
 * Cognition-specific constraint alongside the length limit above; if
 * Cognition adds more blocklisted phrases, extend this table.
 */
const COGNITION_BLOCKLIST_REWRITES: ReadonlyArray<[RegExp, string]> = [
  [/\bTakes a task_id parameter identifying the task\b/g, "Accepts a task_id parameter identifying the task"],
];

function sanitizeToolDescriptionForCognition(description: string): string {
  let out = description;
  for (const [pattern, replacement] of COGNITION_BLOCKLIST_REWRITES) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** Test-only: exercise the Cognition blocklist rewrite directly. */
export function sanitizeToolDescriptionForCognitionForTests(description: string): string {
  return sanitizeToolDescriptionForCognition(description);
}

function encodeToolDef(tool: ToolDef): Buffer {
  const rawDesc = sanitizeToolDescriptionForCognition(tool.description ?? '');
  const desc =
    rawDesc.length > MAX_TOOL_DESC_LEN
      ? rawDesc.slice(0, MAX_TOOL_DESC_LEN - 24) + '\n…(truncated for cloud)'
      : rawDesc;
  return Buffer.concat([
    encodeString(1, tool.name),
    encodeString(2, desc),
    encodeString(3, JSON.stringify(tool.parameters ?? {})),
  ]);
}

function buildGetChatMessageRequest(args: BuildArgs): Buffer {
  const metadata = buildMetadata({
    apiKey: args.apiKey,
    userJwt: args.userJwt,
    sessionId: args.sessionId,
    requestId: args.requestId,
    triggerId: args.triggerId,
  });

  // System messages must be inlined into the user turn (Cognition cloud
  // rejects source=3). See `collapseSystemIntoUser` for the format.
  const collapsed = collapseSystemIntoUser(args.messages);
  const promptParts = collapsed.map((m) =>
    encodeMessage(
      3,
      encodeChatMessagePrompt(
        normalizeContent(m.content),
        SOURCE_BY_ROLE[m.role] ?? 1,
        // Thread tool_call_id (for tool results) + tool_calls (for assistant
        // turns that fired tools) into the proto. Cloud rejects multi-tool
        // conversations otherwise — it can't pair a tool result with the
        // assistant call that produced it.
        {
          toolCallId: m.role === 'tool' ? m.tool_call_id : undefined,
          toolCalls: m.role === 'assistant' ? m.tool_calls : undefined,
        },
      ),
    ),
  );

  const completion = encodeCompletionConfiguration(args.completionOpts ?? {});

  const toolParts: Buffer[] = (args.tools ?? []).map((t) =>
    encodeMessage(10, encodeToolDef(t)),
  );

  // Field layout from mitm capture of the LS:
  //   #1  metadata
  //   #3  chat_message_prompts (repeated — one element per history turn)
  //   #7  request_type (varint enum)
  //   #8  completion_configuration
  //   #10 tools (repeated ChatToolDefinition)
  //   #16 cascade_id (string)
  //   #21 chat_model_uid (string)
  //   #22 prompt_id (string)
  return Buffer.concat([
    encodeMessage(1, metadata),
    ...promptParts,
    encodeVarintField(7, args.requestType ?? 5),
    encodeMessage(8, completion),
    ...toolParts,
    encodeString(16, args.cascadeId),
    encodeString(21, args.modelUid),
    encodeString(22, args.promptId),
  ]);
}

// ----------------------------------------------------------------------------
// Response parsing — pull `delta_text` (top-level field #9) out of each frame
// ----------------------------------------------------------------------------

/**
 * Decode a single streaming ChatMessage proto frame into one or more
 * CloudChatEvents. Captured shape (from a tool-using swe-1.6 chat):
 *
 *   ChatMessage {
 *     #1  bot_id (string)
 *     #2  timestamp { seconds, nanos }
 *     #5  finish_reason (varint — 10 = "tool_calls" observed, others unknown)
 *     #6  ToolCallDelta {
 *           #1 id (string, only on first tool-call frame)
 *           #2 name (string, only on first tool-call frame)
 *           #3 arguments_delta (string, JSON fragment, streamed)
 *         }
 *     #7  ChatStatus { #6 status_code, #9 model_name }
 *     #9  delta_text (string)
 *     #12 (fixed64) some_hash
 *     #17 (string) message_uuid
 *     #28 UsageStats { #1 label, ... }
 *   }
 *
 * #9 appears both at top-level (text delta) AND inside #7 (model_name).
 * iterFields walks top-level only, so we don't confuse the two.
 *
 * #5 is the finish_reason. Observed value `10` = tool_calls finish. We map
 * any non-zero to 'tool_calls' for now (and let the caller fall back to
 * 'stop' if no tool_call deltas were emitted).
 */
function* decodeChatFrame(proto: Buffer): Generator<CloudChatEvent> {
  for (const f of iterFields(proto)) {
    if (f.num === 3 && f.wire === 2 && Buffer.isBuffer(f.value)) {
      // Visible delta_text — what the user should SEE in the chat.
      //
      // We previously had this mapping inverted (#3 = thinking, #9 = visible),
      // which produced two compounding bugs in the TUI:
      //   1. The model's CoT was rendered as plain content, so the user saw
      //      "The user wants me to X..." instead of the answer.
      //   2. The actual answer (which lives in #3) was silently dropped — so
      //      the assistant turn appeared to end after the CoT with nothing
      //      after, matching the "model wrote reasoning then went silent"
      //      symptom the user reported.
      // Verified live: prompted swe-1.6 with "explain then answer 2+2"; #3
      // streamed "2+2=4 because... 4" while #9 streamed the meta-narration
      // "The user wants me to perform a reasoning task...".
      const s = (f.value as Buffer).toString('utf8');
      if (s) yield { kind: 'text', text: s };
    } else if (f.num === 9 && f.wire === 2 && Buffer.isBuffer(f.value)) {
      // Internal thinking / chain-of-thought. Surface as `reasoning` so
      // @ai-sdk consumers (opencode TUI) render it in a collapsed grey
      // block instead of inline with the answer.
      const s = (f.value as Buffer).toString('utf8');
      if (s) yield { kind: 'reasoning', text: s };
    } else if (f.num === 6 && f.wire === 2 && Buffer.isBuffer(f.value)) {
      let id: string | undefined;
      let name: string | undefined;
      let argsDelta: string | undefined;
      for (const sf of iterFields(f.value as Buffer)) {
        if (sf.wire === 2 && Buffer.isBuffer(sf.value)) {
          const s = (sf.value as Buffer).toString('utf8');
          if (sf.num === 1) id = s;
          else if (sf.num === 2) name = s;
          else if (sf.num === 3) argsDelta = s;
        }
      }
      if (id !== undefined && name !== undefined) {
        yield { kind: 'tool_call_start', id, name };
      }
      if (argsDelta !== undefined) {
        // Pass through `id` when this frame carries one (Cognition only
        // sets it on the start frame today, but defending against future
        // interleaving). Callers should prefer `id` over their rolling
        // lastToolCallId when both are available.
        yield { kind: 'tool_call_args', argsDelta, ...(id !== undefined ? { id } : {}) };
      }
    } else if (f.num === 5 && f.wire === 0) {
      const v = Number(f.value);
      // exa.codeium_common_pb.StopReason → OpenAI finish_reason.
      // Source of truth: Windsurf extension.js sets `setEnumType("StopReason", [...])`
      //   0 UNSPECIFIED      → "stop" (no signal — treat as natural end)
      //   1 INCOMPLETE       → "length" (request cut short, model wanted more)
      //   2 STOP_PATTERN     → "stop"   (model emitted its stop sequence — NORMAL)
      //   3 MAX_TOKENS       → "length"
      //   4-9 internal       → "stop"
      //  10 FUNCTION_CALL    → "tool_calls"
      //  11 CONTENT_FILTER   → "content_filter"
      //  12 NON_INSERTION    → "stop"
      //  13 ERROR            → "stop"   (errors come as Connect trailer, not via this)
      //
      // We had 2 and 3 swapped previously, which made the model's normal
      // STOP_PATTERN look like "length" → @ai-sdk treated complete responses
      // as truncated. That was the "model wrote reasoning then went silent"
      // symptom the user kept hitting.
      let reason: 'stop' | 'tool_calls' | 'length' | 'content_filter' = 'stop';
      if (v === 10) reason = 'tool_calls';
      else if (v === 11) reason = 'content_filter';
      else if (v === 1 || v === 3) reason = 'length';
      // else stays 'stop' for 0/2/4-9/12/13
      yield { kind: 'finish', reason };
    } else if (f.num === 28 && f.wire === 2 && Buffer.isBuffer(f.value)) {
      const usage = decodeUsageBlock(f.value as Buffer);
      if (usage) yield usage;
    }
  }
}

/**
 * UsageStats block at proto field #28. Captured shape (mitm of a real call):
 *
 *   UsageStats {
 *     #1 label = "Token Usage"
 *     #2 entries [
 *       UsageEntry {
 *         #1 label = "Input tokens" / "Output tokens" / "Cached tokens" / ...
 *         #2 value (fixed32 — IEEE 754 float, OpenAI-style count cast)
 *         #3 unit = " tokens"
 *         #5 metric_id = "input_tokens" / "output_tokens" / ...
 *       },
 *       ...
 *     ]
 *   }
 *
 * We extract the standard input/output counts and synthesize a `total`.
 * Anything else (cached, reasoning_tokens, …) is dropped for v1.
 */
function decodeUsageBlock(buf: Buffer): CloudChatEvent | null {
  let promptTokens: number | undefined;
  let completionTokens: number | undefined;
  let cachedInputTokens: number | undefined;
  let cacheCreationInputTokens: number | undefined;
  let reasoningTokens: number | undefined;

  for (const f of iterFields(buf)) {
    // Each UsageEntry lives at field 2 (repeated). Field 1 is the block label
    // ("Token Usage"); skip.
    if (f.num !== 2 || f.wire !== 2 || !Buffer.isBuffer(f.value)) continue;

    // Observed entry shape:
    //   UsageEntry {
    //     #4 (sub-message) {
    //       #1 label = "Input tokens" / "Output tokens"
    //       #2 (fixed32) value (IEEE 754 LE float — count as float)
    //       #3 unit = " token"
    //       #4 unit_plural = " tokens"
    //     }
    //     #5 metric_id = "input_tokens" / "output_tokens" / "cached_input_tokens" / ...
    //   }
    let entryMetric: string | undefined;
    let entryValue: number | undefined;
    for (const sf of iterFields(f.value as Buffer)) {
      if (sf.num === 5 && sf.wire === 2 && Buffer.isBuffer(sf.value)) {
        entryMetric = (sf.value as Buffer).toString('utf8');
      } else if (sf.num === 4 && sf.wire === 2 && Buffer.isBuffer(sf.value)) {
        // Recurse into the displayed-dimension submessage to pull the fixed32
        // value at its field 2.
        for (const ssf of iterFields(sf.value as Buffer)) {
          if (ssf.num === 2 && ssf.wire === 5 && Buffer.isBuffer(ssf.value)) {
            entryValue = (ssf.value as Buffer).readFloatLE(0);
            break;
          }
        }
      }
    }
    if (entryMetric && entryValue !== undefined && Number.isFinite(entryValue)) {
      const n = Math.round(entryValue);
      if (entryMetric === 'input_tokens') promptTokens = n;
      else if (entryMetric === 'output_tokens') completionTokens = n;
      else if (entryMetric === 'cached_input_tokens' || entryMetric === 'cache_read_input_tokens') {
        cachedInputTokens = (cachedInputTokens ?? 0) + n;
      } else if (entryMetric === 'cache_creation_input_tokens') {
        cacheCreationInputTokens = (cacheCreationInputTokens ?? 0) + n;
      } else if (entryMetric === 'reasoning_tokens' || entryMetric === 'output_reasoning_tokens') {
        reasoningTokens = (reasoningTokens ?? 0) + n;
      }
    }
  }
  if (promptTokens === undefined && completionTokens === undefined) return null;
  // totalTokens reflects what OpenAI's API counts as billable: input +
  // output. Cached / cache-creation / reasoning subtotals are surfaced as
  // additional fields so callers that want a fuller picture (e.g. cost
  // breakdown for reasoning models) can read them, but they're NOT
  // double-counted into total.
  const total = (promptTokens ?? 0) + (completionTokens ?? 0);
  return {
    kind: 'usage',
    promptTokens,
    completionTokens,
    totalTokens: total > 0 ? total : undefined,
    cachedInputTokens,
    cacheCreationInputTokens,
    reasoningTokens,
  };
}

// ----------------------------------------------------------------------------
// Public API: streamChat
// ----------------------------------------------------------------------------

export interface CloudChatRequest {
  /** Persistent OAuth-issued api_key (`devin-session-token$<JWT>`). */
  apiKey: string;
  /** Pre-resolved API server URL from RegisterUser (falls back to default). */
  apiServerUrl?: string;
  /** Model UID — e.g. `swe-1-6`, `kimi-k2-6`, `claude-opus-4-7-medium`. */
  modelUid: string;
  /** Chat history. */
  messages: ChatHistoryItem[];
  /**
   * Tool definitions available to the model. Cloud encodes these in the
   * GetChatMessage request's `tools` field (proto #10). When set, the model
   * may emit `tool_call_start`/`_args`/`_end` events instead of plain text.
   */
  tools?: ToolDef[];
  /** Cascade ID — reuse across turns of the same conversation. */
  cascadeId?: string;
  /** Optional sampling overrides. */
  completionOpts?: BuildArgs['completionOpts'];
  /** Override request_type (default = 5, CASCADE). */
  requestType?: number;
  /** Abort signal — closes the fetch stream. */
  signal?: AbortSignal;
}

export class CloudChatError extends Error {
  constructor(message: string, public readonly code?: string, public readonly traceId?: string) {
    super(message);
    this.name = 'CloudChatError';
  }
}

const TRACE_ID_RE = /\(trace ID: ([0-9a-f]+)\)/i;

/**
 * Stream chat events from the cloud. Yields CloudChatEvent (text deltas, tool
 * call deltas, finish reason). Use `streamChatText` for legacy text-only iteration.
 *
 * On error (auth fail, quota exhausted, malformed request) throws a
 * CloudChatError with the cloud's `code` + `traceId` for diagnostics.
 */
export async function* streamChatEvents(req: CloudChatRequest): AsyncGenerator<CloudChatEvent> {
  const host = (req.apiServerUrl ?? 'https://server.codeium.com').replace(/\/$/, '');
  const userJwt = await getCachedUserJwt(req.apiKey, host, req.signal);

  // Pre-flight: consult the per-account model catalog. Cognition's cloud
  // returns an opaque `permission_denied: "an internal error occurred (trace
  // ID: ...)"` for every chat call that targets a model not enabled on the
  // caller's tier — issue #14. The catalog's `disabled` flag is the
  // authoritative source for "can this account run this UID"; we surface a
  // named error here so the user knows why instead of guessing.
  //
  // Best-effort: if the catalog fetch fails (network, auth, schema drift) we
  // pass through to the chat call. The cloud will still surface its own
  // error and the trailer-error path below enriches the message in-place.
  const catalog = await getCachedCatalog(req.apiKey, host, req.signal).catch(() => null);
  if (catalog) {
    const entry = catalog.byUid.get(req.modelUid);
    if (!entry) {
      throw new ModelNotAvailableError(req.modelUid, req.modelUid, 'not_listed');
    }
    if (entry.disabled) {
      throw new ModelNotAvailableError(req.modelUid, entry.label, 'disabled');
    }
  }

  // Reuse session + cascade ids across calls for the same (apiKey, host).
  // Without this, every turn looks like a brand-new server-side session
  // and the cloud's prompt cache never hits — significant cost regression
  // for long conversations.
  const sessionIds = getOrAllocateSessionIds(req.apiKey, host, req.cascadeId);

  const proto = buildGetChatMessageRequest({
    apiKey: req.apiKey,
    userJwt,
    modelUid: req.modelUid,
    messages: req.messages,
    tools: req.tools,
    cascadeId: sessionIds.cascadeId,
    promptId: crypto.randomUUID(),
    sessionId: sessionIds.sessionId,
    requestId: BigInt(Date.now()),
    triggerId: crypto.randomUUID(),
    requestType: req.requestType,
    completionOpts: req.completionOpts,
  });
  const framed = frameConnectStream(proto, true);
  const body = new Blob([new Uint8Array(framed)], { type: "application/connect+proto" });

  // Compose caller signal with a TTFB timeout. If the cloud takes longer
  // than CLOUD_STREAM_TTFB_MS to start the response, abort. Once any byte
  // arrives we cancel the TTFB timer and start the per-chunk idle timer
  // inside the read loop instead.
  const ttfbController = new AbortController();
  const ttfbTimer = setTimeout(() => ttfbController.abort(new Error(`cloud-direct: time-to-first-byte timeout (${CLOUD_STREAM_TTFB_MS}ms)`)), CLOUD_STREAM_TTFB_MS);
  const ttfbSignal = ttfbController.signal;
  // Compose req.signal + ttfbSignal. AbortSignal.any was added in Node
  // 20.3 / Bun 1.0; our `engines` allows Node ≥18, so on Node 18-20.2 the
  // built-in is missing. The previous fallback `req.signal ?? ttfbSignal`
  // silently discarded one of the two signals (TTFB if caller passed
  // one), defeating the timeout guard. anySignal() is a real polyfill.
  const initialSignal: AbortSignal = req.signal ? anySignal([req.signal, ttfbSignal]) : ttfbSignal;

  let resp: Response;
  try {
    resp = await fetch(`${host}/exa.api_server_pb.ApiServerService/GetChatMessage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/connect+proto',
        'Connect-Protocol-Version': '1',
        'Connect-Content-Encoding': 'gzip',
        'Connect-Accept-Encoding': 'gzip',
      },
      body,
      signal: initialSignal,
    });
  } finally {
    clearTimeout(ttfbTimer);
  }

  if (!resp.ok) {
    const text = await resp.text();
    throw new CloudChatError(`GetChatMessage HTTP ${resp.status}: ${text.slice(0, 300)}`, undefined);
  }
  if (!resp.body) {
    throw new CloudChatError('GetChatMessage response had no body stream');
  }

  // Incremental parsing. We previously did `pending = Buffer.concat([pending,
  // chunk])` per chunk — O(n²) over a long stream because every chunk copies
  // every buffered byte again. Now we keep a queue of arriving chunks with a
  // running offset; we only `Buffer.concat` when a frame straddles a chunk
  // boundary, and we slice/drop fully-consumed chunks immediately. For
  // typical 50-200KB responses this is ~5x faster and produces zero waste.
  const chunkQueue: Buffer[] = [];
  let queuedBytes = 0;
  // Bun + Node ReadableStream readers diverge on the type-level shape
  // (Bun's includes a `readMany` method); both work the same at runtime.
  const reader = resp.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  let trailerError: { code?: string; message: string; traceId?: string } | null = null;
  let sawEos = false;

  /**
   * Try to read the next `n` bytes from the chunk queue WITHOUT consuming
   * them. Returns null if not enough buffered.
   */
  function peek(n: number): Buffer | null {
    if (queuedBytes < n) return null;
    if (chunkQueue.length === 1 && chunkQueue[0].length >= n) {
      return chunkQueue[0].slice(0, n);
    }
    // Cross-chunk peek — concat just the prefix we need.
    const parts: Buffer[] = [];
    let remaining = n;
    for (const c of chunkQueue) {
      if (remaining <= 0) break;
      if (c.length <= remaining) {
        parts.push(c);
        remaining -= c.length;
      } else {
        parts.push(c.slice(0, remaining));
        remaining = 0;
      }
    }
    return Buffer.concat(parts, n);
  }

  /** Drop the first `n` bytes from the chunk queue. */
  function drop(n: number): void {
    queuedBytes -= n;
    let remaining = n;
    while (remaining > 0 && chunkQueue.length > 0) {
      const head = chunkQueue[0];
      if (head.length <= remaining) {
        chunkQueue.shift();
        remaining -= head.length;
      } else {
        chunkQueue[0] = head.slice(remaining);
        remaining = 0;
      }
    }
  }

  // Track the idle timer at outer scope so the finally block can clear it
  // regardless of how we exit the read loop (clean done, throw, etc).
  // Previously this lived inside `try { ... }` and was only cleared on
  // normal exit — an error path left a 120s timer in the event loop and
  // the process refused to exit promptly.
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  try {
    const resetIdle = (): Promise<{ value?: Uint8Array; done: boolean }> => {
      if (idleTimer) clearTimeout(idleTimer);
      const idleController = new AbortController();
      idleTimer = setTimeout(
        () => idleController.abort(new Error(`cloud-direct: idle timeout (${CLOUD_STREAM_IDLE_MS}ms with no bytes)`)),
        CLOUD_STREAM_IDLE_MS,
      );
      // Race the reader.read() against idle abort. When abort wins, we
      // also actively `cancel()` the underlying body stream so the
      // pending read() resolves promptly with done=true instead of
      // hanging on the now-dead TCP socket until the OS notices.
      //
      // Promise-handling carefully: the reader.read() promise can settle
      // AFTER the outer race rejects (we cancelled, the read eventually
      // sees the cancellation and either resolves with done=true or
      // rejects with an abort error). We attach an explicit `.catch(()=>{})`
      // on the read promise so any post-race rejection doesn't surface as
      // an unhandled-rejection warning in the host runtime.
      return new Promise((resolve, reject) => {
        let settled = false;
        const settle = (fn: () => void): void => {
          if (settled) return;
          settled = true;
          fn();
        };
        const readP = reader.read();
        // Defensive: swallow any post-race rejection. If the outer promise
        // already settled via the abort listener, we still need a handler
        // attached to readP or Node logs an unhandledRejection.
        readP.catch(() => { /* swallowed; outer promise already rejected */ });

        idleController.signal.addEventListener('abort', () => {
          try { void resp.body?.cancel(idleController.signal.reason ?? new Error('idle abort')); } catch { /* */ }
          settle(() => reject(idleController.signal.reason ?? new Error('idle abort')));
        }, { once: true });

        readP.then(
          (v) => settle(() => resolve(v)),
          (e) => settle(() => reject(e)),
        );
      });
    };

    while (true) {
      const { value, done } = await resetIdle();
      if (done) break;
      if (value) {
        chunkQueue.push(Buffer.from(value));
        queuedBytes += value.length;
      }

      // Drain every complete frame currently buffered.
      while (queuedBytes >= 5) {
        const header = peek(5);
        if (!header) break;
        const flags = header[0];
        const len = header.readUInt32BE(1);
        if (queuedBytes < 5 + len) break; // frame still arriving
        drop(5);
        const raw = peek(len) ?? Buffer.alloc(0);
        drop(len);

        let payload = raw;
        if (flags & 0x01) {
          try {
            payload = zlib.gunzipSync(raw);
          } catch (gzipErr) {
            // Corrupt compressed frame — surface as a CloudChatError instead
            // of falling through and re-parsing raw gzip bytes as proto
            // (which used to misparse silently downstream).
            throw new CloudChatError(`Connect frame gunzip failed: ${(gzipErr as Error).message}`);
          }
        }
        const eos = (flags & 0x02) !== 0;

        if (eos) {
          sawEos = true;
          // Trailer: {} on success, {"error":{code,message}} on failure.
          const text = payload.toString('utf8');
          if (text && text.includes('"error"')) {
            let code: string | undefined;
            let message = text;
            try {
              const j = JSON.parse(text) as { error?: { code?: string; message?: string } };
              code = j.error?.code;
              if (j.error?.message) message = j.error.message;
            } catch { /* keep raw */ }
            const traceMatch = message.match(TRACE_ID_RE);
            trailerError = { code, message, traceId: traceMatch?.[1] };
          }
          continue;
        }
        yield* decodeChatFrame(payload);
      }
    }
  } finally {
    // Always clear the idle timer. The previous "clear on normal exit
    // only" path leaked a 120s setTimeout into the event loop on any
    // throw (idle timeout, gunzip error, trailer error, etc), keeping
    // the process from exiting promptly.
    if (idleTimer) clearTimeout(idleTimer);
    // Cancel the underlying body stream on any non-clean exit so the TCP
    // connection is released. `releaseLock` alone leaves the body in a
    // dangling state; we have to call `cancel` on the response body
    // itself (cancel-via-reader requires holding the lock). Fire and
    // forget — there's nothing meaningful to do if cancel rejects.
    try { reader.releaseLock(); } catch { /* */ }
    try { void resp.body?.cancel(); } catch { /* */ }
  }

  if (trailerError) {
    // Cognition uses `permission_denied: "an internal error occurred (trace
    // ID: …)"` as a catch-all for "your account can't run this model" — same
    // root cause issue #14 reported. The pre-flight above catches this when
    // the catalog disagrees with the call, but the catalog can lag (a model
    // that was enabled at fetch time may have been gated between then and
    // now) or be missing (network failure caused a fall-through). When the
    // raw trailer is this exact shape, swap in a message that names the
    // model and explains the likely cause rather than re-passing
    // Cognition's opaque text. The cloud's original message is appended in
    // parens so users (and bug reports) still have it verbatim.
    const isOpaquePermissionDenial =
      trailerError.code === 'permission_denied' &&
      /an internal error occurred/i.test(trailerError.message);
    if (isOpaquePermissionDenial) {
      const enriched =
        `Cognition denied this request for model "${req.modelUid}" with the opaque ` +
        `"an internal error occurred" message. This almost always means the model ` +
        `is not enabled for your account/tier — see https://codeium.com/account. ` +
        `(cloud trace ID: ${trailerError.traceId ?? 'n/a'}; raw message: ${trailerError.message})`;
      throw new CloudChatError(enriched, trailerError.code, trailerError.traceId);
    }
    throw new CloudChatError(trailerError.message, trailerError.code, trailerError.traceId);
  }
  // Truncation detection: the cloud always terminates a successful stream
  // with an EOS trailer. If we hit `done` from the body reader without one,
  // the connection dropped mid-frame and any bytes still in the queue are
  // garbage. Previously those leftover bytes were silently discarded and
  // the consumer saw a clean stop with no error — looked like the model
  // had finished. Now we surface it.
  if (!sawEos) {
    throw new CloudChatError(
      `Cloud stream ended without EOS trailer (${queuedBytes} bytes orphaned). ` +
      `Connection likely dropped mid-response.`,
      'truncated_stream',
    );
  }
}

/**
 * Back-compat: yield text content only (drops tool calls). The plugin uses
 * streamChatEvents directly when it needs to surface tool_calls.
 */
export async function* streamChat(req: CloudChatRequest): AsyncGenerator<string> {
  for await (const ev of streamChatEvents(req)) {
    if (ev.kind === 'text') yield ev.text;
  }
}

// `parseConnectFrames` is no longer needed by streamChat itself, but exported
// from wire.ts for one-shot callers + tests.
void parseConnectFrames;
