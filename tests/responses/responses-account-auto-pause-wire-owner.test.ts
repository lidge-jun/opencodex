import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultConfig, loadConfig, saveConfig } from "../../src/config";
import { captureAccountAutoPauseAttempt, wasAccountAutoPaused } from "../../src/oauth/account-auto-pause";
import { clearGenericFailoverHealth } from "../../src/oauth/generic-account-failover";
import { registerUpstreamRewriter, type UpstreamRewriter } from "../../src/plugins/upstream-hooks";
import { clearKeyCooldowns, forgetApiKeyRotationCursor } from "../../src/providers/key-failover";
import { routedProviderConfig } from "../../src/router";
import { clearResponseStateForTests, flushResponseState } from "../../src/responses/state";
import { handleChatCompletions } from "../../src/server/chat-completions";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import { providerFetch } from "../../src/server/responses/fetch-helpers";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const originalFetch = globalThis.fetch;
let previousHome: string | undefined;
let home: string;
let releaseSpend: () => void;
const unregister: (() => void)[] = [];
const target = "https://example.test/v1/responses";
const replacementTarget = "https://other.example.test/v1/responses";
const refusal = () => Response.json({ error: { type: "permission_error", message: "Your subscription has expired." } }, { status: 403 });

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-auto-pause-wire-owner-"));
  process.env.OPENCODEX_HOME = home;
  releaseSpend = acquireOwnedSpendHome();
  clearGenericFailoverHealth(); clearKeyCooldowns(); forgetApiKeyRotationCursor();
});
afterEach(async () => {
  for (const remove of unregister.splice(0)) remove();
  await flushResponseState(); clearResponseStateForTests();
  releaseSpend();
  clearGenericFailoverHealth(); clearKeyCooldowns(); forgetApiKeyRotationCursor();
  globalThis.fetch = originalFetch;
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});
function rewrite(fn: UpstreamRewriter) {
  unregister.push(registerUpstreamRewriter("account-auto-pause-wire-owner-fixture", fn));
}
function fixture(adapter: "openai-chat" | "anthropic" | "openai-responses" = "openai-chat"): OcxConfig {
  const config = getDefaultConfig();
  config.defaultProvider = "fixture"; config.defaultModel = "fixture";
  config.providers = { fixture: { adapter, authMode: "key", baseUrl: "https://example.test/v1", models: ["fixture"],
    apiKey: "synthetic-A", apiKeyPool: [{ id: "A", key: "synthetic-A" }, { id: "B", key: "synthetic-B" }],
    requestPacing: { enabled: true, keySelection: "round-robin", keys: { maxConcurrentRequests: 1 } },
    accountAutoPause: { enabled: true, consecutiveFailures: 1 },
  } };
  if (adapter === "anthropic") config.protocols = { rollout: { managedMessagesNative: true } };
  saveConfig(config);
  return config;
}
function expectUnpaused(config: OcxConfig) {
  for (const provider of [config.providers.fixture!, loadConfig().providers.fixture!]) {
    expect(provider.apiKeyPool!.map(row => row.id)).toEqual(["A", "B"]);
    for (const row of provider.apiKeyPool!) {
      expect(row.disabled).not.toBe(true);
      expect(row.pauseDetails).toBeUndefined();
    }
  }
}
function expectPaused(config: OcxConfig) {
  for (const provider of [config.providers.fixture!, loadConfig().providers.fixture!]) {
    expect(provider.apiKeyPool![0]).toMatchObject({ id: "A", disabled: true, pauseDetails: { reason: "subscription_expired" } });
    expect(provider.apiKeyPool![1]!.disabled).not.toBe(true);
  }
}

for (const wire of ["Chat", "Messages"] as const) {
  for (const replaced of [true, false]) {
    test(`native ${wire}: ${replaced ? "rewritten credential cannot pause either round-robin key" : "identity rewriter still permits the wire owner to pause"}`, async () => {
      const config = fixture(wire === "Chat" ? "openai-chat" : "anthropic");
      const credentialHeader = wire === "Chat" ? "authorization" : "x-api-key";
      const beforeRewrite: string[] = [];
      rewrite(({ headers }) => {
        beforeRewrite.push(headers.get(credentialHeader)!);
        if (replaced) headers.set(credentialHeader, wire === "Chat" ? "Bearer synthetic-third" : "synthetic-third");
      });
      const sent: { url: string; credential: string | null; response: Response }[] = [];
      globalThis.fetch = (async (input, init) => {
        const credential = new Headers(init?.headers).get(credentialHeader);
        const response = !replaced && credential?.includes("synthetic-B")
          ? Response.json(wire === "Chat"
            ? { id: "synthetic-chat", object: "chat.completion", model: "fixture", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
            : { id: "synthetic-message", type: "message", role: "assistant", model: "fixture", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } })
          : refusal();
        sent.push({ url: String(input), credential, response });
        return response;
      }) as typeof fetch;
      const endpoint = wire === "Chat" ? "chat/completions" : "messages";
      const request = new Request(`http://localhost/v1/${endpoint}`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "fixture/fixture", max_tokens: 64, messages: [{ role: "user", content: "synthetic" }], stream: false }),
      });
      const handler = wire === "Chat" ? handleChatCompletions : handleClaudeMessages;
      const response = await handler(request, config, { model: "fixture", provider: "fixture" });
      const body = await response.text();
      expect(response.status, body).toBe(replaced ? 403 : 200);
      expect(sent).toHaveLength(replaced ? 1 : 2);
      expect(sent[0]!.url).toContain(`/v1/${endpoint}`);
      expect(beforeRewrite).toEqual((replaced ? ["A"] : ["A", "B"]).map(id => wire === "Chat" ? `Bearer synthetic-${id}` : `synthetic-${id}`));
      expect(sent[0]!.credential).toBe(wire === "Chat" ? `Bearer synthetic-${replaced ? "third" : "A"}` : `synthetic-${replaced ? "third" : "A"}`);
      expect(wasAccountAutoPaused(sent[0]!.response)).toBe(!replaced);
      if (replaced) {
        expect(wasAccountAutoPaused(response)).toBe(false);
        expectUnpaused(config);
      } else expectPaused(config);
    });
  }
}

for (const change of ["credential", "URL", "conflicting header", "none", "identity rewriter"] as const) {
  test(`Responses providerFetch: ${change} ${change === "none" || change === "identity rewriter" ? "pauses the wire owner" : "does not pause a configured key"}`, async () => {
    const config = fixture("openai-responses");
    const route = routedProviderConfig("fixture", config.providers.fixture!);
    const rewrittenFrom: string[] = [];
    if (change !== "none") rewrite(t => {
      rewrittenFrom.push(t.headers.get("authorization")!);
      if (change === "credential") t.headers.set("authorization", "Bearer synthetic-third");
      if (change === "URL") t.url = replacementTarget;
      if (change === "conflicting header") t.headers.set("x-api-key", "synthetic-third");
    });
    const sends: { url: string; headers: Headers }[] = [];
    const upstream = refusal();
    const physical = (async (input, init) => {
      sends.push({ url: String(input), headers: new Headers(init?.headers) });
      return upstream;
    }) as typeof fetch;
    let captured = 0;
    const send = providerFetch(Object.assign(route, { fetch: physical }), undefined, {
      providerName: "fixture", httpOnly: true,
      accountAutoPause: (name, provider, headers) => {
        captured++;
        const observer = captureAccountAutoPauseAttempt(name, provider, { config }, headers);
        expect(observer).toBeDefined();
        return observer;
      },
    });
    const response = await send(target, { method: "POST", headers: { authorization: "Bearer synthetic-A" }, body: "{}" });
    const body = await response.json();
    expect(captured).toBe(1);
    expect(response.status).toBe(403);
    expect(body).toEqual({ error: { type: "permission_error", message: "Your subscription has expired." } });
    expect(sends).toHaveLength(1);
    expect(rewrittenFrom).toEqual(change === "none" ? [] : ["Bearer synthetic-A"]);
    expect(sends[0]!.url).toBe(change === "URL" ? replacementTarget : target);
    expect(sends[0]!.headers.get("authorization")).toBe(change === "credential" ? "Bearer synthetic-third" : "Bearer synthetic-A");
    expect(sends[0]!.headers.get("x-api-key")).toBe(change === "conflicting header" ? "synthetic-third" : null);
    const shouldPause = change === "none" || change === "identity rewriter";
    expect(wasAccountAutoPaused(response)).toBe(shouldPause);
    if (shouldPause) expectPaused(config); else expectUnpaused(config);
  });
}

for (const registered of [true, false]) {
  test(`observer without physical report: ${registered ? "registered rewriter prevents counting" : "no rewriter permits counting"}`, async () => {
    const config = fixture();
    const route = routedProviderConfig("fixture", config.providers.fixture!);
    const observer = captureAccountAutoPauseAttempt("fixture", route, { config }, new Headers({ authorization: "Bearer synthetic-A" }));
    expect(observer).toBeDefined();
    // Captured before registration: the no-report fallback must check at response time.
    if (registered) rewrite(() => {});
    const response = refusal();
    expect(await observer!(response)).toBe(response);
    expect(wasAccountAutoPaused(response)).toBe(!registered);
    if (registered) expectUnpaused(config); else expectPaused(config);
  });
}

test("physical report with matching bearer and conflicting x-api-key grants no API-key pause authority", async () => {
  const config = fixture();
  const route = routedProviderConfig("fixture", config.providers.fixture!);
  const observer = captureAccountAutoPauseAttempt("fixture", route, { config }, new Headers({ authorization: "Bearer synthetic-A" }))!;
  expect(observer).toBeDefined();
  expect(typeof observer.physical).toBe("function");
  observer.physical(true, new Headers({ authorization: "Bearer synthetic-A", "x-api-key": "synthetic-third" }));
  const response = refusal();
  expect(await observer(response)).toBe(response);
  expect(wasAccountAutoPaused(response)).toBe(false);
  expectUnpaused(config);
});
