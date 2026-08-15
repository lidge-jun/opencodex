import { comboFailureDecision } from "../../combos/failover";
import { readBoundedResponseBody } from "../../lib/bounded-body";
import { readJsonRequestBody } from "../request-decompress";
import { finishRequestAttempt, type RequestLogContext } from "../request-log";
import type { OcxConfig } from "../../types";
import type { RouteCandidateTrace, RouteDecisionTraceV1 } from "../../routing/trace";
import { handleResponses as handleResponsesCore } from "./core";
import { requestPacingOverloadResponse } from "./pacing-overload";

type CoreHandler = typeof handleResponsesCore;
type CoreOptions = Parameters<CoreHandler>[3];

export interface PolicyFallbackDeps {
  runCore?: CoreHandler;
}

function candidateKey(candidate: Pick<RouteCandidateTrace, "provider" | "model">): string {
  return `${candidate.provider}\u0000${candidate.model}`;
}

/**
 * Rank the remaining candidates from the ORIGINAL policy trace. The initial
 * decision stays immutable; fallback execution belongs in attempts[], not in a
 * rewritten decision trace.
 */
export function rankPolicyFallbackCandidates(
  trace: RouteDecisionTraceV1,
  tried: ReadonlySet<string>,
): RouteCandidateTrace[] {
  return trace.candidates
    .map((candidate, index) => ({ candidate, index }))
    .filter(({ candidate }) =>
      candidate.eligible
      && candidate.exclusions.length === 0
      && !tried.has(candidateKey(candidate)))
    .sort((left, right) => {
      const scoreDelta = (right.candidate.score?.total ?? Number.NEGATIVE_INFINITY)
        - (left.candidate.score?.total ?? Number.NEGATIVE_INFINITY);
      return scoreDelta || left.index - right.index;
    })
    .map(({ candidate }) => candidate);
}

function requestWithCandidate(
  req: Request,
  rawBody: Record<string, unknown>,
  candidate: Pick<RouteCandidateTrace, "provider" | "model">,
): Request {
  const headers = new Headers(req.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.set("content-type", "application/json");
  return new Request(req.url, {
    method: req.method,
    headers,
    body: JSON.stringify({ ...rawBody, model: `${candidate.provider}/${candidate.model}` }),
    signal: req.signal,
  });
}

function errorCodeFromText(text: string): string | undefined {
  if (!text) return undefined;
  try {
    const payload = JSON.parse(text) as { error?: { code?: unknown; type?: unknown }; code?: unknown };
    const candidate = payload.error?.code ?? payload.error?.type ?? payload.code;
    return typeof candidate === "string" ? candidate : undefined;
  } catch {
    return undefined;
  }
}

async function shouldHopPolicyCandidate(response: Response, signal?: AbortSignal): Promise<boolean> {
  if (response.status < 400 || signal?.aborted) return false;
  try {
    const inspected = await readBoundedResponseBody(response.clone(), { signal });
    const text = inspected.displaySafe ? inspected.text : "";
    return comboFailureDecision(response.status, text, { code: errorCodeFromText(text) }) === "hop";
  } catch {
    return false;
  }
}

function isPolicyDecision(trace: RouteDecisionTraceV1 | undefined): trace is RouteDecisionTraceV1 {
  return trace?.routeKind === "policy" && !!trace.profile;
}

/** Finalize the failed physical attempt so the retry receives a fresh attempt row. */
function finishFailedPolicyAttempt(logCtx: RequestLogContext, status: number): void {
  const attempt = logCtx.activeAttempt;
  if (attempt) {
    const startedAt = logCtx.activeAttemptStartedAt ?? Date.now();
    finishRequestAttempt(attempt, status, Math.max(0, Date.now() - startedAt), attempt.usage ?? logCtx.usage);
  }
  delete logCtx.activeAttempt;
  delete logCtx.activeAttemptStartedAt;
  delete logCtx.usage;
  delete logCtx.usageFromBridge;
  delete logCtx.upstreamError;
  delete logCtx.terminalHttpStatus;
  delete logCtx.terminalErrorCode;
  delete logCtx.terminalIncompleteReason;
}

/**
 * Run a Responses request and, only for an explicitly selected policy profile,
 * hop to the next eligible policy candidate after a retryable pre-success
 * failure. The initial policy trace remains the canonical selection evidence;
 * physical retries continue to accumulate in the existing request attempts.
 */
export async function handleResponsesWithPolicyFallback(
  req: Request,
  config: OcxConfig,
  logCtx: RequestLogContext,
  options: CoreOptions = {},
  deps: PolicyFallbackDeps = {},
): Promise<Response> {
  const runCore = deps.runCore ?? handleResponsesCore;
  let requestBodyReadNotified = false;
  const coreOptions: CoreOptions = options.onRequestBodyRead
    ? {
      ...options,
      onRequestBodyRead: () => {
        if (requestBodyReadNotified) return;
        requestBodyReadNotified = true;
        options.onRequestBodyRead?.();
      },
    }
    : options;
  let rawBody: Record<string, unknown> | null = null;
  try {
    const parsed = await readJsonRequestBody(req.clone());
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) rawBody = parsed as Record<string, unknown>;
  } catch {
    // Core owns the client-facing parse/decompression error.
  }

  let response: Response;
  try {
    response = await runCore(req, config, logCtx, coreOptions);
  } catch (error) {
    const overload = requestPacingOverloadResponse(error);
    if (overload) return overload;
    throw error;
  }
  const initialTrace = logCtx.routeDecision;
  const initialRequestedModel = logCtx.requestedModel;
  if (!rawBody || !isPolicyDecision(initialTrace)) return response;

  const tried = new Set<string>([
    candidateKey({ provider: initialTrace.selected.provider, model: initialTrace.selected.model }),
  ]);

  while (await shouldHopPolicyCandidate(response, req.signal)) {
    if (req.signal.aborted) return response;
    const next = rankPolicyFallbackCandidates(initialTrace, tried)[0];
    if (!next) return response;
    tried.add(candidateKey(next));

    finishFailedPolicyAttempt(logCtx, response.status);
    const retryRequest = requestWithCandidate(req, rawBody, next);
    try {
      try {
        response = await runCore(retryRequest, config, logCtx, coreOptions);
      } catch (error) {
        const overload = requestPacingOverloadResponse(error);
        if (overload) return overload;
        throw error;
      }
    } finally {
      logCtx.requestedModel = initialRequestedModel;
      logCtx.routeDecision = initialTrace;
    }
  }

  return response;
}

export const handleResponses = handleResponsesWithPolicyFallback;
