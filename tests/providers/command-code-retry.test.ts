import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCommandCodeAdapter } from "../../src/adapters/command-code";
import { createRequestExecutionBudget } from "../../src/lib/request-execution-budget";
import { resetCommandCodeReasoningEffortsForTest } from "../../src/providers/command-code-efforts";
import { handleResponses } from "../../src/server/responses";
import type { RequestLogContext } from "../../src/server/request-log";
import type { AdapterFetchContext, AdapterRequest } from "../../src/adapters/base";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let home: string, previousHome: string | undefined, codexHome: IsolatedCodexHome;
beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-command-retry-"));
  process.env.OPENCODEX_HOME = home;
  codexHome = installIsolatedCodexHome("ocx-command-retry-codex-");
  resetCommandCodeReasoningEffortsForTest();
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  codexHome.restore();
  removeTreeWithRetry(home);
  resetCommandCodeReasoningEffortsForTest();
});

const request: AdapterRequest = { url: "https://command.test/alpha/generate", method: "POST", headers: {},
  body: JSON.stringify({ params: { model: "deepseek/deepseek-v4-flash", reasoning_effort: "max" } }) };
const provider: OcxProviderConfig = { adapter: "command-code", baseUrl: "https://command.test", authMode: "key", apiKey: "synthetic-key" };
function fixture(status = 400) {
  const bodies: string[] = [];
  const executor = (async (_url, init) => {
    bodies.push(String(init?.body));
    return bodies.length === 1 ? Response.json({ error: "unsupported reasoning_effort", usage: { prompt_tokens: 3, completion_tokens: 1 } }, { status }) : new Response([
      { type: "text-delta", text: "answer" },
      { type: "finish", finishReason: "stop", totalUsage: { inputTokens: 10, outputTokens: 2 } },
    ].map(row => JSON.stringify(row) + "\n").join(""));
  }) as typeof fetch;
  const fetch = (async (url, init) => String(url).includes("commandcode.ai/models/")
    ? new Response("Reasoning efforts high are supported; no other reasoning settings.")
    : executor(url, init)) as typeof globalThis.fetch;
  return { bodies, executor, provider: { ...provider, fetch } as OcxProviderConfig };
}

test.each([400, 422])("effort rejection %s reserves and observes only the additional send", async status => {
  const f = fixture(status), budget = createRequestExecutionBudget();
  const sends: Parameters<NonNullable<AdapterFetchContext["onPhysicalSend"]>>[0][] = [];
  const response = await createCommandCodeAdapter(f.provider).fetchResponse!(request, {
    executor: f.executor, sendBudget: budget, onPhysicalSend: send => sends.push(send),
  });
  expect(response.status).toBe(200);
  expect(f.bodies).toHaveLength(2);
  expect(JSON.parse(f.bodies[1]!).params).not.toHaveProperty("reasoning_effort");
  expect(budget.used).toBe(2);
  expect(sends).toEqual([{ ordinal: 2, recovery: "reasoning-effort-downgrade" }]);
});

test("exhaustion preserves the original error body without sending or observing a retry", async () => {
  const f = fixture(), budget = createRequestExecutionBudget({
    maxTotalModelSends: 1, baseSendAllowance: 1, finalRecoveryAllowance: 0, maxAlternateTargetSends: 0, maxTargetTransitions: 0,
  });
  let observed = 0;
  const response = await createCommandCodeAdapter(f.provider).fetchResponse!(request, {
    executor: f.executor, sendBudget: budget, onPhysicalSend: () => observed++,
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "unsupported reasoning_effort", usage: { prompt_tokens: 3, completion_tokens: 1 } });
  expect(f.bodies).toHaveLength(1);
  expect(observed).toBe(0);
  expect(budget.used).toBe(budget.policy.maxTotalModelSends);
});

test("an exhausted entry budget cannot send the initial request", async () => {
  const f = fixture(), budget = createRequestExecutionBudget();
  budget.used = budget.policy.maxTotalModelSends;
  let observed = 0;
  await expect(createCommandCodeAdapter(f.provider).fetchResponse!(request, {
    executor: f.executor, sendBudget: budget, onPhysicalSend: () => observed++,
  })).rejects.toMatchObject({ code: "request_send_budget_exhausted" });
  expect(f.bodies).toHaveLength(0);
  expect(observed).toBe(0);
});

test("a non-retry response leaves entry accounting to the caller", async () => {
  const f = fixture(403), budget = createRequestExecutionBudget();
  let observed = 0;
  const response = await createCommandCodeAdapter(f.provider).fetchResponse!(request, {
    executor: f.executor, sendBudget: budget, onPhysicalSend: () => observed++,
  });
  expect(response.status).toBe(403);
  expect(f.bodies).toHaveLength(1);
  expect(observed).toBe(0);
  expect(budget.used).toBe(1);
});

test.each([false, true])("routed key retry counts each dispatch once (stream=%s)", async stream => {
  const f = fixture(), logCtx: RequestLogContext = { provider: "", model: "" };
  const budget = createRequestExecutionBudget();
  const config = { port: 0, defaultProvider: "fixture", providers: { fixture: f.provider } } as OcxConfig;
  const req = new Request("http://localhost/v1/responses", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "fixture/deepseek/deepseek-v4-flash", input: "hello", reasoning: { effort: "max" }, stream }) });
  const response = await handleResponses(req, config, logCtx, { sendBudget: budget });
  expect(await response.text()).toContain("answer");
  expect(response.status).toBe(200);
  expect(f.bodies).toHaveLength(2);
  expect(budget.used).toBe(2);
  expect(logCtx.activeAttempt).toMatchObject({ sendCount: 2, recoveryKinds: ["reasoning-effort-downgrade"],
    usage: { inputTokens: 13, outputTokens: 3 } });
});
