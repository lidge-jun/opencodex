import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequestExecutionBudget } from "../../src/lib/request-execution-budget";
import {
  admitWorkflowTurn,
  chargeWorkflowSends,
  DEFAULT_WORKFLOW_BUDGET_POLICY,
  resetWorkflowBudgetsForTest,
  workflowBudgetSnapshot,
} from "../../src/lib/workflow-budget";
import { handleResponses } from "../../src/server/responses/core";
import type { RequestLogContext } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";
import { saveConfig } from "../../src/config";
import { clearKeyCooldowns } from "../../src/providers/key-failover";
import { bindWorkflowBudgetConfig } from "../../src/lib/workflow-budget-config";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import * as proxyEnv from "../../src/lib/proxy-env";
import { createResponsesSendBudget } from "../../src/server/responses/request-send-budget";
import { createTranslatorBudget } from "../../src/lib/translator-budget";

const originalFetch = globalThis.fetch;
const originalHome = process.env.OPENCODEX_HOME;
const CREDITS = { type: "error", error: { type: "rate_limit_error", message: "Usage credits are required for fast mode." } };
const GENERIC = { type: "error", error: { type: "rate_limit_error", message: "Number of request tokens has exceeded your per-minute rate limit" } };
let testDir = "";
let releaseSpendHome: (() => void) | undefined;
const inactiveFetch = (() => { throw new Error("No active in-memory fast-downgrade fixture"); }) as typeof fetch;
let fixtureFetch = inactiveFetch;
let configuredFetch: ReturnType<typeof spyOn> | undefined;

function config(fastMode = true): OcxConfig {
  return {
    defaultProvider: "anthropic-apikey",
    fastMode,
    providers: {
      "anthropic-apikey": {
        adapter: "anthropic",
        baseUrl: "https://api.anthropic.com",
        authMode: "key",
        apiKey: "test-token",
        models: ["claude-opus-5-5"],
        // Anthropic Fast is opt-in; this suite exercises the enabled lane.
        fastEnabled: true,
        fetch: (input: RequestInfo | URL, init?: RequestInit) => fixtureFetch(input, init),
      },
    },
  } as OcxConfig;
}

function request(parentThreadId?: string): Request {
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(parentThreadId ? { "x-codex-parent-thread-id": parentThreadId } : {}),
    },
    body: JSON.stringify({ model: "anthropic-apikey/claude-opus-5-5", stream: false, store: false, input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
    ] }),
  });
}

function refusal(error: typeof CREDITS | typeof GENERIC): Response {
  return Response.json(error, { status: 429 });
}

function success(): Response {
  return Response.json({
    id: "msg-ok", type: "message", role: "assistant", model: "claude-opus-5-5",
    content: [{ type: "text", text: "ok" }], stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 },
  });
}

interface Send {
  body: Record<string, unknown>;
  headers: Headers;
}

function fakeUpstream(answer: (index: number) => Response): Send[] {
  const sends: Send[] = [];
  fixtureFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    sends.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown>, headers: new Headers(init?.headers) });
    return answer(sends.length);
  }) as typeof fetch;
  globalThis.fetch = fixtureFetch;
  return sends;
}

beforeEach(() => {
  resetWorkflowBudgetsForTest();
  clearKeyCooldowns();
  testDir = mkdtempSync(join(tmpdir(), "ocx-anthropic-fast-downgrade-"));
  process.env.OPENCODEX_HOME = testDir;
  releaseSpendHome = acquireOwnedSpendHome();
  fixtureFetch = inactiveFetch;
  // SOCKS dispatch may bypass global fetch, so pin the transport boundary as well.
  configuredFetch = spyOn(proxyEnv, "configuredOutboundFetch").mockImplementation((input, init) => fixtureFetch(input, init));
});

function cleanupTestState(): void {
  try {
    releaseSpendHome?.();
  } finally {
    releaseSpendHome = undefined;
    fixtureFetch = inactiveFetch;
    configuredFetch?.mockRestore(); configuredFetch = undefined;
    globalThis.fetch = originalFetch;
    if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = originalHome;
    rmSync(testDir, { recursive: true, force: true });
    resetWorkflowBudgetsForTest();
    bindWorkflowBudgetConfig(null);
    clearKeyCooldowns();
  }
}

afterEach(cleanupTestState);

describe("Anthropic fast refusal in Responses dispatch", () => {
  test("resends once at standard speed without rotating or cooling the account", async () => {
    const sends = fakeUpstream(index => index === 1 ? refusal(CREDITS) : success());
    const logCtx: RequestLogContext = { model: "", provider: "" };
    const response = await handleResponses(request(), config(), logCtx);
    await response.text();

    expect(response.status).toBe(200);
    expect(sends).toHaveLength(2);
    expect(sends[0]?.body.speed).toBe("fast");
    expect(sends[0]?.headers.get("anthropic-beta")).toContain("fast-mode-2026-02-01");
    expect(sends[1]?.body.speed).toBeUndefined();
    expect(sends[1]?.headers.get("anthropic-beta") ?? "").not.toContain("fast-mode-2026-02-01");
    expect(logCtx.activeAttempt?.recoveryKinds).toEqual(["anthropic-fast-downgrade"]);
    expect(logCtx.activeAttempt?.tierOutcome).toMatchObject({
      wireValue: null, fastOutcome: "downgraded", fastDowngradeReason: "response-declined",
    });
    expect(logCtx.activeAttempt?.sendCount).toBe(2);
    expect(logCtx.attempts).toHaveLength(1);
  });

  test("generic 429 does not trigger fast downgrade", async () => {
    const sends = fakeUpstream(() => refusal(GENERIC));
    const logCtx: RequestLogContext = { model: "", provider: "" };
    const response = await handleResponses(request(), config(), logCtx);
    await response.text();

    expect(response.status).toBe(429);
    expect(sends).toHaveLength(1);
    expect(sends[0]?.body.speed).toBe("fast");
    expect(logCtx.activeAttempt?.recoveryKinds ?? []).not.toContain("anthropic-fast-downgrade");
  });

  test("standard request with fast refusal wording is not resent", async () => {
    const sends = fakeUpstream(() => refusal(CREDITS));
    const logCtx: RequestLogContext = { model: "", provider: "" };
    const response = await handleResponses(request(), config(false), logCtx);
    await response.text();

    expect(response.status).toBe(429);
    expect(sends).toHaveLength(1);
    expect(sends[0]?.body.speed).toBeUndefined();
    expect(logCtx.activeAttempt?.recoveryKinds ?? []).not.toContain("anthropic-fast-downgrade");
  });

  test("a second fast refusal is returned after one standard resend", async () => {
    const sends = fakeUpstream(() => refusal(CREDITS));
    const logCtx: RequestLogContext = { model: "", provider: "" };
    const response = await handleResponses(request(), config(), logCtx);
    const body = await response.text();

    expect(response.status).toBe(429);
    expect(body).toContain("Usage credits are required for fast mode.");
    expect(sends).toHaveLength(2);
    expect(sends.map(send => send.body.speed)).toEqual(["fast", undefined]);
    expect(logCtx.activeAttempt?.recoveryKinds).toEqual(["anthropic-fast-downgrade"]);
  });

  test("the standard resend is admitted through the request budget; a refused reservation keeps the original refusal", async () => {
    // The root's initial send consumes its one request slot; a refused repair reservation
    // preserves the provider's refusal without admitting another physical send.
    const sends = fakeUpstream(() => refusal(CREDITS));
    const logCtx: RequestLogContext = { model: "", provider: "" };
    const rootId = "anthropic-fast-refused-repair-root";
    const admitted = admitWorkflowTurn(rootId, "interactive");
    expect(admitted?.admitted).toBe(true);
    if (admitted?.admitted) admitted.lease.release();
    const budget = createRequestExecutionBudget({
      maxTotalModelSends: 1, baseSendAllowance: 1, finalRecoveryAllowance: 0,
      maxAlternateTargetSends: 0, maxTargetTransitions: 0,
    }, "anthropic-fast-one-send");
    const response = await handleResponses(request(rootId), config(), logCtx, { sendBudget: budget });
    const body = await response.text();

    expect(response.status).toBe(429);
    expect(body).toContain("Usage credits are required for fast mode.");
    expect(sends).toHaveLength(1);
    expect(workflowBudgetSnapshot(rootId)?.sends).toBe(1);
    expect(logCtx.activeAttempt?.recoveryKinds ?? []).not.toContain("anthropic-fast-downgrade");
  });

  test("cleanup restores global state even when spend-home release throws", () => {
    globalThis.fetch = (() => { throw new Error("stale fake upstream"); }) as typeof fetch;
    const release = releaseSpendHome;
    releaseSpendHome = () => { release?.(); throw new Error("spend-home release failed"); };
    const directory = testDir;

    expect(cleanupTestState).toThrow("spend-home release failed");
    expect(releaseSpendHome).toBeUndefined();
    expect(globalThis.fetch).toBe(originalFetch);
    expect(process.env.OPENCODEX_HOME).toBe(originalHome);
    expect(existsSync(directory)).toBe(false);
  });

  test("the admitted standard resend is charged to the request ledger", async () => {
    fakeUpstream(index => index === 1 ? refusal(CREDITS) : success());
    const logCtx: RequestLogContext = { model: "", provider: "" };
    const budget = createRequestExecutionBudget(undefined, "anthropic-fast-charged");
    const response = await handleResponses(request(), config(), logCtx, { sendBudget: budget });
    expect(response.status).toBe(200);
    expect(budget.used).toBe(1);
  });

  test("a child fast downgrade charges the workflow and exhausts later children", async () => {
    const rootId = "anthropic-fast-workflow-root";
    const admitted = admitWorkflowTurn(rootId, "interactive");
    expect(admitted?.admitted).toBe(true);
    if (admitted?.admitted) admitted.lease.release();
    chargeWorkflowSends(rootId, DEFAULT_WORKFLOW_BUDGET_POLICY.maxPhysicalSends - 2);
    const sends = fakeUpstream(index => index === 1 ? refusal(CREDITS) : success());
    const budget = createRequestExecutionBudget(undefined, "anthropic-fast-workflow-child");
    const response = await handleResponses(request(rootId), config(), { model: "", provider: "" }, { sendBudget: budget });
    await response.text();

    expect(response.status).toBe(200);
    expect(sends).toHaveLength(2);
    expect(budget.used).toBe(2);
    expect(workflowBudgetSnapshot(rootId)?.sends).toBe(DEFAULT_WORKFLOW_BUDGET_POLICY.maxPhysicalSends);

    const next = await handleResponses(request(rootId), config(), { model: "", provider: "" });
    expect(next.status).toBe(429);
    expect(await next.text()).toContain("the task reached its send ceiling");
    expect(sends).toHaveLength(2);
  });
});

test("a physical workflow denial stops a reserved fast downgrade before fetch", async () => {
  const sends = fakeUpstream(index => index === 1 ? refusal(CREDITS) : success());
  const budget = createRequestExecutionBudget(undefined, "fast-denied-at-dispatch", {
    beforePhysicalSend: () => false, charge: () => true, refund: () => {},
  });
  const response = await handleResponses(request(), config(), { model: "", provider: "" }, { sendBudget: budget });
  expect(response.status).toBe(429);
  expect(await response.text()).toContain("request_send_budget_exhausted");
  expect(sends).toHaveLength(1);
  expect(budget.used).toBe(0);
});

test("the last prepaid fast downgrade slot is confirmed once", async () => {
  const rootId = "fast-last-prepaid-root";
  const admitted = admitWorkflowTurn(rootId, "interactive");
  if (admitted?.admitted) admitted.lease.release();
  const sends = fakeUpstream(index => index === 1 ? refusal(CREDITS) : success());
  const budget = createRequestExecutionBudget({ maxTotalModelSends: 2, baseSendAllowance: 2,
    finalRecoveryAllowance: 0, maxAlternateTargetSends: 1, maxTargetTransitions: 1 });
  const response = await handleResponses(request(rootId), config(), { model: "", provider: "" }, { sendBudget: budget });
  expect(response.status).toBe(200);
  await response.text();
  expect(sends).toHaveLength(2);
  expect(budget.used).toBe(2);
  expect(workflowBudgetSnapshot(rootId)?.sends).toBe(2);
});

test("a fast downgrade confirms its hop once while an authorized reset replacement keeps its own allowance", async () => {
  const configured = config();
  configured.providers["anthropic-apikey"]!.retryOnReset = { replacements: 1 };
  const sends = fakeUpstream(index => {
    if (index === 2) throw Object.assign(new Error("synthetic reset"), { code: "ECONNRESET" });
    return index === 1 ? refusal(CREDITS) : success();
  });
  const budget = createRequestExecutionBudget({ maxTotalModelSends: 3, baseSendAllowance: 3,
    finalRecoveryAllowance: 0, maxAlternateTargetSends: 1, maxTargetTransitions: 1 });
  const response = await handleResponses(request(), configured, { model: "", provider: "" }, { sendBudget: budget });
  expect(response.status).toBe(200);
  await response.text();
  expect(sends).toHaveLength(3);
  expect(sends.map(send => send.body.speed)).toEqual(["fast", undefined, undefined]);
  expect(budget.used).toBe(3);
});

test("a root-only fast downgrade counts each physical send once and preserves the next allowance", async () => {
  const rootId = "fast-observed-root";
  const policy = { ...DEFAULT_WORKFLOW_BUDGET_POLICY, maxPhysicalSends: 3 };
  bindWorkflowBudgetConfig({ workflowBudget: { maxPhysicalSends: 3 } });
  const admitted = admitWorkflowTurn(rootId, "interactive", policy);
  if (admitted?.admitted) admitted.lease.release();
  const sends = fakeUpstream(index => index === 1 ? refusal(CREDITS) : success());
  const first = await handleResponses(request(rootId), config(), { model: "", provider: "" });
  expect(first.status).toBe(200);
  await first.text();
  expect(sends).toHaveLength(2);
  expect(workflowBudgetSnapshot(rootId, policy)?.sends).toBe(2);
  const next = await handleResponses(request(rootId), config(), { model: "", provider: "" });
  expect(next.status).toBe(200);
  await next.text();
  expect(workflowBudgetSnapshot(rootId, policy)?.sends).toBe(3);
  const exhausted = await handleResponses(request(rootId), config(), { model: "", provider: "" });
  expect(exhausted.status).toBe(429);
  await exhausted.text();
  expect(sends).toHaveLength(3);
});

for (const limit of [1, 2]) test(`a legacy request budget obeys the root ceiling before a fast replay (${limit})`, async () => {
  const rootId = "fast-legacy-root";
  const policy = { ...DEFAULT_WORKFLOW_BUDGET_POLICY, maxPhysicalSends: limit };
  bindWorkflowBudgetConfig({ workflowBudget: { maxPhysicalSends: limit } });
  const admitted = admitWorkflowTurn(rootId, "interactive", policy);
  if (admitted?.admitted) admitted.lease.release();
  const sends = fakeUpstream(index => index === 1 ? refusal(CREDITS) : success());
  const budget = createRequestExecutionBudget();
  const logCtx: RequestLogContext = { model: "", provider: "" };
  const response = await handleResponses(request(rootId), config(), logCtx, { sendBudget: budget });
  expect(response.status).toBe(limit === 1 ? 429 : 200);
  const body = await response.json();
  if (limit === 1) {
    expect(response.headers.get("x-opencodex-local-refusal")).toBe("workflow_sends_exhausted");
    expect(body.error.code).toBe("rate_limit_exceeded");
    expect(logCtx.errorCode).toBe("workflow_sends_exhausted");
  } else expect(response.headers.get("x-opencodex-local-refusal")).toBeNull();
  expect(sends).toHaveLength(limit);
  expect(workflowBudgetSnapshot(rootId, policy)?.sends).toBe(limit);
  expect(budget.used).toBe(limit);
});

test("a root exhausted during initial admission has the workflow refusal header and code", async () => {
  const rootId = "fast-initial-root-race";
  const policy = { ...DEFAULT_WORKFLOW_BUDGET_POLICY, maxPhysicalSends: 1 };
  bindWorkflowBudgetConfig({ workflowBudget: { maxPhysicalSends: 1 } });
  const admitted = admitWorkflowTurn(rootId, "interactive", policy);
  if (admitted?.admitted) admitted.lease.release();
  const sends = fakeUpstream(() => success());
  let claimedByOtherChild = false;
  const budget = createRequestExecutionBudget(undefined, undefined, {
    startRequest: () => {
      if (!claimedByOtherChild) { chargeWorkflowSends(rootId, 1); claimedByOtherChild = true; }
    }, charge: () => true, refund: () => {},
  });
  const logCtx: RequestLogContext = { model: "", provider: "" };
  const response = await handleResponses(request(rootId), config(), logCtx, { sendBudget: budget });
  expect(response.status).toBe(429);
  expect(response.headers.get("x-opencodex-local-refusal")).toBe("workflow_sends_exhausted");
  expect((await response.json()).error.code).toBe("rate_limit_exceeded");
  expect(logCtx.errorCode).toBe("workflow_sends_exhausted");
  expect(sends).toHaveLength(0);
  expect(budget.used).toBe(0);
  expect(workflowBudgetSnapshot(rootId, policy)?.sends).toBe(1);
});

test("request-local exhaustion retains its own code while the workflow still has allowance", async () => {
  const rootId = "fast-request-only-refusal";
  const admitted = admitWorkflowTurn(rootId, "interactive");
  if (admitted?.admitted) admitted.lease.release();
  const sends = fakeUpstream(() => success());
  const configured = config();
  configured.providers["anthropic-apikey"]!.retryOnReset = { replacements: 1 };
  const budget = createRequestExecutionBudget({ maxTotalModelSends: 0, baseSendAllowance: 0,
    finalRecoveryAllowance: 0, maxAlternateTargetSends: 0, maxTargetTransitions: 0 });
  const logCtx: RequestLogContext = { model: "", provider: "" };
  const response = await handleResponses(request(rootId), configured, logCtx, { sendBudget: budget });
  expect(response.status).toBe(429);
  expect(response.headers.get("x-opencodex-local-refusal")).toBeNull();
  expect((await response.json()).error.code).toBe("request_send_budget_exhausted");
  expect(logCtx.errorCode).not.toBe("workflow_sends_exhausted");
  expect(sends).toHaveLength(0);
  expect(workflowBudgetSnapshot(rootId)?.sends).toBe(0);
});

function legacyAdmissionFixture() {
  const rootId = "legacy-initial-admission-root";
  const policy = { ...DEFAULT_WORKFLOW_BUDGET_POLICY, maxPhysicalSends: 1 };
  bindWorkflowBudgetConfig({ workflowBudget: { maxPhysicalSends: 1 } });
  const admitted = admitWorkflowTurn(rootId, "interactive", policy);
  if (admitted?.admitted) admitted.lease.release();
  const budget = createRequestExecutionBudget();
  const translatorBudget = createTranslatorBudget();
  const owner = createResponsesSendBudget({ req: request(rootId), logCtx: { model: "m", provider: "fixture" },
    options: { sendBudget: budget, translatorBudget } });
  if (owner instanceof Response) { translatorBudget.dispose(); throw new Error("fixture admission refused"); }
  return { rootId, budget, owner, close: () => translatorBudget.dispose(),
    sends: () => workflowBudgetSnapshot(rootId, policy)!.sends };
}

test("legacy initial admission releases an unused permit when another child exhausts the root", () => {
  const fixture = legacyAdmissionFixture();
  try {
    const reservation = fixture.budget.reserveDispatch({ sendClass: "initial", targetKey: "fixture/m", countedExternally: true });
    if (!reservation.allowed) throw new Error("fixture permit refused");
    chargeWorkflowSends(fixture.rootId, 1);
    expect(() => fixture.owner.noteInitialDispatch(reservation.permit)).toThrow("request send budget exhausted");
    expect(fixture.budget.used).toBe(0);
    expect(fixture.sends()).toBe(1);
  } finally { fixture.close(); }
});

test("legacy initial admission cannot charge a root for a released permit", () => {
  const fixture = legacyAdmissionFixture();
  try {
    const reservation = fixture.budget.reserveDispatch({ sendClass: "initial", targetKey: "fixture/m", countedExternally: true });
    if (!reservation.allowed) throw new Error("fixture permit refused");
    reservation.permit.release();
    expect(() => fixture.owner.noteInitialDispatch(reservation.permit)).toThrow("request send budget exhausted");
    expect(fixture.budget.used).toBe(0);
    expect(fixture.sends()).toBe(0);
  } finally { fixture.close(); }
});

test("a closed legacy reporter cannot claim another workflow send", () => {
  const fixture = legacyAdmissionFixture();
  try {
    const reporter = fixture.owner.transientSendReporter();
    reporter.close!();
    expect(reporter.beforeSend!()).toBe(false);
    expect(fixture.budget.used).toBe(0);
    expect(fixture.sends()).toBe(0);
  } finally { fixture.close(); }
});

for (const second of ["success", "rate", "billing"] as const) test(`key pool fast downgrade to ${second} counts each physical send once`, async () => {
  const configured = config();
  configured.providers["anthropic-apikey"]!.apiKeyPool = [{ id: "A", key: "test-token" }, { id: "B", key: "test-token-B" }];
  saveConfig(configured);
  const sends = fakeUpstream(index => index === 1 ? refusal(CREDITS)
    : index === 2 && second === "rate" ? refusal(GENERIC)
    : index === 2 && second === "billing" ? Response.json({ type: "error", error: { type: "invalid_request_error",
      message: "Your credit balance is too low to access the Anthropic API." } }, { status: 400 }) : success());
  const budget = createRequestExecutionBudget({ maxTotalModelSends: 3, baseSendAllowance: 3, finalRecoveryAllowance: 0,
    maxAlternateTargetSends: 1, maxTargetTransitions: 2 });
  const response = await handleResponses(request(), configured, { model: "", provider: "" }, { sendBudget: budget });
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("ok");
  expect(budget.used).toBe(sends.length);
  expect(sends.map(send => send.headers.get("x-api-key"))).toEqual(second === "success"
    ? ["test-token", "test-token"] : ["test-token", "test-token", "test-token-B"]);
  expect(sends[0]!.body.speed).toBe("fast");
  for (const send of sends.slice(1)) expect(send.body.speed).toBeUndefined();
});
