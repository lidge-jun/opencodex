import { afterEach, describe, expect, test } from "bun:test";
import {
  buildOpenAIChatPassthroughRequest,
  createOpenAIChatAdapter,
} from "../src/adapters/openai-chat";
import {
  decideTier,
  tierValueAfterDecision,
} from "../src/providers/fastwire";
import { fastPolicyForModel } from "../src/providers/service-tier";
import { handleChatCompletions } from "../src/server/chat-completions";
import type { OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../src/types";

const PROVIDER_NAME = "native-tier-fixture";
const MODEL_ID = "model";
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function provider(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return {
    adapter: "openai-chat",
    baseUrl: "https://native-tier.example.test/v1",
    authMode: "key",
    apiKey: "sk-test",
    ...overrides,
  };
}

function nativeBody(
  target: OcxProviderConfig,
  callerTier: string,
  modelId = MODEL_ID,
): Record<string, unknown> {
  const policy = fastPolicyForModel(target, modelId, PROVIDER_NAME, "chat");
  const request = buildOpenAIChatPassthroughRequest(
    target,
    {
      model: modelId,
      messages: [{ role: "user", content: "ping" }],
      service_tier: callerTier,
    },
    modelId,
    false,
    policy,
  );
  return JSON.parse(request.body) as Record<string, unknown>;
}

function mainPathBody(
  target: OcxProviderConfig,
  callerTier: string,
  modelId = MODEL_ID,
): Record<string, unknown> {
  const policy = fastPolicyForModel(target, modelId, PROVIDER_NAME, "chat");
  const tierDecision = decideTier(policy, undefined, callerTier);
  const serviceTier = tierValueAfterDecision(tierDecision, callerTier);
  const parsed: OcxParsedRequest = {
    modelId,
    stream: false,
    context: { messages: [{ role: "user", content: "ping" }], tools: [] },
    options: {
      ...(serviceTier === undefined ? {} : { serviceTier }),
      tierDecision,
    },
  };
  const request = createOpenAIChatAdapter(target).buildRequest(parsed);
  return JSON.parse(request.body) as Record<string, unknown>;
}

function forwardsTier(body: Record<string, unknown>): boolean {
  return Object.hasOwn(body, "service_tier");
}

describe("native Chat passthrough service-tier policy", () => {
  test.each([
    {
      name: "provider false stays fail-closed even with CallerTierForward",
      config: { supportsServiceTier: false, chatServiceTier: true },
      callerTier: "priority",
      expectedTier: undefined,
    },
    {
      name: "exact-model false narrows provider support",
      config: {
        supportsServiceTier: true,
        chatServiceTier: true,
        modelSupportsServiceTier: { [MODEL_ID]: false },
      },
      callerTier: "priority",
      expectedTier: undefined,
    },
    {
      name: "exact-model true authorizes canonical Fast without CallerTierForward",
      config: { modelSupportsServiceTier: { [MODEL_ID]: true } },
      callerTier: "FAST",
      expectedTier: "FAST",
    },
    {
      name: "exact-model true does not authorize a foreign tier",
      config: { modelSupportsServiceTier: { [MODEL_ID]: true } },
      callerTier: "flex",
      expectedTier: undefined,
    },
    {
      name: "unclassified support drops a caller tier without CallerTierForward",
      config: {},
      callerTier: "flex",
      expectedTier: undefined,
    },
    {
      name: "unclassified support forwards a caller tier with CallerTierForward",
      config: { chatServiceTier: true },
      callerTier: "flex",
      expectedTier: "flex",
    },
  ] as const)("$name", ({ config, callerTier, expectedTier }) => {
    const body = nativeBody(provider(config), callerTier);
    if (expectedTier === undefined) expect(body).not.toHaveProperty("service_tier");
    else expect(body.service_tier).toBe(expectedTier);
  });

  test("the native handler passes its resolved fail-closed policy to the builder", async () => {
    const captured: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return Response.json({
        id: "chatcmpl_native_tier",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      });
    }) as typeof fetch;
    const target = provider({ supportsServiceTier: false, chatServiceTier: true });
    const config = {
      port: 0,
      defaultProvider: PROVIDER_NAME,
      providers: { [PROVIDER_NAME]: target },
    } as OcxConfig;

    const response = await handleChatCompletions(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: `${PROVIDER_NAME}/${MODEL_ID}`,
          messages: [{ role: "user", content: "ping" }],
          service_tier: "priority",
        }),
      }),
      config,
      { model: "", provider: "" },
    );

    expect(response.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0]).not.toHaveProperty("service_tier");
  });
});

describe("main and native Chat tier authorization parity", () => {
  test.each([
    {
      name: "provider fail-closed",
      config: { supportsServiceTier: false, chatServiceTier: true },
      callerTier: "priority",
      forwarded: false,
    },
    {
      name: "exact-model fail-closed",
      config: {
        supportsServiceTier: true,
        chatServiceTier: true,
        modelSupportsServiceTier: { [MODEL_ID]: false },
      },
      callerTier: "priority",
      forwarded: false,
    },
    {
      name: "exact-model canonical Fast",
      config: { modelSupportsServiceTier: { [MODEL_ID]: true } },
      callerTier: "fast",
      forwarded: true,
      mainTier: "priority",
      nativeTier: "fast",
    },
    {
      name: "exact-model foreign tier",
      config: { modelSupportsServiceTier: { [MODEL_ID]: true } },
      callerTier: "flex",
      forwarded: false,
    },
    {
      name: "unclassified without CallerTierForward",
      config: {},
      callerTier: "priority",
      forwarded: false,
    },
    {
      name: "unclassified with CallerTierForward",
      config: { chatServiceTier: true },
      callerTier: "flex",
      forwarded: true,
      mainTier: "flex",
      nativeTier: "flex",
    },
  ] as const)("$name makes the same forward/drop decision", row => {
    const target = provider(row.config);
    const main = mainPathBody(target, row.callerTier);
    const native = nativeBody(target, row.callerTier);

    expect(forwardsTier(main)).toBe(row.forwarded);
    expect(forwardsTier(native)).toBe(row.forwarded);
    expect(forwardsTier(native)).toBe(forwardsTier(main));
    if (row.forwarded) {
      expect(main.service_tier).toBe(row.mainTier);
      expect(native.service_tier).toBe(row.nativeTier);
    }
  });
});
