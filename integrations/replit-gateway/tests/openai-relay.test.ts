import { afterEach, describe, expect, test } from "bun:test";
import { createOpenAiRelay } from "../src/relay/openai-relay";
import { createRelayExecutionContext } from "../src/request-context";
import { createTestGatewayConfig, TEST_GATEWAY_KEY } from "./helpers/test-config";
import {
  chunkedSseResponse,
  installUpstreamFixture,
  type UpstreamFixture,
} from "./helpers/upstream-fixture";

describe("createOpenAiRelay", () => {
  let fixture: UpstreamFixture | undefined;

  afterEach(() => {
    fixture?.restoreFetch();
    fixture?.server.stop(true);
    fixture = undefined;
  });

  function relayContext(clientSignal?: AbortSignal) {
    const execution = createRelayExecutionContext({
      clientSignal: clientSignal ?? new AbortController().signal,
      clientTimeoutMs: 310_000,
      upstreamTimeoutMs: 300_000,
    });
    return {
      context: {
        requestId: "test-request-id",
        clientSignal: execution.clientSignal,
        upstreamSignal: execution.upstreamSignal,
        callerAborted: execution.callerAborted,
        clientTimedOut: execution.clientTimedOut,
        upstreamTimedOut: execution.upstreamTimedOut,
        config: createTestGatewayConfig(),
      },
      cleanup: execution.cleanup,
    };
  }

  test("relays non-streaming chat completions with upstream credentials only", async () => {
    fixture = installUpstreamFixture("integrations.replit.com", (_req, captured) => {
      expect(captured.headers.get("Authorization")).toBe("Bearer replit-openai-secret");
      expect(captured.headers.get("Authorization")).not.toContain(TEST_GATEWAY_KEY);
      return Response.json({ id: "chatcmpl-test", object: "chat.completion" });
    });

    const relay = createOpenAiRelay();
    const { context, cleanup } = relayContext();
    const handoff = new Request("https://gateway.test/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    });

    const res = await relay.handleChatCompletions(handoff, context);
    cleanup();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe("chatcmpl-test");
    expect(fixture.captured[0]?.path).toBe("/openai/v1/chat/completions");
  });

  test("preserves fragmented SSE framing byte-for-byte", async () => {
    const chunks = [
      "data: {\"choices\":[{\"delta\":{\"content\":\"hel\"}}]}\n\n",
      "data: {\"choices\":[{\"delta\":{\"content\":\"lo\"}}]}\n\n",
      "data: [DONE]\n\n",
    ];
    fixture = installUpstreamFixture("integrations.replit.com", () =>
      chunkedSseResponse(chunks),
    );

    const relay = createOpenAiRelay();
    const { context, cleanup } = relayContext();
    const handoff = new Request("https://gateway.test/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o", messages: [], stream: true }),
    });

    const res = await relay.handleChatCompletions(handoff, context);
    cleanup();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toBe(chunks.join(""));
  });

  test("forwards upstream status and Retry-After on cold-start 503", async () => {
    fixture = installUpstreamFixture("integrations.replit.com", () =>
      new Response("cold start", {
        status: 503,
        headers: { "Retry-After": "30", "Content-Type": "application/json" },
      }),
    );

    const relay = createOpenAiRelay();
    const { context, cleanup } = relayContext();
    const handoff = new Request("https://gateway.test/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o", messages: [] }),
    });

    const res = await relay.handleChatCompletions(handoff, context);
    cleanup();
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("30");
    expect(await res.text()).toBe("cold start");
  });

  test("rejects upstream redirects without retrying", async () => {
    fixture = installUpstreamFixture("integrations.replit.com", () =>
      new Response(null, {
        status: 302,
        headers: { Location: "https://evil.test/steal" },
      }),
    );

    const relay = createOpenAiRelay();
    const { context, cleanup } = relayContext();
    const handoff = new Request("https://gateway.test/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o", messages: [] }),
    });

    await expect(relay.handleChatCompletions(handoff, context)).rejects.toThrow(/redirect_rejected/);
    cleanup();
    expect(fixture.captured.length).toBe(1);
  });

  test("aborts upstream when the client disconnects during streaming", async () => {
    let upstreamAborted = false;
    fixture = installUpstreamFixture("integrations.replit.com", () => {
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(new TextEncoder().encode("data: {}\n\n"));
          await new Promise((resolve) => setTimeout(resolve, 200));
          if (!upstreamAborted) controller.enqueue(new TextEncoder().encode("data: {}\n\n"));
          controller.close();
        },
        cancel() {
          upstreamAborted = true;
        },
      });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
    });

    const client = new AbortController();
    const relay = createOpenAiRelay();
    const { context, cleanup } = relayContext(client.signal);
    const handoff = new Request("https://gateway.test/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o", messages: [], stream: true }),
    });

    const res = await relay.handleChatCompletions(handoff, context);
    const reader = res.body?.getReader();
    await reader?.read();
    client.abort();
    await reader?.cancel();
    cleanup();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(upstreamAborted).toBe(true);
  });

  test("closes client stream cleanly when upstream truncates mid-stream", async () => {
    fixture = installUpstreamFixture("integrations.replit.com", () =>
      chunkedSseResponse(["data: {\"ok\":true}\n\n"]),
    );

    const relay = createOpenAiRelay();
    const { context, cleanup } = relayContext();
    const handoff = new Request("https://gateway.test/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o", messages: [], stream: true }),
    });

    const res = await relay.handleChatCompletions(handoff, context);
    const reader = res.body?.getReader();
    const chunks: string[] = [];
    while (true) {
      const { done, value } = await reader!.read();
      if (done) break;
      if (value) chunks.push(new TextDecoder().decode(value));
    }
    cleanup();
    expect(chunks.join("")).toBe("data: {\"ok\":true}\n\n");
  });
});
