/**
 * Generic Responses-API clients (AI-SDK apps such as ZCode) omit `store`, but the
 * canonical forward Codex backend rejects a native request without an explicit
 * store:false ("Store must be set to false"). The default is applied only after
 * routing settles and only on the canonical Codex forward backend
 * (isCanonicalOpenAiForwardProvider: adapter + forward auth + the canonical base
 * URL). Every other Responses upstream — key-auth providers and custom forward
 * gateways alike — intentionally keeps the omitted-store server-side default so a
 * later turn can continue through an unexpanded previous_response_id. These tests
 * pin the scoped default (forward positive cases), the key-auth and custom-gateway
 * negatives, and explicit-value survival on both sides.
 *
 * End-to-end cases assert the captured upstream request body — the externally
 * observable payload. Pattern mirrors tests/responses-compaction-routing.test.ts
 * and tests/github-copilot-wire-defaults.test.ts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { CODEX_FORWARD_BASE_URL } from "../src/providers/openai-tiers";
import { handleResponses } from "../src/server/responses";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

function providerConfig(overrides: Partial<OcxProviderConfig> = {}): OcxConfig {
  return {
    defaultProvider: "gw",
    providers: {
      gw: {
        adapter: "openai-responses",
        baseUrl: CODEX_FORWARD_BASE_URL,
        authMode: "key",
        apiKey: "test-key",
        ...overrides,
      },
    },
  } as unknown as OcxConfig;
}

describe("/v1/responses defaults store:false only for the canonical forward Codex backend", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  function captureUpstream(): { urls: string[]; bodies: string[] } {
    const urls: string[] = [];
    const bodies: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      urls.push(String(input));
      const body =
        input instanceof Request ? await input.clone().text()
        : typeof init?.body === "string" ? init.body
        : "";
      bodies.push(body);
      return new Response("data: [DONE]\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;
    return { urls, bodies };
  }

  async function drive(
    config: OcxConfig,
    store: unknown,
  ): Promise<{ url: string; body: Record<string, unknown> | null }> {
    const { urls, bodies } = captureUpstream();
    await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gw/some-model",
          input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "ping" }] }],
          stream: true,
          ...(store === undefined ? {} : { store }),
        }),
      }),
      config,
      { model: "", provider: "" },
    );
    let parsed: Record<string, unknown> | null = null;
    try { parsed = bodies[0] ? (JSON.parse(bodies[0]) as Record<string, unknown>) : null; } catch { parsed = null; }
    return { url: urls[0] ?? "", body: parsed };
  }

  test("forward route: omitted store reaches the upstream Responses request as false", async () => {
    const { url, body } = await drive(providerConfig({ authMode: "forward" }), undefined);
    expect(url).toContain("/responses");
    expect(body).not.toBeNull();
    expect((body as Record<string, unknown>).store).toBe(false);
  });

  test("key-auth route: omitted store is NOT injected (stateful upstream keeps its default)", async () => {
    const { body } = await drive(providerConfig(), undefined);
    expect(body).not.toBeNull();
    expect(!("store" in (body as Record<string, unknown>))).toBe(true);
  });

  test("custom forward gateway: omitted store is NOT injected (non-canonical base URL keeps its default)", async () => {
    const { body } = await drive(
      providerConfig({ authMode: "forward", baseUrl: "https://gateway.example/v1" }),
      undefined,
    );
    expect(body).not.toBeNull();
    expect(!("store" in (body as Record<string, unknown>))).toBe(true);
  });

  test("forward route: explicit store:true is preserved", async () => {
    const { body } = await drive(providerConfig({ authMode: "forward" }), true);
    expect(body).not.toBeNull();
    expect((body as Record<string, unknown>).store).toBe(true);
  });

  test("forward route: explicit store:false is preserved", async () => {
    const { body } = await drive(providerConfig({ authMode: "forward" }), false);
    expect(body).not.toBeNull();
    expect((body as Record<string, unknown>).store).toBe(false);
  });

  test("key-auth route: explicit store:false is preserved", async () => {
    const { body } = await drive(providerConfig(), false);
    expect(body).not.toBeNull();
    expect((body as Record<string, unknown>).store).toBe(false);
  });
});
