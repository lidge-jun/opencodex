import type { OcxProviderConfig } from "../types";
import { FORWARD_HEADERS } from "../adapters/openai-responses";
import { signalWithTimeout, cancelBodyOnAbort } from "../lib/abort";
import { redactSecretString } from "../lib/redact";
import { sidecarEnter } from "../lib/sidecar-tracker";
import { fetchWithResetRetry } from "../lib/upstream-retry";
import { parseSidecarSSE, type WebSearchResult } from "./parse";
import type { CodexUpstreamOutcome } from "../codex/routing";

export interface SidecarSettings {
  model: string;
  reasoning: string;
  timeoutMs: number;
  /**
   * True when the routed (downstream) model is text-only. The search model CAN see images, so it's
   * told to verbalize any relevant image results and include their URLs — otherwise a non-vision model
   * would receive bare image links it cannot interpret (the image-web-search gap).
   */
  describeImages?: boolean;
}

// Shared with the anthropic-backed executor (single source; audit F3). The instruction is
// backend-agnostic — both the gpt-mini sidecar and a Claude sidecar answer the same way.
export const BASE_INSTRUCTION =
  "You are a web-search assistant. Use the web_search tool to find current information for the " +
  "user's query, then reply with a concise, factual answer. End your reply with a `Sources:` " +
  "section listing each source you used on its own line as `- Title: URL` (one per line).";
export const IMAGE_INSTRUCTION =
  " The model that will read your answer is TEXT-ONLY and cannot see images: if the results include " +
  "relevant images, describe what they show in words and include their source URLs in your answer.";

/** A search result, or an `error` string when the search couldn't run (surfaced as a tool result). */
export type SidecarOutcome = WebSearchResult & { error?: string };
export type SidecarOutcomeRecorder = (outcome: CodexUpstreamOutcome) => void;

/**
 * Execute ONE web search via the gpt-mini sidecar through the ChatGPT forward backend — the only path
 * with a real server-side web_search. Reuses selected forwarded OAuth headers (the forward adapter
 * has no key of its own), replays the hosted web_search tool config verbatim, and runs the mini at
 * minimal reasoning. Never throws — returns `{error}` so the caller injects a graceful tool result.
 */
export async function runWebSearch(
  query: string,
  hostedTool: Record<string, unknown>,
  forwardProvider: OcxProviderConfig,
  selectedForwardHeaders: Headers,
  settings: SidecarSettings,
  abortSignal?: AbortSignal,
  recordOutcome?: SidecarOutcomeRecorder,
): Promise<SidecarOutcome> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (forwardProvider.headers) Object.assign(headers, forwardProvider.headers);
  for (const h of FORWARD_HEADERS) {
    const v = selectedForwardHeaders.get(h);
    if (v) headers[h] = v;
  }
  const body = {
    model: settings.model,
    instructions: settings.describeImages ? BASE_INSTRUCTION + IMAGE_INSTRUCTION : BASE_INSTRUCTION,
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: query }] }],
    tools: [hostedTool],
    tool_choice: "auto",
    reasoning: { effort: settings.reasoning },
    // NOTE: the ChatGPT (codex) backend rejects `max_output_tokens` ("Unsupported parameter") and
    // requires `store: false` — keep this body minimal. The shared SSE parser bounds raw response
    // bytes before format-result applies its smaller display clamp.
    store: false,
    stream: true,
  };
  const url = `${forwardProvider.baseUrl}/responses`;
  const linkedSignal = signalWithTimeout(settings.timeoutMs, abortSignal);
  const sidecarExit = sidecarEnter("web-search");
  const t0 = Date.now();
  try {
    const res = await fetchWithResetRetry(
      () => fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: linkedSignal.signal,
        // Credential-bearing: do not follow a cross-origin 3xx. Bun strips `Authorization`
        // across origins but forwards nonstandard headers such as `chatgpt-account-id`,
        // `session_id`, and `x-codex-turn-metadata` to the redirect target.
        redirect: "manual",
      }),
      { abortSignal: linkedSignal.signal, label: "web-search-sidecar" },
    );
    recordOutcome?.(res.status);
    // Attach the body guard before ANY branch reads it. The success path guarded itself below,
    // but the failure branch's `res.text()` runs first, so a cancel landing between fetch
    // resolution and reader attach orphaned the internal rejection (found investigating #1419).
    const detachBodyGuard = cancelBodyOnAbort(res.body, linkedSignal.signal);
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      detachBodyGuard();
      console.warn(`[web-search] sidecar HTTP ${res.status} for query "${query.slice(0, 80)}" (${Date.now() - t0}ms)`);
      return { text: "", sources: [], error: `sidecar HTTP ${res.status}: ${redactSecretString(t.slice(0, 200))}` };
    }
    try {
      return await parseSidecarSSE(res);
    } finally {
      detachBodyGuard();
    }
  } catch (e) {
    recordOutcome?.(e instanceof Error && e.name === "TimeoutError" ? "timeout" : "connect_error");
    const kind = e instanceof Error && e.name === "TimeoutError" ? "timeout" : "connect_error";
    console.warn(`[web-search] sidecar ${kind} for query "${query.slice(0, 80)}" (${Date.now() - t0}ms)`);
    return { text: "", sources: [], error: e instanceof Error ? e.message : String(e) };
  } finally {
    sidecarExit();
    linkedSignal.cleanup();
  }
}

export interface KeyedWebSearchRequest {
  /** Resolved provider name (for logs). */
  providerName: string;
  /** Resolved key-auth provider pointing at an openai-responses wire. */
  provider: OcxProviderConfig;
  /** The resolved plaintext API key (already validated present). */
  apiKey: string;
}

/**
 * Execute ONE web search via a key-fed openai-responses provider that natively serves hosted
 * web_search (e.g. OpenCode Zen at https://opencode.ai/zen/go/v1). Authenticates with the provider's
 * own API key via `Authorization: Bearer <apiKey>` — it must NEVER touch the ChatGPT forward headers
 * or the Anthropic stored-OAuth credential, so neither ChatGPT nor Anthropic quota is consumed.
 * Reuses the hosted web_search tool verbatim and the shared SSE parser. Never throws.
 */
export async function runKeyedWebSearch(
  query: string,
  hostedTool: Record<string, unknown>,
  sidecar: KeyedWebSearchRequest,
  settings: SidecarSettings,
  abortSignal?: AbortSignal,
): Promise<SidecarOutcome> {
  // Headers() normalizes casing so provider headers cannot create a second
  // Authorization/Content-Type entry that would race with the required ones.
  const headers = new Headers(sidecar.provider.headers);
  headers.set("Content-Type", "application/json");
  headers.set("Authorization", `Bearer ${sidecar.apiKey}`);
  const body = {
    model: settings.model,
    instructions: settings.describeImages ? BASE_INSTRUCTION + IMAGE_INSTRUCTION : BASE_INSTRUCTION,
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: query }] }],
    tools: [hostedTool],
    tool_choice: "auto",
    reasoning: { effort: settings.reasoning },
    store: false,
    stream: true,
  };
  const baseUrl = sidecar.provider.baseUrl.replace(/\/+$/, "");
  const responsesPath = sidecar.provider.responsesPath ?? "/responses";
  const url = `${baseUrl}${responsesPath}`;
  const linkedSignal = signalWithTimeout(settings.timeoutMs, abortSignal);
  const sidecarExit = sidecarEnter("web-search");
  const t0 = Date.now();
  try {
    const res = await fetchWithResetRetry(
      () => fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: linkedSignal.signal,
        // Credential-bearing: never follow a 3xx that could leak the API key to the redirect target.
        redirect: "manual",
      }),
      { abortSignal: linkedSignal.signal, label: "web-search-sidecar-keyed" },
    );
    const detachBodyGuard = cancelBodyOnAbort(res.body, linkedSignal.signal);
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      detachBodyGuard();
      console.warn(`[web-search] keyed sidecar HTTP ${res.status} for query "${query.slice(0, 80)}" (${Date.now() - t0}ms)`);
      return { text: "", sources: [], error: `sidecar HTTP ${res.status}: ${redactSecretString(t.slice(0, 200))}` };
    }
    try {
      return await parseSidecarSSE(res);
    } finally {
      detachBodyGuard();
    }
  } catch (e) {
    const kind = e instanceof Error && e.name === "TimeoutError" ? "timeout" : "connect_error";
    console.warn(`[web-search] keyed sidecar ${kind} for query "${query.slice(0, 80)}" (${Date.now() - t0}ms)`);
    return { text: "", sources: [], error: e instanceof Error ? e.message : String(e) };
  } finally {
    sidecarExit();
    linkedSignal.cleanup();
  }
}
