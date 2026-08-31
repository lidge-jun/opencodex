/**
 * Execute ONE web search via a Grok sidecar through the STORED xai OAuth credential (#2188 L7).
 *
 * POSTs the canonical api.x.ai Responses endpoint with the hosted web_search tool (plus the
 * opt-in x_search tool) and reduces the SSE stream to a SidecarOutcome. Wire shapes are
 * probe-verified (devlog 003 / 070): reasoning.effort is accepted alongside tools; both hosted
 * tools may share one request; annotations arrive as url_citation events on message items;
 * x_search activity surfaces as custom_tool_call items (ctc_) rather than the documented
 * x_search_call — both are tolerated, neither is required. `action` may be absent on
 * output_item.added (skeleton-first) and fills in later. Never throws — returns `{error}` so
 * the caller injects a graceful tool result.
 */
import type { OcxProviderConfig } from "../types";
import { getValidAccessToken, publicOAuthAuthenticationErrorMessage } from "../oauth";
import { applyUpstreamRecoveryInit, fetchWithResetRetry } from "../lib/upstream-retry";
import { cancelBodyOnAbort, signalWithTimeout } from "../lib/abort";
import { sidecarEnter } from "../lib/sidecar-tracker";
import { redactSecretString } from "../lib/redact";
import { MAX_SIDECAR_RESPONSE_BYTES, type WebSearchSource } from "./parse";
import { BASE_INSTRUCTION, IMAGE_INSTRUCTION, type SidecarOutcome, type SidecarSettings } from "./executor";

/** The one destination the OAuth credential may be sent to; provider.baseUrl is honored only on the same origin. */
const XAI_RESPONSES_ORIGIN = "https://api.x.ai";

export interface XaiSearchOptions {
  /** Opt-in: add the hosted x_search tool next to web_search. */
  xSearch?: boolean;
  allowedXHandles?: string[];
  excludedXHandles?: string[];
  fromDate?: string;
  toDate?: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Doc-validated limits (docs.x.ai x-search): <=20 handles, allow XOR exclude, ISO dates. */
export function validateXaiSearchOptions(options: XaiSearchOptions): string | undefined {
  const allowed = options.allowedXHandles ?? [];
  const excluded = options.excludedXHandles ?? [];
  if (allowed.length > 0 && excluded.length > 0) return "allowedXHandles and excludedXHandles are mutually exclusive";
  if (allowed.length > 20) return "allowedXHandles admits at most 20 handles";
  if (excluded.length > 20) return "excludedXHandles admits at most 20 handles";
  for (const [field, value] of [["fromDate", options.fromDate], ["toDate", options.toDate]] as const) {
    if (value !== undefined && !ISO_DATE.test(value)) return `${field} must be an ISO-8601 date (YYYY-MM-DD)`;
  }
  return undefined;
}

function buildXSearchTool(options: XaiSearchOptions): Record<string, unknown> {
  return {
    type: "x_search",
    ...(options.allowedXHandles?.length ? { allowed_x_handles: options.allowedXHandles } : {}),
    ...(options.excludedXHandles?.length ? { excluded_x_handles: options.excludedXHandles } : {}),
    ...(options.fromDate ? { from_date: options.fromDate } : {}),
    ...(options.toDate ? { to_date: options.toDate } : {}),
  };
}

function isRec(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

export async function runXaiWebSearch(
  query: string,
  providerName: string,
  provider: OcxProviderConfig,
  settings: SidecarSettings,
  options: XaiSearchOptions = {},
  abortSignal?: AbortSignal,
): Promise<SidecarOutcome> {
  const invalid = validateXaiSearchOptions(options);
  if (invalid) return { text: "", sources: [], error: `xai sidecar options invalid: ${invalid}` };
  let token: string;
  try {
    token = await getValidAccessToken(providerName);
  } catch (e) {
    return { text: "", sources: [], error: `xai sidecar auth failed: ${publicOAuthAuthenticationErrorMessage(e)}` };
  }
  // Credential pinning: only the EXACT api.x.ai origin may carry the OAuth bearer.
  // A prefix check would admit https://api.x.ai.evil/ (review Critical); parse and
  // compare origins, falling back to the canonical endpoint on any mismatch.
  let base = `${XAI_RESPONSES_ORIGIN}/v1`;
  if (provider.baseUrl) {
    try {
      const parsed = new URL(provider.baseUrl);
      if (parsed.origin === XAI_RESPONSES_ORIGIN) base = provider.baseUrl.replace(/\/+$/, "");
    } catch { /* malformed baseUrl: keep the canonical endpoint */ }
  }
  const url = `${base}/responses`;
  const instruction = settings.describeImages ? BASE_INSTRUCTION + IMAGE_INSTRUCTION : BASE_INSTRUCTION;
  const body = {
    model: settings.model,
    instructions: instruction,
    input: [{ role: "user", content: query }],
    tools: [{ type: "web_search" }, ...(options.xSearch ? [buildXSearchTool(options)] : [])],
    include: ["web_search_call.action.sources"],
    reasoning: { effort: settings.reasoning },
    stream: true,
  };
  const linkedSignal = signalWithTimeout(settings.timeoutMs, abortSignal);
  const sidecarExit = sidecarEnter("web-search");
  const t0 = Date.now();
  try {
    const res = await fetchWithResetRetry(
      recovery => fetch(url, applyUpstreamRecoveryInit({
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: JSON.stringify(body),
        signal: linkedSignal.signal,
        // Credential-bearing: never follow a redirect off the pinned origin.
        redirect: "manual",
      }, recovery)),
      { abortSignal: linkedSignal.signal, label: "xai-web-search-sidecar" },
    );
    const detachBodyGuard = cancelBodyOnAbort(res.body, linkedSignal.signal);
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      detachBodyGuard();
      const entitlement = res.status === 401 || res.status === 403 ? " (Grok OAuth entitlement — re-run ocx login xai?)" : "";
      return { text: "", sources: [], error: `xai sidecar HTTP ${res.status}${entitlement}: ${redactSecretString(t.slice(0, 200))}` };
    }
    try {
      return await parseXaiResponsesSSE(res);
    } finally {
      detachBodyGuard();
    }
  } catch (e) {
    const kind = e instanceof Error && e.name === "TimeoutError" ? "timeout" : "connect_error";
    console.warn(`[web-search] xai sidecar ${kind} (${Date.now() - t0}ms)`);
    return { text: "", sources: [], error: redactSecretString(e instanceof Error ? e.message : String(e)) };
  } finally {
    sidecarExit();
    linkedSignal.cleanup();
  }
}

/**
 * Reduce a Grok Responses SSE stream to a SidecarOutcome (probe-shapes in devlog 003):
 * text from output_text deltas on message items; sources from url_citation annotations
 * unioned with web_search_call action.sources (deduped by url). Tolerates custom_tool_call
 * and x_search_call items, absent `action`, and unknown event names. Bounds raw bytes.
 */
export async function parseXaiResponsesSSE(response: Response): Promise<SidecarOutcome> {
  if (!response.body) return { text: "", sources: [] };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let responseBytes = 0;
  let text = "";
  let doneText = "";
  const sourceUrls = new Map<string, WebSearchSource>();
  let error: string | null = null;
  const addSource = (url: unknown, title?: unknown) => {
    if (typeof url !== "string" || url.length === 0) return;
    if (!sourceUrls.has(url)) sourceUrls.set(url, { url, ...(typeof title === "string" && title.length > 0 && title !== url ? { title } : {}) });
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      responseBytes += value.byteLength;
      if (responseBytes > MAX_SIDECAR_RESPONSE_BYTES * 8) {
        error = "xai sidecar stream exceeded byte bound";
        await reader.cancel(error).catch(() => {});
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const dataLine = frame.match(/^data: (.+)$/m)?.[1];
        if (!dataLine || dataLine === "[DONE]") continue;
        let payload: unknown;
        try { payload = JSON.parse(dataLine); } catch { continue; }
        if (!isRec(payload) || typeof payload.type !== "string") continue;
        switch (payload.type) {
          case "response.output_text.delta": {
            if (typeof payload.delta === "string") text += payload.delta;
            break;
          }
          case "response.output_text.done": {
            if (typeof payload.text === "string") doneText = payload.text;
            break;
          }
          case "response.output_text.annotation.added": {
            const annotation = payload.annotation;
            if (isRec(annotation) && annotation.type === "url_citation") addSource(annotation.url, annotation.title);
            break;
          }
          case "response.output_item.done": {
            const item = payload.item;
            if (isRec(item) && item.type === "web_search_call" && isRec(item.action) && Array.isArray(item.action.sources)) {
              for (const s of item.action.sources) if (isRec(s)) addSource(s.url);
            }
            break;
          }
          case "response.failed":
          case "error": {
            const message = isRec(payload.response) && isRec(payload.response.error) && typeof payload.response.error.message === "string"
              ? payload.response.error.message
              : typeof payload.message === "string" ? payload.message : "upstream reported failure";
            error = redactSecretString(String(message).slice(0, 200));
            break;
          }
          default: break;
        }
      }
    }
  } catch (e) {
    error = redactSecretString(e instanceof Error ? e.message : String(e));
  } finally {
    reader.releaseLock();
  }
  const finalText = doneText.length >= text.length ? doneText : text;
  const outcome: SidecarOutcome = { text: finalText, sources: [...sourceUrls.values()] };
  if (error && finalText.length === 0) outcome.error = error;
  return outcome;
}
