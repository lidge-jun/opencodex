import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCommandCodeAdapter } from "../../src/adapters/command-code";
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
// Synthetic canaries: none of these may reach a client body or a log line.
const ACCOUNT_CANARY = "acct_canary_7f3e91";
const KEY_CANARY = "sk-canary-SYNTHETIC00000000000000";
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
      const error = JSON.parse(text).error;
      expect(error.type).toBe("invalid_request_error");
      expect(error.code).toBe("model_not_in_plan");
      expect(error.message).toContain('"' + REFUSED_MODEL + '"');
      expect(error.message).toContain("MODEL_NOT_IN_PLAN");
      expect(error.message).toContain("will not succeed");
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

describe("Command Code MODEL_NOT_IN_PLAN refusal through dispatch", () => {
  const originalHome = process.env.OPENCODEX_HOME;
  const originalFetch = globalThis.fetch;
  const consoleMethods = ["log", "info", "warn", "error", "debug"] as const;
  const originalConsole = Object.fromEntries(consoleMethods.map(name => [name, console[name]]));
  let fixtureHome = "";
  let releaseSpend: (() => void) | undefined;
  let logged: string[] = [];
  let sends: Array<{ model: string; authorization: string }> = [];

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
    expectNoCanary(logged.join("\n"));
  });

  test("another provider echoing the code cannot claim the plan-refusal hop", async () => {
    await login(1);
    const generate = globalThis.fetch;
    const otherSends: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.startsWith("https://other.example/")) return generate(input, init);
      otherSends.push(url);
      return Response.json({ error: { type: "invalid_request_error", code: "model_not_in_plan", message: "fixture" } }, { status: 400 });
    }) as typeof fetch;
    const cfg = config({ combos: { pair: { strategy: "failover", targets: [
      { provider: "other", model: "m1" },
      { provider: "command-code", model: SERVED_MODEL },
    ] } } } as Partial<OcxConfig>);
    cfg.providers.other = { adapter: "openai-chat", baseUrl: "https://other.example/v1", authMode: "key", apiKey: "synthetic-other", models: ["m1"] };

    const result = await responses(cfg, "combo/pair");
    expect(result.response.status, result.body).toBe(400);
    expect(JSON.parse(result.body).error.code).not.toBe("model_not_in_plan");
    expect(otherSends.length).toBeGreaterThan(0);
    expect(sends).toEqual([]);
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
    expectNoCanary(logged.join("\n"));
  });
});
