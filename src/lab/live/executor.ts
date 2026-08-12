import { evaluateAssertions } from "../conformance/assertion";
import { emptyObservation, finalizeObservation, setClientResponse } from "../conformance/observation";
import { normalizeSseBytes } from "../conformance/sse-normalize";
import type { CaseAuthority, CaseRecord, FailureClassification, FailureRule, NormalizedEvent, NormalizedObservation } from "../conformance/types";
import { domainHash, jcsStringify, scenarioManifestDigest, subjectIdForSubject, suiteManifestDigest } from "../digest";
import type { RouteSubjectV1 } from "../events/types";
import { isTrustedLabRouteExecutor } from "../../lib/lab-live-execution-authority";
import { buildRouteSubjectV1 } from "../subject/route-subject";
import { createLabDestination, LabDestinationError } from "./destination";
import { expandLiveScenario, loadLiveCaseAuthority } from "./manifest";
import { createSandboxResourceState, enforceSandboxLimits, LabSandboxError, prepareLiveSandbox } from "./sandbox";
import { liveSuiteManifestObjectForCase } from "./suite-manifest";
import { classifyTransportError, TransportError } from "./transport";
import type { DnsResolver, LabRouteContext, LabTransport, LiveExecutionAuthority, LiveRunConfig, LiveScenarioRunResult, TrustedLabRouteExecutor } from "./types";

export interface LiveExecutorOptions {
  /** Host-issued exact-route capability for evidence-eligible production execution. */
  routeExecutor?: TrustedLabRouteExecutor;
  /** Test-only byte transport. Results are deliberately not evidence-eligible. */
  transport?: LabTransport;
  resolve?: DnsResolver;
  configDir?: string;
  env?: NodeJS.ProcessEnv;
  /** Orchestration cancellation — must not produce route incompatibility evidence. */
  cancelSignal?: AbortSignal;
}

interface TrustedLiveResultReceipt {
  authorityDigest: string;
  scenarioId: string;
  suiteId: string;
  scenarioManifestDigest: string;
  suiteManifestDigest: string;
  routeSubjectId: string;
  resultDigest: string;
  retryPolicy: FailureRule["retry"] | null;
}

const TRUSTED_RESULT_RECEIPTS = new WeakMap<object, TrustedLiveResultReceipt>();
const LIVE_AUTHORITY_DOMAIN = "ocx-lab:live-authority:v1";
const TRUSTED_LIVE_RESULT_DOMAIN = "ocx-lab:trusted-live-result:v1";

function trustedResultDigest(result: LiveScenarioRunResult): string {
  const payload = {
    scenarioId: result.scenarioId,
    suite: result.suite,
    startedAt: result.startedAt,
    completedAt: result.completedAt,
    passed: result.passed,
    classification: result.classification,
    secondaryCode: result.secondaryCode ?? null,
    assertionResults: result.assertionResults.map((row) => ({
      id: row.id,
      operator: row.operator,
      required: row.required,
      passed: row.passed,
      observedSummary: row.observedSummary,
      reason: row.reason ?? null,
    })),
    diagnostics: [...result.diagnostics],
    routeSubject: result.routeSubject ?? null,
    transportError: result.transportError ?? null,
    executionAuthority: result.executionAuthority,
  };
  return domainHash(TRUSTED_LIVE_RESULT_DOMAIN, jcsStringify(payload));
}

function receiptFor(result: LiveScenarioRunResult, caseRecord: CaseRecord, authority: CaseAuthority, retryPolicy: FailureRule["retry"] | null): TrustedLiveResultReceipt {
  if (!result.routeSubject) throw new Error("trusted live result has no route subject");
  return {
    authorityDigest: domainHash(LIVE_AUTHORITY_DOMAIN, jcsStringify(authority)),
    scenarioId: caseRecord.id,
    suiteId: caseRecord.suite,
    scenarioManifestDigest: scenarioManifestDigest(expandLiveScenario(caseRecord, authority)),
    suiteManifestDigest: suiteManifestDigest(liveSuiteManifestObjectForCase(caseRecord, authority)),
    routeSubjectId: subjectIdForSubject(result.routeSubject),
    resultDigest: trustedResultDigest(result),
    retryPolicy,
  };
}

function sealTrustedLiveResult(result: LiveScenarioRunResult, caseRecord: CaseRecord, authority: CaseAuthority, retryPolicy: FailureRule["retry"] | null): void {
  TRUSTED_RESULT_RECEIPTS.set(result, receiptFor(result, caseRecord, authority, retryPolicy));
}

/** Verify the module-private execution receipt before any live result enters persistence. */
export function assertTrustedLiveResultReceipt(result: LiveScenarioRunResult, caseRecord: CaseRecord, authority: CaseAuthority): void {
  const actual = TRUSTED_RESULT_RECEIPTS.get(result);
  if (!actual || result.executionAuthority !== "trusted_route") {
    throw new Error("live result lacks trusted execution receipt");
  }
  const expected = receiptFor(result, caseRecord, authority, actual.retryPolicy);
  for (const key of Object.keys(expected) as Array<keyof TrustedLiveResultReceipt>) {
    if (actual[key] !== expected[key]) throw new Error("live result trusted execution receipt mismatch");
  }
  if (result.scenarioId !== caseRecord.id || result.suite !== caseRecord.suite) {
    throw new Error("live result scenario identity mismatch");
  }
}

/** Return retryability sealed by the executor after validating the trusted receipt. */
export function trustedLiveResultRetryable(result: LiveScenarioRunResult, caseRecord: CaseRecord, authority: CaseAuthority): boolean {
  assertTrustedLiveResultReceipt(result, caseRecord, authority);
  return TRUSTED_RESULT_RECEIPTS.get(result)?.retryPolicy === "bounded";
}

function liveLimitsFromAuthority(authorityLimits: Record<string, number>): LiveRunConfig {
  return {
    totalTimeoutMs: authorityLimits.totalTimeoutMs ?? 120_000, connectTimeoutMs: authorityLimits.connectTimeoutMs ?? 10_000,
    firstByteTimeoutMs: authorityLimits.firstByteTimeoutMs ?? 30_000, inactivityTimeoutMs: authorityLimits.inactivityTimeoutMs ?? 30_000,
    maxRequests: authorityLimits.maxRequests ?? 16, maxInputBytes: authorityLimits.maxInputBytes ?? 8 * 1024 * 1024,
    maxOutputBytes: authorityLimits.maxOutputBytes ?? 16 * 1024 * 1024, maxOutputTokens: authorityLimits.maxOutputTokens ?? 32_768,
    maxToolCalls: authorityLimits.maxToolCalls ?? 32, maxMemoryBytes: authorityLimits.maxMemoryBytes ?? 512 * 1024 * 1024,
    maxChildProcesses: authorityLimits.maxChildProcesses ?? 0, maxArtifacts: authorityLimits.maxArtifacts ?? 16,
    perArtifactBytes: authorityLimits.perArtifactBytes ?? 256 * 1024, aggregateArtifactBytes: authorityLimits.aggregateArtifactBytes ?? 1024 * 1024,
  };
}

export function isLiveCaseApplicableToRoute(caseRecord: CaseRecord, route: LabRouteContext): boolean {
  const req = caseRecord.requirements;
  if (!req.inboundProtocols.includes(route.inboundProtocol) || !req.upstreamProtocols.includes(route.upstreamProtocol) || !req.surfaces.includes(route.surface)) return false;
  if (req.platforms.length > 0 && !req.platforms.includes(process.platform)) return false;
  if (!req.requiredClaims.every((claim) => (route.requiredClaims ?? []).includes(claim))) return false;
  if (!req.requiredHarnessFeatures.every((feature) => (route.availableHarnessFeatures ?? []).includes(feature))) return false;
  return true;
}

function routePreconditionFailure(route: LabRouteContext, caseRecord: CaseRecord): string | null {
  for (const precondition of caseRecord.requirements.routePreconditions) {
    if (precondition === "lab_run_approval" && route.labRunApproval !== true) return "route_precondition_unmet:lab_run_approval";
    if (precondition === "allow_private_network" && route.allowPrivateNetwork !== true) return "route_precondition_unmet:allow_private_network";
  }
  return null;
}

function classifyWithFailureRules(rules: FailureRule[], signal: string): { classification: FailureClassification; secondaryCode: string; retryPolicy: FailureRule["retry"] | null } {
  const rule = rules.find((row) => row.match.includes(signal));
  return rule ? { classification: rule.classification, secondaryCode: rule.secondaryCode ?? signal, retryPolicy: rule.retry }
    : { classification: "inconclusive", secondaryCode: "unclassified", retryPolicy: null };
}

function pathForProtocol(protocol: string): string {
  if (protocol === "openai-chat") return "/chat/completions";
  if (protocol === "anthropic-messages") return "/messages";
  return "/responses";
}

/** Upstream HTTP path for a trusted live-route request (CL-03 / CL-08 production dispatch). */
export function liveUpstreamRequestPath(protocol: string): string {
  return pathForProtocol(protocol);
}

function chatObservation(body: string, status: number): NormalizedObservation {
  const observation = emptyObservation();
  const output: unknown[] = [];
  let text = "";
  let terminal = false;
  const trimmed = body.trimStart();
  if (trimmed.startsWith("data:")) {
    const toolParts = new Map<number, { id: string; name: string; arguments: string }>();
    for (const frame of body.split(/\r?\n\r?\n/)) {
      const line = frame.split(/\r?\n/).find((row) => row.startsWith("data:"));
      if (!line) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") { if (payload === "[DONE]") terminal = true; continue; }
      let json: any;
      try { json = JSON.parse(payload); } catch { continue; }
      for (const choice of Array.isArray(json.choices) ? json.choices : []) {
        if (typeof choice?.delta?.content === "string") text += choice.delta.content;
        if (choice?.finish_reason != null) terminal = true;
        for (const call of Array.isArray(choice?.delta?.tool_calls) ? choice.delta.tool_calls : []) {
          const idx = Number.isInteger(call?.index) ? call.index : toolParts.size;
          const prior = toolParts.get(idx) ?? { id: "", name: "", arguments: "" };
          if (typeof call?.id === "string") prior.id = call.id;
          if (typeof call?.function?.name === "string") prior.name = call.function.name;
          if (typeof call?.function?.arguments === "string") prior.arguments += call.function.arguments;
          toolParts.set(idx, prior);
        }
      }
    }
    for (const row of [...toolParts.entries()].sort((a, b) => a[0] - b[0]).map(([, value]) => value)) {
      output.push({ type: "function_call", call_id: row.id, name: row.name, arguments: row.arguments });
    }
  } else {
    const json = JSON.parse(body) as any;
    const choice = Array.isArray(json.choices) ? json.choices[0] : undefined;
    if (typeof choice?.message?.content === "string") text = choice.message.content;
    terminal = choice?.finish_reason != null;
    for (const call of Array.isArray(choice?.message?.tool_calls) ? choice.message.tool_calls : []) {
      output.push({ type: "function_call", call_id: call.id, name: call.function?.name, arguments: call.function?.arguments });
    }
  }
  if (text) output.unshift({ type: "message", content: [{ type: "output_text", text }] });
  const json = { status: terminal ? "completed" : "incomplete", output };
  const events: NormalizedEvent[] = terminal ? [{ event: "response.completed", data: { response: json }, ordinal: 0 }] : [];
  finalizeObservation(observation, events, json, status);
  return observation;
}

function responsesObservation(body: string, status: number): NormalizedObservation {
  const observation = emptyObservation();
  const trimmed = body.trimStart();
  if (trimmed.startsWith("data:") || trimmed.startsWith("event:")) {
    const events = normalizeSseBytes(new TextEncoder().encode(body), "openai-responses");
    finalizeObservation(observation, events, null, status);
    return observation;
  }
  const json = JSON.parse(body) as Record<string, unknown>;
  finalizeObservation(observation, [], json, status);
  const state = typeof json.status === "string" ? json.status : undefined;
  if (state === "completed" || state === "failed" || state === "incomplete") {
    setClientResponse(observation, { terminal: state === "completed" ? "completed" : state });
  }
  return observation;
}

function normalizeTransportObservation(route: LabRouteContext, response: { status: number; body: string }): NormalizedObservation {
  const observation = route.upstreamProtocol === "openai-chat" ? chatObservation(response.body, response.status) : responsesObservation(response.body, response.status);
  if (route.surface.startsWith("anthropic-") && observation.client.response.terminal === "completed") {
    setClientResponse(observation, { terminal: "message_stop" });
  }
  return observation;
}

/** Normalize a pinned provider response into a Lab observation (trusted-route production path). */
export function normalizeLabLiveTransportObservation(
  route: LabRouteContext,
  response: { status: number; body: string },
): NormalizedObservation {
  return normalizeTransportObservation(route, response);
}

async function withTotalTimeout<T>(
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
  cancelSignal?: AbortSignal,
): Promise<T> {
  if (cancelSignal?.aborted) throw cancelSignal.reason ?? new TransportError("harness_failure", "cancelled");
  const controller = new AbortController();
  const abortFromCancel = () => controller.abort(cancelSignal?.reason ?? new TransportError("harness_failure", "cancelled"));
  if (cancelSignal) cancelSignal.addEventListener("abort", abortFromCancel, { once: true });
  const timer = setTimeout(() => controller.abort(new TransportError("total_timeout", "live scenario total timeout")), timeoutMs);
  try {
    return await Promise.race([
      run(controller.signal),
      new Promise<T>((_, reject) => controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true })),
    ]);
  } finally {
    clearTimeout(timer);
    if (cancelSignal) cancelSignal.removeEventListener("abort", abortFromCancel);
  }
}

export async function runLiveScenario(caseRecord: CaseRecord, routeContext: LabRouteContext, opts: LiveExecutorOptions = {}): Promise<LiveScenarioRunResult> {
  const diagnostics: string[] = [];
  const startedAt = Date.now();
  let routeSubject: RouteSubjectV1 | undefined;
  let executionAuthority: LiveExecutionAuthority = "none";
  let authority: CaseAuthority | undefined;
  let activeCase = caseRecord;
  let trustedExecutionStarted = false;
  let failureRules: FailureRule[] = [];
  const complete = (partial: Omit<LiveScenarioRunResult, "startedAt" | "completedAt" | "executionAuthority">, retryPolicy: FailureRule["retry"] | null = null): LiveScenarioRunResult => {
    const result: LiveScenarioRunResult = { ...partial, executionAuthority, startedAt, completedAt: Math.max(startedAt, Date.now()) };
    if (trustedExecutionStarted && authority && result.routeSubject) sealTrustedLiveResult(result, activeCase, authority, retryPolicy);
    return result;
  };
  try {
    const environment = prepareLiveSandbox(opts.env);
    authority = loadLiveCaseAuthority();
    const canonicalCase = authority.cases.find((row) => row.id === caseRecord.id);
    if (!canonicalCase || jcsStringify(canonicalCase) !== jcsStringify(caseRecord)) {
      throw new TransportError("harness_failure", "live scenario does not match canonical authority");
    }
    activeCase = canonicalCase;
    if (!isLiveCaseApplicableToRoute(activeCase, routeContext)) {
      return complete({ scenarioId: activeCase.id, suite: activeCase.suite, passed: false, classification: "inconclusive", secondaryCode: "scenario_inapplicable", assertionResults: [], diagnostics, routeSubject });
    }
    const preconditionFailure = routePreconditionFailure(routeContext, activeCase);
    if (preconditionFailure) {
      return complete({ scenarioId: activeCase.id, suite: activeCase.suite, passed: false, classification: "inconclusive", secondaryCode: preconditionFailure, assertionResults: [], diagnostics: [preconditionFailure], routeSubject });
    }
    const expanded = expandLiveScenario(activeCase, authority);
    failureRules = expanded.failureRules as FailureRule[];
    const limits = liveLimitsFromAuthority(expanded.executionLimits as Record<string, number>);
    const destination = await createLabDestination({ baseUrl: routeContext.baseUrl, allowPrivateNetwork: routeContext.allowPrivateNetwork, labRunApproval: routeContext.labRunApproval, resolve: opts.resolve, configDir: opts.configDir });
    routeSubject = buildRouteSubjectV1(routeContext, destination, opts.configDir);
    const state = createSandboxResourceState();
    let observation: NormalizedObservation;
    if (opts.routeExecutor) {
      if (!isTrustedLabRouteExecutor(opts.routeExecutor)) throw new TransportError("untrusted_route_executor", "untrusted route executor capability");
      executionAuthority = "trusted_route";
      trustedExecutionStarted = true;
      observation = await withTotalTimeout(limits.totalTimeoutMs, (signal) => opts.routeExecutor!.execute({ routeContext, destination, routeSubject: routeSubject!, scenarioId: activeCase.id, initiatingRequest: activeCase.initiatingRequest?.bytesUtf8, limits, signal, environment }), opts.cancelSignal);
    } else if (opts.transport && activeCase.initiatingRequest) {
      executionAuthority = "test_transport";
      const body = activeCase.initiatingRequest.bytesUtf8;
      const inputBytes = new TextEncoder().encode(body).byteLength;
      enforceSandboxLimits(state, limits, { requests: 1, inputBytes });
      const response = await withTotalTimeout(limits.totalTimeoutMs, (signal) => opts.transport!.request({ method: "POST", path: pathForProtocol(routeContext.upstreamProtocol), body, signal }), opts.cancelSignal);
      if (response.status === 401 || response.status === 403) throw new TransportError("auth_blocked", `HTTP ${response.status}`);
      if (response.status === 429) throw new TransportError("quota_blocked", "HTTP 429");
      if (response.status === 451) throw new TransportError("region_blocked", "HTTP 451");
      if (response.status >= 500) throw new TransportError("provider_transient", `HTTP ${response.status}`);
      const outputBytes = new TextEncoder().encode(response.body).byteLength;
      enforceSandboxLimits(state, limits, { outputBytes, outputTokens: Math.ceil(outputBytes / 4) });
      observation = normalizeTransportObservation(routeContext, response);
    } else {
      throw new TransportError("live_transport_required", activeCase.initiatingRequest ? "live transport or trusted route executor required" : "trusted route executor required");
    }
    const assertionResults = evaluateAssertions(activeCase.assertions, observation);
    const requiredFailures = assertionResults.filter((row) => row.required && !row.passed);
    if (activeCase.expectedFailure) {
      const matched = activeCase.expectedFailure.assertionIds.every((id) => assertionResults.find((row) => row.id === id)?.passed === true) && requiredFailures.length === 0;
      if (matched) {
        return complete({ scenarioId: activeCase.id, suite: activeCase.suite, passed: true, classification: activeCase.expectedFailure.expectedClass, secondaryCode: activeCase.expectedFailure.expectedCode, assertionResults, diagnostics, routeSubject });
      }
      const mismatch = classifyWithFailureRules(failureRules, "required_assertion_failed");
      return complete({ scenarioId: activeCase.id, suite: activeCase.suite, passed: false, classification: mismatch.classification, secondaryCode: mismatch.secondaryCode, assertionResults, diagnostics, routeSubject }, mismatch.retryPolicy);
    }
    const passed = requiredFailures.length === 0;
    const classified = passed ? { classification: "inconclusive" as FailureClassification, secondaryCode: "pass", retryPolicy: null } : classifyWithFailureRules(failureRules, "required_assertion_failed");
    return complete({ scenarioId: activeCase.id, suite: activeCase.suite, passed, classification: passed ? "inconclusive" : classified.classification, secondaryCode: passed ? undefined : classified.secondaryCode, assertionResults, diagnostics, routeSubject }, passed ? null : classified.retryPolicy);
  } catch (error) {
    const diagnosticCode = error instanceof TransportError || error instanceof LabSandboxError || error instanceof LabDestinationError
      ? error.code
      : "execution_error";
    diagnostics.push(diagnosticCode);
    let classified = classifyTransportError(error);
    if (error instanceof LabSandboxError) classified = { classification: error.code === "harness_failure" ? "harness_failure" : "budget_exhausted", secondaryCode: error.code };
    if (error instanceof LabDestinationError) classified = { classification: error.code === "network_blocked" ? "network_failure" : "harness_failure", secondaryCode: error.code };
    const failureSignal = error instanceof TransportError || error instanceof LabSandboxError || error instanceof LabDestinationError ? error.code : "harness_failure";
    const retryPolicy = failureRules.find((rule) => rule.match.includes(failureSignal))?.retry ?? null;
    return complete({ scenarioId: activeCase.id, suite: activeCase.suite, passed: false, classification: classified.classification, secondaryCode: classified.secondaryCode, assertionResults: [], diagnostics, routeSubject, transportError: error instanceof TransportError ? error.code : undefined }, retryPolicy);
  }
}