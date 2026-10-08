import { afterEach, beforeEach, expect, test } from "bun:test";
import { createAnthropicInstanceFixture, type AnthropicInstanceFixture } from "../helpers/anthropic-instance-fixture";
import type { OcxProviderConfig } from "../../src/types";
let fixture: AnthropicInstanceFixture;
let auth: typeof import("../../src/sidecar/auth");
let binding: typeof import("../../src/sidecar/anthropic-binding");
beforeEach(async () => {
  fixture = await createAnthropicInstanceFixture();
  await fixture.seed();
  auth = await import("../../src/sidecar/auth");
  binding = await import("../../src/sidecar/anthropic-binding");
});
afterEach(() => fixture?.dispose());

test("generated descriptions cache within one instance but not across pools", async () => {
  const vision = await import("../../src/vision");
  const { parseRequest } = await import("../../src/responses/parser");
  vision.resetVisionDescriptionCache();
  const calls: string[] = [];
  globalThis.fetch = (async (_url, init) => {
    const token = new Headers(init?.headers).get("authorization") ?? "";
    const instance = token.includes("anthropic2") ? "anthropic2" : "anthropic";
    calls.push(instance);
    return new Response(`data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: `description ${instance}` } })}\n\ndata: {"type":"message_stop"}\n\n`,
      { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  try {
    for (const instance of ["anthropic", "anthropic", "anthropic2", "anthropic2"] as const) {
      const parsed = parseRequest({ model: fixture.model, input: [{ role: "user", content: [
        { type: "input_text", text: "Describe this" },
        { type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" },
      ] }] });
      await vision.describeImagesInPlace(parsed, {
        backend: "anthropic",
        anthropicSidecar: { providerName: instance, provider: fixture.config.providers[instance]!, config: fixture.config },
        settings: { model: fixture.model, reasoning: "low", timeoutMs: 1000 },
        maxDescriptionsPerTurn: 1,
      }, new Headers());
      expect(JSON.stringify(parsed.context.messages)).toContain(`description ${instance}`);
    }
    expect(calls).toEqual(["anthropic", "anthropic2"]);
  } finally { vision.resetVisionDescriptionCache(); }
});

test("Anthropic family inherits B only after backend choice; explicit A stays an explicit mixed target", () => {
  const config = fixture.config;
  expect(auth.resolveAnthropicHelperInstance(config, { backendFamily: "openai", parentProviderName: "anthropic2" })).toBeUndefined();
  expect(auth.resolveAnthropicHelperInstance(config, { backendFamily: "anthropic", parentProviderName: "anthropic2" })).toBe("anthropic2");
  expect(auth.resolveAnthropicHelperInstance(config, { backendFamily: "anthropic", parentProviderName: "anthropic2", anthropicInstance: "anthropic" })).toBe("anthropic");
  expect(auth.resolveAnthropicHelperInstance(config, { backendFamily: "anthropic", parentProviderName: "unrelated" })).toBeUndefined();
  expect(auth.resolveSidecarAuth(config).anthropicProviderName).toBe("anthropic");
  delete config.providers.anthropic;
  expect(auth.resolveSidecarAuth(config).isAnthropicAuth).toBe(false);
});

test("unavailable selected B never returns a legacy-discovery fallback", () => {
  delete fixture.config.providers.anthropic2;
  expect(() => auth.resolveAnthropicHelperInstance(fixture.config, {
    backendFamily: "anthropic", parentProviderName: "anthropic2",
  })).toThrow(auth.AnthropicHelperUnavailableError);
  expect(() => auth.resolveSidecarAuth(fixture.config, "anthropic2")).toThrow(auth.AnthropicHelperUnavailableError);
  expect(auth.resolveSidecarAuth(fixture.config).anthropicProviderName).toBe("anthropic");
});

for (const instance of ["anthropic", "anthropic2"] as const) {
  test(`${instance}: helper snapshot uses its model route and physical owner`, async () => {
    const config = fixture.config;
    const pool = { enabled: true, routes: [{ name: "helper", match: "*", accounts: [fixture.ids[1]] }] };
    if (instance === "anthropic") config.anthropicAccountPool = pool;
    else config.providers.anthropic2!.anthropicAccountPool = pool;
    const snapshot = await binding.resolveAnthropicHelperSnapshot(config, instance, fixture.model);
    expect(snapshot.provider).toBe(instance);
    expect(snapshot.accountId).toBe(fixture.ids[1]);
    // A helper reads the pool's selection; it never promotes the active pointer.
    expect(fixture.store.getAccountSet(instance)?.activeAccountId).toBe(fixture.ids[0]);
    let sends = 0;
    globalThis.fetch = (async (_url, init) => {
      sends++;
      fixture.ledger.record({ instance, accountId: snapshot.accountId,
        token: new Headers(init?.headers).get("authorization")!.slice(7), model: fixture.model });
      return new Response(null, { status: 200, headers: { "anthropic-ratelimit-unified-5h-utilization": "0.37" } });
    }) as typeof fetch;
    const target = config.providers[instance]!.baseUrl;
    await binding.fetchAnthropicHelper(config, snapshot, fixture.model, target, `${target}/v1/messages`,
      { headers: { authorization: `Bearer ${snapshot.accessToken}` } });
    expect(sends).toBe(1);
    expect(fixture.quota.getCachedProviderAccountQuota(instance, snapshot.accountId)?.fiveHourPercent).toBe(37);
    config.providers[instance]!.disabled = true;
    await expect(binding.fetchAnthropicHelper(config, snapshot, fixture.model, target, `${target}/v1/messages`,
      { headers: { authorization: `Bearer ${snapshot.accessToken}` } })).rejects.toThrow(auth.AnthropicHelperUnavailableError);
    expect(sends).toBe(1);
  });
}

test("a custom unmarked anthropic2 parent is not Pool 2 and is never inherited", () => {
  delete fixture.config.providers.anthropic2!.anthropicOAuthInstance;
  expect(auth.resolveAnthropicHelperInstance(fixture.config, { backendFamily: "anthropic", parentProviderName: "anthropic2" })).toBeUndefined();
  expect(auth.resolveSidecarAuth(fixture.config).anthropicProviderName).toBe("anthropic");
});

test("a paused active account does not make a pool with another usable account unavailable", async () => {
  await fixture.store.mutateStore(store => { store.anthropic2!.accounts.find(row => row.id === fixture.ids[0])!.paused = true; });
  expect(auth.resolveAnthropicHelperInstance(fixture.config, { backendFamily: "anthropic", parentProviderName: "anthropic2" })).toBe("anthropic2");
  const snapshot = await binding.resolveAnthropicHelperSnapshot(fixture.config, "anthropic2", fixture.model);
  expect(snapshot.accountId).toBe(fixture.ids[1]);
  await fixture.store.mutateStore(store => { store.anthropic2!.accounts.forEach(row => { row.paused = true; }); });
  expect(() => auth.resolveSidecarAuth(fixture.config, "anthropic2")).toThrow(auth.AnthropicHelperUnavailableError);
});

test("vision planner turns an unavailable selected pool into no plan instead of failing the request", async () => {
  const vision = await import("../../src/vision");
  const { parseRequest } = await import("../../src/responses/parser");
  await fixture.store.mutateStore(store => { delete store.anthropic2; });
  fixture.config.visionSidecar = { backend: "anthropic", anthropicInstance: "anthropic2" };
  const target: OcxProviderConfig = { ...fixture.config.providers.anthropic!, modelCapabilities: { [fixture.model]: { inputModalities: ["text"] } } };
  const parsed = parseRequest({ model: fixture.model, input: [{ role: "user", content: [
    { type: "input_text", text: "Describe this" },
    { type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" },
  ] }] });
  expect(vision.planVisionSidecar(fixture.config, target, fixture.model, parsed, undefined, { providerName: "anthropic" })).toBeUndefined();
  delete fixture.config.visionSidecar.anthropicInstance;
  expect(vision.planVisionSidecar(fixture.config, target, fixture.model, parsed, undefined, { providerName: "anthropic" })?.anthropicSidecar?.providerName).toBe("anthropic");
});
