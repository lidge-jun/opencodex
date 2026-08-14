import type { AdapterFetchContext, AdapterRequest, ProviderAdapter } from "./base";
import { debugDroppedFrame } from "../lib/debug";
import { createHash } from "node:crypto";
import { createImageBudget, materializeInlineImage, MAX_ENCODED_BYTES_PER_IMAGE, artifactHttpUrl } from "../images/artifacts";
import type {
  AdapterEvent,
  OcxAssistantMessage,
  OcxContentPart,
  OcxParsedRequest,
  OcxProviderConfig,
  OcxTextContent,
  OcxToolCall,
  OcxUsage,
} from "../types";
import { isAllowedToolChoice, namespacedToolName, resolveToolChoiceWireName, toolAllowedByChoice } from "../types";
import { contentPartsToText, parseDataUrl } from "./image";
import { getVertexAccessToken } from "../lib/gcp-adc";
import { fetchAntigravityWithRetry, fetchVertexWithRetry } from "./google-http";
import { safeAntigravityHttpErrorMessage, safeVertexHttpErrorMessage } from "./google-errors";
import { isVertexTruncatedTurn, vertexTruncationErrorMessage } from "./google-truncation";
import { ANTIGRAVITY_REQUEST_UA, antigravitySessionId, isLikelyRealThoughtSignature, sanitizeAntigravityClaudeSignatures } from "./google-antigravity-wire";
import { compileGoogleWireBody } from "./google-wire-compiler";
import { identifyRoutedModel } from "./identity";
import { antigravityUsesReplayCache, applyAntigravityReplay, clearAntigravityReplay, observeAntigravityReplay } from "./google-antigravity-replay";
import { resolveAntigravityEffortWireModel } from "../providers/antigravity-models";
import { googleVertexLocationConfigError } from "../providers/google-vertex-location";
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

/**
 * Google renamed the current Gemini Flash generations on the Generative Language API,
 * appending a `-tiered` suffix (`gemini-3.7-flash` -> `gemini-3.7-flash-tiered`). The
 * old `gemini-3.7-flash` path 404s, so a saved config or registry entry naming the base
 * id must be resolved here before it reaches the URL. The user-facing id is deliberately
 * left alone: the picker, the catalog, the usage log and the price overlays all stay
 * keyed on the base id, and only the wire path learns the new spelling.
 */
const GEMINI_DIRECT_WIRE_RENAMES: Record<string, string> = {
  "gemini-3.7-flash": "gemini-3.7-flash-tiered",
  "gemini-3.6-flash": "gemini-3.6-flash-tiered",
};

function resolveDirectGeminiWireModelId(modelId: string): string {
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
function geminiToolCallId(rawId: string | undefined): string | undefined {
  const raw = rawId ?? "";
  if (raw.length === 0) return undefined;
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (cleaned === raw) return cleaned;
  // Lossy rewrite happened: disambiguate with a deterministic suffix derived from the raw id.
  const suffix = createHash("sha256").update(raw).digest("hex").slice(0, 8);
  return `${cleaned}_${suffix}`;
}

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
  const hasContent = content.some(p => p.type === "image" || (typeof p.text === "string" && p.text.length > 0));
  return hasContent ? contentPartsToText(content) : GEMINI_EMPTY_TOOL_OUTPUT_PLACEHOLDER;
}

function messagesToGeminiFormat(
  parsed: OcxParsedRequest,
  routedModelId = parsed.modelId,
): { systemInstruction?: unknown; contents: unknown[] } {
  // Neutralize Codex's GPT-5 identity line (Gemini/Antigravity share this path) so a routed model
  // never misreports as GPT-5/OpenAI, and never leaks the proxy identity upstream.
  const toolCatalogNudge = buildNonOpenAIToolCatalogNudgeForTools(parsed.context.tools, parsed.options.toolChoice);
  const systemText = identifyRoutedModel([
    ...(parsed.context.systemPrompt ?? []),
    ...(toolCatalogNudge ? [toolCatalogNudge] : []),
    GOOGLE_BREVITY_INSTRUCTION,
  ].join("\n\n"), routedModelId);
  const systemInstruction = { parts: [{ text: systemText }] };

  const contents: unknown[] = [];

  for (const msg of parsed.context.messages) {
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
            const callId = geminiToolCallId(tc.id);
            const functionCall: Record<string, unknown> = { name: namespacedToolName(tc.namespace, tc.name), args: tc.arguments };
            // Claude-on-Antigravity maps this id to Anthropic `tool_use.id`; without it the upstream
            // conversion 400s. Gemini accepts the optional id and pairs call/response by it.
            if (callId !== undefined) functionCall.id = callId;
            const part: Record<string, unknown> = { functionCall };
            if (isLikelyRealThoughtSignature(tc.thoughtSignature)) part.thoughtSignature = tc.thoughtSignature;
            parts.push(part);
          }
        }
        // A turn with nothing Gemini can represent (e.g. thinking-only) would serialize as
        // `parts: []`, which the Anthropic translation rejects. Skip it, as the Anthropic
        // adapter does for its own empty assistant content.
        if (parts.length === 0) break;
        contents.push({ role: "model", parts });
        break;
      }
      case "toolResult": {
        // The functionResponse part carries the textual result. Gemini cannot embed images inside a
        // functionResponse, but it does accept sibling inline_data parts in the same user turn, so
        // tool-result screenshots (e.g. Computer Use) ride along as inline_data instead of being
        // flattened to a "[image]" marker the model can't actually see.
        const responseId = geminiToolCallId(msg.toolCallId);
        const functionResponse: Record<string, unknown> = { name: namespacedToolName(msg.toolNamespace, msg.toolName), response: { result: geminiToolResultText(msg.content) } };
        // Mirror the matching functionCall id so Claude-on-Antigravity can pair this result with its
        // `tool_use` block (-> Anthropic `tool_result.tool_use_id`).
        if (responseId !== undefined) functionResponse.id = responseId;
        const parts: unknown[] = [{ functionResponse }];
        for (const part of toolResultImageParts(msg.content)) parts.push(part);
        contents.push({ role: "user", parts });
        break;
      }
    }
  }

  return { systemInstruction, contents };
}

function toolsToGeminiFormat(parsed: OcxParsedRequest): unknown[] | undefined {
  if (!parsed.context.tools?.length) return undefined;
  const allowed = isAllowedToolChoice(parsed.options.toolChoice)
    ? new Set(parsed.options.toolChoice.allowedTools)
    : undefined;
  const tools = allowed
    ? parsed.context.tools.filter(t => toolAllowedByChoice(t, allowed))
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
  text?: string;
  thought?: boolean;
  functionCall?: { name: string; args: unknown };
}

/**
 * Google marks model-internal reasoning as a normal text-bearing part plus `thought: true`.
 * Keep that provider visibility bit authoritative here so the streaming and buffered parsers
 * cannot accidentally expose the same hidden reasoning through different event types.
 */
function googlePartTextEvent(part: GoogleResponsePart): AdapterEvent | undefined {
  if (!part.text) return undefined;
  return part.thought === true
    ? { type: "reasoning_raw_delta", text: part.text }
    : { type: "text_delta", text: part.text };
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
  return {
    name: "google",

    // Vertex + Antigravity get Kiro-style retry/timeout + classified, redacted errors. AI-Studio
    // Gemini keeps the default server fetch path (fetchResponse stays undefined so server.ts falls back).
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
          ).wireModelId
        : resolveDirectGeminiWireModelId(parsed.modelId);
      const { systemInstruction, contents } = messagesToGeminiFormat(parsed, routedModelId);
      const tools = toolsToGeminiFormat(parsed);

      const body: Record<string, unknown> = { contents };
      if (systemInstruction) body.systemInstruction = systemInstruction;
      if (tools) body.tools = tools;
      // Only meaningful with declarations on the wire: mode ANY with an empty
      // catalog is a guaranteed upstream 400.
      const toolConfig = tools ? toolChoiceToGeminiToolConfig(parsed) : undefined;
      if (toolConfig) body.toolConfig = toolConfig;

      const generationConfig: Record<string, unknown> = {};
      if (parsed.options.maxOutputTokens) generationConfig.maxOutputTokens = parsed.options.maxOutputTokens;
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
        const { wireModelId, thinkingLevel } = resolveAntigravityEffortWireModel(parsed.modelId, mappedEffort);
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
        }
        const envelope = {
          model: wireModelId,
          // The envelope's `userAgent` field is a protocol constant ("antigravity"), distinct from
          // the HTTP `User-Agent` header (the real CLI UA). CLIProxyAPI `geminiToAntigravity` hardcodes
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
          // Drop the cache entry so the next turn starts clean instead of re-injecting a bad sig.
          const replayModel = provider.googleMode === "cloud-code-assist" ? antigravityModel : vertexReplayModel;
          const replaySession = provider.googleMode === "cloud-code-assist" ? antigravitySession : vertexReplaySession;
          if ((provider.googleMode === "cloud-code-assist" || provider.googleMode === "vertex")
            && replayModel && replaySession
            && /signature|invalid_argument|invalid argument/i.test(err?.message ?? "")) {
            clearAntigravityReplay(replayModel, replaySession);
          }
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
        if (rawCandidates === undefined) return "continue";
        if (!Array.isArray(rawCandidates)) {
          yield { type: "error", message: "google response contained invalid candidates" };
          return "terminate";
        }
        if (rawCandidates.length === 0) return "continue";
        const rawCandidate = rawCandidates[0];
        if (rawCandidate === null || typeof rawCandidate !== "object" || Array.isArray(rawCandidate)) {
          // Unlike a root `data: null` keepalive, this is a claimed response candidate. Treat it
          // as terminal protocol corruption so the turn cannot complete after silently losing
          // a candidate or tool call (#1325).
          yield { type: "error", message: "google response contained invalid candidates" };
          return "terminate";
        }
        const candidate = rawCandidate as {
          content?: { parts?: unknown[] };
          finishReason?: string;
        };

        if (typeof candidate.finishReason === "string" && candidate.finishReason) {
          lastFinishReason = candidate.finishReason;
          sawTerminalSignal = true;
        }

        const parts = candidate.content?.parts as GoogleResponsePart[] | undefined;
        // Record Gemini thought signatures for the next stateless tool-result turn. Vertex and
        // Antigravity use separate model namespaces so opaque provider state cannot cross routes.
        const replayModel = provider.googleMode === "cloud-code-assist" ? antigravityModel : vertexReplayModel;
        const replaySession = provider.googleMode === "cloud-code-assist" ? antigravitySession : vertexReplaySession;
        if ((provider.googleMode === "cloud-code-assist" || provider.googleMode === "vertex")
          && parts && replayModel && replaySession) {
          observeAntigravityReplay(replayModel, replaySession, parts as unknown[]);
        }
        if (parts) {
          for (const part of parts) {
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
            if (part.functionCall) {
              const id = `call_${crypto.randomUUID().slice(0, 8)}`;
              toolCallsStarted++;
              emittedContentEvent = true;
              yield { type: "tool_call_start", id, name: restoreGoogleToolName(part.functionCall.name) };
              yield { type: "tool_call_delta", arguments: JSON.stringify(part.functionCall.args ?? {}) };
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
        raw = JSON.parse(rawText) as Record<string, unknown>;
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

      const candidates = json.candidates as { content?: { parts?: GoogleResponsePart[] }; finishReason?: string }[] | undefined;
      if (!candidates?.length) {
        return finish([{ type: "error", message: "google response contained no candidates" }]);
      }
      let toolCallsStarted = 0;
      const imageBudget = createImageBudget();
      if (candidates?.[0]?.content?.parts) {
        // Non-streaming Google-family response: observe thought signatures for the next turn,
        // using the same transport-scoped namespace as the streaming path.
        const replayModel = provider.googleMode === "cloud-code-assist" ? antigravityModel : vertexReplayModel;
        const replaySession = provider.googleMode === "cloud-code-assist" ? antigravitySession : vertexReplaySession;
        if ((provider.googleMode === "cloud-code-assist" || provider.googleMode === "vertex")
          && replayModel && replaySession) {
          observeAntigravityReplay(replayModel, replaySession, candidates[0].content.parts as unknown[]);
        }
        for (const part of candidates[0].content.parts) {
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
          if (part.functionCall) {
            const id = `call_${crypto.randomUUID().slice(0, 8)}`;
            toolCallsStarted++;
            events.push({ type: "tool_call_start", id, name: restoreGoogleToolName(part.functionCall.name) });
            events.push({ type: "tool_call_delta", arguments: JSON.stringify(part.functionCall.args ?? {}) });
            events.push({ type: "tool_call_end" });
          }
        }
      }

      // Fail-closed truncation, same as the stream path: a non-stream turn cut off mid tool call
      // (MAX_TOKENS / MALFORMED_FUNCTION_CALL) surfaces an error instead of a silent done.
      if ((provider.googleMode === "vertex" || provider.googleMode === "cloud-code-assist")
        && isVertexTruncatedTurn(candidates?.[0]?.finishReason, toolCallsStarted)) {
        return finish([{ type: "error", message: vertexTruncationErrorMessage(candidates?.[0]?.finishReason) }]);
      }

      const usage = json.usageMetadata as Record<string, number> | undefined;
      events.push({
        type: "done",
        usage: usageFromGemini(usage),
      });
      return finish(events);
    },
  };
}
