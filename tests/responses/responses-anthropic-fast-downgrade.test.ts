import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

const originalFetch = globalThis.fetch;
const originalHome = process.env.OPENCODEX_HOME;
const CREDITS = { type: "error", error: { type: "rate_limit_error", message: "Usage credits are required for fast mode." } };
const GENERIC = { type: "error", error: { type: "rate_limit_error", message: "Number of request tokens has exceeded your per-minute rate limit" } };
let testDir = "";
let releaseSpendHome: (() => void) | undefined;

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
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    sends.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown>, headers: new Headers(init?.headers) });
    return answer(sends.length);
  }) as typeof fetch;
  return sends;
}

beforeEach(() => {
  resetWorkflowBudgetsForTest();
  testDir = mkdtempSync(join(tmpdir(), "ocx-anthropic-fast-downgrade-"));
  process.env.OPENCODEX_HOME = testDir;
  releaseSpendHome = acquireOwnedSpendHome();
});

function cleanupTestState(): void {
  try {
    releaseSpendHome?.();
  } finally {
    releaseSpendHome = undefined;
    globalThis.fetch = originalFetch;
    if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = originalHome;
    rmSync(testDir, { recursive: true, force: true });
    resetWorkflowBudgetsForTest();
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
    // Anthropic's initial send runs on the reset-only leg, which does not charge the shared
    // ledger (pre-existing, every adapter without a transient policy). The resend is the part
    // this arm owns, so a zero-send budget must refuse it and hand the real refusal back.
    const sends = fakeUpstream(() => refusal(CREDITS));
    const logCtx: RequestLogContext = { model: "", provider: "" };
    const rootId = "anthropic-fast-refused-repair-root";
    const admitted = admitWorkflowTurn(rootId, "interactive");
    expect(admitted?.admitted).toBe(true);
    if (admitted?.admitted) admitted.lease.release();
    const budget = createRequestExecutionBudget({
      maxTotalModelSends: 0, baseSendAllowance: 0, finalRecoveryAllowance: 0,
      maxAlternateTargetSends: 0, maxTargetTransitions: 0,
    }, "anthropic-fast-zero-send");
    const response = await handleResponses(request(rootId), config(), logCtx, { sendBudget: budget });
    const body = await response.text();

    expect(response.status).toBe(429);
    expect(body).toContain("Usage credits are required for fast mode.");
    expect(sends).toHaveLength(1);
    expect(workflowBudgetSnapshot(rootId)?.sends).toBe(0);
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
    chargeWorkflowSends(rootId, DEFAULT_WORKFLOW_BUDGET_POLICY.maxPhysicalSends - 1);
    const sends = fakeUpstream(index => index === 1 ? refusal(CREDITS) : success());
    const budget = createRequestExecutionBudget(undefined, "anthropic-fast-workflow-child");
    const response = await handleResponses(request(rootId), config(), { model: "", provider: "" }, { sendBudget: budget });
    await response.text();

    expect(response.status).toBe(200);
    expect(sends).toHaveLength(2);
    expect(budget.used).toBe(1);
    expect(workflowBudgetSnapshot(rootId)?.sends).toBe(DEFAULT_WORKFLOW_BUDGET_POLICY.maxPhysicalSends);

    const next = await handleResponses(request(rootId), config(), { model: "", provider: "" });
    expect(next.status).toBe(429);
    expect(await next.text()).toContain("the task reached its send ceiling");
    expect(sends).toHaveLength(2);
  });
});
