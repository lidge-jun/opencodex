import { expect, test } from "bun:test";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import {
  createRegisteredAdvisorPlan, linkAdvisorPlanConfig, setAdvisorPlanFactory, type AdvisorPlanInput,
} from "../../src/server/responses/advisor-plan-slot";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import type { OcxConfig } from "../../src/types";

// The Advisor factory is registered on the live config object, but /v1/messages hands the
// Responses pipeline a request-scoped replay view (`buildClaudeReplayConfig` plus cacheRetention).
// Looking the factory up by that view alone found nothing, so Claude Code never saw the advisor
// tool and preflight never ran while /v1/chat/completions on the same config worked.

const workerStream = 'data: {"choices":[{"delta":{"content":"fixture"},"finish_reason":null}]}\n\n'
  + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';

const plan = (seen: AdvisorPlanInput[]) => async (input: AdvisorPlanInput) => {
  seen.push(input);
  return {
    tool: { name: "advisor", description: "fixture", parameters: { type: "object", properties: {} }, advisor: true },
    preflightInject: async () => false,
    attachGuard: () => {},
  };
};

test("a linked request view resolves the live factory at lookup time", async () => {
  const live = { port: 10100, providers: {} } as OcxConfig;
  const view = linkAdvisorPlanConfig(live, { ...live, cacheRetention: "short" as const });
  const nested = linkAdvisorPlanConfig(view, { ...view });
  const seen: AdvisorPlanInput[] = [];
  expect(createRegisteredAdvisorPlan({ config: view, workerIdentity: "w", workerModelId: "w" })).toBeNull();
  setAdvisorPlanFactory(live, plan(seen));
  try {
    expect((await createRegisteredAdvisorPlan({ config: view, workerIdentity: "w", workerModelId: "w" }))?.tool.name).toBe("advisor");
    expect((await createRegisteredAdvisorPlan({ config: nested, workerIdentity: "w", workerModelId: "w" }))?.tool.name).toBe("advisor");
    // The plan still receives the view it was asked for, not the live object.
    expect(seen.map(input => input.config)).toEqual([view, nested]);
    expect(seen[0]!.config).toBe(view);
    // An unrelated copy never inherits a factory it was not linked to.
    expect(createRegisteredAdvisorPlan({ config: { ...live }, workerIdentity: "w", workerModelId: "w" })).toBeNull();
  } finally { setAdvisorPlanFactory(live, null); }
  // Disabling the live config detaches every view linked to it.
  expect(createRegisteredAdvisorPlan({ config: view, workerIdentity: "w", workerModelId: "w" })).toBeNull();
});

test("/v1/messages reaches the factory registered on the live config and sends the advisor tool", async () => {
  const release = acquireOwnedSpendHome();
  const workerBodies: Record<string, unknown>[] = [];
  const seen: AdvisorPlanInput[] = [];
  const config: OcxConfig = {
    defaultProvider: "worker",
    providers: { worker: { adapter: "openai-chat", apiKey: "fixture", models: ["m"], liveModels: false,
      baseUrl: "https://worker.test/v1",
      fetch: (async (_url, init) => {
        workerBodies.push(JSON.parse(String(init?.body)));
        return new Response(workerStream, { headers: { "content-type": "text/event-stream" } });
      }) as typeof fetch } },
  };
  setAdvisorPlanFactory(config, plan(seen));
  try {
    const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "worker/m", max_tokens: 100, stream: false, messages: [{ role: "user", content: "fixture" }] }),
    }), config, { model: "", provider: "" }, { requestId: "advisor-messages", start: Date.now() });
    await response.text();
    expect(response.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.config).not.toBe(config);
    expect(workerBodies).toHaveLength(1);
    const tools = (workerBodies[0]!.tools ?? []) as { function?: { name?: string } }[];
    expect(tools.map(tool => tool.function?.name)).toContain("advisor");
  } finally { setAdvisorPlanFactory(config, null); release(); }
});
