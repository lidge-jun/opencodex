/**
 * #3761: the Codex App always declares the hosted web_search tool, and the KEY-auth Responses
 * passthrough relayed that declaration as though the destination executed it. Ollama Cloud GLM
 * does not, so it answered with a plain function_call named web_search that nothing ran, and the
 * undeclared-tool guard ended the turn.
 *
 * These pin the opt-in bridge: OFF reproduces the reported abort, ON removes the call from the
 * client stream and continues the conversation upstream, and an unrelated undeclared tool still
 * fails closed through the bridged stream.
 */
import { describe, expect, test } from "bun:test";
import {
  appendBridgeSearchTurn,
  createPassthroughWebSearchBridgeStream,
  planPassthroughWebSearchBridge,
  resolveOllamaWebSearchEndpoint,
  resolvePassthroughWebSearchBridgeAuth,
  resetRefusedBridgeEndpointWarningsForTests,
  shouldResolveOpenAiPassthroughWebSearchBridge,
  sidecarSettingsForBridge,
  WEB_SEARCH_BRIDGE_ERROR_CODE,
  WEB_SEARCH_BRIDGE_MIXED_TOOLS_ERROR_CODE,
  type PassthroughWebSearchBridgePlan,
} from "../../src/web-search/passthrough-bridge";
import { providerWebSearchBridgeConfigError, validateConfigCandidate } from "../../src/config";
import { mapOllamaSearchResponse } from "../../src/web-search/ollama-executor";
import { UNDECLARED_TOOL_CALL_ERROR_CODE } from "../../src/server/responses-undeclared-tool-guard";
import { handleResponses } from "../../src/server/responses";
import {
  resetProviderRequestPacingForTest,
  setProviderRequestPacingRuntimeForTest,
  waitForProviderRequestSlot,
} from "../../src/providers/request-pacing";
import type { OcxConfig, OcxParsedRequest, OcxProviderConfig, ProviderWebSearchBridgeBackend, ProviderWebSearchBridgeConfig } from "../../src/types";

/** One SSE event block without its blank-line delimiter. */
function frame(type: string, payload: Record<string, unknown>): string {
  return "event: " + type + "\ndata: " + JSON.stringify({ type, ...payload });
}

function sseBody(...blocks: string[]): string {
  return blocks.concat("data: [DONE]").join("\n\n") + "\n\n";
}

function streamFromText(text: string): ReadableStream<Uint8Array> {
  const chunk = new TextEncoder().encode(text);
  let sent = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) {
        controller.close();
        return;
      }
      sent = true;
      controller.enqueue(chunk);
    },
  });
}

/** Every parsed data payload the client received, in order. */
function clientEvents(body: string): Record<string, unknown>[] {
  return body
    .split(/\r?\n/)
    .filter(line => line.startsWith("data:"))
    .map(line => line.slice(5).trim())
    .filter(payload => payload.length > 0 && payload !== "[DONE]")
    .map(payload => JSON.parse(payload) as Record<string, unknown>);
}

function providerFixture(
  bridge?: ProviderWebSearchBridgeConfig,
  overrides: Partial<OcxProviderConfig> = {},
): OcxProviderConfig {
  return {
    adapter: "openai-responses",
    baseUrl: "https://ollama.com/v1",
    authMode: "key",
    apiKey: "fixture-key",
    ...(bridge ? { webSearchBridge: bridge } : {}),
    ...overrides,
  } as OcxProviderConfig;
}

function parsedFixture(overrides: Record<string, unknown> = {}): OcxParsedRequest {
  return {
    modelId: "glm-4.7",
    options: {},
    stream: true,
    _webSearch: { type: "web_search" },
    ...overrides,
  } as unknown as OcxParsedRequest;
}

const armed: ProviderWebSearchBridgeConfig = { enabled: true, backend: "ollama" };

describe("planPassthroughWebSearchBridge arming", () => {
  test("arms for an enabled ollama-backed key provider on the canonical origin", () => {
    const plan = planPassthroughWebSearchBridge(parsedFixture(), providerFixture(armed), {
      providerName: "gateway",
      isPassthrough: true,
      stream: true,
    });
    expect(plan).toEqual({
      backend: "ollama",
      endpoint: "https://ollama.com/api/web_search",
      maxSearches: 3,
      timeoutMs: 60_000,
    });
  });

  test("stays disarmed without the opt-in", () => {
    const off: (ProviderWebSearchBridgeConfig | undefined)[] = [
      undefined,
      { backend: "ollama" },
      { enabled: false, backend: "ollama" },
    ];
    for (const bridge of off) {
      expect(planPassthroughWebSearchBridge(parsedFixture(), providerFixture(bridge), {
        providerName: "gateway",
        isPassthrough: true,
        stream: true,
      })).toBeUndefined();
    }
  });

  test("never arms for forwarded ChatGPT auth or a stored OAuth credential", () => {
    for (const authMode of ["forward", "oauth"] as const) {
      expect(planPassthroughWebSearchBridge(
        parsedFixture(),
        providerFixture(armed, { authMode }),
        { providerName: "gateway", isPassthrough: true, stream: true },
      )).toBeUndefined();
    }
  });

  test("stays disarmed off the passthrough, without hosted web_search, and for non-streaming turns", () => {
    const provider = providerFixture(armed);
    expect(planPassthroughWebSearchBridge(parsedFixture(), provider, {
      providerName: "gateway",
      isPassthrough: false,
      stream: true,
    })).toBeUndefined();
    expect(planPassthroughWebSearchBridge(parsedFixture({ _webSearch: undefined }), provider, {
      providerName: "gateway",
      isPassthrough: true,
      stream: true,
    })).toBeUndefined();
    expect(planPassthroughWebSearchBridge(parsedFixture(), provider, {
      providerName: "gateway",
      isPassthrough: true,
      stream: false,
    })).toBeUndefined();
  });

  test("a tool_choice that excludes search excludes the bridge", () => {
    expect(planPassthroughWebSearchBridge(
      parsedFixture({ options: { toolChoice: { type: "function", name: "exec" } } }),
      providerFixture(armed),
      { providerName: "gateway", isPassthrough: true, stream: true },
    )).toBeUndefined();
  });

  test("backends without resolved credentials stay inert rather than falling back", () => {
    for (const backend of ["openai", "anthropic", "xai", "gemini", "exa"] as const) {
      expect(planPassthroughWebSearchBridge(
        parsedFixture(),
        providerFixture({ enabled: true, backend }),
        { providerName: "gateway", isPassthrough: true, stream: true },
      )).toBeUndefined();
    }
  });

  test("the ollama backend refuses a non-canonical origin unless the operator names the endpoint", () => {
    const renamed = providerFixture(armed, { baseUrl: "https://gateway.example/v1" });
    expect(resolveOllamaWebSearchEndpoint("gateway", renamed)).toBeUndefined();
    expect(planPassthroughWebSearchBridge(parsedFixture(), renamed, {
      providerName: "gateway",
      isPassthrough: true,
      stream: true,
    })).toBeUndefined();

    const operatorSet = providerFixture(
      { enabled: true, backend: "ollama", endpoint: "https://search.internal/api/web_search" },
      { baseUrl: "https://gateway.example/v1" },
    );
    const plan = planPassthroughWebSearchBridge(parsedFixture(), operatorSet, {
      providerName: "gateway",
      isPassthrough: true,
      stream: true,
    });
    expect(plan?.endpoint).toBe("https://search.internal/api/web_search");
  });

  test("out-of-range bounds fall back to the documented defaults", () => {
    const plan = planPassthroughWebSearchBridge(
      parsedFixture(),
      providerFixture({ enabled: true, backend: "ollama", maxSearches: 99, timeoutMs: 1 }),
      { providerName: "gateway", isPassthrough: true, stream: true },
    );
    expect(plan?.maxSearches).toBe(3);
    expect(plan?.timeoutMs).toBe(60_000);
  });

  test("an openai backend arms only when the ChatGPT sidecar is present", () => {
    const provider = providerFixture({ enabled: true, backend: "openai" }, { baseUrl: "https://gateway.example/v1" });
    expect(planPassthroughWebSearchBridge(parsedFixture(), provider, {
      providerName: "gateway",
      isPassthrough: true,
      stream: true,
    })).toBeUndefined();
    const openAiSidecar = {
      providerName: "openai" as const,
      provider: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" },
      accountMode: "direct" as const,
      authContext: { kind: "main" as const, accountId: null },
      headers: new Headers({ authorization: "Bearer chatgpt" }),
    };
    const planned = planPassthroughWebSearchBridge(parsedFixture(), provider, {
      providerName: "gateway",
      isPassthrough: true,
      stream: true,
      auth: { openAiSidecar },
    });
    expect(planned).toEqual({ backend: "openai", maxSearches: 3, timeoutMs: 60_000 });
    expect(shouldResolveOpenAiPassthroughWebSearchBridge(provider, parsedFixture(), true)).toBe(true);
    expect(shouldResolveOpenAiPassthroughWebSearchBridge(providerFixture(armed), parsedFixture(), true)).toBe(false);
  });

  test("sidecar backends arm only with their own credential handle", () => {
    const gateway = { baseUrl: "https://gateway.example/v1" };
    const anthropic = { providerName: "claude", provider: { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "oauth" } };
    const xai = { providerName: "xai", provider: { adapter: "openai-responses", baseUrl: "https://api.x.ai/v1", authMode: "oauth" } };
    const gemini = { providerName: "google-antigravity", provider: { adapter: "google-antigravity", baseUrl: "https://cloudcode-pa.googleapis.com", authMode: "oauth" } };
    expect(planPassthroughWebSearchBridge(
      parsedFixture(),
      providerFixture({ enabled: true, backend: "anthropic" }, gateway),
      { providerName: "gateway", isPassthrough: true, stream: true, auth: { anthropic } },
    )?.backend).toBe("anthropic");
    expect(planPassthroughWebSearchBridge(
      parsedFixture(),
      providerFixture({ enabled: true, backend: "xai" }, gateway),
      { providerName: "gateway", isPassthrough: true, stream: true, auth: { xai } },
    )?.backend).toBe("xai");
    expect(planPassthroughWebSearchBridge(
      parsedFixture(),
      providerFixture({ enabled: true, backend: "gemini" }, gateway),
      { providerName: "gateway", isPassthrough: true, stream: true, auth: { gemini } },
    )?.backend).toBe("gemini");
    expect(planPassthroughWebSearchBridge(
      parsedFixture(),
      providerFixture({ enabled: true, backend: "exa" }, gateway),
      { providerName: "gateway", isPassthrough: true, stream: true, auth: { exaApiKey: "exa-canary" } },
    )?.backend).toBe("exa");
    // A named backend does not borrow a different credential.
    expect(planPassthroughWebSearchBridge(
      parsedFixture(),
      providerFixture({ enabled: true, backend: "exa" }, gateway),
      { providerName: "gateway", isPassthrough: true, stream: true, auth: { anthropic, xai, gemini } },
    )).toBeUndefined();
    expect(planPassthroughWebSearchBridge(
      parsedFixture(),
      providerFixture({ enabled: true, backend: "openai" }, gateway),
      { providerName: "gateway", isPassthrough: true, stream: true, auth: { exaApiKey: "exa-canary" } },
    )).toBeUndefined();
  });

  test("resolvePassthroughWebSearchBridgeAuth inspects only the named backend", () => {
    const cfg = {
      port: 0,
      defaultProvider: "fixture",
      providers: {},
      webSearchSidecar: { exaApiKey: "exa-canary" },
    } as unknown as OcxConfig;
    expect(resolvePassthroughWebSearchBridgeAuth("exa", cfg)).toEqual({ exaApiKey: "exa-canary" });
    expect(resolvePassthroughWebSearchBridgeAuth("openai", cfg)).toEqual({});
    expect(resolvePassthroughWebSearchBridgeAuth("anthropic", cfg)).toEqual({});
    expect(resolvePassthroughWebSearchBridgeAuth("xai", cfg)).toEqual({});
    expect(resolvePassthroughWebSearchBridgeAuth("gemini", cfg)).toEqual({});
    expect(resolvePassthroughWebSearchBridgeAuth("ollama", cfg)).toEqual({});
  });
});

// webSearchBridge.endpoint names the destination that receives this provider's API key, so it
// gets the same literal destination assessment baseUrl already gets: metadata is refused
// outright, and loopback or private space needs the provider's allowPrivateNetwork opt-in or a
// registry entry that is local by default. Every provider here sits on a non-canonical baseUrl
// so the configured endpoint, not the Ollama Cloud fallback, decides the outcome.
describe("webSearchBridge.endpoint destination policy", () => {
  const gateway = { baseUrl: "https://gateway.example/v1" };

  test("a configured metadata endpoint disarms the bridge", () => {
    const provider = providerFixture(
      { enabled: true, backend: "ollama", endpoint: "http://169.254.169.254/latest/meta-data" },
      gateway,
    );
    expect(resolveOllamaWebSearchEndpoint("gateway", provider)).toBeUndefined();
    expect(planPassthroughWebSearchBridge(parsedFixture(), provider, {
      providerName: "gateway",
      isPassthrough: true,
      stream: true,
    })).toBeUndefined();
  });

  test("allowPrivateNetwork does not waive a metadata endpoint", () => {
    const provider = providerFixture(
      { enabled: true, backend: "ollama", endpoint: "http://169.254.169.254/latest/meta-data" },
      { ...gateway, allowPrivateNetwork: true },
    );
    expect(resolveOllamaWebSearchEndpoint("gateway", provider)).toBeUndefined();
    expect(planPassthroughWebSearchBridge(parsedFixture(), provider, {
      providerName: "gateway",
      isPassthrough: true,
      stream: true,
    })).toBeUndefined();
  });

  test("the Aliyun metadata address stays refused under the opt-in", () => {
    const provider = providerFixture(
      { enabled: true, backend: "ollama", endpoint: "http://100.100.100.200/api/web_search" },
      { ...gateway, allowPrivateNetwork: true },
    );
    expect(resolveOllamaWebSearchEndpoint("gateway", provider)).toBeUndefined();
    expect(planPassthroughWebSearchBridge(parsedFixture(), provider, {
      providerName: "gateway",
      isPassthrough: true,
      stream: true,
    })).toBeUndefined();
  });

  test("a private-network endpoint stays disarmed without the opt-in", () => {
    const provider = providerFixture(
      { enabled: true, backend: "ollama", endpoint: "http://10.0.0.5/api/web_search" },
      gateway,
    );
    expect(planPassthroughWebSearchBridge(parsedFixture(), provider, {
      providerName: "gateway",
      isPassthrough: true,
      stream: true,
    })).toBeUndefined();
  });

  test("allowPrivateNetwork arms a private-network endpoint", () => {
    const provider = providerFixture(
      { enabled: true, backend: "ollama", endpoint: "http://10.0.0.5/api/web_search" },
      { ...gateway, allowPrivateNetwork: true },
    );
    expect(resolveOllamaWebSearchEndpoint("gateway", provider)).toBe("http://10.0.0.5/api/web_search");
    expect(planPassthroughWebSearchBridge(parsedFixture(), provider, {
      providerName: "gateway",
      isPassthrough: true,
      stream: true,
    })?.endpoint).toBe("http://10.0.0.5/api/web_search");
  });

  test("a self-hosted ollama keeps its loopback endpoint because the registry entry is local by default", () => {
    const provider = providerFixture(
      { enabled: true, backend: "ollama", endpoint: "http://127.0.0.1:11434/api/web_search" },
      gateway,
    );
    expect(resolveOllamaWebSearchEndpoint("ollama", provider)).toBe("http://127.0.0.1:11434/api/web_search");
    expect(planPassthroughWebSearchBridge(parsedFixture(), provider, {
      providerName: "ollama",
      isPassthrough: true,
      stream: true,
    })?.endpoint).toBe("http://127.0.0.1:11434/api/web_search");
  });

  test("the same loopback endpoint is refused under a name with no registry default", () => {
    const provider = providerFixture(
      { enabled: true, backend: "ollama", endpoint: "http://127.0.0.1:11434/api/web_search" },
      gateway,
    );
    expect(planPassthroughWebSearchBridge(parsedFixture(), provider, {
      providerName: "gateway",
      isPassthrough: true,
      stream: true,
    })).toBeUndefined();
  });

  test("a local-by-default registry name also covers private space, not just loopback", () => {
    // allowPrivateNetworkByDefault is not loopback-only; it is the same waiver baseUrl gets, so a
    // LAN Ollama arms too. Pinned because the rule is broader than the 127.0.0.1 case suggests.
    const provider = providerFixture(
      { enabled: true, backend: "ollama", endpoint: "http://10.0.0.5:11434/api/web_search" },
      gateway,
    );
    expect(resolveOllamaWebSearchEndpoint("ollama", provider)).toBe("http://10.0.0.5:11434/api/web_search");
    expect(planPassthroughWebSearchBridge(parsedFixture(), provider, {
      providerName: "ollama",
      isPassthrough: true,
      stream: true,
    })?.endpoint).toBe("http://10.0.0.5:11434/api/web_search");
  });

  test("a public endpoint still arms", () => {
    const provider = providerFixture(
      { enabled: true, backend: "ollama", endpoint: "https://ollama.com/api/web_search" },
      gateway,
    );
    expect(planPassthroughWebSearchBridge(parsedFixture(), provider, {
      providerName: "gateway",
      isPassthrough: true,
      stream: true,
    })?.endpoint).toBe("https://ollama.com/api/web_search");
  });

  test("a hostname that merely resembles a metadata address still arms", () => {
    // The synchronous classifier is literal-only and resolves no DNS, exactly as at the baseUrl
    // boundary, so a lookalike hostname is just a hostname here.
    const provider = providerFixture(
      { enabled: true, backend: "ollama", endpoint: "https://imds.example.test/latest/meta-data" },
      gateway,
    );
    expect(planPassthroughWebSearchBridge(parsedFixture(), provider, {
      providerName: "gateway",
      isPassthrough: true,
      stream: true,
    })?.endpoint).toBe("https://imds.example.test/latest/meta-data");
  });
});

// The refusal disarms the bridge without an error, which is what keeps the key unspent. That
// silence broke a real configuration: a provider keyed under a CUSTOM name pointing at loopback
// used to arm, and only the registry ids are local by default. The operator has to be told once.
describe("a refused endpoint tells the operator once", () => {
  const gateway = { baseUrl: "https://gateway.example/v1" };

  function captureWarnings(run: () => void): string[] {
    const lines: string[] = [];
    const saved = console.warn;
    console.warn = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
    try {
      run();
    } finally {
      console.warn = saved;
    }
    return lines;
  }

  test("a custom-named local provider is warned, with the remedy and without the endpoint", () => {
    resetRefusedBridgeEndpointWarningsForTests();
    const provider = providerFixture(
      { enabled: true, backend: "ollama", endpoint: "http://127.0.0.1:11434/api/web_search" },
      gateway,
    );
    const warnings = captureWarnings(() => {
      expect(resolveOllamaWebSearchEndpoint("my-ollama", provider)).toBeUndefined();
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("my-ollama");
    expect(warnings[0]).toContain("allowPrivateNetwork");
    // The destination itself never reaches the log.
    expect(warnings[0]).not.toContain("127.0.0.1");
    expect(warnings[0]).not.toContain("/api/web_search");
  });

  test("the same refusal does not warn again on every later request", () => {
    resetRefusedBridgeEndpointWarningsForTests();
    const provider = providerFixture(
      { enabled: true, backend: "ollama", endpoint: "http://10.0.0.5/api/web_search" },
      gateway,
    );
    const warnings = captureWarnings(() => {
      for (let i = 0; i < 5; i += 1) {
        expect(planPassthroughWebSearchBridge(parsedFixture(), provider, {
          providerName: "local-llm",
          isPassthrough: true,
          stream: true,
        })).toBeUndefined();
      }
    });
    expect(warnings).toHaveLength(1);
  });

  test("an accepted endpoint is not warned about", () => {
    resetRefusedBridgeEndpointWarningsForTests();
    const provider = providerFixture(
      { enabled: true, backend: "ollama", endpoint: "http://127.0.0.1:11434/api/web_search" },
      gateway,
    );
    const warnings = captureWarnings(() => {
      expect(resolveOllamaWebSearchEndpoint("ollama", provider)).toBe("http://127.0.0.1:11434/api/web_search");
    });
    expect(warnings).toEqual([]);
  });
});

// The blocker this policy exists for: config load does NOT run providerWebSearchBridgeConfigError,
// so a metadata endpoint reaches running config intact. Plan time is what refuses to spend it.
describe("a metadata endpoint survives config load and is refused at plan time", () => {
  test("configSchema accepts the block and the planner still disarms", () => {
    const result = validateConfigCandidate({
      port: 0,
      defaultProvider: "gateway",
      providers: {
        gateway: {
          adapter: "openai-responses",
          baseUrl: "https://gateway.example/v1",
          authMode: "key",
          apiKey: "fixture-key",
          webSearchBridge: {
            enabled: true,
            backend: "ollama",
            endpoint: "http://169.254.169.254/latest/meta-data",
          },
        },
      },
    });
    expect(result.ok).toBe(true);
    const loaded = (result as { ok: true; config: OcxConfig }).config.providers.gateway!;
    // It really did survive validation, untouched.
    expect(loaded.webSearchBridge?.endpoint).toBe("http://169.254.169.254/latest/meta-data");
    expect(planPassthroughWebSearchBridge(parsedFixture(), loaded, {
      providerName: "gateway",
      isPassthrough: true,
      stream: true,
    })).toBeUndefined();
  });
});

describe("providerWebSearchBridgeConfigError endpoint destination policy", () => {
  test("names webSearchBridge.endpoint rather than baseUrl in a metadata refusal", () => {
    const value = { enabled: true, backend: "ollama", endpoint: "http://169.254.169.254/latest/meta-data" };
    const error = providerWebSearchBridgeConfigError(value, "gateway", {});
    expect(error).toContain("webSearchBridge.endpoint");
    expect(error).toContain("metadata");
    expect(error).not.toStartWith("baseUrl");
    expect(providerWebSearchBridgeConfigError(value, "gateway", { allowPrivateNetwork: true })).not.toBeNull();
  });

  test("a private-network endpoint errors without the opt-in and passes with it", () => {
    const value = { enabled: true, backend: "ollama", endpoint: "http://10.0.0.5/api/web_search" };
    expect(providerWebSearchBridgeConfigError(value, "gateway", {})).toContain("allowPrivateNetwork");
    expect(providerWebSearchBridgeConfigError(value, "gateway", { allowPrivateNetwork: true })).toBeNull();
  });

  test("a public endpoint and an absent endpoint both pass", () => {
    expect(providerWebSearchBridgeConfigError(
      { enabled: true, backend: "ollama", endpoint: "https://ollama.com/api/web_search" },
      "gateway",
      {},
    )).toBeNull();
    expect(providerWebSearchBridgeConfigError({ enabled: true, backend: "ollama" }, "gateway", {})).toBeNull();
  });

  test("the shape check still runs before the destination check", () => {
    expect(providerWebSearchBridgeConfigError(
      { enabled: true, backend: "ollama", endpoint: "not-a-url" },
      "gateway",
      {},
    )).toBe("webSearchBridge.endpoint must be an absolute http(s) URL");
  });
});

const plan: PassthroughWebSearchBridgePlan = {
  backend: "ollama",
  endpoint: "https://ollama.com/api/web_search",
  maxSearches: 3,
  timeoutMs: 60_000,
};

const searchCall = {
  type: "function_call",
  id: "fc_1",
  call_id: "call_1",
  name: "web_search",
  arguments: "{\"query\":\"opencodex release\"}",
};

const preamble = {
  type: "message",
  id: "msg_1",
  role: "assistant",
  content: [{ type: "output_text", text: "Let me look that up." }],
};

const answer = {
  type: "message",
  id: "msg_2",
  role: "assistant",
  content: [{ type: "output_text", text: "The current release is 2.50.0." }],
};

/** A leg that asks for one search, preceded by a normal assistant message. */
function searchLeg(): string {
  return sseBody(
    frame("response.created", { response: { id: "resp_1", status: "in_progress" } }),
    frame("response.output_item.added", { output_index: 0, item: { ...preamble, content: [] } }),
    frame("response.output_item.done", { output_index: 0, item: preamble }),
    frame("response.output_item.added", { output_index: 1, item: { ...searchCall, arguments: "" } }),
    frame("response.function_call_arguments.done", {
      output_index: 1,
      item_id: "fc_1",
      arguments: searchCall.arguments,
    }),
    frame("response.output_item.done", { output_index: 1, item: searchCall }),
    frame("response.completed", {
      response: { id: "resp_1", status: "completed", output: [preamble, searchCall] },
    }),
  );
}

function answerLeg(): string {
  return sseBody(
    frame("response.created", { response: { id: "resp_2", status: "in_progress" } }),
    frame("response.output_item.added", { output_index: 0, item: { ...answer, content: [] } }),
    frame("response.output_item.done", { output_index: 0, item: answer }),
    frame("response.completed", {
      response: { id: "resp_2", status: "completed", output: [answer] },
    }),
  );
}

const initialBody = JSON.stringify({
  model: "glm-4.7",
  stream: true,
  input: [{ role: "user", content: [{ type: "input_text", text: "what is the latest release?" }] }],
  tools: [{ type: "web_search" }],
});

describe("the bridged client stream", () => {
  test("replaces the web_search function_call with a hosted cell and continues upstream", async () => {
    const sent: string[] = [];
    const executed: string[][] = [];
    const stream = createPassthroughWebSearchBridgeStream({
      plan,
      firstLeg: streamFromText(searchLeg()),
      requestBody: initialBody,
      send: async (body) => {
        sent.push(body);
        return new Response(streamFromText(answerLeg()), {
          headers: { "content-type": "text/event-stream" },
        });
      },
      execute: async (queries) => {
        executed.push(queries);
        return { text: "opencodex 2.50.0 shipped", sources: [{ url: "https://example.test/rel", title: "Releases" }] };
      },
    });

    const body = await new Response(stream).text();
    const events = clientEvents(body);

    // The call Codex cannot execute never reaches it; the hosted cell does.
    expect(body).not.toContain("\"name\":\"web_search\"");
    expect(body).not.toContain("\"type\":\"function_call\"");
    const added = events.find(event =>
      event.type === "response.output_item.added"
      && (event.item as Record<string, unknown>).type === "web_search_call");
    const done = events.find(event =>
      event.type === "response.output_item.done"
      && (event.item as Record<string, unknown>).type === "web_search_call");
    expect(added).toBeDefined();
    expect(done).toBeDefined();
    const addedItem = added!.item as Record<string, unknown>;
    const doneItem = done!.item as Record<string, unknown>;
    expect(addedItem.status).toBe("in_progress");
    expect(String(addedItem.id)).toStartWith("ws_");
    expect(doneItem.id).toBe(addedItem.id);
    expect(doneItem.status).toBe("completed");
    expect(doneItem.action).toEqual({
      type: "search",
      query: "opencodex release",
      queries: ["opencodex release"],
    });
    expect(doneItem.sources).toEqual([{ url: "https://example.test/rel", title: "Releases" }]);
    expect(executed).toEqual([["opencodex release"]]);

    // The second upstream body carries the executed call and its result.
    expect(sent).toHaveLength(1);
    const continuation = JSON.parse(sent[0]!) as { input: Record<string, unknown>[]; stream: boolean };
    expect(continuation.stream).toBe(true);
    const call = continuation.input.find(item => item.type === "function_call");
    const output = continuation.input.find(item => item.type === "function_call_output");
    expect(call).toMatchObject({ call_id: "call_1", name: "web_search", arguments: searchCall.arguments });
    expect(output).toMatchObject({ call_id: "call_1", output: "opencodex 2.50.0 shipped" });

    // Both legs land in one monotonic client numbering, and the terminal snapshot matches it.
    const indexes = events
      .filter(event => event.type === "response.output_item.added")
      .map(event => event.output_index);
    expect(indexes).toEqual([0, 1, 2]);
    const completed = events.filter(event => event.type === "response.completed");
    expect(completed).toHaveLength(1);
    const finalOutput = (completed[0]!.response as { output: Record<string, unknown>[] }).output;
    expect(finalOutput.map(item => item.type)).toEqual(["message", "web_search_call", "message"]);
    const sequences = events.map(event => event.sequence_number as number);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
  });

  test("a turn with no search is relayed untouched and never re-sends", async () => {
    let sends = 0;
    let finalizations = 0;
    const stream = createPassthroughWebSearchBridgeStream({
      plan,
      firstLeg: streamFromText(answerLeg()),
      requestBody: initialBody,
      send: async () => {
        sends += 1;
        return new Response(null, { status: 500 });
      },
      execute: async () => {
        throw new Error("must not execute a search for a turn that did not ask for one");
      },
      onFinalize: () => { finalizations += 1; },
    });

    const body = await new Response(stream).text();
    expect(sends).toBe(0);
    expect(body).not.toContain("web_search_call");
    expect(body).toContain("response.completed");
    expect(body).toContain("The current release is 2.50.0.");
    expect(body.trimEnd().endsWith("data: [DONE]")).toBe(true);
    expect(finalizations).toBe(1);
  });

  test("a search mixed with another client tool call ends the turn on that leg", async () => {
    const sent: string[] = [];
    const executed: string[][] = [];
    const clientCall = {
      type: "function_call",
      id: "fc_2",
      call_id: "call_2",
      name: "exec",
      arguments: "{\"cmd\":\"ls\"}",
    };
    const mixedLeg = sseBody(
      frame("response.output_item.added", { output_index: 0, item: { ...searchCall, arguments: "" } }),
      frame("response.output_item.done", { output_index: 0, item: searchCall }),
      frame("response.output_item.added", { output_index: 1, item: { ...clientCall, arguments: "" } }),
      frame("response.function_call_arguments.done", {
        output_index: 1,
        item_id: "fc_2",
        arguments: clientCall.arguments,
      }),
      frame("response.output_item.done", { output_index: 1, item: clientCall }),
      frame("response.completed", {
        response: { id: "resp_1", status: "completed", output: [searchCall, clientCall] },
      }),
    );

    const stream = createPassthroughWebSearchBridgeStream({
      plan,
      firstLeg: streamFromText(mixedLeg),
      requestBody: initialBody,
      send: async (body) => {
        sent.push(body);
        return new Response(null, { status: 500 });
      },
      execute: async (queries) => {
        executed.push(queries);
        return { text: "opencodex 2.50.0 shipped", sources: [{ url: "https://example.test/rel", title: "Releases" }] };
      },
    });

    const body = await new Response(stream).text();
    const events = clientEvents(body);

    // The client's own call is unanswered, so the conversation owes the client a turn, not the
    // gateway: the search still runs, then the leg ends with no continuation POST upstream.
    expect(sent).toEqual([]);
    expect(executed).toEqual([["opencodex release"]]);
    expect(body).not.toContain("response.failed");
    expect(body).not.toContain(WEB_SEARCH_BRIDGE_MIXED_TOOLS_ERROR_CODE);

    // The hosted cell completes with its real queries and sources, exactly as on a pure leg.
    const cellDone = events.find(event =>
      event.type === "response.output_item.done"
      && (event.item as Record<string, unknown>).type === "web_search_call");
    expect(cellDone).toBeDefined();
    const cellItem = cellDone!.item as Record<string, unknown>;
    expect(cellItem.status).toBe("completed");
    expect(cellItem.action).toEqual({
      type: "search",
      query: "opencodex release",
      queries: ["opencodex release"],
    });
    expect(cellItem.sources).toEqual([{ url: "https://example.test/rel", title: "Releases" }]);

    // The held client call is released with its own item id, call_id, and arguments intact.
    const execDone = events.find(event =>
      event.type === "response.output_item.done"
      && (event.item as Record<string, unknown>).type === "function_call");
    expect(execDone).toBeDefined();
    expect(execDone!.item as Record<string, unknown>).toMatchObject({
      id: "fc_2",
      call_id: "call_2",
      name: "exec",
      arguments: clientCall.arguments,
    });

    // One terminal, and its snapshot carries both items in the order upstream emitted them.
    const completed = events.filter(event => event.type === "response.completed");
    expect(completed).toHaveLength(1);
    const output = (completed[0]!.response as { output: Record<string, unknown>[] }).output;
    expect(output.map(item => item.type)).toEqual(["web_search_call", "function_call"]);
    expect(output[1]).toMatchObject({ call_id: "call_2", name: "exec" });
  });

  test("a mixed leg where the client call streams first keeps the streamed order in the snapshot", async () => {
    const sent: string[] = [];
    const clientCall = {
      type: "function_call",
      id: "fc_0",
      call_id: "call_0",
      name: "exec",
      arguments: "{}",
    };
    const mixedLeg = sseBody(
      frame("response.output_item.added", { output_index: 0, item: { ...clientCall, arguments: "" } }),
      frame("response.output_item.done", { output_index: 0, item: clientCall }),
      frame("response.output_item.added", { output_index: 1, item: { ...searchCall, arguments: "" } }),
      frame("response.output_item.done", { output_index: 1, item: searchCall }),
      frame("response.completed", {
        response: { id: "resp_1", status: "completed", output: [clientCall, searchCall] },
      }),
    );

    const stream = createPassthroughWebSearchBridgeStream({
      plan,
      firstLeg: streamFromText(mixedLeg),
      requestBody: initialBody,
      send: async (body) => {
        sent.push(body);
        return new Response(null, { status: 500 });
      },
      execute: async () => ({ text: "a result", sources: [] }),
    });

    const events = clientEvents(await new Response(stream).text());
    expect(sent).toEqual([]);

    // The held call reaches the client AFTER the hosted cell, because it is only released once
    // the leg is known to end here; output_index follows that streamed order with no gap.
    const added = events.filter(event => event.type === "response.output_item.added");
    expect(added.map(event => (event.item as Record<string, unknown>).type))
      .toEqual(["web_search_call", "function_call"]);
    expect(added.map(event => event.output_index)).toEqual([0, 1]);

    // The retained snapshot follows the same streamed order -- it exists so response.output
    // matches the turn the client received, so a divergence here would contradict the stream.
    const completed = events.find(event => event.type === "response.completed");
    const output = (completed!.response as { output: Record<string, unknown>[] }).output;
    expect(output.map(item => item.type)).toEqual(["web_search_call", "function_call"]);
    expect(output[1]).toMatchObject({ call_id: "call_0", name: "exec" });
  });

  test("a mixed leg whose upstream terminal already ended runs no search and closes the cell", async () => {
    const sent: string[] = [];
    let executes = 0;
    const clientCall = {
      type: "function_call",
      id: "fc_3",
      call_id: "call_3",
      name: "exec",
      arguments: "{}",
    };
    const mixedLeg = sseBody(
      frame("response.output_item.added", { output_index: 0, item: { ...searchCall, arguments: "" } }),
      frame("response.output_item.done", { output_index: 0, item: searchCall }),
      frame("response.output_item.added", { output_index: 1, item: { ...clientCall, arguments: "" } }),
      frame("response.output_item.done", { output_index: 1, item: clientCall }),
      frame("response.incomplete", {
        response: { id: "resp_1", status: "incomplete", output: [searchCall, clientCall] },
      }),
    );

    const stream = createPassthroughWebSearchBridgeStream({
      plan,
      firstLeg: streamFromText(mixedLeg),
      requestBody: initialBody,
      send: async (body) => {
        sent.push(body);
        return new Response(null, { status: 500 });
      },
      execute: async () => {
        executes += 1;
        return { text: "unused", sources: [] };
      },
    });

    const body = await new Response(stream).text();
    const events = clientEvents(body);

    // The upstream terminal already ended the turn, so no search is billed and nothing is
    // sent back upstream.
    expect(executes).toBe(0);
    expect(sent).toEqual([]);

    // The opened hosted cell still closes -- as failed, not left in_progress under a finished
    // turn -- and the held client call is released rather than dropped.
    const cellDone = events.find(event =>
      event.type === "response.output_item.done"
      && (event.item as Record<string, unknown>).type === "web_search_call");
    expect((cellDone!.item as Record<string, unknown>).status).toBe("failed");
    const execDone = events.find(event =>
      event.type === "response.output_item.done"
      && (event.item as Record<string, unknown>).type === "function_call");
    expect(execDone!.item as Record<string, unknown>).toMatchObject({ call_id: "call_3", name: "exec" });

    // The upstream terminal is relayed as it stood: incomplete, not a bridge failure.
    const incomplete = events.filter(event => event.type === "response.incomplete");
    expect(incomplete).toHaveLength(1);
    expect(body).not.toContain("response.failed");
  });

  test("a mixed leg whose upstream terminal FAILED closes the cell and drops the held call", async () => {
    // Sibling of the incomplete case above, and the reason the two terminals are not one branch.
    // An incomplete turn is one the client can still act on, so its withheld call goes back. A
    // failed turn is over, and handing Codex a tool call to start executing inside it is the
    // exact thing the bridge's failure path refuses to do.
    const sent: string[] = [];
    let executes = 0;
    const clientCall = {
      type: "function_call",
      id: "fc_4",
      call_id: "call_4",
      name: "exec",
      arguments: "{}",
    };
    const mixedLeg = sseBody(
      frame("response.output_item.added", { output_index: 0, item: { ...searchCall, arguments: "" } }),
      frame("response.output_item.done", { output_index: 0, item: searchCall }),
      frame("response.output_item.added", { output_index: 1, item: { ...clientCall, arguments: "" } }),
      frame("response.output_item.done", { output_index: 1, item: clientCall }),
      frame("response.failed", {
        response: { id: "resp_1", status: "failed", output: [searchCall, clientCall] },
      }),
    );

    const stream = createPassthroughWebSearchBridgeStream({
      plan,
      firstLeg: streamFromText(mixedLeg),
      requestBody: initialBody,
      send: async (body) => {
        sent.push(body);
        return new Response(null, { status: 500 });
      },
      execute: async () => {
        executes += 1;
        return { text: "unused", sources: [] };
      },
    });

    const body = await new Response(stream).text();
    const events = clientEvents(body);

    // No search is billed and nothing goes back upstream, same as the incomplete case.
    expect(executes).toBe(0);
    expect(sent).toEqual([]);

    // The opened hosted cell still closes rather than dangling under a finished turn.
    const cellDone = events.find(event =>
      event.type === "response.output_item.done"
      && (event.item as Record<string, unknown>).type === "web_search_call");
    expect((cellDone!.item as Record<string, unknown>).status).toBe("failed");

    // The withheld client call is NOT released: no function_call reaches the client.
    const execDone = events.find(event =>
      event.type === "response.output_item.done"
      && (event.item as Record<string, unknown>).type === "function_call");
    expect(execDone).toBeUndefined();
    expect(body).not.toContain("call_4");

    // The upstream terminal is relayed as it stood: failed.
    expect(events.filter(event => event.type === "response.failed")).toHaveLength(1);
  });

  test("already-hosted web_search_call items pass through without a proxy search", async () => {
    let sends = 0;
    let executes = 0;
    const hosted = {
      type: "web_search_call",
      id: "ws_hosted",
      status: "completed",
      action: { type: "search", query: "latest status" },
    };
    const hostedLeg = sseBody(
      frame("response.output_item.added", { output_index: 0, item: { ...hosted, status: "in_progress" } }),
      frame("response.output_item.done", { output_index: 0, item: hosted }),
      frame("response.output_item.added", { output_index: 1, item: { ...answer, content: [] } }),
      frame("response.output_item.done", { output_index: 1, item: answer }),
      frame("response.completed", {
        response: { id: "resp_1", status: "completed", output: [hosted, answer] },
      }),
    );
    const stream = createPassthroughWebSearchBridgeStream({
      plan,
      firstLeg: streamFromText(hostedLeg),
      requestBody: initialBody,
      send: async () => {
        sends += 1;
        return new Response(null, { status: 500 });
      },
      execute: async () => {
        executes += 1;
        return { text: "unused", sources: [] };
      },
    });
    const body = await new Response(stream).text();
    expect(sends).toBe(0);
    expect(executes).toBe(0);
    expect(body).toContain("\"type\":\"web_search_call\"");
    expect(body).toContain("The current release is 2.50.0.");
    expect(body).not.toContain("response.failed");
  });

  test("probe B mixed hosted cells plus exec plus web_search ends the turn on that leg", async () => {
    const sent: string[] = [];
    const executed: string[][] = [];
    const hosted = {
      type: "web_search_call",
      id: "ws_hosted",
      status: "completed",
      action: { type: "search", query: "already searched" },
    };
    const execCall = {
      type: "function_call",
      id: "fc_exec",
      call_id: "call_exec",
      name: "exec",
      arguments: "{\"cmd\":\"python fetch.py\"}",
    };
    const probeB = sseBody(
      frame("response.output_item.added", { output_index: 0, item: { ...hosted, status: "in_progress" } }),
      frame("response.output_item.done", { output_index: 0, item: hosted }),
      frame("response.output_item.added", { output_index: 1, item: { ...execCall, arguments: "" } }),
      frame("response.output_item.done", { output_index: 1, item: execCall }),
      frame("response.output_item.added", { output_index: 2, item: { ...searchCall, arguments: "" } }),
      frame("response.output_item.done", { output_index: 2, item: searchCall }),
      frame("response.completed", {
        response: { id: "resp_1", status: "completed", output: [hosted, execCall, searchCall] },
      }),
    );
    const stream = createPassthroughWebSearchBridgeStream({
      plan,
      firstLeg: streamFromText(probeB),
      requestBody: initialBody,
      send: async (body) => {
        sent.push(body);
        return new Response(null, { status: 500 });
      },
      execute: async (queries) => {
        executed.push(queries);
        return { text: "a result", sources: [] };
      },
    });
    const body = await new Response(stream).text();
    const events = clientEvents(body);
    // Only the intercepted call is executed proxy-side; the already-hosted cell is upstream's
    // own item and passes through, and the leg still ends without a continuation.
    expect(sent).toEqual([]);
    expect(executed).toEqual([["opencodex release"]]);
    expect(body).not.toContain("response.failed");
    expect(body).not.toContain(WEB_SEARCH_BRIDGE_MIXED_TOOLS_ERROR_CODE);
    // The held exec call is released for Codex to run with its identity intact.
    const execDone = events.find(event =>
      event.type === "response.output_item.done"
      && (event.item as Record<string, unknown>).type === "function_call");
    expect(execDone).toBeDefined();
    expect(execDone!.item as Record<string, unknown>).toMatchObject({
      id: "fc_exec",
      call_id: "call_exec",
      name: "exec",
      arguments: "{\"cmd\":\"python fetch.py\"}",
    });
    // The snapshot follows the streamed order: the hosted cell, the new cell, then the
    // released client call.
    const completed = events.find(event => event.type === "response.completed");
    const output = (completed!.response as { output: Record<string, unknown>[] }).output;
    expect(output.map(item => item.type))
      .toEqual(["web_search_call", "web_search_call", "function_call"]);
    expect(output[0]).toMatchObject({ id: "ws_hosted" });
    expect(output[2]).toMatchObject({ call_id: "call_exec", name: "exec" });
  });

  test("DeepSeek-style XML assistant text is not dispatched as a search", async () => {
    let sends = 0;
    let executes = 0;
    const xmlAnswer = {
      type: "message",
      id: "msg_xml",
      role: "assistant",
      content: [{
        type: "output_text",
        text: "I'll search for that information now.\n\n<web_search>\n<query>DeepSeek V4.1-Flash API price</query>\n</web_search>\n\nI don't have a web_search tool available.",
      }],
    };
    const xmlLeg = sseBody(
      frame("response.output_item.added", { output_index: 0, item: { ...xmlAnswer, content: [] } }),
      frame("response.output_item.done", { output_index: 0, item: xmlAnswer }),
      frame("response.completed", {
        response: { id: "resp_1", status: "completed", output: [xmlAnswer] },
      }),
    );
    const stream = createPassthroughWebSearchBridgeStream({
      plan,
      firstLeg: streamFromText(xmlLeg),
      requestBody: initialBody,
      send: async () => {
        sends += 1;
        return new Response(null, { status: 500 });
      },
      execute: async () => {
        executes += 1;
        return { text: "unused", sources: [] };
      },
    });
    const body = await new Response(stream).text();
    expect(sends).toBe(0);
    expect(executes).toBe(0);
    expect(body).toContain("<web_search>");
    expect(body).toContain("DeepSeek V4.1-Flash API price");
    expect(body).not.toContain("response.failed");
    expect(clientEvents(body).some(event =>
      event.type === "response.output_item.added"
      && (event.item as Record<string, unknown>).type === "web_search_call")).toBe(false);
  });

  test("a search that is not the last item keeps its streamed position", async () => {
    // The model searches first and keeps talking; the hosted cell must open where the call stood.
    const leg = sseBody(
      frame("response.output_item.added", { output_index: 0, item: { ...searchCall, arguments: "" } }),
      frame("response.output_item.done", { output_index: 0, item: searchCall }),
      frame("response.output_item.added", { output_index: 1, item: { ...preamble, content: [] } }),
      frame("response.output_item.done", { output_index: 1, item: preamble }),
      frame("response.completed", {
        response: { id: "resp_1", status: "completed", output: [searchCall, preamble] },
      }),
    );
    const stream = createPassthroughWebSearchBridgeStream({
      plan,
      firstLeg: streamFromText(leg),
      requestBody: initialBody,
      send: async () => new Response(streamFromText(answerLeg()), {
        headers: { "content-type": "text/event-stream" },
      }),
      execute: async () => ({ text: "a result", sources: [] }),
    });

    const events = clientEvents(await new Response(stream).text());
    const added = events.filter(event => event.type === "response.output_item.added");
    expect(added.map(event => (event.item as Record<string, unknown>).type))
      .toEqual(["web_search_call", "message", "message"]);
    expect(added.map(event => event.output_index)).toEqual([0, 1, 2]);

    // The terminal snapshot keeps the same order the client saw, not the order of completion.
    const completed = events.find(event => event.type === "response.completed");
    const output = (completed!.response as { output: Record<string, unknown>[] }).output;
    expect(output.map(item => item.type)).toEqual(["web_search_call", "message", "message"]);
  });

  test("a continuation body over the outbound ceiling is refused instead of sent", async () => {
    let sends = 0;
    const stream = createPassthroughWebSearchBridgeStream({
      plan,
      firstLeg: streamFromText(searchLeg()),
      requestBody: initialBody,
      send: async () => {
        sends += 1;
        return new Response(null, { status: 500 });
      },
      execute: async () => ({ text: "a result", sources: [] }),
      checkOutboundBody: () => "outbound body is too large",
    });

    const body = await new Response(stream).text();
    expect(sends).toBe(0);
    const failed = clientEvents(body).find(event => event.type === "response.failed");
    const error = (failed!.response as { error: Record<string, unknown> }).error;
    expect(error.code).toBe(WEB_SEARCH_BRIDGE_ERROR_CODE);
    expect(String(error.message)).toContain("outbound body is too large");
  });

  test("a cancelled client stream bills no further search and sends no continuation", async () => {
    let sends = 0;
    let executes = 0;
    let finalizations = 0;
    const stream = createPassthroughWebSearchBridgeStream({
      plan,
      firstLeg: streamFromText(searchLeg()),
      requestBody: initialBody,
      send: async () => {
        sends += 1;
        return new Response(streamFromText(answerLeg()), {
          headers: { "content-type": "text/event-stream" },
        });
      },
      execute: async () => {
        executes += 1;
        return { text: "a result", sources: [] };
      },
      onFinalize: () => { finalizations += 1; },
    });

    await stream.getReader().cancel("client disconnected");
    expect(executes).toBe(0);
    expect(sends).toBe(0);
    expect(finalizations).toBe(1);
  });


  test("the search budget is bounded and the turn terminates rather than looping", async () => {
    const executed: string[][] = [];
    let sends = 0;
    const stream = createPassthroughWebSearchBridgeStream({
      plan: { ...plan, maxSearches: 1 },
      firstLeg: streamFromText(searchLeg()),
      requestBody: initialBody,
      send: async () => {
        sends += 1;
        return new Response(streamFromText(searchLeg()), {
          headers: { "content-type": "text/event-stream" },
        });
      },
      execute: async (queries) => {
        executed.push(queries);
        return { text: "one result", sources: [] };
      },
    });

    const body = await new Response(stream).text();
    // One executed search, one refusal cell, then a bounded terminal failure.
    expect(executed).toHaveLength(1);
    expect(sends).toBe(2);
    const failed = clientEvents(body).find(event => event.type === "response.failed");
    expect((failed!.response as { error: Record<string, unknown> }).error.code)
      .toBe(WEB_SEARCH_BRIDGE_ERROR_CODE);
  });

  test("an executor failure is reported as the tool result, not as a dead turn", async () => {
    const sent: string[] = [];
    const stream = createPassthroughWebSearchBridgeStream({
      plan,
      firstLeg: streamFromText(searchLeg()),
      requestBody: initialBody,
      send: async (body) => {
        sent.push(body);
        return new Response(streamFromText(answerLeg()), {
          headers: { "content-type": "text/event-stream" },
        });
      },
      execute: async () => ({ text: "", sources: [], error: "ollama web-search HTTP 401" }),
    });

    const body = await new Response(stream).text();
    const done = clientEvents(body).find(event =>
      event.type === "response.output_item.done"
      && (event.item as Record<string, unknown>).type === "web_search_call");
    expect((done!.item as Record<string, unknown>).status).toBe("failed");
    const continuation = JSON.parse(sent[0]!) as { input: Record<string, unknown>[] };
    const output = continuation.input.find(item => item.type === "function_call_output");
    expect(String(output!.output)).toContain("Web search failed: ollama web-search HTTP 401");
    expect(body).toContain("The current release is 2.50.0.");
  });
});

describe("bridge helpers", () => {
  test("appendBridgeSearchTurn refuses a body whose input is not an array", () => {
    expect(appendBridgeSearchTurn("not json", [])).toBeUndefined();
    expect(appendBridgeSearchTurn(JSON.stringify({ input: "prompt" }), [])).toBeUndefined();
  });

  test("mapOllamaSearchResponse digests results and rejects a shapeless body", () => {
    expect(mapOllamaSearchResponse({ nope: true }).error).toBeDefined();
    expect(mapOllamaSearchResponse({ results: [] }).error).toBeDefined();
    const mapped = mapOllamaSearchResponse({
      results: [{ title: "Releases", url: "https://example.test/rel", content: "2.50.0 is out" }],
    });
    expect(mapped.error).toBeUndefined();
    expect(mapped.sources).toEqual([{ url: "https://example.test/rel", title: "Releases" }]);
    expect(mapped.text).toContain("2.50.0 is out");
  });
});

// The global webSearchSidecar block carries the model chosen for ITS backend, while the bridge
// backend is per-provider and configured independently. Without the agreement check a global
// { backend: "openai", model: "gpt-5.6-luna" } would reach runAnthropicWebSearch on an anthropic
// bridge, and Anthropic rejects the model.
describe("sidecarSettingsForBridge backend/model agreement", () => {
  function bridgePlan(backend: ProviderWebSearchBridgeBackend): PassthroughWebSearchBridgePlan {
    return { backend, maxSearches: 3, timeoutMs: 60_000 };
  }

  test("a global sidecar model configured for another backend does not reach this bridge", () => {
    const sidecar = { backend: "openai", model: "gpt-5.6-luna" } as const;
    expect(sidecarSettingsForBridge("anthropic", bridgePlan("anthropic"), { sidecar }).model)
      .toBe("claude-sonnet-5");
    expect(sidecarSettingsForBridge("xai", bridgePlan("xai"), { sidecar }).model)
      .toBe("grok-4.6");
    expect(sidecarSettingsForBridge("gemini", bridgePlan("gemini"), { sidecar }).model)
      .toBe("gemini-3.8-flash");
  });

  test("a global sidecar model configured for the same backend is kept as the operator override", () => {
    expect(sidecarSettingsForBridge("anthropic", bridgePlan("anthropic"), {
      sidecar: { backend: "anthropic", model: "claude-opus-4-6" },
    }).model).toBe("claude-opus-4-6");
    expect(sidecarSettingsForBridge("xai", bridgePlan("xai"), {
      sidecar: { backend: "xai", model: "grok-4.6-fast" },
    }).model).toBe("grok-4.6-fast");
    expect(sidecarSettingsForBridge("gemini", bridgePlan("gemini"), {
      sidecar: { backend: "gemini", model: "gemini-3.8-pro" },
    }).model).toBe("gemini-3.8-pro");
  });

  test("an unset global sidecar backend resolves to openai and matches only an openai bridge", () => {
    const sidecar = { model: "gpt-5.6-terra" } as const;
    expect(sidecarSettingsForBridge("openai", bridgePlan("openai"), { sidecar }).model)
      .toBe("gpt-5.6-terra");
    expect(sidecarSettingsForBridge("anthropic", bridgePlan("anthropic"), { sidecar }).model)
      .toBe("claude-sonnet-5");
  });

  test("an explicit openai sidecar backend keeps its model on an openai bridge", () => {
    const sidecar = { backend: "openai", model: "gpt-5.6-terra" } as const;
    expect(sidecarSettingsForBridge("openai", bridgePlan("openai"), { sidecar }).model)
      .toBe("gpt-5.6-terra");
  });

  test("a missing global sidecar block still yields a model for the ollama bridge", () => {
    // createOllamaBridgeExecutor passes no sidecar; the ollama arm is inert anyway since
    // runOllamaWebSearch takes no model argument.
    const settings = sidecarSettingsForBridge("ollama", bridgePlan("ollama"), {});
    expect(typeof settings.model).toBe("string");
    expect(settings.model.length).toBeGreaterThan(0);
  });

  test("reasoning, timeout, and describeImages still come from the sidecar block, the plan, and the context", () => {
    const settings = sidecarSettingsForBridge("xai", bridgePlan("xai"), {
      describeImages: true,
      sidecar: { backend: "xai", model: "grok-4.6-fast", reasoning: "high" },
    });
    expect(settings.reasoning).toBe("high");
    expect(settings.timeoutMs).toBe(60_000);
    expect(settings.describeImages).toBe(true);

    const unset = sidecarSettingsForBridge("xai", bridgePlan("xai"), {
      sidecar: { backend: "xai" },
    });
    expect(unset.reasoning).toBe("low");
    expect(unset.describeImages).toBe(false);
  });
});

describe("the reported turn, end to end through handleResponses", () => {
  function config(bridge?: ProviderWebSearchBridgeConfig): OcxConfig {
    return {
      port: 0,
      defaultProvider: "fixture",
      providers: {
        fixture: {
          adapter: "openai-responses",
          baseUrl: "https://ollama.com/v1",
          authMode: "key",
          apiKey: "fixture-key",
          ...(bridge ? { webSearchBridge: bridge } : {}),
        },
      },
    } as unknown as OcxConfig;
  }

  // Codex's own shape: the hosted web_search declaration plus ordinary client function tools.
  const clientRequest = JSON.stringify({
    model: "fixture/glm-4.7",
    stream: true,
    input: [{ role: "user", content: [{ type: "input_text", text: "what is the latest release?" }] }],
    tools: [
      { type: "web_search" },
      { type: "function", name: "wait", parameters: { type: "object" } },
    ],
  });

  async function post(
    ocxConfig: OcxConfig,
    legs: string[],
    hooks: { onSearch?: () => void; onProviderResponse?: (leg: number) => void } = {},
  ): Promise<{
    body: string;
    outbound: string[];
    destinations: Array<{ url: string; authorization: string | null }>;
    searches: number;
    searchUrls: string[];
    searchHeaders: Array<{ url: string; authorization: string | null; xApiKey: string | null }>;
  }> {
    const savedFetch = globalThis.fetch;
    const outbound: string[] = [];
    const destinations: Array<{ url: string; authorization: string | null }> = [];
    const searchUrls: string[] = [];
    const searchHeaders: Array<{ url: string; authorization: string | null; xApiKey: string | null }> = [];
    let searches = 0;
    let leg = 0;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL ? input.href : (input as Request).url;
      if (url.includes("/api/web_search") || url.includes("api.exa.ai/search")) {
        searches += 1;
        searchUrls.push(url);
        const headers = new Headers(init?.headers);
        searchHeaders.push({
          url,
          authorization: headers.get("authorization"),
          xApiKey: headers.get("x-api-key"),
        });
        hooks.onSearch?.();
        return new Response(JSON.stringify({
          results: [{
            title: "Releases",
            url: "https://example.test/rel",
            content: "opencodex 2.50.0",
            text: "opencodex 2.50.0",
          }],
        }), { headers: { "content-type": "application/json" } });
      }
      outbound.push(String(init?.body ?? ""));
      destinations.push({ url, authorization: new Headers(init?.headers).get("authorization") });
      const text = legs[Math.min(leg, legs.length - 1)]!;
      leg += 1;
      hooks.onProviderResponse?.(leg);
      return new Response(text, { headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;
    try {
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer caller-inbound" },
        body: clientRequest,
      }), ocxConfig, { model: "", provider: "" });
      return { body: await response.text(), outbound, destinations, searches, searchUrls, searchHeaders };
    } finally {
      globalThis.fetch = savedFetch;
    }
  }

  test("without the opt-in the reported abort still happens", async () => {
    const result = await post(config(), [searchLeg()]);
    expect(result.searches).toBe(0);
    expect(result.outbound).toHaveLength(1);
    expect(result.body).toContain("response.failed");
    expect(result.body).toContain(UNDECLARED_TOOL_CALL_ERROR_CODE);
    expect(result.body).not.toContain("web_search_call");
  });

  test("with the opt-in the client sees a hosted search cell and the answer", async () => {
    const result = await post(config(armed), [searchLeg(), answerLeg()]);

    expect(result.searches).toBe(1);
    expect(result.body).not.toContain(UNDECLARED_TOOL_CALL_ERROR_CODE);
    expect(result.body).toContain("\"type\":\"web_search_call\"");
    expect(result.body).not.toContain("\"name\":\"web_search\"");
    expect(result.body).toContain("The current release is 2.50.0.");

    // The search result reached the SECOND upstream body as a native tool result.
    expect(result.outbound).toHaveLength(2);
    expect(result.destinations).toEqual([
      { url: "https://ollama.com/v1/responses", authorization: "Bearer fixture-key" },
      { url: "https://ollama.com/v1/responses", authorization: "Bearer fixture-key" },
    ]);
    const continuation = JSON.parse(result.outbound[1]!) as { input: Record<string, unknown>[] };
    const output = continuation.input.find(item => item.type === "function_call_output");
    expect(output).toBeDefined();
    expect(String(output!.output)).toContain("opencodex 2.50.0");
    expect(continuation.input.some(item =>
      item.type === "function_call" && item.name === "web_search")).toBe(true);
  });

  const selectionChanges: Array<[string, (ocxConfig: OcxConfig) => void]> = [
    ["selection revision with an unchanged key", cfg => {
      cfg.providers.fixture!.apiKeySelectionRevision = "selection-after";
    }],
    ["key reference with the same resolved value", cfg => {
      cfg.providers.fixture!.apiKey = "${OCX_BRIDGE_BINDING_ALTERNATE}";
      cfg.providers.fixture!.apiKeyPool![0]!.key = "${OCX_BRIDGE_BINDING_ALTERNATE}";
    }],
    ["selected entry id", cfg => {
      cfg.providers.fixture!.apiKeyPool![0]!.id = "entry-after";
    }],
    ["resolved key behind an unchanged reference", () => {
      process.env.OCX_BRIDGE_BINDING_KEY = "fixture-key-after";
    }],
    ["authentication mode", cfg => { cfg.providers.fixture!.authMode = "forward"; }],
    ["base URL", cfg => { cfg.providers.fixture!.baseUrl = "https://gateway.example/v1"; }],
    ["provider disabled", cfg => { cfg.providers.fixture!.disabled = true; }],
    ["provider removed", cfg => { delete cfg.providers.fixture; }],
  ];

  test.each(selectionChanges)("refuses the continuation when search changes the %s", async (_name, change) => {
    const savedKey = process.env.OCX_BRIDGE_BINDING_KEY;
    const savedAlternate = process.env.OCX_BRIDGE_BINDING_ALTERNATE;
    process.env.OCX_BRIDGE_BINDING_KEY = "fixture-key";
    process.env.OCX_BRIDGE_BINDING_ALTERNATE = "fixture-key";
    const cfg = config(armed);
    Object.assign(cfg.providers.fixture!, {
      apiKey: "${OCX_BRIDGE_BINDING_KEY}",
      apiKeySelectionRevision: "selection-before",
      apiKeyPool: [{ id: "entry-before", key: "${OCX_BRIDGE_BINDING_KEY}" }],
    });
    try {
      const result = await post(cfg, [searchLeg(), answerLeg()], { onSearch: () => change(cfg) });
      expect(result.searches).toBe(1);
      expect(result.outbound).toHaveLength(1);
      expect(result.destinations).toEqual([
        { url: "https://ollama.com/v1/responses", authorization: "Bearer fixture-key" },
      ]);
      const events = clientEvents(result.body);
      expect(events.filter(event => event.type === "response.failed")).toHaveLength(1);
      expect(events.filter(event => event.type === "response.completed")).toHaveLength(0);
      expect(result.body).toContain(WEB_SEARCH_BRIDGE_ERROR_CODE);
      expect(result.body).not.toContain("The current release is 2.50.0.");
    } finally {
      if (savedKey === undefined) delete process.env.OCX_BRIDGE_BINDING_KEY;
      else process.env.OCX_BRIDGE_BINDING_KEY = savedKey;
      if (savedAlternate === undefined) delete process.env.OCX_BRIDGE_BINDING_ALTERNATE;
      else process.env.OCX_BRIDGE_BINDING_ALTERNATE = savedAlternate;
    }
  });

  test("rechecks the continuation binding after its pacing wait", async () => {
    const cfg = config(armed);
    cfg.providers.fixture!.requestPacing = { enabled: true, minIntervalMs: 100 };
    let now = 0;
    let searches = 0;
    let waitsAfterSearch = 0;
    resetProviderRequestPacingForTest();
    setProviderRequestPacingRuntimeForTest({
      now: () => now,
      setTimer: (callback, delayMs) => {
        queueMicrotask(() => {
          if (searches > 0) {
            waitsAfterSearch += 1;
            cfg.providers.fixture!.apiKeySelectionRevision = "selection-during-pacing";
          }
          now += delayMs;
          callback();
        });
        return 1;
      },
      clearTimer: () => {},
      enqueueMicrotask: queueMicrotask,
    });
    try {
      const result = await post(cfg, [searchLeg(), answerLeg()], { onSearch: () => { searches += 1; } });
      expect(result.searches).toBe(1);
      expect(waitsAfterSearch).toBe(1);
      expect(result.outbound).toHaveLength(1);
      expect(result.body).toContain(WEB_SEARCH_BRIDGE_ERROR_CODE);
      expect(clientEvents(result.body).filter(event => event.type === "response.completed")).toHaveLength(0);
    } finally {
      resetProviderRequestPacingForTest();
    }
  });

  test("keeps the dispatched binding if selection changes before first-leg headers return", async () => {
    const cfg = config(armed);
    const result = await post(cfg, [searchLeg(), answerLeg()], {
      onProviderResponse: leg => {
        if (leg === 1) cfg.providers.fixture!.apiKey = "fixture-key-after";
      },
    });
    expect(result.searches).toBe(1);
    expect(result.outbound).toHaveLength(1);
    expect(result.destinations[0]!.authorization).toBe("Bearer fixture-key");
    expect(result.body).toContain(WEB_SEARCH_BRIDGE_ERROR_CODE);
    expect(clientEvents(result.body).filter(event => event.type === "response.completed")).toHaveLength(0);
  });

  test("allows initial dispatch reselection and binds search to the key that served it", async () => {
    const cfg = config(armed);
    cfg.providers.fixture!.requestPacing = { enabled: true, minIntervalMs: 100 };
    let now = 0;
    let waits = 0;
    resetProviderRequestPacingForTest();
    setProviderRequestPacingRuntimeForTest({
      now: () => now,
      setTimer: (callback, delayMs) => {
        queueMicrotask(() => {
          waits += 1;
          if (waits === 1) {
            cfg.providers.fixture!.apiKey = "fixture-key-after";
            cfg.providers.fixture!.apiKeySelectionRevision = "selection-before-first-send";
          }
          now += delayMs;
          callback();
        });
        return 1;
      },
      clearTimer: () => {},
      enqueueMicrotask: queueMicrotask,
    });
    try {
      // Occupy the first slot so the already-built request must wait before credential dispatch.
      await waitForProviderRequestSlot("fixture", cfg.providers.fixture!, "glm-4.7");
      const result = await post(cfg, [searchLeg(), answerLeg()]);
      expect(waits).toBe(2);
      expect(result.searches).toBe(1);
      expect(result.destinations).toEqual([
        { url: "https://ollama.com/v1/responses", authorization: "Bearer fixture-key-after" },
        { url: "https://ollama.com/v1/responses", authorization: "Bearer fixture-key-after" },
      ]);
      const continuation = JSON.parse(result.outbound[1]!) as { input: Record<string, unknown>[] };
      const output = continuation.input.find(item => item.type === "function_call_output");
      expect(String(output?.output)).toContain("opencodex 2.50.0");
      expect(result.body).toContain("The current release is 2.50.0.");
      expect(result.body).not.toContain("response.failed");
    } finally {
      resetProviderRequestPacingForTest();
    }
  });

  test("an unrelated undeclared tool still fails closed through the bridged stream", async () => {
    const strayCall = {
      type: "function_call",
      id: "fc_9",
      call_id: "call_9",
      name: "frobnicate",
      arguments: "{}",
    };
    const strayLeg = sseBody(
      frame("response.output_item.added", { output_index: 0, item: { ...strayCall, arguments: "" } }),
      frame("response.output_item.done", { output_index: 0, item: strayCall }),
      frame("response.completed", {
        response: { id: "resp_1", status: "completed", output: [strayCall] },
      }),
    );

    const result = await post(config(armed), [strayLeg]);
    expect(result.searches).toBe(0);
    expect(result.body).toContain("response.failed");
    expect(result.body).toContain(UNDECLARED_TOOL_CALL_ERROR_CODE);
    expect(result.body).toContain("frobnicate");
  });

  test("an exa-backed gateway executes hosted-only search without the ollama origin", async () => {
    const cfg = {
      port: 0,
      defaultProvider: "fixture",
      providers: {
        fixture: {
          adapter: "openai-responses",
          baseUrl: "https://gateway.example/v1",
          authMode: "key",
          apiKey: "fixture-key",
          webSearchBridge: { enabled: true, backend: "exa" },
        },
      },
      webSearchSidecar: { exaApiKey: "exa-canary" },
    } as unknown as OcxConfig;
    const result = await post(cfg, [searchLeg(), answerLeg()]);
    expect(result.searchUrls).toEqual(["https://api.exa.ai/search"]);
    expect(result.searchHeaders).toEqual([
      { url: "https://api.exa.ai/search", authorization: null, xApiKey: "exa-canary" },
    ]);
    expect(result.body).not.toContain(UNDECLARED_TOOL_CALL_ERROR_CODE);
    expect(result.body).toContain("\"type\":\"web_search_call\"");
    expect(result.body).not.toContain("\"name\":\"web_search\"");
    expect(result.body).toContain("The current release is 2.50.0.");
    expect(result.destinations.map(destination => destination.url)).toEqual([
      "https://gateway.example/v1/responses",
      "https://gateway.example/v1/responses",
    ]);
    expect(result.destinations.every(destination => destination.authorization === "Bearer fixture-key")).toBe(true);
  });

  test("an exa-backed mixed exec/search turn ends the turn on that leg", async () => {
    const cfg = {
      port: 0,
      defaultProvider: "fixture",
      providers: {
        fixture: {
          adapter: "openai-responses",
          baseUrl: "https://gateway.example/v1",
          authMode: "key",
          apiKey: "fixture-key",
          webSearchBridge: { enabled: true, backend: "exa" },
        },
      },
      webSearchSidecar: { exaApiKey: "exa-canary" },
    } as unknown as OcxConfig;
    // The client call uses the one function name the request declares ("wait"); anything else
    // would trip the undeclared-tool guard for a reason unrelated to the bridge.
    const waitCall = {
      type: "function_call",
      id: "fc_wait",
      call_id: "call_wait",
      name: "wait",
      arguments: "{}",
    };
    const mixedLeg = sseBody(
      frame("response.output_item.added", { output_index: 0, item: { ...searchCall, arguments: "" } }),
      frame("response.output_item.done", { output_index: 0, item: searchCall }),
      frame("response.output_item.added", { output_index: 1, item: { ...waitCall, arguments: "" } }),
      frame("response.output_item.done", { output_index: 1, item: waitCall }),
      frame("response.completed", {
        response: { id: "resp_1", status: "completed", output: [searchCall, waitCall] },
      }),
    );
    const result = await post(cfg, [mixedLeg]);
    // The exa search still ran proxy-side, the leg ended the turn, and no continuation POST
    // went back to the gateway: the client's call is answered by the client, not upstream.
    expect(result.searches).toBe(1);
    expect(result.outbound).toHaveLength(1);
    expect(result.body).not.toContain(WEB_SEARCH_BRIDGE_MIXED_TOOLS_ERROR_CODE);
    expect(result.body).not.toContain("response.failed");
    expect(result.body).toContain("\"type\":\"web_search_call\"");
    expect(result.body).toContain("\"name\":\"wait\"");
    expect(result.body).toContain("call_wait");
  });

  test("exa without a key stays disarmed on a non-ollama gateway", async () => {
    const cfg = {
      port: 0,
      defaultProvider: "fixture",
      providers: {
        fixture: {
          adapter: "openai-responses",
          baseUrl: "https://gateway.example/v1",
          authMode: "key",
          apiKey: "fixture-key",
          webSearchBridge: { enabled: true, backend: "exa" },
        },
      },
    } as unknown as OcxConfig;
    const result = await post(cfg, [searchLeg()]);
    expect(result.searches).toBe(0);
    expect(result.body).toContain(UNDECLARED_TOOL_CALL_ERROR_CODE);
  });
});
