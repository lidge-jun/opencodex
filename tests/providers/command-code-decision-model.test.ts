import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearComboSelectionState, clearComboTargetCooldowns, isComboTargetInCooldown } from "../../src/combos";
import { clearGenericFailoverHealth } from "../../src/oauth/generic-account-failover";
import { getAccountSet, saveCredential, setActiveAccount } from "../../src/oauth/store";
import { extractProviderModelItems, resolveProviderModelDiscovery } from "../../src/providers/model-discovery";
import { isCommandCodeDecisionModel } from "../../src/providers/command-code-decision-models";
import { clearKeyCooldowns } from "../../src/providers/key-failover";
import { closeRequestHistoryIndex } from "../../src/routing/history/indexer";
import { handleChatCompletions } from "../../src/server/chat-completions";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import { handleResponses } from "../../src/server/responses";
import { clearComboRecallForTests } from "../../src/server/responses/combo-session-recall";
import { nativeChatDeclineReason } from "../../src/server/chat-native-eligibility";
import { nativeMessagesDeclineReason } from "../../src/server/messages-native-eligibility";
import { clearFallbackEventsForTests, recentFallbackEvents } from "../../src/routing/fallback-policy";
import type { RouteResult } from "../../src/router";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// #8997: Command Code lists its System One decision models (typesafe/jev*) in /provider/v1/models,
// but serves them only at POST /provider/v1/systemone. A chat request must never reach them.
setDefaultTimeout(30_000);

const JEV = "typesafe/jev-1.14.0";
const SERVED = "deepseek/deepseek-v4-flash";
const FAILING = "deepseek/deepseek-v4-pro";
const COMPLETED = [
  JSON.stringify({ type: "text-delta", text: "OK" }),
  JSON.stringify({ type: "finish", finishReason: "stop" }),
].join("\n") + "\n";

describe("Command Code decision models are not chat models", () => {
  test("live discovery drops the decision rows for both Command Code presets and keeps chat rows", () => {
    const listing = { data: [
      { id: SERVED, object: "model", owned_by: "command-code", supported_endpoints: ["/chat/completions"] },
      { id: "typesafe/jev", object: "model", owned_by: "command-code" },
      { id: JEV, object: "model", owned_by: "command-code" },
      { id: "TypeSafe/JEV-2", object: "model", owned_by: "command-code" },
      { id: "claude-sonnet-5-5", object: "model", owned_by: "command-code", supported_endpoints: ["/messages"] },
    ] };
    for (const [name, provider] of [
      ["command-code", { adapter: "command-code", baseUrl: "https://api.commandcode.ai", authMode: "oauth" as const }],
      ["commandcode", { adapter: "openai-chat", baseUrl: "https://api.commandcode.ai/provider/v1" }],
    ] as const) {
      const result = extractProviderModelItems(listing, resolveProviderModelDiscovery(name, provider));
      expect(result.ok, name).toBe(true);
      if (!result.ok) continue;
      expect(result.items.map(item => item.id), name).toEqual([SERVED, "claude-sonnet-5-5"]);
    }
  });

  test("the request guard matches native, encoded and case-varied decision ids only", () => {
    for (const id of ["typesafe/jev", JEV, "TypeSafe/JEV-2", "typesafe-jev-1.14.0", " typesafe/jev ", "vendor/typesafe/jev", "vendor-typesafe-jev"]) {
      expect(isCommandCodeDecisionModel(id), id).toBe(true);
    }
    for (const id of [SERVED, "jev-1.13", "zai-org/GLM-5.3", "deepseek-v4-flash", "typesafe/other", "claude-sonnet-5-5", "typesafe/je-v"]) {
      expect(isCommandCodeDecisionModel(id), id).toBe(false);
    }
  });

  test("request admission refuses exactly the ids discovery hides, and every encoded slug of them", () => {
    const ids = ["typesafe/jev", JEV, "TypeSafe/JEV-2", "vendor/typesafe/jev", "typesafe/jevons", SERVED,
      "typesafe/other", "claude-sonnet-5-5", "jev-1.13", "typesafe-jev-1.14.0", "vendor/typesafe-jev"];
    const discovery = resolveProviderModelDiscovery("command-code", { adapter: "command-code", baseUrl: "https://api.commandcode.ai", authMode: "oauth" });
    const result = extractProviderModelItems({ data: ids.map(id => ({ id, object: "model" })) }, discovery);
    expect(result.ok).toBe(true);
    const admitted = new Set(result.ok ? result.items.map(item => item.id) : []);
    for (const id of ids) {
      expect(admitted.has(id), id).toBe(!isCommandCodeDecisionModel(id));
      // The Codex-facing slug folds slashes to dashes; a hidden id's slug is refused too.
      if (!admitted.has(id)) expect(isCommandCodeDecisionModel(id.replaceAll("/", "-")), id).toBe(true);
    }
  });

  test("the native Chat and Messages lanes decline a decision route so the refusal path owns it", () => {
    const route = (adapter: string, modelId: string) => ({
      providerName: "commandcode", modelId, provider: { adapter, baseUrl: "https://api.commandcode.ai/provider/v1", authMode: "key", apiKey: "synthetic-key" },
    }) as unknown as RouteResult;
    const config = { providers: {}, protocols: { rollout: { managedMessagesNative: true } } } as unknown as OcxConfig;
    expect(nativeChatDeclineReason(route("openai-chat", JEV), { messages: [] })).toBe("compatibility-reject");
    expect(nativeChatDeclineReason(route("openai-chat", SERVED), { messages: [] })).toBeUndefined();
    expect(nativeMessagesDeclineReason(route("anthropic", "vendor/typesafe/jev"), {}, config)).toBe("compatibility-reject");
    expect(nativeMessagesDeclineReason(route("anthropic", "claude-sonnet-5-5"), {}, config)).not.toBe("compatibility-reject");
  });
});

describe("a chat request that reaches a Command Code decision model fails fast", () => {
  const originalHome = process.env.OPENCODEX_HOME;
  const originalFetch = globalThis.fetch;
  let fixtureHome = "";
  let releaseSpend: (() => void) | undefined;
  let sends: string[] = [];

  beforeEach(() => {
    fixtureHome = mkdtempSync(join(tmpdir(), "ocx-command-code-decision-"));
    process.env.OPENCODEX_HOME = fixtureHome;
    releaseSpend = acquireOwnedSpendHome();
    clearGenericFailoverHealth();
    clearComboSelectionState();
    clearComboRecallForTests();
    clearComboTargetCooldowns();
    clearKeyCooldowns();
    sends = [];
    clearFallbackEventsForTests();
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      sends.push(url);
      if (url === "https://api.commandcode.ai/alpha/generate") return new Response(COMPLETED);
      if (url === "https://api.commandcode.ai/provider/v1/chat/completions") {
        if (String(init?.body ?? "").includes(FAILING)) {
          return Response.json({ error: { message: "fixture outage", type: "server_error" } }, { status: 503 });
        }
        return Response.json({ id: "c1", object: "chat.completion", created: 1, model: SERVED,
          choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }] });
      }
      throw new Error("Unexpected fixture request: " + url);
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    releaseSpend?.();
    releaseSpend = undefined;
    closeRequestHistoryIndex();
    clearGenericFailoverHealth();
    clearComboSelectionState();
    clearComboRecallForTests();
    clearComboTargetCooldowns();
    clearKeyCooldowns();
    if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = originalHome;
    removeTreeWithRetry(fixtureHome);
  });

  async function login(): Promise<void> {
    await saveCredential("command-code", {
      access: "synthetic-command-0", refresh: "synthetic-refresh-0",
      expires: Date.now() + 3_600_000, accountId: "fixture-0", source: "oauth",
    }, { addAccount: true });
    await setActiveAccount("command-code", getAccountSet("command-code")!.accounts[0]!.id);
  }

  function config(models: string[], extra: Partial<OcxConfig> = {}): OcxConfig {
    return {
      defaultProvider: "command-code",
      providers: {
        "command-code": { adapter: "command-code", baseUrl: "https://api.commandcode.ai", authMode: "oauth", models },
        commandcode: { adapter: "openai-chat", baseUrl: "https://api.commandcode.ai/provider/v1", apiKey: "synthetic-key", models },
      },
      ...extra,
    } as OcxConfig;
  }

  function expectDecisionRefusal(status: number, body: string): void {
    // 404 model_not_found from the pipeline's early refusal (OpenAI's own shape for a non-chat model).
    expect(status, body).toBe(404);
    expect(body).toContain("/provider/v1/systemone");
    expect(body).toContain("JEV combo");
  }

  test("Responses, Chat and Messages inbound are refused without an upstream send, on both presets", async () => {
    await login();
    const cfg = config([JEV, SERVED]);
    for (const provider of ["command-code", "commandcode"]) {
      const model = provider + "/" + JEV;
      const responses = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, input: "hello", stream: false }),
      }), cfg, { model: "", provider: "" });
      expectDecisionRefusal(responses.status, await responses.text());
      const chat = await handleChatCompletions(new Request("http://localhost/v1/chat/completions", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, messages: [{ role: "user", content: "hello" }] }),
      }), cfg, { model: "", provider: "" });
      expectDecisionRefusal(chat.status, await chat.text());
      const messages = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, max_tokens: 64, messages: [{ role: "user", content: "hello" }] }),
      }), cfg, { model: "", provider: "" });
      expectDecisionRefusal(messages.status, await messages.text());
    }
    expect(sends).toEqual([]);

    // The guard is scoped to decision ids: chat models on both presets still reach upstream.
    for (const provider of ["command-code", "commandcode"]) {
      const served = await handleChatCompletions(new Request("http://localhost/v1/chat/completions", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: provider + "/" + SERVED, messages: [{ role: "user", content: "hello" }] }),
      }), cfg, { model: "", provider: "" });
      expect(served.status, await served.text()).toBe(200);
    }
    expect(sends).toEqual([
      "https://api.commandcode.ai/alpha/generate",
      "https://api.commandcode.ai/provider/v1/chat/completions",
    ]);
  });

  test("a stale encoded selection with an empty discovery cache is refused before any send", async () => {
    await login();
    const cfg = config([]);
    for (const model of ["command-code/typesafe-jev-1.14.0", "commandcode/typesafe-jev-1.14.0", "command-code/TypeSafe/JEV",
      "command-code/vendor-typesafe-jev", "commandcode/vendor-typesafe-jev"]) {
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, input: "hello", stream: false }),
      }), cfg, { model: "", provider: "" });
      expectDecisionRefusal(response.status, await response.text());
    }
    expect(sends).toEqual([]);
  });

test("an OAuth decision route is refused before any credential is resolved or refreshed", async () => {
    // No login at all: transport preparation would answer 401 for the OAuth preset.
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "command-code/" + JEV, input: "hello", stream: false }),
    }), config([JEV, SERVED]), { model: "", provider: "" });
    expectDecisionRefusal(response.status, await response.text());
    // An expired credential: transport preparation would send a refresh request first.
    await saveCredential("command-code", {
      access: "synthetic-expired", refresh: "synthetic-refresh-expired",
      expires: Date.now() - 60_000, accountId: "fixture-expired", source: "oauth",
    }, { addAccount: true });
    await setActiveAccount("command-code", getAccountSet("command-code")!.accounts[0]!.id);
    const expired = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "command-code/" + JEV, input: "hello", stream: false }),
    }), config([JEV, SERVED]), { model: "", provider: "" });
    expectDecisionRefusal(expired.status, await expired.text());
    expect(sends).toEqual([]);
  });

  test("a combo moves past an OAuth decision target without a credential verdict cooling its provider", async () => {
    const jevTarget = { provider: "command-code", model: JEV };
    // A third target on the same OAuth provider: a 401 from transport preparation would read as a
    // provider-wide credential failure and cool it too, although no credential was ever tried.
    const sameProvider = { provider: "command-code", model: SERVED };
    const cfg = config([JEV, SERVED], { combos: { pair: { strategy: "failover", targets: [
      jevTarget, { provider: "commandcode", model: SERVED }, sameProvider,
    ] } } });
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "combo/pair", input: "hello", stream: false }),
    }), cfg, { model: "", provider: "" });
    const body = await response.text();
    expect(response.status, body).toBe(200);
    expect(sends).toEqual(["https://api.commandcode.ai/provider/v1/chat/completions"]);
    expect(isComboTargetInCooldown("pair", sameProvider)).toBe(false);
  });

  test("an image-bearing request is refused before the vision sidecar describes anything", async () => {
    await login();
    // A routed describer answers on the proxy's own loopback port; any describe call is a recorded send.
    const cfg = config([JEV, SERVED], { port: 1234, visionSidecar: { enabled: true, backend: "routed", model: "command-code/" + SERVED } });
    // Declared blind, so without the early refusal the sidecar would describe the image first.
    cfg.providers["command-code"]!.noVisionModels = [JEV];
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "command-code/" + JEV, stream: false, input: [{ role: "user", content: [
        { type: "input_text", text: "what is this" },
        { type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" },
      ] }] }),
    }), cfg, { model: "", provider: "" });
    expectDecisionRefusal(response.status, await response.text());
    expect(sends).toEqual([]);
  });

  test("a combo listing the decision model does not cool its chat sibling", async () => {
    await login();
    const jevTarget = { provider: "command-code", model: JEV };
    const servedTarget = { provider: "command-code", model: SERVED };
    const cfg = config([JEV, SERVED], { combos: { pair: { strategy: "failover", targets: [jevTarget, servedTarget] } } });
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "combo/pair", input: "hello", stream: false }),
    }), cfg, { model: "", provider: "" });
    const body = await response.text();
    // The decision target is refused locally; the combo moves on and the chat sibling serves.
    expect(response.status, body).toBe(200);
    expect(body).toContain("OK");
    expect(sends).toEqual(["https://api.commandcode.ai/alpha/generate"]);
    expect(isComboTargetInCooldown("pair", servedTarget)).toBe(false);
  });

  test("a routing policy skips the decision candidate without making it the next hop's source", async () => {
    await login();
    const cfg = config([JEV, SERVED, FAILING], { routingProfiles: { wf: { candidates: [
      { provider: "commandcode", model: FAILING },
      { provider: "command-code", model: JEV },
      { provider: "command-code", model: SERVED },
    ] } } } as Partial<OcxConfig>);
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "policy/wf", input: "hello", stream: false }),
    }), cfg, { model: "", provider: "" });
    const body = await response.text();
    expect(response.status, body).toBe(200);
    expect(body).toContain("OK");
    // A failed upstream, no send for the decision candidate, then the chat candidate.
    expect(sends).toEqual([
      "https://api.commandcode.ai/provider/v1/chat/completions",
      "https://api.commandcode.ai/alpha/generate",
    ]);
    // Every taken hop starts from the candidate that actually sent; the decision candidate never is a source.
    const taken = recentFallbackEvents().filter(event => event.outcome === "taken");
    expect(taken.length).toBeGreaterThan(0);
    expect(taken.some(event => event.from.includes("jev"))).toBe(false);
  });
});
