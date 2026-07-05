import type { IncomingMeta, ProviderAdapter } from "./base";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../types";

// Headers relayed verbatim from the caller in OAuth-passthrough ("forward") mode.
// Exported so the web-search sidecar reuses the exact same forwarded-auth set for its ChatGPT call.
export const FORWARD_HEADERS = [
  "authorization",
  "chatgpt-account-id",
  "openai-beta",
  "originator",
  "session_id",
  "session-id",
  "thread-id",
  "x-client-request-id",
  "x-codex-beta-features",
  "x-codex-installation-id",
  "x-codex-parent-thread-id",
  "x-codex-turn-metadata",
  "x-codex-turn-state",
  "x-codex-window-id",
  "x-oai-attestation",
  "x-responsesapi-include-timing-metrics",
];

function sanitizeReasoningInputContent(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const raw = body as Record<string, unknown>;
  if (!Array.isArray(raw.input)) return body;

  let changed = false;
  const input = raw.input.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const rec = item as Record<string, unknown>;
    if (rec.type !== "reasoning" || !Array.isArray(rec.content) || rec.content.length === 0) return item;
    changed = true;
    // Routed models can produce raw `reasoning_text` output items. Codex echoes those in later
    // native GPT requests, but ChatGPT's Responses backend accepts reasoning input only with empty
    // `content`; keep summaries/ids and drop the raw content so native passthrough does not 400.
    return { ...rec, content: [] };
  });

  return changed ? { ...raw, input } : body;
}

/**
 * Hosted (OpenAI-executed) tool types that specific native slugs reject at request time. Codex
 * attaches these for app skills (e.g. `image_generation` for imagegen) regardless of the target
 * model, and the passthrough path forwards the raw body untouched — so a slug that doesn't support
 * the tool 400s (`Tool 'image_generation' is not supported with gpt-5.3-codex-spark.`). Each entry
 * maps a model-slug matcher to the hosted tool types that must be stripped before forwarding.
 * Extend this when another native slug rejects a hosted tool (e.g. `code_interpreter`).
 */
const UNSUPPORTED_HOSTED_TOOLS: ReadonlyArray<{ match: (model: string) => boolean; tools: ReadonlySet<string> }> = [
  { match: model => model.includes("codex-spark"), tools: new Set(["image_generation"]) },
];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function stripExpandedPreviousResponseId(body: unknown, expanded: boolean | undefined): unknown {
  if (!expanded || !isPlainObject(body) || !Object.prototype.hasOwnProperty.call(body, "previous_response_id")) return body;
  const { previous_response_id: _previousResponseId, ...rest } = body;
  return rest;
}

/**
 * Remove hosted tool entries the target native slug rejects, so the OAuth-passthrough body never
 * carries a tool the upstream model 400s on. No-op (returns the original reference) when nothing
 * matches, keeping the common path allocation-free.
 */
function stripUnsupportedHostedTools(body: unknown): unknown {
  if (!isPlainObject(body) || !Array.isArray(body.tools)) return body;
  const model = typeof body.model === "string" ? body.model : "";
  const unsupported = UNSUPPORTED_HOSTED_TOOLS.filter(e => e.match(model));
  if (unsupported.length === 0) return body;

  const tools = body.tools.filter(t => {
    const type = isPlainObject(t) && typeof t.type === "string" ? t.type : undefined;
    if (!type) return true;
    return !unsupported.some(e => e.tools.has(type));
  });
  return tools.length === body.tools.length ? body : { ...body, tools };
}

export function createResponsesPassthroughAdapter(provider: OcxProviderConfig): ProviderAdapter & { passthrough: true } {
  return {
    name: "openai-responses",
    passthrough: true as const,

    buildRequest(parsed: OcxParsedRequest, incoming?: IncomingMeta) {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      let url: string;

      if (provider.authMode === "forward") {
        // OAuth passthrough: ChatGPT backend path is `${baseUrl}/responses` (no /v1).
        url = `${provider.baseUrl}/responses`;
        if (provider.headers) Object.assign(headers, provider.headers); // static headers first…
        const runtimeProvider = provider as {
          _codexAccountOverride?: { accessToken: string; chatgptAccountId: string };
          _codexAccountRequired?: boolean;
        };
        if (runtimeProvider._codexAccountRequired && !runtimeProvider._codexAccountOverride) {
          throw new Error("Codex pool account auth is required but unavailable");
        }
        for (const h of FORWARD_HEADERS) {
          const v = incoming?.headers.get(h);
          if (v) headers[h] = v;                                        // …so forwarded auth always wins.
        }
        const override = runtimeProvider._codexAccountOverride;
        if (override) {
          headers["authorization"] = `Bearer ${override.accessToken}`;
          headers["chatgpt-account-id"] = override.chatgptAccountId;
        }
      } else {
        const base = provider.baseUrl.replace(/\/v1\/?$/, "");
        url = `${base}/v1/responses`;
        if (provider.apiKey) headers["Authorization"] = `Bearer ${provider.apiKey}`;
        if (provider.headers) Object.assign(headers, provider.headers);
      }

      return {
        url,
        method: "POST",
        headers,
        body: JSON.stringify(stripUnsupportedHostedTools(sanitizeReasoningInputContent(
          stripExpandedPreviousResponseId(parsed._rawBody, parsed._previousResponseInputExpanded),
        ))),
      };
    },

    async *parseStream(): AsyncGenerator<AdapterEvent> {
      yield { type: "error", message: "passthrough adapter should not parse stream" };
    },
  };
}
