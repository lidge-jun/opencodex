/**
 * `service_tier` is an OpenAI-only Responses parameter. Fast mode used to inject it
 * for EVERY Responses provider; now a provider-level `supportsServiceTier` capability
 * gates it after the final route is settled (tri-state): canonical OpenAI providers
 * keep the fast-mode behavior (`true`), DeepSeek/Volcengine strip it (`false`), and
 * unclassified custom providers preserve caller-supplied values untouched without
 * ever receiving an injection (PR #860 family).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { providerConfigSeed, enrichProviderFromRegistry } from "../src/providers/derive";
import { getProviderRegistryEntry } from "../src/providers/registry";
import type { RequestLogContext } from "../src/server/request-log";
import { applyServiceTierGate, handleResponses } from "../src/server/responses/core";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

describe("registry capability reaches saved configs without overriding them", () => {
  test("the registry holds the defaults; the seed stays free of them so explicit config stays distinguishable", () => {
    const entry = getProviderRegistryEntry("deepseek")!;
    expect(entry.supportsServiceTier).toBe(false);
    expect(entry.preserveResponsesReasoningContent).toBe(true);
    expect(getProviderRegistryEntry("openai-apikey")!.supportsServiceTier).toBe(true);
    expect(getProviderRegistryEntry("volcengine-agent-plan")!.supportsServiceTier).toBe(false);
    // Registry-only metadata (same philosophy as modelWireDefaults): NOT seeded.
    const seed = providerConfigSeed(entry);
    expect(seed.supportsServiceTier).toBeUndefined();
    expect(seed.preserveResponsesReasoningContent).toBeUndefined();
  });

  test("enrichProviderFromRegistry backfills a missing field (not a hardcoded config)", () => {
    const prov: OcxProviderConfig = { adapter: "openai-chat", baseUrl: "https://api.deepseek.com", apiKey: "sk-test" };
    enrichProviderFromRegistry("deepseek", prov);
    expect(prov.supportsServiceTier).toBe(false);
    expect(prov.preserveResponsesReasoningContent).toBe(true);
  });

  test("an explicit config value beats the registry default in both directions", () => {
    const stripped: OcxProviderConfig = { adapter: "openai-responses", baseUrl: "https://api.openai.com/v1", apiKey: "sk-test", supportsServiceTier: false };
    enrichProviderFromRegistry("openai-apikey", stripped);
    expect(stripped.supportsServiceTier).toBe(false);
    const optedIn: OcxProviderConfig = { adapter: "openai-chat", baseUrl: "https://api.deepseek.com", apiKey: "sk-test", supportsServiceTier: true };
    enrichProviderFromRegistry("deepseek", optedIn);
    expect(optedIn.supportsServiceTier).toBe(true);
  });
});

describe("applyServiceTierGate fails closed", () => {
  test("a supported provider is untouched, including a caller-supplied tier", () => {
    const body = { model: "m", service_tier: "flex" };
    const options: { serviceTier?: string } = { serviceTier: "flex" };
    applyServiceTierGate({ adapter: "openai-responses", baseUrl: "https://api.openai.com/v1", supportsServiceTier: true }, body, options);
    expect(body.service_tier).toBe("flex");
    expect(options.serviceTier).toBe("flex");
  });

  test("an unsupported provider loses the field AND the logging value", () => {
    const body = { model: "m", service_tier: "priority" };
    const options: { serviceTier?: string } = { serviceTier: "priority" };
    applyServiceTierGate({ adapter: "openai-responses", baseUrl: "https://api.deepseek.com", supportsServiceTier: false }, body, options);
    expect("service_tier" in body).toBe(false);
    expect(options.serviceTier).toBeUndefined();
  });

  test("an unclassified provider (undefined capability) preserves the caller value", () => {
    const body = { model: "m", service_tier: "priority" };
    const options: { serviceTier?: string } = { serviceTier: "priority" };
    applyServiceTierGate({ adapter: "openai-responses", baseUrl: "https://example.com/v1" }, body, options);
    // Tri-state: only an explicit `false` strips; unknown gateways keep the
    // caller's field (we know nothing about them), and never get an injection.
    expect(body.service_tier).toBe("priority");
    expect(options.serviceTier).toBe("priority");
  });

  test("a non-Responses adapter is out of scope", () => {
    const body = { model: "m", service_tier: "priority" };
    const options: { serviceTier?: string } = {};
    applyServiceTierGate({ adapter: "openai-chat", baseUrl: "https://api.deepseek.com" }, body, options);
    expect(body.service_tier).toBe("priority");
  });
});

describe("the gate fires on the live handleResponses path", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  function captureBody(): { bodies: Record<string, unknown>[] } {
    const bodies: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    return { bodies };
  }

  async function drive(
    providerName: string,
    provider: OcxProviderConfig,
    model: string,
    rawBody: Record<string, unknown>,
    fastMode?: boolean,
  ): Promise<Record<string, unknown>> {
    const { bodies } = captureBody();
    const config = { providers: { [providerName]: provider }, ...(fastMode === undefined ? {} : { fastMode }) } as unknown as OcxConfig;
    await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: `${providerName}/${model}`, input: "ping", stream: true, ...rawBody }),
      }),
      config,
      { model: "", provider: "" },
      {},
    );
    return bodies[0] ?? {};
  }

  const deepseekProvider = (): OcxProviderConfig =>
    ({ ...providerConfigSeed(getProviderRegistryEntry("deepseek")!), apiKey: "sk-test" });
  const openAiKeyProvider = (): OcxProviderConfig =>
    ({ ...providerConfigSeed(getProviderRegistryEntry("openai-apikey")!), apiKey: "sk-test" });

  test("DeepSeek never receives service_tier, even with fastMode on", async () => {
    const body = await drive("deepseek", deepseekProvider(), "deepseek-v4-flash", {}, true);
    expect("service_tier" in body).toBe(false);
  });

  test("DeepSeek strips a caller-supplied service_tier", async () => {
    const body = await drive("deepseek", deepseekProvider(), "deepseek-v4-flash", { service_tier: "priority" });
    expect("service_tier" in body).toBe(false);
  });

  test("DeepSeek clears a stripped caller tier from request logging", async () => {
    const { bodies } = captureBody();
    const logCtx: RequestLogContext = { model: "", provider: "" };
    await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "deepseek/deepseek-v4-flash",
          input: "ping",
          stream: true,
          service_tier: "priority",
        }),
      }),
      { providers: { deepseek: deepseekProvider() } } as unknown as OcxConfig,
      logCtx,
      {},
    );

    expect("service_tier" in (bodies[0] ?? {})).toBe(false);
    expect(logCtx.requestedServiceTier).toBeUndefined();
    expect(logCtx.requestedSpeedLabel).toBeUndefined();
  });

  test("canonical OpenAI keeps fast-mode injection and removal", async () => {
    const on = await drive("openai-apikey", openAiKeyProvider(), "gpt-5.5", {}, true);
    expect(on.service_tier).toBe("priority");
    const off = await drive("openai-apikey", openAiKeyProvider(), "gpt-5.5", { service_tier: "flex" }, false);
    expect("service_tier" in off).toBe(false);
  });

  test("canonical OpenAI preserves a caller value when fastMode is unset", async () => {
    const body = await drive("openai-apikey", openAiKeyProvider(), "gpt-5.5", { service_tier: "flex" });
    expect(body.service_tier).toBe("flex");
  });

  test("an unclassified custom Responses provider keeps caller values; only explicit false strips", async () => {
    const custom = (): OcxProviderConfig => ({ adapter: "openai-responses", baseUrl: "https://gateway.example.com/v1", apiKey: "sk-test" });
    const preserved = await drive("custom-gw", custom(), "some-model", { service_tier: "priority" });
    expect(preserved.service_tier).toBe("priority");
    const stripped = await drive("custom-gw", { ...custom(), supportsServiceTier: false }, "some-model", { service_tier: "priority" });
    expect("service_tier" in stripped).toBe(false);
    const optedIn = await drive("custom-gw", { ...custom(), supportsServiceTier: true }, "some-model", { service_tier: "priority" });
    expect(optedIn.service_tier).toBe("priority");
  });
});
