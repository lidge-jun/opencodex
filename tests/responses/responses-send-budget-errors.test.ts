import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpendLedgerFileRefusedError } from "../../src/lib/spend-reservation-ledger";
import { formatErrorResponse } from "../../src/bridge";
import * as resolver from "../../src/server/adapter-resolve";
import type { ProviderAdapter } from "../../src/adapters/base";
import { handleResponsesCompact } from "../../src/server/responses/compact";
import { handleResponses } from "../../src/server/responses/core";
import { mapSpendLedgerStorageError } from "../../src/server/responses/spend-storage-error";
import { clearUpstreamHostHealth, getUpstreamHostHealth, upstreamHostHealthKey } from "../../src/codex/upstream-host-health";
import { resetWorkflowBudgetsForTest } from "../../src/lib/workflow-budget";
import { resetProviderRequestPacingForTest } from "../../src/providers/request-pacing";
import { clearResponseStateForTests, flushResponseState } from "../../src/responses/state";
import { addFinalRequestLog, type RequestLogContext, type RequestLogEntry } from "../../src/server/request-log";
import { createRequestExecutionBudget } from "../../src/lib/request-execution-budget";
import * as authContext from "../../src/codex/auth-context";
import * as hostHealth from "../../src/codex/upstream-host-health";
import { closeRequestHistoryIndex } from "../../src/routing/history/indexer";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { installIsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { repoPath } from "../helpers/repo-root";
import { classifyError, httpStatusFromTerminalError, SEND_BUDGET_EXHAUSTED_CODE } from "../../src/lib/errors";
import { adapterFailureFromEvent } from "../../src/bridge/internal";
import { SendBudgetExhaustedError, UpstreamRetryEvidenceError } from "../../src/lib/upstream-retry";

/**
 * A refusal this proxy made must not be reported as a provider failure (#4708).
 *
 * The three dispatch paths disagreed. Passthrough answered 429 and explicitly declined to blame
 * the provider; the adapter paths fell through to `describeUpstreamConnectFailure` and answered
 * 502 "Provider unreachable"; runTurn pushed an unstructured message that was inferred back to
 * 502 under HTTP 200.
 *
 * The 502 is the damaging one, and not only because it is wrong. The Codex client retries 5xx
 * and does not retry a 429, so telling it the provider broke makes it send the whole turn again
 * -- the amplification this budget exists to stop. That is why the fix is the status, and the
 * distinct code is the part that lets an operator tell the two 429s apart afterwards.
 */
const source = (relative: string): string => readFileSync(repoPath(relative), "utf8");

describe("a spent send budget is reported as this proxy's refusal", () => {
  test("the distinct code survives serialization instead of collapsing into the generic one", () => {
    const refusal = classifyError(429, SEND_BUDGET_EXHAUSTED_CODE, "request send budget exhausted before dispatch");
    expect(refusal.type).toBe("rate_limit_error");
    expect(refusal.code).toBe(SEND_BUDGET_EXHAUSTED_CODE);

    // A provider rate limit is still the generic identity: the branch above is keyed on the
    // supplied type, not on the status, so it cannot capture an upstream 429.
    const upstream = classifyError(429, "upstream_error", "Too Many Requests");
    expect(upstream.type).toBe("rate_limit_error");
    expect(upstream.code).toBe("rate_limit_exceeded");
  });

  test("the error class and the classifier name the same identity", () => {
    expect(new SendBudgetExhaustedError("host").code).toBe(SEND_BUDGET_EXHAUSTED_CODE);
  });

  test("a committed stream carries the refusal as a structured terminal", () => {
    const failure = adapterFailureFromEvent({
      type: "error",
      status: 429,
      errorType: "rate_limit_error",
      code: SEND_BUDGET_EXHAUSTED_CODE,
      message: "request send budget exhausted before dispatch",
    });
    expect(failure.httpStatus).toBe(429);
    expect(failure.error.type).toBe("rate_limit_error");
    expect(failure.error.code).toBe(SEND_BUDGET_EXHAUSTED_CODE);

    // Without the structure, the same message is inferred from text alone and lands on the 502
    // the client would retry. This is the control that makes the assertion above mean something.
    const unstructured = adapterFailureFromEvent({
      type: "error",
      message: "request send budget exhausted before dispatch",
    });
    // Asserted as the property rather than the exact status: what matters is that the identity
    // is gone, so the client cannot tell this from an upstream fault and does not get the 429
    // that would stop it retrying.
    expect(unstructured.httpStatus).not.toBe(429);
    expect(unstructured.error.code).not.toBe(SEND_BUDGET_EXHAUSTED_CODE);
  });

  test("both adapter catch sites answer before the upstream-failure description", () => {
    const dispatch = source("src/server/responses/adapter-dispatch.ts");
    const guards = dispatch.match(/if \(err instanceof SendBudgetExhaustedError\) \{/g) ?? [];
    expect(guards).toHaveLength(2);
    // Order is the assertion: describeUpstreamConnectFailure is what launders the refusal into
    // "Provider unreachable", so the typed branch has to precede every one of its call sites.
    let cursor = 0;
    for (let index = 0; index < 2; index += 1) {
      const guard = dispatch.indexOf("if (err instanceof SendBudgetExhaustedError) {", cursor);
      const describe = dispatch.indexOf("describeUpstreamConnectFailure(err, connectMs)", cursor);
      expect(guard).toBeGreaterThan(-1);
      expect(describe).toBeGreaterThan(guard);
      cursor = describe + 1;
    }
  });

  test("reservation denials preserve unbound-history detail on HTTP and SSE response paths", () => {
    const adapter = source("src/server/responses/adapter-dispatch.ts");
    const passthrough = source("src/server/responses/passthrough-dispatch.ts");
    const runTurn = source("src/server/responses/run-turn-execution.ts");
    expect(adapter.match(/unboundPoolSpendRefusalResponse\(logCtx\)/g)).toHaveLength(2);
    expect(passthrough).toContain("unboundPoolSpendRefusalResponse(logCtx)");
    expect(runTurn).toContain("unboundPoolSpendRefusalMessage(logCtx) ?? err.message");
  });

  test("a local 429 never rotates a credential or writes a cooldown", () => {
    const runTurn = source("src/server/responses/run-turn-execution.ts");
    const rotate = runTurn.indexOf("const rotateRunTurnAdapterOnPreflight429");
    const guard = runTurn.indexOf("if (error.code === SEND_BUDGET_EXHAUSTED_CODE) return false;", rotate);
    const status = runTurn.indexOf("const status = error.status", rotate);
    expect(rotate).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(rotate);
    // Before the status is even read: a refusal that reached the roster cap would cool down an
    // account that rate-limited nothing, and that fake signal outlives the request.
    expect(status).toBeGreaterThan(guard);
  });

  test("the continuation 429 loop consults the shared remainder before it cancels the body", () => {
    const continuation = source("src/server/responses/adapter-continuation.ts");
    const loop = continuation.indexOf("adapterExchange.rateLimitRetries < rateLimitPolicy.attempts");
    const check = continuation.indexOf("!sendBudgetExhausted()", loop);
    const wait = continuation.indexOf("prepareSameTarget429Wait", loop);
    expect(loop).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(loop);
    expect(wait).toBeGreaterThan(check);
  });
});

const code = "spend_ledger_storage_unavailable";
const refusal = () => new SpendLedgerFileRefusedError("journal", "extra-hard-link");

async function dispatch(adapter: string, error: Error, recovery = false, runTurn = false, stream = false, combo = false, preDispatch = false) {
  const oldHome = process.env.OPENCODEX_HOME;
  const oldFetch = globalThis.fetch;
  const home = mkdtempSync(join(tmpdir(), "responses-spend-storage-"));
  process.env.OPENCODEX_HOME = home;
  const codex = installIsolatedCodexHome("responses-storage-codex-");
  const release = acquireOwnedSpendHome();
  clearUpstreamHostHealth(); resetWorkflowBudgetsForTest();
  let sends = 0;
  let refunds = 0;
  const budget = preDispatch ? createRequestExecutionBudget(undefined, undefined, {
    charge: () => true, refund: () => { refunds++; }, startRequest: () => { if (!recovery || sends > 0) throw error; },
  }) : undefined;
  const probeRelease = spyOn(authContext, "releaseCodexAuthContextProbeLease");
  const hostRelease = spyOn(hostHealth, "releaseUpstreamHostAdmission");
  const logCtx: RequestLogContext = { model: "", provider: "" };
  const originalResolve = resolver.resolveAdapter;
  const adapterSpy = runTurn ? spyOn(resolver, "resolveAdapter").mockImplementation((provider, cache) => {
    if (provider.adapter !== "cursor") return originalResolve(provider, cache);
    return { name: "cursor", buildRequest: () => ({ url: provider.baseUrl, method: "POST", headers: {}, body: "{}" }),
      async *parseStream() { yield { type: "done" }; },
      async runTurn() { sends++; throw error; },
    } satisfies ProviderAdapter;
  }) : undefined;
  try {
    globalThis.fetch = (async () => {
      sends++;
      if (recovery && sends === 1) return Response.json({ error: { message: "rate limited" } }, {
        status: 429, headers: { "retry-after": "0" },
      });
      throw error;
    }) as typeof fetch;
    const config: OcxConfig = { port: 0, defaultProvider: "fixture", upstreamHostCircuitThreshold: 1,
      providers: { fixture: { adapter: adapter === "compact" ? "openai-responses" : adapter, baseUrl: adapter === "compact" ? "https://chatgpt.com/backend-api/codex" : "https://synthetic.invalid/v1", apiKey: "synthetic",
        models: ["test"], authMode: preDispatch && !recovery && (adapter === "openai-responses" || adapter === "compact") ? "forward" : "key", liveModels: false, transientRetryOn5xx: { attempts: recovery ? 2 : 1 },
        retryOn429: { attempts: 1, intervalMs: 1, maxIntervalMs: 1 } } } };
    const request = new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json", ...(preDispatch ? { authorization: "Bearer synthetic" } : {}) },
      body: JSON.stringify({ model: "fixture/test", input: "Synthetic storage refusal task.", stream, store: false }),
    });
    const response = adapter === "compact"
      ? await handleResponsesCompact(request, config, logCtx, undefined, undefined, { ...(budget ? { sendBudget: budget } : {}) })
      : await handleResponses(request, config, logCtx, { comboAttempt: combo, ...(budget ? { sendBudget: budget } : {}) });
    const text = await response.text();
    const health = getUpstreamHostHealth(upstreamHostHealthKey("fixture", adapter === "compact" ? "https://chatgpt.com" : "https://synthetic.invalid"));
    let entry: RequestLogEntry | undefined;
    addFinalRequestLog("synthetic-storage-request", Date.now(), logCtx, response.status, undefined, row => { entry = row; });
    const probesReleased = probeRelease.mock.calls.length;
    const hostsReleased = hostRelease.mock.calls.filter(([lease]) => lease !== null && lease !== undefined).length;
    return { entry, logCtx, probesReleased, hostsReleased, used: budget?.used, refunds, status: response.status, text, payload: stream && response.status === 200 ? undefined : JSON.parse(text), health, sends };
  } finally {
    probeRelease.mockRestore(); hostRelease.mockRestore();
    adapterSpy?.mockRestore();
    globalThis.fetch = oldFetch;
    release(); closeRequestHistoryIndex(); await flushResponseState(); clearResponseStateForTests();
    resetWorkflowBudgetsForTest(); resetProviderRequestPacingForTest(); clearUpstreamHostHealth();
    if (oldHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = oldHome;
    codex.restore(); removeTreeWithRetry(home);
  }
}

function assertStorage(result: Awaited<ReturnType<typeof dispatch>>) {
  expect(result.status, result.text).toBe(503);
  expect(result.payload.error.type).toBe("server_error");
  expect(result.payload.error.code).toBe(code);
  expect(result.payload.error.message).toContain("journal: extra-hard-link");
  expect(result.payload.error.message).toContain("move it out");
  expect(result.text).not.toContain("Provider unreachable");
  expect(result.text).not.toContain("private-wrapper-path");
  expect(result.health?.consecutiveFailures ?? 0).toBe(0);
  expect(result.entry?.failureCause).toBe("local-refusal");
  expect(result.entry?.errorCode).toBe(code);
  expect(result.logCtx.localTerminalReason).toBe(code);
  expect(result.logCtx.terminalSource).toBe("synthetic");
}

describe("Responses spend-ledger storage refusals", () => {
  for (const adapter of ["openai-responses", "openai-chat"]) {
    for (const wrapped of [false, true]) test(`${adapter}: ${wrapped ? "wrapped" : "direct"} refusal is local 503`, async () => {
      const error = wrapped ? new UpstreamRetryEvidenceError([503],
        new Error("private-wrapper-path", { cause: refusal() })) : refusal();
      const result = await dispatch(adapter, error);
      assertStorage(result);
      expect(result.sends).toBe(1);
    });
    test(`${adapter}: a genuine connection error still returns 502`, async () => {
      const result = await dispatch(adapter, Object.assign(new Error("synthetic connection refused"), { code: "ECONNREFUSED" }));
      expect(result.status, result.text).toBe(502);
      expect(result.payload.error.code).not.toBe(code);
      expect(result.text).toContain("Provider unreachable");
      if (adapter === "openai-responses") expect(result.health?.consecutiveFailures).toBe(1);
    });
  }

  for (const adapter of ["openai-responses", "openai-chat", "compact"]) for (const wrapped of [false, true]) {
    test(`${adapter}: initial ${wrapped ? "wrapped" : "direct"} admission refusal releases leases and dispatches nothing`, async () => {
      const error = wrapped ? new UpstreamRetryEvidenceError([503], refusal()) : refusal();
      const result = await dispatch(adapter, error, false, false, false, false, true);
      assertStorage(result);
      expect(result.sends).toBe(0);
      expect(result.used).toBe(0);
      expect(result.refunds).toBe(0);
      expect(result.probesReleased).toBeGreaterThan(0);
      if (adapter !== "openai-chat") expect(result.hostsReleased).toBeGreaterThan(0);
    });
  }

  for (const adapter of ["openai-responses", "openai-chat"]) test(`${adapter}: recovery storage refusal retains the already dispatched send`, async () => {
    const result = await dispatch(adapter, new UpstreamRetryEvidenceError([503], refusal()), true, false, false, false, true);
    assertStorage(result);
    expect(result.sends).toBe(1);
    expect(result.used).toBe(1);
    expect(result.refunds).toBe(0);
  });

  test("translated recovery maps a wrapped storage refusal before transport classification", async () => {
    const result = await dispatch("openai-chat", new UpstreamRetryEvidenceError([503], refusal()), true);
    assertStorage(result);
    expect(result.sends).toBe(2);
  });

  for (const wrapped of [false, true]) test(`runTurn: ${wrapped ? "wrapped" : "direct"} buffered refusal is HTTP 503`, async () => {
    assertStorage(await dispatch("cursor", wrapped ? new UpstreamRetryEvidenceError([503], refusal()) : refusal(), false, true));
  });

  test("runTurn: a committed SSE stream carries the structured storage refusal", async () => {
    const result = await dispatch("cursor", new UpstreamRetryEvidenceError([503], refusal()), false, true, true);
    expect(result.status).toBe(200);
    expect(result.text).toContain('"code":"spend_ledger_storage_unavailable"');
    expect(result.text).toContain('"type":"server_error"');
    expect(result.text).toContain("move it out");
    expect(result.text).not.toContain("Provider unreachable");
  });

  test("runTurn: Combo preflight preserves the local 503 before committing SSE", async () => {
    assertStorage(await dispatch("cursor", new UpstreamRetryEvidenceError([503], refusal()), false, true, true, true));
  });

  test("runTurn: buffered Combo preflight preserves the local 503", async () => {
    assertStorage(await dispatch("cursor", new UpstreamRetryEvidenceError([503], refusal()), false, true, false, true));
  });

  test("structured runTurn terminal and formatter retain the storage code and status", async () => {
    const mapped = mapSpendLedgerStorageError(new UpstreamRetryEvidenceError([503], refusal()));
    expect(mapped).toBeDefined();
    const terminal = adapterFailureFromEvent({ type: "error", ...mapped! });
    expect(terminal.httpStatus).toBe(503);
    expect(terminal.error.type).toBe("server_error");
    expect(terminal.error.code).toBe(code);
    expect(httpStatusFromTerminalError(terminal.error)).toBe(503);
    const response = formatErrorResponse(502, "upstream_error", terminal.error.message, { code: terminal.error.code });
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe(code);
    expect(classifyError(503, code, refusal().message).code).toBe(code);
    expect(classifyError(503, "server_error", "Provider temporarily unavailable").code).toBe("server_is_overloaded");
  });

  test("cause traversal terminates on cycles and leaves unrelated owner errors alone", () => {
    const cycle = new Error("synthetic cycle"); cycle.cause = cycle;
    expect(mapSpendLedgerStorageError(cycle)).toBeUndefined();
    expect(mapSpendLedgerStorageError(new Error("storage text alone"))).toBeUndefined();
  });
});
