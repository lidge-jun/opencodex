import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { buildOpenAIChatPassthroughRequest } from "../src/adapters/openai-chat";
import { chatCompletionsToResponsesBody } from "../src/chat/inbound";
import { fastPolicyForModel } from "../src/providers/service-tier";
import * as adapterResolveModule from "../src/server/adapter-resolve";
import type { RequestLogContext } from "../src/server/request-log";
import { handleResponses } from "../src/server/responses/core";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function driveResponses(args: {
  provider: OcxProviderConfig;
  providerName?: string;
  model?: string;
  callerTier?: string;
  fastMode?: boolean;
}): Promise<{ outboundBody: Record<string, unknown>; logCtx: RequestLogContext }> {
  const providerName = args.providerName ?? "fastwire-fixture";
  const model = args.model ?? "model";
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return new Response("data: [DONE]\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;

  const config = {
    port: 0,
    defaultProvider: providerName,
    providers: { [providerName]: args.provider },
    ...(args.fastMode === undefined ? {} : { fastMode: args.fastMode }),
  } as OcxConfig;
  const logCtx: RequestLogContext = { model: "", provider: "" };
  const requestBody = {
    model: `${providerName}/${model}`,
    input: "ping",
    stream: true,
    ...(args.callerTier === undefined ? {} : { service_tier: args.callerTier }),
  };

  await handleResponses(
    new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestBody),
    }),
    config,
    logCtx,
    {},
  );

  expect(bodies).toHaveLength(1);
  return { outboundBody: bodies[0]!, logCtx };
}

const supportedResponsesProvider = (): OcxProviderConfig => ({
  adapter: "openai-responses",
  baseUrl: "https://supported.example.test/v1",
  authMode: "key",
  apiKey: "sk-test",
  supportsServiceTier: true,
});

const unclassifiedResponsesProvider = (): OcxProviderConfig => ({
  adapter: "openai-responses",
  baseUrl: "https://unclassified.example.test/v1",
  authMode: "key",
  apiKey: "sk-test",
});

describe("FastWire characterization: supported-route fastMode tri-state", () => {
  test("fastMode=true overrides caller flex with priority", async () => {
    const { outboundBody } = await driveResponses({
      provider: supportedResponsesProvider(),
      callerTier: "flex",
      fastMode: true,
    });
    expect(outboundBody.service_tier).toBe("priority");
  });

  test("fastMode=false removes the caller tier", async () => {
    const { outboundBody } = await driveResponses({
      provider: supportedResponsesProvider(),
      callerTier: "turbo-x",
      fastMode: false,
    });
    expect(outboundBody).not.toHaveProperty("service_tier");
  });

  test("fastMode=undefined preserves caller flex", async () => {
    const { outboundBody } = await driveResponses({
      provider: supportedResponsesProvider(),
      callerTier: "flex",
    });
    expect(outboundBody.service_tier).toBe("flex");
  });

  test("a capability-without-wire warning is redacted and throttled per provider/model", async () => {
    const providerName = `sk-ant-api03-${"A".repeat(40)}`;
    const model = `model\n${"x".repeat(100)}`;
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const provider: OcxProviderConfig = {
      ...supportedResponsesProvider(),
      fastWire: null,
    };

    try {
      await driveResponses({ provider, providerName, model, callerTier: "flex" });
      await driveResponses({ provider, providerName, model, callerTier: "flex" });
      const fastWireWarnings = warnSpy.mock.calls
        .map(call => String(call[0]))
        .filter(message => message.includes("Fast policy"));
      expect(fastWireWarnings).toHaveLength(1);
      expect(fastWireWarnings[0]).not.toContain(providerName);
      expect(fastWireWarnings[0]).not.toContain("\n");
      expect(fastWireWarnings[0]).not.toContain("x".repeat(65));
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("FastWire characterization: resolved model adapter controls fast override", () => {
  test.each([
    { fastMode: true, expectedTier: "priority" },
    { fastMode: false, expectedTier: undefined },
  ])(
    "anthropic provider overridden to openai-chat emits $expectedTier with fastMode=$fastMode",
    async ({ fastMode, expectedTier }) => {
      const { outboundBody } = await driveResponses({
        provider: {
          adapter: "anthropic",
          baseUrl: "https://mixed-wire.example.test/v1",
          authMode: "key",
          apiKey: "sk-test",
          modelAdapters: { model: "openai-chat" },
          supportsServiceTier: true,
          chatServiceTier: true,
        },
        callerTier: "flex",
        fastMode,
      });
      if (expectedTier === undefined) expect(outboundBody).not.toHaveProperty("service_tier");
      else expect(outboundBody.service_tier).toBe(expectedTier);
    },
  );
});

describe("FastWire characterization: unclassified support matrix", () => {
  const cells = ([true, false, undefined] as const).flatMap(fastMode =>
    (["priority", "fast", "flex"] as const).map(callerTier => ({ fastMode, callerTier }))
  );

  test.each(cells)(
    "support=undefined preserves caller $callerTier with fastMode=$fastMode",
    async ({ fastMode, callerTier }) => {
      const { outboundBody } = await driveResponses({
        provider: unclassifiedResponsesProvider(),
        callerTier,
        fastMode,
      });
      expect(outboundBody.service_tier).toBe(callerTier);
    },
  );
});

describe("FastWire characterization: exact-model Chat tier forwarding", () => {
  // FastWire #1886 B1 capability semantic migration: exact capability no longer grants
  // permission to forward a caller's foreign Chat tier.
  test.each(["flex", "turbo-x"])(
    "exact model true drops foreign caller tier %s without chatServiceTier",
    async callerTier => {
      const { outboundBody, logCtx } = await driveResponses({
        provider: {
          adapter: "openai-chat",
          baseUrl: "https://chat.example.test/v1",
          authMode: "key",
          apiKey: "sk-test",
          modelSupportsServiceTier: { model: true },
        },
        callerTier,
      });
      expect(outboundBody).not.toHaveProperty("service_tier");
      expect(logCtx.tierOutcome).toMatchObject({
        callerTierDropped: true,
        fastOutcome: "not-requested",
      });
      expect(logCtx.tierOutcome?.canonical).toBeUndefined();
    },
  );

  test("chatServiceTier still forwards an exact model's foreign caller tier", async () => {
    const { outboundBody } = await driveResponses({
      provider: {
        adapter: "openai-chat",
        baseUrl: "https://chat.example.test/v1",
        authMode: "key",
        apiKey: "sk-test",
        modelSupportsServiceTier: { model: true },
        chatServiceTier: true,
      },
      callerTier: "flex",
    });
    expect(outboundBody.service_tier).toBe("flex");
  });

  test("exact model capability translates canonical caller Fast without foreign-tier permission", async () => {
    const { outboundBody, logCtx } = await driveResponses({
      provider: {
        adapter: "openai-chat",
        baseUrl: "https://chat.example.test/v1",
        authMode: "key",
        apiKey: "sk-test",
        modelSupportsServiceTier: { model: true },
      },
      callerTier: "fast",
    });
    expect(outboundBody.service_tier).toBe("priority");
    expect(logCtx.tierOutcome).toMatchObject({
      canonical: "priority",
      fastOutcome: "applied",
    });
  });
});

describe("FastWire B1: Chat capability and canonical inherit", () => {
  test.each([
    { supportsServiceTier: true, expectedTier: "priority", expectedOutcome: "applied" },
    { supportsServiceTier: false, expectedTier: undefined, expectedOutcome: "downgraded" },
  ] as const)(
    "provider capability=$supportsServiceTier controls canonical Fast injection without chatServiceTier",
    async ({ supportsServiceTier, expectedTier, expectedOutcome }) => {
      const { outboundBody, logCtx } = await driveResponses({
        provider: {
          adapter: "openai-chat",
          baseUrl: "https://chat-capability.example.test/v1",
          authMode: "key",
          apiKey: "sk-test",
          supportsServiceTier,
        },
        fastMode: true,
      });
      if (expectedTier === undefined) expect(outboundBody).not.toHaveProperty("service_tier");
      else expect(outboundBody.service_tier).toBe(expectedTier);
      expect(logCtx.tierOutcome?.fastOutcome).toBe(expectedOutcome);
    },
  );

  test.each(["fast", "FAST", "priority"])(
    "supported Chat route normalizes inherited caller %s to priority",
    async callerTier => {
      const { outboundBody, logCtx } = await driveResponses({
        provider: {
          adapter: "openai-chat",
          baseUrl: "https://chat-capability.example.test/v1",
          authMode: "key",
          apiKey: "sk-test",
          supportsServiceTier: true,
        },
        callerTier,
      });
      expect(outboundBody.service_tier).toBe("priority");
      expect(logCtx.tierOutcome).toMatchObject({
        canonical: "priority",
        fastOutcome: "applied",
      });
    },
  );

  test("unclassified Chat route drops caller fast without CallerTierForward", async () => {
    const { outboundBody, logCtx } = await driveResponses({
      provider: {
        adapter: "openai-chat",
        baseUrl: "https://chat-unclassified.example.test/v1",
        authMode: "key",
        apiKey: "sk-test",
      },
      callerTier: "fast",
    });
    expect(outboundBody).not.toHaveProperty("service_tier");
    expect(logCtx.tierOutcome).toMatchObject({ fastOutcome: "unknown" });
    expect(logCtx.tierOutcome?.canonical).toBeUndefined();
  });
});

describe("FastWire characterization: requestedServiceTier timing", () => {
  test("records the raw caller tier when fastMode overrides the wire tier", async () => {
    const { outboundBody, logCtx } = await driveResponses({
      provider: supportedResponsesProvider(),
      callerTier: "flex",
      fastMode: true,
    });
    expect(outboundBody.service_tier).toBe("priority");
    expect(logCtx.requestedServiceTier).toBe("flex");
  });

  test("clears the caller tier after an unsupported route strips it", async () => {
    const { outboundBody, logCtx } = await driveResponses({
      provider: {
        ...supportedResponsesProvider(),
        supportsServiceTier: false,
      },
      callerTier: "priority",
    });
    expect(outboundBody).not.toHaveProperty("service_tier");
    expect(logCtx.requestedServiceTier).toBeUndefined();
  });
});

describe("FastWire characterization: rawBody observation point", () => {
  test("Responses writes the decision outbound without changing parsed._rawBody", async () => {
    let adapterRawBody: Record<string, unknown> | undefined;
    let outboundBody: Record<string, unknown> | undefined;
    const actualResolveAdapter = adapterResolveModule.resolveAdapter;
    const adapterSpy = spyOn(adapterResolveModule, "resolveAdapter").mockImplementation((provider, cacheRetention) => {
      const actualAdapter = actualResolveAdapter(provider, cacheRetention);
      return {
        ...actualAdapter,
        buildRequest(parsed, incoming) {
          adapterRawBody = parsed._rawBody as Record<string, unknown>;
          const request = actualAdapter.buildRequest!(parsed, incoming);
          outboundBody = JSON.parse(request.body) as Record<string, unknown>;
          return request;
        },
      };
    });

    try {
      globalThis.fetch = (async () => new Response("data: [DONE]\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })) as typeof fetch;
      const providerName = "fastwire-raw-body";
      const config = {
        port: 0,
        defaultProvider: providerName,
        fastMode: true,
        providers: { [providerName]: supportedResponsesProvider() },
      } as OcxConfig;
      const request = new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: `${providerName}/model`,
          input: "ping",
          stream: true,
          service_tier: "flex",
        }),
      });

      await handleResponses(request, config, { model: "", provider: "" }, {});
      expect(outboundBody?.service_tier).toBe("priority");
      expect(adapterRawBody?.service_tier).toBe("flex");
    } finally {
      adapterSpy.mockRestore();
    }
  });
});

describe("FastWire characterization: known bugs", () => {
  test("characterization: native chat passthrough honors exact-model false", () => {
    // FastWire #1886 native-chat policy fix: exact-model false now strips the caller tier.
    const provider: OcxProviderConfig = {
      adapter: "openai-chat",
      baseUrl: "https://native-chat.example.test/v1",
      authMode: "key",
      apiKey: "sk-test",
      supportsServiceTier: true,
      chatServiceTier: true,
      modelSupportsServiceTier: { model: false },
    };
    const request = buildOpenAIChatPassthroughRequest(
      provider,
      {
        model: "model",
        messages: [{ role: "user", content: "ping" }],
        service_tier: "flex",
      },
      "model",
      false,
      fastPolicyForModel(provider, "model", "native-chat", "chat"),
    );
    const body = JSON.parse(request.body) as Record<string, unknown>;
    expect(body).not.toHaveProperty("service_tier");
  });

  test("characterization: chat-to-responses conversion preserves service_tier", () => {
    // FastWire #1886 chat-tier-copy bug-fix unit flips the A0 known-bug characterization.
    const body = chatCompletionsToResponsesBody({
      model: "model",
      messages: [{ role: "user", content: "ping" }],
      service_tier: "priority",
    });
    expect(body.service_tier).toBe("priority");
  });
});
