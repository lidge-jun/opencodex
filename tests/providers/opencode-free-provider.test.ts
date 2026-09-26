import { describe, expect, test } from "bun:test";
import { PROVIDER_REGISTRY, providerModelWireDefault } from "../../src/providers/registry";
import { providerConfigSeed, deriveKeyLoginMap, deriveFeaturedProviderIds } from "../../src/providers/derive";
import { createOpenAIChatAdapter } from "../../src/adapters/openai-chat";
import { createRegisteredAdapter } from "../../src/adapters/registry";
import { buildOpenAIChatPassthroughRequest } from "../../src/adapters/openai-chat/passthrough";
import { transformProviderRequest } from "../../src/adapters/provider-compatibility";
import {
  ZEN_FREE_SESSION_RE,
  ZEN_FREE_USER_AGENT,
  mintZenFreeSessionId,
} from "../../src/adapters/opencode-free-session";
import {
  ZEN_FREE_GATE_DECLARATION,
  missingZenFreeGateTools,
} from "../../src/adapters/opencode-free-tools";
import { MODEL_ADAPTER_OVERRIDE_ALLOWED } from "../../src/types/wire";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import type { IncomingMeta, ProviderAdapter } from "../../src/adapters/base";
import { routedProviderConfig } from "../../src/router";
import { buildModelsRequest } from "../../src/oauth";
import type { OcxParsedRequest, OcxProviderConfig } from "../../src/types";

function minimalRequest(model = "kimi-k2.7-code"): OcxParsedRequest {
  return {
    modelId: model,
    stream: false,
    context: { messages: [{ role: "user", content: "hi" }], tools: [] },
    options: {},
  };
}

function threadedRequest(threadId: string, model = "muse-spark-1.3-contributor-free"): OcxParsedRequest {
  return { ...minimalRequest(model), _codexOwnThreadId: threadId };
}

function responsesInboundRequest(threadId: string): OcxParsedRequest {
  // The Responses passthrough forwards the caller's raw body, so a request
  // without one never reaches the header path under test.
  return {
    ...threadedRequest(threadId),
    _rawBody: {
      model: "muse-spark-1.3-contributor-free",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      stream: false,
    },
  };
}

function metaWithSession(session?: string): IncomingMeta {
  const headers = new Headers();
  if (session !== undefined) headers.set("x-opencode-session", session);
  return { headers, translatorBudget: createTranslatorBudget() };
}

function registered(provider: OcxProviderConfig, adapter = provider.adapter): ProviderAdapter {
  return createRegisteredAdapter({ ...provider, adapter }, { providerId: "opencode-free" });
}

function nativeRequest(
  provider: OcxProviderConfig,
  body: Record<string, unknown>,
  model = "big-pickle",
  requestSessionLane = "native-test-lane",
) {
  const request = buildOpenAIChatPassthroughRequest(provider, body, model, body.stream === true);
  return transformProviderRequest(provider, request, {
    incomingHeaders: new Headers(),
    requestSessionLane,
  });
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

  test("keyless requests mint the anonymous tier identity", async () => {
    const provider: OcxProviderConfig = providerConfigSeed(entry!);
    const adapter = registered(provider);
    const req = await adapter.buildRequest(threadedRequest("thread-alpha"), metaWithSession());
    const headers = req.headers as Record<string, string>;
    // The gateway maps Bearer public to its anonymous pool (see
    // src/adapters/opencode-free-session.ts for provenance).
    expect(headers["Authorization"]).toBe("Bearer public");
    // The bare registry default is repaired: the gate only admits versioned UAs.
    expect(headers["User-Agent"]).toBe(ZEN_FREE_USER_AGENT);
    expect(headers["x-opencode-client"]).toBe("desktop");
    expect(ZEN_FREE_SESSION_RE.test(headers["x-opencode-session"] ?? "")).toBe(true);
    expect(req.url).toBe("https://opencode.ai/zen/v1/chat/completions");
  });

  test("an operator User-Agent is preserved verbatim, only the bare default is repaired", async () => {
    const seed = providerConfigSeed(entry!);
    const custom = (await registered({
      ...seed,
      headers: { ...seed.headers, "User-Agent": "custom-agent/9.9" },
    }).buildRequest(threadedRequest("t"), metaWithSession())).headers as Record<string, string>;
    expect(custom["User-Agent"]).toBe("custom-agent/9.9");
    expect(ZEN_FREE_SESSION_RE.test(custom["x-opencode-session"] ?? "")).toBe(true);
  });

  test("the minted session is stable per Codex thread and distinct across threads", async () => {
    const provider: OcxProviderConfig = providerConfigSeed(entry!);
    const adapter = registered(provider);
    const first = ((await adapter.buildRequest(threadedRequest("thread-alpha"), metaWithSession())).headers as Record<string, string>)["x-opencode-session"];
    const second = ((await adapter.buildRequest(threadedRequest("thread-alpha"), metaWithSession())).headers as Record<string, string>)["x-opencode-session"];
    const other = ((await adapter.buildRequest(threadedRequest("thread-beta"), metaWithSession())).headers as Record<string, string>)["x-opencode-session"];
    expect(first).toBe(second);
    expect(other).not.toBe(first);
    expect(ZEN_FREE_SESSION_RE.test(other ?? "")).toBe(true);
  });

  test("a valid caller session passes through, a malformed one is replaced", async () => {
    const provider: OcxProviderConfig = providerConfigSeed(entry!);
    const adapter = registered(provider);
    const valid = mintZenFreeSessionId("caller-seed");
    const kept = ((await adapter.buildRequest(threadedRequest("t"), metaWithSession(valid))).headers as Record<string, string>)["x-opencode-session"];
    expect(kept).toBe(valid);
    const replaced = ((await adapter.buildRequest(threadedRequest("t"), metaWithSession("not-a-session"))).headers as Record<string, string>)["x-opencode-session"];
    expect(replaced).not.toBe("not-a-session");
    expect(ZEN_FREE_SESSION_RE.test(replaced ?? "")).toBe(true);
  });

  test("an operator-configured Authorization header is never overwritten", async () => {
    const provider: OcxProviderConfig = {
      ...providerConfigSeed(entry!),
      headers: { ...providerConfigSeed(entry!).headers, Authorization: "Bearer operator-key" },
    };
    const headers = (await registered(provider).buildRequest(threadedRequest("t"), metaWithSession())).headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer operator-key");
    expect(ZEN_FREE_SESSION_RE.test(headers["x-opencode-session"] ?? "")).toBe(true);
  });

  test("the Responses wire mints the same identity for Muse Spark turns", async () => {
    const provider: OcxProviderConfig = providerConfigSeed(entry!);
    const headers = (await registered(provider, "openai-responses").buildRequest(
      responsesInboundRequest("thread-alpha"),
      metaWithSession(),
    )).headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer public");
    expect(headers["User-Agent"]).toBe(ZEN_FREE_USER_AGENT);
    expect(headers["x-opencode-client"]).toBe("desktop");
    const chatHeaders = (await registered(provider).buildRequest(threadedRequest("thread-alpha"), metaWithSession())).headers as Record<string, string>;
    expect(headers["x-opencode-session"]).toBe(chatHeaders["x-opencode-session"]);
  });

  test("the native Chat fast path mints the same identity", () => {
    const provider: OcxProviderConfig = providerConfigSeed(entry!);
    const rawBody = { messages: [{ role: "user", content: "hi" }], stream: true };
    const headers = nativeRequest(provider, rawBody).headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer public");
    expect(headers["User-Agent"]).toBe(ZEN_FREE_USER_AGENT);
    expect(ZEN_FREE_SESSION_RE.test(headers["x-opencode-session"] ?? "")).toBe(true);
  });

  test("native Chat sessions are stable per request lane and isolated across lanes", () => {
    const provider: OcxProviderConfig = providerConfigSeed(entry!);
    const rawBody = { messages: [{ role: "user", content: "hi" }], stream: true };
    const first = nativeRequest(provider, rawBody, "big-pickle", "lane-a").headers["x-opencode-session"];
    const retry = nativeRequest(provider, rawBody, "big-pickle", "lane-a").headers["x-opencode-session"];
    const other = nativeRequest(provider, rawBody, "big-pickle", "lane-b").headers["x-opencode-session"];
    expect(retry).toBe(first);
    expect(other).not.toBe(first);
  });

  test("the native Chat fast path leaves other endpoints byte-identical", () => {
    const provider: OcxProviderConfig = {
      adapter: "openai-chat",
      baseUrl: "https://api.example.test/v1",
      authMode: "key",
      keyOptional: true,
    };
    const rawBody = { messages: [{ role: "user", content: "hi" }], stream: true };
    const headers = nativeRequest(provider, rawBody, "some-model").headers as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
    expect(headers["x-opencode-session"]).toBeUndefined();
  });

  test("a relayed caller User-Agent is replaced when the operator configured none", () => {
    // A saved row with no header block: the Responses passthrough relays the
    // caller's fingerprint (e.g. codex-cli), which the gate refuses.
    const provider: OcxProviderConfig = {
      adapter: "openai-chat",
      baseUrl: "https://opencode.ai/zen/v1",
      authMode: "key",
      keyOptional: true,
    };
    const incoming = new Headers({ "user-agent": "codex-cli/0.153.4" });
    const headers = registered(provider, "openai-responses").buildRequest(
      responsesInboundRequest("t"),
      { headers: incoming, translatorBudget: createTranslatorBudget() },
    ).headers as Record<string, string>;
    expect(headers["User-Agent"]).toBe(ZEN_FREE_USER_AGENT);
    expect(headers["Authorization"]).toBe("Bearer public");
    expect(ZEN_FREE_SESSION_RE.test(headers["x-opencode-session"] ?? "")).toBe(true);
  });

  test("non-Zen providers never enter Zen code paths", async () => {
    // The registry composes the wrapper conditionally: any other endpoint
    // gets the bare adapter, so neither declarations nor identity appear.
    const provider: OcxProviderConfig = {
      adapter: "openai-chat",
      baseUrl: "https://api.example.test/v1",
      authMode: "key",
      keyOptional: true,
    };
    const built = await createRegisteredAdapter(provider).buildRequest(minimalRequest("some-model"), metaWithSession());
    const headers = built.headers as Record<string, string>;
    const body = JSON.parse(built.body as string) as { tools?: unknown };
    expect(headers["x-opencode-session"]).toBeUndefined();
    expect(headers["Authorization"]).toBeUndefined();
    expect(body.tools).toBeUndefined();
  });

  test("Muse Spark contributor-free ids default to the Responses wire on every inbound", () => {    const base = { baseUrl: "https://opencode.ai/zen/v1", adapter: "openai-chat" };
    for (const model of ["muse-spark-1.2-contributor-free", "muse-spark-1.3-contributor-free"]) {
      for (const inbound of ["responses", "chat", "anthropic"] as const) {
        expect(providerModelWireDefault("opencode-free", base, model, MODEL_ADAPTER_OVERRIDE_ALLOWED, inbound))
          .toBe("openai-responses");
      }
      // Case-insensitive like the rest of model-id matching.
      expect(providerModelWireDefault("opencode-free", base, "Muse-Spark-1.3-Contributor-Free", MODEL_ADAPTER_OVERRIDE_ALLOWED, "responses"))
        .toBe("openai-responses");
    }
    // Chat-wire free models stay on Chat.
    expect(providerModelWireDefault("opencode-free", base, "big-pickle", MODEL_ADAPTER_OVERRIDE_ALLOWED, "responses"))
      .toBeUndefined();
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

    test("the merged headers reach the wire with the repaired UA, not just the resolved config", async () => {
      const routed = routedProviderConfig("opencode-free", persisted({ "x-opencode-client": "desktop" }));
      const req = await registered(routed).buildRequest(minimalRequest(), metaWithSession());
      expect((req.headers as Record<string, string>)["User-Agent"]).toBe(ZEN_FREE_USER_AGENT);
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
    const { deriveProviderPresets } = require("../../src/providers/derive");
    const presets = deriveProviderPresets();
    const preset = presets.find((p: { id: string }) => p.id === "opencode-free");
    expect(preset).toBeDefined();
    expect(preset.keyOptional).toBe(true);
    expect(preset.note).toBeDefined();
  });

  describe("keyless gate declarations (shell/read pair)", () => {
    test("missing-pair detection mirrors the gateway: exact lowercase only", () => {
      expect(missingZenFreeGateTools(undefined)).toEqual(["shell", "read"]);
      expect(missingZenFreeGateTools([])).toEqual(["shell", "read"]);
      expect(missingZenFreeGateTools(["shell"])).toEqual(["read"]);
      expect(missingZenFreeGateTools(["bash", "read"])).toEqual([]);
      expect(missingZenFreeGateTools(["shell", "read", "exec"])).toEqual([]);
      // Capitalized Claude-style names do not satisfy the gate.
      expect(missingZenFreeGateTools(["Bash", "Read"])).toEqual(["shell", "read"]);
      expect(missingZenFreeGateTools(["exec", "wait"])).toEqual(["shell", "read"]);
    });

    async function chatToolNames(provider: OcxProviderConfig, request: OcxParsedRequest): Promise<(string | undefined)[]> {
      const adapter = registered(provider);
      const built = await adapter.buildRequest(request, metaWithSession());
      const body = JSON.parse(built.body as string) as {
        tools?: Array<{ function?: { name?: unknown } }>;
      };
      return (body.tools ?? []).map(tool => typeof tool?.function?.name === "string" ? tool.function.name : undefined);
    }

    test("translated Chat appends the missing pair and never duplicates", async () => {
      const provider: OcxProviderConfig = providerConfigSeed(entry!);
      expect(await chatToolNames(provider, minimalRequest("big-pickle"))).toEqual(["shell", "read"]);
      const execOnly: OcxParsedRequest = {
        ...minimalRequest("big-pickle"),
        context: {
          messages: [{ role: "user", content: "hi" }],
          tools: [{ name: "exec", description: "run", parameters: { type: "object", properties: {} } }],
        },
      };
      expect(await chatToolNames(provider, execOnly)).toEqual(["exec", "shell", "read"]);
      const already: OcxParsedRequest = {
        ...minimalRequest("big-pickle"),
        context: {
          messages: [{ role: "user", content: "hi" }],
          tools: [
            { name: "shell", description: "s", parameters: { type: "object", properties: {} } },
            { name: "read", description: "r", parameters: { type: "object", properties: {} } },
          ],
        },
      };
      expect(await chatToolNames(provider, already)).toEqual(["shell", "read"]);
    });

    test("appended declarations carry the never-invoke wording", async () => {
      const provider: OcxProviderConfig = providerConfigSeed(entry!);
      const adapter = registered(provider);
      const built = await adapter.buildRequest(minimalRequest("big-pickle"), metaWithSession());
      const body = JSON.parse(built.body as string) as {
        tools?: Array<{ function?: { description?: unknown } }>;
      };
      for (const tool of body.tools ?? []) {
        expect(tool?.function?.description).toBe(ZEN_FREE_GATE_DECLARATION);
      }
    });

    test("keyed sends do not gain gate declarations", async () => {
      const provider: OcxProviderConfig = { ...providerConfigSeed(entry!), apiKey: "user-secret-key" };
      const adapter = registered(provider);
      const built = await adapter.buildRequest(minimalRequest("big-pickle"), metaWithSession());
      const body = JSON.parse(built.body as string) as {
        tools?: unknown[];
      };
      expect(body.tools).toBeUndefined();
    });

    test("Responses wire creates the pair when the turn declares no tools", () => {
      const provider: OcxProviderConfig = providerConfigSeed(entry!);
      const body = JSON.parse(registered(provider, "openai-responses").buildRequest(
        responsesInboundRequest("thread-gamma"),
        metaWithSession(),
      ).body as string) as { tools?: Array<{ name?: unknown }> };
      expect((body.tools ?? []).map(tool => tool?.name)).toEqual(["shell", "read"]);
    });

    test("native Chat fast path creates the pair when the turn declares no tools", () => {
      const provider: OcxProviderConfig = providerConfigSeed(entry!);
      const body = JSON.parse(nativeRequest(
        provider,
        { messages: [{ role: "user", content: "hi" }], stream: true },
      ).body as string) as { tools?: Array<{ function?: { name?: unknown } }> };
      expect((body.tools ?? []).map(tool => tool?.function?.name)).toEqual(["shell", "read"]);
    });

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
