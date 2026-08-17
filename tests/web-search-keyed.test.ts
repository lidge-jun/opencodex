import { afterEach, describe, expect, test } from "bun:test";
import { parseRequest } from "../src/responses/parser";
import {
  planWebSearch,
  resolveKeyedWebSearchSidecar,
  resolveSidecarBackend,
} from "../src/web-search";
import { runKeyedWebSearch } from "../src/web-search/executor";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

const routed: OcxProviderConfig = {
  adapter: "openai-chat",
  baseUrl: "https://routed.test/v1",
  apiKey: "routed-key",
};

/** Use the registry golden row (key-auth Zen Go gateway). */
function zenProvider(
  overrides: Partial<OcxProviderConfig> = {},
): OcxProviderConfig {
  return {
    adapter: "openai-chat",
    baseUrl: "https://opencode.ai/zen/go/v1",
    apiKey: "zen-key",
    ...overrides,
  };
}

function configFor(
  webSearchSidecar: Record<string, unknown>,
  provider = zenProvider(),
): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "opencode-go",
    providers: { "opencode-go": provider },
    webSearchSidecar,
  } as OcxConfig;
}

function parsedWithWebSearch() {
  return parseRequest({
    model: "opencode-go/deepseek-v4-flash",
    input: "Search current docs",
    stream: true,
    tools: [{ type: "web_search" }],
  });
}

describe("keyed web-search sidecar eligibility", () => {
  test("resolveSidecarBackend widens to keyed", () => {
    expect(resolveSidecarBackend("keyed")).toBe("keyed");
    expect(resolveSidecarBackend("openai")).toBe("openai");
    expect(resolveSidecarBackend("anthropic")).toBe("anthropic");
    expect(resolveSidecarBackend(undefined)).toBe("openai");
  });

  test("deepseek-v4-flash on opencode-go resolves to a keyed sidecar", () => {
    const cfg = configFor({
      backend: "keyed",
      provider: "opencode-go",
      model: "deepseek-v4-flash",
    });
    const sidecar = resolveKeyedWebSearchSidecar(cfg);
    expect(sidecar?.providerName).toBe("opencode-go");
    expect(sidecar?.model).toBe("deepseek-v4-flash");
    expect(sidecar?.apiKey).toBe("zen-key");
  });

  test("planWebSearch returns a keyed plan that never selects ChatGPT/Anthropic credentials", () => {
    const cfg = configFor({
      backend: "keyed",
      provider: "opencode-go",
      model: "deepseek-v4-flash",
    });
    const plan = planWebSearch(
      cfg,
      parsedWithWebSearch(),
      false,
      routed,
      "model",
    );
    expect(plan?.backend).toBe("keyed");
    expect(plan?.keyedSidecar?.apiKey).toBe("zen-key");
    expect(plan?.forwardSidecar).toBeUndefined();
    expect(plan?.anthropicSidecar).toBeUndefined();
  });

  test("fails closed when the provider is disabled", () => {
    expect(
      resolveKeyedWebSearchSidecar(
        configFor(
          { backend: "keyed", provider: "opencode-go" },
          zenProvider({ disabled: true }),
        ),
      ),
    ).toBeUndefined();
  });

  test("fails closed when the API key is missing", () => {
    expect(
      resolveKeyedWebSearchSidecar(
        configFor(
          { backend: "keyed", provider: "opencode-go" },
          zenProvider({ apiKey: "" }),
        ),
      ),
    ).toBeUndefined();
  });

  test("fails closed when the model is not declared to host hosted web_search", () => {
    expect(
      resolveKeyedWebSearchSidecar(
        configFor({
          backend: "keyed",
          provider: "opencode-go",
          model: "kimi-k3",
        }),
      ),
    ).toBeUndefined();
  });

  test("fails closed when the provider is unknown", () => {
    expect(
      resolveKeyedWebSearchSidecar(
        configFor({
          backend: "keyed",
          provider: "nope",
          model: "deepseek-v4-flash",
        }),
      ),
    ).toBeUndefined();
  });

  test("fails closed for an explicit keyed backend with no provider name", () => {
    expect(
      planWebSearch(
        configFor({ backend: "keyed" }),
        parsedWithWebSearch(),
        false,
        routed,
        "model",
      ),
    ).toBeUndefined();
  });
});

describe("runKeyedWebSearch request shape", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("POSTs baseUrl/responses with Bearer api key, hosted tool, and manual redirect", async () => {
    let captured: {
      url: string;
      headers: Record<string, string>;
      body: Record<string, unknown>;
      redirect?: string;
    } | null = null;
    globalThis.fetch = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => {
        headers[k] = v;
      });
      captured = {
        url: String(url),
        headers,
        body: JSON.parse(String(init?.body)),
        redirect: (init as { redirect?: string })?.redirect,
      };
      const body = [
        "event: response.output_text.done\ndata: " +
          JSON.stringify({
            type: "response.output_text.done",
            text: "zen answer",
          }) +
          "\n\n",
        "event: response.completed\ndata: " +
          JSON.stringify({
            type: "response.completed",
            response: {
              output: [
                {
                  type: "message",
                  role: "assistant",
                  content: [
                    {
                      type: "output_text",
                      text: "zen answer",
                      annotations: [
                        {
                          type: "url_citation",
                          url: "https://example.com",
                          title: "Ex",
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          }) +
          "\n\n",
      ].join("");
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(body));
            c.close();
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const out = await runKeyedWebSearch(
      "latest bun release",
      { type: "web_search", max_results: 5 } as unknown as Record<
        string,
        unknown
      >,
      {
        providerName: "opencode-go",
        provider: zenProvider(),
        apiKey: "zen-key",
      },
      {
        model: "deepseek-v4-flash",
        reasoning: "low",
        timeoutMs: 5000,
        describeImages: false,
      },
    );
    expect(out.error).toBeUndefined();
    expect(out.text).toBe("zen answer");
    expect(out.sources).toEqual([{ url: "https://example.com", title: "Ex" }]);

    const c = captured!;
    expect(c.url).toBe("https://opencode.ai/zen/go/v1/responses");
    expect(c.headers["authorization"]).toBe("Bearer zen-key");
    expect(c.headers["content-type"]).toBe("application/json");
    expect(c.redirect).toBe("manual");
    expect(c.body.model).toBe("deepseek-v4-flash");
    expect(c.body.tools).toEqual([{ type: "web_search", max_results: 5 }]);
  });

  test("honors provider.responsesPath when configured", async () => {
    let capturedUrl: string | null = null;
    globalThis.fetch = (async (url: string | URL | Request) => {
      capturedUrl = String(url);
      const body = [
        "event: response.output_text.done\ndata: " +
          JSON.stringify({ type: "response.output_text.done", text: "ok" }) +
          "\n\n",
        "event: response.completed\ndata: " +
          JSON.stringify({
            type: "response.completed",
            response: {
              output: [
                {
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: "ok", annotations: [] }],
                },
              ],
            },
          }) +
          "\n\n",
      ].join("");
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(body));
            c.close();
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const out = await runKeyedWebSearch(
      "latest bun release",
      { type: "web_search" } as unknown as Record<string, unknown>,
      {
        providerName: "custom",
        provider: zenProvider({
          baseUrl: "https://search.example/v1",
          responsesPath: "/custom-responses",
        }),
        apiKey: "custom-key",
      },
      {
        model: "deepseek-v4-flash",
        reasoning: "low",
        timeoutMs: 5000,
        describeImages: false,
      },
    );
    expect(out.error).toBeUndefined();
    expect(capturedUrl).toBe("https://search.example/v1/custom-responses");
  });
});
