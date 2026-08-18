import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { buildOpenAIChatPassthroughRequest } from "../src/adapters/openai-chat";
import { chatCompletionsToResponsesBody } from "../src/chat/inbound";
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
  model?: string;
  callerTier?: string;
  fastMode?: boolean;
}): Promise<{ outboundBody: Record<string, unknown>; logCtx: RequestLogContext }> {
  const providerName = "fastwire-fixture";
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
  test.each(["flex", "turbo-x"])(
    "exact model true forwards foreign caller tier %s without chatServiceTier",
    async callerTier => {
      const { outboundBody } = await driveResponses({
        provider: {
          adapter: "openai-chat",
          baseUrl: "https://chat.example.test/v1",
          authMode: "key",
          apiKey: "sk-test",
          modelSupportsServiceTier: { model: true },
        },
        callerTier,
      });
      expect(outboundBody.service_tier).toBe(callerTier);
    },
  );
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
  test("fastMode injection is visible in parsed._rawBody when the adapter is invoked", async () => {
    let adapterRawBody: Record<string, unknown> | undefined;
    const adapterSpy = spyOn(adapterResolveModule, "resolveAdapter").mockReturnValue({
      name: "openai-responses",
      passthrough: true,
      async buildRequest(parsed) {
        adapterRawBody = JSON.parse(JSON.stringify(parsed._rawBody)) as Record<string, unknown>;
        throw new Error("fastwire rawBody observation complete");
      },
    } as ReturnType<typeof adapterResolveModule.resolveAdapter>);

    try {
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

      await expect(handleResponses(request, config, { model: "", provider: "" }, {}))
        .rejects.toThrow("fastwire rawBody observation complete");
      // A1 intentionally moves fast-mode injection out of `_rawBody`; update this
      // characterization when that observation point changes.
      expect(adapterRawBody?.service_tier).toBe("priority");
    } finally {
      adapterSpy.mockRestore();
    }
  });
});

describe("FastWire characterization: known bugs", () => {
  test("characterization (known bug): native chat passthrough ignores exact-model false", () => {
    const request = buildOpenAIChatPassthroughRequest(
      {
        adapter: "openai-chat",
        baseUrl: "https://native-chat.example.test/v1",
        authMode: "key",
        apiKey: "sk-test",
        supportsServiceTier: true,
        chatServiceTier: true,
        modelSupportsServiceTier: { model: false },
      },
      {
        model: "model",
        messages: [{ role: "user", content: "ping" }],
        service_tier: "flex",
      },
      "model",
      false,
    );
    const body = JSON.parse(request.body) as Record<string, unknown>;
    expect(body.service_tier).toBe("flex");
  });

  test("characterization (known bug): chat-to-responses conversion drops service_tier", () => {
    const body = chatCompletionsToResponsesBody({
      model: "model",
      messages: [{ role: "user", content: "ping" }],
      service_tier: "priority",
    });
    expect(body).not.toHaveProperty("service_tier");
  });
});
