import { afterEach, beforeEach, expect, test } from "bun:test";
import { createAnthropicInstanceFixture, type AnthropicInstanceFixture } from "../helpers/anthropic-instance-fixture";
let f: AnthropicInstanceFixture;
beforeEach(async () => { f = await createAnthropicInstanceFixture(); await f.seed(); });
afterEach(async () => { await f?.dispose(); });

test("search planner inherits B, honors explicit A and never auto-selects B without a parent", async () => {
  const { planWebSearch } = await import("../../src/web-search");
  const { parseRequest } = await import("../../src/responses/parser");
  const parsed = parseRequest({ model: f.model, input: "Find documentation", tools: [{ type: "web_search" }] });
  f.config.webSearchSidecar = { backend: "anthropic" };
  const plan = () => planWebSearch(f.config, parsed, false, f.config.providers.anthropic2!, f.model, undefined, { providerName: "anthropic2" });
  expect(plan()?.anthropicSidecar?.providerName).toBe("anthropic2");
  f.config.webSearchSidecar.anthropicInstance = "anthropic";
  expect(plan()?.anthropicSidecar?.providerName).toBe("anthropic");
  delete f.config.webSearchSidecar.anthropicInstance;
  expect(planWebSearch(f.config, parsed, false, f.config.providers.anthropic2!, f.model)?.anthropicSidecar?.providerName).toBe("anthropic");
  delete f.config.providers.anthropic;
  expect(planWebSearch(f.config, parsed, false, f.config.providers.anthropic2!, f.model)).toBeUndefined();
  expect(plan()?.anthropicSidecar?.providerName).toBe("anthropic2");
});

test("selected empty B refuses instead of borrowing healthy A for search", async () => {
  const { findAnthropicSidecarProvider } = await import("../../src/web-search/sidecar-providers");
  const { resolveAlphaSearchSidecar } = await import("../../src/web-search/alpha-search");
  const { AnthropicHelperUnavailableError } = await import("../../src/sidecar/auth");
  await f.store.mutateStore(store => { delete store.anthropic2; });
  f.config.webSearchSidecar = { backend: "anthropic", anthropicInstance: "anthropic2" };
  expect(() => findAnthropicSidecarProvider(f.config)).toThrow(AnthropicHelperUnavailableError);
  expect(resolveAlphaSearchSidecar(f.config)).toEqual({ status: "missing-credential", backend: "anthropic" });
  expect(f.ledger.sends).toHaveLength(0);
});

test("search executor sends the selected B snapshot and rejects a stale marked target", async () => {
  const { runAnthropicWebSearch } = await import("../../src/web-search/anthropic-executor");
  const { instanceFixtureCredential } = await import("../helpers/anthropic-instance-fixture");
  const calls: string[] = [];
  globalThis.fetch = (async (_url, init) => {
    const token = new Headers(init?.headers).get("authorization")!.slice(7);
    const slot = [1, 2].find(n => instanceFixtureCredential("anthropic2", n).access === token)!;
    f.ledger.record({ instance: "anthropic2", accountId: f.ids[slot - 1]!, token });
    calls.push(token);
    return new Response('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"fixture result"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');
  }) as typeof fetch;
  const outcome = await runAnthropicWebSearch("fixture query", "anthropic2", f.config.providers.anthropic2!,
    { model: f.model, reasoning: "low", timeoutMs: 1000 }, undefined, f.config);
  expect(outcome.text).toContain("fixture result");
  expect(calls).toHaveLength(1);
  delete f.config.providers.anthropic2!.anthropicOAuthInstance;
  const refused = await runAnthropicWebSearch("fixture query", "anthropic2", f.config.providers.anthropic2!,
    { model: f.model, reasoning: "low", timeoutMs: 1000 }, undefined, f.config);
  expect(refused.error).toBeDefined();
  expect(calls).toHaveLength(1);
});

test("unavailable selected pool yields no search plan and a disarmed bridge, never a thrown main request", async () => {
  const { planWebSearch } = await import("../../src/web-search");
  const { resolvePassthroughWebSearchBridgeAuth } = await import("../../src/web-search/passthrough-bridge");
  const { parseRequest } = await import("../../src/responses/parser");
  const parsed = parseRequest({ model: f.model, input: "Find documentation", tools: [{ type: "web_search" }] });
  await f.store.mutateStore(store => { delete store.anthropic2; });
  f.config.webSearchSidecar = { backend: "anthropic" };
  expect(planWebSearch(f.config, parsed, false, f.config.providers.anthropic2!, f.model, undefined, { providerName: "anthropic2" })).toBeUndefined();
  expect(resolvePassthroughWebSearchBridgeAuth("anthropic", f.config, undefined, "anthropic2")).toEqual({});
  f.config.webSearchSidecar.anthropicInstance = "anthropic2";
  expect(planWebSearch(f.config, parsed, false, f.config.providers.anthropic!, f.model, undefined, { providerName: "anthropic" })).toBeUndefined();
  expect(resolvePassthroughWebSearchBridgeAuth("anthropic", f.config)).toEqual({});
  expect(f.ledger.sends).toHaveLength(0);
});

test("a trailing-slash baseUrl reaches the same Messages URL the send fence admits", async () => {
  const { runAnthropicWebSearch } = await import("../../src/web-search/anthropic-executor");
  f.config.providers.anthropic2!.baseUrl = "https://api.anthropic.com/";
  const urls: string[] = [];
  globalThis.fetch = (async url => {
    urls.push(String(url));
    return new Response('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"fixture result"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');
  }) as typeof fetch;
  const outcome = await runAnthropicWebSearch("fixture query", "anthropic2", f.config.providers.anthropic2!,
    { model: f.model, reasoning: "low", timeoutMs: 1000 }, undefined, f.config);
  expect(outcome.error).toBeUndefined();
  expect(urls).toEqual(["https://api.anthropic.com/v1/messages"]);
});
