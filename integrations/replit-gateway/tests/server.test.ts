import { describe, expect, test } from "bun:test";
import { createGatewayServer } from "../src/server/create-server";
import { loadGatewayConfigFromEnv } from "../src/config";

const VALID_ENV = {
  REPLIT_GATEWAY_KEY: "gateway-key-01234567890123456789012",
  REPLIT_GATEWAY_PUBLIC_ORIGIN: "https://my-app.replit.app",
  REPLIT_GATEWAY_OPENAI_MODELS: "gpt-4o",
  REPLIT_GATEWAY_ANTHROPIC_MODELS: "claude-sonnet-4-6",
  AI_INTEGRATIONS_OPENAI_BASE_URL: "https://integrations.replit.com/openai/v1",
  AI_INTEGRATIONS_OPENAI_API_KEY: "replit-openai-secret",
  AI_INTEGRATIONS_ANTHROPIC_BASE_URL: "https://integrations.replit.com/anthropic",
  AI_INTEGRATIONS_ANTHROPIC_API_KEY: "replit-anthropic-secret",
};

describe("createGatewayServer", () => {
  test("rejects unauthenticated requests before relay routes", async () => {
    const server = createGatewayServer(loadGatewayConfigFromEnv(VALID_ENV));
    const res = await server.fetch(new Request("https://gateway.test/v1/models"));
    expect(res.status).toBe(401);
    await server.stop();
  });

  test("does not expose integration secrets in error responses", async () => {
    const server = createGatewayServer(loadGatewayConfigFromEnv(VALID_ENV));
    const res = await server.fetch(new Request("https://gateway.test/v1/models", {
      headers: { Authorization: "Bearer wrong" },
    }));
    const body = await res.text();
    expect(body).not.toContain("replit-openai-secret");
    expect(body).not.toContain("replit-anthropic-secret");
    await server.stop();
  });

  test("returns upstream_error when relay upstream is unreachable", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (..._args: Parameters<typeof fetch>) => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    try {
      const server = createGatewayServer(loadGatewayConfigFromEnv(VALID_ENV));
      const res = await server.fetch(new Request("https://gateway.test/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${VALID_ENV.REPLIT_GATEWAY_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "gpt-4o", messages: [] }),
      }));
      expect(res.status).toBe(502);
      const body = await res.text();
      expect(body).toContain("upstream_error");
      await server.stop();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects disallowed models before an injected relay runs", async () => {
    let relayCalled = false;
    const server = createGatewayServer(loadGatewayConfigFromEnv(VALID_ENV), {
      openAiRelay: {
        async handleChatCompletions() {
          relayCalled = true;
          return Response.json({ ok: true });
        },
      },
    });
    const res = await server.fetch(new Request("https://gateway.test/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${VALID_ENV.REPLIT_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "gpt-4.1", messages: [] }),
    }));
    expect(res.status).toBe(400);
    expect(relayCalled).toBe(false);
    await server.stop();
  });

  test("returns a safe classified response when an injected relay throws", async () => {
    const server = createGatewayServer(loadGatewayConfigFromEnv(VALID_ENV), {
      openAiRelay: {
        async handleChatCompletions() {
          throw new Error("upstream diagnostic AI_INTEGRATIONS_OPENAI_API_KEY=secret");
        },
      },
    });
    const res = await server.fetch(new Request("https://gateway.test/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${VALID_ENV.REPLIT_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "gpt-4o", messages: [] }),
    }));
    expect(res.status).toBe(502);
    const body = await res.text();
    expect(body).toContain("upstream_error");
    expect(body).not.toContain("AI_INTEGRATIONS_OPENAI_API_KEY");
    await server.stop();
  });

  test("passes a linked upstream signal to injected relays", async () => {
    let observedAborted = false;
    let relayReady: (() => void) | undefined;
    const relayStarted = new Promise<void>((resolve) => {
      relayReady = resolve;
    });
    const server = createGatewayServer(loadGatewayConfigFromEnv(VALID_ENV), {
      openAiRelay: {
        async handleChatCompletions(_request, context) {
          if (context.upstreamSignal.aborted) {
            observedAborted = true;
          } else {
            context.upstreamSignal.addEventListener("abort", () => {
              observedAborted = true;
            }, { once: true });
          }
          relayReady?.();
          await new Promise((resolve) => setTimeout(resolve, 50));
          return Response.json({ ok: true });
        },
      },
    });
    const controller = new AbortController();
    const req = new Request("https://gateway.test/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${VALID_ENV.REPLIT_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "gpt-4o", messages: [] }),
    });
    const pending = server.fetch(req);
    await relayStarted;
    controller.abort();
    await pending;
    expect(observedAborted).toBe(true);
    await server.stop();
  });

  test("does not forward gateway Authorization to injected relays", async () => {
    let seenAuth: string | null = "unset";
    const server = createGatewayServer(loadGatewayConfigFromEnv(VALID_ENV), {
      openAiRelay: {
        async handleChatCompletions(request) {
          seenAuth = request.headers.get("Authorization");
          return Response.json({ ok: true });
        },
      },
    });
    const res = await server.fetch(new Request("https://gateway.test/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${VALID_ENV.REPLIT_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "gpt-4o", messages: [] }),
    }));
    expect(res.status).toBe(200);
    expect(seenAuth).toBeNull();
    await server.stop();
  });

  test("returns a safe classified response when body reading fails", async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("reader exploded"));
      },
    });
    const server = createGatewayServer(loadGatewayConfigFromEnv(VALID_ENV));
    const res = await server.fetch(new Request("https://gateway.test/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${VALID_ENV.REPLIT_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: stream,
      duplex: "half",
    } as RequestInit));
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).toContain("internal");
    await server.stop();
  });

  test("classifies client deadline expiry as client_timeout", async () => {
    const server = createGatewayServer(loadGatewayConfigFromEnv({
      ...VALID_ENV,
      REPLIT_GATEWAY_CLIENT_TIMEOUT_MS: "1000",
      REPLIT_GATEWAY_UPSTREAM_TIMEOUT_MS: "1000",
    }), {
      openAiRelay: {
        async handleChatCompletions() {
          await new Promise((resolve) => setTimeout(resolve, 1100));
          return Response.json({ ok: true });
        },
      },
    });
    const res = await server.fetch(new Request("https://gateway.test/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${VALID_ENV.REPLIT_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "gpt-4o", messages: [] }),
    }));
    expect(res.status).toBe(408);
    const body = await res.json();
    expect(body.error.type).toBe("client_timeout");
    await server.stop();
  });
});
