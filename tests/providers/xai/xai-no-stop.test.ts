import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter, buildOpenAIChatPassthroughRequest } from "../../../src/adapters/openai-chat";
import { createResponsesPassthroughAdapter } from "../../../src/adapters/openai-responses";
import { PROVIDER_REGISTRY } from "../../../src/providers/registry";
import { routedProviderConfig } from "../../../src/router";
import type { OcxParsedRequest, OcxProviderConfig } from "../../../src/types";
import { withTestTranslatorBudget } from "../../helpers/translator-budget";

const XAI_NO_STOP_MODELS = [
  "grok-4.7",
  "grok-4.6",
  "grok-4.5",
  "grok-4.3",
  "grok-4.20-multi-agent-0309",
  "grok-4.20-0309-reasoning",
  "grok-build-0.1",
] as const;

function xaiProvider(): OcxProviderConfig {
  return {
    adapter: "openai-chat",
    baseUrl: "https://api.x.ai/v1",
    apiKey: "sk-test",
    authMode: "key",
    noStopModels: [...XAI_NO_STOP_MODELS],
  };
}

function parsed(modelId: string): OcxParsedRequest {
  return {
    modelId,
    context: { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
    stream: false,
    options: { stopSequences: ["END"] },
  };
}

describe("xAI noStopModels", () => {
  test("seeds documented reasoning ids that reject Chat Completions stop", () => {
    const xai = PROVIDER_REGISTRY.find(provider => provider.id === "xai");
    expect(xai?.noStopModels).toEqual([...XAI_NO_STOP_MODELS]);
    expect(xai?.noStopModels).not.toContain("grok-4.20-0309-non-reasoning");
    expect(xai?.noStopModels).not.toContain("grok-composer-2.5-fast");
  });

  // Live 2026-09-23: `ocx-claude-xai--grok-4.7` + stop_sequences -> 400 "Model grok-4.7 does not
  // support parameter stop." — the same auto-mode classifier break, one release later.
  test("seed covers grok-4.7", () => {
    const xai = PROVIDER_REGISTRY.find(provider => provider.id === "xai");
    expect(xai?.noStopModels).toContain("grok-4.7");
  });

  test("openai-chat omits stop for grok-4.6 and forwards it for other ids", () => {
    const adapter = createOpenAIChatAdapter(xaiProvider());
    const dropped = JSON.parse(adapter.buildRequest(parsed("grok-4.6")).body as string) as { stop?: unknown };
    expect(dropped.stop).toBeUndefined();
    const forwarded = JSON.parse(
      adapter.buildRequest(parsed("grok-composer-2.5-fast")).body as string,
    ) as { stop?: unknown };
    expect(forwarded.stop).toEqual(["END"]);
  });

  test("routedProviderConfig fills noStopModels on a bare xAI row", () => {
    const routed = routedProviderConfig("xai", {
      adapter: "openai-chat",
      baseUrl: "https://api.x.ai/v1",
      apiKey: "sk-test",
      authMode: "key",
    });
    expect(routed.noStopModels).toEqual([...XAI_NO_STOP_MODELS]);
    const dropped = JSON.parse(
      createOpenAIChatAdapter(routed).buildRequest(parsed("grok-4.6")).body as string,
    ) as { stop?: unknown };
    expect(dropped.stop).toBeUndefined();
  });

  test("passthrough omits stop for grok-4.6 and forwards it for other ids", () => {
    const provider = xaiProvider();
    const dropped = JSON.parse(buildOpenAIChatPassthroughRequest(
      provider,
      { model: "grok-4.6", messages: [], stop: ["END"] },
      "grok-4.6",
      false,
    ).body) as { stop?: unknown };
    expect(dropped.stop).toBeUndefined();
    const forwarded = JSON.parse(buildOpenAIChatPassthroughRequest(
      provider,
      { model: "grok-composer-2.5-fast", messages: [], stop: ["END"] },
      "grok-composer-2.5-fast",
      false,
    ).body) as { stop?: unknown };
    expect(forwarded.stop).toEqual(["END"]);
  });

  // grok-4.20-multi-agent-0309 has no Chat wire, so a Claude Code request reaches it as a
  // Responses body whose `stop` came from `stop_sequences` (src/claude/inbound.ts).
  test("Responses passthrough omits stop and penalties for listed ids and forwards them for others", () => {
    const adapter = withTestTranslatorBudget(createResponsesPassthroughAdapter({
      ...xaiProvider(),
      noPenaltyModels: [...XAI_NO_STOP_MODELS],
      adapter: "openai-responses",
    }));
    const build = (modelId: string) => JSON.parse(adapter.buildRequest({
      modelId,
      context: { messages: [] },
      stream: false,
      options: {},
      _rawBody: { model: modelId, input: "hi", stop: ["END"], presence_penalty: 0.1, frequency_penalty: 0.2 },
    }, { headers: new Headers() }).body) as { stop?: unknown; presence_penalty?: unknown; frequency_penalty?: unknown };
    const dropped = build("grok-4.20-multi-agent-0309");
    expect(dropped.stop).toBeUndefined();
    expect(dropped.presence_penalty).toBeUndefined();
    expect(dropped.frequency_penalty).toBeUndefined();
    const kept = build("grok-4.20-0309-non-reasoning");
    expect(kept.stop).toEqual(["END"]);
    expect(kept.presence_penalty).toBe(0.1);
    expect(kept.frequency_penalty).toBe(0.2);
  });
});
