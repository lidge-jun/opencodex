import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAdvisorRuntimePlan } from "../../src/advisor/runtime";
import { createAdvisorTaskBudget } from "../../src/advisor/budget";
import { createAdvisorActivityStore } from "../../src/advisor/activity";
import { createAdvisorPreflightLedger } from "../../src/advisor/state";
import { parseAdvisorSettingsPatch } from "../../src/server/management/advisor-routes";
import { resolveAdvisorSettings } from "../../src/advisor/settings";
import { parseRequest } from "../../src/responses/parser";
import type { OcxConfig } from "../../src/types";

const originalFetch = globalThis.fetch;
const roots: string[] = [];
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function tool(id: string, name: string, args: unknown, output: string) {
  return [
    { type: "function_call", call_id: id, name, arguments: JSON.stringify(args) },
    { type: "function_call_output", call_id: id, output },
  ];
}
function request(retry = false, suffix = "", thread = "stable-thread") {
  const input = [
    { role: "user", content: "Fix these failing tests. private-task-text" },
    ...tool("first" + suffix, "exec_command", { cmd: "bun test" }, "Process exit code: 1\nprivate-failure-output"),
  ];
  if (retry) input.push(...tool("edit" + suffix, "apply_patch", {}, "Success. Updated files"),
    ...tool("retry" + suffix, "exec_command", { cmd: "bun test" }, "Process exit code: 1\nprivate-retry-output"));
  const parsed = parseRequest({ model: "worker", stream: false, input });
  if (thread) parsed._codexOwnThreadId = thread;
  return parsed;
}
function fixture(limit = 3) {
  const root = mkdtempSync(join(tmpdir(), "advisor-adaptive-")); roots.push(root);
  const budgetPath = join(root, "budget.sqlite");
  const config = { port: 10100, providers: {}, advisor: {
    enabled: true, model: "expert", policy: "adaptive", effort: "max", contextSharingConsent: "v1", maxConsultationsPerTask: limit,
  } } as OcxConfig;
  const ledger = createAdvisorPreflightLedger();
  const activities = createAdvisorActivityStore();
  const budget = createAdvisorTaskBudget(budgetPath);
  const plan = (extra: Partial<Parameters<typeof createAdvisorRuntimePlan>[0]> = {}) => createAdvisorRuntimePlan({
    config, ledger, budget, activities, workerIdentity: "worker", workerModelId: "worker",
    baseUrlOverride: "http://expert.test", ...extra,
  })!;
  return { config, budget, budgetPath, ledger, activities, plan };
}
function loopback() {
  const calls: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body)));
    return Response.json({ choices: [{ message: { content: "private-advice: inspect the state owner" } }], usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 } },
      { headers: { "x-opencodex-advisor-reasoning": '{"effectiveEffort":"high"}' } });
  }) as typeof fetch;
  return calls;
}

test("initial advice and a later failed repair have independent claims and bounded evidence context", async () => {
  const f = fixture(); const calls = loopback();
  expect(await f.plan().preflightInject(request())).toBe(true);
  const repeated = request(true);
  expect(await f.plan().preflightInject(repeated)).toBe(true);
  expect(await f.plan().preflightInject(request(true))).toBe(false);
  expect(calls).toHaveLength(2);
  expect(JSON.stringify(calls[1])).toContain("Repeated validation failure");
  const advisory = repeated.context.messages.at(-1)!;
  expect(advisory.role).toBe("user");
  expect(JSON.stringify(repeated.context.messages.filter(m => m.role === "developer"))).not.toContain("private-advice");
  expect(f.activities.snapshot().map(entry => entry.trigger)).toEqual(["repair_failure", "preflight"]);
});

test("concurrent requests for one failed repair dispatch only one consultation", async () => {
  const f = fixture(); const calls = loopback();
  expect(await Promise.all([f.plan().preflightInject(request(true)), f.plan().preflightInject(request(true))])).toEqual([true, false]);
  expect(calls).toHaveLength(1);
});

test("adaptive task allowance includes manual calls and survives new ledger, process and worker identity", async () => {
  const f = fixture(2); const calls = loopback();
  const first = f.plan(); const parsed = request();
  expect(await first.preflightInject(parsed)).toBe(true);
  expect((await first.consult(parsed, "manual", "Check this assumption")).ok).toBe(true);
  const restarted = f.plan({ ledger: createAdvisorPreflightLedger(), budget: createAdvisorTaskBudget(f.budgetPath), workerModelId: "another-worker" });
  expect(await restarted.preflightInject(request(true))).toBe(false);
  expect(calls).toHaveLength(2);
  expect(f.activities.snapshot()[0]!.status).toBe("blocked");
  const refused = await restarted.consult(request(true), "manual", "Another question");
  expect(refused.blocked).toBe("budget");
  // A task-budget refusal must not tell the worker the per-request limit was reached.
  expect(refused.content).toContain("consultation kind: budget");
  expect(refused.content).toContain("task consultation budget is exhausted or unavailable");
  expect(refused.content).not.toContain("limit reached for this request");
  expect(calls).toHaveLength(2);
});

test("no stable identity means no adaptive automatic call, while manual remains request-bounded", async () => {
  const f = fixture(); const calls = loopback();
  const plan = f.plan(); const parsed = request(true, "", "");
  expect(await plan.preflightInject(parsed)).toBe(false);
  for (let i = 0; i < 3; i++) expect((await plan.consult(parsed, "manual", String(i))).ok).toBe(true);
  const blocked = await plan.consult(parsed, "manual", "fourth");
  expect(blocked.blocked).toBe("limit");
  expect(blocked.content).toContain("per-request consultation limit reached");
  expect(f.activities.snapshot()[0]!.blockReason).toBe("limit");
  expect(calls).toHaveLength(3);
});

test("consent revoked after claim neither reserves budget nor injects advice", async () => {
  const f = fixture(1); const calls = loopback();
  const parsed = request(true);
  expect(await f.plan({ afterPreflightClaim: () => { delete f.config.advisor!.contextSharingConsent; } }).preflightInject(parsed)).toBe(false);
  expect(calls).toHaveLength(0);
  expect(parsed.context.messages.some(message => message.role === "developer")).toBe(false);
  f.config.advisor!.contextSharingConsent = "v1";
  expect(await f.plan().preflightInject(request(true))).toBe(true);
});

test("cancelled dispatched consultations release the claim but keep the possibly spent allowance", async () => {
  const f = fixture(1); const controller = new AbortController();
  globalThis.fetch = (async () => { controller.abort(); throw new DOMException("cancelled", "AbortError"); }) as typeof fetch;
  const parsed = request(true);
  expect(await f.plan({ abortSignal: controller.signal }).preflightInject(parsed)).toBe(false);
  expect(parsed.context.messages.some(message => message.role === "developer")).toBe(false);
  const calls = loopback();
  expect(await f.plan().preflightInject(request(true))).toBe(false);
  expect(calls).toHaveLength(0);
  expect(f.activities.snapshot().map(entry => entry.status)).toEqual(["blocked", "cancelled"]);
});

test("unavailable budget fails open for the worker without an expert call", async () => {
  const f = fixture(); const calls = loopback(); const parsed = request(true);
  const before = parsed.context.messages.length;
  expect(await f.plan({ budget: { reserve: () => ({ ok: false, reason: "unavailable" }) } }).preflightInject(parsed)).toBe(false);
  expect(calls).toHaveLength(0);
  expect(parsed.context.messages).toHaveLength(before);
});

test("activity records contain metadata and mapped effort, never context, commands or advice", async () => {
  const f = fixture(); loopback();
  await f.plan().preflightInject(request(true));
  const records = f.activities.snapshot();
  expect(records[0]).toMatchObject({ trigger: "repair_failure", status: "ok", requestedEffort: "max", effectiveEffort: "high", usage: { inputTokens: 9, outputTokens: 4, totalTokens: 13 } });
  const serialized = JSON.stringify(records);
  for (const text of ["private-task-text", "private-failure-output", "private-advice", "stable-thread", "bun test"]) expect(serialized).not.toContain(text);
  records[0]!.usage!.inputTokens = 1000;
  expect(f.activities.snapshot()[0]!.usage!.inputTokens).toBe(9);
  expect(f.activities.snapshot(Date.now() + 86_400_001)).toHaveLength(0);
});

test("adaptive settings and task limits use the same strict API and resolver contract", () => {
  expect(parseAdvisorSettingsPatch({ policy: "adaptive", maxConsultationsPerTask: 2 })).toEqual({ ok: true, patch: { policy: "adaptive", maxConsultationsPerTask: 2 } });
  for (const value of [0, 4, 1.1, "2", null]) expect(parseAdvisorSettingsPatch({ maxConsultationsPerTask: value }).ok).toBe(false);
  expect(resolveAdvisorSettings({ advisor: { maxConsultationsPerTask: 4 } }).maxConsultationsPerTask).toBe(3);
});
