import type { AdapterFetchContext, AdapterRequest, ProviderAdapter } from "./base";
import { debugDroppedFrame } from "../lib/debug";
import { createToolCallIdAllocator } from "./tool-call-id";
import { createImageBudget, materializeInlineImage, MAX_ENCODED_BYTES_PER_IMAGE, artifactHttpUrl } from "../images/artifacts";
import type {
  AdapterEvent,
  OcxAssistantMessage,
  OcxContentPart,
  OcxParsedRequest,
  OcxProviderConfig,
  OcxProviderOpaqueToolCallMetadata,
  OcxTextContent,
  OcxToolCall,
  OcxToolResultMessage,
  OcxUsage,
} from "../types";
import { isAllowedToolChoice, namespacedToolName, resolveToolChoiceWireName, toolChoiceToolPredicate } from "../types";
import { contentPartsToText, parseDataUrl } from "./image";
import { getVertexAccessToken } from "../lib/gcp-adc";
import { fetchAntigravityWithRetry, fetchVertexWithRetry } from "./google-http";
import { safeAntigravityHttpErrorMessage, safeVertexHttpErrorMessage } from "./google-errors";
import { isVertexTruncatedTurn, vertexTruncationErrorMessage } from "./google-truncation";
import { ANTIGRAVITY_REQUEST_UA, antigravitySessionId, isLikelyRealThoughtSignature, sanitizeAntigravityClaudeSignatures } from "./google-antigravity-wire";
import { compileGoogleWireBody } from "./google-wire-compiler";
import { identifyRoutedModel } from "./identity";
import {
  antigravityUsesReplayCache,
  applyAntigravityReplay,
  applyAntigravityThoughtSignatureFallback,
  clearAntigravityReplay,
  observeAntigravityReplay,
} from "./google-antigravity-replay";
import { canonicalAntigravityUsageModel, resolveAntigravityEffortWireModel } from "../providers/antigravity-models";
import { googleVertexLocationConfigError } from "../providers/google-vertex-location";
import { forgetThoughtSignatureForReplay, lookupReplayThoughtSignature } from "../responses/thought-signature-replay";
import {
  isTranslatorBudgetExceededError,
  retainTranslatedEventBatch,
  type TranslatorBudget,
} from "../lib/translator-budget";
import { buildNonOpenAIToolCatalogNudgeForTools } from "./tool-catalog-nudge";
import { configuredReasoningEfforts, mapReasoningEffort } from "../reasoning-effort";

// Google-family models (Gemini/Vertex/Antigravity) tend to emit long running commentary between
// tool calls. This steers them to keep the BETWEEN-STEP text to one line and reason internally
// while still driving tools to completion. The FINAL answer is explicitly exempt so task output is
// not truncated. Appended to systemInstruction for the `google` adapter only, so non-Google
// providers are unaffected.
const GOOGLE_BREVITY_INSTRUCTION = [
  "Output style for this session:",
  "- While you are still working (between tool calls), keep any text you emit to a single short line; do not narrate at length.",
  "- Do detailed reasoning internally, not as visible intermediate output.",
  "- Prefer taking the next tool action over explaining; keep calling tools until the task is complete.",
  "- This applies only to intermediate progress text. Your final answer after the work is done is exempt: write it in full and at whatever length the task requires.",
].join("\n");

const ANTIGRAVITY_REJECTED_CLAUDE_SDK_PARAGRAPH =
  "You are a Claude agent, built on Anthropic's Claude Agent SDK.";

/**
 * CCA Flash generations that reject the Claude-Agent identity paragraph.
 *
 * Membership is probe-established per generation, never assumed: 3.7 and 3.8 both answer
 * 429 RESOURCE_EXHAUSTED when this paragraph survives into `systemInstruction`, and 200 with
 * it stripped — same account, seconds apart. A policy rejection wearing a quota error's
 * clothing sends users hunting a quota problem that does not exist, so a new generation is
 * added here only after the probe, and never dropped on the assumption that Google fixed it.
 */
const ANTIGRAVITY_CLAUDE_SDK_PARAGRAPH_REJECTORS = new Set([
  "gemini-3.7-flash",
  "gemini-3.8-flash",
]);

/**
 * Whether CCA rejects the Claude-Agent identity paragraph for this request.
 *
 * Judged on the ROUTED WIRE id, not the selector, because three different selectors reach the
 * same rejecting generation:
 *
 * - the collapsed base (`gemini-3.8-flash`);
 * - a raw suffix id (`gemini-3.8-flash-high`), which the picker publishes whenever discovery
 *   returns a PARTIAL ladder;
 * - a RETIRED id (`gemini-3.6-flash`), which rule 0 redirects onto `gemini-3.7-flash-tiered`.
 *
 * That last one is why a selector-keyed test is not enough: retired ids deliberately keep their
 * own identity for usage accounting, so they never canonicalize into the generation they
 * actually call. A saved 3.6 selection was probed at 429 with the paragraph intact for exactly
 * this reason. Matching on the wire id also means a future generation is covered by naming its
 * wire spelling once, rather than every selector that can reach it.
 */
function rejectsClaudeSdkParagraph(modelId: string, wireModelId: string): boolean {
  const canonicalWire = canonicalAntigravityUsageModel(wireModelId.replace(/-tiered$/, ""));
  return ANTIGRAVITY_CLAUDE_SDK_PARAGRAPH_REJECTORS.has(canonicalWire)
    || ANTIGRAVITY_CLAUDE_SDK_PARAGRAPH_REJECTORS.has(canonicalAntigravityUsageModel(modelId));
}

function stripAntigravityRejectedClaudeSdkParagraph(systemText: string): string {
  return systemText
    .split("\n\n")
    .filter(paragraph => paragraph !== ANTIGRAVITY_REJECTED_CLAUDE_SDK_PARAGRAPH)
    .join("\n\n");
}

/**
 * Documented output ceiling for a Google-surface model, or `undefined` when the id is not
 * recognized.
 *
 * Unknown ids return `undefined` deliberately. An earlier revision returned a 16,384 floor for
 * anything unmatched, which silently truncated aliases, gateway ids, and any model added after
 * this table was written — the operator asked for N tokens and got 16,384 with no signal. A cap
 * we cannot justify is worse than no cap: `structure/02_config-and-codex-home.md` is explicit
 * that an explicit request value wins, so an unrecognized model passes through untouched and the
 * upstream remains the authority on its own limit.
 *
 * Matching is prefix/family based rather than substring based for the same reason: `includes("pro")`
 * matched any id containing "pro" (`my-prototype-model`), and `includes("oss")` matched any id
 * containing "oss" (`crossover-v2`).
 */
export function maxOutputTokensForGoogleModel(modelId: string): number | undefined {
  const lower = modelId.toLowerCase().trim();
  if (lower.startsWith("gemini")) {
    // Pro tops out one token below the flash/other Gemini ceiling; both are documented values.
    return /(^|[-.])pro([-.]|$)/.test(lower) ? 65535 : 65536;
  }
  if (lower.startsWith("claude")) return 64000;
  if (lower.startsWith("gpt-oss")) return 32768;
  return undefined;
}

export function clampGoogleMaxOutputTokens(
  modelId: string,
  requestedTokens?: number,
): number | undefined {
  if (requestedTokens === undefined || requestedTokens <= 0) return undefined;
  const modelMax = maxOutputTokensForGoogleModel(modelId);
  // Unknown model: honour the request as-is rather than inventing a ceiling for it.
  if (modelMax === undefined) return requestedTokens;
  return Math.min(requestedTokens, modelMax);
}

/**
 * Some Google direct deployments expose current Gemini Flash generations with a `-tiered`
 * wire suffix (`gemini-3.7-flash` -> `gemini-3.7-flash-tiered`). Keep the picker-visible id
 * stable and make the mapping configurable for deployments that still serve the bare id.
 */
const GEMINI_DIRECT_WIRE_RENAMES: Record<string, string> = {
  "gemini-3.7-flash": "gemini-3.7-flash-tiered",
  "gemini-3.6-flash": "gemini-3.6-flash-tiered",
};

function resolveDirectGeminiWireModelId(modelId: string, applyRenames: boolean): string {
  if (!applyRenames) return modelId;
  return Object.hasOwn(GEMINI_DIRECT_WIRE_RENAMES, modelId)
    ? GEMINI_DIRECT_WIRE_RENAMES[modelId]!
    : modelId;
}

/** Vertex API key: provider.apiKey if it looks real (not a sentinel), else GOOGLE_CLOUD_API_KEY env. */
function resolveVertexApiKey(optKey?: string): string | undefined {
  const realKey = optKey && !optKey.startsWith("<") && optKey !== "N/A" ? optKey : undefined;
  return realKey || process.env.GOOGLE_CLOUD_API_KEY;
}

/** Prefer Codex's stable opaque thread key; retain the existing deterministic fallback for clients
 * that omit it. The replay store hashes this value and never retains the raw session identifier. */
function vertexReplaySessionId(parsed: OcxParsedRequest): string {
  const threadId = parsed._clientThreadId?.trim();
  return threadId || antigravitySessionId(parsed);
}

/**
 * Stable tool-call id for the Gemini wire `functionCall.id` / `functionResponse.id` fields.
 *
 * Gemini treats these ids as optional and pairs a call with its response by id when present, so
 * emitting them is harmless for Gemini models. They are REQUIRED, however, for Claude-on-Antigravity:
 * the backend converts the Gemini-shaped request into Anthropic `messages`, mapping
 * `functionCall.id -> tool_use.id` and `functionResponse.id -> tool_result.tool_use_id`. With no id
 * the conversion fails upstream with `messages.N.content.M.tool_use.id: Field required` (HTTP 400).
 *
 * Anthropic's `tool_use.id` only accepts `[a-zA-Z0-9_-]`, so non-conforming characters are mapped to
 * `_`. To keep the mapping injective (so two distinct raw ids like `call:a` and `call/a` cannot
 * collide into one `tool_use.id` within a request), a short hash of the original raw id is appended
 * whenever any character had to be rewritten. The transform is deterministic, so a call id and its
 * matching result id — equal at the source, since Codex pairs them — still normalize identically and
 * the call/response pairing is preserved. Returns `undefined` for an empty id so the caller omits the
 * field entirely rather than inventing a non-matching one.
 */
// Aliasing the stateless transform here would reintroduce the collision it cannot prevent:
// a rewritten id can equal a distinct raw id that already conforms. Use a request-scoped
// allocator, exactly as the Anthropic adapter does, so call/response pairing stays injective.

/**
 * Inline image parts (Gemini `inline_data`) extracted from tool-result content. Only base64 data URLs
 * can be inlined; a remote URL has no mime type we can supply, so it is skipped here (the textual
 * result already carries an "[image]" marker via contentPartsToText).
 */
function toolResultImageParts(content: string | OcxContentPart[]): unknown[] {
  if (typeof content === "string") return [];
  const parts: unknown[] = [];
  for (const p of content) {
    if (p.type !== "image") continue;
    const data = parseDataUrl(p.imageUrl);
    if (data) parts.push({ inline_data: { mime_type: data.mediaType, data: data.base64 } });
  }
  return parts;
}

/**
 * Antigravity translates these Gemini `contents` into Anthropic `messages` for Claude models, and
 * Anthropic rejects a text block whose `text` is empty or absent. An empty Gemini text part reaches
 * that upstream as `{"type":"text"}` — a proto3 empty string is omitted from the translated JSON —
 * and 400s with `messages.N.content.M.text.text: Field required` (issue #420). An empty `parts: []`
 * model turn fails the same way. Gemini itself accepts both shapes, which is why this only ever
 * surfaced on Claude-on-Antigravity; the guard lives here because this is where the parts are
 * built. Mirrors the Anthropic adapter's own empty-block guard (src/adapters/anthropic.ts).
 */
const GEMINI_EMPTY_PLACEHOLDER = "(empty)";
const GEMINI_EMPTY_TOOL_OUTPUT_PLACEHOLDER = "(empty tool output)";
const GEMINI_MISSING_TOOL_RESULT = "[missing tool_result for this tool_use in history]";

/** A Gemini text part, or undefined when the value cannot form a valid non-empty text block. */
function geminiTextPart(text: unknown): { text: string } | undefined {
  return typeof text === "string" && text.length > 0 ? { text } : undefined;
}

/**
 * Text for `functionResponse.response.result`. `contentPartsToText` collapses an empty array — or one
 * holding only empty text — to its "[image]" marker, which would claim an image the turn does not
 * actually carry (`toolResultImageParts` adds none). Fall back to the placeholder unless the content
 * has something representable.
 */
function geminiToolResultText(content: string | OcxContentPart[]): string {
  if (typeof content === "string") return content || GEMINI_EMPTY_TOOL_OUTPUT_PLACEHOLDER;
  const hasContent = content.some(p => p.type !== "text" || p.text.length > 0);
  return hasContent ? contentPartsToText(content) : GEMINI_EMPTY_TOOL_OUTPUT_PLACEHOLDER;
}

function geminiToolResultParts(
  msg: OcxToolResultMessage,
  wireName: string,
  wireCallId: string,
): unknown[] {
  const functionResponse: Record<string, unknown> = {
    name: wireName,
    response: { result: geminiToolResultText(msg.content) },
    id: wireCallId,
  };
  return [{ functionResponse }, ...toolResultImageParts(msg.content)];
}

function geminiMissingToolResultPart(wireName: string, wireCallId: string): unknown {
  return {
    functionResponse: {
      name: wireName,
      response: { result: GEMINI_MISSING_TOOL_RESULT },
      id: wireCallId,
    },
  };
}

function geminiUnrepresentableToolCallPart(tc: OcxToolCall, wireName: string): unknown {
  const args = typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments);
  return { text: `[tool_use without a usable id: ${wireName}]\n${args}` };
}

function geminiOrphanToolResultParts(msg: OcxToolResultMessage): unknown[] {
  const label = msg.toolName ? `${msg.toolName} (${msg.toolCallId})` : msg.toolCallId;
  return [
    { text: `[tool_result without adjacent tool_use: ${label}]\n${geminiToolResultText(msg.content)}` },
    ...toolResultImageParts(msg.content),
  ];
}

function messagesToGeminiFormat(
  parsed: OcxParsedRequest,
  identityModelId: string,
  stripRejectedClaudeSdkParagraph = false,
): { systemInstruction?: unknown; contents: unknown[]; replayedCallIds: string[] } {
  // Neutralize Codex's GPT-5 identity line (Gemini/Antigravity share this path) so a routed model
  // never misreports as GPT-5/OpenAI, and never leaks the proxy identity upstream.
  const toolCatalogNudge = buildNonOpenAIToolCatalogNudgeForTools(parsed.context.tools, parsed.options.toolChoice);
  const identifiedSystemText = identifyRoutedModel([
    ...(parsed.context.systemPrompt ?? []),
    ...(toolCatalogNudge ? [toolCatalogNudge] : []),
    GOOGLE_BREVITY_INSTRUCTION,
  ].join("\n\n"), identityModelId);
  const systemText = stripRejectedClaudeSdkParagraph
    ? stripAntigravityRejectedClaudeSdkParagraph(identifiedSystemText)
    : identifiedSystemText;
  const systemInstruction = { parts: [{ text: systemText }] };

  const contents: unknown[] = [];
  const replayedCallIds: string[] = [];

  const callIds = createToolCallIdAllocator();
  for (const msg of parsed.context.messages) {
    if (msg.role === "assistant") {
      for (const part of (msg as OcxAssistantMessage).content) {
        if (part.type === "toolCall") callIds.reserve((part as OcxToolCall).id);
      }
    } else if (msg.role === "toolResult") {
      callIds.reserve((msg as OcxToolResultMessage).toolCallId);
    }
  }
  for (let i = 0; i < parsed.context.messages.length; i++) {
    const msg = parsed.context.messages[i];
    switch (msg.role) {
      case "user":
      case "developer": {
        if (typeof msg.content === "string") {
          contents.push({ role: "user", parts: [{ text: msg.content || GEMINI_EMPTY_PLACEHOLDER }] });
        } else {
          const parts: unknown[] = [];
          for (const p of msg.content as OcxContentPart[]) {
            if (p.type === "image") {
              const data = parseDataUrl(p.imageUrl);
              // Gemini takes base64 via inline_data; a remote URL needs a mime type we don't have, so
              // fall back to a short marker rather than inlining the URL as a huge text blob.
              parts.push(data ? { inline_data: { mime_type: data.mediaType, data: data.base64 } } : { text: `[image: ${p.imageUrl}]` });
              continue;
            }
            if (p.type === "video") {
              const data = parseDataUrl(p.videoUrl);
              // Gemini accepts inline video bytes in the same Part union as images. Arbitrary
              // remote URLs are not valid fileData references, so retain only a short marker.
              parts.push(data ? { inline_data: { mime_type: data.mediaType, data: data.base64 } } : { text: `[video: ${p.videoUrl}]` });
              continue;
            }
            // Drop empty/malformed text instead of emitting `{ text: "" }` or a bare `{}` part.
            const textPart = geminiTextPart(p.text);
            if (textPart) parts.push(textPart);
          }
          contents.push({ role: "user", parts: parts.length > 0 ? parts : [{ text: GEMINI_EMPTY_PLACEHOLDER }] });
        }
        break;
      }
      case "assistant": {
        const aMsg = msg as OcxAssistantMessage;
        const parts: unknown[] = [];
        const toolCalls: Array<{ wireCallId: string; wireName: string }> = [];
        for (const p of aMsg.content) {
          if (p.type === "text") {
            const textPart = geminiTextPart((p as OcxTextContent).text);
            if (textPart) parts.push(textPart);
          } else if (p.type === "toolCall") {
            const tc = p as OcxToolCall;
            // Preserve the thought signature on the function-call part so Antigravity/Gemini-3
            // reasoning continuity survives history-driven (stateless) turns, not just same-process
            // streaming covered by the replay cache. Only forward a REAL upstream signature — the
            // Responses parser also stashes synthetic item ids (`fc_...`) on this field, and sending
            // those as a thoughtSignature breaks continuity (the replay cache supplies the real one).
            const callId = callIds.allocate(tc.id);
            const wireName = namespacedToolName(tc.namespace, tc.name);
            if (callId === undefined) {
              // Claude-on-Antigravity requires a usable id for every translated tool_use. An empty
              // source id cannot be paired safely, so preserve the call as text and let its result
              // follow the same orphan-text path instead of emitting an invalid functionCall.
              parts.push(geminiUnrepresentableToolCallPart(tc, wireName));
              continue;
            }
            const functionCall: Record<string, unknown> = { name: wireName, args: tc.arguments };
            // Claude-on-Antigravity maps this id to Anthropic `tool_use.id`; without it the upstream
            // conversion 400s. Gemini accepts the optional id and pairs call/response by it.
            functionCall.id = callId;
            toolCalls.push({ wireCallId: callId, wireName });
            const part: Record<string, unknown> = { functionCall };
            // Prefer the metadata that travelled with this exact call; fall back to the legacy
            // field for callers that have not been migrated. Never merge or synthesize.
            // Final fallback (#1926): the durable store, read AT SERIALIZATION TIME. The
            // Responses parser runs before the route/credential scope is bound, so its
            // parse-time lookup can never hit; by the time this adapter serializes, the
            // credential-scoped identity is bound and the durable lookup is meaningful.
            const signature = tc.providerMetadata?.google?.thoughtSignature
              ?? tc.thoughtSignature
              ?? lookupReplayThoughtSignature(tc.id, parsed._reasoningReplayScope);
            if (isLikelyRealThoughtSignature(signature)) {
              part.thoughtSignature = signature;
              replayedCallIds.push(tc.id);
            }
            parts.push(part);
          }
        }
        // A turn with nothing Gemini can represent (e.g. thinking-only) would serialize as
        // `parts: []`, which the Anthropic translation rejects. Skip it, as the Anthropic
        // adapter does for its own empty assistant content.
        if (parts.length === 0) break;
        contents.push({ role: "model", parts });
        if (toolCalls.length > 0) {
          // Gemini/Claude-on-Antigravity requires one adjacent response batch for the whole
          // function-call turn. Replayed histories can be interrupted, reversed, duplicated, or
          // contain an orphan result; repair only this wire boundary without inventing success.
          const requiredIds = new Set(toolCalls.map(call => call.wireCallId));
          const resultsById = new Map<string, OcxToolResultMessage>();
          const orphanResults: OcxToolResultMessage[] = [];
          let j = i + 1;
          while (j < parsed.context.messages.length && parsed.context.messages[j].role === "toolResult") {
            const result = parsed.context.messages[j] as OcxToolResultMessage;
            const wireResultId = callIds.lookup(result.toolCallId);
            if (wireResultId !== undefined && requiredIds.has(wireResultId) && !resultsById.has(wireResultId)) {
              resultsById.set(wireResultId, result);
            } else {
              orphanResults.push(result);
            }
            j++;
          }

          const responseParts: unknown[] = [];
          for (const call of toolCalls) {
            const result = resultsById.get(call.wireCallId);
            if (result) responseParts.push(...geminiToolResultParts(result, call.wireName, call.wireCallId));
            else responseParts.push(geminiMissingToolResultPart(call.wireName, call.wireCallId));
          }
          for (const orphan of orphanResults) {
            responseParts.push(...geminiOrphanToolResultParts(orphan));
          }
          contents.push({ role: "user", parts: responseParts });
          i = j - 1;
        }
        break;
      }
      case "toolResult": {
        // A standalone functionResponse is invalid without an immediately preceding matching
        // functionCall batch. Preserve the result as explicit user text (plus any representable
        // image siblings) rather than manufacturing a successful call or sending a 400-prone shape.
        contents.push({ role: "user", parts: geminiOrphanToolResultParts(msg as OcxToolResultMessage) });
        break;
      }
    }
  }

  return { systemInstruction, contents, replayedCallIds };
}

function toolsToGeminiFormat(parsed: OcxParsedRequest): unknown[] | undefined {
  if (!parsed.context.tools?.length) return undefined;
  const tools = isAllowedToolChoice(parsed.options.toolChoice)
    ? parsed.context.tools.filter(toolChoiceToolPredicate(parsed.options.toolChoice, parsed.context.tools))
    : parsed.context.tools;
  if (tools.length === 0) return undefined;
  return [{
    functionDeclarations: tools.map(t => ({
      name: namespacedToolName(t.namespace, t.name),
      description: t.description,
      parameters: t.parameters,
    })),
  }];
}

/**
 * Client tool_choice enforcement on the wire. The catalog nudge states the same contract in
 * prose, but without functionCallingConfig the model is free to ignore it. "auto" stays absent
 * so the common case is byte-identical. The allowedTools variant already filters the
 * declarations in toolsToGeminiFormat; only its "required" half needs a wire mode.
 */
function toolChoiceToGeminiToolConfig(parsed: OcxParsedRequest): Record<string, unknown> | undefined {
  const choice = parsed.options.toolChoice;
  if (!choice || choice === "auto") return undefined;
  if (choice === "none") return { functionCallingConfig: { mode: "NONE" } };
  if (choice === "required") return { functionCallingConfig: { mode: "ANY" } };
  if (isAllowedToolChoice(choice)) {
    return choice.mode === "required" ? { functionCallingConfig: { mode: "ANY" } } : undefined;
  }
  return {
    functionCallingConfig: {
      mode: "ANY",
      allowedFunctionNames: [resolveToolChoiceWireName(parsed.context.tools, choice.name)],
    },
  };
}

function usageFromGemini(usage: Record<string, number> | undefined): OcxUsage | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.promptTokenCount ?? 0,
    outputTokens: usage.candidatesTokenCount ?? 0,
    ...(usage.cachedContentTokenCount !== undefined ? { cachedInputTokens: usage.cachedContentTokenCount } : {}),
    ...(usage.thoughtsTokenCount !== undefined ? { reasoningOutputTokens: usage.thoughtsTokenCount } : {}),
  };
}

/**
 * Cap on the buffered non-streaming response body (100 MiB), matching
 * IMAGES_RESPONSE_MAX_BYTES in src/server/images.ts. Enforced by streaming the
 * body with a hard byte cap before JSON.parse — Content-Length alone is not
 * trusted (missing/lying headers must still reject oversized payloads).
 * Streaming SSE responses also cap each data frame before JSON.parse.
 */
const MAX_RESPONSE_BYTES = 100 * 1024 * 1024;
const MAX_SSE_FRAME_BYTES = MAX_RESPONSE_BYTES;

// Note: imagen-* models use a different API surface (prediction/image-generation
// schema) and must NOT be treated as responseModalities-capable Gemini models.
// Explicit allowlist only — never `/gemini/ && /image/` (resurrects media-gen IDs).
const IMAGE_CAPABLE_MODELS = new Set([
  "gemini-3.1-flash-image",
  "gemini-2.0-flash-preview-image-generation",
  "gemini-3-pro-image-preview",
]);

function isImageCapableModel(modelId: string): boolean {
  return IMAGE_CAPABLE_MODELS.has(modelId);
}

/**
 * Model-visible markdown link for a materialized artifact. Uses the authenticated
 * opaque HTTP route so remote/container clients can fetch the image without host
 * filesystem paths leaking into the transcript.
 */
function artifactMarkdownUrl(filePath: string): string {
  return artifactHttpUrl(filePath).replace(/([()])/g, "\\$1");
}

interface GoogleResponsePart {
  text?: unknown;
  thought?: boolean;
  thoughtSignature?: string;
  thought_signature?: string;
  extra_content?: { google?: { thought_signature?: unknown } };
  functionCall?: unknown;
}

interface GoogleFunctionCall {
  name: string;
  args?: unknown;
}

/**
 * Read a Gemini/Antigravity thought signature from a response part. Antigravity can place it
 * either directly on the part (`thoughtSignature` / `thought_signature`) or inside the same
 * nested `extra_content.google.thought_signature` shape used on the Responses wire.
 */
function googlePartThoughtSignature(part: GoogleResponsePart): string | undefined {
  const direct = part.thoughtSignature ?? part.thought_signature;
  if (typeof direct === "string" && direct.length > 0) return direct;
  const nested = part.extra_content?.google?.thought_signature;
  return typeof nested === "string" && nested.length > 0 ? nested : undefined;
}

/**
 * Carry a Gemini thought signature with the exact function-call part that produced it. Google
 * validates the signature against that specific part, so it must ride the individual tool call
 * rather than be re-matched by name/arguments later (issue #1735).
 */
function googleToolCallMetadataFromPart(
  part: GoogleResponsePart,
  fallbackSignature?: string,
): { providerMetadata: OcxProviderOpaqueToolCallMetadata } | undefined {
  const signature = googlePartThoughtSignature(part) ?? fallbackSignature;
  if (!isLikelyRealThoughtSignature(signature)) return undefined;
  return { providerMetadata: { google: { thoughtSignature: signature } } };
}

/**
 * Google marks model-internal reasoning as a normal text-bearing part plus `thought: true`.
 * Keep that provider visibility bit authoritative here so the streaming and buffered parsers
 * cannot accidentally expose the same hidden reasoning through different event types.
 */
function googlePartTextEvent(part: GoogleResponsePart): AdapterEvent | undefined {
  // A malformed scalar/object is not text and must not cross the AdapterEvent boundary. Dropping
  // only this optional field preserves the rest of the part without inventing assistant output by
  // coercion; an empty string keeps its existing no-event behavior.
  if (typeof part.text !== "string" || part.text.length === 0) return undefined;
  return part.thought === true
    ? { type: "reasoning_raw_delta", text: part.text }
    : { type: "text_delta", text: part.text };
}

interface InvalidGoogleFunctionCallDiagnostic {
  reason:
    | "function_call_not_object"
    | "function_call_name_invalid"
    | "function_call_name_blank";
  partIndex: number;
  valueType: string;
}

interface InvalidGoogleShapeDiagnostic {
  reason:
    | "candidates_not_array"
    | "candidate_not_object"
    | "content_not_object"
    | "parts_not_array"
    | "part_not_object";
  partIndex?: number;
  valueType: string;
}

function isGoogleRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function googleStructuralValueType(value: unknown): string {
  if (value === null) return "null";
  return Array.isArray(value) ? "array" : typeof value;
}

/**
 * Gemini delivers one complete functionCall per part, so a missing name cannot be repaired by a
 * later delta. Validate the whole parts array before observing signatures or emitting content: a
 * malformed call must terminate the claimed response rather than enter replay state or reach the
 * bridge as a nameless dispatch. Null remains an absence encoding, matching other optional fields.
 */
function diagnoseGoogleFunctionCalls(
  parts: readonly GoogleResponsePart[],
): InvalidGoogleFunctionCallDiagnostic | undefined {
  for (let partIndex = 0; partIndex < parts.length; partIndex++) {
    const functionCall = parts[partIndex]?.functionCall;
    if (functionCall === undefined || functionCall === null) continue;
    if (!isGoogleRecord(functionCall)) {
      return {
        reason: "function_call_not_object",
        partIndex,
        valueType: googleStructuralValueType(functionCall),
      };
    }
    if (typeof functionCall.name !== "string") {
      return {
        reason: "function_call_name_invalid",
        partIndex,
        valueType: googleStructuralValueType(functionCall.name),
      };
    }
    if (functionCall.name.trim().length === 0) {
      return {
        reason: "function_call_name_blank",
        partIndex,
        valueType: "string",
      };
    }
  }
  return undefined;
}

function googleFunctionCall(part: GoogleResponsePart): GoogleFunctionCall | undefined {
  const functionCall = part.functionCall;
  if (!isGoogleRecord(functionCall) || typeof functionCall.name !== "string") return undefined;
  return { name: functionCall.name, args: functionCall.args };
}

function invalidGoogleFunctionCallEvent(
  diagnostic: InvalidGoogleFunctionCallDiagnostic,
): Extract<AdapterEvent, { type: "error" }> {
  const subject = diagnostic.reason === "function_call_not_object"
    ? "invalid function call"
    : diagnostic.reason === "function_call_name_blank"
      ? "blank function call name"
      : "invalid function call name";
  return {
    type: "error",
    message: `google response contained ${subject} (${diagnostic.reason}; partIndex=${diagnostic.partIndex}; valueType=${diagnostic.valueType}) — cannot dispatch`,
  };
}

/**
 * A candidate's `content` is claimed model output inside a well-formed frame, so it is governed by
 * the #1332 nested-shape rule (fail closed) rather than #1240's root-frame padding rule (skip).
 *
 * Absence stays legal, and so does one encoding of it: an empty array is how a JSON writer with no
 * distinct empty-object form spells an empty `content`, and it already behaves as "no parts". A
 * NON-empty array is the opposite case — `content?.parts` silently reads `undefined` from it, so a
 * candidate shaped `content: [{ parts: [...] }]` dropped its own text and completed as an empty
 * turn.
 */
function diagnoseGoogleContent(content: unknown): InvalidGoogleShapeDiagnostic | undefined {
  if (content === undefined || content === null || isGoogleRecord(content)) return undefined;
  if (Array.isArray(content) && content.length === 0) return undefined;
  return { reason: "content_not_object", valueType: googleStructuralValueType(content) };
}

/**
 * `content.parts` sits one rung below the candidate guard added in #1332, and both parsers
 * consumed it unchecked: `for (const part of {})` throws `{} is not iterable`, and a `[null]`
 * element throws on `part.thoughtSignature`. A `parts` that is absent or `null` keeps its existing
 * skip — only a present, non-null container is validated.
 */
function diagnoseGoogleParts(parts: unknown): InvalidGoogleShapeDiagnostic | undefined {
  if (!Array.isArray(parts)) {
    return { reason: "parts_not_array", valueType: googleStructuralValueType(parts) };
  }
  for (let partIndex = 0; partIndex < parts.length; partIndex++) {
    const part: unknown = parts[partIndex];
    if (!isGoogleRecord(part)) {
      return { reason: "part_not_object", partIndex, valueType: googleStructuralValueType(part) };
    }
  }
  return undefined;
}

function invalidGoogleShapeEvent(
  diagnostic: InvalidGoogleShapeDiagnostic,
): Extract<AdapterEvent, { type: "error" }> {
  const at = diagnostic.partIndex !== undefined ? `; partIndex=${diagnostic.partIndex}` : "";
  // The subject names the rung that failed, so an operator reading a log can tell a broken
  // candidate list from a well-formed candidate whose parts are broken. The candidate subject keeps
  // the exact wording #1332 introduced as its prefix, so an existing grep still matches.
  const subject = diagnostic.reason === "candidates_not_array" || diagnostic.reason === "candidate_not_object"
    ? "candidates"
    : diagnostic.reason === "content_not_object"
      ? "content"
      : "content parts";
  return {
    type: "error",
    message: `google response contained invalid ${subject} (${diagnostic.reason}${at}; valueType=${diagnostic.valueType})`,
  };
}

export function createGoogleAdapter(provider: OcxProviderConfig): ProviderAdapter {
  // Per-request closure: resolveAdapter builds a fresh adapter per request (server.ts), so buildRequest
  // can stash the CCA model/session for parseStream's reasoning-replay observation.
  let antigravityModel: string | undefined;
  let antigravitySession: string | undefined;
  // Vertex returns the same opaque Gemini thought signatures as CCA, but its replay namespace
  // must stay transport-scoped: a signature minted by one Google backend must never be sent to
  // another merely because the public model id and first prompt happen to match.
  let vertexReplayModel: string | undefined;
  let vertexReplaySession: string | undefined;
  let restoreGoogleToolName = (name: string): string => name;
  let lastInjectedCallIds: string[] = [];
  let lastReasoningReplayScope: OcxParsedRequest["_reasoningReplayScope"];

  // Conservative batch invalidation: upstream Gemini/Antigravity errors (e.g.
  // "Function call is missing a thought_signature in functionCall parts") do not specify which
  // specific call_id was rejected. When a request containing replayed signatures is rejected,
  // we evict all callIds injected in that turn (lastInjectedCallIds) from the durable store
  // and clear the session replay cache, preventing poisoned-signature loops while allowing
  // subsequent turns to re-accumulate valid signatures. Unrelated calls from other turns remain intact.
  //
  // Memory-cache clearing stays broad (any invalid-argument/signature error can poison the
  // session replay cache), but durable-store eviction is intentionally narrower: it only runs
  // when the error text explicitly mentions a signature, so a generic tool-schema
  // INVALID_ARGUMENT does not destroy valid durable signatures.
  function handleSignatureRejection(errorMessage?: string) {
    const replayModel = provider.googleMode === "cloud-code-assist" ? antigravityModel : vertexReplayModel;
    const replaySession = provider.googleMode === "cloud-code-assist" ? antigravitySession : vertexReplaySession;
    const text = errorMessage ?? "";
    const isInvalidArgument = /invalid_argument|invalid argument/i.test(text);
    const isSignatureError = /signature|thought_signature|thoughtSignature/i.test(text);
    // The in-memory Antigravity replay cache only exists for CCA/Vertex, so clearing it stays
    // scoped to those modes (replayModel/replaySession are undefined elsewhere anyway).
    if (
      (provider.googleMode === "cloud-code-assist" || provider.googleMode === "vertex")
      && replayModel && replaySession && (isInvalidArgument || isSignatureError)
    ) {
      clearAntigravityReplay(replayModel, replaySession);
    }
    // The DURABLE store is not mode-scoped: signatures are remembered through
    // rememberAndSerializeExtraContent and read back by lookupReplayThoughtSignature on every
    // Google mode, including AI Studio. Gating eviction on CCA/Vertex therefore left AI Studio
    // with rejected signatures cached forever, replaying them into every subsequent turn — the
    // store poisons itself and the request keeps failing. Eviction follows the same scope the
    // write does.
    if (isSignatureError) {
      for (const callId of lastInjectedCallIds) {
        forgetThoughtSignatureForReplay(callId, lastReasoningReplayScope);
      }
    }
  }

  return {
    name: "google",

    // Vertex + Antigravity get Kiro-style retry/timeout + classified, redacted errors.
    // Direct AI-Studio uses the canonical server transport (fetchWithTransientRetry), which
    // retries transient 5xx responses through providerFetch while preserving multi-key pool
    // 429 rotation and raw error formatting.
    ...(provider.googleMode === "vertex" || provider.googleMode === "cloud-code-assist"
      ? {
          fetchResponse: (request: AdapterRequest, ctx?: AdapterFetchContext): Promise<Response> =>
            (provider.googleMode === "cloud-code-assist" ? fetchAntigravityWithRetry : fetchVertexWithRetry)(request, ctx),
          formatErrorBody: (status: number, _headers: Headers, payloadText: string): string =>
            (provider.googleMode === "cloud-code-assist" ? safeAntigravityHttpErrorMessage : safeVertexHttpErrorMessage)(status, payloadText),
        }
      : {}),

    async buildRequest(parsed: OcxParsedRequest) {
      const routedModelId = provider.googleMode === "cloud-code-assist"
        ? resolveAntigravityEffortWireModel(
            parsed.modelId,
            mapReasoningEffort(provider, parsed.modelId, parsed.options.reasoning),
            provider.baseUrl,
          ).wireModelId
        : provider.googleMode === "vertex"
          ? parsed.modelId
          : resolveDirectGeminiWireModelId(parsed.modelId, provider.directGeminiWireRenames !== false);
      // AI Studio's `-tiered` spelling is wire-only; CCA aliases may migrate to another generation.
      const identityModelId = provider.googleMode === "cloud-code-assist" ? routedModelId : parsed.modelId;
      const stripRejectedClaudeSdkParagraph = provider.googleMode === "cloud-code-assist"
        && rejectsClaudeSdkParagraph(parsed.modelId, routedModelId);
      const { systemInstruction, contents, replayedCallIds } = messagesToGeminiFormat(
        parsed,
        identityModelId,
        stripRejectedClaudeSdkParagraph,
      );
      lastInjectedCallIds = [...replayedCallIds];
      lastReasoningReplayScope = parsed._reasoningReplayScope;
      const tools = toolsToGeminiFormat(parsed);

      const body: Record<string, unknown> = { contents };
      if (systemInstruction) body.systemInstruction = systemInstruction;
      if (tools) body.tools = tools;
      // Only meaningful with declarations on the wire: mode ANY with an empty
      // catalog is a guaranteed upstream 400.
      const toolConfig = tools ? toolChoiceToGeminiToolConfig(parsed) : undefined;
      if (toolConfig) body.toolConfig = toolConfig;

      const generationConfig: Record<string, unknown> = {};
      const clampedMaxOutputTokens = clampGoogleMaxOutputTokens(identityModelId, parsed.options.maxOutputTokens);
      if (clampedMaxOutputTokens !== undefined) generationConfig.maxOutputTokens = clampedMaxOutputTokens;
      if (parsed.options.temperature !== undefined) generationConfig.temperature = parsed.options.temperature;
      if (parsed.options.topP !== undefined) generationConfig.topP = parsed.options.topP;
      if (parsed.options.stopSequences) generationConfig.stopSequences = parsed.options.stopSequences;
      // Effort → thinkingLevel follows the configured ladder: any model advertising reasoning
      // efforts (registry preset or user config) sends the mapped level, so a picker-selected
      // effort actually reaches the wire (gemini-3.1-pro-preview ships a ladder). The original
      // gemini-3.5/3.6-flash direct-mode slice stays hardcoded so unladdered configs keep their
      // current behavior; Vertex participates only through an explicitly configured ladder (the
      // seed google-vertex entry ships none). Image models are excluded — thinkingConfig would
      // suppress the responseModalities fallback below. CCA maps effort on its envelope path.
      const thinkingEligible = provider.googleMode !== "cloud-code-assist"
        && !isImageCapableModel(parsed.modelId)
        && (configuredReasoningEfforts(provider, parsed.modelId) !== undefined
          || (provider.googleMode !== "vertex"
            && (parsed.modelId === "gemini-3.5-flash" || parsed.modelId === "gemini-3.6-flash")));
      const thinkingLevel = thinkingEligible
        ? mapReasoningEffort(provider, parsed.modelId, parsed.options.reasoning)
        : undefined;
      if (thinkingLevel) generationConfig.thinkingConfig = { thinkingLevel };
      if (!generationConfig.thinkingConfig && isImageCapableModel(parsed.modelId)) {
        generationConfig.responseModalities = ["TEXT", "IMAGE"];
      }
      if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig;

      const method = parsed.stream ? "streamGenerateContent" : "generateContent";
      const streamParam = parsed.stream ? "?alt=sse" : "";
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (provider.headers) Object.assign(headers, provider.headers);

      if (provider.googleMode === "cloud-code-assist") {
        // Google Antigravity (Cloud Code Assist): wrap the flat Gemini body in the CCA envelope.
        const token = provider.apiKey?.trim();
        if (!token) throw new Error("google-antigravity oauth token missing — run ocx login google-antigravity");
        const base = provider.baseUrl?.trim();
        if (!base) throw new Error("google-antigravity requires a non-empty baseUrl");
        const url = `${base}/v1internal:${method}${streamParam}`;
        const project = provider.project;
        if (!project) throw new Error("Antigravity requires a discovered Cloud Code Assist project id (re-run `ocx login google-antigravity`).");
        const sessionId = antigravitySessionId(parsed);
        const mappedEffort = mapReasoningEffort(provider, parsed.modelId, parsed.options.reasoning);
        const { wireModelId, thinkingLevel } = resolveAntigravityEffortWireModel(
          parsed.modelId,
          mappedEffort,
          provider.baseUrl,
        );
        antigravityModel = wireModelId;
        antigravitySession = sessionId;
        // Effort → thinkingConfig for CCA (CLIProxyAPI proven: request.generationConfig.thinkingConfig).
        // Suffix/compat IDs return thinkingLevel=undefined — the suffix IS the effort, no contradiction.
        if (thinkingLevel) {
          const gc = (body.generationConfig ?? {}) as Record<string, unknown>;
          gc.thinkingConfig = { thinkingLevel };
          body.generationConfig = gc;
        }
        // Reasoning continuity: Gemini models re-inject cached thoughtSignatures; Claude-on-Antigravity
        // sanitizes signatures inline (no cache). Both guard against the upstream 400 on bad signatures.
        // The real Antigravity client puts the session id ONLY at `request.sessionId` (camelCase,
        // nested) — matching CLIProxyAPI `generateStableSessionID`. An extra top-level/snake_case
        // spelling is a non-first-party key, so we send the single canonical location.
        const draftRequest: Record<string, unknown> = { ...body, sessionId };
        // Claude-on-Antigravity forces VALIDATED function calling (the real client always sets it).
        if (/claude/i.test(wireModelId)) {
          // VALIDATED would defeat a client's tool_choice "none": honor it by dropping the
          // declarations instead, the wire shape of a tool-less Claude turn.
          if (parsed.options.toolChoice === "none") {
            delete draftRequest.tools;
            delete draftRequest.toolConfig;
          }
          const existing = (draftRequest.toolConfig ?? {}) as Record<string, unknown>;
          const fcc = (existing.functionCallingConfig ?? {}) as Record<string, unknown>;
          draftRequest.toolConfig = { ...existing, functionCallingConfig: { ...fcc, mode: "VALIDATED" } };
        }
        const compiled = compileGoogleWireBody(draftRequest);
        const request = compiled.body;
        restoreGoogleToolName = compiled.restoreToolName;
        // Compile names before replay: signatures are keyed by the exact provider-visible name.
        if (Array.isArray((request as { contents?: unknown[] }).contents)) {
          const contents = (request as { contents: unknown[] }).contents;
          if (antigravityUsesReplayCache(wireModelId)) {
            applyAntigravityReplay(wireModelId, sessionId, contents);
          } else {
            sanitizeAntigravityClaudeSignatures(contents);
          }
          // After replay, not instead of it: a real signature always wins, and the sentinel only
          // fills a first functionCall that replay could not sign. Outside the cache branch too,
          // because the turn still needs a signature when no session was ever recorded.
          applyAntigravityThoughtSignatureFallback(wireModelId, contents);
          // Claude-on-Antigravity rejects assistant-tail (model-tail in Gemini terms) histories
          // as prefill: "This model does not support assistant message prefill. The conversation
          // must end with a user message." Context compaction, previous_response_id expansion,
          // and interrupted-turn replay can all produce a model-tail history. Append a user
          // "(continue)" nudge, mirroring the anthropic adapter's tail guard (src/adapters/anthropic.ts).
          if (/claude/i.test(wireModelId)) {
            const last = contents.length > 0 ? contents[contents.length - 1] as { role?: string } : undefined;
            if (!last || last.role === "model") {
              contents.push({ role: "user", parts: [{ text: "(continue)" }] });
            }
          }
        }
        const envelope = {
          model: wireModelId,
          // The envelope's `userAgent` field is a protocol constant ("antigravity"), distinct from
          // the HTTP `User-Agent` header (the real IDE UA). CLIProxyAPI `geminiToAntigravity` hardcodes
          // the body field; only the header carries the versioned client string.
          userAgent: "antigravity",
          requestType: "agent",
          project,
          requestId: `agent-${crypto.randomUUID()}`,
          request,
        };
        headers["User-Agent"] = ANTIGRAVITY_REQUEST_UA;
        headers["Authorization"] = `Bearer ${token}`;
        return { url, method: "POST", headers, body: JSON.stringify(envelope) };
      }

      if (provider.googleMode === "vertex") {
        const compiled = compileGoogleWireBody(body);
        restoreGoogleToolName = compiled.restoreToolName;
        const vertexProject = provider.project || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || "api-key";
        const vertexLocation = provider.location || process.env.GOOGLE_CLOUD_LOCATION || "global";
        vertexReplayModel = `vertex:${vertexProject}:${vertexLocation}:${parsed.modelId}`;
        vertexReplaySession = vertexReplaySessionId(parsed);
        // Compile names before replay so the cache matches the exact provider-visible
        // functionCall identity. This is the same bounded TTL/LRU store used by CCA, with the
        // transport prefix above preventing cross-backend signature reuse (#1254).
        if (Array.isArray((compiled.body as { contents?: unknown[] }).contents)) {
          applyAntigravityReplay(
            vertexReplayModel,
            vertexReplaySession,
            (compiled.body as { contents: unknown[] }).contents,
          );
          applyAntigravityThoughtSignatureFallback(
            vertexReplayModel,
            (compiled.body as { contents: unknown[] }).contents,
          );
        }
        // Vertex AI: project/location endpoint with GCP ADC, or x-goog-api-key fast path.
        const apiKey = resolveVertexApiKey(provider.apiKey);
        if (apiKey) {
          const url = `https://aiplatform.googleapis.com/v1/publishers/google/models/${parsed.modelId}:${method}${streamParam}`;
          headers["x-goog-api-key"] = apiKey;
          return { url, method: "POST", headers, body: JSON.stringify(compiled.body) };
        }
        const project = provider.project || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
        if (!project) throw new Error("Vertex AI requires a project id (provider.project or GOOGLE_CLOUD_PROJECT/GCLOUD_PROJECT).");
        const location = provider.location || process.env.GOOGLE_CLOUD_LOCATION;
        if (!location) throw new Error("Vertex AI requires a location (provider.location or GOOGLE_CLOUD_LOCATION).");
        const locationError = googleVertexLocationConfigError(location);
        if (locationError) throw new Error(locationError);
        const host = location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
        const url = `https://${host}/v1/projects/${project}/locations/${location}/publishers/google/models/${parsed.modelId}:${method}${streamParam}`;
        const token = await getVertexAccessToken();
        headers["Authorization"] = `Bearer ${token}`;
        return { url, method: "POST", headers, body: JSON.stringify(compiled.body) };
      }

      // ai-studio (default): Generative Language API + x-goog-api-key.
      const url = `${provider.baseUrl}/v1beta/models/${routedModelId}:${method}${streamParam}`;
      const apiKey = provider.apiKey?.trim();
      if (!apiKey) throw new Error("google (AI Studio) requires a non-empty API key");
      headers["x-goog-api-key"] = apiKey;

      const compiled = compileGoogleWireBody(body);
      restoreGoogleToolName = compiled.restoreToolName;
      return { url, method: "POST", headers, body: JSON.stringify(compiled.body) };
    },

    async *parseStream(response: Response, budget: TranslatorBudget): AsyncGenerator<AdapterEvent> {
      if (!response.body) {
        yield { type: "error", message: "No response body" };
        return;
      }
      // Streaming responses are processed incrementally (SSE chunks), so the full body
      // is never buffered — no Content-Length pre-check is needed here. Per-image size
      // protection is enforced on each chunk via MAX_ENCODED_BYTES_PER_IMAGE before
      // materializeInlineImage is called (see the inline.data check below).

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const budgetEncoder = new TextEncoder();
      let buffer = "";
      let bufferBytes = 0;
      let pendingUsage: OcxUsage | undefined;
      let toolCallsStarted = 0;
      let lastFinishReason: string | undefined;
      let sawAnyFrame = false;
      let sawTerminalSignal = false;
      let pendingStreamThoughtSig: string | undefined;

      const handleDataLine = async function* (line: string): AsyncGenerator<AdapterEvent, "continue" | "content" | "terminate"> {
        const payload = line.slice(5).trim();
        if (!payload) return "continue";
        if (payload.length > MAX_SSE_FRAME_BYTES) {
          yield { type: "error", message: `upstream SSE data frame exceeds ${MAX_SSE_FRAME_BYTES} bytes` };
          return "terminate";
        }
        let emittedContentEvent = false;

        let parsed: unknown;
        try {
          parsed = JSON.parse(payload);
        } catch {
          yield { type: "error", message: "malformed upstream SSE data frame" };
          return "terminate";
        }
        // `JSON.parse("null")` returns null rather than throwing, so the catch above cannot cover
        // it and the `chunk.error` read below crashed the stream (see openai-chat.ts). Skip such a
        // frame rather than terminating, for the reason given there: it is padding between real
        // frames, not a broken stream. Deliberately returns BEFORE `sawAnyFrame`, so a stream made
        // only of non-record frames still fails the terminal-signal check below instead of
        // completing empty. An unparseable frame stays terminal.
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          return "continue";
        }
        const chunk = parsed as Record<string, unknown>;
        sawAnyFrame = true;

        // Inline provider error inside a 200 stream → terminal error (see openai-chat.ts).
        if (chunk.error) {
          const err = chunk.error as { message?: string } | undefined;
          // Clear-on-invalid: a signature rejection means our replayed thoughtSignatures are stale.
          // Drop the cache entry and durable store entry for rejected calls so the next turn
          // starts clean instead of re-injecting a bad sig.
          handleSignatureRejection(err?.message);
          yield { type: "error", message: err?.message ?? "upstream error" };
          return "terminate";
        }

        // Antigravity (CCA) nests the standard Gemini payload under `response`.
        let root = chunk;
        if (provider.googleMode === "cloud-code-assist") {
          const wrapped = chunk.response;
          if (!wrapped || typeof wrapped !== "object" || Array.isArray(wrapped)) {
            yield { type: "error", message: "google-antigravity response missing response wrapper" };
            return "terminate";
          }
          root = wrapped as Record<string, unknown>;
        }
        // usageMetadata is a top-level field independent of candidates; read it BEFORE the
        // candidates guard so a usage-only final chunk is not dropped.
        const usageMeta = root.usageMetadata as Record<string, number> | undefined;
        if (usageMeta) {
          // Accumulate usage; emit a single terminal `done` post-loop so usage is never
          // dropped on EOF and the stream never yields two `done` events.
          pendingUsage = usageFromGemini(usageMeta);
          sawTerminalSignal = true;
        }
        const rawCandidates = root.candidates;
        // `null` is an absence encoding, not corruption, and terminating on it is the #1219
        // failure mode one rung in: a `{"candidates":null}` frame arriving between a content
        // delta and the finish chunk killed a turn whose answer had already fully arrived. An
        // absent key and an empty array are already skipped here; `null` joins them. A non-null
        // non-array container is still claimed structure the parser cannot read, and stays
        // terminal.
        if (rawCandidates === undefined || rawCandidates === null) return "continue";
        if (!Array.isArray(rawCandidates)) {
          yield invalidGoogleShapeEvent({
            reason: "candidates_not_array",
            valueType: googleStructuralValueType(rawCandidates),
          });
          return "terminate";
        }
        if (rawCandidates.length === 0) return "continue";
        const rawCandidate = rawCandidates[0];
        if (!isGoogleRecord(rawCandidate)) {
          // Unlike a root `data: null` keepalive, this is a claimed response candidate. Treat it
          // as terminal protocol corruption so the turn cannot complete after silently losing
          // a candidate or tool call (#1325).
          yield invalidGoogleShapeEvent({
            reason: "candidate_not_object",
            valueType: googleStructuralValueType(rawCandidate),
          });
          return "terminate";
        }
        const candidate = rawCandidate as {
          content?: unknown;
          finishReason?: string;
        };

        if (typeof candidate.finishReason === "string" && candidate.finishReason) {
          lastFinishReason = candidate.finishReason;
          sawTerminalSignal = true;
        }

        // One rung below the candidate guard above, same rule: this is claimed content, not
        // padding, so it fails closed rather than being iterated or silently dropped (#1325).
        const rawContent: unknown = candidate.content;
        const invalidContent = diagnoseGoogleContent(rawContent);
        if (invalidContent) {
          yield invalidGoogleShapeEvent(invalidContent);
          return "terminate";
        }
        const rawParts: unknown = isGoogleRecord(rawContent) ? rawContent.parts : undefined;
        let parts: GoogleResponsePart[] | undefined;
        if (rawParts !== undefined && rawParts !== null) {
          const invalidParts = diagnoseGoogleParts(rawParts);
          if (invalidParts) {
            yield invalidGoogleShapeEvent(invalidParts);
            return "terminate";
          }
          parts = rawParts as GoogleResponsePart[];
          const invalidFunctionCall = diagnoseGoogleFunctionCalls(parts);
          if (invalidFunctionCall) {
            yield invalidGoogleFunctionCallEvent(invalidFunctionCall);
            return "terminate";
          }
        }
        // Record Gemini thought signatures for the next stateless tool-result turn. Vertex and
        // Antigravity use separate model namespaces so opaque provider state cannot cross routes.
        const replayModel = provider.googleMode === "cloud-code-assist" ? antigravityModel : vertexReplayModel;
        const replaySession = provider.googleMode === "cloud-code-assist" ? antigravitySession : vertexReplaySession;
        if ((provider.googleMode === "cloud-code-assist" || provider.googleMode === "vertex")
          && parts && replayModel && replaySession) {
          // Observation may scan the whole frame, so use it only for replay-cache side effects.
          // The source-order loop below exclusively owns stream carry and cannot pair backwards.
          observeAntigravityReplay(
            replayModel,
            replaySession,
            parts as unknown[],
            pendingStreamThoughtSig,
          );
        }
        if (parts) {
          for (const part of parts) {
            const sig = googlePartThoughtSignature(part);
            if (part.thought === true && sig && isLikelyRealThoughtSignature(sig)) {
              pendingStreamThoughtSig = sig;
            }
            const textEvent = googlePartTextEvent(part);
            if (textEvent) {
              emittedContentEvent = true;
              yield textEvent;
            }
            const inline = (part as { inlineData?: { mimeType?: string; data?: string } }).inlineData;
            if (inline && typeof inline.data === "string") {
              if (inline.data.length > MAX_ENCODED_BYTES_PER_IMAGE) {
                yield { type: "error", message: "inline image exceeds per-image size cap" };
              } else {
                try {
                  const filePath = await materializeInlineImage(inline.data, imageBudget);
                  const escapedPath = artifactMarkdownUrl(filePath);
                  emittedContentEvent = true;
                  yield { type: "text_delta", text: `\n![image](${escapedPath})\n` };
                } catch {
                  yield { type: "error", message: "failed to materialize inline image" };
                }
              }
            }
            const functionCall = googleFunctionCall(part);
            if (functionCall) {
              const id = `call_${crypto.randomUUID().slice(0, 8)}`;
              toolCallsStarted++;
              emittedContentEvent = true;
              const restoredName = restoreGoogleToolName(functionCall.name);
              yield {
                type: "tool_call_start",
                id,
                name: restoredName,
                ...googleToolCallMetadataFromPart(part, pendingStreamThoughtSig),
              };
              yield { type: "tool_call_delta", arguments: JSON.stringify(functionCall.args ?? {}) };
              yield { type: "tool_call_end" };
            }
          }
        }
        return emittedContentEvent ? "content" : "continue";
      };
      const imageBudget = createImageBudget();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const nextBuffer = buffer + decoder.decode(value, { stream: true });
          const nextBufferBytes = budgetEncoder.encode(nextBuffer).byteLength;
          const appendReservation = budget.reserveTransient(nextBufferBytes, { kind: "live_transient" });
          buffer = nextBuffer;
          appendReservation.commitRetained();
          budget.releaseRetained(bufferBytes, { kind: "live_transient" });
          bufferBytes = nextBufferBytes;
          // Cap incomplete frames before waiting for a newline — otherwise a single
          // unterminated data: payload can grow without bound.
          if (buffer.length > MAX_SSE_FRAME_BYTES) {
            yield { type: "error", message: `upstream SSE data frame exceeds ${MAX_SSE_FRAME_BYTES} bytes` };
            try { await reader.cancel(); } catch { /* ignore */ }
            return;
          }

          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          const residualBytes = budgetEncoder.encode(buffer).byteLength;
          const residualReservation = budget.reserveTransient(residualBytes, { kind: "live_transient" });
          residualReservation.commitRetained();
          budget.releaseRetained(bufferBytes, { kind: "live_transient" });
          bufferBytes = residualBytes;

          let sawLiveness = false;
          let sawContentEvent = false;
          for (const line of lines) {
            if (line.startsWith("data:")) {
              const result = yield* handleDataLine(line);
              if (result === "terminate") return;
              if (result === "content") sawContentEvent = true;
              continue;
            }
            sawLiveness = true;
            if (line.startsWith(":") || !line.trim()) continue;
            debugDroppedFrame("google", line);
          }
          if (sawLiveness && !sawContentEvent) yield { type: "heartbeat" };
        }
        buffer += decoder.decode();
        if (buffer.trim().length > 0) {
          const residual = buffer.trim();
          if (residual.startsWith(":")) {
            yield { type: "heartbeat" };
          } else if (!residual.startsWith("data:")) {
            yield { type: "error", message: "upstream stream ended with an incomplete SSE frame — possible truncation" };
            return;
          } else if ((yield* handleDataLine(residual)) === "terminate") return;
        }
        // Fail-closed: a turn cut off mid tool call (MAX_TOKENS / MALFORMED_FUNCTION_CALL) surfaces
        // an error instead of a silently-incomplete done. Mirrors kiro-truncation.
        if ((provider.googleMode === "vertex" || provider.googleMode === "cloud-code-assist")
          && isVertexTruncatedTurn(lastFinishReason, toolCallsStarted)) {
          yield { type: "error", message: vertexTruncationErrorMessage(lastFinishReason) };
          return;
        }
        if (!sawAnyFrame || !sawTerminalSignal) {
          yield { type: "error", message: "upstream stream ended without a terminal signal — possible truncation" };
          return;
        }
        const stopReason = lastFinishReason === "MAX_TOKENS"
          ? "max_tokens"
          : ["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII"].includes(lastFinishReason ?? "")
            ? "content_filter"
            : undefined;
        yield {
          type: "done",
          usage: pendingUsage,
          ...(stopReason ? { stopReason } : {}),
        };
      } catch (error) {
        if (!isTranslatorBudgetExceededError(error)) throw error;
        try { await reader.cancel(error); } catch { /* already closed */ }
        yield {
          type: "error",
          status: 502,
          errorType: "upstream_error",
          code: "translation_buffer_limit",
          message: "upstream translation buffer exceeded the safe limit",
        };
      } finally {
        budget.releaseRetained(bufferBytes, { kind: "live_transient" });
        reader.releaseLock();
      }
    },

    async parseResponse(response: Response, budget: TranslatorBudget): Promise<AdapterEvent[]> {
      // Reject oversized responses before JSON parse. Prefer Content-Length when
      // present and truthful; always stream-read with a hard byte cap so a missing
      // or lying Content-Length cannot force a full in-memory buffer + parse.
      const contentLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
        try { await response.body?.cancel(); } catch { /* ignore */ }
        return [{ type: "error", message: `google response too large (content-length ${contentLength} exceeds ${MAX_RESPONSE_BYTES} bytes)` }];
      }
      let rawText: string;
      let rawTextBytes = 0;
      try {
        const reader = response.body?.getReader();
        if (!reader) return [{ type: "error", message: "google response had no body" }];
        const chunks: Uint8Array[] = [];
        let total = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > MAX_RESPONSE_BYTES) {
              await reader.cancel().catch(() => {});
              return [{ type: "error", message: `google response too large (exceeded ${MAX_RESPONSE_BYTES} bytes)` }];
            }
            budget.chargeRetained(value.byteLength, { kind: "retained_collectors" });
            chunks.push(value);
          }
        } finally {
          try { await reader.cancel(); } catch { /* ignore */ }
          reader.releaseLock();
        }
        const bytesReservation = budget.reserveTransient(total, { kind: "retained_collectors" });
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        bytesReservation.commitRetained();
        budget.releaseRetained(total, { kind: "retained_collectors" });
        rawText = new TextDecoder().decode(bytes);
        rawTextBytes = new TextEncoder().encode(rawText).byteLength;
        const textReservation = budget.reserveTransient(rawTextBytes, { kind: "retained_collectors" });
        textReservation.commitRetained();
        budget.releaseRetained(total, { kind: "retained_collectors" });
      } catch (err) {
        return [{ type: "error", message: err instanceof Error ? err.message : "failed to read google response body" }];
      }
      let raw: Record<string, unknown>;
      let rawBytes = 0;
      try {
        const parsedRaw: unknown = JSON.parse(rawText);
        // `JSON.parse("null")` returns null instead of throwing, so the catch below cannot see it
        // and the `raw.error` read crashed the turn — #1219 at the buffered body root, which #1240
        // never reached because that audit swept SSE frame parsers only. There is no next frame to
        // recover into here, so unlike a stream frame this fails closed, matching the
        // unparseable-body branch just below and the buffered candidate guards added in #2232.
        if (!isGoogleRecord(parsedRaw)) {
          budget.releaseRetained(rawTextBytes, { kind: "retained_collectors" });
          const valueType = googleStructuralValueType(parsedRaw);
          return [{ type: "error", message: `google response was not a JSON object (${valueType})` }];
        }
        raw = parsedRaw;
        rawBytes = new TextEncoder().encode(JSON.stringify(raw)).byteLength;
        const rawReservation = budget.reserveTransient(rawBytes, { kind: "retained_collectors" });
        rawReservation.commitRetained();
        budget.releaseRetained(rawTextBytes, { kind: "retained_collectors" });
      } catch {
        budget.releaseRetained(rawTextBytes, { kind: "retained_collectors" });
        return [{ type: "error", message: "google response was not valid JSON" }];
      }
      const finish = (events: AdapterEvent[]): AdapterEvent[] => {
        retainTranslatedEventBatch(events, budget);
        budget.releaseRetained(rawBytes, { kind: "retained_collectors" });
        rawBytes = 0;
        return events;
      };
      if (raw.error) {
        const err = raw.error as { message?: string };
        handleSignatureRejection(err.message);
        return finish([{ type: "error", message: err.message ?? "upstream error" }]);
      }
      // Antigravity (CCA) nests the standard Gemini payload under `response`; unwrap it.
      let json = raw;
      if (provider.googleMode === "cloud-code-assist") {
        const wrapped = raw.response;
        if (!wrapped || typeof wrapped !== "object" || Array.isArray(wrapped)) {
          return finish([{ type: "error", message: "google-antigravity response missing response wrapper" }]);
        }
        json = wrapped as Record<string, unknown>;
      }
      const events: AdapterEvent[] = [];

      const rawCandidates: unknown = json.candidates;
      // Parity with the streaming path, which has rejected a non-array `candidates` since #1332.
      // Buffered accepted `"abc"` outright (`"abc".length` is 3, so the emptiness check below
      // passed and `candidates[0]` was the character `"a"`), and reported `{}`/`5` as an absent
      // candidate list rather than a malformed one.
      if (rawCandidates !== undefined && rawCandidates !== null && !Array.isArray(rawCandidates)) {
        return finish([invalidGoogleShapeEvent({
          reason: "candidates_not_array",
          valueType: googleStructuralValueType(rawCandidates),
        })]);
      }
      const candidates = rawCandidates as { finishReason?: string }[] | undefined;
      if (!candidates?.length) {
        return finish([{ type: "error", message: "google response contained no candidates" }]);
      }
      const rawCandidate: unknown = candidates[0];
      if (!isGoogleRecord(rawCandidate)) {
        // The streaming parser already treats this as terminal protocol corruption (#1325/#1332).
        // Buffered returned a bare `done`, so a claimed-but-malformed candidate was reported to
        // the caller as a successful empty turn.
        return finish([invalidGoogleShapeEvent({
          reason: "candidate_not_object",
          valueType: googleStructuralValueType(rawCandidate),
        })]);
      }
      const candidate = rawCandidate as { content?: unknown; finishReason?: string };
      let toolCallsStarted = 0;
      const imageBudget = createImageBudget();
      const rawContent: unknown = candidate.content;
      const invalidContent = diagnoseGoogleContent(rawContent);
      if (invalidContent) return finish([invalidGoogleShapeEvent(invalidContent)]);
      const rawParts: unknown = isGoogleRecord(rawContent) ? rawContent.parts : undefined;
      if (rawParts !== undefined && rawParts !== null) {
        const invalidParts = diagnoseGoogleParts(rawParts);
        if (invalidParts) return finish([invalidGoogleShapeEvent(invalidParts)]);
        const parts = rawParts as GoogleResponsePart[];
        const invalidFunctionCall = diagnoseGoogleFunctionCalls(parts);
        if (invalidFunctionCall) return finish([invalidGoogleFunctionCallEvent(invalidFunctionCall)]);
        // Non-streaming Google-family response: observe thought signatures for the next turn,
        // using the same transport-scoped namespace as the streaming path.
        const replayModel = provider.googleMode === "cloud-code-assist" ? antigravityModel : vertexReplayModel;
        const replaySession = provider.googleMode === "cloud-code-assist" ? antigravitySession : vertexReplaySession;
        if ((provider.googleMode === "cloud-code-assist" || provider.googleMode === "vertex")
          && replayModel && replaySession) {
          observeAntigravityReplay(replayModel, replaySession, parts as unknown[]);
        }
        let pendingThoughtSig: string | undefined;
        for (const part of parts) {
          const sig = googlePartThoughtSignature(part);
          if (part.thought === true && sig && isLikelyRealThoughtSignature(sig)) {
            pendingThoughtSig = sig;
          }
          const textEvent = googlePartTextEvent(part);
          if (textEvent) events.push(textEvent);
          const inline = (part as { inlineData?: { mimeType?: string; data?: string } }).inlineData;
          if (inline && typeof inline.data === "string") {
            if (inline.data.length > MAX_ENCODED_BYTES_PER_IMAGE) {
              events.push({ type: "error", message: "inline image exceeds per-image size cap" });
            } else {
              try {
                const filePath = await materializeInlineImage(inline.data, imageBudget);
                const escapedPath = artifactMarkdownUrl(filePath);
                events.push({ type: "text_delta", text: `\n![image](${escapedPath})\n` });
              } catch {
                events.push({ type: "error", message: "failed to materialize inline image" });
              }
            }
          }
          const functionCall = googleFunctionCall(part);
          if (functionCall) {
            const id = `call_${crypto.randomUUID().slice(0, 8)}`;
            toolCallsStarted++;
            events.push({
              type: "tool_call_start",
              id,
              name: restoreGoogleToolName(functionCall.name),
              ...googleToolCallMetadataFromPart(part, pendingThoughtSig),
            });
            events.push({ type: "tool_call_delta", arguments: JSON.stringify(functionCall.args ?? {}) });
            events.push({ type: "tool_call_end" });
          }
        }
      }

      // Fail-closed truncation, same as the stream path: a non-stream turn cut off mid tool call
      // (MAX_TOKENS / MALFORMED_FUNCTION_CALL) surfaces an error instead of a silent done.
      if ((provider.googleMode === "vertex" || provider.googleMode === "cloud-code-assist")
        && isVertexTruncatedTurn(candidate.finishReason, toolCallsStarted)) {
        return finish([{ type: "error", message: vertexTruncationErrorMessage(candidate.finishReason) }]);
      }

      const usage = json.usageMetadata as Record<string, number> | undefined;
      // Mirror the streaming path: a buffered turn cut off by the token limit or a content filter
      // must carry its stop reason, or the bridge sees a clean `done` and reports the truncated
      // turn as completed — and, on a compaction turn, installs the half-written summary as
      // replacement history (#422).
      const finishReason = candidate.finishReason as string | undefined;
      const stopReason = finishReason === "MAX_TOKENS"
        ? "max_tokens"
        : ["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII"].includes(finishReason ?? "")
          ? "content_filter"
          : undefined;
      events.push({
        type: "done",
        usage: usageFromGemini(usage),
        ...(stopReason ? { stopReason } : {}),
      });
      return finish(events);
    },
  };
}
