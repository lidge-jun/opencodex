import { describe, expect, test } from "bun:test";
import {
  adapterDefinitions,
  createRegisteredAdapter,
  effectiveAdapterContract,
  getAdapterDefinition,
} from "../src/adapters/registry";
import { resolveAdapter } from "../src/server/adapter-resolve";
import type { OcxParsedRequest, OcxProviderConfig } from "../src/types";
import { withTestTranslatorBudget } from "./helpers/translator-budget";

const EXPECTED_ADAPTER_NAMES = {
  "command-code": "command-code",
  "openai-chat": "openai-chat",
  "ollama-native": "ollama-native",
  anthropic: "anthropic",
  "openai-responses": "openai-responses",
  google: "google",
  kiro: "kiro",
  azure: "azure-openai",
  "azure-openai": "azure-openai",
  cursor: "cursor",
  "mimo-free": "mimo-free",
} as const;

function provider(adapter: string): OcxProviderConfig {
  return {
    adapter,
    // mimo-free throws for non-canonical endpoints since #1714; every other
    // adapter accepts the placeholder URL.
    baseUrl: adapter === "mimo-free"
      ? "https://api.xiaomimimo.com/api/free-ai/openai/chat"
      // ollama-native refuses a bare /v1 path on a host it does not recognise, rather than
      // guessing that an arbitrary destination speaks Ollama's compatibility surface.
      : adapter === "ollama-native"
        ? "https://example.invalid/api"
        : "https://example.invalid/v1",
    authMode: "key",
    apiKey: "test-key",
    defaultMaxOutputTokens: 4096,
  } as OcxProviderConfig;
}

const ANTHROPIC_CACHE_REQUEST: OcxParsedRequest = {
  modelId: "claude-haiku-4-5",
  stream: true,
  options: {},
  context: {
    messages: [{ role: "user", content: "cache me", timestamp: 0 }],
  },
};

async function expectLongCacheRetention(adapter: ReturnType<typeof resolveAdapter>): Promise<void> {
  const request = await withTestTranslatorBudget(adapter).buildRequest(ANTHROPIC_CACHE_REQUEST);
  const body = JSON.parse(request.body) as {
    messages?: Array<{ content?: string | Array<{ cache_control?: { type?: string; ttl?: string } }> }>;
  };
  const content = body.messages?.[0]?.content;
  if (!Array.isArray(content)) throw new Error("expected Anthropic cache retention to annotate user content");
  expect(content.at(-1)?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
}

describe("adapter registry authority", () => {
  test("enumerates every production adapter exactly once", () => {
    expect(adapterDefinitions().map(([id]) => id)).toEqual(Object.keys(EXPECTED_ADAPTER_NAMES));
  });

  test("records semantic inheritance without forcing constructor wrapping", () => {
    expect(getAdapterDefinition("azure")?.contractParent).toBe("openai-responses");
    expect(getAdapterDefinition("azure-openai")?.contractParent).toBe("openai-responses");
    expect(getAdapterDefinition("mimo-free")?.contractParent).toBe("openai-chat");

    expect(effectiveAdapterContract("azure").wire).toBe("openai-responses");
    expect(effectiveAdapterContract("azure-openai").wire).toBe("openai-responses");
    expect(effectiveAdapterContract("mimo-free").wire).toBe("openai-chat");
    expect(effectiveAdapterContract("cursor").mutation).toBe("codex-owned-with-gated-native-fallback");
  });

  test("constructs every current adapter with its existing observable identity", () => {
    for (const [adapterId, expectedName] of Object.entries(EXPECTED_ADAPTER_NAMES)) {
      expect(createRegisteredAdapter(provider(adapterId)).name, adapterId).toBe(expectedName);
      expect(resolveAdapter(provider(adapterId)).name, adapterId).toBe(expectedName);
    }
  });

  test("forwards Anthropic cache retention through registry and server resolution", async () => {
    await expectLongCacheRetention(createRegisteredAdapter(provider("anthropic"), { cacheRetention: "long" }));
    await expectLongCacheRetention(resolveAdapter(provider("anthropic"), "long"));
  });

  test("rejects unknown persisted adapter ids at the runtime boundary", () => {
    for (const adapterId of ["not-a-real-adapter", "__proto__", "constructor"]) {
      expect(() => createRegisteredAdapter(provider(adapterId)))
        .toThrow(`Unknown adapter: ${adapterId}`);
      expect(() => effectiveAdapterContract(adapterId))
        .toThrow(`Unknown adapter: ${adapterId}`);
    }
  });

  test("rejects non-string persisted adapter ids before registry lookup", () => {
    for (const adapterId of [null, 42, ["azure"]]) {
      expect(getAdapterDefinition(adapterId)).toBeUndefined();
      const malformed = { ...provider("anthropic"), adapter: adapterId } as unknown as OcxProviderConfig;
      expect(() => createRegisteredAdapter(malformed)).toThrow("Unknown adapter:");
    }
  });
});
