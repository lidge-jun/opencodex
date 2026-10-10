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
import { localAdmissionToken, localInferenceDestination } from "../lib/local-destinations";
import { signalWithTimeout, cancelBodyOnAbort } from "../lib/abort";
import { redactSecretString } from "../lib/redact";
import { sidecarEnter } from "../lib/sidecar-tracker";
import {
  ADVISOR_INTERNAL_CAPABILITY_HEADER,
  internalCallCapability,
} from "../lib/local-internal-call-capability";
import { configuredPort } from "../server/auth-cors";
import { ADVISOR_SYSTEM_INSTRUCTION, buildAdvisorUserPrompt, type AdvisorContextInput } from "./context";

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
}

export function advisorDestinationOrigin(
  config: Pick<OcxConfig, "port" | "hostname" | "unauthenticatedLoopbackListener">,
): string {
  // Same port resolution rule as the vision sidecar: config.port can be 0 (ephemeral bind, tests)
  // or stale after a live port override, so prefer the recorded actual bind port when present.
  const port = config.port && config.port > 0
    ? config.port
    : Number(configuredPort()) || 10_100;
  return localInferenceDestination(config, port).origin;
}

function extractContent(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const message = (choices[0] as { message?: unknown })?.message;
  if (!message || typeof message !== "object") return undefined;
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string" && content.trim().length > 0) return content;
  if (Array.isArray(content)) {
    const joined = content
      .map(part => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : ""))
      .join("");
    if (joined.trim().length > 0) return joined;
  }
  return undefined;
}

function extractUsage(payload: unknown): AdvisorConsultationResult["usage"] {
  if (!payload || typeof payload !== "object") return undefined;
  const usage = (payload as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") return undefined;
  const num = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
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

export async function consultAdvisor(
  input: AdvisorContextInput,
  config: Pick<OcxConfig, "port" | "hostname" | "apiKeys" | "unauthenticatedLoopbackListener">,
  effort: string,
  timeoutMs: number,
  abortSignal?: AbortSignal,
  baseUrlOverride?: string,
): Promise<AdvisorConsultationResult> {
  const t0 = Date.now();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    [ADVISOR_INTERNAL_CAPABILITY_HEADER]: internalCallCapability(),
  };
  // Admission ladder identical to the vision sidecar: env token || service token file || first
  // configured API key, sent as `x-opencodex-api-key` — never Authorization. Loopback binds that
  // require no token simply omit it.
  const admission = localAdmissionToken(config);
  if (admission) headers["x-opencodex-api-key"] = admission;

  const requestBody = {
    model: input.advisorModel,
    stream: false,
    reasoning_effort: effort,
    messages: [
      { role: "system", content: ADVISOR_SYSTEM_INSTRUCTION },
      { role: "user", content: buildAdvisorUserPrompt(input) },
    ],
  };

  const linkedSignal = signalWithTimeout(timeoutMs, abortSignal);
  const sidecarExit = sidecarEnter("advisor");
  if (abortSignal?.aborted) {
    sidecarExit();
    linkedSignal.cleanup();
    return { ok: false, cancelled: true, advice: "", advisorModel: input.advisorModel, error: "advisor cancelled before dispatch", durationMs: Date.now() - t0 };
  }
  try {
    const res = await fetch(`${baseUrlOverride ?? advisorBaseUrl(config)}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
      signal: linkedSignal.signal,
      redirect: "manual",
    });
    const detachBodyGuard = cancelBodyOnAbort(res.body, linkedSignal.signal);
    try {
      // Bounded read: count bytes per chunk and cancel the reader the moment the bound is
      // exceeded, instead of materializing the full body before the length check.
      let raw = "";
      let totalBytes = 0;
      const reader = res.body?.getReader();
      if (reader) {
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          totalBytes += value.byteLength;
          if (totalBytes > MAX_ADVISOR_RESPONSE_BYTES) {
            try { await reader.cancel(); } catch { /* body already closing */ }
            return { ok: false, advice: "", advisorModel: input.advisorModel, error: "advisor response exceeded byte bound", durationMs: Date.now() - t0 };
          }
          raw += decoder.decode(value, { stream: true });
        }
        raw += decoder.decode();
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
      let payload: unknown;
      try { payload = JSON.parse(raw); } catch {
        return { ok: false, advice: "", advisorModel: input.advisorModel, error: "advisor returned non-JSON", durationMs };
      }
      const content = extractContent(payload);
      if (!content) {
        return { ok: false, advice: "", advisorModel: input.advisorModel, error: "advisor returned no text", durationMs };
      }
      return {
        ok: true,
        advice: content.length > MAX_ADVICE_CHARS ? `${content.slice(0, MAX_ADVICE_CHARS)}… [truncated]` : content,
        advisorModel: input.advisorModel,
        durationMs,
        ...(extractUsage(payload) ? { usage: extractUsage(payload) } : {}),
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
    const kind = e instanceof Error && e.name === "TimeoutError" ? "timeout" : "connect_error";
    return {
      ok: false, advice: "", advisorModel: input.advisorModel,
      error: `advisor ${kind}: ${redactSecretString(e instanceof Error ? e.message : String(e))}`,
      durationMs,
    };
  } finally {
    sidecarExit();
    linkedSignal.cleanup();
  }
}
