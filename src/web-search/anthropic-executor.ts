import { resolveAnthropicHelperSnapshot, fetchAnthropicHelper, anthropicHelperMessagesUrl } from "../sidecar/anthropic-binding";
import { isAnthropicInstanceId } from "../providers/anthropic-instance-id";
import type { OAuthAccessSnapshot } from "../oauth";
import type { OcxConfig, OcxProviderConfig } from "../types";
import { publicOAuthAuthenticationErrorMessage } from "../oauth";
import { getAnthropicSidecarAccessToken } from "../oauth/anthropic-routing";
import { ANTHROPIC_OAUTH_BETA, CLAUDE_CODE_SYSTEM_INSTRUCTION } from "../oauth/anthropic";
import { CLAUDE_CLI_USER_AGENT } from "../providers/claude-cli-identity";
import { sidecarThinkingOff } from "../adapters/anthropic-model-contract";
import { CLAUDE_CODE_HEADERS, claudeCodeSessionId } from "../adapters/client-fingerprint";
import { signalWithTimeout, cancelBodyOnAbort } from "../lib/abort";
import { sidecarEnter } from "../lib/sidecar-tracker";
import { applyUpstreamRecoveryInit, fetchWithResetRetry, SendBudgetExhaustedError } from "../lib/upstream-retry";
import type { AuxiliaryModelSend } from "../lib/request-execution-budget";
import { estimateTokens } from "../lib/token-estimate";
import { sseFieldValue } from "../lib/sse-decoder";
import {
  MAX_SIDECAR_RESPONSE_BYTES,
  cancelReaderWithoutWaiting,
  type WebSearchSource,
} from "./parse";
import { BASE_INSTRUCTION, IMAGE_INSTRUCTION, type SidecarOutcome, type SidecarSettings } from "./executor";

/** Hardcoded per-turn search bound handed to the server tool (mirrors the loop's maxSearches intent). */
const ANTHROPIC_MAX_USES = 3;
/** Answer budget; the injected tool_result is clamped downstream, so this only bounds the sidecar turn. */
const ANTHROPIC_MAX_TOKENS = 8192;
/** A terminal exactly at the wire cap must prove EOF without holding a reader indefinitely. */
const ANTHROPIC_CAP_EOF_PROBE_TIMEOUT_MS = 1_000;

function isRec(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Read at most `MAX_SIDECAR_RESPONSE_BYTES` of an untrusted upstream body, then stop reading. */
async function readBoundedText(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  let seen = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = MAX_SIDECAR_RESPONSE_BYTES - seen;
      const accepted = value.byteLength <= remaining ? value : value.subarray(0, remaining);
      seen += accepted.byteLength;
      out += decoder.decode(accepted, { stream: true });
      if (seen >= MAX_SIDECAR_RESPONSE_BYTES) {
        cancelReaderWithoutWaiting(reader, "sidecar error body byte limit reached");
        break;
      }
    }
    out += decoder.decode();
  } catch {
    /* a failed error-body read must not mask the HTTP status we are about to report */
  }
  return out;
}

/**
 * Fold an Anthropic Messages SSE stream (a web_search_20250305 turn) into a WebSearchResult.
 *
 * Anthropic streams the FULL `web_search_tool_result.content` array on `content_block_start` (not via
 * deltas), so sources are collected there; the answer text arrives as `text_delta` events, and
 * `citations_delta` (web_search_result_location) contributes any additional cited URLs. A
 * `web_search_tool_result_error` content object yields an error. Never throws; partial text is
 * retained with an error when the search or stream did not complete successfully.
 */
export async function parseAnthropicSidecarSSE(res: Response): Promise<SidecarOutcome> {
  const sources: WebSearchSource[] = [];
  const seen = new Set<string>();
  const pushSource = (url: unknown, title: unknown): void => {
    if (typeof url !== "string" || url.length === 0 || seen.has(url)) return;
    seen.add(url);
    sources.push(typeof title === "string" && title.length > 0 ? { url, title } : { url });
  };

  let text = "";
  let sawToolResultError = false;
  let failure: string | undefined;
  let sawMessageStop = false;
  let cleanEof = false;
  let stopReason: string | undefined;
  if (!res.body) return { text: "", sources, error: "anthropic sidecar returned no response body" };

  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  let buffer = "";
  let responseBytes = 0;

  const handleFrame = (data: Record<string, unknown>, type: string, complete: boolean): void => {
    if (type === "ping") return;
    if (sawMessageStop) failure ??= "anthropic sidecar returned data after completion";
    cleanEof = false;
    if (type === "error") {
      failure ??= "anthropic sidecar returned a stream error";
    } else if (type === "message_stop") {
      sawMessageStop = true;
    } else if (type === "message_delta") {
      const delta = isRec(data.delta) ? data.delta : {};
      if (typeof delta.stop_reason === "string") {
        stopReason = delta.stop_reason;
        cleanEof = complete;
      }
    }
    if (type === "content_block_start") {
      const block = isRec(data.content_block) ? data.content_block : {};
      if (block.type === "web_search_tool_result") {
        if (Array.isArray(block.content)) {
          for (const hit of block.content) {
            if (isRec(hit) && hit.type === "web_search_result") pushSource(hit.url, hit.title);
          }
        } else if (isRec(block.content) && block.content.type === "web_search_tool_result_error") {
          sawToolResultError = true;
        }
      }
    } else if (type === "content_block_delta") {
      const delta = isRec(data.delta) ? data.delta : {};
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        text += delta.text;
      } else if (delta.type === "citations_delta") {
        const citation = isRec(delta.citation) ? delta.citation : {};
        if (citation.type === "web_search_result_location") pushSource(citation.url, citation.title);
      }
    }
  };

  // Parse one SSE frame's `data:` payload and fold it. Shared by the streaming loop and the EOF flush.
  const processFrame = (rawFrame: string, complete = true): void => {
    const invalidFrame = (): void => {
      cleanEof = false;
      failure ??= sawMessageStop
        ? "anthropic sidecar returned data after completion"
        : "anthropic sidecar returned an invalid stream frame";
    };
    const dataLines: string[] = [];
    let eventName: string | undefined;
    for (const line of rawFrame.split("\n")) {
      const dataValue = sseFieldValue(line, "data");
      if (dataValue !== null) dataLines.push(dataValue);
      const eventValue = sseFieldValue(line, "event");
      if (eventValue !== null) eventName = eventValue;
    }
    if (eventName === "ping") return;
    if (dataLines.length === 0 && (complete || rawFrame.split("\n").every(line => !line.trim() || line.startsWith(":")))) return;
    const dataLine = dataLines.join("\n");
    if (!dataLine || dataLine === "[DONE]") { invalidFrame(); return; }
    let data: unknown;
    try { data = JSON.parse(dataLine); } catch { invalidFrame(); return; }
    if (isRec(data)) {
      const type = eventName || (typeof data.type === "string" ? data.type : "");
      handleFrame(data, type, complete);
    } else invalidFrame();
  };

  const processCompleteFrames = (): void => {
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const rawFrame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      processFrame(rawFrame);
    }
  };

  const verifyEofAtCap = async (): Promise<boolean> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let expired = false;
    const timeout = new Promise<null>(resolve => {
      timer = setTimeout(() => { expired = true; resolve(null); }, ANTHROPIC_CAP_EOF_PROBE_TIMEOUT_MS);
    });
    try {
      for (;;) {
        if (expired) return false;
        const next = await Promise.race([reader.read(), timeout]);
        if (expired || next === null) return false;
        if (next.done) return true;
        if (next.value.byteLength > 0) return false;
        // A source that synchronously produces empty chunks must not starve the probe timer.
        await new Promise<void>(resolve => setTimeout(resolve, 0));
      }
    } catch {
      return false;
    } finally { if (timer !== undefined) clearTimeout(timer); }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // A sidecar that never emits a frame separator would otherwise grow `buffer` without
      // limit. Bound the accepted bytes exactly like the Responses sidecar parser does.
      const remaining = MAX_SIDECAR_RESPONSE_BYTES - responseBytes;
      const accepted = value.byteLength <= remaining ? value : value.subarray(0, remaining);
      responseBytes += accepted.byteLength;
      // Preserve a trailing CR until the next chunk so split CRLF remains one line break.
      buffer = (buffer + decoder.decode(accepted, { stream: true })).replace(/\r\n/g, "\n").replace(/\r(?!$)/g, "\n");
      processCompleteFrames();
      if (responseBytes >= MAX_SIDECAR_RESPONSE_BYTES) {
        // A trailing CR can complete a CR-only terminal delimiter at the exact boundary.
        if (buffer.endsWith("\r")) {
          buffer = buffer.slice(0, -1) + "\n";
          processCompleteFrames();
        }
        const trailingCommentsOnly = buffer.split("\n").every(line => !line.trim() || line.startsWith(":"));
        // A complete terminal or stop-reason delta at the cap needs bounded EOF proof; an
        // oversized chunk or partial trailing frame is an error. Never await upstream teardown.
        if ((!sawMessageStop && !cleanEof) || value.byteLength > remaining || !trailingCommentsOnly) {
          failure ??= "anthropic sidecar response exceeded the byte limit";
        } else if (!failure && !sawToolResultError
          && (stopReason === undefined || stopReason === "end_turn" || stopReason === "stop_sequence")
          && !(await verifyEofAtCap())) {
          failure = "anthropic sidecar response byte limit reached before EOF";
        }
        cancelReaderWithoutWaiting(reader, "sidecar response byte limit reached");
        buffer = "";
        break;
      }
    }
    // Flush the decoder and process any final unterminated frame (a stream that ends without \n\n).
    buffer = (buffer + decoder.decode()).replace(/\r\n|\r/g, "\n");
    processCompleteFrames();
    if (buffer.trim().length > 0) processFrame(buffer, false);
  } catch {
    failure ??= "anthropic sidecar stream could not be read";
  }

  const trimmed = text.trim();
  if (sawToolResultError) failure ??= "anthropic web search returned an error result";
  if (stopReason !== undefined && stopReason !== "end_turn" && stopReason !== "stop_sequence") {
    failure ??= "anthropic sidecar produced an incomplete answer";
  }
  if (!sawMessageStop && !cleanEof) failure ??= "anthropic sidecar stream ended before completion";
  if (failure) return { text: trimmed, sources, error: failure };
  if (trimmed.length === 0) {
    return { text: "", sources, error: "anthropic sidecar produced no answer" };
  }
  return { text: trimmed, sources };
}

/**
 * Execute ONE web search via a Claude sidecar through the STORED anthropic OAuth credential — the
 * Anthropic-backed analog of runWebSearch. Resolves the helper model's permitted account (refresh handled)
 * and reproduces the Claude Code OAuth fingerprint (identity system block first, oauth beta, client
 * headers, stable session id) so the request is first-party-shaped. Never throws — returns `{error}`
 * so the caller injects a graceful tool result.
 */
export async function runAnthropicWebSearch(
  query: string,
  providerName: string,
  provider: OcxProviderConfig,
  settings: SidecarSettings,
  abortSignal?: AbortSignal,
  config?: OcxConfig,
  dispatchSidecarSend?: AuxiliaryModelSend,
): Promise<SidecarOutcome> {
  const url = anthropicHelperMessagesUrl(provider.baseUrl);
  let token: string;
  let snapshot: OAuthAccessSnapshot | undefined;
  const capturedTarget = provider.baseUrl;
  try {
    if (config && isAnthropicInstanceId(providerName)) {
      snapshot = await resolveAnthropicHelperSnapshot(config, providerName, settings.model);
      token = snapshot.accessToken;
    } else {
      token = await getAnthropicSidecarAccessToken(providerName, settings.model, config);
    }
  } catch (e) {
    return { text: "", sources: [], error: `anthropic sidecar auth failed: ${publicOAuthAuthenticationErrorMessage(e)}` };
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01",
    "Accept": "text/event-stream",
    "User-Agent": CLAUDE_CLI_USER_AGENT,
    "Authorization": `Bearer ${token}`,
    "anthropic-beta": ANTHROPIC_OAUTH_BETA,
    ...CLAUDE_CODE_HEADERS,
    "X-Claude-Code-Session-Id": claudeCodeSessionId(token),
    "x-client-request-id": crypto.randomUUID(),
  };
  if (provider.headers) Object.assign(headers, provider.headers);

  const instruction = settings.describeImages ? BASE_INSTRUCTION + IMAGE_INSTRUCTION : BASE_INSTRUCTION;
  const body = {
    model: settings.model,
    max_tokens: ANTHROPIC_MAX_TOKENS,
    // Sonnet 5 defaults to adaptive thinking when omitted; keep the sidecar fast/cheap (audit F2).
    // The per-family off switch (disabled, between_tools or a low effort) lives in the model contract.
    ...sidecarThinkingOff(settings.model),
    // OAuth fingerprint requires the Claude Code identity as the FIRST system block (audit F6/anthropic.ts).
    system: [
      { type: "text", text: CLAUDE_CODE_SYSTEM_INSTRUCTION },
      { type: "text", text: instruction },
    ],
    messages: [{ role: "user", content: [{ type: "text", text: query }] }],
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: ANTHROPIC_MAX_USES }],
    stream: true,
  };

  const dispatch = (target: string, init: RequestInit) => snapshot && config
    ? fetchAnthropicHelper(config, snapshot, settings.model, capturedTarget, target, init)
    : fetch(target, init);
  const linkedSignal = signalWithTimeout(settings.timeoutMs, abortSignal);
  const sidecarExit = sidecarEnter("web-search");
  const t0 = Date.now();
  const serializedBody = JSON.stringify(body);
  const sendTarget = {
    poolId: snapshot?.provider ?? providerName,
    // Anthropic has no durable identity scope; never borrow the routed Codex account.
    identityId: "",
    targetKey: `anthropic-web-search:${crypto.randomUUID()}`,
    // This helper contains only text/tool definitions; include the full wire envelope conservatively.
    estimate: { inputTokens: Math.max(1, estimateTokens(serializedBody, settings.model)), outputCeilingTokens: body.max_tokens },
  };
  try {
    const res = await fetchWithResetRetry(
      // The replay needs `keepalive: false` to leave the half-closed pooled socket; Bun has
      // ignored a bare `Connection: close` (oven-sh/bun#20492).
      recovery => {
        const run = () => dispatch(url, applyUpstreamRecoveryInit({
          method: "POST",
          redirect: "manual",
          headers,
          body: serializedBody,
          signal: linkedSignal.signal,
        }, recovery));
        return dispatchSidecarSend ? dispatchSidecarSend(sendTarget, run) : run();
      },
      { replaySafe: true, abortSignal: linkedSignal.signal, label: "web-search-sidecar-anthropic" },
    );
    // Guard before any branch reads the body: the failure branch's `res.text()` ran ahead of
    // the success-path guard, reopening the fetch-resolution-to-reader-attach race
    // (found investigating #1419).
    const detachBodyGuard = cancelBodyOnAbort(res.body, linkedSignal.signal);
    if (!res.ok) {
      // Untrusted upstream error bodies are only used for an auth-failure message, so read a
      // bounded prefix instead of buffering an arbitrarily large response.
      const t = await readBoundedText(res);
      detachBodyGuard();
      console.warn(`[web-search] anthropic sidecar HTTP ${res.status} for query "${query.slice(0, 80)}" (${Date.now() - t0}ms)`);
      if (res.status === 401) {
        return { text: "", sources: [], error: `anthropic sidecar auth failed: ${publicOAuthAuthenticationErrorMessage(new Error(t))}` };
      }
      // Upstream bodies are untrusted and may contain credentials, paths, or provider diagnostics.
      return { text: "", sources: [], error: `sidecar HTTP ${res.status}` };
    }
    try {
      return await parseAnthropicSidecarSSE(res);
    } finally {
      detachBodyGuard();
    }
  } catch (e) {
    const kind = e instanceof SendBudgetExhaustedError ? "send_budget_exhausted"
      : e instanceof Error && e.name === "TimeoutError" ? "timeout" : "connect_error";
    console.warn(`[web-search] anthropic sidecar ${kind} for query "${query.slice(0, 80)}" (${Date.now() - t0}ms)`);
    return { text: "", sources: [], error: `anthropic sidecar ${kind}` };
  } finally {
    sidecarExit();
    linkedSignal.cleanup();
  }
}
