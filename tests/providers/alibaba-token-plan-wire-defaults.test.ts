/**
 * Alibaba Token Plan (Beijing) serves the same models over both the OpenAI Responses
 * wire and Chat Completions, and Alibaba documents an official Responses API plus a
 * Codex integration guide on the same base (#5097). The registry pins the
 * live-verified models to native Responses for Responses inbound only; chat and
 * anthropic inbound keep the provider-wide chat wire, mirroring the DeepSeek
 * deepseek-v4-flash precedent. The end-to-end cases assert the captured upstream URL
 * because a resolver-only test would pass even if the handleResponses replay flipped
 * the wire back.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { providerConfigSeed } from "../../src/providers/derive";
import { getProviderRegistryEntry } from "../../src/providers/registry";
import { resolveWireProtocolOverride } from "../../src/server/adapter-resolve";
import { handleResponses } from "../../src/server/responses/core";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

const RESPONSES_INBOUND_DEFAULT = ["qwen3.8-flash", "qwen3.7-plus", "glm-5.3"] as const;
const CHAT_SERVED = ["qwen3.8-max", "qwen3.7-max", "qwen3.6-flash", "deepseek-v4-pro", "glm-5.2"] as const;
const INBOUNDS = ["responses", "chat", "anthropic"] as const;

function tokenPlanProvider(): OcxProviderConfig {
  return { ...providerConfigSeed(getProviderRegistryEntry("alibaba-token-plan")!), apiKey: "sk-test" };
}

describe("pinned Token Plan models ride Responses only on Responses inbound", () => {
  for (const model of RESPONSES_INBOUND_DEFAULT) {
    test(`${model} resolves to openai-responses for responses inbound`, () => {
      expect(resolveWireProtocolOverride("alibaba-token-plan", model, tokenPlanProvider(), "responses").adapter)
        .toBe("openai-responses");
    });

    for (const inbound of ["chat", "anthropic"] as const) {
      test(`${model} stays on the provider chat wire for ${inbound} inbound`, () => {
        expect(resolveWireProtocolOverride("alibaba-token-plan", model, tokenPlanProvider(), inbound).adapter)
          .toBe("openai-chat");
      });
    }
  }
});

describe("unpinned Token Plan models keep the provider chat wire", () => {
  for (const model of CHAT_SERVED) {
    test(`${model} stays on openai-chat for every inbound`, () => {
      for (const inbound of INBOUNDS) {
        expect(resolveWireProtocolOverride("alibaba-token-plan", model, tokenPlanProvider(), inbound).adapter)
          .toBe("openai-chat");
      }
    });
  }
});

describe("explicit modelAdapters beat the Token Plan defaults in both directions", () => {
  test("opt-out: qwen3.8-flash pinned back to chat for responses inbound", () => {
    const provider = { ...tokenPlanProvider(), modelAdapters: { "qwen3.8-flash": "openai-chat" } };
    expect(resolveWireProtocolOverride("alibaba-token-plan", "qwen3.8-flash", provider, "responses").adapter)
      .toBe("openai-chat");
  });

  test("opt-in: an unpinned model mapped to Responses", () => {
    const provider = { ...tokenPlanProvider(), modelAdapters: { "deepseek-v4.1-flash": "openai-responses" } };
    expect(resolveWireProtocolOverride("alibaba-token-plan", "deepseek-v4.1-flash", provider, "responses").adapter)
      .toBe("openai-responses");
  });
});

describe("the Token Plan default is isolated to the registry provider", () => {
  test("qwen3.8-flash on a custom provider is untouched", () => {
    const other: OcxProviderConfig = { adapter: "openai-chat", baseUrl: "https://example.com/v1", apiKey: "sk-test" };
    for (const inbound of INBOUNDS) {
      expect(resolveWireProtocolOverride("some-custom", "qwen3.8-flash", other, inbound).adapter)
        .toBe("openai-chat");
    }
  });

  test("resolution preserves credentials and the base URL through the copy", () => {
    const resolved = resolveWireProtocolOverride("alibaba-token-plan", "qwen3.8-flash", tokenPlanProvider(), "responses");
    expect(resolved.adapter).toBe("openai-responses");
    expect(resolved.apiKey).toBe("sk-test");
    expect(resolved.baseUrl).toBe("https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1");
  });
});

describe("the Token Plan wire default survives the handleResponses replay", () => {
  const originalFetch = globalThis.fetch;
  let releaseSpendHome: (() => void) | undefined;

  afterEach(() => {
    releaseSpendHome?.();
    releaseSpendHome = undefined;
    globalThis.fetch = originalFetch;
  });

  type Captured = { url: string; body: Record<string, unknown> };

  function captureUpstream(): Captured[] {
    const seen: Captured[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return new Response("data: [DONE]\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;
    return seen;
  }

  async function driveCapture(
    model: string,
    inboundWire: "responses" | "chat" | "anthropic",
    extra: Record<string, unknown> = {},
  ): Promise<Captured | undefined> {
    const seen = captureUpstream();
    const config = { providers: { "alibaba-token-plan": tokenPlanProvider() } } as unknown as OcxConfig;
    releaseSpendHome ??= acquireOwnedSpendHome();
    await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: `alibaba-token-plan/${model}`, input: "ping", stream: true, ...extra }),
      }),
      config,
      { model: "", provider: "" },
      { inboundWire },
    );
    return seen[0];
  }

  async function drive(model: string, inboundWire: "responses" | "chat" | "anthropic"): Promise<string> {
    return (await driveCapture(model, inboundWire))?.url ?? "";
  }

  test("qwen3.8-flash reaches the Responses upstream, never /chat/completions", async () => {
    const url = await drive("qwen3.8-flash", "responses");
    expect(url).toContain("token-plan.cn-beijing.maas.aliyuncs.com");
    expect(url).toContain("/responses");
    expect(url).not.toContain("chat/completions");
  });

  // The review on #5188 asked for this model by name: it is the only pinned model that
  // loses thinkingBudgetModels' numeric thinking_budget translation when it moves to the
  // Responses wire, so its upstream URL has to be pinned by evidence, not by symmetry
  // with the other two.
  test("qwen3.7-plus reaches the Responses upstream, never /chat/completions", async () => {
    const url = await drive("qwen3.7-plus", "responses");
    expect(url).toContain("token-plan.cn-beijing.maas.aliyuncs.com");
    expect(url).toContain("/responses");
    expect(url).not.toContain("chat/completions");
  });

  // Moving qwen3.7-plus off Chat drops the numeric thinking_budget translation. The live
  // evidence on #5188 is that this gateway accepts the whole effort ladder as
  // reasoning.effort strings on the Responses wire, so the outgoing body must carry the
  // caller's effort as that string and no Chat-side budget field.
  test("qwen3.7-plus sends the caller's effort as reasoning.effort on the Responses wire", async () => {
    const captured = await driveCapture("qwen3.7-plus", "responses", { reasoning: { effort: "high" } });
    expect(captured?.url).toContain("/responses");
    const reasoning = captured?.body.reasoning as Record<string, unknown> | undefined;
    expect(reasoning?.effort).toBe("high");
    expect(Object.hasOwn(captured?.body ?? {}, "thinking_budget")).toBe(false);
  });

  test("glm-5.3 reaches the Responses upstream on a responses inbound", async () => {
    const url = await drive("glm-5.3", "responses");
    expect(url).toContain("token-plan.cn-beijing.maas.aliyuncs.com");
    expect(url).toContain("/responses");
    expect(url).not.toContain("chat/completions");
  });

  test("qwen3.8-flash keeps the chat upstream on a chat inbound replay", async () => {
    const url = await drive("qwen3.8-flash", "chat");
    expect(url).toContain("token-plan.cn-beijing.maas.aliyuncs.com");
    expect(url).toContain("chat/completions");
  });

  test("glm-5.3 keeps the chat upstream on an anthropic inbound replay", async () => {
    const url = await drive("glm-5.3", "anthropic");
    expect(url).toContain("chat/completions");
  });

  test("qwen3.8-max (unpinned) keeps the chat upstream on a responses inbound", async () => {
    const url = await drive("qwen3.8-max", "responses");
    expect(url).toContain("chat/completions");
  });
});

describe("pinned replay keeps plaintext reasoning content on the Responses wire", () => {
  const originalFetch = globalThis.fetch;
  let releaseSpendHome: (() => void) | undefined;

  afterEach(() => {
    releaseSpendHome?.();
    releaseSpendHome = undefined;
    globalThis.fetch = originalFetch;
  });

  // The pin moved these models onto the Responses serializer, whose
  // sanitizeReasoningInputContent blanks replayed reasoning content unless
  // preserveResponsesReasoningContent is set — the flag the Chat-side
  // preserveReasoningContentModels list does not cover. DeepSeek and Z.AI set the flag beside
  // their pins; this entry keeps the pairing, or the pinned models would replay with strictly
  // less state than they carry on Chat (the #5097 opt-in record never exercised plaintext replay).
  async function driveReplay(provider: OcxProviderConfig): Promise<{ url: string; reasoningContent: unknown[] | undefined }> {
    const seen: { url: string; body: Record<string, unknown> }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return new Response("data: [DONE]\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;
    releaseSpendHome ??= acquireOwnedSpendHome();
    await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "alibaba-token-plan/qwen3.8-flash",
          input: [
            { type: "message", role: "user", content: [{ type: "input_text", text: "ping" }] },
            { type: "reasoning", id: "rs_1", summary: [], content: [{ type: "reasoning_text", text: "keep me" }] },
          ],
          stream: true,
        }),
      }),
      { providers: { "alibaba-token-plan": provider } } as unknown as OcxConfig,
      { model: "", provider: "" },
      { inboundWire: "responses" },
    );
    const first = seen[0];
    if (!first) return { url: "", reasoningContent: undefined };
    const reasoning = (first.body.input as unknown[] | undefined)?.find(
      (item): item is Record<string, unknown> =>
        typeof item === "object" && item !== null && (item as Record<string, unknown>).type === "reasoning",
    );
    return { url: first.url, reasoningContent: reasoning?.content as unknown[] | undefined };
  }

  test("the registry flag preserves replayed reasoning content on the pinned wire", async () => {
    const { url, reasoningContent } = await driveReplay(tokenPlanProvider());
    expect(url).toContain("/responses");
    expect(reasoningContent).toEqual([{ type: "reasoning_text", text: "keep me" }]);
  });

  test("without the flag the same replay is blanked — the flag is what preserves it", async () => {
    const provider = { ...tokenPlanProvider(), preserveResponsesReasoningContent: false };
    const { url, reasoningContent } = await driveReplay(provider);
    expect(url).toContain("/responses");
    expect(reasoningContent).toEqual([]);
  });
});
