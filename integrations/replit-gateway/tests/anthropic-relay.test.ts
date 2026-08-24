import { afterEach, describe, expect, test } from "bun:test";
import { createAnthropicRelay } from "../src/relay/anthropic-relay";
import { createRelayExecutionContext } from "../src/request-context";
import { createTestGatewayConfig } from "./helpers/test-config";
import {
  chunkedSseResponse,
  installUpstreamFixture,
  type UpstreamFixture,
} from "./helpers/upstream-fixture";

describe("createAnthropicRelay", () => {
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

  test("relays messages with managed x-api-key only", async () => {
    fixture = installUpstreamFixture("integrations.replit.com", (_req, captured) => {
      expect(captured.headers.get("x-api-key")).toBe("replit-anthropic-secret");
      expect(captured.headers.get("Authorization")).toBeNull();
      expect(captured.headers.get("authorization")).toBeNull();
      expect(captured.headers.get("Authorization")).toBeNull();
      return Response.json({ id: "msg_test", type: "message" });
    });

    const relay = createAnthropicRelay();
    const { context, cleanup } = relayContext();
    const handoff = new Request("https://gateway.test/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 16, messages: [] }),
    });

    const res = await relay.handleMessages(handoff, context);
    cleanup();
    expect(res.status).toBe(200);
    expect(fixture.captured[0]?.path).toBe("/anthropic/messages");
  });

  test("preserves tool-call fragments and thinking events in order", async () => {
    const frames = [
      `event: content_block_start\ndata: ${JSON.stringify({
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "" },
      })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "rea" },
      })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "lly" },
      })}\n\n`,
      `event: content_block_stop\ndata: ${JSON.stringify({
        type: "content_block_stop",
        index: 0,
      })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "toolu_1", name: "bash", input: {} },
      })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: "{\"cmd\":\"" },
      })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: "ls\"}" },
      })}\n\n`,
      `event: content_block_stop\ndata: ${JSON.stringify({
        type: "content_block_stop",
        index: 1,
      })}\n\n`,
      `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
    ];

    fixture = installUpstreamFixture("integrations.replit.com", () =>
      chunkedSseResponse(frames),
    );

    const relay = createAnthropicRelay();
    const { context, cleanup } = relayContext();
    const handoff = new Request("https://gateway.test/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-beta": "interleaved-thinking-2025-05-14",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 16,
        stream: true,
        messages: [{ role: "user", content: "think and run" }],
      }),
    });

    const res = await relay.handleMessages(handoff, context);
    cleanup();
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe(frames.join(""));
    expect(text).toContain("thinking_delta");
    expect(text).toContain("input_json_delta");
    expect(fixture.captured[0]?.headers.get("anthropic-beta")).toBe(
      "interleaved-thinking-2025-05-14",
    );
  });

  test("forwards upstream failure status after headers are sent", async () => {
    fixture = installUpstreamFixture("integrations.replit.com", () =>
      new Response("rate limited", {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "12" },
      }),
    );

    const relay = createAnthropicRelay();
    const { context, cleanup } = relayContext();
    const handoff = new Request("https://gateway.test/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 16, messages: [] }),
    });

    const res = await relay.handleMessages(handoff, context);
    cleanup();
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("12");
    expect(await res.text()).toBe("rate limited");
  });

  test("rejects upstream redirects without retrying", async () => {
    fixture = installUpstreamFixture("integrations.replit.com", () =>
      new Response(null, {
        status: 307,
        headers: { Location: "https://evil.test/steal" },
      }),
    );

    const relay = createAnthropicRelay();
    const { context, cleanup } = relayContext();
    const handoff = new Request("https://gateway.test/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 16, messages: [] }),
    });

    await expect(relay.handleMessages(handoff, context)).rejects.toThrow(/redirect_rejected/);
    cleanup();
    expect(fixture.captured.length).toBe(1);
  });
});
