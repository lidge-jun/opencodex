import { describe, expect, test } from "bun:test";
import { PROVIDER_REGISTRY } from "../src/providers/registry";
import { providerConfigSeed, deriveKeyLoginMap, deriveFeaturedProviderIds } from "../src/providers/derive";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
import { routedProviderConfig } from "../src/router";
import { buildModelsRequest } from "../src/oauth";
import type { OcxParsedRequest, OcxProviderConfig } from "../src/types";

function minimalRequest(model = "kimi-k2.7-code"): OcxParsedRequest {
  return {
    modelId: model,
    stream: false,
    context: { messages: [{ role: "user", content: "hi" }], tools: [] },
    options: {},
  };
}

describe("opencode-free provider", () => {
  const entry = PROVIDER_REGISTRY.find(e => e.id === "opencode-free");

  test("registry entry exists with correct shape", () => {
    expect(entry).toBeDefined();
    expect(entry?.adapter).toBe("openai-chat");
    expect(entry?.baseUrl).toBe("https://opencode.ai/zen/v1");
    expect(entry?.authKind).toBe("key");
    expect(entry?.keyOptional).toBe(true);
    expect(entry?.featured).toBe(true);
    expect(entry?.liveModels).toBe(true);
    expect(entry?.models).toBeUndefined();
  });

  test("static headers include only the public client markers", () => {
    expect(entry?.staticHeaders?.["Authorization"]).toBeUndefined();
    expect(entry?.staticHeaders?.["User-Agent"]).toBe("opencode");
    expect(entry?.staticHeaders?.["x-opencode-client"]).toBe("desktop");
  });

  test("providerConfigSeed propagates static headers", () => {
    const seed = providerConfigSeed(entry!);
    expect(seed.headers?.["Authorization"]).toBeUndefined();
    expect(seed.headers?.["User-Agent"]).toBe("opencode");
    expect(seed.headers?.["x-opencode-client"]).toBe("desktop");
    expect(seed.keyOptional).toBe(true);
    expect(seed.liveModels).toBe(true);
  });

  test("is included in the key-login map (keyOptional = true)", () => {
    const keyMap = deriveKeyLoginMap();
    expect(keyMap["opencode-free"]).toBeDefined();
  });

  test("is in the featured provider list", () => {
    expect(deriveFeaturedProviderIds()).toContain("opencode-free");
  });

  test("adapter sends no auth header with no apiKey configured", () => {
    const provider: OcxProviderConfig = providerConfigSeed(entry!);
    const adapter = createOpenAIChatAdapter(provider);
    const req = adapter.buildRequest(minimalRequest());
    const headers = req.headers as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
    expect(headers["User-Agent"]).toBe("opencode");
    expect(headers["x-opencode-client"]).toBe("desktop");
    expect(req.url).toBe("https://opencode.ai/zen/v1/chat/completions");
  });

  test("user-supplied apiKey is sent when configured", () => {
    const provider: OcxProviderConfig = {
      ...providerConfigSeed(entry!),
      apiKey: "user-secret-key",
    };
    const adapter = createOpenAIChatAdapter(provider);
    const req = adapter.buildRequest(minimalRequest());
    const headers = req.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer user-secret-key");
    expect(headers["x-opencode-client"]).toBe("desktop");
  });

  test("the provider client marker still applies when a user apiKey is present", () => {
    const provider: OcxProviderConfig = {
      ...providerConfigSeed(entry!),
      apiKey: "user-secret-key",
    };
    const adapter = createOpenAIChatAdapter(provider);
    const req = adapter.buildRequest(minimalRequest());
    const headers = req.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer user-secret-key");
    expect(headers["x-opencode-client"]).toBe("desktop");
    expect(Object.keys(headers)).toContain("Authorization");
  });

  // A seeded config is the easy case. The one that actually reaches users is a config written
  // BEFORE a static header existed: it is on disk with the old header set (or with none at all,
  // because the management API strips a block that exactly matches the registry), and nothing
  // rewrites it. If the header only arrives at seed time, every existing install stays on the
  // old fingerprint forever — which is what the original #2067 patch would have shipped.
  describe("existing installs receive newly added static headers", () => {
    const persisted = (headers?: Record<string, string>): OcxProviderConfig => ({
      adapter: "openai-chat",
      baseUrl: "https://opencode.ai/zen/v1",
      keyOptional: true,
      ...(headers ? { headers } : {}),
    });

    test("a config saved with no header block gains the full registry set", () => {
      const routed = routedProviderConfig("opencode-free", persisted());
      expect(routed.headers?.["User-Agent"]).toBe("opencode");
      expect(routed.headers?.["x-opencode-client"]).toBe("desktop");
    });

    test("a config saved with only the older marker gains the new one", () => {
      const routed = routedProviderConfig("opencode-free", persisted({ "x-opencode-client": "desktop" }));
      expect(routed.headers?.["User-Agent"]).toBe("opencode");
      expect(routed.headers?.["x-opencode-client"]).toBe("desktop");
    });

    test("the merged headers reach the wire, not just the resolved config", () => {
      const routed = routedProviderConfig("opencode-free", persisted({ "x-opencode-client": "desktop" }));
      const req = createOpenAIChatAdapter(routed).buildRequest(minimalRequest());
      expect((req.headers as Record<string, string>)["User-Agent"]).toBe("opencode");
    });

    test("a user override wins and does not become a second comma-joined value", () => {
      // HTTP header names are case-insensitive but object keys are not: a naive spread would
      // leave both "user-agent" and "User-Agent", which `Headers` serializes as
      // "custom-agent, opencode" — a corrupted request rather than an override.
      const routed = routedProviderConfig("opencode-free", persisted({ "user-agent": "custom-agent" }));
      const uaKeys = Object.keys(routed.headers ?? {}).filter(k => k.toLowerCase() === "user-agent");
      expect(uaKeys).toEqual(["user-agent"]);
      expect(routed.headers?.["user-agent"]).toBe("custom-agent");
      expect(new Headers(routed.headers as Record<string, string>).get("user-agent")).toBe("custom-agent");
      // Names the user did not claim are still filled.
      expect(routed.headers?.["x-opencode-client"]).toBe("desktop");
    });

    test("model discovery carries the same fingerprint as inference", () => {
      // A provider identified as `opencode` when it completes but anonymous when it lists its
      // own models reads as two different clients to an upstream rate limiter.
      const req = buildModelsRequest(persisted({ "x-opencode-client": "desktop" }), undefined, "opencode-free");
      expect(req.headers["User-Agent"]).toBe("opencode");
      expect(req.headers["x-opencode-client"]).toBe("desktop");
    });

    test("model discovery honors a user User-Agent override", () => {
      const req = buildModelsRequest(persisted({ "user-agent": "custom-agent" }), undefined, "opencode-free");
      const uaKeys = Object.keys(req.headers).filter(k => k.toLowerCase() === "user-agent");
      expect(uaKeys).toEqual(["user-agent"]);
      expect(req.headers["user-agent"]).toBe("custom-agent");
    });
  });

  test("provider note mentions no key needed", () => {
    expect(entry?.note?.toLowerCase()).toContain("no key needed");
    expect(entry?.note?.toLowerCase()).toContain("200");
    expect(entry?.note?.toLowerCase()).toContain("discovered live from zen");
  });

  test("DeepSeek Free preserves reasoning content for tool-call history", () => {
    const provider: OcxProviderConfig = providerConfigSeed(entry!);
    const request = adapterRequest("deepseek-v4-flash-free");
    const body = JSON.parse(createOpenAIChatAdapter(provider).buildRequest(request).body as string) as {
      messages: Array<Record<string, unknown> & { reasoning_content?: string }>;
    };
    expect(body.messages.find(message => message.role === "assistant")?.reasoning_content)
      .toBe("previous reasoning");
  });

  test("Zen-bound tool schemas are normalized to an object root", () => {
    const provider: OcxProviderConfig = providerConfigSeed(entry!);
    const request: OcxParsedRequest = {
      modelId: "deepseek-v4-flash-free",
      stream: false,
      context: {
        messages: [{ role: "user", content: "hi" }],
        tools: [
          {
            name: "arr",
            description: "array-root",
            parameters: { type: ["object", "null"], properties: { a: { type: "string" } } },
          },
          {
            name: "comp",
            description: "root-oneOf",
            parameters: {
              oneOf: [
                { type: "object", properties: { x: { type: "string" } } },
                { type: "object", properties: { y: { type: "number" } } },
              ],
            },
          },
        ],
      },
      options: {},
    };

    const body = JSON.parse(createOpenAIChatAdapter(provider).buildRequest(request).body as string) as {
      tools: Array<{ function: { parameters: Record<string, unknown> } }>;
    };

    expect(body.tools[0].function.parameters.type).toBe("object");
    expect(body.tools[0].function.parameters.properties).toEqual({ a: { type: "string" } });
    expect(body.tools[1].function.parameters.type).toBe("object");
    expect(body.tools[1].function.parameters.oneOf).toBeUndefined();
    expect(body.tools[1].function.parameters.properties).toEqual({
      x: { type: "string" },
      y: { type: "number" },
    });
  });

  test("deriveProviderPresets exposes keyOptional for GUI picker", () => {
    const { deriveProviderPresets } = require("../src/providers/derive");
    const presets = deriveProviderPresets();
    const preset = presets.find((p: { id: string }) => p.id === "opencode-free");
    expect(preset).toBeDefined();
    expect(preset.keyOptional).toBe(true);
    expect(preset.note).toBeDefined();
  });
});

function adapterRequest(modelId: string) {
  return {
    modelId,
    stream: false,
    context: {
      messages: [
        { role: "user" as const, content: "inspect the repo", timestamp: 0 },
        {
          role: "assistant" as const,
          timestamp: 1,
          content: [
            { type: "thinking" as const, thinking: "previous reasoning" },
            { type: "toolCall" as const, id: "call_1", name: "read_file", arguments: { path: "README.md" } },
          ],
        },
        {
          role: "toolResult" as const,
          toolCallId: "call_1",
          toolName: "read_file",
          content: "contents",
          isError: false,
          timestamp: 2,
        },
      ],
    },
    options: { reasoning: "high" as const },
  };
}
