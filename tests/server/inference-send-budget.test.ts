import { describe, expect, test } from "bun:test";
import { CODEX_TEXT_GUARDED_BUDGET_POLICY } from "../../src/lib/request-execution-budget";
import { createInferenceSendBudget } from "../../src/server/inference/context";
import type { RequestLogContext } from "../../src/server/request-log";

describe("createInferenceSendBudget", () => {
  test("mints a default-policy holder and parks this request's spend tracker on the log", () => {
    const logCtx: RequestLogContext = { model: "m", provider: "p" };
    const req = new Request("http://localhost/v1/responses", { method: "POST" });
    const budget = createInferenceSendBudget(req, logCtx);
    expect(budget.policy).toBe(CODEX_TEXT_GUARDED_BUDGET_POLICY);
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
});
