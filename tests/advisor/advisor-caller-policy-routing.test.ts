import { afterEach, beforeEach, expect, test } from "bun:test";
import { activateAdvisor } from "../../src/lib/advisor-activation";
import { handleResponses } from "../../src/server/responses/core";
import { handleChatCompletions } from "../../src/server/chat-completions";
import { resolveDataPlaneAdmissionSecret } from "../../src/server/auth-cors";
import { advisorBaseUrl } from "../../src/advisor/consult";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { clearComboSelectionState, clearComboTargetCooldowns } from "../../src/combos";
import { noteSubagentModelFailure, resetSubagentModelFallbackStateForTests } from "../../src/codex/subagent-model-fallback";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { ADVISOR_INTERNAL_CAPABILITY_HEADER, internalCallCapability } from "../../src/lib/local-internal-call-capability";

const originalFetch = globalThis.fetch;
const caller = { kind: "configured", keyId: "laptop", source: "bearer" } as const;
let release: (() => void) | undefined;
beforeEach(() => {
  release = acquireOwnedSpendHome();
  clearComboSelectionState();
  clearComboTargetCooldowns();
  resetSubagentModelFallbackStateForTests();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  release?.();
  clearComboSelectionState();
  clearComboTargetCooldowns();
  resetSubagentModelFallbackStateForTests();
});

function answer(init?: RequestInit, text = "fixture advice"): Response {
  const body = JSON.parse(String(init?.body));
  return body.stream ? new Response([
    { choices: [{ delta: { content: text }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
  ].map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream" },
  }) : Response.json({ choices: [{ message: { content: text }, finish_reason: "stop" }] });
}

type Variant = "combo" | "nested" | "collapsed" | "native";
function fixture(kind: "metered" | "fallback", variant: Variant, consent = false) {
  const calls: string[] = [];
  let consults = 0;
  const workerBodies: string[] = [];
  const provider = (id: string): OcxProviderConfig => ({
    adapter: "openai-chat", apiKey: "fixture-key", baseUrl: `https://${id}.test/v1`,
    models: ["m", "primary", "backup"], liveModels: false, reasoningEfforts: ["low", "high"],
    fetch: (async (_input, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.has("x-opencodex-advisor-admission-policy")).toBe(false);
      expect(headers.has(ADVISOR_INTERNAL_CAPABILITY_HEADER)).toBe(false);
      const model = JSON.parse(String(init?.body)).model;
      if (id === "worker") workerBodies.push(String(init?.body));
      calls.push(`${id}/${model}`);
      if (id === "expert" && model === "primary") {
        return Response.json({ error: { message: "fixture unavailable model", code: "model_not_found" } }, { status: 404 });
      }
      return answer(init, variant === "nested" && id === "expert" ? '{"choice":"free/m:high"}' : "fixture advice");
    }) as typeof fetch,
  });
  const config: OcxConfig = {
    port: 10100, defaultProvider: "worker",
    protocols: variant === "native" ? { rollout: { nativeChatCombos: true } } : undefined,
    providers: { worker: provider("worker"), expert: provider("expert"), free: provider("free"), primary: provider("primary"), backup: provider("backup") },
    apiKeys: [
      { id: "host", name: "host", key: "ocx_data_" + "h".repeat(40), createdAt: "2026-01-01", allowMeteredComboTargets: true },
      { id: "laptop", name: "laptop", key: "ocx_data_" + "c".repeat(40), createdAt: "2026-01-01", allowMeteredComboTargets: consent },
    ],
    fallback: { devices: { laptop: { model: consent, provider: consent } } },
    combos: { inner: { targets: kind === "metered"
      ? [{ provider: "expert", model: "m", metered: true }]
      : [{ provider: "expert", model: "primary" }, { provider: "backup", model: "m" }] } },
    advisor: { enabled: true, model: "combo/inner", effort: "high", policy: "preflight", contextSharingConsent: "v1" },
  };
  if (variant === "nested") {
    config.combos!.outer = { strategy: "jev", decisionModel: "combo/inner", targets: [{ provider: "free", model: "m" }] };
    config.advisor!.model = "combo/outer";
  }
  if (variant === "collapsed") {
    config.providers.primary!.adapter = "openai-responses";
    config.combos!.inner!.alias = "collapsed-expert";
    config.subagentModelFallback = ["collapsed-expert"];
    config.advisor!.model = "primary/m";
    noteSubagentModelFailure("primary/m", "429", config);
  }
  activateAdvisor(config);
  globalThis.fetch = (async (input, init) => {
    if (String(input) !== `${advisorBaseUrl(config)}/v1/chat/completions`) throw new Error("unexpected external fetch");
    consults++;
    const headers = new Headers(init?.headers);
    if (variant === "collapsed") headers.set("x-openai-subagent", "collab_spawn");
    const admission = resolveDataPlaneAdmissionSecret(headers.get("x-opencodex-api-key")!, config, "x-api-key")!;
    return handleChatCompletions(new Request(String(input), { ...init, headers }), config, { model: "", provider: "" }, {
      requestId: `policy-consult-${consults}`, start: Date.now(), admission,
    });
  }) as typeof fetch;
  return { config, calls, workerBodies, consults: () => consults };
}

async function run(f: ReturnType<typeof fixture>, direct = false, collapsed = false) {
  const response = await handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST", headers: { "content-type": "application/json", ...(collapsed ? { "x-openai-subagent": "collab_spawn" } : {}) },
    body: JSON.stringify({ model: direct ? f.config.advisor!.model : "worker/m", input: [
      { role: "user", content: "fixture task" },
      { type: "function_call", name: "shell", call_id: "orientation", arguments: "{}" },
      { type: "function_call_output", call_id: "orientation", output: "fixture orientation" },
    ], stream: false }),
  }), f.config, { model: "", provider: "" }, { admission: caller, ...(direct ? { advisorInternal: true } : {}) });
  await response.text();
  return response.status;
}

for (const variant of ["combo", "nested", "collapsed", "native"] as const) {
  test(`laptop paid-combo refusal survives Advisor ${variant}`, async () => {
    const f = fixture("metered", variant);
    expect(await run(f)).toBe(200);
    expect(f.consults()).toBe(1);
    expect(f.calls.filter(call => call.startsWith("expert/"))).toEqual([]);
    expect(f.calls).toContain("worker/m");
    if (variant !== "nested") expect(f.workerBodies.join()).toContain("opencodex_advisor_unavailable");
  });
}
for (const variant of ["combo", "nested", "native"] as const) {
  test(`laptop device fallback refusal survives Advisor ${variant}`, async () => {
    const f = fixture("fallback", variant);
    expect(await run(f)).toBe(200);
    expect(f.consults()).toBe(1);
    expect(f.calls).toContain("expert/primary");
    expect(f.calls).not.toContain("backup/m");
    if (variant !== "nested") expect(f.workerBodies.join()).toContain("opencodex_advisor_unavailable");
  });
}

for (const kind of ["metered", "fallback"] as const) {
  test(`caller ${kind} policy is captured before asynchronous body parsing`, async () => {
    const f = fixture(kind, "combo");
    const pending = run(f);
    f.config.apiKeys![1]!.allowMeteredComboTargets = true;
    f.config.fallback = {};
    expect(await pending).toBe(200);
    expect(f.consults()).toBe(1);
    expect(f.calls).not.toContain(kind === "metered" ? "expert/m" : "backup/m");
  });
  test(`consenting laptop ${kind} control reaches the destination`, async () => {
    const f = fixture(kind, "combo", true);
    expect(await run(f)).toBe(200);
    expect(f.calls).toContain(kind === "metered" ? "expert/m" : "backup/m");
  });
}

for (const capability of [undefined, "1", "A".repeat(43)] as const) {
  test(`external forged policy has no effect with capability ${capability ?? "absent"}`, async () => {
    const f = fixture("metered", "combo", true);
    const response = await handleChatCompletions(new Request("http://localhost/v1/chat/completions", {
      method: "POST", headers: {
        "content-type": "application/json",
        "x-opencodex-advisor-admission-policy": "client-supplied-policy",
        ...(capability ? { [ADVISOR_INTERNAL_CAPABILITY_HEADER]: capability } : {}),
      }, body: JSON.stringify({ model: "expert/m", messages: [{ role: "user", content: "fixture" }] }),
    }), f.config, { model: "", provider: "" });
    await response.text();
    expect(response.status).toBe(200);
    expect(f.calls).toEqual(["expert/m"]);
  });
}

test("an authenticated internal hop with missing policy fails closed", async () => {
  const f = fixture("metered", "combo", true);
  const response = await handleChatCompletions(new Request("http://localhost/v1/chat/completions", {
    method: "POST", headers: {
      "content-type": "application/json",
      [ADVISOR_INTERNAL_CAPABILITY_HEADER]: internalCallCapability(),
    }, body: JSON.stringify({ model: "expert/m", messages: [{ role: "user", content: "fixture" }] }),
  }), f.config, { model: "", provider: "" });
  expect(response.status).toBe(403);
  expect(f.calls).toEqual([]);
});

test("a laptop without paid consent still receives advice from an unmetered combo target", async () => {
  const f = fixture("metered", "combo");
  f.config.combos!.inner!.targets.push({ provider: "free", model: "m" });
  f.config.fallback!.devices!.laptop!.provider = true;
  expect(await run(f)).toBe(200);
  expect(f.calls).not.toContain("expert/m");
  expect(f.calls).toContain("free/m");
  expect(f.workerBodies.join()).toContain("fixture advice");
});
