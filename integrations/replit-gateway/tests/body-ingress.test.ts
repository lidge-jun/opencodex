import { describe, expect, test } from "bun:test";
import { readBoundedBody } from "../src/body";
import { createRelayExecutionContext } from "../src/request-context";
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

describe("request-body ingress lifecycle", () => {
  test("cancels body reader when client aborts during ingress", async () => {
    let readerCancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        controller.enqueue(new TextEncoder().encode('{"model":"gpt-4o","messages":'));
        await new Promise((resolve) => setTimeout(resolve, 200));
        controller.enqueue(new TextEncoder().encode("[]}"));
        controller.close();
      },
      cancel() {
        readerCancelled = true;
      },
    });

    const client = new AbortController();
    const req = new Request("https://gateway.test/v1/chat/completions", {
      method: "POST",
      signal: client.signal,
      headers: { "content-type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit);

    const execution = createRelayExecutionContext({
      clientSignal: client.signal,
      clientTimeoutMs: 60_000,
      upstreamTimeoutMs: 60_000,
    });

    const pending = readBoundedBody(req, 4096, {
      signal: execution.clientSignal,
      callerAborted: execution.callerAborted,
      clientTimedOut: execution.clientTimedOut,
    });

    await new Promise((resolve) => setTimeout(resolve, 120));
    client.abort();
    const result = await pending;
    execution.cleanup();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.category).toBe("client_aborted");
    expect(readerCancelled).toBe(true);
  });

  test("classifies client deadline during slow ingress as client_timeout", async () => {
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        controller.enqueue(new TextEncoder().encode('{"model":"gpt-4o"}'));
        controller.close();
      },
    });

    const req = new Request("https://gateway.test/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit);

    const execution = createRelayExecutionContext({
      clientSignal: new AbortController().signal,
      clientTimeoutMs: 50,
      upstreamTimeoutMs: 50,
    });

    const result = await readBoundedBody(req, 4096, {
      signal: execution.clientSignal,
      callerAborted: execution.callerAborted,
      clientTimedOut: execution.clientTimedOut,
    });
    execution.cleanup();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.category).toBe("client_timeout");
  });

  test("server classifies client abort during ingress as client_aborted", async () => {
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        controller.enqueue(new TextEncoder().encode('{"model":"gpt-4o","messages":[]}'));
        controller.close();
      },
    });

    const client = new AbortController();
    const server = createGatewayServer(loadGatewayConfigFromEnv(VALID_ENV));
    const pending = server.fetch(new Request("https://gateway.test/v1/chat/completions", {
      method: "POST",
      signal: client.signal,
      headers: {
        Authorization: `Bearer ${VALID_ENV.REPLIT_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: stream,
      duplex: "half",
    } as RequestInit));

    await new Promise((resolve) => setTimeout(resolve, 50));
    client.abort();
    const res = await pending;
    expect(res.status).toBe(499);
    await server.stop();
  });
});
