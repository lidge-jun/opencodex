import { afterEach, beforeEach, expect, test } from "bun:test";
import { activateAdvisor } from "../../src/lib/advisor-activation";
import { handleResponses } from "../../src/server/responses/core";
import { handleChatCompletions } from "../../src/server/chat-completions";
import { resolveDataPlaneAdmissionSecret } from "../../src/server/auth-cors";
import { advisorBaseUrl, consultAdvisor } from "../../src/advisor/consult";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { clearComboSelectionState, clearComboTargetCooldowns } from "../../src/combos";
import { noteSubagentModelFailure, resetSubagentModelFallbackStateForTests } from "../../src/codex/subagent-model-fallback";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { setAdvisorPlanFactory } from "../../src/server/responses/advisor-plan-slot";
import { createAdvisorRuntimePlan } from "../../src/advisor/runtime";
import { ADVISOR_ADMISSION_POLICY_HEADER, readAdvisorAdmissionPolicy, registerAdvisorAdmissionPolicy } from "../../src/server/advisor-admission-scope";
import { ADVISOR_INTERNAL_CAPABILITY_HEADER, internalCallCapability } from "../../src/lib/local-internal-call-capability";
import { captureAdmissionPolicy, inheritAdmissionPolicy } from "../../src/server/capture-admission-policy";
import { parseRequest } from "../../src/responses/parser";
import { admissionMayUseMeteredComboTargets, admissionScopeDenial, resolveAdmissionModelScope, routeAllowedByScope } from "../../src/server/admission-model-scope";
import { nativeMessagesToolScopeDenial } from "../../src/server/messages-native-scope";

const originalFetch = globalThis.fetch;
const caller = { kind: "configured", keyId: "caller", source: "bearer" } as const;
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

type Variant = "combo" | "nested" | "collapsed";
function fixture(kind: "metered" | "fallback", variant: Variant, consent = false) {
  const calls: string[] = [];
  let consults = 0;
  let token: string | null = null;
  const provider = (id: string): OcxProviderConfig => ({
    adapter: "openai-chat", apiKey: "fixture-key", baseUrl: `https://${id}.test/v1`,
    models: ["m", "primary", "backup"], liveModels: false, reasoningEfforts: ["low", "high"],
    fetch: (async (_input, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.has(ADVISOR_ADMISSION_POLICY_HEADER)).toBe(false);
      expect(headers.has(ADVISOR_INTERNAL_CAPABILITY_HEADER)).toBe(false);
      const model = JSON.parse(String(init?.body)).model;
      calls.push(`${id}/${model}`);
      if (id === "expert" && model === "primary") {
        return Response.json({ error: { message: "fixture unavailable model", code: "model_not_found" } }, { status: 404 });
      }
      return answer(init, variant === "nested" && id === "expert" ? '{"choice":"free/m:high"}' : "fixture advice");
    }) as typeof fetch,
  });
  const config: OcxConfig = {
    port: 10100, defaultProvider: "worker",
    providers: { worker: provider("worker"), expert: provider("expert"), free: provider("free"), primary: provider("primary") },
    apiKeys: [
      { id: "host", name: "host", key: "ocx_data_" + "h".repeat(40), createdAt: "2026-01-01", allowMeteredComboTargets: true },
      { id: "caller", name: "caller", key: "ocx_data_" + "c".repeat(40), createdAt: "2026-01-01", allowMeteredComboTargets: consent },
    ],
    fallback: { devices: { caller: { model: consent, provider: consent } } },
    combos: { inner: { targets: kind === "metered"
      ? [{ provider: "expert", model: "m", metered: true }]
      : [{ provider: "expert", model: "primary" }, { provider: "expert", model: "backup" }] } },
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
    token = headers.get(ADVISOR_ADMISSION_POLICY_HEADER);
    expect(readAdvisorAdmissionPolicy(token, null)).toBeUndefined();
    expect(readAdvisorAdmissionPolicy(token, "A".repeat(43))).toBeUndefined();
    expect(readAdvisorAdmissionPolicy(token, internalCallCapability())).toBeDefined();
    if (variant === "collapsed") headers.set("x-openai-subagent", "collab_spawn");
    const admission = resolveDataPlaneAdmissionSecret(headers.get("x-opencodex-api-key")!, config, "x-api-key")!;
    return handleChatCompletions(new Request(String(input), { ...init, headers }), config, { model: "", provider: "" }, {
      requestId: `policy-consult-${consults}`, start: Date.now(), admission,
    });
  }) as typeof fetch;
  return { config, calls, consults: () => consults, token: () => token };
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
  if (!direct) {
    expect(f.token()).toBeTruthy();
    expect(readAdvisorAdmissionPolicy(f.token(), internalCallCapability())).toBeUndefined();
  }
  return response.status;
}

for (const variant of ["combo", "nested", "collapsed"] as const) {
  test(`caller without paid opt-in: ${variant} makes zero metered sends`, async () => {
    const f = fixture("metered", variant);
    expect(await run(f)).toBe(200);
    expect(f.consults()).toBe(1);
    expect(f.calls.filter(call => call.startsWith("expert/"))).toEqual([]);
    expect(f.calls).toContain("worker/m");
  });
}
for (const variant of ["combo", "nested"] as const) {
  test(`caller fallback disabled: ${variant} makes zero backup sends`, async () => {
    const f = fixture("fallback", variant);
    expect(await run(f)).toBe(200);
    expect(f.consults()).toBe(1);
    expect(f.calls).toContain("expert/primary");
    expect(f.calls).not.toContain("expert/backup");
  });
}
for (const kind of ["metered", "fallback"] as const) {
  test(`direct caller ${kind} control refuses the same destination`, async () => {
    const f = fixture(kind, "combo");
    expect(await run(f, true)).toBeGreaterThanOrEqual(400);
    expect(f.consults()).toBe(0);
    expect(f.calls).not.toContain(kind === "metered" ? "expert/m" : "expert/backup");
  });
  for (const variant of ["combo", "nested", ...(kind === "metered" ? ["collapsed" as const] : [])] as const) {
    test(`consenting caller ${kind} ${variant} control reaches the destination`, async () => {
      const f = fixture(kind, variant, true);
      expect(await run(f)).toBe(200);
      expect(f.consults()).toBe(1);
      expect(f.calls).toContain(kind === "metered" ? "expert/m" : "expert/backup");
    });
  }
  for (const mutation of ["broadened", "deleted"] as const) {
    test(`captured caller ${kind} limits survive ${mutation} live config`, async () => {
      const f = fixture(kind, "combo");
      setAdvisorPlanFactory(f.config, async input => {
        if (mutation === "deleted") f.config.apiKeys = f.config.apiKeys!.filter(key => key.id !== "caller");
        else f.config.apiKeys![1]!.allowMeteredComboTargets = true;
        f.config.fallback = {};
        expect(Object.isFrozen(input.admissionPolicy)).toBe(true);
        expect(Object.isFrozen(input.admissionPolicy!.fallbackPolicies[0]!.config.fallback!.devices!.caller)).toBe(true);
        return createAdvisorRuntimePlan(input);
      });
      expect(await run(f)).toBe(200);
      expect(f.consults()).toBe(1);
      expect(f.calls).not.toContain(kind === "metered" ? "expert/m" : "expert/backup");
    });
  }
  test(`host ${kind} limits also apply to a consenting caller`, async () => {
    const f = fixture(kind, "combo", true);
    if (kind === "metered") f.config.apiKeys![0]!.allowMeteredComboTargets = false;
    else f.config.fallback!.devices!.host = { model: false };
    expect(await run(f)).toBe(200);
    expect(f.consults()).toBe(1);
    expect(f.calls).not.toContain(kind === "metered" ? "expert/m" : "expert/backup");
  });
}

test("a made-up snapshot token with the process capability fails closed", async () => {
  const f = fixture("metered", "combo", true);
  const response = await handleChatCompletions(new Request("http://localhost/v1/chat/completions", {
    method: "POST", headers: {
      "content-type": "application/json",
      [ADVISOR_INTERNAL_CAPABILITY_HEADER]: internalCallCapability(),
      [ADVISOR_ADMISSION_POLICY_HEADER]: "A".repeat(43),
    }, body: JSON.stringify({ model: "expert/m", messages: [{ role: "user", content: "fixture" }] }),
  }), f.config, { model: "", provider: "" });
  expect(response.status).toBe(403);
  expect(f.calls).toEqual([]);
});

test("a live snapshot token without the process capability grants no policy authority", async () => {
  const f = fixture("metered", "combo", true);
  const registration = registerAdvisorAdmissionPolicy(captureAdmissionPolicy(f.config, caller, { providers: ["worker"], models: [] }));
  try {
    const response = await handleChatCompletions(new Request("http://localhost/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json", [ADVISOR_ADMISSION_POLICY_HEADER]: registration.token },
      body: JSON.stringify({ model: "expert/m", messages: [{ role: "user", content: "fixture" }] }),
    }), f.config, { model: "", provider: "" });
    await response.text();
    expect(response.status).toBe(200);
    expect(f.calls).toEqual(["expert/m"]);
  } finally { registration.release(); }
});

for (const failure of ["network", "cancelled"] as const) {
  test(`the policy registry releases a ${failure} consultation`, async () => {
    let token: string | null = null;
    const controller = new AbortController();
    globalThis.fetch = (async (_input, init) => {
      token = new Headers(init?.headers).get(ADVISOR_ADMISSION_POLICY_HEADER);
      expect(readAdvisorAdmissionPolicy(token, internalCallCapability())).toBeDefined();
      if (failure === "cancelled") controller.abort();
      throw new Error("fixture connection failure");
    }) as typeof fetch;
    const outcome = await consultAdvisor({
      parsed: parseRequest({ model: "worker/m", input: "fixture" }),
      workerIdentity: "worker/m", advisorModel: "expert/m", reason: "manual",
    }, {}, "high", 5_000, controller.signal, "http://localhost");
    expect(outcome.ok).toBe(false);
    if (failure === "cancelled") expect(outcome.cancelled).toBe(true);
    expect(token).toBeTruthy();
    expect(readAdvisorAdmissionPolicy(token, internalCallCapability())).toBeUndefined();
  });
}

test("scope intersection preserves qualified models and unnamed-destination refusals", () => {
  const f = fixture("metered", "combo", true);
  f.config.apiKeys![0]!.allowedProviders = ["expert"];
  f.config.apiKeys![0]!.allowedModels = ["m"];
  const policy = captureAdmissionPolicy(f.config, caller, { providers: [], models: ["free/m"] });
  const inherited = inheritAdmissionPolicy({ kind: "configured", keyId: "host", source: "bearer" }, policy);
  const scope = resolveAdmissionModelScope(f.config, inherited);
  expect(routeAllowedByScope(scope, { providerName: "expert", modelId: "m" })).toBe(false);
  expect(routeAllowedByScope(scope, { providerName: "free", modelId: "m" })).toBe(false);
  expect(nativeMessagesToolScopeDenial(scope, "expert", "expert/m", {
    tools: [{ type: "advisor_20260101", name: "advisor", model: "m" }],
  })).toBeDefined();
  expect(admissionScopeDenial(f.config, inherited, undefined, { providerName: "expert", modelId: undefined })?.status).toBe(403);
  f.config.apiKeys![0]!.allowedModels = [];
  expect(admissionScopeDenial(f.config, inherited, undefined, { providerName: "expert", modelId: undefined })?.status).toBe(403);
});

test("registry owns an immutable copy and releases only its consultation", () => {
  const policy = { ...structuredClone(captureAdmissionPolicy({}, undefined)) };
  const controller = new AbortController();
  const first = registerAdvisorAdmissionPolicy(policy, controller.signal);
  const second = registerAdvisorAdmissionPolicy(policy);
  try {
    policy.allowMeteredComboTargets = false;
    const captured = readAdvisorAdmissionPolicy(first.token, internalCallCapability())!;
    expect(captured.allowMeteredComboTargets).toBe(true);
    expect(Object.isFrozen(captured)).toBe(true);
    expect(Object.isFrozen(captured.fallbackPolicies)).toBe(true);
    expect(first.token).not.toBe(second.token);
    controller.abort();
    expect(readAdvisorAdmissionPolicy(first.token, internalCallCapability())).toBeUndefined();
    expect(readAdvisorAdmissionPolicy(second.token, internalCallCapability())).toBeDefined();
    first.release();
    expect(readAdvisorAdmissionPolicy(second.token, internalCallCapability())).toBeDefined();
  } finally { first.release(); second.release(); }
  expect(readAdvisorAdmissionPolicy(second.token, internalCallCapability())).toBeUndefined();
});

test("registry revokes an aborted consultation before fetch settles", async () => {
  const controller = new AbortController();
  let token: string | null = null;
  let finish!: (response: Response) => void;
  globalThis.fetch = (async (_input, init) => {
    token = new Headers(init?.headers).get(ADVISOR_ADMISSION_POLICY_HEADER);
    return await new Promise<Response>(resolve => { finish = resolve; });
  }) as typeof fetch;
  const pending = consultAdvisor({
    parsed: parseRequest({ model: "worker/m", input: "fixture" }),
    workerIdentity: "worker/m", advisorModel: "expert/m", reason: "manual",
  }, {}, "high", 5_000, controller.signal, "http://localhost");
  expect(readAdvisorAdmissionPolicy(token, internalCallCapability())).toBeDefined();
  controller.abort();
  expect(readAdvisorAdmissionPolicy(token, internalCallCapability())).toBeUndefined();
  finish(Response.json({ error: "fixture" }, { status: 503 }));
  expect((await pending).ok).toBe(false);
});

test("unkeyed caller combo opt-in remains required behind a consenting host key", () => {
  const f = fixture("metered", "combo", true);
  const policy = captureAdmissionPolicy({}, { kind: "loopback", source: "loopback" });
  const inherited = inheritAdmissionPolicy({ kind: "configured", keyId: "host", source: "bearer" }, policy);
  expect(admissionMayUseMeteredComboTargets(f.config, inherited, {})).toBe(false);
  expect(admissionMayUseMeteredComboTargets(f.config, inherited, { allowMeteredTargets: false })).toBe(false);
  expect(admissionMayUseMeteredComboTargets(f.config, inherited, { allowMeteredTargets: true })).toBe(true);
  f.config.apiKeys![0]!.allowMeteredComboTargets = false;
  expect(admissionMayUseMeteredComboTargets(f.config, inherited, { allowMeteredTargets: true })).toBe(false);
});

test("a live permissive policy token cannot grant an external caller paid consent", async () => {
  const f = fixture("metered", "combo");
  const registration = registerAdvisorAdmissionPolicy(captureAdmissionPolicy({}, undefined));
  try {
    const response = await handleChatCompletions(new Request("http://localhost/v1/chat/completions", {
      method: "POST", headers: {
        "content-type": "application/json",
        [ADVISOR_INTERNAL_CAPABILITY_HEADER]: "A".repeat(43),
        [ADVISOR_ADMISSION_POLICY_HEADER]: registration.token,
      }, body: JSON.stringify({ model: "combo/inner", messages: [{ role: "user", content: "fixture" }] }),
    }), f.config, { model: "", provider: "" }, { requestId: "forged-paid-policy", start: Date.now(), admission: caller });
    await response.text();
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(f.calls).toEqual([]);
  } finally { registration.release(); }
});
