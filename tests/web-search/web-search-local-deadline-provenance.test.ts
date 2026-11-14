import { afterEach, describe, expect, test } from "bun:test";
import type { AdapterFetchContext, ProviderAdapter } from "../../src/adapters/base";
import { parseRequest } from "../../src/responses/parser";
import { responseWithDeferredRequestLog, type RequestLogEntry } from "../../src/server";
import type { RequestLogContext } from "../../src/server/request-log";
import type { AdapterEvent, OcxProviderConfig } from "../../src/types";
import { runWithWebSearch, type WebSearchLoopDeps } from "../../src/web-search/loop";
import { createTestTranslatorBudget } from "../helpers/translator-budget";
import type { OcxConfig } from "../../src/types";
import type { RouteDecisionTraceV1 } from "../../src/routing/trace";
import { handleResponsesWithPolicyFallback } from "../../src/server/responses/policy-fallback";
import { PolicyCandidateUnavailableError, policyCandidateRefusalResponse } from "../../src/server/responses/policy-request-scope";
import { resetStreamedOpaqueBlobLogContext } from "../../src/server/responses/core-opaque-recovery";
import { recordLocalFailureDetail, upstreamErrorIsLocal } from "../../src/server/request-log-failure-detail";

/**
 * T04-b: a web-search deadline this proxy enforces must reach the request row as local failure
 * detail, never as upstream evidence, while the client wire, error code and retry facts stay as
 * they were. A real upstream status keeps its upstream provenance.
 */

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const forwardProvider: OcxProviderConfig = { adapter: "openai-responses", baseUrl: "https://chatgpt.test/v1", authMode: "forward" };
const request = () => ({ url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" });
const HEADER_MS = 30;
const STALL_MS = 40;
const headerSentence = (ms: number) => "Provider response-header timeout after " + ms + "ms during web-search";
const stallSentence = (ms: number) => "Routed model generation timeout after " + ms + "ms without response bytes during web-search";

function hanging(ctx?: AdapterFetchContext): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = ctx?.abortSignal;
    const fail = () => reject(signal?.reason ?? new DOMException("aborted", "AbortError"));
    if (signal?.aborted) fail();
    else signal?.addEventListener("abort", fail, { once: true });
  });
}

function sidecarSearchSucceeds(): void {
  globalThis.fetch = (async () => new Response(
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"docs result"}\n\n'
      + 'event: response.completed\ndata: {"type":"response.completed"}\n\n',
    { headers: { "content-type": "text/event-stream" } },
  )) as unknown as typeof fetch;
}

const searchCall: AdapterEvent[] = [
  { type: "tool_call_start", id: "search_1", name: "web_search" },
  { type: "tool_call_delta", arguments: JSON.stringify({ query: "current docs" }) },
  { type: "tool_call_end" },
];

let wireSeq = 0;

interface Outcome {
  wireStatus: number;
  wire: string;
  row: RequestLogEntry & Record<string, unknown>;
}

async function run(adapter: ProviderAdapter, extra: Partial<WebSearchLoopDeps> = {}, providerName?: string): Promise<Outcome> {
  const logCtx = { model: "routed/model", provider: providerName ?? "routed" } as RequestLogContext;
  const response = await runWithWebSearch({
    parsed: parseRequest({ model: "routed/model", input: "Search current docs", stream: true, tools: [{ type: "web_search" }] }),
    adapter,
    forwardProvider,
    hostedTool: { type: "web_search" },
    selectedForwardHeaders: new Headers({ authorization: "Bearer forwarded" }),
    settings: { model: "gpt-5.6-luna", reasoning: "low", timeoutMs: 1_000 },
    maxSearches: 1,
    incomingMeta: { headers: new Headers(), translatorBudget: createTestTranslatorBudget(), ...(providerName ? { providerName } : {}) },
    proxyErrorContext: logCtx,
    ...extra,
  });
  const entries: RequestLogEntry[] = [];
  const wire = await responseWithDeferredRequestLog(response, "ocx-t04b", Date.now(), logCtx, entry => entries.push(entry)).text();
  expect(entries).toHaveLength(1);
  // Response ids and timestamps are per-run; everything else on the wire is compared verbatim.
  const normalized = wire.replace(/"id":"resp_[0-9a-f]+"/g, '"id":"resp_X"').replace(/"created_at":\d+/g, '"created_at":0');
  console.log("WIRE " + adapter.name + "#" + (++wireSeq) + " " + JSON.stringify({ status: response.status, wire: normalized }));
  return { wireStatus: response.status, wire: normalized, row: entries[0] as Outcome["row"] };
}

function failedError(wire: string): unknown {
  const frame = wire.split("\n\n").find(block => block.startsWith("event: response.failed"));
  if (!frame) return undefined;
  const data = JSON.parse(frame.split("\n").find(line => line.startsWith("data: "))!.slice(6));
  return data.response.error;
}

const done = async function* (): AsyncGenerator<AdapterEvent> { yield { type: "done" }; };
const noParseResponse = async () => [{ type: "done" } as AdapterEvent];

describe("T04-b local deadline provenance in the request row", () => {
  test("first-iteration header deadline: wire unchanged, row carries local header_timeout and no upstream condition", async () => {
    const out = await run({ name: "header-hang", buildRequest: request, fetchResponse: (_r, ctx) => hanging(ctx), parseStream: done, parseResponse: noParseResponse },
      { connectTimeoutMs: HEADER_MS });
    expect(out.wireStatus).toBe(504);
    expect(JSON.parse(out.wire)).toEqual({ error: { message: headerSentence(HEADER_MS), type: "upstream_error", code: null } });
    expect(out.row).toMatchObject({ status: 504, errorCode: "upstream_server_error", closeReason: "non_stream", failureDetail: { code: "header_timeout", value: HEADER_MS }, failureCause: "upstream-fault" });
    expect(out.row.upstreamCondition).toBeUndefined();
  }, 2_000);

  test("first-iteration body stall: wire unchanged, row carries local generation_timeout and no upstream condition", async () => {
    const out = await run({
      name: "silent-body", buildRequest: request,
      fetchResponse: async () => new Response(new ReadableStream<Uint8Array>({}), { status: 200 }),
      async *parseStream(response) { await response.text(); yield { type: "done" }; },
      parseResponse: noParseResponse,
    }, { routedModelStallTimeoutMs: STALL_MS });
    expect(out.wireStatus).toBe(200);
    expect(failedError(out.wire)).toEqual({ message: stallSentence(STALL_MS), type: "server_error", code: "upstream_server_error" });
    expect(out.row).toMatchObject({ status: 504, errorCode: "upstream_server_error", terminalStatus: "failed", terminalSource: "upstream", failureDetail: { code: "generation_timeout", value: STALL_MS }, failureCause: "upstream-fault" });
    expect(out.row.upstreamCondition).toBeUndefined();
  }, 2_000);

  test("later-iteration header deadline after one search keeps local provenance in-stream", async () => {
    sidecarSearchSucceeds();
    let pass = 0;
    const out = await run({
      name: "search-then-header-hang", buildRequest: request,
      fetchResponse: (_r, ctx) => ++pass === 1 ? Promise.resolve(new Response("first", { status: 200 })) : hanging(ctx),
      async *parseStream(response) { await response.text(); yield* searchCall; yield { type: "done" }; },
      parseResponse: noParseResponse,
    }, { connectTimeoutMs: HEADER_MS });
    expect(pass).toBe(2);
    expect(out.wireStatus).toBe(200);
    expect(failedError(out.wire)).toMatchObject({ message: headerSentence(HEADER_MS) });
    expect(out.row).toMatchObject({ terminalStatus: "failed", failureDetail: { code: "header_timeout", value: HEADER_MS } });
    expect(out.row.upstreamCondition).toBeUndefined();
  }, 2_000);

  test("nested recovery: a header deadline inside recover() survives the outer catch as local provenance", async () => {
    let sends = 0;
    const thinkingRecovery = {
      prepareEvent: () => true,
      prepareHttp: async () => false,
      observeIteration: () => {},
      projectHttpFailure: async () => ({ type: "error" as const, message: "unused" }),
      wrap: (value: unknown) => value,
      rememberSuccess: () => {},
    } as unknown as NonNullable<WebSearchLoopDeps["thinkingRecovery"]>;
    const out = await run({
      name: "recover-then-header-hang", buildRequest: request,
      fetchResponse: (_r, ctx) => ++sends === 1 ? Promise.resolve(new Response("first", { status: 200 })) : hanging(ctx),
      async *parseStream(response) { await response.text(); yield { type: "error", message: "invalid signature in thinking block", status: 400 }; },
      parseResponse: noParseResponse,
    }, { connectTimeoutMs: HEADER_MS, thinkingRecovery });
    expect(sends).toBe(2);
    expect(out.wireStatus).toBe(200);
    expect(failedError(out.wire)).toMatchObject({ message: headerSentence(HEADER_MS) });
    expect(out.row).toMatchObject({ status: 504, failureDetail: { code: "header_timeout", value: HEADER_MS } });
    expect(out.row.upstreamCondition).toBeUndefined();
  }, 2_000);

  test("Antigravity 403 rotation whose replacement hits the header deadline is logged as the local deadline", async () => {
    const out = await run({
      name: "agy-403", buildRequest: request,
      fetchResponse: async () => new Response(JSON.stringify({ error: { message: "denied", status: "PERMISSION_DENIED" } }), { status: 403, headers: { "content-type": "application/json" } }),
      parseStream: done, parseResponse: noParseResponse,
    }, {
      connectTimeoutMs: HEADER_MS,
      on429: async () => ({ adapter: { name: "agy-sibling-hang", buildRequest: request, fetchResponse: (_r, ctx) => hanging(ctx), parseStream: done, parseResponse: noParseResponse }, recoveryKind: "oauth-account-403" as const }),
    }, "google-antigravity");
    expect(out.wireStatus).toBe(504);
    expect(JSON.parse(out.wire)).toEqual({ error: { message: headerSentence(HEADER_MS), type: "upstream_error", code: null } });
    expect(out.row).toMatchObject({ status: 504, errorCode: "upstream_server_error", failureDetail: { code: "header_timeout", value: HEADER_MS } });
    expect(out.row.upstreamCondition).toBeUndefined();
  }, 2_000);

  test("guard: Antigravity 403 whose replacement fails without a deadline keeps the terminal 403 attribution", async () => {
    let rotations = 0;
    const out = await run({
      name: "agy-403", buildRequest: request,
      fetchResponse: async () => new Response(JSON.stringify({ error: { message: "denied", status: "PERMISSION_DENIED" } }), { status: 403, headers: { "content-type": "application/json" } }),
      parseStream: done, parseResponse: noParseResponse,
    }, {
      connectTimeoutMs: 1_000,
      on429: async () => ++rotations > 1 ? null : ({ adapter: { name: "agy-sibling-broken", buildRequest: request, fetchResponse: async () => { throw new Error("sibling transport failed"); }, parseStream: done, parseResponse: noParseResponse }, recoveryKind: "oauth-account-403" as const }),
    }, "google-antigravity");
    expect(out.wireStatus).toBe(403);
    expect(out.row).toMatchObject({ status: 403, errorCode: "permission_denied", upstreamCondition: "access_denied", failureCause: "credential-rejected" });
    expect(out.row.failureDetail).toBeUndefined();
  }, 2_000);

  test("guard: a real upstream 504 keeps upstream provenance and no local detail", async () => {
    const out = await run({
      name: "upstream-504", buildRequest: request,
      fetchResponse: async () => new Response(JSON.stringify({ error: { message: "gateway timeout", type: "server_error" } }), { status: 504, headers: { "content-type": "application/json" } }),
      parseStream: done, parseResponse: noParseResponse,
    }, { connectTimeoutMs: 1_000 });
    expect(out.wireStatus).toBe(504);
    expect(JSON.parse(out.wire)).toEqual({ error: { message: "Provider error 504", type: "upstream_error", code: null } });
    expect(out.row).toMatchObject({ status: 504, errorCode: "upstream_server_error", upstreamCondition: "upstream_failed", failureCause: "upstream-fault" });
    expect(out.row.failureDetail).toBeUndefined();
  }, 2_000);

  test("guard: a real upstream 504 on a later iteration keeps upstream provenance", async () => {
    sidecarSearchSucceeds();
    let pass = 0;
    const out = await run({
      name: "search-then-upstream-504", buildRequest: request,
      fetchResponse: async () => ++pass === 1
        ? new Response("first", { status: 200 })
        : new Response(JSON.stringify({ error: { message: "gateway timeout", type: "server_error" } }), { status: 504, headers: { "content-type": "application/json" } }),
      async *parseStream(response) { await response.text(); yield* searchCall; yield { type: "done" }; },
      parseResponse: noParseResponse,
    }, { connectTimeoutMs: 1_000 });
    expect(pass).toBe(2);
    expect(failedError(out.wire)).toMatchObject({ message: "Provider error 504" });
    expect(out.row).toMatchObject({ terminalStatus: "failed", upstreamCondition: "upstream_failed" });
    expect(out.row.failureDetail).toBeUndefined();
  }, 2_000);

  test("guard: a terminal upstream 403 keeps credential attribution", async () => {
    const out = await run({
      name: "upstream-403", buildRequest: request,
      fetchResponse: async () => new Response(JSON.stringify({ error: { message: "forbidden", type: "permission_error" } }), { status: 403, headers: { "content-type": "application/json" } }),
      parseStream: done, parseResponse: noParseResponse,
    });
    expect(out.wireStatus).toBe(403);
    expect(out.row).toMatchObject({ status: 403, errorCode: "permission_denied", upstreamCondition: "access_denied", failureCause: "credential-rejected" });
    expect(out.row.failureDetail).toBeUndefined();
  }, 2_000);
});


// ---------------------------------------------------------------------------------------------
// Amendment 1: a reused log context must not carry one attempt's local verdict into the next.
// Fixture shapes follow the independent review probe (reviews/diagnostics/probes/t04b-review.test.ts).
// ---------------------------------------------------------------------------------------------

const json = (status: number, payload: unknown) => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
const LEGS = {
  local: { name: "leg-header-hang", buildRequest: request, fetchResponse: (_r: unknown, ctx?: AdapterFetchContext) => hanging(ctx), parseStream: done, parseResponse: noParseResponse } as ProviderAdapter,
  upstream403: { name: "leg-upstream-403", buildRequest: request, fetchResponse: async () => json(403, { error: { message: "forbidden", type: "permission_error" } }), parseStream: done, parseResponse: noParseResponse } as ProviderAdapter,
  upstream504: { name: "leg-upstream-504", buildRequest: request, fetchResponse: async () => json(504, { error: { message: "gateway timeout", type: "server_error" } }), parseStream: done, parseResponse: noParseResponse } as ProviderAdapter,
};
type Leg = keyof typeof LEGS | "skip";

function loopOn(logCtx: RequestLogContext, leg: keyof typeof LEGS): Promise<Response> {
  return runWithWebSearch({
    parsed: parseRequest({ model: "routed/model", input: "Search current docs", stream: true, tools: [{ type: "web_search" }] }),
    adapter: LEGS[leg],
    forwardProvider,
    hostedTool: { type: "web_search" },
    selectedForwardHeaders: new Headers({ authorization: "Bearer forwarded" }),
    settings: { model: "gpt-5.6-luna", reasoning: "low", timeoutMs: 1_000 },
    maxSearches: 1,
    incomingMeta: { headers: new Headers(), translatorBudget: createTestTranslatorBudget() },
    proxyErrorContext: logCtx,
    connectTimeoutMs: leg === "local" ? HEADER_MS : 1_000,
  });
}

function policyConfig(): OcxConfig {
  return {
    port: 0, defaultProvider: "provider-a",
    providers: Object.fromEntries(["a", "b", "c"].map(id => ["provider-" + id, {
      adapter: "openai-chat", baseUrl: "https://" + id + ".example/v1", authMode: "key", apiKey: "fixture-key", models: ["model-" + id],
    }])),
  } as OcxConfig;
}
function policyTrace(candidates: number): RouteDecisionTraceV1 {
  return {
    version: 1, decisionId: "decision-1", createdAt: 1, requestedModel: "policy/daily", routeKind: "policy",
    profile: { id: "daily", revision: "rev-1" }, requirements: [],
    candidates: ["a", "b", "c"].slice(0, candidates).map((id, index) => ({
      provider: "provider-" + id, model: "model-" + id, eligible: true, exclusions: [], score: { total: 0.9 - index / 10, components: {} },
    })),
    selected: { candidateIndex: 0, provider: "provider-a", model: "model-a", reason: "highest-score" },
  } as RouteDecisionTraceV1;
}

async function policyRun(label: string, legs: Leg[]): Promise<Outcome & { calls: number }> {
  const logCtx = { model: "policy/daily", provider: "policy", requestedModel: "policy/daily" } as RequestLogContext;
  let calls = 0;
  const response = await handleResponsesWithPolicyFallback(
    new Request("http://localhost/v1/responses", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "policy/daily", input: "hello", stream: false }) }),
    policyConfig(), logCtx, {}, {
      runCore: async (req, _config, context, options) => {
        options?.onRequestBodyParsed?.(await req.json());
        context.routeDecision = policyTrace(legs.length);
        const leg = legs[calls++]!;
        if (leg === "skip") return policyCandidateRefusalResponse(new PolicyCandidateUnavailableError())!;
        return loopOn(context as RequestLogContext, leg);
      },
    });
  const entries: RequestLogEntry[] = [];
  const wire = await responseWithDeferredRequestLog(response, "ocx-t04b-policy", Date.now(), logCtx, entry => entries.push(entry)).text();
  expect(entries).toHaveLength(1);
  console.log("WIRE policy:" + label + " " + JSON.stringify({ status: response.status, calls, wire }));
  return { wireStatus: response.status, wire, row: entries[0] as Outcome["row"], calls };
}

describe("T04-b amendment 1: attempt boundaries on a reused log context", () => {
  test("policy: local deadline then a real upstream 403 logs the 403's upstream attribution", async () => {
    const out = await policyRun("local-403", ["local", "upstream403"]);
    expect(out.calls).toBe(2);
    expect(out.wireStatus).toBe(403);
    expect(JSON.parse(out.wire)).toEqual({ error: { message: "Provider error 403", type: "upstream_error", code: null } });
    expect(out.row).toMatchObject({ status: 403, errorCode: "permission_denied", upstreamCondition: "access_denied", failureCause: "credential-rejected" });
    expect(out.row.failureDetail).toBeUndefined();
  }, 3_000);

  test("policy: local deadline then a real upstream 504 logs the 504's upstream attribution", async () => {
    const out = await policyRun("local-504", ["local", "upstream504"]);
    expect(out.calls).toBe(2);
    expect(out.wireStatus).toBe(504);
    expect(JSON.parse(out.wire)).toEqual({ error: { message: "Provider error 504", type: "upstream_error", code: null } });
    expect(out.row).toMatchObject({ status: 504, errorCode: "upstream_server_error", upstreamCondition: "upstream_failed" });
    expect(out.row.failureDetail).toBeUndefined();
  }, 3_000);

  test("policy: a real upstream 403 then a local deadline logs the final local deadline", async () => {
    const out = await policyRun("403-local", ["upstream403", "local"]);
    expect(out.calls).toBe(2);
    expect(out.wireStatus).toBe(504);
    expect(JSON.parse(out.wire)).toEqual({ error: { message: headerSentence(HEADER_MS), type: "upstream_error", code: null } });
    expect(out.row).toMatchObject({ status: 504, errorCode: "upstream_server_error", failureDetail: { code: "header_timeout", value: HEADER_MS } });
    expect(out.row.upstreamCondition).toBeUndefined();
  }, 3_000);

  test("policy: a locally skipped candidate restores the retained local deadline exactly", async () => {
    const out = await policyRun("local-skip", ["local", "skip"]);
    expect(out.calls).toBe(2);
    expect(out.wireStatus).toBe(504);
    expect(JSON.parse(out.wire)).toEqual({ error: { message: headerSentence(HEADER_MS), type: "upstream_error", code: null } });
    expect(out.row).toMatchObject({ status: 504, failureDetail: { code: "header_timeout", value: HEADER_MS } });
    expect(out.row.upstreamCondition).toBeUndefined();
  }, 3_000);

  test("policy: local deadline, a skipped candidate, then a real 403 logs the 403", async () => {
    const out = await policyRun("local-skip-403", ["local", "skip", "upstream403"]);
    expect(out.calls).toBe(3);
    expect(out.wireStatus).toBe(403);
    expect(out.row).toMatchObject({ status: 403, errorCode: "permission_denied", upstreamCondition: "access_denied" });
    expect(out.row.failureDetail).toBeUndefined();
  }, 3_000);

  test("opaque-blob reset drops a previous attempt's local verdict", () => {
    const logCtx = { model: "m", provider: "p" } as RequestLogContext;
    recordLocalFailureDetail(logCtx, headerSentence(HEADER_MS), { code: "header_timeout", value: HEADER_MS });
    resetStreamedOpaqueBlobLogContext(logCtx);
    expect(upstreamErrorIsLocal(logCtx)).toBe(false);
    expect(logCtx.failureDetail).toBeUndefined();
    expect(logCtx.upstreamError).toBeUndefined();
  });
});
