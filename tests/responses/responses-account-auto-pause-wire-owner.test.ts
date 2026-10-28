import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultConfig, loadConfig, saveConfig } from "../../src/config";
import { observeMainQuotaCredential, observeMainQuotaIdentity } from "../../src/codex/main-account-cache";
import { captureConfigGeneration } from "../../src/lib/state-store-sweeper";
import type { CodexAuthContext } from "../../src/codex/auth-context";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { captureAccountAutoPauseAttempt, wasAccountAutoPaused } from "../../src/oauth/account-auto-pause";
import { clearGenericFailoverHealth } from "../../src/oauth/generic-account-failover";
import { registerUpstreamRewriter, rewriteWebSocketDial, type UpstreamRewriter } from "../../src/plugins/upstream-hooks";
import { clearKeyCooldowns, forgetApiKeyRotationCursor } from "../../src/providers/key-failover";
import { routedProviderConfig } from "../../src/router";
import { resetProviderRequestPacingForTest } from "../../src/providers/request-pacing";
import { clearResponseStateForTests, flushResponseState } from "../../src/responses/state";
import { handleChatCompletions } from "../../src/server/chat-completions";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import { providerFetch } from "../../src/server/responses/fetch-helpers";
import { bindUpstreamRequestCompressionConfig } from "../../src/server/responses/request-compression";
import { gunzipSync } from "node:zlib";
import { handleResponses } from "../../src/server/responses/core";
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


describe("Responses handler translated Chat physical send ownership", () => {
  beforeEach(() => resetProviderRequestPacingForTest());
  afterEach(() => resetProviderRequestPacingForTest());
  for (const plugin of ["none", "identity", "credential replacement then unregister"] as const) {
    test(`${plugin}: ${plugin === "credential replacement then unregister" ? "preserves refusal without pausing either key" : "pauses A and recovers with B"}`, async () => {
      const config = fixture("openai-chat");
      const rewrittenFrom: string[] = [];
      let removeRewriter: (() => void) | undefined;
      const replaced = plugin === "credential replacement then unregister";
      if (plugin !== "none") {
        removeRewriter = registerUpstreamRewriter("responses-chat-wire-owner-fixture", ({ headers, transport }) => {
          expect(transport).toBe("http");
          rewrittenFrom.push(headers.get("authorization")!);
          if (replaced) headers.set("authorization", "Bearer synthetic-third");
        });
        unregister.push(removeRewriter);
      }
      const sends: { url: string; credential: string | null; response: Response }[] = [];
      globalThis.fetch = (async (input, init) => {
        const credential = new Headers(init?.headers).get("authorization");
        // The plugin disappears while the rewritten physical send is in flight.
        if (replaced) removeRewriter!();
        const response = credential === "Bearer synthetic-B"
          ? Response.json({ id: "synthetic-chat", object: "chat.completion", model: "fixture",
            choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
          : refusal();
        sends.push({ url: String(input), credential, response });
        return response;
      }) as typeof fetch;
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "fixture/fixture", input: "synthetic", stream: false, store: false }),
      }), config, { model: "fixture", provider: "fixture" });
      const body = await response.text();
      expect(response.status, body).toBe(replaced ? 403 : 200);
      expect(sends.map(send => send.url)).toEqual(Array(replaced ? 1 : 2).fill("https://example.test/v1/chat/completions"));
      expect(sends.map(send => send.credential)).toEqual(replaced
        ? ["Bearer synthetic-third"] : ["Bearer synthetic-A", "Bearer synthetic-B"]);
      expect(rewrittenFrom).toEqual(plugin === "none" ? []
        : replaced ? ["Bearer synthetic-A"] : ["Bearer synthetic-A", "Bearer synthetic-B"]);
      expect(wasAccountAutoPaused(sends[0]!.response)).toBe(!replaced);
      if (replaced) {
        expect(body).toContain("Your subscription has expired.");
        expectUnpaused(config);
      } else {
        expect(body).toContain("ok");
        expectPaused(config);
      }
    });
  }
});

describe("Codex pool WebSocket observer without a physical report", () => {
  for (const plugin of ["registered after capture then removed", "registered at capture then removed", "none"] as const) {
    test(`${plugin}: ${plugin === "none" ? "counts the refusal and pauses the captured account" : "does not count the rewritten dial refusal"}`, async () => {
      const config = getDefaultConfig();
      config.defaultProvider = "openai"; config.defaultModel = "gpt-5.5";
      config.providers = { openai: { adapter: "openai-responses", authMode: "forward", codexAccountMode: "pool",
        baseUrl: "https://chatgpt.com/backend-api/codex", models: ["gpt-5.5"],
        accountAutoPause: { enabled: true, consecutiveFailures: 1 } } };
      config.codexAccounts = ["fixture-a", "fixture-b"].map(id => ({ id, email: "", isMain: false }));
      config.activeCodexAccountId = "fixture-a";
      const generation = saveCodexAccountCredential("fixture-a", { accessToken: "synthetic-access", refreshToken: "synthetic-refresh",
        expiresAt: Date.now() + 3_600_000, chatgptAccountId: "synthetic-account" });
      saveConfig(config);
      let removeRewriter: (() => void) | undefined;
      let rewrites = 0;
      const install = () => {
        removeRewriter = registerUpstreamRewriter("codex-ws-wire-owner-fixture", target => {
          rewrites++;
          expect(target.transport).toBe("websocket");
          target.headers.set("authorization", "Bearer synthetic-third");
        });
        unregister.push(removeRewriter);
      };
      if (plugin === "registered at capture then removed") install();
      const observer = captureAccountAutoPauseAttempt("openai", config.providers.openai!, { config,
        codex: { kind: "pool", accountId: "fixture-a", generation, writerGeneration: 0,
          accessToken: "synthetic-access", chatgptAccountId: "synthetic-account" },
      }, new Headers({ authorization: "Bearer synthetic-access", "chatgpt-account-id": "synthetic-account" }));
      expect(observer).toBeDefined();
      if (plugin === "registered after capture then removed") install();
      const dial = rewriteWebSocketDial("wss://chatgpt.com/backend-api/codex/responses", {
        authorization: "Bearer synthetic-access", "chatgpt-account-id": "synthetic-account",
      }, undefined);
      expect(rewrites).toBe(plugin === "none" ? 0 : 1);
      expect(dial.headers.authorization).toBe(plugin === "none" ? "Bearer synthetic-access" : "Bearer synthetic-third");
      removeRewriter?.();
      // WebSocket has no HTTP physical report; observe only after the plugin is gone.
      const response = refusal();
      expect(await observer!(response)).toBe(response);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: { type: "permission_error", message: "Your subscription has expired." } });
      const shouldPause = plugin === "none";
      expect(wasAccountAutoPaused(response)).toBe(shouldPause);
      for (const live of [config, loadConfig()]) {
        expect(live.pausedCodexAccountIds?.includes("fixture-a") ?? false).toBe(shouldPause);
        expect(live.pausedCodexAccountIds?.includes("fixture-b") ?? false).toBe(false);
        if (shouldPause) expect(live.codexAccountPauseState?.["fixture-a"]?.details?.reason).toBe("subscription_expired");
        else expect(live.codexAccountPauseState?.["fixture-a"]).toBeUndefined();
      }
    });
  }
});

describe("nested auto-pause observers on one physical response", () => {
  test("count a refusal once per account when both observers see it", async () => {
    const config = fixture();
    config.providers.fixture!.accountAutoPause = { enabled: true, consecutiveFailures: 2 };
    saveConfig(config);
    const route = routedProviderConfig("fixture", config.providers.fixture!);
    const headers = () => new Headers({ authorization: "Bearer synthetic-A" });
    const outer = captureAccountAutoPauseAttempt("fixture", route, { config }, headers())!;
    const inner = captureAccountAutoPauseAttempt("fixture", route, { config }, headers())!;
    inner.physical(true, headers());
    const first = refusal();
    await inner(first);
    await outer(first);
    expect(wasAccountAutoPaused(first)).toBe(false);
    expectUnpaused(config);
    // The streak still holds one refusal: the next owned refusal reaches the threshold of two.
    const next = captureAccountAutoPauseAttempt("fixture", route, { config }, headers())!;
    next.physical(true, headers());
    const second = refusal();
    await next(second);
    expect(wasAccountAutoPaused(second)).toBe(true);
    expectPaused(config);
  });

  test("an unreported observer never attributes a response reported as sent with another credential", async () => {
    const config = fixture();
    const route = routedProviderConfig("fixture", config.providers.fixture!);
    const headers = new Headers({ authorization: "Bearer synthetic-A" });
    const outer = captureAccountAutoPauseAttempt("fixture", route, { config }, headers)!;
    const inner = captureAccountAutoPauseAttempt("fixture", route, { config }, headers)!;
    inner.physical(true, new Headers({ authorization: "Bearer synthetic-third" }));
    const response = refusal();
    await inner(response);
    await outer(response);
    expect(wasAccountAutoPaused(response)).toBe(false);
    expectUnpaused(config);
  });
});

function codexFixture(kind: "pool" | "main-pool") {
  const config = getDefaultConfig();
  config.defaultProvider = "openai";
  config.providers = { openai: { adapter: "openai-responses", authMode: "forward", codexAccountMode: "pool",
    baseUrl: "https://chatgpt.com/backend-api/codex", accountAutoPause: { enabled: true, consecutiveFailures: 1 } } };
  const accountId = kind === "pool" ? "fixture-a" : "__main__";
  config.codexAccounts = [{ id: accountId, email: "", isMain: kind === "main-pool" }, { id: "fixture-b", email: "", isMain: false }];
  config.activeCodexAccountId = accountId;
  let codex: CodexAuthContext;
  if (kind === "pool") {
    const generation = saveCodexAccountCredential(accountId, { accessToken: "synthetic-access", refreshToken: "synthetic-refresh",
      expiresAt: Date.now() + 3_600_000, chatgptAccountId: "synthetic-account" });
    codex = { kind, accountId, generation, writerGeneration: 0, accessToken: "synthetic-access", chatgptAccountId: "synthetic-account" };
  } else {
    observeMainQuotaIdentity("synthetic-account");
    const mainQuotaWriter = observeMainQuotaCredential("synthetic-access", "synthetic-account")!;
    codex = { kind, accountId, writerGeneration: captureConfigGeneration(), mainQuotaWriter,
      accessToken: "synthetic-access", chatgptAccountId: "synthetic-account" };
  }
  saveConfig(config);
  const headers = new Headers({ authorization: "Bearer synthetic-access", "chatgpt-account-id": "synthetic-account" });
  const capture = (sent = headers) => captureAccountAutoPauseAttempt("openai", config.providers.openai!, { config, codex }, sent);
  const expectPause = (paused: boolean) => {
    for (const live of [config, loadConfig()]) {
      expect(live.pausedCodexAccountIds?.includes(accountId) ?? false).toBe(paused);
      expect(live.pausedCodexAccountIds?.includes("fixture-b") ?? false).toBe(false);
      if (paused) expect(live.codexAccountPauseState?.[accountId]?.details?.reason).toBe("subscription_expired");
      else expect(live.codexAccountPauseState?.[accountId]).toBeUndefined();
    }
  };
  return { headers, capture, expectPause };
}

for (const kind of ["pool", "main-pool"] as const) {
  for (const change of ["workspace replaced", "workspace deleted", "organization added", "organization changed", "organization deleted",
    "project added", "project changed", "project deleted", "matching headers", "matching selectors"] as const) {
    test(`Codex ${kind} physical report: ${change}`, async () => {
      const f = codexFixture(kind);
      if (change === "organization changed" || change === "organization deleted" || change === "matching selectors") f.headers.set("openai-organization", "synthetic-org");
      if (change === "project changed" || change === "project deleted" || change === "matching selectors") f.headers.set("openai-project", "synthetic-project");
      const observer = f.capture();
      expect(observer).toBeDefined();
      const sent = new Headers(f.headers);
      if (change === "workspace replaced") sent.set("chatgpt-account-id", "synthetic-other-account");
      if (change === "workspace deleted") sent.delete("chatgpt-account-id");
      if (change === "organization added" || change === "organization changed") sent.set("openai-organization", "synthetic-other-org");
      if (change === "organization deleted") sent.delete("openai-organization");
      if (change === "project added" || change === "project changed") sent.set("openai-project", "synthetic-other-project");
      if (change === "project deleted") sent.delete("openai-project");
      expect(sent.get("authorization")).toBe("Bearer synthetic-access");
      observer!.physical(true, sent);
      const response = refusal();
      expect(await observer!(response)).toBe(response);
      expect(response.status).toBe(403);
      const shouldPause = change === "matching headers" || change === "matching selectors";
      expect(wasAccountAutoPaused(response)).toBe(shouldPause);
      f.expectPause(shouldPause);
    });
  }
  for (const workspace of ["missing", "different"] as const) {
    test(`Codex ${kind} capture: ${workspace} workspace grants no observer`, () => {
      const f = codexFixture(kind);
      if (workspace === "missing") f.headers.delete("chatgpt-account-id");
      else f.headers.set("chatgpt-account-id", "synthetic-other-account");
      expect(f.capture()).toBeUndefined();
      f.expectPause(false);
    });
  }
  for (const registered of [false, true]) {
    test(`Codex ${kind} no physical report with workspace: ${registered ? "rewriter blocks pause" : "no rewriter permits pause"}`, async () => {
      const f = codexFixture(kind);
      expect(f.headers.get("chatgpt-account-id")).toBe("synthetic-account");
      const observer = f.capture();
      expect(observer).toBeDefined();
      if (registered) rewrite(() => {});
      const response = refusal();
      expect(await observer!(response)).toBe(response);
      expect(wasAccountAutoPaused(response)).toBe(!registered);
      f.expectPause(!registered);
    });
  }
}

describe("auto-pause ownership on compressed native Responses sends", () => {
  const codexUrl = "https://chatgpt.com/backend-api/codex/responses";
  for (const rewritten of [false, true]) {
    test(`${rewritten ? "rewritten credential under gzip does not pause" : "wire owner under gzip pauses"}; the report carries post-compression headers`, async () => {
      bindUpstreamRequestCompressionConfig({ upstreamRequestCompression: "gzip" });
      try {
        const config = fixture("openai-responses");
        const route = routedProviderConfig("fixture", config.providers.fixture!);
        if (rewritten) rewrite(t => { t.headers.set("authorization", "Bearer synthetic-third"); });
        const original = JSON.stringify({ input: "x".repeat(4096) });
        const reported: Headers[] = [];
        const sends: { headers: Headers; body: Uint8Array }[] = [];
        const upstream = refusal();
        const physical = (async (_input, init) => {
          sends.push({ headers: new Headers(init?.headers), body: new Uint8Array(init?.body as ArrayBufferLike) });
          return upstream;
        }) as typeof fetch;
        const send = providerFetch(Object.assign(route, { fetch: physical }), undefined, {
          providerName: "fixture", httpOnly: true,
          accountAutoPause: (name, provider, headers) => {
            const observer = captureAccountAutoPauseAttempt(name, provider, { config }, headers)!;
            expect(observer).toBeDefined();
            const report = observer.physical;
            observer.physical = (sameDestination, wire) => { reported.push(new Headers(wire)); report(sameDestination, wire); };
            return observer;
          },
        });
        const response = await send(codexUrl, { method: "POST",
          headers: { authorization: "Bearer synthetic-A", "content-type": "application/json", "content-length": String(original.length) }, body: original });
        // Consuming the body releases the per-key pacing slot for the next case.
        expect(await response.json()).toEqual({ error: { type: "permission_error", message: "Your subscription has expired." } });
        expect(sends).toHaveLength(1);
        expect(reported).toHaveLength(1);
        for (const headers of [reported[0]!, sends[0]!.headers]) {
          expect(headers.get("content-encoding")).toBe("gzip");
          expect(headers.get("content-length")).toBeNull();
          expect(headers.get("authorization")).toBe(rewritten ? "Bearer synthetic-third" : "Bearer synthetic-A");
        }
        expect(new TextDecoder().decode(gunzipSync(sends[0]!.body))).toBe(original);
        expect(wasAccountAutoPaused(response)).toBe(!rewritten);
        if (rewritten) expectUnpaused(config); else expectPaused(config);
      } finally {
        bindUpstreamRequestCompressionConfig(null);
      }
    });
  }
});

