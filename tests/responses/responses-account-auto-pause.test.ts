import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultConfig, saveConfig } from "../../src/config";
import { getAccountSet, saveCredential, setActiveAccount } from "../../src/oauth/store";
import { handleResponses } from "../../src/server/responses/core";
import { flushResponseState, clearResponseStateForTests } from "../../src/responses/state";
import { clearGenericFailoverHealth } from "../../src/oauth/generic-account-failover";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import type { OcxConfig } from "../../src/types";

const originalHome = process.env.OPENCODEX_HOME;
const originalFetch = globalThis.fetch;
let home: string;
let releaseSpend: () => void;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-auto-pause-runtime-"));
  process.env.OPENCODEX_HOME = home;
  releaseSpend = acquireOwnedSpendHome();
  clearGenericFailoverHealth();
});
afterEach(async () => {
  await flushResponseState(); clearResponseStateForTests();
  releaseSpend(); clearGenericFailoverHealth();
  globalThis.fetch = originalFetch;
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = originalHome;
  removeTreeWithRetry(home);
});
const orgRefusal = () => Response.json({ error: { type: "permission_error", message: "OAuth authentication is currently not allowed for this organization" } }, { status: 403 });
const completion = () => Response.json({ id: "synthetic-completion", object: "chat.completion", model: "fixture", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
function configFor(name: string, oauth: boolean): OcxConfig {
  const config = getDefaultConfig();
  config.defaultProvider = name; config.defaultModel = "fixture";
  config.providers = { [name]: { baseUrl: "https://example.test/v1", adapter: "openai-chat", authMode: oauth ? "oauth" : "key", models: ["fixture"], accountAutoPause: { enabled: true },
    ...(!oauth ? { apiKey: "synthetic-A", apiKeyPool: [{ id: "A", key: "synthetic-A" }, { id: "B", key: "synthetic-B" }] } : {}),
  } };
  saveConfig(config);
  return config;
}
async function send(config: OcxConfig, name: string, sendBudget?: import("../../src/lib/request-execution-budget").RequestExecutionBudget) {
  const response = await handleResponses(new Request("http://localhost/v1/responses", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: `${name}/fixture`, input: "synthetic", stream: false, store: false }) }), config, { model: "fixture", provider: name }, { sendBudget });
  const text = await response.text();
  return { status: response.status, text };
}
for (const oauth of [true, false]) {
  test(`${oauth ? "OAuth" : "key"} HTTP path pauses at threshold and serves the same request with its sibling`, async () => {
    const name = oauth ? "command-code" : "fixture";
    if (oauth) {
      for (let n = 0; n < 2; n++) await saveCredential(name, { access: `synthetic-${n}`, refresh: `synthetic-refresh-${n}`, expires: Date.now() + 3_600_000, accountId: `synthetic-${n}`, source: "oauth" });
      await setActiveAccount(name, getAccountSet(name)!.accounts[0]!.id);
    }
    const config = configFor(name, oauth);
    const sends: string[] = [];
    globalThis.fetch = (async (_input, init) => {
      const auth = new Headers(init?.headers).get("authorization")!;
      sends.push(auth);
      return auth === `Bearer synthetic-${oauth ? "0" : "A"}` ? orgRefusal() : completion();
    }) as typeof fetch;
    const first = await send(config, name);
    expect(first.status, first.text).toBe(403);
    expect(sends.length).toBe(1);
    const second = await send(config, name);
    expect(second.status, second.text).toBe(200);
    expect(sends).toEqual([`Bearer synthetic-${oauth ? "0" : "A"}`, `Bearer synthetic-${oauth ? "0" : "A"}`, `Bearer synthetic-${oauth ? "1" : "B"}`]);
    const third = await send(config, name);
    expect(third.status, third.text).toBe(200);
    expect(sends.at(-1)).toBe(`Bearer synthetic-${oauth ? "1" : "B"}`);
  });
}

test("default-off HTTP requests preserve the refusal and never rotate/pause", async () => {
  const config = configFor("fixture", false);
  delete config.providers.fixture!.accountAutoPause;
  saveConfig(config);
  let sends = 0;
  globalThis.fetch = (async () => { sends++; return orgRefusal(); }) as typeof fetch;
  for (let n = 0; n < 3; n++) expect((await send(config, "fixture")).status).toBe(403);
  expect(sends).toBe(3);
  expect(config.providers.fixture!.apiKeyPool![0]!.disabled).not.toBe(true);
});

test("Anthropic organization refusal pauses and rebuilds the in-flight OAuth request", async () => {
  const { deriveOAuthProviderConfig } = await import("../../src/providers/derive");
  const { clearAnthropicAccountPoolState } = await import("../../src/oauth/anthropic-routing");
  clearAnthropicAccountPoolState();
  for (let n = 0; n < 2; n++) await saveCredential("anthropic", { access: `synthetic-${n}`, refresh: `synthetic-refresh-${n}`, expires: Date.now() + 3_600_000, accountId: `synthetic-${n}`, source: "oauth" });
  const ids = getAccountSet("anthropic")!.accounts.map(a => a.id);
  await setActiveAccount("anthropic", ids[0]!);
  const config = getDefaultConfig();
  config.providers = { anthropic: { ...deriveOAuthProviderConfig("anthropic")!, models: ["fixture"], accountAutoPause: { enabled: true } } };
  config.defaultProvider = "anthropic"; config.defaultModel = "fixture";
  saveConfig(config);
  const sends: string[] = [];
  globalThis.fetch = (async (_input, init) => {
    const bearer = new Headers(init?.headers).get("authorization")!;
    sends.push(bearer);
    return bearer === "Bearer synthetic-0" ? orgRefusal() : Response.json({ id: "synthetic-message", type: "message", role: "assistant", model: "fixture", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
  }) as typeof fetch;
  try {
    const first = await send(config, "anthropic");
    expect(first.status, first.text).toBe(403);
    const second = await send(config, "anthropic");
    expect(second.status, second.text).toBe(200);
    expect(sends).toEqual(["Bearer synthetic-0", "Bearer synthetic-0", "Bearer synthetic-1"]);
    expect(getAccountSet("anthropic")!.accounts[0]!.paused).toBe(true);
  } finally { clearAnthropicAccountPoolState(); }
});


test("auto-pause never buys a sibling send when the request has only one send", async () => {
  const { createRequestExecutionBudget, CODEX_TEXT_GUARDED_BUDGET_POLICY } = await import("../../src/lib/request-execution-budget");
  const config = configFor("fixture", false);
  config.providers.fixture!.accountAutoPause = { enabled: true, consecutiveFailures: 1 };
  saveConfig(config);
  let sends = 0;
  globalThis.fetch = (async () => { sends++; return orgRefusal(); }) as typeof fetch;
  const budget = createRequestExecutionBudget({ ...CODEX_TEXT_GUARDED_BUDGET_POLICY, maxTotalModelSends: 1, baseSendAllowance: 1, finalRecoveryAllowance: 0 });
  const result = await send(config, "fixture", budget);
  expect(result.status, result.text).toBe(403);
  expect(sends).toBe(1);
  expect(config.providers.fixture!.apiKeyPool![0]!.disabled).toBe(true);
});

test("Codex pool permanent refusal pauses without forcing reauth and retries a sibling", async () => {
  const { saveCodexAccountCredential } = await import("../../src/codex/account-store");
  const { updateAccountQuota, clearAccountNeedsReauth } = await import("../../src/codex/auth-api");
  const { clearCodexUpstreamHealth, clearThreadAccountMap } = await import("../../src/codex/routing");
  const config = getDefaultConfig();
  config.providers = { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", codexAccountMode: "pool", upstreamWebsocket: false, accountAutoPause: { enabled: true }, models: ["gpt-5.5"] } };
  config.defaultProvider = "openai"; config.defaultModel = "gpt-5.5";
  config.openaiProviderTierVersion = 2;
  config.codexAccounts = ["fixture-a", "fixture-b"].map(id => ({ id, email: "", isMain: false, chatgptAccountId: `synthetic-${id}` }));
  config.activeCodexAccountId = "fixture-a";
  for (const id of ["fixture-a", "fixture-b"]) {
    saveCodexAccountCredential(id, { accessToken: `synthetic-${id}`, refreshToken: `synthetic-refresh-${id}`, expiresAt: Date.now() + 3_600_000, chatgptAccountId: `synthetic-${id}` });
    updateAccountQuota(id, 10); clearAccountNeedsReauth(id);
  }
  saveConfig(config);
  clearCodexUpstreamHealth(); clearThreadAccountMap();
  const sends: string[] = [];
  globalThis.fetch = (async (input, init) => {
    if (String(input).includes("/models")) return Response.json({ models: [{ slug: "gpt-5.5", supported_in_api: true, visibility: "list" }] });
    const bearer = new Headers(init?.headers).get("authorization")!;
    sends.push(bearer);
    return bearer === "Bearer synthetic-fixture-a" ? orgRefusal() : Response.json({ id: "synthetic-response", object: "response", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });
  }) as typeof fetch;
  const request = () => new Request("http://localhost/v1/responses", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "openai/gpt-5.5", input: "synthetic", stream: false, store: false }) });
  try {
    const first = await handleResponses(request(), config, { model: "gpt-5.5", provider: "openai" });
    const firstText = await first.text();
    expect(first.status, firstText).toBe(403);
    const second = await handleResponses(request(), config, { model: "gpt-5.5", provider: "openai" });
    const secondText = await second.text();
    expect(second.status, secondText).toBe(200);
    expect(config.pausedCodexAccountIds).toContain("fixture-a");
    expect(sends).toEqual(["Bearer synthetic-fixture-a", "Bearer synthetic-fixture-a", "Bearer synthetic-fixture-b"]);
  } finally { clearCodexUpstreamHealth(); clearThreadAccountMap(); }
});

test("native Messages keeps OAuth auto-pause and current-request rotation", async () => {
  const { handleClaudeMessages } = await import("../../src/server/claude-messages");
  const { clearAnthropicAccountPoolState } = await import("../../src/oauth/anthropic-routing");
  clearAnthropicAccountPoolState();
  for (let n = 0; n < 2; n++) await saveCredential("anthropic", { access: `synthetic-native-${n}`, refresh: `synthetic-refresh-${n}`, expires: Date.now() + 3_600_000, accountId: `synthetic-native-${n}`, source: "oauth" });
  await setActiveAccount("anthropic", getAccountSet("anthropic")!.accounts[0]!.id);
  const config = getDefaultConfig();
  config.providers = { anthropic: { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "oauth", models: ["claude-sonnet-4-5"], accountAutoPause: { enabled: true } } };
  config.defaultProvider = "anthropic";
  config.protocols = { rollout: { managedMessagesNative: true, managedMessagesNativeOAuth: true } };
  saveConfig(config);
  const sends: string[] = [];
  globalThis.fetch = (async (_input, init) => {
    const bearer = new Headers(init?.headers).get("authorization")!;
    sends.push(bearer);
    return bearer === "Bearer synthetic-native-0" ? orgRefusal() : Response.json({ id: "synthetic-native", type: "message", role: "assistant", model: "claude-sonnet-4-5", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
  }) as typeof fetch;
  const sendNative = () => handleClaudeMessages(new Request("http://localhost/v1/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "anthropic/claude-sonnet-4-5", max_tokens: 64, messages: [{ role: "user", content: "synthetic" }] }) }), config, { model: "", provider: "" });
  try {
    const first = await sendNative(); await first.text(); expect(first.status).toBe(403);
    const second = await sendNative(); const text = await second.text(); expect(second.status, text).toBe(200);
    expect(sends).toEqual(["Bearer synthetic-native-0", "Bearer synthetic-native-0", "Bearer synthetic-native-1"]);
  } finally { clearAnthropicAccountPoolState(); }
});

test("provider-specific exact send total preserves the original refusal", async () => {
  const config = configFor("fixture", false);
  config.providers.fixture!.accountAutoPause = { enabled: true, consecutiveFailures: 1 };
  config.providers.fixture!.transientRetryOn5xx = { attempts: 1 };
  saveConfig(config);
  let sends = 0;
  globalThis.fetch = (async () => { sends++; return orgRefusal(); }) as typeof fetch;
  const response = await send(config, "fixture");
  expect(response.status, response.text).toBe(403);
  expect(sends).toBe(1);
});

for (const wire of ["chat", "messages"] as const) for (const distributed of [false, true]) {
  test(`native ${wire} recovers auto-pause reached after a same-key 429 replay (distributed=${distributed})`, async () => {
    const config = configFor("fixture", false);
    const provider = config.providers.fixture!;
    provider.accountAutoPause = { enabled: true, consecutiveFailures: 1 };
    if (distributed) provider.requestPacing = { enabled: true, keySelection: "round-robin", keys: { maxConcurrentRequests: 1 } };
    provider.retryOn429 = { attempts: 1, intervalMs: 100, maxIntervalMs: 100, respectRetryAfter: false };
    if (wire === "messages") {
      provider.adapter = "anthropic"; provider.baseUrl = "https://api.anthropic.com";
      config.protocols = { rollout: { managedMessagesNative: true } };
    }
    saveConfig(config);
    const sends: string[] = [];
    globalThis.fetch = (async (_input, init) => {
      const headers = new Headers(init?.headers);
      sends.push(headers.get("authorization") ?? headers.get("x-api-key") ?? "missing");
      if (sends.length === 1) return Response.json({ error: { type: "rate_limit_error", message: "synthetic rate limit" } }, { status: 429 });
      if (sends.length === 2) return orgRefusal();
      return wire === "chat" ? completion() : Response.json({ id: "synthetic-message", type: "message", role: "assistant", model: "fixture", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
    }) as typeof fetch;
    const body = { model: "fixture/fixture", max_tokens: 64, messages: [{ role: "user", content: "synthetic" }], stream: false };
    const req = new Request(`http://localhost/v1/${wire === "chat" ? "chat/completions" : "messages"}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const response = wire === "chat"
      ? await (await import("../../src/server/chat-completions")).handleChatCompletions(req, config, { model: "fixture", provider: "fixture" })
      : await (await import("../../src/server/claude-messages")).handleClaudeMessages(req, config, { model: "fixture", provider: "fixture" });
    const text = await response.text();
    expect(response.status, text).toBe(200);
    expect(sends.length).toBe(3);
    expect(sends[2]).toContain("synthetic-B");
    expect(config.providers.fixture!.apiKeyPool![0]!.disabled).toBe(true);
  });
}
