import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../../src/config";
import {
  buildOpenAIChatPassthroughRequest,
  createOpenAIChatAdapter,
} from "../../../src/adapters/openai-chat";
import {
  decideTier,
  tierValueAfterDecision,
} from "../../../src/providers/fastwire";
import { clearKeyCooldowns } from "../../../src/providers/key-failover";
import { fastPolicyForModel } from "../../../src/providers/service-tier";
import { handleChatCompletions } from "../../../src/server/chat-completions";
import type { OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../../../src/types";
import { removeTreeWithRetry } from "../../helpers/remove-tree";

const PROVIDER_NAME = "native-tier-fixture";
const MODEL_ID = "model";
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearKeyCooldowns(PROVIDER_NAME);
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
  callerTier: string | undefined,
  modelId = MODEL_ID,
  fastMode?: boolean,
): Record<string, unknown> {
  const policy = fastPolicyForModel(target, modelId, PROVIDER_NAME, "chat");
  const request = buildOpenAIChatPassthroughRequest(
    target,
    {
      model: modelId,
      messages: [{ role: "user", content: "ping" }],
      ...(callerTier === undefined ? {} : { service_tier: callerTier }),
    },
    modelId,
    false,
    policy,
    fastMode,
  );
  return JSON.parse(request.body) as Record<string, unknown>;
}

function mainPathBody(
  target: OcxProviderConfig,
  callerTier: string | undefined,
  modelId = MODEL_ID,
  fastMode?: boolean,
): Record<string, unknown> {
  const policy = fastPolicyForModel(target, modelId, PROVIDER_NAME, "chat");
  const tierDecision = decideTier(policy, fastMode, callerTier);
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

/**
 * The translated path WITHOUT a router-supplied `tierDecision`.
 *
 * `mainPathBody` always computes and passes a decision, so it never exercises the adapter's
 * absent-decision fallback. That fallback used to re-derive its own looser answer beside
 * `decideTier` instead of asking it, which let a foreign caller tier reach the wire on a
 * provider whose policy drops foreign tiers.
 */
function undecidedPathBody(
  target: OcxProviderConfig,
  callerTier: string | undefined,
  modelId = MODEL_ID,
): Record<string, unknown> {
  const parsed: OcxParsedRequest = {
    modelId,
    stream: false,
    context: { messages: [{ role: "user", content: "ping" }], tools: [] },
    options: { ...(callerTier === undefined ? {} : { serviceTier: callerTier }) },
  };
  const request = createOpenAIChatAdapter(target).buildRequest(parsed);
  return JSON.parse(request.body) as Record<string, unknown>;
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
    {
      name: "classified foreign-tier drop overrides CallerTierForward",
      config: {
        supportsServiceTier: true,
        chatServiceTier: true,
        fastWire: {
          kind: "service-tier",
          canonicalToWire: { priority: "priority" },
          foreignCallerTiers: "drop",
        },
      },
      callerTier: "flex",
      expectedTier: undefined,
    },
  ] as const)("$name", ({ config, callerTier, expectedTier }) => {
    const body = nativeBody(provider(config), callerTier);
    if (expectedTier === undefined) expect(body).not.toHaveProperty("service_tier");
    else expect(body.service_tier).toBe(expectedTier);
  });

  describe("the translated path with no router tier decision defers to decideTier", () => {
    const dropsForeign = {
      supportsServiceTier: true,
      chatServiceTier: true,
      fastWire: {
        kind: "service-tier" as const,
        canonicalToWire: { priority: "priority" },
        foreignCallerTiers: "drop" as const,
      },
    };

    test("a foreign caller tier is dropped when the policy drops foreign tiers", () => {
      // Before the fix this serialized `flex` because the fallback only asked whether foreign
      // forwarding was allowed anywhere, not what the policy decided for this tier.
      expect(undecidedPathBody(provider(dropsForeign), "flex")).not.toHaveProperty("service_tier");
    });

    test("a canonical Fast tier still serializes through the same path", () => {
      expect(undecidedPathBody(provider(dropsForeign), "priority").service_tier).toBe("priority");
    });

    test("the fallback and decideTier cannot disagree", () => {
      // The invariant, stated directly: whatever the state machine decides for this caller
      // tier is what the wire carries, with or without a router-supplied decision.
      for (const callerTier of ["flex", "priority", "auto", "default"]) {
        const target = provider(dropsForeign);
        const decision = decideTier(fastPolicyForModel(target, MODEL_ID, undefined, "chat"), undefined, callerTier);
        const serializes = decision.kind === "set" || decision.kind === "forward-caller";
        expect(forwardsTier(undecidedPathBody(target, callerTier))).toBe(serializes);
      }
    });
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

  test("forced Fast injects the policy wire value and forced default drops the caller tier", () => {
    const target = provider({ supportsServiceTier: true, chatServiceTier: true });

    expect(nativeBody(target, "flex", MODEL_ID, true).service_tier).toBe("priority");
    expect(nativeBody(target, undefined, MODEL_ID, true).service_tier).toBe("priority");
    expect(nativeBody(target, "priority", MODEL_ID, false)).not.toHaveProperty("service_tier");
  });

  test("key failover rebuilds the request without reintroducing a dropped foreign tier", async () => {
    const previousHome = process.env.OPENCODEX_HOME;
    const home = mkdtempSync(join(tmpdir(), "ocx-native-tier-failover-"));
    process.env.OPENCODEX_HOME = home;
    const captured: Array<{ authorization: string | null; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured.push({
        authorization: new Headers(init?.headers).get("authorization"),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });
      if (captured.length === 1) {
        return Response.json({ error: { message: "rate limited" } }, {
          status: 429,
          headers: { "retry-after": "0" },
        });
      }
      return Response.json({
        id: "chatcmpl_native_tier_failover",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      });
    }) as typeof fetch;
    const target = provider({
      supportsServiceTier: true,
      chatServiceTier: true,
      fastWire: {
        kind: "service-tier",
        canonicalToWire: { priority: "priority" },
        foreignCallerTiers: "drop",
      },
      apiKey: "key-one",
      apiKeyPool: [{ id: "one", key: "key-one" }, { id: "two", key: "key-two" }],
    });
    const config = {
      port: 0,
      defaultProvider: PROVIDER_NAME,
      providers: { [PROVIDER_NAME]: target },
    } as OcxConfig;

    try {
      saveConfig(config);
      const response = await handleChatCompletions(
        new Request("http://localhost/v1/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: `${PROVIDER_NAME}/${MODEL_ID}`,
            messages: [{ role: "user", content: "ping" }],
            service_tier: "flex",
          }),
        }),
        config,
        { model: "", provider: "" },
      );

      expect(response.status).toBe(200);
      expect(captured.map(entry => entry.authorization)).toEqual(["Bearer key-one", "Bearer key-two"]);
      expect(captured).toHaveLength(2);
      for (const entry of captured) expect(entry.body).not.toHaveProperty("service_tier");
    } finally {
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      removeTreeWithRetry(home);
    }
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
    {
      name: "classified foreign-tier drop with CallerTierForward",
      config: {
        supportsServiceTier: true,
        chatServiceTier: true,
        fastWire: {
          kind: "service-tier",
          canonicalToWire: { priority: "priority" },
          foreignCallerTiers: "drop",
        },
      },
      callerTier: "flex",
      forwarded: false,
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

  test("forced Fast and forced default make the same decision on both Chat paths", () => {
    const target = provider({ supportsServiceTier: true, chatServiceTier: true });

    for (const fastMode of [true, false] as const) {
      const main = mainPathBody(target, "flex", MODEL_ID, fastMode);
      const native = nativeBody(target, "flex", MODEL_ID, fastMode);
      expect(forwardsTier(native)).toBe(forwardsTier(main));
      expect(native.service_tier).toBe(main.service_tier);
    }
  });

  test("the native lane keeps caller image bytes only for positively vision-capable models", async () => {
    // Scope boundary for the openai-chat inline image budget (see
    // tests/adapters/openai/openai-chat-image-normalization.test.ts). That budget lives in
    // the adapter's buildRequest, but an eligible Chat-inbound request is dispatched down
    // this native lane, which builds through buildOpenAIChatPassthroughRequest and never
    // reaches the normalizer. Asserted through the real handler rather than the builder,
    // so it proves the dispatcher selects that lane. Widening the budget to cover the
    // fast path is a separate contract change.
    const url = `data:image/png;base64,${"A".repeat(4_000_000)}`;
    const captured: string[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured.push(String(init?.body ?? ""));
      return Response.json({
        id: "chatcmpl_native_image",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      });
    }) as typeof fetch;

    const target = provider({
      modelCapabilities: { [MODEL_ID]: { inputModalities: ["text", "image"] } },
    });
    const response = await handleChatCompletions(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: `${PROVIDER_NAME}/${MODEL_ID}`,
          messages: [{
            role: "user",
            content: [
              { type: "text", text: "what is this" },
              ...Array.from({ length: 4 }, () => ({ type: "image_url", image_url: { url } })),
            ],
          }],
        }),
      }),
      { port: 0, defaultProvider: PROVIDER_NAME, providers: { [PROVIDER_NAME]: target } } as OcxConfig,
      { model: "", provider: "" },
    );

    expect(response.status).toBe(200);
    expect(captured).toHaveLength(1);
    const parts = (JSON.parse(captured[0]!) as { messages: Array<{ content: unknown }> })
      .messages.flatMap(m => (Array.isArray(m.content) ? m.content : []))
      .filter((p): p is { type: string; image_url: { url: string } } =>
        typeof p === "object" && p !== null && (p as { type?: unknown }).type === "image_url");
    // Well over the 3.5MiB image budget, and still byte-identical on the wire.
    expect(parts).toHaveLength(4);
    for (const part of parts) expect(part.image_url.url).toBe(url);
  });
});


test("explicit text-only capabilities divert image-bearing native Chat requests", async () => {
  const { isNativeChatRouteEligible } = await import("../../../src/server/chat-native");
  const { routeModel } = await import("../../../src/router");
  const config = { port: 10100, defaultProvider: "custom", providers: { custom: provider({ modelCapabilities: { model: { inputModalities: ["text"] } } }) } } as OcxConfig;
  const route = routeModel(config, "custom/model");
  expect(isNativeChatRouteEligible(route, { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,YQ==" } }] }] }, config)).toBe(false);
  expect(isNativeChatRouteEligible(route, { messages: [{ role: "user", content: "hello" }] }, config)).toBe(true);
});

test("unknown image capability retains native Chat compatibility until capability is known", async () => {
  const { isNativeChatRouteEligible } = await import("../../../src/server/chat-native");
  const { routeModel } = await import("../../../src/router");
  const config = { port: 10100, defaultProvider: "custom", providers: { custom: provider() } } as OcxConfig;
  const route = routeModel(config, "custom/model");
  const imageBody = { messages: [{ role: "user", content: [{
    type: "image_url", image_url: { url: "data:image/png;base64,YQ==" },
  }] }] };
  expect(isNativeChatRouteEligible(route, imageBody, config)).toBe(true);
});
