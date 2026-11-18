/**
 * #7894: Advisor's self-fetch credential carries host policy of its own.
 *
 * A loopback listener admits every request before reading a token, so the host snapshot taken at
 * authentication says "loopback" even when the consult presents a configured key. That key's model
 * scope, paid-combo consent and device fallback identity must still bind the consultation;
 * otherwise a caller allowed onto a model gets an Advisor consult the host key forbids. Each case
 * drives the real listener (createServeOptions) on both loopback ingress shapes.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { activateAdvisor } from "../../src/lib/advisor-activation";
import { createServeOptions, type ServeOptionsContext } from "../../src/server/index/serve-options";
import { requestPolicyView } from "../../src/server/auth-cors";
import { tryAdmitTurn } from "../../src/server/lifecycle";
import { advisorBaseUrl } from "../../src/advisor/consult";
import { handleChatCompletions } from "../../src/server/chat-completions";
import { registerAdvisorAdmissionPolicy, ADVISOR_ADMISSION_POLICY_HEADER } from "../../src/server/advisor-admission-scope";
import { captureAdmissionPolicy, captureSelfFetchCredentialPolicy, intersectAdmissionPolicies } from "../../src/server/capture-admission-policy";
import { ADVISOR_INTERNAL_CAPABILITY_HEADER, internalCallCapability } from "../../src/lib/local-internal-call-capability";
import { MODEL_NOT_ALLOWED_FOR_KEY } from "../../src/server/admission-model-scope";
import { collectSse } from "../helpers/responses-conformance";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import type { OcxConfig } from "../../src/types";

const originalFetch = globalThis.fetch;
const savedEnv = { token: process.env.OPENCODEX_API_AUTH_TOKEN, file: process.env.OCX_API_TOKEN_FILE };
let releaseSpendHome: (() => void) | undefined;
beforeEach(() => {
  // Make localAdmissionToken select the first configured key: no env token, no service file.
  delete process.env.OPENCODEX_API_AUTH_TOKEN;
  process.env.OCX_API_TOKEN_FILE = "missing-service-api-token-7894";
});
afterEach(() => {
  try { releaseSpendHome?.(); } finally {
    releaseSpendHome = undefined;
    globalThis.fetch = originalFetch;
    if (savedEnv.token === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN; else process.env.OPENCODEX_API_AUTH_TOKEN = savedEnv.token;
    if (savedEnv.file === undefined) delete process.env.OCX_API_TOKEN_FILE; else process.env.OCX_API_TOKEN_FILE = savedEnv.file;
  }
});

const HOST_KEY = "ocx_data_" + "h".repeat(40);
const CALLER_KEY = "ocx_data_" + "c".repeat(40);
const ADVICE = "Sequence the fix: token store first.";
const advisorCall = [
  { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_adv_host", type: "function",
    function: { name: "advisor", arguments: JSON.stringify({ question: "Where do I start?" }) } }] }, finish_reason: null }] },
  { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
];
const plain = [
  { choices: [{ delta: { content: "Continuing." }, finish_reason: null }] },
  { choices: [{ delta: {}, finish_reason: "stop" }] },
];
const sse = (frames: unknown[]) => new Response(
  frames.map(frame => "data: " + JSON.stringify(frame)).join("\n\n") + "\n\ndata: [DONE]\n\n",
  { headers: { "content-type": "text/event-stream" } });
const completion = (content: string) => Response.json({
  choices: [{ message: { content }, finish_reason: "stop" }],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
});

type Ingress = "primary" | "secondary";
interface Harness { config: OcxConfig; workerBodies: string[]; expertCalls: number }

function harness(ingress: Ingress, hostAllowsExpert: boolean): Harness {
  const h = { workerBodies: [] as string[], expertCalls: 0 } as Harness;
  let leg = 0;
  h.config = {
    port: 10100,
    hostname: ingress === "primary" ? "127.0.0.1" : "0.0.0.0",
    ...(ingress === "secondary" ? { unauthenticatedLoopbackListener: { enabled: true, port: 10200 } } : {}),
    providers: {
      worker: { adapter: "openai-chat", baseUrl: "https://worker.test/v1", apiKey: "w", models: ["deepseek-v4"], liveModels: false,
        fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
          h.workerBodies.push(String(init?.body));
          return sse(leg++ === 0 ? advisorCall : plain);
        }) as typeof fetch },
      expert: { adapter: "openai-chat", baseUrl: "https://expert.test/v1", apiKey: "e", models: ["gpt-6-astra"], liveModels: false,
        fetch: (async () => { h.expertCalls += 1; return completion(ADVICE); }) as typeof fetch },
    },
    advisor: { enabled: true, model: "expert/gpt-6-astra", contextSharingConsent: "v1", effort: "high", policy: "manual" },
    apiKeys: [
      // First configured key: the credential localAdmissionToken selects for the consult.
      { id: "host", name: "host", key: HOST_KEY, createdAt: "2026-01-01T00:00:00.000Z",
        ...(hostAllowsExpert ? {} : { allowedProviders: ["worker"], allowedModels: ["worker/deepseek-v4"] }) },
      { id: "caller", name: "caller", key: CALLER_KEY, createdAt: "2026-01-01T00:00:00.000Z",
        allowedProviders: ["worker", "expert"], allowedModels: ["worker/deepseek-v4", "expert/gpt-6-astra"] },
    ],
  } as OcxConfig;
  activateAdvisor(h.config);
  return h;
}

const publicServer = { timeout() {} };
const loopbackServer = { timeout() {} };
type ServerArg = Parameters<ReturnType<typeof createServeOptions>["fetch"]>[1];

function listener(config: OcxConfig) {
  const runAdmittedHttpTurn: ServeOptionsContext["runAdmittedHttpTurn"] = (req, _policy, work) => {
    const lease = tryAdmitTurn(undefined, req.signal)!;
    return work(lease).finally(() => { if (!lease.isTransferred()) lease.release(); });
  };
  return createServeOptions({
    config, deps: {}, runAdmittedHttpTurn,
    ingressForServer: (server: unknown) => server === loopbackServer ? "unauthenticated-loopback" : "public",
    loopbackPolicy: () => requestPolicyView(config, "127.0.0.1"),
    loopbackRouteAllowed: () => true,
    packageTreeIntegrity: { status: () => ({ ok: true }) },
  } as unknown as ServeOptionsContext);
}

/** Every Advisor self-fetch re-enters the real listener the destination resolver chose. */
function routeSelfFetch(h: Harness, serve: ReturnType<typeof listener>, ingress: Ingress, consults: number[]) {
  const expected = advisorBaseUrl(h.config) + "/v1/chat/completions";
  expect(expected).toBe(ingress === "primary" ? "http://127.0.0.1:10100/v1/chat/completions" : "http://127.0.0.1:10200/v1/chat/completions");
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) !== expected) throw new Error("unexpected fetch: " + String(input));
    const res = await serve.fetch(new Request(expected, init),
      (ingress === "primary" ? publicServer : loopbackServer) as unknown as ServerArg);
    consults.push(res.status);
    return res;
  }) as typeof fetch;
}

async function runCallerTurn(ingress: Ingress, hostAllowsExpert: boolean) {
  releaseSpendHome = acquireOwnedSpendHome();
  const h = harness(ingress, hostAllowsExpert);
  const serve = listener(h.config);
  const consults: number[] = [];
  routeSelfFetch(h, serve, ingress, consults);
  // Primary loopback bind: every caller is loopback-admitted. Secondary: a remote caller presents
  // its own key on the authenticated public listener, and that key may reach the expert model.
  const response = await serve.fetch(new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", "thread-id": "thread-host-key-" + ingress,
      ...(ingress === "secondary" ? { "x-opencodex-api-key": CALLER_KEY } : {}) },
    body: JSON.stringify({ model: "worker/deepseek-v4", input: "Fix the failing auth tests", stream: true }),
  }), publicServer as unknown as ServerArg);
  expect(response.status).toBe(200);
  const frames = await collectSse(response.body!);
  expect(frames.some(frame => frame.event === "response.completed")).toBe(true);
  return { h, consults };
}

describe("Advisor self-fetch credential host policy on the real listener (#7894)", () => {
  for (const ingress of ["primary", "secondary"] as const) {
    test(ingress + " loopback ingress: a host key that forbids the Advisor model fails the consult closed", async () => {
      const { h, consults } = await runCallerTurn(ingress, false);
      expect(consults).toEqual([403]);
      expect(h.expertCalls).toBe(0);
      // The worker continuation receives the existing unavailable notice, never advice.
      expect(h.workerBodies.length).toBeGreaterThanOrEqual(2);
      expect(h.workerBodies[1]!).toContain("opencodex_advisor_unavailable");
      expect(h.workerBodies[1]!).not.toContain(ADVICE);
    });

    test(ingress + " loopback ingress: a host key that allows the Advisor model still consults", async () => {
      const { h, consults } = await runCallerTurn(ingress, true);
      expect(consults).toEqual([200]);
      expect(h.expertCalls).toBe(1);
      expect(h.workerBodies[1]!).toContain(ADVICE);
    });
  }

  test("an ordinary loopback caller presenting the restricted host key keeps loopback admission", async () => {
    releaseSpendHome = acquireOwnedSpendHome();
    const h = harness("secondary", false);
    const response = await listener(h.config).fetch(new Request("http://127.0.0.1:10200/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-opencodex-api-key": HOST_KEY },
      body: JSON.stringify({ model: "expert/gpt-6-astra", messages: [{ role: "user", content: "hi" }], stream: false }),
    }), loopbackServer as unknown as ServerArg);
    expect(response.status).toBe(200);
    expect(h.expertCalls).toBe(1);
  });

  test("an internal self-fetch presenting a credential the data plane does not know is refused", async () => {
    releaseSpendHome = acquireOwnedSpendHome();
    const h = harness("primary", true);
    const registration = registerAdvisorAdmissionPolicy(captureAdmissionPolicy(h.config));
    try {
      const response = await handleChatCompletions(new Request("http://127.0.0.1:10100/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", "x-opencodex-api-key": "ocx_data_" + "u".repeat(40),
          [ADVISOR_INTERNAL_CAPABILITY_HEADER]: internalCallCapability(),
          [ADVISOR_ADMISSION_POLICY_HEADER]: registration.token },
        body: JSON.stringify({ model: "expert/gpt-6-astra", messages: [{ role: "user", content: "hi" }], stream: false }),
      }), h.config, { model: "", provider: "" }, {
        requestId: "host-key-unknown", start: Date.now(), admission: { kind: "loopback", source: "loopback" },
      });
      expect(response.status).toBe(403);
      expect((await response.json() as { error?: { code?: string } }).error?.code).toBe(MODEL_NOT_ALLOWED_FOR_KEY);
      expect(h.expertCalls).toBe(0);
    } finally { registration.release(); }
  });

  test("the self-fetch key's paid-combo consent and device fallback identity bind the consult", () => {
    const h = harness("primary", true);
    h.config.apiKeys![0]!.allowMeteredComboTargets = false;
    h.config.apiKeys![1]!.allowMeteredComboTargets = true;
    h.config.fallback = { devices: { host: { provider: false } } };
    const presented = captureSelfFetchCredentialPolicy(new Request("http://127.0.0.1:10100/v1/chat/completions", {
      headers: { "x-opencodex-api-key": HOST_KEY },
    }), h.config)!;
    // The loopback listener alone would grant paid targets on opt-in and name no device.
    const listenerOnly = captureAdmissionPolicy(h.config, { kind: "loopback", source: "loopback" });
    expect(listenerOnly.allowMeteredComboTargets).toBe(true);
    const merged = intersectAdmissionPolicies(listenerOnly, presented);
    expect(merged.allowMeteredComboTargets).toBe(false);
    expect(merged.fallbackPolicies.flatMap(policy => policy.deviceIds)).toEqual(["host"]);
  });
});
