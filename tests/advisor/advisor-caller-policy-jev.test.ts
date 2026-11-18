import { expect, test } from "bun:test";
import { handleResponses } from "../../src/server/responses/core";
import { handleChatCompletions } from "../../src/server/chat-completions";
import { activateAdvisor } from "../../src/lib/advisor-activation";
import { advisorBaseUrl } from "../../src/advisor/consult";
import { resolveDataPlaneAdmissionSecret } from "../../src/server/auth-cors";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { clearComboSelectionState, clearComboTargetCooldowns } from "../../src/combos";
import { setAdvisorPlanFactory } from "../../src/server/responses/advisor-plan-slot";
import { createAdvisorRuntimePlan } from "../../src/advisor/runtime";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";

// #7859: a JEV decision turn runs detached from its parent. Its synthetic Advisor consultation must keep
// the caller policy admitted at ingress even when the live config widens while the parent is suspended.

for (const kind of ["metered", "fallback"] as const) for (const widen of [false, true]) test(`detached JEV Advisor preserves ingress ${kind} refusal (widen=${widen})`, async () => {
  const release = acquireOwnedSpendHome();
  const oldFetch = globalThis.fetch;
  clearComboSelectionState(); clearComboTargetCooldowns();
  const calls: string[] = [];
  const policies: unknown[] = [];
  let decisionSends = 0;
  const sse = (frames: unknown[]) => new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  const provider = (name: string): OcxProviderConfig => ({
    adapter: "openai-chat", apiKey: "fixture", models: ["m"], liveModels: false,
    baseUrl: `https://${name}.test/v1`, fetch: (async (_url, init) => {
      calls.push(`${name}/m`);
      const body = JSON.parse(String(init?.body));
      if (kind === "fallback" && name === "paid") return Response.json({ error: { code: "model_not_found", message: "fixture missing model" } }, { status: 404 });
      if (name === "decision" && decisionSends++ === 0) {
        expect(body.tools.some((tool: any) => tool.function?.name === "advisor")).toBe(true);
        return sse([
          { choices: [{ delta: { role: "assistant", tool_calls: [{ index: 0, id: "ask1", type: "function", function: { name: "advisor", arguments: '{"question":"routing advice?"}' } }] }, finish_reason: null }] },
          { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
        ]);
      }
      const content = name === "decision" ? '{"choice":"worker/m:none"}' : "fixture answer";
      return body.stream ? sse([
        { choices: [{ delta: { content }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]) : Response.json({ choices: [{ message: { content }, finish_reason: "stop" }] });
    }) as typeof fetch,
  });
  const config: OcxConfig = {
    port: 10100, defaultProvider: "worker",
    providers: { worker: provider("worker"), other: provider("other"), decision: provider("decision"), paid: provider("paid"), backup: provider("backup") },
    apiKeys: [
      { id: "host", name: "host", key: "ocx_data_" + "h".repeat(40), createdAt: "2026-01-01", allowMeteredComboTargets: true },
      { id: "laptop", name: "laptop", key: "ocx_data_" + "c".repeat(40), createdAt: "2026-01-01", allowMeteredComboTargets: false },
    ],
    fallback: { devices: { laptop: { provider: false } } },
    combos: {
      outer: { strategy: "jev", decisionModel: "decision/m", targets: [{ provider: "worker", model: "m" }, { provider: "other", model: "m" }] },
      inner: { targets: kind === "metered" ? [{ provider: "paid", model: "m", metered: true }] : [{ provider: "paid", model: "m" }, { provider: "backup", model: "m" }] },
    },
    advisor: { enabled: true, model: "combo/inner", policy: "manual", effort: "high", contextSharingConsent: "v1" },
  };
  activateAdvisor(config);
  setAdvisorPlanFactory(config, input => {
    policies.push({ worker: input.workerModelId, paid: input.admissionPolicy?.allowMeteredComboTargets, fallback: input.admissionPolicy?.fallbackPolicies[0]?.config.fallback?.devices?.laptop?.provider });
    return createAdvisorRuntimePlan(input);
  });
  globalThis.fetch = (async (input, init) => {
    expect(String(input)).toBe(`${advisorBaseUrl(config)}/v1/chat/completions`);
    const headers = new Headers(init?.headers);
    const admission = resolveDataPlaneAdmissionSecret(headers.get("x-opencodex-api-key")!, config, "x-api-key")!;
    return handleChatCompletions(new Request(String(input), init), config, { model: "", provider: "" }, { requestId: "r3-jev", start: Date.now(), admission });
  }) as typeof fetch;
  try {
    const pending = handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "combo/outer", input: "fixture routing task", stream: false }),
    }), config, { model: "", provider: "" }, { admission: { kind: "configured", keyId: "laptop", source: "bearer" } });
    if (widen) { config.apiKeys![1]!.allowMeteredComboTargets = true; config.fallback = {}; }
    const response = await pending;
    await response.text();
    expect(response.status).toBe(200);
    expect(decisionSends).toBe(2);
    expect(calls).not.toContain(kind === "metered" ? "paid/m" : "backup/m");
  } finally { globalThis.fetch = oldFetch; release(); clearComboSelectionState(); clearComboTargetCooldowns(); }
});
