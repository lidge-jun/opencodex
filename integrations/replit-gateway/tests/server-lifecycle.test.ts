import { afterEach, describe, expect, test } from "bun:test";
import { createGatewayServer } from "../src/server/create-server";
import { loadGatewayConfigFromEnv } from "../src/config";
import { installUpstreamFixture, type UpstreamFixture } from "./helpers/upstream-fixture";

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

describe("server response lifecycle", () => {
  let fixture: UpstreamFixture | undefined;

  afterEach(() => {
    fixture?.restoreFetch();
    fixture?.server.stop(true);
    fixture = undefined;
  });

  test("aborts upstream after headers when client cancels body consumption", async () => {
    let upstreamAborted = false;
    fixture = installUpstreamFixture("integrations.replit.com", () => {
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(new TextEncoder().encode("data: {}\n\n"));
          await new Promise((resolve) => setTimeout(resolve, 500));
          if (!upstreamAborted) controller.enqueue(new TextEncoder().encode("data: {}\n\n"));
          controller.close();
        },
        cancel() {
          upstreamAborted = true;
        },
      });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
    });

    const server = createGatewayServer(loadGatewayConfigFromEnv(VALID_ENV));
    const controller = new AbortController();
    const pending = server.fetch(new Request("https://gateway.test/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${VALID_ENV.REPLIT_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "gpt-4o", messages: [], stream: true }),
    }));

    const res = await pending;
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    await reader.read();
    controller.abort();
    await reader.cancel();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(upstreamAborted).toBe(true);
    await server.stop();
  });

  test("holds concurrency slot until response body finishes", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    fixture = installUpstreamFixture("integrations.replit.com", () => {
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          releaseFirst?.();
          controller.enqueue(new TextEncoder().encode("data: hold\n\n"));
          await new Promise((resolve) => setTimeout(resolve, 200));
          controller.close();
        },
      });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
    });

    const server = createGatewayServer(loadGatewayConfigFromEnv({
      ...VALID_ENV,
      REPLIT_GATEWAY_MAX_CONCURRENT: "1",
    }));

    const first = server.fetch(new Request("https://gateway.test/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${VALID_ENV.REPLIT_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "gpt-4o", messages: [], stream: true }),
    }));

    await firstStarted;
    const second = await server.fetch(new Request("https://gateway.test/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${VALID_ENV.REPLIT_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "gpt-4o", messages: [], stream: true }),
    }));
    expect(second.status).toBe(429);

    const firstRes = await first;
    const reader = firstRes.body!.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }

    const third = await server.fetch(new Request("https://gateway.test/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${VALID_ENV.REPLIT_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "gpt-4o", messages: [], stream: true }),
    }));
    expect(third.status).toBe(200);
    await third.body?.cancel();
    await server.stop();
  });
});
