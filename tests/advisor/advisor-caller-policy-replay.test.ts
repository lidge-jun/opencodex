import { expect, test } from "bun:test";
import { handleResponses } from "../../src/server/responses/policy-fallback";
import { handleChatCompletions } from "../../src/server/chat-completions";
import { activateAdvisor } from "../../src/lib/advisor-activation";
import { resolveDataPlaneAdmissionSecret } from "../../src/server/auth-cors";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { setAdvisorPlanFactory } from "../../src/server/responses/advisor-plan-slot";
import { createAdvisorRuntimePlan } from "../../src/advisor/runtime";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { createWebsocketHandler } from "../../src/server/index/websocket-handler";
import { tryReserveCodexWebSocket } from "../../src/codex/websocket-registry";
import { buildResponsesWsData, type WsData } from "../../src/server/ws-bridge";
import type { ServerWebSocket } from "bun";
import { closeRequestHistoryIndex } from "../../src/routing/history/indexer";
import { runOptionalShutdownHooks } from "../../src/lib/optional-shutdown-hooks";
import { clearComboSelectionState, clearComboTargetCooldowns } from "../../src/combos";

for (const ingress of ["wrapper", "websocket"] as const) test(`policy replay keeps ingress paid refusal (${ingress})`, async () => {
  const release = acquireOwnedSpendHome();
  clearComboSelectionState(); clearComboTargetCooldowns();
  const oldFetch = globalThis.fetch;
  const calls: string[] = [];
  const policies: { worker: string; paid?: boolean }[] = [];
  let secondSends = 0;
  const sse = (frames: unknown[]) => new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  const provider = (name: string): OcxProviderConfig => ({
    adapter: "openai-chat", apiKey: "fixture", models: ["m"], liveModels: false,
    baseUrl: `https://${name}.test/v1`, fetch: (async (_url, init) => {
      calls.push(`${name}/m`);
      const body = JSON.parse(String(init?.body));
      if (name === "a") {
        config.apiKeys![1]!.allowMeteredComboTargets = true;
        return Response.json({ error: { code: "model_not_found", message: "fixture missing model" } }, { status: 404 });
      }
      if (name === "b" && secondSends++ === 0) return sse([
        { choices: [{ delta: { role: "assistant", tool_calls: [{ index: 0, id: "ask1", type: "function", function: { name: "advisor", arguments: '{"question":"routing advice?"}' } }] }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ]);
      return body.stream ? sse([
        { choices: [{ delta: { content: "fixture answer" }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]) : Response.json({ choices: [{ message: { content: "fixture answer" }, finish_reason: "stop" }] });
    }) as typeof fetch,
  });
  const config: OcxConfig = {
    port: 10100, defaultProvider: "a",
    providers: { a: provider("a"), b: provider("b"), paid: provider("paid") },
    apiKeys: [
      { id: "host", name: "host", key: "ocx_data_" + "h".repeat(40), createdAt: "2026-01-01", allowMeteredComboTargets: true },
      { id: "laptop", name: "laptop", key: "ocx_data_" + "c".repeat(40), createdAt: "2026-01-01", allowMeteredComboTargets: false },
    ],
    routingProfiles: { daily: { candidates: [{ provider: "a", model: "m" }, { provider: "b", model: "m" }] } },
    combos: { inner: { targets: [{ provider: "paid", model: "m", metered: true }] } },
    advisor: { enabled: true, model: "combo/inner", policy: "manual", effort: "high", contextSharingConsent: "v1" },
  };
  activateAdvisor(config);
  setAdvisorPlanFactory(config, async input => {
    policies.push({ worker: input.workerIdentity, paid: input.admissionPolicy?.allowMeteredComboTargets });
    return createAdvisorRuntimePlan(input);
  });
  globalThis.fetch = (async (input, init) => {
    expect(new URL(String(input)).pathname).toBe("/v1/chat/completions");
    const headers = new Headers(init?.headers);
    const admission = resolveDataPlaneAdmissionSecret(headers.get("x-opencodex-api-key")!, config, "x-api-key")!;
    return handleChatCompletions(new Request(String(input), init), config, { model: "", provider: "" }, { requestId: "r4-policy", start: Date.now(), admission });
  }) as typeof fetch;
  const admission = { kind: "configured", keyId: "laptop", source: "bearer" } as const;
  try {
    if (ingress === "websocket") {
      const handler = createWebsocketHandler({ config, deps: {} } as Parameters<typeof createWebsocketHandler>[0]);
      const sent: any[] = [];
      let readyState = 1;
      const ws = {
        data: buildResponsesWsData(new Headers(), admission, tryReserveCodexWebSocket() ?? undefined),
        get readyState() { return readyState; }, getBufferedAmount: () => 0,
        send(text: string) { sent.push(JSON.parse(text)); return 1; },
        close(code = 1000, reason = "") { if (readyState === 3) return; readyState = 3; handler.close(ws, code, reason); },
      } as unknown as ServerWebSocket<WsData>;
      handler.open(ws);
      try {
        handler.message(ws, JSON.stringify({ type: "response.create", model: "policy/daily", input: "fixture routing task" }));
        const deadline = Date.now() + 4000;
        while (ws.data.cancel && Date.now() < deadline) await Bun.sleep(1);
        expect(ws.data.cancel).toBeUndefined();
        expect(secondSends).toBe(2);
        expect(sent.some(f => f.type === "response.completed")).toBe(true);
        expect(calls).not.toContain("paid/m");
        expect(policies.map(policy => policy.paid)).toEqual([false, false]);
      } finally { ws.close(); }
      return;
    }
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "policy/daily", input: "fixture routing task", stream: true }),
    }), config, { model: "", provider: "" }, {
      admission, inboundTransport: "websocket",
    });
    await response.text();
    expect(response.status).toBe(200);
    expect(secondSends).toBe(2);
    expect(calls).not.toContain("paid/m");
    expect(policies.map(policy => policy.paid)).toEqual([false, false]);
  } finally { globalThis.fetch = oldFetch; closeRequestHistoryIndex(); runOptionalShutdownHooks(); release(); clearComboSelectionState(); clearComboTargetCooldowns(); }
});
