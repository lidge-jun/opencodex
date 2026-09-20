import { describe, expect, test } from "bun:test";
import {
  buildOpenAIChatPassthroughRequest,
  createOpenAIChatAdapter as createOpenAIChatAdapterProduction,
} from "../../../src/adapters/openai-chat";
import { PROVIDER_REGISTRY } from "../../../src/providers/registry";
import { XAI_MODELS } from "../../../src/providers/registry/model-seeds";
import { routeModel } from "../../../src/router";
import type { OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../../../src/types";
import { withTestTranslatorBudget } from "../../helpers/translator-budget";

const createOpenAIChatAdapter = (...args: Parameters<typeof createOpenAIChatAdapterProduction>) =>
  withTestTranslatorBudget(createOpenAIChatAdapterProduction(...args));

function parsed(modelId: string, stopSequences: string[] = ["END"]): OcxParsedRequest {
  return {
    modelId,
    context: { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
    stream: false,
    options: { stopSequences },
  };
}

function provider(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return {
    adapter: "openai-chat",
    baseUrl: "https://example.test/v1",
    apiKey: "sk-test",
    authMode: "key",
    ...overrides,
  };
}

function translatedBody(cfg: OcxProviderConfig, modelId: string): Record<string, unknown> {
  return JSON.parse(createOpenAIChatAdapter(cfg).buildRequest(parsed(modelId)).body as string) as Record<string, unknown>;
}

function passthroughBody(
  cfg: OcxProviderConfig,
  modelId: string,
  raw: Record<string, unknown> = { messages: [{ role: "user", content: "hi" }], stop: ["END"] },
): Record<string, unknown> {
  return JSON.parse(buildOpenAIChatPassthroughRequest(cfg, raw, modelId, false).body as string) as Record<string, unknown>;
}

describe("noStopModels omits Chat Completions stop", () => {
  const gated = provider({ noStopModels: ["grok-4.6"] });

  test("translated path drops stop for a listed model", () => {
    expect(translatedBody(gated, "grok-4.6").stop).toBeUndefined();
  });

  test("translated path keeps stop for an unlisted sibling", () => {
    expect(translatedBody(gated, "other-model").stop).toEqual(["END"]);
  });

  test("an unset noStopModels list still forwards stop", () => {
    expect(translatedBody(provider(), "grok-4.6").stop).toEqual(["END"]);
  });

  test("passthrough path deletes inbound stop for a listed model", () => {
    expect(passthroughBody(gated, "grok-4.6").stop).toBeUndefined();
  });

  test("passthrough path keeps inbound stop for an unlisted sibling", () => {
    expect(passthroughBody(gated, "other-model").stop).toEqual(["END"]);
  });

  test("passthrough does not mutate the caller body", () => {
    const raw = { messages: [{ role: "user", content: "hi" }], stop: ["END"] };
    passthroughBody(gated, "grok-4.6", raw);
    expect(raw.stop).toEqual(["END"]);
  });

  test("xAI registry seed lists every catalog model", () => {
    const xai = PROVIDER_REGISTRY.find((entry) => entry.id === "xai");
    expect(xai?.noStopModels).toEqual(XAI_MODELS);
    expect(xai?.noStopModels).toContain("grok-4.6");
    expect(xai?.noStopModels).toContain("grok-4.20-multi-agent-0309");
  });

  test("routed xAI Chat Completions omits stop for grok-4.6", () => {
    const config = {
      port: 10100,
      defaultProvider: "xai",
      providers: {
        xai: {
          adapter: "openai-chat",
          baseUrl: "https://api.x.ai/v1",
          apiKey: "sk-test",
          authMode: "key",
        },
      },
    } as OcxConfig;
    const routed = routeModel(config, "xai/grok-4.6").provider;
    expect(routed.noStopModels).toContain("grok-4.6");
    expect(translatedBody(routed, "grok-4.6").stop).toBeUndefined();
    expect(passthroughBody(routed, "grok-4.6").stop).toBeUndefined();
  });
});
