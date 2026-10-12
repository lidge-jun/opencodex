/**
 * Alibaba Token Plan (Beijing) serves the same models over both Chat Completions and an
 * OpenAI-compatible Responses API on the same /compatible-mode/v1 base, and Alibaba ships an
 * official Codex integration guide on wire_api = "responses" (#5097). Three models carry live
 * end-to-end evidence on that gateway: qwen3.8-flash, qwen3.7-plus and glm-5.3.
 *
 * That evidence now backs the registry modelWireDefaults pin in
 * alibaba-token-plan-wire-defaults.test.ts together with the entry-level
 * preserveResponsesReasoningContent flag: the flag that was the open delta when the opt-in
 * landed (#5198) is measured live on this gateway (#5188), because the entry preserves
 * plaintext reasoning content on the Chat wire through preserveReasoningContentModels, and
 * the Responses serializer reads the separate flag. Z.AI and DeepSeek set both flags for
 * exactly this reason.
 *
 * These cases lock the documented per-model modelAdapters opt-in for the REST of the family
 * (and the opt-out against the pins) so neither can silently regress, and keep the guard that
 * a Responses wire default must carry the Responses-side preservation beside it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { providerConfigSeed } from "../../src/providers/derive";
import { getProviderRegistryEntry } from "../../src/providers/registry";
import { resolveWireProtocolOverride } from "../../src/server/adapter-resolve";
import { handleResponses } from "../../src/server/responses/core";
import { ALIBABA_TOKEN_PLAN_PRESERVE_REASONING } from "../../src/providers/registry/model-seeds";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

const LIVE_VERIFIED = ["qwen3.8-flash", "qwen3.7-plus", "glm-5.3"] as const;
const INBOUNDS = ["responses", "chat", "anthropic"] as const;

function tokenPlanProvider(): OcxProviderConfig {
  return { ...providerConfigSeed(getProviderRegistryEntry("alibaba-token-plan")!), apiKey: "sk-test" };
}

describe("chat and anthropic inbound keep the provider chat wire", () => {
  for (const model of LIVE_VERIFIED) {
    for (const inbound of ["chat", "anthropic"] as const) {
      test(`${model} stays on the provider chat wire for ${inbound} inbound`, () => {
        expect(resolveWireProtocolOverride("alibaba-token-plan", model, tokenPlanProvider(), inbound).adapter)
          .toBe("openai-chat");
      });
    }
  }

  test("the pins are exactly the live-verified models, scoped to responses inbound", () => {
    const entry = getProviderRegistryEntry("alibaba-token-plan")!;
    expect(Object.keys(entry.modelWireDefaults ?? {}).sort()).toEqual([...LIVE_VERIFIED].sort());
    for (const declared of Object.values(entry.modelWireDefaults ?? {})) {
      expect(typeof declared === "string" ? undefined : declared.inbound).toEqual(["responses"]);
    }
  });
});

describe("the documented Responses opt-in resolves and reaches the native wire", () => {
  for (const model of LIVE_VERIFIED) {
    test(`modelAdapters selects openai-responses for ${model}`, () => {
      const provider = { ...tokenPlanProvider(), modelAdapters: { [model]: "openai-responses" } };
      const resolved = resolveWireProtocolOverride("alibaba-token-plan", model, provider, "responses");
      expect(resolved.adapter).toBe("openai-responses");
      expect(resolved.apiKey).toBe("sk-test");
      expect(resolved.baseUrl).toBe("https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1");
    });
  }

  test("an unrelated provider is untouched by the opt-in", () => {
    const other: OcxProviderConfig = { adapter: "openai-chat", baseUrl: "https://example.com/v1", apiKey: "sk-test" };
    for (const inbound of INBOUNDS) {
      expect(resolveWireProtocolOverride("some-custom", "qwen3.8-flash", other, inbound).adapter)
        .toBe("openai-chat");
    }
  });
});

describe("the opt-in survives the handleResponses replay", () => {
  const originalFetch = globalThis.fetch;
  let releaseSpendHome: (() => void) | undefined;

  afterEach(() => {
    releaseSpendHome?.();
    releaseSpendHome = undefined;
    globalThis.fetch = originalFetch;
  });

  // A resolver-only assertion would pass even if the replay flipped the wire back, so the
  // upstream URL the request actually reached is what these cases read.
  async function drive(model: string, modelAdapters?: Record<string, string>): Promise<string> {
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response("data: [DONE]\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;
    const provider = modelAdapters ? { ...tokenPlanProvider(), modelAdapters } : tokenPlanProvider();
    const config = { providers: { "alibaba-token-plan": provider } } as unknown as OcxConfig;
    releaseSpendHome ??= acquireOwnedSpendHome();
    await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: `alibaba-token-plan/${model}`, input: "ping", stream: true }),
      }),
      config,
      { model: "", provider: "" },
      { inboundWire: "responses" },
    );
    return urls[0] ?? "";
  }

  test("qwen3.8-flash reaches /responses once opted in", async () => {
    const url = await drive("qwen3.8-flash", { "qwen3.8-flash": "openai-responses" });
    expect(url).toContain("token-plan.cn-beijing.maas.aliyuncs.com");
    expect(url).toContain("/responses");
    expect(url).not.toContain("chat/completions");
  });

  test("an unpinned family member reaches /chat/completions without the opt-in", async () => {
    const url = await drive("qwen3.8-max");
    expect(url).toContain("token-plan.cn-beijing.maas.aliyuncs.com");
    expect(url).toContain("chat/completions");
  });

  test("an unpinned family member reaches /responses once opted in", async () => {
    const url = await drive("qwen3.8-max", { "qwen3.8-max": "openai-responses" });
    expect(url).toContain("token-plan.cn-beijing.maas.aliyuncs.com");
    expect(url).toContain("/responses");
    expect(url).not.toContain("chat/completions");
  });
});

describe("a Responses default flip must carry Responses-side reasoning preservation", () => {
  test("the Chat wire already preserves reasoning content for the live-verified models", () => {
    for (const model of LIVE_VERIFIED) {
      expect(ALIBABA_TOKEN_PLAN_PRESERVE_REASONING).toContain(model);
    }
    expect(getProviderRegistryEntry("alibaba-token-plan")!.preserveReasoningContentModels)
      .toEqual(ALIBABA_TOKEN_PLAN_PRESERVE_REASONING);
  });

  // The guard, not a restatement of the case above: preserveReasoningContentModels is read by the
  // Chat adapter only. If this entry ever declares a Responses wire default, the Responses
  // serializer's own flag has to be set too, or the pinned models silently start replaying with
  // blanked reasoning content.
  test("declaring a Responses wire default without the Responses flag fails here", () => {
    const entry = getProviderRegistryEntry("alibaba-token-plan")!;
    const pinsResponses = Object.values(entry.modelWireDefaults ?? {})
      .some(declared => (typeof declared === "string" ? declared : declared.wire) === "openai-responses");
    if (!pinsResponses) {
      expect(entry.preserveResponsesReasoningContent).toBeUndefined();
      return;
    }
    expect(entry.preserveResponsesReasoningContent).toBe(true);
  });
});
