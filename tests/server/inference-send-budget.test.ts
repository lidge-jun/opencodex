import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { CODEX_TEXT_GUARDED_BUDGET_POLICY } from "../../src/lib/request-execution-budget";
import { createInferenceSendBudget, expandInferenceOAuthSendBudget } from "../../src/server/inference/context";
import type { RequestLogContext } from "../../src/server/request-log";
import { createRequestExecutionBudget, deriveRequestExecutionBudget } from "../../src/lib/request-execution-budget";
import { fetchWithTransientRetry, TRANSIENT_RETRY_MAX_ATTEMPTS } from "../../src/lib/upstream-retry";
import { budgetOwner } from "../helpers/send-budget-owner";

let home: string;
let originalHome: string | undefined;
let releaseHome: () => void;
beforeEach(() => {
  originalHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-inference-budget-"));
  process.env.OPENCODEX_HOME = home;
  releaseHome = acquireOwnedSpendHome();
});
afterEach(() => {
  releaseHome();
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalHome;
  removeTreeWithRetry(home);
});

describe("createInferenceSendBudget", () => {
  test.each([0, 1])("an adapter credential hop enforces a real endpoint transition (limit=%i)", limit => {
    const budget = createRequestExecutionBudget({
      ...CODEX_TEXT_GUARDED_BUDGET_POLICY,
      maxTargetTransitions: limit,
      maxAlternateTargetSends: limit,
    });
    const { owner, dispose } = budgetOwner(budget);
    try {
      const initial = owner.adapterDispatchBudget!.reserveDispatch({ sendClass: "initial", targetKey: "https://region-a.example/" });
      if (initial.allowed) initial.permit.use();
      const hop = owner.reserveCredentialHop("auth-recovery", "provider|model|oauth-429", true);
      owner.pendingHopPermit = hop.permit;
      const replay = owner.adapterDispatchBudget!.reserveDispatch({ sendClass: "transient", targetKey: "https://region-b.example/" });
      expect(replay.allowed).toBe(limit === 1);
      if (replay.allowed) replay.permit.use();
      expect(budget.used).toBe(1 + limit);
      expect(budget.targetTransitions).toBe(limit);
      expect(budget.alternateTargetSends).toBe(limit);
      expect(budget.lastTargetKey).toBe(limit ? "https://region-b.example/" : "https://region-a.example/");
    } finally { dispose(); }
  });

  test("the last helper-driven account gets its prepaid send plus remaining retries", async () => {
    const budget = createInferenceSendBudget(new Request("http://localhost/v1/responses"), { model: "m", provider: "p" });
    expandInferenceOAuthSendBudget(budget, 4);
    const { owner, dispose } = budgetOwner(budget);
    try {
      owner.noteTransientSends(9);
      const hop = owner.reserveCredentialHop("auth-recovery", "provider|model|oauth-429", true);
      owner.pendingHopPermit = hop.permit;
      const allowance = owner.recoverySendAllowance(3, "auth-recovery", "provider|model|oauth-429");
      let sends = 0;
      const response = await fetchWithTransientRetry(async () => {
        if (sends === 0) hop.permit?.use();
        sends++;
        return new Response("", { status: sends === 3 ? 200 : 503 });
      }, { attempts: allowance.attempts, onSendsConsumed: owner.noteTransientSends });
      expect(response.status).toBe(200);
      expect(sends).toBe(3);
      expect(budget.used).toBe(12);
      expect(budget.reserveDispatch({ sendClass: "auth-recovery", targetKey: "provider|model|oauth-429" }).allowed).toBe(false);
    } finally { dispose(); }
  });

  test("same-provider auth recovery keeps the adapter's physical target", () => {
    const budget = createRequestExecutionBudget();
    const { owner, dispose } = budgetOwner(budget);
    try {
      const targetKey = "https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent";
      const initial = owner.adapterDispatchBudget!.reserveDispatch({ sendClass: "initial", targetKey });
      expect(initial.allowed).toBe(true);
      if (initial.allowed) initial.permit.use();
      const hop = owner.reserveCredentialHop("auth-recovery", "google-antigravity|model|oauth-429");
      expect(hop.allowed).toBe(true);
      owner.pendingHopPermit = hop.permit;
      const replay = owner.adapterDispatchBudget!.reserveDispatch({ sendClass: "initial", targetKey });
      expect(replay.allowed).toBe(true);
      if (replay.allowed) replay.permit.use();
      const retry = owner.adapterDispatchBudget!.reserveDispatch({ sendClass: "transient", targetKey });
      expect(retry.allowed).toBe(true);
      expect(budget.lastTargetKey).toBe(targetKey);
      expect(budget.targetTransitions).toBe(0);
      expect(budget.used).toBe(3);
    } finally { dispose(); }
  });
  test("mints a default-policy holder and parks this request's spend tracker on the log", () => {
    const logCtx: RequestLogContext = { model: "m", provider: "p" };
    const req = new Request("http://localhost/v1/responses", { method: "POST" });
    const budget = createInferenceSendBudget(req, logCtx);
    expect(budget.policy).toEqual(CODEX_TEXT_GUARDED_BUDGET_POLICY);
    expect(typeof budget.logicalRequestId).toBe("string");
    expect(budget.used).toBe(0);
    expect(logCtx.spendTracker).toBeDefined();
  });

  test("each call mints its own holder", () => {
    const req = new Request("http://localhost/v1/responses", { method: "POST" });
    const a = createInferenceSendBudget(req, { model: "m", provider: "p" });
    const b = createInferenceSendBudget(req, { model: "m", provider: "p" });
    expect(a).not.toBe(b);
    expect(a.logicalRequestId).not.toBe(b.logicalRequestId);
  });

  test("roster expansion is bounded and does not change another request or explicit scopes", () => {
    const req = new Request("http://localhost/v1/responses");
    const budget = createInferenceSendBudget(req, { model: "m", provider: "p" });
    const other = createInferenceSendBudget(req, { model: "m", provider: "p" });
    const exact = createRequestExecutionBudget();
    const child = deriveRequestExecutionBudget(budget, { ...budget.policy });
    expandInferenceOAuthSendBudget(budget, 4);
    expandInferenceOAuthSendBudget(exact, 4);
    expandInferenceOAuthSendBudget(child, 4);
    expect(budget.policy.baseSendAllowance).toBe(4 * TRANSIENT_RETRY_MAX_ATTEMPTS);
    expect(budget.policy.maxTotalModelSends).toBe(4 * TRANSIENT_RETRY_MAX_ATTEMPTS);
    for (const unexpanded of [other, exact, child]) {
      expect(unexpanded.policy).toEqual(CODEX_TEXT_GUARDED_BUDGET_POLICY);
    }
    // Later cooldowns or logins cannot shrink or replenish this request's snapshot.
    expandInferenceOAuthSendBudget(budget, 2);
    expandInferenceOAuthSendBudget(budget, 8);
    for (let i = 0; i < 4 * TRANSIENT_RETRY_MAX_ATTEMPTS; i++) {
      const send = budget.reserveDispatch({ sendClass: "transient", targetKey: "physical-url" });
      expect(send.allowed).toBe(true);
      if (send.allowed) send.permit.use();
    }
    expect(budget.reserveDispatch({ sendClass: "auth-recovery", targetKey: "physical-url" }).allowed).toBe(false);
    expect(child.used).toBe(budget.used);
  });

  test("one credential retains the default and a spent request cannot expand", () => {
    const req = new Request("http://localhost/v1/responses");
    const single = createInferenceSendBudget(req, { model: "m", provider: "p" });
    expandInferenceOAuthSendBudget(single, 1);
    expect(single.policy).toEqual(CODEX_TEXT_GUARDED_BUDGET_POLICY);
    const started = createInferenceSendBudget(req, { model: "m", provider: "p" });
    const send = started.reserveDispatch({ sendClass: "initial", targetKey: "physical-url" });
    if (send.allowed) send.permit.use();
    expandInferenceOAuthSendBudget(started, 4);
    expect(started.policy).toEqual(CODEX_TEXT_GUARDED_BUDGET_POLICY);
  });
});
