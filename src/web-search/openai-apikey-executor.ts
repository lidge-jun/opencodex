/**
 * Execute ONE web search via OpenAI's hosted web_search, authenticated with a plain API key
 * (`sk-…`) against the public Responses API — the key-auth twin of `runWebSearch`.
 *
 * `runWebSearch` can only reach the ChatGPT *forward* backend: it reuses the caller's forwarded
 * OAuth headers (`FORWARD_HEADERS`) and has no key of its own, so a deployment with no ChatGPT
 * login — e.g. a local model behind opencodex whose only OpenAI credential is an API key — has no
 * server-side search. This executor closes that gap: it POSTs the SAME hosted web_search body to
 * the public Responses API with `Authorization: Bearer <key>`, then reuses the shared Responses
 * SSE parser (`parseSidecarSSE`) and the same `SidecarSettings`/`SidecarOutcome` contract.
 *
 * Transport mirrors the exa key-based executor (no `withUpstreamHttpVersion` pin — the key-auth
 * path has no `upstreamHttpVersion` of its own): `applyUpstreamRecoveryInit` for the recovery
 * fields, `redirect: "manual"` so a cross-origin 3xx cannot carry the `Authorization` header to a
 * redirect target. Never throws — every error string passes `redactSecretString` AND the key is
 * scrubbed from the literal value, because pattern-based redaction cannot be trusted to recognize
 * an arbitrary operator key.
 */
import { applyUpstreamRecoveryInit, fetchWithResetRetry } from "../lib/upstream-retry";
import { signalWithTimeout, cancelBodyOnAbort } from "../lib/abort";
import { sidecarEnter } from "../lib/sidecar-tracker";
import { redactSecretString } from "../lib/redact";
import { parseSidecarSSE } from "./parse";
import {
  BASE_INSTRUCTION,
  IMAGE_INSTRUCTION,
  type SidecarOutcome,
  type SidecarOutcomeRecorder,
  type SidecarSettings,
} from "./executor";

/**
 * The public OpenAI Responses endpoint that hosts the web_search tool for a standard `sk-…` key.
 * Hardcoded (like the exa executor's EXA_SEARCH_URL): this backend is a fixed public capability,
 * not a configurable provider, so the operator supplies only the key.
 */
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

export async function runOpenAiApiKeyWebSearch(
  query: string,
  apiKey: string,
  hostedTool: Record<string, unknown>,
  settings: SidecarSettings,
  abortSignal?: AbortSignal,
  recordOutcome?: SidecarOutcomeRecorder,
): Promise<SidecarOutcome> {
  if (!apiKey) {
    return { text: "", sources: [], error: "openai-apikey sidecar selected without a usable OpenAI API key (webSearchSidecar.openaiApiKey or OPENAI_API_KEY)" };
  }
  // The executor KNOWS the secret — pattern-based redaction cannot be trusted to recognize an
  // arbitrary operator key, so scrub the literal value explicitly before anything reaches a log
  // (mirrors the exa executor's scrub; runWebSearch has no key to scrub because it is keyless).
  const scrub = (s: string) => redactSecretString(s.split(apiKey).join("[redacted-openai-key]"));
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
  const body = {
    model: settings.model,
    instructions: settings.describeImages ? BASE_INSTRUCTION + IMAGE_INSTRUCTION : BASE_INSTRUCTION,
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: query }] }],
    tools: [hostedTool],
    tool_choice: "auto",
    // Omitted when `SidecarSettings.reasoning` is undefined (operator set `reasoning: "off"` or
    // left it empty): non-reasoning models such as gpt-4.1-mini reject the field with a 400.
    ...(settings.reasoning !== undefined ? { reasoning: { effort: settings.reasoning } } : {}),
    // Same minimal body runWebSearch sends the forward backend: the hosted web_search runs
    // server-side and the shared SSE parser bounds the streamed response.
    store: false,
    stream: true,
  };
  const url = OPENAI_RESPONSES_URL;
  const linkedSignal = signalWithTimeout(settings.timeoutMs, abortSignal);
  const sidecarExit = sidecarEnter("web-search");
  const t0 = Date.now();
  try {
    const res = await fetchWithResetRetry(
      recovery => fetch(url, applyUpstreamRecoveryInit({
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: linkedSignal.signal,
        // Credential-bearing: do not follow a cross-origin 3xx. Bun strips `Authorization` across
        // origins, but a manual redirect is the explicit, auditable form (mirrors runWebSearch).
        redirect: "manual",
      }, recovery)),
      { abortSignal: linkedSignal.signal, label: "web-search-sidecar" },
    );
    // Attach the body guard before ANY branch reads it. The success path guards itself below, but
    // the failure branch's `res.text()` runs first, so a cancel landing between fetch resolution
    // and reader attach would otherwise orphan the internal rejection.
    const detachBodyGuard = cancelBodyOnAbort(res.body, linkedSignal.signal);
    if (!res.ok) {
      recordOutcome?.(res.status);
      const t = await res.text().catch(() => "");
      detachBodyGuard();
      console.warn(`[web-search] openai-apikey sidecar HTTP ${res.status} for query "${query.slice(0, 80)}" (${Date.now() - t0}ms)`);
      // Scrub BEFORE truncating: slicing first can cut the literal key at the boundary, leaving an
      // unscrubbable key prefix in the surviving error text.
      return { text: "", sources: [], error: `openai-apikey sidecar HTTP ${res.status}: ${scrub(t.slice(0, 200))}` };
    }
    try {
      const parsed = await parseSidecarSSE(res);
      if (linkedSignal.signal.aborted) throw linkedSignal.signal.reason;
      recordOutcome?.(res.status);
      return parsed;
    } finally {
      detachBodyGuard();
    }
  } catch (e) {
    const kind = e instanceof Error && e.name === "TimeoutError" ? "timeout" : "connect_error";
    const callerAborted = abortSignal?.aborted === true
      && linkedSignal.signal.aborted
      && linkedSignal.signal.reason === abortSignal.reason
      && e === linkedSignal.signal.reason;
    recordOutcome?.(callerAborted ? "connect_neutral" : kind);
    console.warn(`[web-search] openai-apikey sidecar ${kind} for query "${query.slice(0, 80)}" (${Date.now() - t0}ms)`);
    return { text: "", sources: [], error: scrub(e instanceof Error ? e.message : String(e)) };
  } finally {
    sidecarExit();
    linkedSignal.cleanup();
  }
}
