/**
 * Generic Responses-API clients (AI-SDK apps such as ZCode) omit `store`, but the
 * Codex backend rejects a native request without an explicit store:false
 * ("Store must be set to false"). The chat-completions inbound already defaults
 * store:false when absent (src/server/chat-completions.ts); these tests pin the
 * same default on the /v1/responses inbound and prove explicit values survive.
 *
 * End-to-end cases assert the captured upstream request body — the externally
 * observable payload. Pattern mirrors tests/github-copilot-wire-defaults.test.ts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { providerConfigSeed } from "../src/providers/derive";
import { getProviderRegistryEntry } from "../src/providers/registry";
import { handleResponses } from "../src/server/responses/core";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

function copilotProvider(): OcxProviderConfig {
  // The entry's allowKeyAuthOverride lets tests use key auth instead of live OAuth.
  return { ...providerConfigSeed(getProviderRegistryEntry("github-copilot")!), authMode: "key", apiKey: "sk-test" };
}

describe("/v1/responses defaults store:false when the client omits it", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  function captureUpstream(): { urls: string[]; bodies: Promise<string>[] } {
    const urls: string[] = [];
    const bodies: Promise<string>[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      urls.push(String(input));
      const body =
        input instanceof Request ? input.clone().text()
        : typeof init?.body === "string" ? Promise.resolve(init.body)
        : Promise.resolve("");
      bodies.push(body);
      return new Response("data: [DONE]\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;
    return { urls, bodies };
  }

  async function drive(requestStore: unknown): Promise<{ url: string; body: Record<string, unknown> | null }> {
    const { urls, bodies } = captureUpstream();
    const config = { providers: { "github-copilot": copilotProvider() } } as unknown as OcxConfig;
    await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "github-copilot/gpt-5.4",
          input: [{ role: "user", content: [{ type: "input_text", text: "ping" }] }],
          stream: true,
          ...(requestStore === undefined ? {} : { store: requestStore }),
        }),
      }),
      config,
      { model: "", provider: "" },
    );
    const raw = bodies[0] ? await bodies[0] : "";
    let parsed: Record<string, unknown> | null = null;
    try { parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : null; } catch { parsed = null; }
    return { url: urls[0] ?? "", body: parsed };
  }

  test("omitted store reaches the upstream Responses request as false", async () => {
    const { url, body } = await drive(undefined);
    expect(url).toContain("/responses");
    expect(body).not.toBeNull();
    expect((body as Record<string, unknown>).store).toBe(false);
  });

  test("explicit store:true is preserved, never overridden", async () => {
    const { body } = await drive(true);
    expect(body).not.toBeNull();
    expect((body as Record<string, unknown>).store).toBe(true);
  });

  test("explicit store:false is preserved unchanged", async () => {
    const { body } = await drive(false);
    expect(body).not.toBeNull();
    expect((body as Record<string, unknown>).store).toBe(false);
  });
});
