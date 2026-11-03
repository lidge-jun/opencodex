import { expect, mock, test } from "bun:test";
import * as slot from "../../src/server/responses/advisor-plan-slot";
import type { AdvisorPlanInput } from "../../src/server/responses/advisor-plan-slot";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { runAdmittedBodyWork } from "../../src/server/inbound-body-admission";
import { inboundBodyBudget } from "../../src/server/inbound-body-budget";
import { MAX_DECOMPRESSED_BODY_BYTES } from "../../src/server/request-decompress";
import { tryAdmitTurn } from "../../src/server/lifecycle";
import type { ServeOptionsContext } from "../../src/server/index/serve-options";

// #7859: a raised maxInboundBodyBytes makes the HTTP wrapper wait for inbound-body capacity before
// the handler runs. The Advisor caller policy must be the one admitted at authentication, not one
// read from the live config after that wait.
// Pass-through: mock.module is process-wide, so other files in the same run keep the real plan.
const originalCreate = slot.createRegisteredAdvisorPlan;
const inputs: AdvisorPlanInput[] = [];
mock.module("../../src/server/responses/advisor-plan-slot", () => ({
  ...slot,
  createRegisteredAdvisorPlan(input: AdvisorPlanInput) { inputs.push(input); return originalCreate(input); },
}));
const { createServeOptions } = await import("../../src/server/index/serve-options");
const stream = 'data: {"choices":[{"delta":{"content":"fixture"},"finish_reason":null}]}\n\n'
  + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
function config(raised: boolean): OcxConfig {
  return {
    hostname: "0.0.0.0", defaultProvider: "worker",
    ...(raised ? { maxInboundBodyBytes: MAX_DECOMPRESSED_BODY_BYTES + 1 } : {}),
    providers: { worker: { adapter: "openai-chat", apiKey: "fixture", models: ["m"],
      liveModels: false, baseUrl: "https://worker.test/v1",
      fetch: (async (_input, init) => JSON.parse(String(init?.body)).stream
        ? new Response(stream, { headers: { "content-type": "text/event-stream" } })
        : Response.json({ choices: [{ message: { content: "fixture" }, finish_reason: "stop" }] })) as typeof fetch } },
    apiKeys: [{ id: "laptop", name: "laptop", key: "ocx_data_" + "c".repeat(40), createdAt: "2026-01-01", allowMeteredComboTargets: false }],
    fallback: { devices: { laptop: { provider: false } } },
  };
}

for (const wire of ["responses", "chat/completions", "messages", "responses/compact"] as const) {
  for (const raised of [false, true]) {
    test(`HTTP ${wire} keeps the admitted caller policy across the capacity wait (raised limit: ${raised})`, async () => {
      const release = acquireOwnedSpendHome();
      inputs.length = 0;
      const cfg = config(raised);
      const runAdmittedHttpTurn: ServeOptionsContext["runAdmittedHttpTurn"] = (req, policy, work, refusalLog) => {
        const lease = tryAdmitTurn(undefined, req.signal)!;
        // The same body-admission helper index.ts runs before handing the turn to its handler.
        return runAdmittedBodyWork(req, policy, cfg.maxInboundBodyBytes, () => work(lease), refusalLog)
          .finally(() => { if (!lease.isTransferred()) lease.release(); });
      };
      const ctx = {
        config: cfg, deps: {}, ingressForServer: () => "public",
        packageTreeIntegrity: { status: () => ({ ok: true }) }, runAdmittedHttpTurn,
      } as unknown as ServeOptionsContext;
      const serve = createServeOptions(ctx);
      const request = new Request(`http://localhost/v1/${wire}`, {
        method: "POST", headers: { "content-type": "application/json", "x-opencodex-api-key": cfg.apiKeys![0]!.key },
        body: JSON.stringify({ model: "worker/m", store: true, max_tokens: 100, stream: false,
          input: [{ role: "user", content: "fixture" }], messages: [{ role: "user", content: "fixture" }] }),
      });
      const holder = raised ? await inboundBodyBudget.acquire(inboundBodyBudget.capacity(), request.signal, 0) : null;
      try {
        const requestServer = { timeout() {} } as unknown as Parameters<typeof serve.fetch>[1];
        const pending = serve.fetch(request, requestServer);
        if (raised) expect(inboundBodyBudget.snapshot().queuedRequests).toBe(1);
        cfg.apiKeys![0]!.allowMeteredComboTargets = true;
        cfg.fallback = {};
        holder?.release();
        const response = await pending;
        await response.text();
        expect(response.status).toBe(200);
        expect(inputs).toHaveLength(1);
        const captured = inputs[0]!.admissionPolicy!;
        expect({ paid: captured.allowMeteredComboTargets,
          providerFallback: captured.fallbackPolicies[0]!.config.fallback?.devices?.laptop?.provider })
          .toEqual({ paid: false, providerFallback: false });
      } finally { holder?.release(); release(); }
    });
  }
}
