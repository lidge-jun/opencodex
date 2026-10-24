import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCommandCodeAdapter } from "../../src/adapters/command-code";
import { formatErrorResponse } from "../../src/bridge";
import { runWithImageBridge } from "../../src/images/loop";
import type { ImageBridgePlan } from "../../src/images/types";
import { runWithWebSearch } from "../../src/web-search/loop";
import type { ProviderAdapter } from "../../src/adapters/base";
import { createTestTranslatorBudget } from "../helpers/translator-budget";
import { isVerifiedModelNotInPlanResponse, MODEL_NOT_IN_PLAN_CODE } from "../../src/lib/errors";
import { clearComboSelectionState, clearComboTargetCooldowns } from "../../src/combos";
import { clearGenericFailoverHealth } from "../../src/oauth/generic-account-failover";
import { getAccountSet, saveCredential, setActiveAccount } from "../../src/oauth/store";
import { resetCommandCodeReasoningEffortsForTest } from "../../src/providers/command-code-efforts";
import { clearKeyCooldowns } from "../../src/providers/key-failover";
import { closeRequestHistoryIndex } from "../../src/routing/history/indexer";
import { handleChatCompletions } from "../../src/server/chat-completions";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import { handleResponses } from "../../src/server/responses";
import { clearComboRecallForTests } from "../../src/server/responses/combo-session-recall";
import type { OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// Combo and policy routes each make two loopback-free sends; suite load can push past 5s.
setDefaultTimeout(30_000);

const GENERATE_URL = "https://api.commandcode.ai/alpha/generate";
const REFUSED_MODEL = "google/gemini-4-argon";
const SERVED_MODEL = "deepseek/deepseek-v4-flash";
// Synthetic canaries: none of these may reach a client body or a log line. The key canary is
// unlabelled on purpose -- secret redaction does not recognize it, so only dropping the upstream
// detail keeps it out.
const ACCOUNT_CANARY = "acct_canary_7f3e91";
const KEY_CANARY = "plain-key-canary-7f3e91";
const MISLEADING_DETAIL = "Fixture Argon available in Pro and above plans (account " + ACCOUNT_CANARY
  + ", key " + KEY_CANARY + ", unsupported reasoning effort, quota exhausted)";
const COMPLETED = [
  JSON.stringify({ type: "text-delta", text: "OK" }),
  JSON.stringify({ type: "finish", finishReason: "stop" }),
].join("\n") + "\n";

function planRefusalBody(message = "MODEL_NOT_IN_PLAN: " + MISLEADING_DETAIL) {
  return { success: false, error: { code: "FORBIDDEN", status: 403, message } };
}

function planRefusal(): Response {
  return Response.json(planRefusalBody(), { status: 403 });
}

function expectNoCanary(text: string) {
  for (const canary of [ACCOUNT_CANARY, KEY_CANARY, "unsupported reasoning effort", "quota exhausted"]) {
    expect(text).not.toContain(canary);
  }
}

describe("Command Code MODEL_NOT_IN_PLAN refusal at the adapter", () => {
  afterEach(() => resetCommandCodeReasoningEffortsForTest());

  function parsed(modelId = REFUSED_MODEL, reasoning?: string): OcxParsedRequest {
    return {
      modelId,
      stream: true,
      context: { systemPrompt: [], messages: [{ role: "user", content: "hello", timestamp: 1 }], tools: [] },
      options: { ...(reasoning ? { reasoning } : {}), maxOutputTokens: 100 },
    };
  }

  function adapterWith(fetch: typeof globalThis.fetch, authMode: OcxProviderConfig["authMode"] = "oauth") {
    return createCommandCodeAdapter({
      adapter: "command-code", baseUrl: "https://api.commandcode.ai", authMode, apiKey: "synthetic-credential", fetch,
    } as OcxProviderConfig & { fetch: typeof globalThis.fetch });
  }

  test("answers the exact refusal once as a non-retryable 400 on every auth mode", async () => {
    for (const authMode of ["oauth", "key", "forward"] as const) {
      let calls = 0;
      const adapter = adapterWith((async () => { calls += 1; return planRefusal(); }) as typeof globalThis.fetch, authMode);
      const response = await adapter.fetchResponse(await adapter.buildRequest(parsed()));
      const text = await response.text();

      expect(calls).toBe(1);
      expect(response.status).toBe(400);
      expect(response.headers.get("x-opencodex-refusal")).toBe("model-not-in-plan");
      expect(response.headers.get("x-opencodex-upstream-status")).toBe("403");
      // The whole body, so no upstream detail can ride along outside the canaries.
      expect(JSON.parse(text)).toEqual({ error: {
        type: "invalid_request_error",
        code: "model_not_in_plan",
        message: "Command Code refused the model \"" + REFUSED_MODEL + "\": this account's plan does not include it (MODEL_NOT_IN_PLAN). "
          + "Choose a model the plan includes or change the Command Code plan; retrying this request will not succeed.",
      } });
      expectNoCanary(text);
    }
  });

  test("leaves every other 403 and every lookalike untouched", async () => {
    const fixtures: Array<{ status: number; body: unknown }> = [
      { status: 403, body: { success: false, error: { code: "FORBIDDEN", message: "Access denied" } } },
      { status: 403, body: planRefusalBody("MODEL_NOT_IN_PLAN_OTHER: something else") },
      { status: 403, body: planRefusalBody("model_not_in_plan: lower case") },
      { status: 403, body: planRefusalBody("Note: MODEL_NOT_IN_PLAN appears later") },
      { status: 403, body: { success: true, error: planRefusalBody().error } },
      { status: 403, body: { success: false, error: { ...planRefusalBody().error, code: "BAD_REQUEST" } } },
      { status: 401, body: planRefusalBody() },
      { status: 404, body: planRefusalBody() },
    ];
    for (const fixture of fixtures) {
      let calls = 0;
      const adapter = adapterWith((async () => {
        calls += 1;
        return Response.json(fixture.body, { status: fixture.status });
      }) as typeof globalThis.fetch);
      const response = await adapter.fetchResponse(await adapter.buildRequest(parsed()));

      expect(calls).toBe(1);
      expect(response.status).toBe(fixture.status);
      expect(response.headers.get("x-opencodex-refusal")).toBeNull();
      expect(await response.json()).toEqual(fixture.body);
    }
  });

  test("fails open for malformed, oversized and invalid UTF-8 bodies", async () => {
    const prefix = new TextEncoder().encode('{"success":false,"error":{"code":"FORBIDDEN","message":"MODEL_NOT_IN_PLAN: x');
    const suffix = new TextEncoder().encode('"}}');
    const invalidUtf8 = new Uint8Array(prefix.length + 1 + suffix.length);
    invalidUtf8.set(prefix);
    invalidUtf8[prefix.length] = 0x80;
    invalidUtf8.set(suffix, prefix.length + 1);
    const fixtures = [
      new Response("{not json", { status: 403 }),
      new Response(JSON.stringify({ ...planRefusalBody(), pad: "x".repeat(9_000) }), { status: 403 }),
      new Response(invalidUtf8, { status: 403 }),
    ];
    for (const fixture of fixtures) {
      const adapter = adapterWith((async () => fixture.clone()) as typeof globalThis.fetch);
      const response = await adapter.fetchResponse(await adapter.buildRequest(parsed()));

      expect(response.status).toBe(403);
      expect(response.headers.get("x-opencodex-refusal")).toBeNull();
    }
  });

  test("re-throws the caller abort reason instead of failing open", async () => {
    const controller = new AbortController();
    const reason = new Error("caller cancelled");
    const adapter = adapterWith((async () => {
      controller.abort(reason);
      return planRefusal();
    }) as typeof globalThis.fetch);
    await expect(adapter.fetchResponse(await adapter.buildRequest(parsed()), { abortSignal: controller.signal }))
      .rejects.toBe(reason);
  });

  test("a refusal whose detail mentions reasoning effort never starts the effort repair", async () => {
    let calls = 0;
    const adapter = adapterWith((async () => { calls += 1; return planRefusal(); }) as typeof globalThis.fetch);
    const response = await adapter.fetchResponse(await adapter.buildRequest(parsed("moonshotai/Kimi-K3", "max")));

    expect(calls).toBe(1);
    expect(response.status).toBe(400);
    expect(response.headers.get("x-opencodex-refusal")).toBe("model-not-in-plan");
  });

  test("normalizes the refusal that answers a genuine effort-repair send", async () => {
    let calls = 0;
    const adapter = adapterWith((async () => {
      calls += 1;
      return calls === 1
        ? new Response(JSON.stringify({ error: "unsupported reasoning_effort" }), { status: 400 })
        : planRefusal();
    }) as typeof globalThis.fetch);
    const response = await adapter.fetchResponse(await adapter.buildRequest(parsed("moonshotai/Kimi-K3", "max")));

    expect(calls).toBe(2);
    expect(response.status).toBe(400);
    expect(response.headers.get("x-opencodex-refusal")).toBe("model-not-in-plan");
    expect((await response.json()).error.code).toBe("model_not_in_plan");
  });
});

describe("plan-refusal provenance at the shared formatter", () => {
  test("a caller-supplied code keeps the wire code but never mints provenance", () => {
    // run-turn combo children pass an adapter event's own code here with `classified: true`;
    // an adapter other than Command Code can emit this code, so the formatter must not vouch for it.
    for (const classified of [false, true]) {
      const response = formatErrorResponse(400, "invalid_request_error", "fixture", { code: MODEL_NOT_IN_PLAN_CODE, classified });
      expect(isVerifiedModelNotInPlanResponse(response), "classified=" + classified).toBe(false);
    }
  });
});

describe("plan refusal through the sidecar loops", () => {
  const guardedFetch = globalThis.fetch;
  // Nothing in these loop tests may reach a network: the routed send is injected below.
  beforeEach(() => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      throw new Error("unexpected network request: " + (input instanceof Request ? input.url : String(input)));
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = guardedFetch;
    laterRefusal = async () => planRefusal();
    resetCommandCodeReasoningEffortsForTest();
  });
  // Each test may swap the routed answer; the default is an immediate refusal.
  let laterRefusal: () => Promise<Response> = async () => planRefusal();
  const routedSend = (async () => laterRefusal()) as unknown as typeof globalThis.fetch;

  const loopParsed = (): OcxParsedRequest => ({
    modelId: REFUSED_MODEL, stream: true, options: { maxOutputTokens: 64 },
    context: { systemPrompt: [], messages: [{ role: "user", content: "hello", timestamp: 1 }], tools: [] },
  });
  const commandCode = () => createCommandCodeAdapter({
    adapter: "command-code", baseUrl: "https://api.commandcode.ai", authMode: "key", apiKey: "synthetic-credential",
    fetch: (async () => planRefusal()) as typeof globalThis.fetch,
  } as OcxProviderConfig & { fetch: typeof globalThis.fetch });
  // Another adapter echoing the code and forging the marker header, without the in-memory mark.
  const forged = (): ProviderAdapter => ({
    name: "fixture",
    buildRequest: async () => ({ url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" }),
    fetchResponse: async () => Response.json({ error: { type: "invalid_request_error", code: MODEL_NOT_IN_PLAN_CODE, message: "forged" } },
      { status: 400, headers: { "x-opencodex-refusal": "model-not-in-plan" } }),
    async *parseStream() { /* never reached: the first iteration fails */ },
  });
  const loops = {
    "web search": (adapter: ProviderAdapter) => runWithWebSearch({
      parsed: loopParsed(), adapter, backend: "exa", exaApiKey: "fixture-exa", hostedTool: { type: "web_search" },
      settings: { model: "fixture", reasoning: "low", timeoutMs: 1000 }, maxSearches: 1,
      incomingMeta: { headers: new Headers(), translatorBudget: createTestTranslatorBudget(), providerFetch: routedSend },
    }),
    "image bridge": (adapter: ProviderAdapter) => runWithImageBridge({
      parsed: loopParsed(), adapter,
      plan: { provider: {} as never, auth: { baseUrl: "https://images.test", token: "fixture" }, model: "fixture-image", toolNames: new Set(["image_gen"]) } as ImageBridgePlan,
      incomingMeta: { headers: new Headers(), translatorBudget: createTestTranslatorBudget(), providerFetch: routedSend },
      on429: async () => null,
      fetchForRequest: () => routedSend,
    }),
  };

  for (const [name, run] of Object.entries(loops)) {
    test(name + " keeps the verified refusal's copy, code and provenance", async () => {
      const response = await run(commandCode());
      const body = await response.text();
      expect(response.status, body).toBe(400);
      expect(isVerifiedModelNotInPlanResponse(response)).toBe(true);
      const error = JSON.parse(body).error;
      expect(error.code).toBe(MODEL_NOT_IN_PLAN_CODE);
      expect(error.message).toContain('"' + REFUSED_MODEL + '"');
      expect(error.message).toContain("will not succeed");
      expectNoCanary(body);
    });

    test(name + " grants nothing to a forged code and marker", async () => {
      const response = await run(forged());
      const body = await response.text();
      expect(response.status, body).toBe(400);
      expect(isVerifiedModelNotInPlanResponse(response)).toBe(false);
      expect(JSON.parse(body).error.code).not.toBe(MODEL_NOT_IN_PLAN_CODE);
    });
  }

  for (const [name, tool, run] of [
    ["web search", { name: "web_search", input: { query: "fixture" } }, loops["web search"]],
    ["image bridge", { name: "image_gen", input: { prompt: "a cat" } }, loops["image bridge"]],
  ] as const) {
    test(name + " ends a later-iteration refusal with a terminal stream code", async () => {
      // Iteration one asks for the sidecar tool (the sidecar call itself fails under the network
      // guard); iteration two is the verified refusal, inside an already committed 200 stream.
      let generate = 0;
      laterRefusal = async () => {
        generate += 1;
        if (generate > 1) return planRefusal();
        return new Response([
          JSON.stringify({ type: "tool-call", toolCallId: "call_1", toolName: tool.name, input: tool.input }),
          JSON.stringify({ type: "finish", finishReason: "tool-calls" }),
        ].join("\n") + "\n");
      };
      const response = await run(commandCode());
      const body = await response.text();
      expect(response.status, body).toBe(200);
      expect(generate).toBe(2);
      const failed = body.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)))
        .find(frame => frame.type === "response.failed");
      expect(failed?.response?.error?.code, body).toBe("invalid_prompt");
      expect(failed?.response?.error?.message).toContain("MODEL_NOT_IN_PLAN");
      expect(body).not.toContain('"code":"model_not_in_plan"');
      expectNoCanary(body);
    });
  }
});

describe("Command Code MODEL_NOT_IN_PLAN refusal through dispatch", () => {
  const originalHome = process.env.OPENCODEX_HOME;
  const originalFetch = globalThis.fetch;
  const consoleMethods = ["log", "info", "warn", "error", "debug"] as const;
  const originalConsole = Object.fromEntries(consoleMethods.map(name => [name, console[name]]));
  let fixtureHome = "";
  let releaseSpend: (() => void) | undefined;
  let logged: string[] = [];
  let sends: Array<{ model: string; authorization: string }> = [];
  // Tool names each Command Code send declared, so a route test can prove which path built it.
  let sentToolNames: string[][] = [];

  beforeEach(() => {
    fixtureHome = mkdtempSync(join(tmpdir(), "ocx-command-plan-denial-"));
    process.env.OPENCODEX_HOME = fixtureHome;
    releaseSpend = acquireOwnedSpendHome();
    clearGenericFailoverHealth();
    clearComboSelectionState();
    clearComboRecallForTests();
    clearComboTargetCooldowns();
    clearKeyCooldowns();
    logged = [];
    sends = [];
    for (const name of consoleMethods) {
      console[name] = (...args: unknown[]) => { logged.push(args.map(arg => String(arg)).join(" ")); };
    }
    // The refused model answers MODEL_NOT_IN_PLAN; every other model completes.
    globalThis.fetch = (async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== GENERATE_URL) throw new Error("Unexpected fixture request: " + url);
      const model = String((JSON.parse(String(init?.body)) as { params: { model: string } }).params.model);
      sends.push({ model, authorization: new Headers(init?.headers).get("authorization") ?? "" });
      const declared = (JSON.parse(String(init?.body)) as { params: { tools?: Array<{ name?: unknown }> } }).params.tools ?? [];
      sentToolNames.push(declared.map(tool => String(tool.name)));
      return model === REFUSED_MODEL ? planRefusal() : new Response(COMPLETED);
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const name of consoleMethods) console[name] = originalConsole[name]!;
    releaseSpend?.();
    releaseSpend = undefined;
    closeRequestHistoryIndex();
    clearGenericFailoverHealth();
    clearComboSelectionState();
    clearComboRecallForTests();
    clearComboTargetCooldowns();
    clearKeyCooldowns();
    resetCommandCodeReasoningEffortsForTest();
    if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = originalHome;
    removeTreeWithRetry(fixtureHome);
  });

  /** Native Command Code dispatch reads a stored login; key rows are covered at the adapter above. */
  async function login(accounts: number): Promise<void> {
    for (let index = 0; index < accounts; index++) await saveCredential("command-code", {
      access: "synthetic-command-" + index, refresh: "synthetic-refresh-" + index,
      expires: Date.now() + 3_600_000, accountId: "fixture-" + index, source: "oauth",
    }, { addAccount: true });
    await setActiveAccount("command-code", getAccountSet("command-code")!.accounts[0]!.id);
  }

  function config(extra: Partial<OcxConfig> = {}): OcxConfig {
    return {
      defaultProvider: "command-code",
      providers: {
        "command-code": {
          adapter: "command-code", baseUrl: "https://api.commandcode.ai", authMode: "oauth",
          models: [REFUSED_MODEL, SERVED_MODEL],
        },
      },
      ...extra,
    } as OcxConfig;
  }

  async function responses(cfg: OcxConfig, model: string, stream = false) {
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, input: "hello", stream }),
    }), cfg, { model: "", provider: "" });
    return { response, body: await response.text() };
  }

  test("an OAuth account is refused once, keeps its seat, and still serves its other models", async () => {
    await login(2);
    const cfg = config();

    for (const stream of [false, true]) {
      sends = [];
      const refused = await responses(cfg, "command-code/" + REFUSED_MODEL, stream);
      expect(refused.response.status, refused.body).toBe(400);
      expect(JSON.parse(refused.body).error.code).toBe("model_not_in_plan");
      expect(sends).toEqual([{ model: REFUSED_MODEL, authorization: "Bearer synthetic-command-0" }]);
      expectNoCanary(refused.body);
    }

    sends = [];
    const served = await responses(cfg, "command-code/" + SERVED_MODEL);
    expect(served.response.status, served.body).toBe(200);
    expect(sends).toEqual([{ model: SERVED_MODEL, authorization: "Bearer synthetic-command-0" }]);
    expect(getAccountSet("command-code")!.activeAccountId).toBe(getAccountSet("command-code")!.accounts[0]!.id);
    expectNoCanary(logged.join("\n"));
  });

  test("Chat and Messages inbound answer the refusal once with a 400", async () => {
    await login(1);
    const cfg = config();
    const chat = await handleChatCompletions(new Request("http://localhost/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "command-code/" + REFUSED_MODEL, messages: [{ role: "user", content: "hello" }] }),
    }), cfg, { model: "", provider: "" });
    const chatBody = await chat.text();
    expect(chat.status, chatBody).toBe(400);
    expect(chatBody).toContain("MODEL_NOT_IN_PLAN");
    expectNoCanary(chatBody);
    expect(sends.map(send => send.model)).toEqual([REFUSED_MODEL]);

    sends = [];
    const messages = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "command-code/" + REFUSED_MODEL, max_tokens: 64, messages: [{ role: "user", content: "hello" }] }),
    }), cfg, { model: "", provider: "" });
    const messagesBody = await messages.text();
    expect(messages.status, messagesBody).toBe(400);
    expect(messagesBody).toContain("MODEL_NOT_IN_PLAN");
    expectNoCanary(messagesBody);
    expect(sends.map(send => send.model)).toEqual([REFUSED_MODEL]);
    expectNoCanary(logged.join("\n"));
  });

  test("a combo hops past the refused model and cools only that target", async () => {
    await login(1);
    const cfg = config({ combos: { pair: { strategy: "failover", targets: [
      { provider: "command-code", model: REFUSED_MODEL },
      { provider: "command-code", model: SERVED_MODEL },
    ] } } } as Partial<OcxConfig>);

    const first = await responses(cfg, "combo/pair");
    expect(first.response.status, first.body).toBe(200);
    expect(JSON.parse(first.body).status).toBe("completed");
    expect(sends.map(send => send.model)).toEqual([REFUSED_MODEL, SERVED_MODEL]);

    sends = [];
    const second = await responses(cfg, "combo/pair");
    expect(second.response.status, second.body).toBe(200);
    expect(sends.map(send => send.model)).toEqual([SERVED_MODEL]);

    // Streamed, the verified refusal must reach the same fallback through the stream wrappers.
    clearComboTargetCooldowns();
    sends = [];
    const streamed = await responses(cfg, "combo/pair", true);
    expect(streamed.response.status, streamed.body).toBe(200);
    expect(streamed.body).toContain("response.completed");
    expect(sends.map(send => send.model)).toEqual([REFUSED_MODEL, SERVED_MODEL]);
    expectNoCanary(logged.join("\n"));
  });

  test("another provider echoing the code and marker cannot claim the plan-refusal hop", async () => {
    await login(1);
    const generate = globalThis.fetch;
    const otherSends: string[] = [];
    let echoedCode = "";
    globalThis.fetch = (async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.startsWith("https://other.example/")) return generate(input, init);
      otherSends.push(url);
      // The marker header is forged as well: a header is not provenance either.
      return Response.json({ error: { type: "invalid_request_error", code: echoedCode, message: "fixture" } },
        { status: 400, headers: { "x-opencodex-refusal": "model-not-in-plan" } });
    }) as typeof fetch;
    const cfg = config({ combos: { pair: { strategy: "failover", targets: [
      { provider: "other", model: "m1" },
      { provider: "command-code", model: SERVED_MODEL },
    ] } } } as Partial<OcxConfig>);
    cfg.providers.other = { adapter: "openai-chat", baseUrl: "https://other.example/v1", authMode: "key", apiKey: "synthetic-other", models: ["m1"] };

    // Every spelling combo failover folds into the hop code, including the ones it normalizes.
    for (const spelling of ["model_not_in_plan", "MODEL_NOT_IN_PLAN", "model-not-in-plan", " Model-Not-In-Plan "]) {
      echoedCode = spelling;
      otherSends.length = 0;
      sends = [];
      clearComboTargetCooldowns();
      const result = await responses(cfg, "combo/pair");
      expect(result.response.status, spelling + ": " + result.body).toBe(400);
      expect(JSON.parse(result.body).error.code).not.toBe("model_not_in_plan");
      expect(otherSends.length, spelling).toBeGreaterThan(0);
      expect(sends, spelling).toEqual([]);
    }
  });

  test("a passthrough or streamed candidate forging code and marker is read like any unknown code", async () => {
    await login(1);
    const generate = globalThis.fetch;
    let echo = { code: "", stream: false };
    globalThis.fetch = (async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.startsWith("https://other.example/")) return generate(input, init);
      const error = { type: "invalid_request_error", code: echo.code, message: "fixture" };
      // Every echo also forges the adapter's marker header, which must not count as provenance.
      const forged = { "x-opencodex-refusal": "model-not-in-plan" };
      if (!echo.stream) return Response.json({ error }, { status: 400, headers: forged });
      const failed = { type: "response.failed", response: { id: "resp_fixture", object: "response", status: "failed", error, output: [] } };
      return new Response("event: response.failed\ndata: " + JSON.stringify(failed) + "\n\n", { headers: { "content-type": "text/event-stream", ...forged } });
    }) as typeof fetch;
    const other = { adapter: "openai-responses", baseUrl: "https://other.example/v1", authMode: "key", apiKey: "synthetic-other", models: ["m1"] } as OcxProviderConfig;
    const candidates = [{ provider: "other", model: "m1" }, { provider: "command-code", model: SERVED_MODEL }];
    const policy = config({ routingProfiles: { daily: { candidates } } } as Partial<OcxConfig>);
    policy.providers.other = other;
    const combo = config({ combos: { pair: { strategy: "failover", targets: candidates } } } as Partial<OcxConfig>);
    combo.providers.other = other;

    // The control is a code nothing recognizes; every plan-refusal spelling must route exactly like it.
    const outcome = async (code: string, route: "policy/daily" | "combo/pair", stream: boolean) => {
      echo = { code, stream };
      sends = [];
      clearComboTargetCooldowns();
      const result = await responses(route === "policy/daily" ? policy : combo, route, stream);
      return { status: result.response.status, sends: sends.map(send => send.model), planCode: result.body.includes('"code":"model_not_in_plan"') };
    };
    for (const [route, stream] of [["policy/daily", false], ["combo/pair", true]] as const) {
      const control = await outcome("fixture_unknown_code", route, stream);
      for (const spelling of ["model_not_in_plan", "MODEL_NOT_IN_PLAN", "model-not-in-plan"]) {
        const observed = await outcome(spelling, route, stream);
        expect({ ...observed, planCode: false }, route + " " + spelling).toEqual({ ...control, planCode: false });
        expect(observed.sends, route + " " + spelling).toEqual([]);
      }
    }
  });

  test("a web-search sidecar combo and policy still move past the refused model", async () => {
    await login(1);
    const targets = [{ provider: "command-code", model: REFUSED_MODEL }, { provider: "command-code", model: SERVED_MODEL }];
    const sidecar = { webSearchSidecar: { backend: "exa", exaApiKey: "fixture-exa" } };
    const send = async (cfg: OcxConfig, model: string) => {
      sends = [];
      sentToolNames = [];
      clearComboTargetCooldowns();
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, input: "hello", stream: false, tools: [{ type: "web_search" }] }),
      }), cfg, { model: "", provider: "" });
      return { status: response.status, body: await response.text(), sends: sends.map(entry => entry.model),
        // The web-search sidecar is the path under test: every send carries its injected function tool.
        viaSidecar: sentToolNames.map(names => names.includes("web_search")) };
    };
    const combo = await send(config({ ...sidecar, combos: { pair: { strategy: "failover", targets } } } as Partial<OcxConfig>), "combo/pair");
    expect(combo.status, combo.body).toBe(200);
    expect(combo.sends).toEqual([REFUSED_MODEL, SERVED_MODEL]);
    expect(combo.viaSidecar).toEqual([true, true]);
    const policy = await send(config({ ...sidecar, routingProfiles: { daily: { candidates: targets } } } as Partial<OcxConfig>), "policy/daily");
    expect(policy.status, policy.body).toBe(200);
    expect(policy.sends).toEqual([REFUSED_MODEL, SERVED_MODEL]);
    expect(policy.viaSidecar).toEqual([true, true]);
    const direct = await send(config(sidecar as Partial<OcxConfig>), "command-code/" + REFUSED_MODEL);
    expect(direct.status, direct.body).toBe(400);
    expect(JSON.parse(direct.body).error.message).toContain("MODEL_NOT_IN_PLAN");
    expect(direct.sends).toEqual([REFUSED_MODEL]);
    expect(direct.viaSidecar).toEqual([true]);
    expectNoCanary(combo.body + policy.body + direct.body + logged.join("\n"));
  });

  test("Chat answers a later sidecar-iteration refusal as a client error in both modes", async () => {
    await login(1);
    const cfg = config({ webSearchSidecar: { backend: "exa", exaApiKey: "fixture-exa" } } as Partial<OcxConfig>);
    let generate = 0;
    // Iteration one asks for the sidecar search (which fails: the fixture refuses the search
    // host); iteration two is the verified refusal inside the already committed stream.
    globalThis.fetch = (async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== GENERATE_URL) throw new Error("Unexpected fixture request: " + url);
      generate += 1;
      if (generate % 2 === 0) return planRefusal();
      return new Response([
        JSON.stringify({ type: "tool-call", toolCallId: "call_1", toolName: "web_search", input: { query: "fixture" } }),
        JSON.stringify({ type: "finish", finishReason: "tool-calls" }),
      ].join("\n") + "\n");
    }) as typeof fetch;
    const chat = (stream: boolean) => handleChatCompletions(new Request("http://localhost/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "command-code/" + REFUSED_MODEL, stream, tools: [{ type: "web_search" }],
        messages: [{ role: "user", content: "hello" }] }),
    }), cfg, { model: "", provider: "" });

    const buffered = await chat(false);
    const bufferedBody = await buffered.text();
    expect(buffered.status, bufferedBody).toBe(400);
    expect(JSON.parse(bufferedBody).error).toMatchObject({ type: "invalid_request_error", code: "invalid_prompt" });
    expect(bufferedBody).toContain("MODEL_NOT_IN_PLAN");

    const streamed = await chat(true);
    const streamedBody = await streamed.text();
    const errorFrame = streamedBody.split("\n").filter(line => line.startsWith("data: {"))
      .map(line => JSON.parse(line.slice(6))).find(frame => frame.error)?.error;
    expect(errorFrame, streamedBody).toMatchObject({ type: "invalid_request_error", code: "invalid_prompt" });
    expect(errorFrame.message).toContain("MODEL_NOT_IN_PLAN");
    expect(generate).toBe(4);
    expectNoCanary(bufferedBody + streamedBody + logged.join("\n"));
  });

  test("a routing policy moves on to its next candidate", async () => {
    await login(1);
    const cfg = config({ routingProfiles: { daily: { candidates: [
      { provider: "command-code", model: REFUSED_MODEL },
      { provider: "command-code", model: SERVED_MODEL },
    ] } } } as Partial<OcxConfig>);

    const result = await responses(cfg, "policy/daily");
    expect(result.response.status, result.body).toBe(200);
    expect(sends.map(send => send.model)).toEqual([REFUSED_MODEL, SERVED_MODEL]);

    sends = [];
    const streamed = await responses(cfg, "policy/daily", true);
    expect(streamed.response.status, streamed.body).toBe(200);
    expect(streamed.body).toContain("response.completed");
    expect(sends.map(send => send.model)).toEqual([REFUSED_MODEL, SERVED_MODEL]);
    expectNoCanary(logged.join("\n"));
  });
});
