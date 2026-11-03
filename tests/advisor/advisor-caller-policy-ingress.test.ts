import { afterEach, expect, mock, test } from "bun:test";
import * as slot from "../../src/server/responses/advisor-plan-slot";
import type { AdvisorPlanInput } from "../../src/server/responses/advisor-plan-slot";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import type { OcxConfig } from "../../src/types";

// #7859: the Advisor plan must receive the caller policy admitted at ingress, captured before the
// first await. Each case widens the live config while the body is still being read.
const originalCreate = slot.createRegisteredAdvisorPlan;
const inputs: AdvisorPlanInput[] = [];
mock.module("../../src/server/responses/advisor-plan-slot", () => ({
  ...slot,
  createRegisteredAdvisorPlan(input: AdvisorPlanInput) {
    inputs.push(input);
    return originalCreate(input);
  },
}));
const { handleClaudeMessages } = await import("../../src/server/claude-messages");
const { handleChatCompletions } = await import("../../src/server/chat-completions");
afterEach(() => { inputs.length = 0; });

const workerStream = 'data: {"choices":[{"delta":{"content":"fixture"},"finish_reason":null}]}\n\n'
  + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';

for (const wire of ["messages", "chat"] as const) {
  for (const kind of ["metered", "fallback"] as const) {
    test(`${wire} keeps the admitted caller ${kind} policy when config widens during body read`, async () => {
      const release = acquireOwnedSpendHome();
      try {
        const config: OcxConfig = {
          defaultProvider: "worker",
          providers: { worker: { adapter: "openai-chat", apiKey: "fixture", models: ["m"],
            liveModels: false, baseUrl: "https://worker.test/v1",
            fetch: (async () => new Response(workerStream, { headers: { "content-type": "text/event-stream" } })) as typeof fetch } },
          apiKeys: [{ id: "laptop", name: "laptop", key: "fixture", createdAt: "2026-01-01", allowMeteredComboTargets: false }],
          fallback: { devices: { laptop: { provider: false } } },
        };
        const request = new Request(`http://localhost/v1/${wire}`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "worker/m", store: true, max_tokens: 100, stream: false, messages: [{ role: "user", content: "fixture" }] }),
        });
        const pending = (wire === "messages" ? handleClaudeMessages : handleChatCompletions)(request, config,
          { model: "", provider: "" }, { requestId: "capture-probe", start: Date.now(), admission: { kind: "configured", keyId: "laptop", source: "bearer" } });
        config.apiKeys![0]!.allowMeteredComboTargets = true;
        config.fallback = {};
        const response = await pending;
        await response.text();
        expect(response.status).toBe(200);
        expect(inputs).toHaveLength(1);
        if (kind === "metered") expect(inputs[0]!.admissionPolicy!.allowMeteredComboTargets).toBe(false);
        else expect(inputs[0]!.admissionPolicy!.fallbackPolicies[0]!.config.fallback?.devices?.laptop?.provider).toBe(false);
      } finally { release(); }
    });
  }
}
