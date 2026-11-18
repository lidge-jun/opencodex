/**
 * #7894 round 3: which credential an internal self-fetch presents, and whose paid-combo consent
 * governs it, on the real listener (createServeOptions).
 *
 * Paid consent: on a public bind the secondary loopback listener admits the consult as loopback,
 * and loopback on a public proxy never consents to metered combo targets. A validated self-fetch
 * key is the operator's consent for that key, so a consenting caller and host key must reach a
 * metered target the combo opted into, exactly as a direct request with that key does. The
 * caller's consent and the combo opt-in still bind; an unkeyed loopback caller is still refused.
 *
 * Presented credential: a loopback bind can deliberately leave the installed service-token file
 * (a hub client key) out of this proxy's admission credentials. A destination that requires no
 * admission must not receive a credential this data plane does not recognize, or every
 * consultation and routed helper fails closed; a configured key it does recognize still binds.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activateAdvisor } from "../../src/lib/advisor-activation";
import { createServeOptions, type ServeOptionsContext } from "../../src/server/index/serve-options";
import { requestPolicyView } from "../../src/server/auth-cors";
import { tryAdmitTurn } from "../../src/server/lifecycle";
import { advisorBaseUrl } from "../../src/advisor/consult";
import { postLocalChatCompletion } from "../../src/lib/local-chat-completion";
import { registerAdvisorAdmissionPolicy, SIDECAR_ADMISSION_POLICY_HEADER, SIDECAR_INTERNAL_CAPABILITY_HEADER } from "../../src/server/advisor-admission-scope";
import { captureAdmissionPolicy } from "../../src/server/capture-admission-policy";
import { internalCallCapability } from "../../src/lib/local-internal-call-capability";
import { clearComboSelectionState, clearComboTargetCooldowns } from "../../src/combos";
import { collectSse } from "../helpers/responses-conformance";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import type { OcxApiKeyEntry, OcxConfig } from "../../src/types";

const originalFetch = globalThis.fetch;
const savedEnv = { token: process.env.OPENCODEX_API_AUTH_TOKEN, file: process.env.OCX_API_TOKEN_FILE };
let releaseSpendHome: (() => void) | undefined;
let scratch: string | undefined;
beforeEach(() => {
  delete process.env.OPENCODEX_API_AUTH_TOKEN;
  process.env.OCX_API_TOKEN_FILE = "missing-service-api-token-7894-r3";
  clearComboSelectionState();
  clearComboTargetCooldowns();
  releaseSpendHome = acquireOwnedSpendHome();
});
afterEach(() => {
  try { releaseSpendHome?.(); } finally {
    releaseSpendHome = undefined;
    globalThis.fetch = originalFetch;
    clearComboSelectionState();
    clearComboTargetCooldowns();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    scratch = undefined;
    if (savedEnv.token === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN; else process.env.OPENCODEX_API_AUTH_TOKEN = savedEnv.token;
    if (savedEnv.file === undefined) delete process.env.OCX_API_TOKEN_FILE; else process.env.OCX_API_TOKEN_FILE = savedEnv.file;
  }
});

const HOST_KEY = "ocx_data_" + "h".repeat(40);
const CALLER_KEY = "ocx_data_" + "c".repeat(40);
const HUB_CLIENT_KEY = "ocx_data_" + "f".repeat(40);
const ADVICE = "Sequence the fix: token store first.";
const advisorCall = [
  { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_adv_r3", type: "function",
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
const key = (id: string, secret: string, extra: Partial<OcxApiKeyEntry> = {}): OcxApiKeyEntry =>
  ({ id, name: id, key: secret, createdAt: "2026-01-01T00:00:00.000Z", ...extra });

interface Harness { config: OcxConfig; workerBodies: string[]; expertCalls: number }

function harness(config: Omit<OcxConfig, "providers" | "advisor"> & { advisorModel: string }): Harness {
  const h = { workerBodies: [] as string[], expertCalls: 0 } as Harness;
  let leg = 0;
  const { advisorModel, ...rest } = config;
  h.config = {
    port: 10100,
    ...rest,
    providers: {
      worker: { adapter: "openai-chat", baseUrl: "https://worker.test/v1", apiKey: "w", models: ["deepseek-v4"], liveModels: false,
        fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
          h.workerBodies.push(String(init?.body));
          return sse(leg++ === 0 ? advisorCall : plain);
        }) as typeof fetch },
      expert: { adapter: "openai-chat", baseUrl: "https://expert.test/v1", apiKey: "e", models: ["gpt-6-astra", "m"], liveModels: false,
        fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
          h.expertCalls += 1;
          return JSON.parse(String(init?.body)).stream
            ? sse([{ choices: [{ delta: { content: ADVICE }, finish_reason: null }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }])
            : completion(ADVICE);
        }) as typeof fetch },
    },
    advisor: { enabled: true, model: advisorModel, contextSharingConsent: "v1", effort: "high", policy: "manual" },
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

interface SelfFetch { status: number; presented: string | null }

/** Every self-fetch re-enters the real listener the destination resolver chose. */
function routeSelfFetch(config: OcxConfig, serve: ReturnType<typeof listener>, viaLoopbackListener: boolean): SelfFetch[] {
  const seen: SelfFetch[] = [];
  const expected = advisorBaseUrl(config) + "/v1/chat/completions";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) !== expected) throw new Error("unexpected fetch: " + String(input));
    const res = await serve.fetch(new Request(expected, init),
      (viaLoopbackListener ? loopbackServer : publicServer) as unknown as ServerArg);
    seen.push({ status: res.status, presented: new Headers(init?.headers).get("x-opencodex-api-key") });
    return res;
  }) as typeof fetch;
  return seen;
}

async function workerTurn(serve: ReturnType<typeof listener>, callerKey?: string) {
  const response = await serve.fetch(new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", "thread-id": "thread-r3-" + crypto.randomUUID(),
      ...(callerKey ? { "x-opencodex-api-key": callerKey } : {}) },
    body: JSON.stringify({ model: "worker/deepseek-v4", input: "Fix the failing auth tests", stream: true }),
  }), publicServer as unknown as ServerArg);
  expect(response.status).toBe(200);
  const frames = await collectSse(response.body!);
  expect(frames.some(frame => frame.event === "response.completed")).toBe(true);
}

describe("a validated self-fetch key's paid-combo consent on a public bind's loopback listener", () => {
  function meteredHarness(consent: { host: boolean; caller: boolean; comboOptIn: boolean }) {
    return harness({
      hostname: "0.0.0.0",
      unauthenticatedLoopbackListener: { enabled: true, port: 10200 },
      apiKeys: [
        key("host", HOST_KEY, { allowMeteredComboTargets: consent.host }),
        key("caller", CALLER_KEY, { allowMeteredComboTargets: consent.caller }),
      ],
      combos: { inner: { ...(consent.comboOptIn ? { allowMeteredTargets: true } : {}),
        targets: [{ provider: "expert", model: "m", metered: true }] } },
      advisorModel: "combo/inner",
    });
  }

  test("consenting caller, host key and combo reach the metered target", async () => {
    const h = meteredHarness({ host: true, caller: true, comboOptIn: true });
    const serve = listener(h.config);
    const seen = routeSelfFetch(h.config, serve, true);
    await workerTurn(serve, CALLER_KEY);
    expect(seen).toEqual([{ status: 200, presented: HOST_KEY }]);
    expect(h.expertCalls).toBe(1);
    expect(h.workerBodies[1]!).toContain(ADVICE);
  });

  for (const [label, consent] of [
    ["the host key", { host: false, caller: true, comboOptIn: true }],
    ["the caller", { host: true, caller: false, comboOptIn: true }],
    ["the combo", { host: true, caller: true, comboOptIn: false }],
  ] as const) {
    test("a refusal by " + label + " still keeps the consult off the metered target", async () => {
      const h = meteredHarness(consent);
      const serve = listener(h.config);
      const seen = routeSelfFetch(h.config, serve, true);
      await workerTurn(serve, CALLER_KEY);
      expect(seen.length).toBe(1);
      expect(seen[0]!.status).not.toBe(200);
      expect(h.expertCalls).toBe(0);
      expect(h.workerBodies[1]!).toContain("opencodex_advisor_unavailable");
    });
  }

  test("an unkeyed caller on the loopback listener is still refused the metered target", async () => {
    const h = meteredHarness({ host: true, caller: true, comboOptIn: true });
    const response = await listener(h.config).fetch(new Request("http://127.0.0.1:10200/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-opencodex-api-key": HOST_KEY },
      body: JSON.stringify({ model: "combo/inner", messages: [{ role: "user", content: "hi" }], stream: false }),
    }), loopbackServer as unknown as ServerArg);
    expect(response.status).not.toBe(200);
    expect(h.expertCalls).toBe(0);
  });
});

describe("the credential a loopback-bind self-fetch presents", () => {
  function installHubClientToken() {
    scratch = mkdtempSync(join(tmpdir(), "ocx-7894-r3-"));
    const file = join(scratch, "service-api-token");
    writeFileSync(file, HUB_CLIENT_KEY + "\n");
    process.env.OCX_API_TOKEN_FILE = file;
  }

  test("an installed hub client token this proxy does not admit is not presented to Advisor", async () => {
    installHubClientToken();
    const h = harness({ hostname: "127.0.0.1", advisorModel: "expert/gpt-6-astra" });
    const serve = listener(h.config);
    const seen = routeSelfFetch(h.config, serve, false);
    await workerTurn(serve);
    expect(seen).toEqual([{ status: 200, presented: null }]);
    expect(h.expertCalls).toBe(1);
    expect(h.workerBodies[1]!).toContain(ADVICE);
  });

  test("a recognized restricted key behind that token still binds the consult", async () => {
    installHubClientToken();
    const h = harness({ hostname: "127.0.0.1", advisorModel: "expert/gpt-6-astra",
      apiKeys: [key("host", HOST_KEY, { allowedProviders: ["worker"], allowedModels: ["worker/deepseek-v4"] })] });
    const serve = listener(h.config);
    const seen = routeSelfFetch(h.config, serve, false);
    await workerTurn(serve);
    expect(seen).toEqual([{ status: 403, presented: HOST_KEY }]);
    expect(h.expertCalls).toBe(0);
    expect(h.workerBodies[1]!).toContain("opencodex_advisor_unavailable");
  });

  test("a routed sidecar self-fetch does not present the unadmitted hub client token", async () => {
    installHubClientToken();
    const h = harness({ hostname: "127.0.0.1", advisorModel: "expert/gpt-6-astra" });
    const seen = routeSelfFetch(h.config, listener(h.config), false);
    const registration = registerAdvisorAdmissionPolicy(captureAdmissionPolicy(h.config));
    try {
      const outcome = await postLocalChatCompletion({
        config: h.config, label: "routed describe", logTag: "vision", timeoutMs: 10_000, maxResponseBytes: 64_000,
        headers: { [SIDECAR_ADMISSION_POLICY_HEADER]: registration.token, [SIDECAR_INTERNAL_CAPABILITY_HEADER]: internalCallCapability() },
        body: { model: "expert/gpt-6-astra", messages: [{ role: "user", content: "describe" }] },
      });
      expect(outcome).toEqual({ text: ADVICE });
      expect(seen).toEqual([{ status: 200, presented: null }]);
    } finally { registration.release(); }
  });
});
