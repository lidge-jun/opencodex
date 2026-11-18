import { expect, test } from "bun:test";
import { handleResponses } from "../../src/server/responses/core";
import { handleChatCompletions } from "../../src/server/chat-completions";
import { activateAdvisor } from "../../src/lib/advisor-activation";
import { resolveDataPlaneAdmissionSecret } from "../../src/server/auth-cors";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { resetVisionDescriptionCache } from "../../src/vision";
import { setAdvisorPlanFactory } from "../../src/server/responses/advisor-plan-slot";
import { createAdvisorRuntimePlan } from "../../src/advisor/runtime";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { clearComboSelectionState, clearComboTargetCooldowns } from "../../src/combos";

for (const refusing of ["caller", "host"] as const) for (const kind of ["metered", "fallback"] as const) test(`routed vision Advisor must retain ${refusing} ${kind} refusal`, async () => {
  const release = acquireOwnedSpendHome();
  const oldFetch = globalThis.fetch;
  resetVisionDescriptionCache();
  clearComboSelectionState(); clearComboTargetCooldowns();
  const calls: string[] = [];
  const policies: { paid?: boolean; devices?: readonly (readonly string[])[] }[] = [];
  let helperSends = 0;
  const sse = (frames: unknown[]) => new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  const provider = (name: string): OcxProviderConfig => ({
    adapter: name === "helper" ? "anthropic" : "openai-chat", apiKey: "fixture", models: ["m"], liveModels: false,
    baseUrl: `https://${name}.test/v1`,
    ...(name === "worker" ? { noVisionModels: ["m"] } : {}),
    ...(name === "helper" ? { modelCapabilities: { m: { inputModalities: ["text", "image"] } } } : {}),
    fetch: (async (_url, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.has("x-opencodex-sidecar-internal")).toBe(false);
      expect(headers.has("x-opencodex-sidecar-admission-policy")).toBe(false);
      calls.push(`${name}/m`);
      const body = JSON.parse(String(init?.body));
      if (kind === "fallback" && name === "paid") return Response.json({ error: { code: "model_not_found", message: "fixture missing model" } }, { status: 404 });
      if (name === "helper" && helperSends++ === 0) {
        expect(body.tools.some((tool: any) => tool.name === "advisor")).toBe(true);
        return sse([
          { type: "message_start", message: { id: "fixture", role: "assistant", model: "m", content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
          { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "ask1", name: "advisor", input: {} } },
          { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"question":"routing advice?"}' } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } },
          { type: "message_stop" },
        ]);
      }
      if (name === "helper") return sse([
        { type: "message_start", message: { id: "fixture2", role: "assistant", model: "m", content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "fixture answer" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ]);
      return body.stream ? sse([
        { choices: [{ delta: { content: "fixture answer" }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]) : Response.json({ choices: [{ message: { content: "fixture answer" }, finish_reason: "stop" }] });
    }) as typeof fetch,
  });
  const config: OcxConfig = {
    port: 10100, defaultProvider: "worker",
    providers: { worker: provider("worker"), helper: provider("helper"), paid: provider("paid"), backup: provider("backup") },
    apiKeys: [
      { id: "host", name: "host", key: "ocx_data_" + "h".repeat(40), createdAt: "2026-01-01", allowMeteredComboTargets: refusing !== "host" },
      { id: "laptop", name: "laptop", key: "ocx_data_" + "c".repeat(40), createdAt: "2026-01-01", allowMeteredComboTargets: refusing !== "caller" },
    ],
    fallback: { devices: { [refusing === "caller" ? "laptop" : "host"]: { provider: false } } },
    combos: { inner: { targets: kind === "metered" ? [{ provider: "paid", model: "m", metered: true }] : [{ provider: "paid", model: "m" }, { provider: "backup", model: "m" }] } },
    visionSidecar: { enabled: true, backend: "routed", model: "helper/m" },
    advisor: { enabled: true, model: "combo/inner", policy: "manual", effort: "high", contextSharingConsent: "v1" },
  };
  activateAdvisor(config);
  setAdvisorPlanFactory(config, async input => {
    policies.push({ paid: input.admissionPolicy?.allowMeteredComboTargets, devices: input.admissionPolicy?.fallbackPolicies.map(p => p.deviceIds) });
    return createAdvisorRuntimePlan(input);
  });
  globalThis.fetch = (async (input, init) => {
    expect(new URL(String(input)).pathname).toBe("/v1/chat/completions");
    const headers = new Headers(init?.headers);
    const admission = resolveDataPlaneAdmissionSecret(headers.get("x-opencodex-api-key")!, config, "x-api-key")!;
    return handleChatCompletions(new Request(String(input), init), config, { model: "", provider: "" }, { requestId: "r4-vision", start: Date.now(), admission });
  }) as typeof fetch;
  try {
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "worker/m", input: [{ role: "user", content: [{ type: "input_text", text: "Describe this fixture" }, { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" }] }], stream: false }),
    }), config, { model: "", provider: "" }, { admission: { kind: "configured", keyId: "laptop", source: "bearer" } });
    await response.text();
    expect(response.status).toBe(200);
    expect(helperSends).toBe(2);
    expect(calls).not.toContain(kind === "metered" ? "paid/m" : "backup/m");
    expect(policies[0]?.paid).toBe(false);
    expect(policies[0]?.devices?.flat()).toEqual(expect.arrayContaining(["host", "laptop"]));
  } finally { globalThis.fetch = oldFetch; resetVisionDescriptionCache(); release(); clearComboSelectionState(); clearComboTargetCooldowns(); }
});
