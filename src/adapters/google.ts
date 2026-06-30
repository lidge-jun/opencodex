import type { AdapterFetchContext, AdapterRequest, ProviderAdapter } from "./base";
import { debugDroppedFrame } from "../debug";
import { createHash } from "node:crypto";
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
import { isAllowedToolChoice, namespacedToolName, toolAllowedByChoice } from "../types";
import { contentPartsToText, parseDataUrl } from "./image";
import { getVertexAccessToken } from "../lib/gcp-adc";
import { fetchAntigravityWithRetry, fetchVertexWithRetry } from "./google-http";
import { isVertexTruncationReason, vertexTruncationErrorMessage } from "./google-truncation";
import { ANTIGRAVITY_REQUEST_UA, antigravitySessionId, isLikelyRealThoughtSignature, sanitizeAntigravityClaudeSignatures } from "./google-antigravity-wire";
import { sanitizeGeminiToolParameters } from "./google-tool-schema";
import { neutralizeIdentity } from "./identity";
import { ANTIGRAVITY_GOOG_API_CLIENT_UA } from "./client-fingerprint";
import { antigravityUsesReplayCache, applyAntigravityReplay, clearAntigravityReplay, observeAntigravityReplay } from "./google-antigravity-replay";

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

/** Vertex API key: provider.apiKey if it looks real (not a sentinel), else GOOGLE_CLOUD_API_KEY env. */
function resolveVertexApiKey(optKey?: string): string | undefined {
  const realKey = optKey && !optKey.startsWith("<") && optKey !== "N/A" ? optKey : undefined;
  return realKey || process.env.GOOGLE_CLOUD_API_KEY;
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

function messagesToGeminiFormat(parsed: OcxParsedRequest): { systemInstruction?: unknown; contents: unknown[] } {
  // Neutralize Codex's GPT-5 identity line (Gemini/Antigravity share this path) so a routed model
  // never misreports as GPT-5/OpenAI, and never leaks the proxy identity upstream.
  const systemText = neutralizeIdentity([...(parsed.context.systemPrompt ?? []), GOOGLE_BREVITY_INSTRUCTION].join("\n\n"));
  const systemInstruction = { parts: [{ text: systemText }] };

  const contents: unknown[] = [];

  for (const msg of parsed.context.messages) {
    switch (msg.role) {
      case "user":
      case "developer": {
        if (typeof msg.content === "string") {
          contents.push({ role: "user", parts: [{ text: msg.content }] });
        } else {
          const parts = (msg.content as OcxContentPart[]).map(p => {
            if (p.type === "image") {
              const data = parseDataUrl(p.imageUrl);
              // Gemini takes base64 via inline_data; a remote URL needs a mime type we don't have, so
              // fall back to a short marker rather than inlining the URL as a huge text blob.
              return data ? { inline_data: { mime_type: data.mediaType, data: data.base64 } } : { text: `[image: ${p.imageUrl}]` };
            }
            return { text: p.text };
          });
          contents.push({ role: "user", parts });
        }
        break;
      }
      case "assistant": {
        const aMsg = msg as OcxAssistantMessage;
        const parts: unknown[] = [];
        for (const p of aMsg.content) {
          if (p.type === "text") parts.push({ text: (p as OcxTextContent).text });
          else if (p.type === "toolCall") {
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
        contents.push({ role: "model", parts });
        break;
      }
      case "toolResult": {
        // The functionResponse part carries the textual result. Gemini cannot embed images inside a
        // functionResponse, but it does accept sibling inline_data parts in the same user turn, so
        // tool-result screenshots (e.g. Computer Use) ride along as inline_data instead of being
        // flattened to a "[image]" marker the model can't actually see.
        const responseId = geminiToolCallId(msg.toolCallId);
        const functionResponse: Record<string, unknown> = { name: namespacedToolName(msg.toolNamespace, msg.toolName), response: { result: contentPartsToText(msg.content) } };
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
      parameters: sanitizeGeminiToolParameters(t.parameters),
    })),
  }];
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

export function createGoogleAdapter(provider: OcxProviderConfig): ProviderAdapter {
  // Per-request closure: resolveAdapter builds a fresh adapter per request (server.ts), so buildRequest
  // can stash the CCA model/session for parseStream's reasoning-replay observation.
  let antigravityModel: string | undefined;
  let antigravitySession: string | undefined;
  return {
    name: "google",

    // Vertex + Antigravity get Kiro-style retry/timeout + classified, redacted errors. AI-Studio
    // Gemini keeps the default server fetch path (fetchResponse stays undefined so server.ts falls back).
    ...(provider.googleMode === "vertex" || provider.googleMode === "cloud-code-assist"
      ? {
          fetchResponse: (request: AdapterRequest, ctx?: AdapterFetchContext): Promise<Response> =>
            (provider.googleMode === "cloud-code-assist" ? fetchAntigravityWithRetry : fetchVertexWithRetry)(request, ctx),
        }
      : {}),

    async buildRequest(parsed: OcxParsedRequest) {
      const { systemInstruction, contents } = messagesToGeminiFormat(parsed);
      const tools = toolsToGeminiFormat(parsed);

      const body: Record<string, unknown> = { contents };
      if (systemInstruction) body.systemInstruction = systemInstruction;
      if (tools) body.tools = tools;

      const generationConfig: Record<string, unknown> = {};
      if (parsed.options.maxOutputTokens) generationConfig.maxOutputTokens = parsed.options.maxOutputTokens;
      if (parsed.options.temperature !== undefined) generationConfig.temperature = parsed.options.temperature;
      if (parsed.options.topP !== undefined) generationConfig.topP = parsed.options.topP;
      if (parsed.options.stopSequences) generationConfig.stopSequences = parsed.options.stopSequences;
      if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig;

      const method = parsed.stream ? "streamGenerateContent" : "generateContent";
      const streamParam = parsed.stream ? "?alt=sse" : "";
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (provider.headers) Object.assign(headers, provider.headers);

      if (provider.googleMode === "cloud-code-assist") {
        // Google Antigravity (Cloud Code Assist): wrap the flat Gemini body in the CCA envelope.
        const base = provider.baseUrl || "https://daily-cloudcode-pa.googleapis.com";
        const url = `${base}/v1internal:${method}${streamParam}`;
        const project = provider.project;
        if (!project) throw new Error("Antigravity requires a discovered Cloud Code Assist project id (re-run `ocx login google-antigravity`).");
        const sessionId = antigravitySessionId(parsed);
        antigravityModel = parsed.modelId;
        antigravitySession = sessionId;
        // Reasoning continuity: Gemini models re-inject cached thoughtSignatures; Claude-on-Antigravity
        // sanitizes signatures inline (no cache). Both guard against the upstream 400 on bad signatures.
        if (Array.isArray((body as { contents?: unknown[] }).contents)) {
          const contents = (body as { contents: unknown[] }).contents;
          if (antigravityUsesReplayCache(parsed.modelId)) {
            applyAntigravityReplay(parsed.modelId, sessionId, contents);
          } else {
            sanitizeAntigravityClaudeSignatures(contents);
          }
        }
        // The real Antigravity client puts the session id ONLY at `request.sessionId` (camelCase,
        // nested) — matching CLIProxyAPI `generateStableSessionID`. An extra top-level/snake_case
        // spelling is a non-first-party key, so we send the single canonical location.
        const request: Record<string, unknown> = { ...body, sessionId };
        // Claude-on-Antigravity forces VALIDATED function calling (the real client always sets it).
        if (/claude/i.test(parsed.modelId)) {
          const existing = (request.toolConfig ?? {}) as Record<string, unknown>;
          const fcc = (existing.functionCallingConfig ?? {}) as Record<string, unknown>;
          request.toolConfig = { ...existing, functionCallingConfig: { ...fcc, mode: "VALIDATED" } };
        }
        const envelope = {
          model: parsed.modelId,
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
        // The Antigravity client library reports a secondary Google API client UA alongside the CLI UA.
        headers["x-goog-api-client"] = ANTIGRAVITY_GOOG_API_CLIENT_UA;
        if (provider.apiKey) headers["Authorization"] = `Bearer ${provider.apiKey}`;
        return { url, method: "POST", headers, body: JSON.stringify(envelope) };
      }

      if (provider.googleMode === "vertex") {
        // Vertex AI: project/location endpoint with GCP ADC, or x-goog-api-key fast path.
        const apiKey = resolveVertexApiKey(provider.apiKey);
        if (apiKey) {
          const url = `https://aiplatform.googleapis.com/v1/publishers/google/models/${parsed.modelId}:${method}${streamParam}`;
          headers["x-goog-api-key"] = apiKey;
          return { url, method: "POST", headers, body: JSON.stringify(body) };
        }
        const project = provider.project || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
        if (!project) throw new Error("Vertex AI requires a project id (provider.project or GOOGLE_CLOUD_PROJECT/GCLOUD_PROJECT).");
        const location = provider.location || process.env.GOOGLE_CLOUD_LOCATION;
        if (!location) throw new Error("Vertex AI requires a location (provider.location or GOOGLE_CLOUD_LOCATION).");
        const host = location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
        const url = `https://${host}/v1/projects/${project}/locations/${location}/publishers/google/models/${parsed.modelId}:${method}${streamParam}`;
        const token = await getVertexAccessToken();
        headers["Authorization"] = `Bearer ${token}`;
        return { url, method: "POST", headers, body: JSON.stringify(body) };
      }

      // ai-studio (default): Generative Language API + x-goog-api-key.
      const url = `${provider.baseUrl}/v1beta/models/${parsed.modelId}:${method}${streamParam}`;
      if (provider.apiKey) headers["x-goog-api-key"] = provider.apiKey;

      return { url, method: "POST", headers, body: JSON.stringify(body) };
    },

    async *parseStream(response: Response): AsyncGenerator<AdapterEvent> {
      if (!response.body) {
        yield { type: "error", message: "No response body" };
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let pendingUsage: OcxUsage | undefined;
      let toolCallsStarted = 0;
      let lastFinishReason: string | undefined;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const payload = line.slice(6).trim();
            if (!payload) continue;

            let chunk: Record<string, unknown>;
            try { chunk = JSON.parse(payload); } catch { debugDroppedFrame("google", payload); continue; }

            // Inline provider error inside a 200 stream → terminal error (see openai-chat.ts).
            if (chunk.error) {
              const err = chunk.error as { message?: string } | undefined;
              // Clear-on-invalid: a signature rejection means our replayed thoughtSignatures are stale.
              // Drop the cache entry so the next turn starts clean instead of re-injecting a bad sig.
              if (provider.googleMode === "cloud-code-assist" && antigravityModel && antigravitySession
                && /signature|invalid_argument|invalid argument/i.test(err?.message ?? "")) {
                clearAntigravityReplay(antigravityModel, antigravitySession);
              }
              yield { type: "error", message: err?.message ?? "upstream error" };
              return;
            }

            // Antigravity (CCA) nests the standard Gemini payload under `response`.
            const root = (provider.googleMode === "cloud-code-assist"
              ? (chunk.response as Record<string, unknown> | undefined) ?? chunk
              : chunk);
            // usageMetadata is a top-level field independent of candidates; read it BEFORE the
            // candidates guard so a usage-only final chunk is not dropped.
            const usageMeta = root.usageMetadata as Record<string, number> | undefined;
            if (usageMeta) {
              // Accumulate usage; emit a single terminal `done` post-loop so usage is never
              // dropped on EOF and the stream never yields two `done` events.
              pendingUsage = usageFromGemini(usageMeta);
            }
            const candidates = root.candidates as { content?: { parts?: unknown[] }; finishReason?: string }[] | undefined;
            if (!candidates?.length) continue;

            lastFinishReason = candidates[0].finishReason ?? lastFinishReason;

            const parts = candidates[0].content?.parts as { text?: string; functionCall?: { name: string; args: unknown } }[] | undefined;
            // Antigravity reasoning-replay: record thoughtSignatures from the model parts for the next turn.
            if (provider.googleMode === "cloud-code-assist" && parts && antigravityModel && antigravitySession) {
              observeAntigravityReplay(antigravityModel, antigravitySession, parts as unknown[]);
            }
            if (parts) {
              for (const part of parts) {
                if (part.text) {
                  yield { type: "text_delta", text: part.text };
                }
                if (part.functionCall) {
                  const id = `call_${crypto.randomUUID().slice(0, 8)}`;
                  toolCallsStarted++;
                  yield { type: "tool_call_start", id, name: part.functionCall.name };
                  yield { type: "tool_call_delta", arguments: JSON.stringify(part.functionCall.args ?? {}) };
                  yield { type: "tool_call_end" };
                }
              }
            }
          }
        }
        // Fail-closed: a turn cut off mid tool call (MAX_TOKENS / MALFORMED_FUNCTION_CALL) surfaces
        // an error instead of a silently-incomplete done. Mirrors kiro-truncation.
        if ((provider.googleMode === "vertex" || provider.googleMode === "cloud-code-assist")
          && toolCallsStarted > 0 && isVertexTruncationReason(lastFinishReason)) {
          yield { type: "error", message: vertexTruncationErrorMessage(lastFinishReason) };
          return;
        }
        yield { type: "done", usage: pendingUsage };
      } finally {
        reader.releaseLock();
      }
    },

    async parseResponse(response: Response): Promise<AdapterEvent[]> {
      const raw = await response.json() as Record<string, unknown>;
      // Antigravity (CCA) nests the standard Gemini payload under `response`; unwrap it.
      const json = (provider.googleMode === "cloud-code-assist"
        ? (raw.response as Record<string, unknown> | undefined) ?? raw
        : raw);
      const events: AdapterEvent[] = [];

      const candidates = json.candidates as { content?: { parts?: { text?: string; functionCall?: { name: string; args: unknown } }[] }; finishReason?: string }[] | undefined;
      let toolCallsStarted = 0;
      if (candidates?.[0]?.content?.parts) {
        // Non-streaming CCA: observe thoughtSignatures for the next turn, same as the stream path.
        if (provider.googleMode === "cloud-code-assist" && antigravityModel && antigravitySession) {
          observeAntigravityReplay(antigravityModel, antigravitySession, candidates[0].content.parts as unknown[]);
        }
        for (const part of candidates[0].content.parts) {
          if (part.text) events.push({ type: "text_delta", text: part.text });
          if (part.functionCall) {
            const id = `call_${crypto.randomUUID().slice(0, 8)}`;
            toolCallsStarted++;
            events.push({ type: "tool_call_start", id, name: part.functionCall.name });
            events.push({ type: "tool_call_delta", arguments: JSON.stringify(part.functionCall.args ?? {}) });
            events.push({ type: "tool_call_end" });
          }
        }
      }

      // Fail-closed truncation, same as the stream path: a non-stream turn cut off mid tool call
      // (MAX_TOKENS / MALFORMED_FUNCTION_CALL) surfaces an error instead of a silent done.
      if ((provider.googleMode === "vertex" || provider.googleMode === "cloud-code-assist")
        && toolCallsStarted > 0 && isVertexTruncationReason(candidates?.[0]?.finishReason)) {
        return [{ type: "error", message: vertexTruncationErrorMessage(candidates?.[0]?.finishReason) }];
      }

      const usage = json.usageMetadata as Record<string, number> | undefined;
      events.push({
        type: "done",
        usage: usageFromGemini(usage),
      });
      return events;
    },
  };
}
