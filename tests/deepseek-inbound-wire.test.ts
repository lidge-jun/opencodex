/**
 * DeepSeek V4 Flash is native on BOTH the Responses API and Chat Completions, so the
 * wire it should ride depends on what the CLIENT already speaks:
 *
 * - Codex speaks Responses natively -> go out on Responses, zero translation hops.
 * - Claude Code (Anthropic Messages) and OpenAI-compatible Chat clients -> stay on the
 *   provider-wide Chat wire, which DeepSeek serves natively too.
 *
 * The subtle part is that the Chat and Anthropic surfaces translate their body into a
 * Responses shape and REPLAY through handleResponses. A resolver-only test would pass
 * while that replay silently flipped the wire back, so the end-to-end cases below
 * assert the captured upstream URL, which is externally observable.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { enrichProviderFromRegistry, providerConfigSeed } from "../src/providers/derive";
import { getProviderRegistryEntry } from "../src/providers/registry";
import { createResponsesPassthroughAdapter as createResponsesPassthroughAdapterProduction } from "../src/adapters/openai-responses";
import { resolveWireProtocolOverride } from "../src/server/adapter-resolve";
import { handleResponses } from "../src/server/responses/core";
import type { OcxConfig, OcxProviderConfig } from "../src/types";
import { withTestTranslatorBudget } from "./helpers/translator-budget";

const createResponsesPassthroughAdapter = (...args: Parameters<typeof createResponsesPassthroughAdapterProduction>) =>
  withTestTranslatorBudget(createResponsesPassthroughAdapterProduction(...args));

const MODEL = "deepseek-v4-flash";

function deepseekProvider(): OcxProviderConfig {
  return { ...providerConfigSeed(getProviderRegistryEntry("deepseek")!), apiKey: "sk-test" };
}

describe("DeepSeek wire selection is scoped to the inbound protocol", () => {
  test("a Responses inbound rides the native Responses wire", () => {
    const resolved = resolveWireProtocolOverride("deepseek", MODEL, deepseekProvider(), "responses");
    expect(resolved.adapter).toBe("openai-responses");
  });

  test("an omitted inbound defaults to Responses", () => {
    // Most call sites are genuine Responses requests and rely on the default.
    const resolved = resolveWireProtocolOverride("deepseek", MODEL, deepseekProvider());
    expect(resolved.adapter).toBe("openai-responses");
  });

  test("an Anthropic inbound stays on the provider Chat wire", () => {
    const resolved = resolveWireProtocolOverride("deepseek", MODEL, deepseekProvider(), "anthropic");
    expect(resolved.adapter).toBe("openai-chat");
  });

  test("a Chat inbound stays on the provider Chat wire", () => {
    const resolved = resolveWireProtocolOverride("deepseek", MODEL, deepseekProvider(), "chat");
    expect(resolved.adapter).toBe("openai-chat");
  });

  test("an explicit per-model override still wins on every inbound", () => {
    // User intent outranks a registry default, or the override would be unusable on
    // the two surfaces the scope excludes.
    const provider = { ...deepseekProvider(), modelAdapters: { [MODEL]: "openai-responses" } };
    for (const inbound of ["responses", "chat", "anthropic"] as const) {
      expect(resolveWireProtocolOverride("deepseek", MODEL, provider, inbound).adapter)
        .toBe("openai-responses");
    }
  });

  test("a model with no declared default is untouched on every inbound", () => {
    for (const inbound of ["responses", "chat", "anthropic"] as const) {
      expect(resolveWireProtocolOverride("deepseek", "deepseek-chat", deepseekProvider(), inbound).adapter)
        .toBe("openai-chat");
    }
  });
});

describe("the inbound scope survives the handleResponses replay", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  function captureUpstreamUrl(): string[] {
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response("data: [DONE]\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;
    return urls;
  }

  async function drive(inboundWire?: "responses" | "chat" | "anthropic"): Promise<string> {
    const urls = captureUpstreamUrl();
    const config = { providers: { deepseek: deepseekProvider() } } as unknown as OcxConfig;
    await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: MODEL, input: "ping", stream: true }),
      }),
      config,
      { model: "", provider: "" },
      inboundWire === undefined ? {} : { inboundWire },
    );
    return urls[0] ?? "";
  }

  test("a native Responses request reaches the documented /responses route", async () => {
    expect(await drive("responses")).toBe("https://api.deepseek.com/responses");
  });

  test("an Anthropic replay reaches /chat/completions, not /responses", async () => {
    // Regression guard for the audit's critical finding: editing only the pre-flight
    // resolution in claude-messages.ts left this URL on /responses.
    expect(await drive("anthropic")).toBe("https://api.deepseek.com/chat/completions");
  });

  test("a Chat replay reaches /chat/completions, not /responses", async () => {
    expect(await drive("chat")).toBe("https://api.deepseek.com/chat/completions");
  });
});

/**
 * DeepSeek documents "the API is stateless: responses and conversations are not
 * stored on the server", so parameters that reference server-held state can never be
 * honoured. Multi-turn context still works because the proxy expands
 * previous_response_id into a full input replay before the adapter runs.
 */
describe("stateless Responses upstreams get no stateful parameters", () => {
  function buildBody(provider: OcxProviderConfig, rawBody: Record<string, unknown>): Record<string, unknown> {
    const built = createResponsesPassthroughAdapter(provider).buildRequest({
      modelId: MODEL,
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: { model: MODEL, input: "ping", ...rawBody },
    } as Parameters<ReturnType<typeof createResponsesPassthroughAdapter>["buildRequest"]>[0], { headers: new Headers() });
    return JSON.parse(String(built.body)) as Record<string, unknown>;
  }

  const STATEFUL = {
    previous_response_id: "resp_abc",
    conversation: "conv_abc",
    background: true,
    metadata: { k: "v" },
    prompt: { id: "pmpt_abc" },
  };

  test("the documented stateful parameters are dropped and store is pinned", () => {
    const body = buildBody({ ...deepseekProvider(), adapter: "openai-responses" }, STATEFUL);
    for (const key of Object.keys(STATEFUL)) expect(body).not.toHaveProperty(key);
    expect(body.store).toBe(false);
  });

  test("service_tier remains adapter-passthrough data until route normalization", () => {
    // The adapter must not make provider-capability decisions. The server owns that
    // normalization after the final route is known.
    const body = buildBody({ ...deepseekProvider(), adapter: "openai-responses" }, { service_tier: "priority" });
    expect(body.service_tier).toBe("priority");
  });

  test("a provider without the capability keeps every one of them", () => {
    // Negative control: the strip must be capability-gated, not global.
    const body = buildBody(
      { adapter: "openai-responses", baseUrl: "https://api.openai.example", authMode: "key", apiKey: "sk-test" },
      STATEFUL,
    );
    expect(body.previous_response_id).toBe("resp_abc");
    expect(body.metadata).toEqual({ k: "v" });
    expect(body.store).toBeUndefined();
  });

  test("registry enrichment backfills the capability without expanding persisted seeds", () => {
    expect(providerConfigSeed(getProviderRegistryEntry("deepseek")!).statelessResponses).toBe(true);
    // Seeds stay lean: the registry-only capability is backfilled by enrichment/routing.
    expect(providerConfigSeed(getProviderRegistryEntry("deepseek")!).supportsServiceTier).toBeUndefined();
    expect(providerConfigSeed(getProviderRegistryEntry("volcengine-agent-plan")!).supportsServiceTier).toBeUndefined();
    expect(providerConfigSeed(getProviderRegistryEntry("cerebras")!).statelessResponses).toBeUndefined();
    expect(providerConfigSeed(getProviderRegistryEntry("cerebras")!).supportsServiceTier).toBeUndefined();
    const enriched = deepseekProvider();
    delete enriched.supportsServiceTier;
    enrichProviderFromRegistry("deepseek", enriched);
    expect(enriched.supportsServiceTier).toBe(false);
  });

  test("a replay miss does not forward an orphaned tool result", () => {
    // On a replay miss the delta can open with a function_call_output whose paired
    // function_call sat in the prefix that was never expanded. A stateless upstream
    // cannot resolve the pair from its own storage, so forwarding the orphan earns a
    // 400 -- dropping stateful params is not much use if the body is unparseable.
    const built = createResponsesPassthroughAdapter({ ...deepseekProvider(), adapter: "openai-responses" })
      .buildRequest({
        modelId: MODEL,
        context: { messages: [] },
        stream: true,
        options: {},
        previousResponseId: "resp_missing",
        _rawBody: {
          model: MODEL,
          previous_response_id: "resp_missing",
          input: [
            { type: "function_call_output", call_id: "call_orphan", output: "42" },
            { type: "message", role: "user", content: [{ type: "input_text", text: "and now?" }] },
          ],
        },
      } as Parameters<ReturnType<typeof createResponsesPassthroughAdapter>["buildRequest"]>[0], { headers: new Headers() });
    const input = (JSON.parse(String(built.body)) as { input: Array<{ type?: string; call_id?: string }> }).input;
    expect(input.some(item => item.call_id === "call_orphan")).toBe(false);
    expect(input.some(item => item.type === "message")).toBe(true);
  });
});

describe("Responses service-tier injection is capability-gated and fails closed", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  interface UpstreamCall {
    url: string;
    body: Record<string, unknown>;
  }

  function captureCalls(): UpstreamCall[] {
    const calls: UpstreamCall[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        body: typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {},
      });
      return new Response("data: [DONE]\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;
    return calls;
  }

  async function drive(config: OcxConfig, body: Record<string, unknown>): Promise<{
    response: Response;
    calls: UpstreamCall[];
  }> {
    const calls = captureCalls();
    const response = await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      config,
      { model: "", provider: "" },
      { inboundWire: "responses" },
    );
    return { response, calls };
  }

  async function forwardBody(config: OcxConfig, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { response, calls } = await drive(config, body);
    // Tests must prove one successful upstream call, not vacuous pass-throughs.
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    return calls[0]!.body;
  }

  function deepseekWithoutCapability(): OcxProviderConfig {
    const provider = deepseekProvider();
    // Simulate a pre-capability config saved before this registry field existed. The
    // router must backfill the registry `false`, so this exercises the stale-config path.
    delete provider.supportsServiceTier;
    return provider;
  }

  test("an omitted capability strips a caller tier and never injects fastMode (DeepSeek stale config)", async () => {
    const config = {
      fastMode: true,
      defaultProvider: "deepseek",
      providers: { deepseek: deepseekWithoutCapability() },
    } as unknown as OcxConfig;
    const body = await forwardBody(config, { model: MODEL, input: "ping", stream: true, service_tier: "priority" });
    expect(body.service_tier).toBeUndefined();
  });

  test("an omitted capability strips a caller tier even when fastMode is unset", async () => {
    const config = {
      defaultProvider: "deepseek",
      providers: { deepseek: deepseekWithoutCapability() },
    } as unknown as OcxConfig;
    const body = await forwardBody(config, { model: MODEL, input: "ping", stream: true, service_tier: "priority" });
    expect(body.service_tier).toBeUndefined();
  });

  test("an unclassified custom Responses provider also fails closed", async () => {
    const config = {
      fastMode: true,
      defaultProvider: "custom",
      providers: {
        custom: {
          adapter: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          authMode: "key",
          apiKey: "sk-test",
        },
      },
    } as unknown as OcxConfig;
    const body = await forwardBody(config, { model: "custom-model", input: "ping", stream: true, service_tier: "priority" });
    expect(body.service_tier).toBeUndefined();
  });

  test("keeps fast mode for the OpenAI API Responses provider", async () => {
    const provider = {
      ...providerConfigSeed(getProviderRegistryEntry("openai-apikey")!),
      apiKey: "sk-test",
    };
    // The router must backfill registry capabilities for an older persisted provider row.
    delete provider.supportsServiceTier;
    const config = {
      fastMode: true,
      defaultProvider: "openai-apikey",
      providers: { "openai-apikey": provider },
    } as unknown as OcxConfig;
    expect((await forwardBody(config, { model: "openai-apikey/gpt-5.5", input: "ping", stream: true })).service_tier)
      .toBe("priority");
  });

  test("removes a caller tier when OpenAI fast mode is explicitly disabled", async () => {
    const provider = {
      ...providerConfigSeed(getProviderRegistryEntry("openai-apikey")!),
      apiKey: "sk-test",
    };
    delete provider.supportsServiceTier;
    const config = {
      fastMode: false,
      defaultProvider: "openai-apikey",
      providers: { "openai-apikey": provider },
    } as unknown as OcxConfig;
    expect((await forwardBody(config, { model: "openai-apikey/gpt-5.5", input: "ping", stream: true, service_tier: "priority" })).service_tier)
      .toBeUndefined();
  });

  test("preserves a caller tier for an explicit supportsServiceTier provider when fastMode is unset", async () => {
    const provider = {
      ...providerConfigSeed(getProviderRegistryEntry("openai-apikey")!),
      apiKey: "sk-test",
      supportsServiceTier: true,
    };
    const config = {
      defaultProvider: "openai-apikey",
      providers: { "openai-apikey": provider },
    } as unknown as OcxConfig;
    const body = await forwardBody(config, { model: "openai-apikey/gpt-5.5", input: "ping", stream: true, service_tier: "priority" });
    expect(body.service_tier).toBe("priority");
  });

  test("the canonical openai Codex-login route forwards priority on the native wire", async () => {
    const config = {
      fastMode: true,
      defaultProvider: "openai",
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          codexAccountMode: "direct",
          supportsServiceTier: true,
        },
      },
    } as unknown as OcxConfig;
    const calls = captureCalls();
    const response = await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // `direct` mode requires the caller's own Codex bearer token before the proxy
          // forwards the request upstream; this is not a proxy admission secret.
          authorization: "Bearer sk-codex-login-test",
        },
        body: JSON.stringify({ model: "gpt-5.5", input: "ping", stream: true }),
      }),
      config,
      { model: "", provider: "" },
      { inboundWire: "responses" },
    );
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(calls[0]!.body.service_tier).toBe("priority");
  });
});
