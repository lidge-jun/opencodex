/**
 * Execute ONE advisor consultation through the proxy's own /v1/chat/completions on loopback.
 *
 * Same execution shape as the vision sidecar's routed describe (src/vision/routed-describe.ts):
 * the loopback call re-enters the normal data plane, so model resolution, provider auth, effort
 * mapping and usage accounting are the ROUTING AUTHORITY's job — the advisor never builds its own
 * router and never touches provider credentials. Any model string the router accepts works here:
 * a bare native model, an explicit "provider/model", or an account-qualified native model.
 *
 * Recursion fence: the request carries `x-opencodex-advisor-internal` set to this process's
 * capability. The Chat surface checks that value before its bridge rebuilds headers and carries
 * the fact into handleResponses as `advisorInternal`. A marked request never plans an advisor
 * consultation (depth cap 1 — the same structure as the vision describe fence). The capability
 * is not a literal and is not forwarded upstream.
 *
 * Failure contract: never throws. A failed consultation returns `ok: false` plus a redacted,
 * bounded error string; the worker keeps going (fail-open) either with an explicit
 * unavailable context or with nothing, depending on the trigger.
 */
import type { OcxConfig } from "../types";
import { localInferenceDestination, selfFetchAdmissionToken, type LocalInferenceDestination } from "../lib/local-destinations";
import { cancelBodyOnAbort } from "../lib/abort";
import { sidecarEnter } from "../lib/sidecar-tracker";
import {
  ADVISOR_INTERNAL_CAPABILITY_HEADER,
  internalCallCapability,
} from "../lib/local-internal-call-capability";
import { configuredPort } from "../server/auth-cors";
import { readAdvisorReasoning } from "../server/inference/advisor-diagnostics";
import {
  ADVISOR_SYSTEM_INSTRUCTION,
  ADVISOR_QUESTION_ONLY_INSTRUCTION,
  buildAdvisorUserPrompt,
  type AdvisorContextInput,
} from "./context";
import {
  ADVISOR_ADMISSION_SCOPE_HEADER,
  AdvisorAdmissionScopeEncodedBoundExceeded,
  encodeAdvisorAdmissionScope,
  ADVISOR_ADMISSION_POLICY_HEADER,
  registerAdvisorAdmissionPolicy,
} from "../server/advisor-admission-scope";
import type { AdmissionModelScope } from "../server/admission-model-scope";
import type { CapturedAdmissionPolicy } from "../types/admission-policy";
import { captureAdmissionPolicy } from "../server/capture-admission-policy";

/**
 * The header the advisor presents on its own loopback request. Its VALUE is this process's
 * internal-call capability — never a literal, and never trusted from an inbound caller.
 */
export { ADVISOR_INTERNAL_CAPABILITY_HEADER as ADVISOR_INTERNAL_HEADER } from "../lib/local-internal-call-capability";

/** Bound the loopback JSON response; advice is prose, not data dumps. */
const MAX_ADVISOR_RESPONSE_BYTES = 4 * 1024 * 1024;
/** Advice length cap handed to the worker. */
const MAX_ADVICE_CHARS = 16_000;

export interface AdvisorConsultationResult {
  ok: boolean;
  /** Advisor prose when ok; empty string otherwise. */
  advice: string;
  advisorModel: string;
  /** True when the caller aborted the request — not a provider failure (no cooldown). */
  cancelled?: boolean;
  /** Redacted, bounded failure description when not ok. */
  error?: string;
  /** Loopback round-trip duration (ms), for logs. */
  durationMs: number;
  /** Token usage reported by the chat completion, when the adapter surfaced it. */
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  effectiveEffort?: string | null;
}

export function advisorDestinationOrigin(
  config: Pick<OcxConfig, "port" | "hostname" | "unauthenticatedLoopbackListener">,
): string {
  return advisorDestination(config).origin;
}

function advisorDestination(
  config: Pick<OcxConfig, "port" | "hostname" | "unauthenticatedLoopbackListener">,
): LocalInferenceDestination {
  // Same port resolution rule as the vision sidecar: config.port can be 0 (ephemeral bind, tests)
  // or stale after a live port override, so prefer the recorded actual bind port when present.
  const port = config.port && config.port > 0
    ? config.port
    : Number(configuredPort()) || 10_100;
  return localInferenceDestination(config, port);
}

/** Hard ceiling multiplier so an endlessly trickling stream cannot hang forever. */
const HARD_CEILING_MULTIPLIER = 4;
const HARD_CEILING_MIN_MS = 600_000;

interface InactivitySignal {
  signal: AbortSignal;
  readonly timedOut: boolean;
  touch(): void;
  cleanup(): void;
}

/**
 * Inactivity timeout signal with a generous hard ceiling: `touch()` resets the idle timer while
 * real SSE data arrives so actively streaming/reasoning advisors are not killed at a fixed
 * wall-clock mark, while a hung upstream still times out at `idleTimeoutMs`.
 */
function createInactivitySignal(idleTimeoutMs: number, abortSignal?: AbortSignal): InactivitySignal {
  const controller = new AbortController();
  let timedOut = false;
  let cleaned = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let ceilingTimer: ReturnType<typeof setTimeout> | undefined;

  const fireTimeout = () => {
    if (cleaned || controller.signal.aborted) return;
    timedOut = true;
    const err = new Error("advisor inactivity timeout");
    err.name = "TimeoutError";
    controller.abort(err);
  };

  const resetIdle = () => {
    if (cleaned || controller.signal.aborted) return;
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(fireTimeout, idleTimeoutMs);
  };

  const onCallerAbort = () => {
    if (!controller.signal.aborted) controller.abort(abortSignal?.reason);
  };

  if (abortSignal) {
    if (abortSignal.aborted) {
      onCallerAbort();
    } else {
      abortSignal.addEventListener("abort", onCallerAbort, { once: true });
    }
  }

  if (!controller.signal.aborted) {
    resetIdle();
    const hardCeilingMs = Math.max(idleTimeoutMs * HARD_CEILING_MULTIPLIER, HARD_CEILING_MIN_MS);
    ceilingTimer = setTimeout(fireTimeout, hardCeilingMs);
  }

  return {
    signal: controller.signal,
    get timedOut() { return timedOut; },
    touch: resetIdle,
    cleanup() {
      cleaned = true;
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      if (ceilingTimer !== undefined) clearTimeout(ceilingTimer);
      if (abortSignal) abortSignal.removeEventListener("abort", onCallerAbort);
    },
  };
}

function textFromField(content: unknown, allowWhitespaceOnly = false): string | undefined {
  if (typeof content === "string") {
    return allowWhitespaceOnly ? (content.length > 0 ? content : undefined) : (content.trim().length > 0 ? content : undefined);
  }
  if (Array.isArray(content)) {
    const joined = content
      .map(part => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : ""))
      .join("");
    return allowWhitespaceOnly ? (joined.length > 0 ? joined : undefined) : (joined.trim().length > 0 ? joined : undefined);
  }
  return undefined;
}

function extractContent(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const message = (choices[0] as { message?: unknown })?.message;
  if (!message || typeof message !== "object") return undefined;
  return textFromField((message as { content?: unknown }).content);
}

function extractDeltaContent(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const delta = (choices[0] as { delta?: unknown })?.delta;
  if (!delta || typeof delta !== "object") return undefined;
  return textFromField((delta as { content?: unknown }).content, true);
}

function extractStreamError(payload: unknown): boolean {
  return Boolean(payload && typeof payload === "object" && "error" in payload && (payload as { error?: unknown }).error);
}

function extractUsage(payload: unknown): AdvisorConsultationResult["usage"] {
  if (!payload || typeof payload !== "object") return undefined;
  const usage = (payload as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") return undefined;
  const num = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
  const inputTokens = num((usage as { prompt_tokens?: unknown }).prompt_tokens);
  const outputTokens = num((usage as { completion_tokens?: unknown }).completion_tokens);
  const totalTokens = num((usage as { total_tokens?: unknown }).total_tokens);
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) return undefined;
  return { ...(inputTokens !== undefined ? { inputTokens } : {}), ...(outputTokens !== undefined ? { outputTokens } : {}), ...(totalTokens !== undefined ? { totalTokens } : {}) };
}

/**
 * Base URL seam for tests; production always self-fetches the resolved local destination.
 * The advisor is an internal caller: no credential material rides the override path in tests.
 */
export function advisorBaseUrl(
  config: Pick<OcxConfig, "port" | "hostname" | "unauthenticatedLoopbackListener">,
): string {
  return advisorDestinationOrigin(config);
}

/** Terminal stream events across the Chat Completions and Responses shapes the Advisor can receive. */
function isTerminalStreamChunk(chunk: unknown): boolean {
  if (!chunk || typeof chunk !== "object") return false;
  const record = chunk as { type?: unknown; choices?: unknown };
  if (record.type === "response.completed" || record.type === "response.done") return true;
  return Array.isArray(record.choices) && record.choices.some(choice =>
    !!choice && typeof choice === "object" && typeof (choice as { finish_reason?: unknown }).finish_reason === "string");
}

export async function consultAdvisor(
  input: AdvisorContextInput,
  config: Pick<OcxConfig, "port" | "hostname" | "apiKeys" | "unauthenticatedLoopbackListener">,
  effort: string,
  timeoutMs: number,
  abortSignal?: AbortSignal,
  baseUrlOverride?: string,
  admissionScope?: AdmissionModelScope,
  admissionPolicy?: CapturedAdmissionPolicy,
): Promise<AdvisorConsultationResult> {
  const t0 = Date.now();
  // A low-level guard as well as the plan check: never fall back to task context or pay for an empty question.
  if (input.contextMode === "question-only" && !input.question?.trim()) {
    return {
      ok: false, advice: "", advisorModel: input.advisorModel, durationMs: 0,
      error: "A non-empty question is required in question-only mode; no consultation sent.",
    };
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    [ADVISOR_INTERNAL_CAPABILITY_HEADER]: internalCallCapability(),
  };
  // Admission ladder identical to the vision sidecar: env token || service token file || first
  // configured API key, sent as `x-opencodex-api-key` — never Authorization. A destination that
  // requires no admission gets only a credential this data plane recognizes (#7894).
  const admission = selfFetchAdmissionToken(config, advisorDestination(config));
  if (admission) headers["x-opencodex-api-key"] = admission;
  // Keep the bounded scope envelope for transport validation; the process-local policy
  // registration below owns the complete snapshot. The receiver also enforces host limits.
  try {
    headers[ADVISOR_ADMISSION_SCOPE_HEADER] = encodeAdvisorAdmissionScope(admissionScope ?? { providers: [], models: [] });
  } catch (error) {
    if (error instanceof AdvisorAdmissionScopeEncodedBoundExceeded) {
      // Controlled failure before fetch: an over-bound scope must never reach the peer —
      // it would be rejected mid-request — and must never be narrowed silently either.
      return { ok: false, advice: "", advisorModel: input.advisorModel, error: error.message, durationMs: Date.now() - t0 };
    }
    throw error;
  }

  const requestBody = {
    model: input.advisorModel,
    stream: true,
    reasoning_effort: effort,
    messages: [
      { role: "system", content: input.contextMode === "question-only" ? ADVISOR_QUESTION_ONLY_INSTRUCTION : ADVISOR_SYSTEM_INSTRUCTION },
      { role: "user", content: buildAdvisorUserPrompt(input) },
    ],
  };

  const linkedSignal = createInactivitySignal(timeoutMs, abortSignal);
  const sidecarExit = sidecarEnter("advisor");
  if (abortSignal?.aborted) {
    sidecarExit();
    linkedSignal.cleanup();
    return { ok: false, cancelled: true, advice: "", advisorModel: input.advisorModel, error: "advisor cancelled before dispatch", durationMs: Date.now() - t0 };
  }
  let policyRegistration: ReturnType<typeof registerAdvisorAdmissionPolicy> | undefined;
  try {
    policyRegistration = registerAdvisorAdmissionPolicy(admissionPolicy ?? captureAdmissionPolicy(config, undefined, admissionScope), linkedSignal.signal);
    headers[ADVISOR_ADMISSION_POLICY_HEADER] = policyRegistration.token;
    const res = await fetch(`${baseUrlOverride ?? advisorBaseUrl(config)}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
      signal: linkedSignal.signal,
      redirect: "manual",
      proxy: false,
    });
    const detachBodyGuard = cancelBodyOnAbort(res.body, linkedSignal.signal);
    try {
      const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
      const explicitSse = contentType.includes("text/event-stream");
      let streamingSse = explicitSse;
      if (res.ok) linkedSignal.touch();

      // Bounded read: count bytes per chunk and cancel the reader the moment the bound is
      // exceeded, instead of materializing the full body before the length check.
      let raw = "";
      let sseBuffer = "";
      let streamedText = "";
      let fallbackMessageText: string | undefined;
      let streamUsage: AdvisorConsultationResult["usage"] | undefined;
      let streamError = false;
      let sawMalformedSseJson = false;
      let sawAnySseData = false;
      let sawDone = false;
      // A stream is complete only with a terminal signal: [DONE], a finish_reason, or response.completed.
      let sawTerminal = false;

      const processSseLine = (line: string) => {
        const trimmed = line.trim();
        if (trimmed === "" || trimmed.startsWith(":")) return;
        if (!trimmed.startsWith("data:")) return;
        linkedSignal.touch();
        sawAnySseData = true;
        const dataStr = trimmed.slice(5).trim();
        if (dataStr === "" || dataStr === "[DONE]") {
          if (dataStr === "[DONE]") { sawDone = true; sawTerminal = true; }
          return;
        }
        let chunk: unknown;
        try {
          chunk = JSON.parse(dataStr);
        } catch {
          sawMalformedSseJson = true;
          return;
        }
        if (extractStreamError(chunk)) {
          streamError = true;
          return;
        }
        if (isTerminalStreamChunk(chunk)) sawTerminal = true;
        const delta = extractDeltaContent(chunk);
        if (delta) streamedText += delta;
        const fullMsg = extractContent(chunk);
        if (fullMsg) fallbackMessageText = fullMsg;
        const chunkUsage = extractUsage(chunk);
        if (chunkUsage) streamUsage = chunkUsage;
      };

      let totalBytes = 0;
      const reader = res.body?.getReader();
      if (reader) {
        const cancelLockedReader = () => { void reader.cancel().catch(() => {}); };
        if (linkedSignal.signal.aborted) cancelLockedReader();
        else linkedSignal.signal.addEventListener("abort", cancelLockedReader, { once: true });
        const decoder = new TextDecoder();
        try {
          for (;;) {
            if (linkedSignal.signal.aborted) {
              throw linkedSignal.signal.reason ?? new Error("advisor aborted");
            }
            const { done, value } = await reader.read();
            if (linkedSignal.signal.aborted) {
              throw linkedSignal.signal.reason ?? new Error("advisor aborted");
            }
            if (done) break;
            totalBytes += value.byteLength;
            if (totalBytes > MAX_ADVISOR_RESPONSE_BYTES) {
              try { await reader.cancel(); } catch { /* body already closing */ }
              return { ok: false, advice: "", advisorModel: input.advisorModel, error: "advisor response exceeded byte bound", durationMs: Date.now() - t0 };
            }
            const decoded = decoder.decode(value, { stream: true });
            if (!streamingSse) {
              raw += decoded;
              const trimmed = raw.trimStart();
              if (trimmed.startsWith("data:") || trimmed.startsWith(":")) {
                streamingSse = true;
                sseBuffer = raw;
                raw = "";
              }
            } else {
              sseBuffer += decoded;
            }
            if (streamingSse) {
              const lines = sseBuffer.split(/\r?\n/);
              sseBuffer = lines.pop() ?? "";
              for (const line of lines) processSseLine(line);
            }
          }
          const flushed = decoder.decode();
          if (!streamingSse) {
            raw += flushed;
            const trimmed = raw.trimStart();
            if (trimmed.startsWith("data:") || trimmed.startsWith(":")) {
              streamingSse = true;
              sseBuffer = raw;
              raw = "";
            }
          } else {
            sseBuffer += flushed;
          }
          if (streamingSse && sseBuffer.length > 0) {
            for (const line of sseBuffer.split(/\r?\n/)) processSseLine(line);
          }
        } finally {
          linkedSignal.signal.removeEventListener("abort", cancelLockedReader);
        }
      }
      const durationMs = Date.now() - t0;
      if (!res.ok) {
        // Status only. Upstream bodies can echo the consultation prompt; they are not logged
        // and not handed to the worker. display-safe body text is intentionally not copied here.
        return {
          ok: false, advice: "", advisorModel: input.advisorModel,
          error: `advisor HTTP ${res.status}`,
          durationMs,
        };
      }
      let content: string | undefined;
      let usage: AdvisorConsultationResult["usage"] | undefined;
      if (streamingSse) {
        if (streamError) {
          return { ok: false, advice: "", advisorModel: input.advisorModel, error: "advisor HTTP 502", durationMs };
        }
        // A malformed event lost part of the answer, and a stream without a terminal signal was cut off:
        // either way the text is incomplete and must not be presented as finished advice.
        if (sawMalformedSseJson) {
          return { ok: false, advice: "", advisorModel: input.advisorModel, error: "advisor returned non-JSON", durationMs };
        }
        if (sawAnySseData && !sawTerminal) {
          return { ok: false, advice: "", advisorModel: input.advisorModel, error: "advisor stream ended before completion", durationMs };
        }
        if (!sawAnySseData && !explicitSse) {
          return { ok: false, advice: "", advisorModel: input.advisorModel, error: "advisor returned non-JSON", durationMs };
        }
        content = streamedText.trim().length > 0 ? streamedText : fallbackMessageText;
        usage = streamUsage;
      } else {
        let payload: unknown;
        try { payload = JSON.parse(raw); } catch {
          return { ok: false, advice: "", advisorModel: input.advisorModel, error: "advisor returned non-JSON", durationMs };
        }
        if (extractStreamError(payload)) {
          return { ok: false, advice: "", advisorModel: input.advisorModel, error: "advisor HTTP 502", durationMs };
        }
        content = extractContent(payload);
        usage = extractUsage(payload);
      }
      if (!content) {
        return { ok: false, advice: "", advisorModel: input.advisorModel, error: "advisor returned no text", durationMs };
      }
      return {
        ok: true,
        advice: content.length > MAX_ADVICE_CHARS ? `${content.slice(0, MAX_ADVICE_CHARS)}… [truncated]` : content,
        advisorModel: input.advisorModel,
        durationMs,
        effectiveEffort: readAdvisorReasoning(res.headers),
        ...(usage ? { usage } : {}),
      };
    } finally {
      detachBodyGuard();
    }
  } catch (e) {
    const durationMs = Date.now() - t0;
    // Client cancellation is not a provider failure: the caller aborted (linked signal), so the
    // task must stay eligible for a later attempt rather than entering a failure cooldown.
    if (abortSignal?.aborted) {
      return { ok: false, cancelled: true, advice: "", advisorModel: input.advisorModel, error: "advisor cancelled by the caller", durationMs };
    }
    const kind = linkedSignal.timedOut || (e instanceof Error && e.name === "TimeoutError") ? "timeout" : "connect_error";
    return {
      ok: false, advice: "", advisorModel: input.advisorModel,
      error: `advisor ${kind}`,
      durationMs,
    };
  } finally {
    policyRegistration?.release();
    sidecarExit();
    linkedSignal.cleanup();
  }
}
