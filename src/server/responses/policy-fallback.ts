import { comboFailureDecision } from "../../combos/failover";
import { readBoundedResponseBody } from "../../lib/bounded-body";
import { isNonReplayableResponse } from "../../lib/upstream-retry";
import { finishRequestAttempt, type RequestLogContext } from "../request-log";
import { linkRequestSessionLane } from "../request-log-conversation";
import type { OcxConfig } from "../../types";
import type { RouteCandidateTrace, RouteDecisionTraceV1 } from "../../routing/trace";
import { handleResponses as handleResponsesCore } from "./core";
import { requestPacingOverloadResponse } from "./pacing-overload";
import { captureExplicitOpenAiCallerAuth } from "../../providers/openai-sidecar";
import { captureCallerDirectAuth } from "../../providers/caller-authorization";
import { resolvePolicyProfileId } from "../../routing/profile";
import { parseSyntheticRowId } from "../fast-row";
import { routeConcreteModel } from "../../router";
import { isPolicyCandidateRefusal, policyWireDestination, type PolicyRequestScope } from "./policy-request-scope";

type CoreHandler = typeof handleResponsesCore;
type CoreOptions = Parameters<CoreHandler>[3];

export interface PolicyFallbackDeps {
  runCore?: CoreHandler;
}

function candidateKey(candidate: Pick<RouteCandidateTrace, "provider" | "model">): string {
  return `${candidate.provider}\u0000${candidate.model}`;
}

function staysWithinPolicyAfterRedirect(
  config: OcxConfig,
  policyEligibility: ReadonlySet<string>,
  candidate: RouteCandidateTrace,
  triedDestinations: ReadonlySet<string>,
): boolean {
  try {
    // Both inspection and execution resolve the original concrete candidate, without public
    // combo/profile aliases or combo selection writes. A redirect must remain in the evaluation.
    const routed = routeConcreteModel(config, `${candidate.provider}/${candidate.model}`);
    return policyEligibility.has(`${routed.providerName}\u0000${routed.modelId}`)
      && !triedDestinations.has(policyWireDestination(routed));
  } catch {
    // A route that fails to resolve (e.g. a redirect cycle) cannot succeed on retry; its terminal
    // error is rarely hop-worthy, so keep the fallback alive for the next eligible candidate.
    return false;
  }
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
  // The next candidate owns a different physical credential domain. Typed
  // admission and any claimed Claude snapshot stay in caller-owned CoreOptions.
  headers.delete("authorization");
  headers.delete("chatgpt-account-id");
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.set("content-type", "application/json");
  const retryRequest = new Request(req.url, {
    method: req.method,
    headers,
    body: JSON.stringify({ ...rawBody, model: `${candidate.provider}/${candidate.model}` }),
    signal: req.signal,
  });
  // A sessionless request keeps the lane it was already allocated. Without this the second
  // candidate reaches OpenCode Go under a different x-opencode-session than the first attempt,
  // which is the same conversation split the header exists to prevent.
  linkRequestSessionLane(req, retryRequest);
  return retryRequest;
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
  // A response that must not be sent again cannot open a policy-candidate retry either.
  if (isNonReplayableResponse(response)) return false;
  if (isPolicyCandidateRefusal(response)) return true;
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
  const policyScope: PolicyRequestScope = options.policyRequestScope ?? { triedDestinations: new Set() };
  let requestBodyReadNotified = false;
  let storedPool401ReplayDispatched = false;
  let rawBody: Record<string, unknown> | null = null;
  const coreOptions: CoreOptions = {
    ...options,
    policyRequestScope: policyScope,
    openAiSidecarAuth: options.openAiSidecarAuth === undefined
      ? captureExplicitOpenAiCallerAuth(req.headers, config) : options.openAiSidecarAuth,
    nativeCallerAuth: options.nativeCallerAuth === undefined
      ? captureExplicitOpenAiCallerAuth(req.headers, config) : options.nativeCallerAuth,
    callerDirectAuth: options.callerDirectAuth === undefined
      ? captureCallerDirectAuth(req.headers, config) : options.callerDirectAuth,
    ...(options.onRequestBodyRead ? {
      onRequestBodyRead: () => {
        if (requestBodyReadNotified) return;
        requestBodyReadNotified = true;
        options.onRequestBodyRead?.();
      },
    } : {}),
    onRequestBodyParsed: body => {
      options.onRequestBodyParsed?.(body);
      if (rawBody === null && body && typeof body === "object" && !Array.isArray(body)
        && typeof (body as { model?: unknown }).model === "string") {
        const model = (body as { model: string }).model;
        const { fastRow, effortRow } = parseSyntheticRowId(model, config);
        if (resolvePolicyProfileId(config, fastRow?.baseId ?? effortRow?.baseId ?? model) === null) return;
        // Recovery and other core preparation may mutate the parsed body in place. Keep an
        // immutable snapshot of the original wire body so a retry cannot serialize those
        // mutations. Object-identity metadata is re-established by each attempt, not serialized.
        rawBody = structuredClone(body as Record<string, unknown>);
      }
    },
    onStoredPool401ReplayDispatched: () => {
      storedPool401ReplayDispatched = true;
      options.onStoredPool401ReplayDispatched?.();
    },
  };
  let response: Response;
  try {
    response = await runCore(req, config, logCtx, coreOptions);
  } catch (error) {
    const overload = requestPacingOverloadResponse(error);
    if (overload) return overload;
    throw error;
  }
  const initialTrace = policyScope.decision ?? logCtx.routeDecision;
  const initialRequestedModel = logCtx.requestedModel;
  if (!rawBody || !isPolicyDecision(initialTrace)) return response;

  const tried = new Set<string>([
    candidateKey({ provider: initialTrace.selected.provider, model: initialTrace.selected.model }),
  ]);
  const selectedCandidate = initialTrace.selected.candidateIndex === undefined ? undefined
    : initialTrace.candidates[initialTrace.selected.candidateIndex];
  if (selectedCandidate) tried.add(candidateKey(selectedCandidate));
  // Redirect eligibility needs the full evaluation membership, not the bounded trace list.
  const policyEligibility: ReadonlySet<string> = policyScope.eligibility ?? logCtx.policyEligibility
    ?? new Set(initialTrace.candidates
      .filter(candidate => candidate.eligible)
      .map(candidate => candidateKey(candidate)));
  policyScope.eligibility = policyEligibility;
  policyScope.decision = initialTrace;
  policyScope.triedDestinations.add(policyScope.preparedDestination ?? policyWireDestination({
    providerName: initialTrace.selected.provider, modelId: initialTrace.selected.model,
  }));

  while (!storedPool401ReplayDispatched && await shouldHopPolicyCandidate(response, req.signal)) {
    if (req.signal.aborted) return response;
    const next = rankPolicyFallbackCandidates(initialTrace, tried)
      .find(candidate => staysWithinPolicyAfterRedirect(config, policyEligibility, candidate, policyScope.triedDestinations));
    if (!next) return response;
    tried.add(candidateKey(next));

    // Retain the failed response's log owner until a candidate actually replaces it. This is
    // deliberately shallow: completed attempts and the live spend tracker keep their identity.
    const failureLog = { ...logCtx };
    finishFailedPolicyAttempt(logCtx, response.status);
    const retryRequest = requestWithCandidate(req, rawBody, next);
    delete policyScope.preparedDestination;
    try {
      try {
        const nextResponse = await runCore(retryRequest, config, logCtx, { ...coreOptions, policyFallbackCandidate: next });
        // A locally skipped route owns neither the returned failure nor its usage/settlement.
        // Preparation can replace route metadata and the tracker, or add fields absent before it.
        if (isPolicyCandidateRefusal(nextResponse)) {
          for (const key of Object.keys(logCtx)) {
            if (!Object.hasOwn(failureLog, key)) Reflect.deleteProperty(logCtx, key);
          }
          Object.assign(logCtx, failureLog);
        } else response = nextResponse;
        if (policyScope.preparedDestination) policyScope.triedDestinations.add(policyScope.preparedDestination);
      } catch (error) {
        const overload = requestPacingOverloadResponse(error);
        if (overload) return overload;
        throw error;
      }
    } finally {
      logCtx.requestedModel = initialRequestedModel;
      logCtx.routeDecision = initialTrace;
      logCtx.policyEligibility = policyEligibility;
    }
  }

  return response;
}

export const handleResponses = handleResponsesWithPolicyFallback;
