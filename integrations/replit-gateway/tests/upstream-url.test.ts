import { describe, expect, test } from "bun:test";
import { joinUpstreamEndpoint, validateUpstreamBaseUrl } from "../src/origin";
import { createOpenAiRelay } from "../src/relay/openai-relay";
import { createAnthropicRelay } from "../src/relay/anthropic-relay";
import { createRelayExecutionContext } from "../src/request-context";
import { createTestGatewayConfig } from "./helpers/test-config";
import { installUpstreamFixture, type UpstreamFixture } from "./helpers/upstream-fixture";

describe("upstream URL joining", () => {
  test("rejects query strings and fragments in base URLs", () => {
    expect(() => validateUpstreamBaseUrl("https://host/openai/v1?tenant=a")).toThrow(/query/i);
    expect(() => validateUpstreamBaseUrl("https://host/openai/v1#frag")).toThrow(/hash/i);
  });

  test("normalizes all trailing slashes", () => {
    expect(validateUpstreamBaseUrl("https://host/openai/v1/")).toBe("https://host/openai/v1");
    expect(validateUpstreamBaseUrl("https://host/openai/v1///")).toBe("https://host/openai/v1");
    expect(validateUpstreamBaseUrl("https://host/openai/v1")).toBe("https://host/openai/v1");
  });

  test("joinUpstreamEndpoint appends native paths safely", () => {
    expect(joinUpstreamEndpoint("https://host/openai/v1", "/chat/completions")).toBe(
      "https://host/openai/v1/chat/completions",
    );
    expect(joinUpstreamEndpoint("https://host/openai/v1///", "/chat/completions")).toBe(
      "https://host/openai/v1/chat/completions",
    );
  });
});

describe("relay upstream URL construction", () => {
  let fixture: UpstreamFixture | undefined;

  test("OpenAI relay requests the joined chat completions path", async () => {
    fixture = installUpstreamFixture("host.test", (_req, captured) => {
      expect(captured.path).toBe("/openai/v1/chat/completions");
      return Response.json({ ok: true });
    });

    const execution = createRelayExecutionContext({
      clientSignal: new AbortController().signal,
      clientTimeoutMs: 60_000,
      upstreamTimeoutMs: 60_000,
    });

    const relay = createOpenAiRelay();
    const config = createTestGatewayConfig({ openaiBaseUrl: "https://host.test/openai/v1///" });
    const handoff = new Request("https://gateway.test/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"model":"gpt-4o","messages":[]}',
    });

    await relay.handleChatCompletions(handoff, {
      requestId: "id",
      clientSignal: execution.clientSignal,
      upstreamSignal: execution.upstreamSignal,
      callerAborted: execution.callerAborted,
      clientTimedOut: execution.clientTimedOut,
      upstreamTimedOut: execution.upstreamTimedOut,
      config,
    });
    execution.cleanup();
    fixture.restoreFetch();
    fixture.server.stop(true);
  });

  test("Anthropic relay requests the joined messages path", async () => {
    fixture = installUpstreamFixture("host.test", (_req, captured) => {
      expect(captured.path).toBe("/anthropic/messages");
      return Response.json({ ok: true });
    });

    const execution = createRelayExecutionContext({
      clientSignal: new AbortController().signal,
      clientTimeoutMs: 60_000,
      upstreamTimeoutMs: 60_000,
    });

    const relay = createAnthropicRelay();
    const config = createTestGatewayConfig({ anthropicBaseUrl: "https://host.test/anthropic/" });
    const handoff = new Request("https://gateway.test/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"model":"claude-sonnet-4-6","max_tokens":1,"messages":[]}',
    });

    await relay.handleMessages(handoff, {
      requestId: "id",
      clientSignal: execution.clientSignal,
      upstreamSignal: execution.upstreamSignal,
      callerAborted: execution.callerAborted,
      clientTimedOut: execution.clientTimedOut,
      upstreamTimedOut: execution.upstreamTimedOut,
      config,
    });
    execution.cleanup();
    fixture.restoreFetch();
    fixture.server.stop(true);
  });
});
