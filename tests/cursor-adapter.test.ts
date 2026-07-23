import { describe, expect, test } from "bun:test";
import {
  createCursorAdapter,
  cursorExecDeniedMessage,
} from "../src/adapters/cursor";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../src/types";
import type { CursorClientMessage, CursorRunRequest, CursorServerMessage } from "../src/adapters/cursor/types";

const provider: OcxProviderConfig = {
  adapter: "cursor",
  baseUrl: "https://api2.cursor.sh",
};

const parsed: OcxParsedRequest = {
  modelId: "cursor/auto",
  context: { messages: [] },
  stream: false,
  options: {},
};

async function collect(gen: AsyncGenerator<AdapterEvent>): Promise<AdapterEvent[]> {
  const events: AdapterEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

describe("Cursor adapter live transport", () => {
  test("runTurn emits a missing-token error before live network", async () => {
    const adapter = createCursorAdapter(provider);
    const events: AdapterEvent[] = [];

    await adapter.runTurn?.(parsed, { headers: new Headers() }, event => events.push(event));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "error",
      message: expect.stringContaining("no Cursor access token is configured"),
    });
  });

  test("pre-aborted runTurn emits an abort error", async () => {
    const adapter = createCursorAdapter(provider);
    const events: AdapterEvent[] = [];
    const abort = new AbortController();
    abort.abort("test");

    await adapter.runTurn?.(parsed, { headers: new Headers(), abortSignal: abort.signal }, event => events.push(event));

    expect(events).toEqual([{ type: "error", message: "Cursor turn was aborted before start." }]);
  });

  test("runTurn maps mocked Cursor transport messages into AdapterEvents", async () => {
    const requests: CursorRunRequest[] = [];
    const writes: CursorClientMessage[] = [];
    const adapter = createCursorAdapter(provider, {
      createTransport: () => ({
        async *run(request) {
          requests.push(request);
          yield { type: "thinking", thinking: "검토 중" } satisfies CursorServerMessage;
          yield { type: "text", text: "안녕하세요" } satisfies CursorServerMessage;
          yield { type: "done", usage: { inputTokens: 3, outputTokens: 5 } } satisfies CursorServerMessage;
        },
        writeClient(message) {
          writes.push(message);
        },
      }),
    });
    const events: AdapterEvent[] = [];

    await adapter.runTurn?.(
      { ...parsed, modelId: "cursor/auto", context: { messages: [{ role: "user", content: "hi", timestamp: 1 }] } },
      { headers: new Headers() },
      event => events.push(event),
    );

    expect(requests[0]?.modelId).toBe("default");
    expect(requests[0]?.routingLevel).toBeUndefined();
    expect(writes).toEqual([]);
    expect(events).toEqual([
      { type: "thinking_delta", thinking: "검토 중" },
      { type: "text_delta", text: "안녕하세요" },
      { type: "done", usage: { inputTokens: 3, outputTokens: 5 } },
    ]);
  });

  test("runTurn preserves explicit Cursor Router optimization levels", async () => {
    const requests: CursorRunRequest[] = [];
    const adapter = createCursorAdapter(provider, {
      createTransport: () => ({
        async *run(request) {
          requests.push(request);
          yield { type: "done" } satisfies CursorServerMessage;
        },
        writeClient() {},
      }),
    });

    await adapter.runTurn?.(
      { ...parsed, modelId: "cursor/auto-intelligence" },
      { headers: new Headers() },
      () => {},
    );

    expect(requests[0]).toMatchObject({ modelId: "default", routingLevel: "intelligence" });
  });

  test("runTurn sanitizes unexpected transport errors", async () => {
    const adapter = createCursorAdapter(provider, {
      createTransport: () => ({
        async *run() {
          throw new Error("gRPC error 16: Bearer secret-token-123 authorization=secret-token-123");
        },
        writeClient() {},
      }),
    });
    const events: AdapterEvent[] = [];

    await adapter.runTurn?.(parsed, { headers: new Headers() }, event => events.push(event));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "error",
      message: expect.stringContaining("gRPC error 16: Bearer [REDACTED] authorization=[REDACTED]"),
    });
    expect(JSON.stringify(events).includes("secret-token-123")).toBe(false);
  });

  test("parseStream reports that the fetch path is disabled", async () => {
    const adapter = createCursorAdapter(provider);

    expect(await collect(adapter.parseStream(new Response()))).toEqual([
      {
        type: "error",
        message: "Cursor adapter uses runTurn; the fetch/parseStream path is disabled.",
      },
    ]);
  });

  test("legacy mock exec message names the unavailable case", () => {
    expect(cursorExecDeniedMessage("shellArgs")).toContain("shellArgs");
    expect(cursorExecDeniedMessage("shellArgs")).toContain("legacy mock transport cannot execute");
  });

  test("retries external-model invalid_argument once with a fresh conversation id", async () => {
    const seen: string[] = [];
    let attempts = 0;
    const adapter = createCursorAdapter({
      ...provider,
      apiKey: "cursor-token",
    }, {
      createTransport: () => ({
        async *run(request) {
          attempts += 1;
          seen.push(request.conversationId);
          if (attempts === 1) {
            throw Object.assign(
              new Error("Cursor invalid request: Cursor Connect error invalid_argument: Error"),
              { code: "invalid_argument" },
            );
          }
          yield { type: "done" } satisfies CursorServerMessage;
        },
        writeClient() {},
      }),
    });

    const events: AdapterEvent[] = [];
    const body: OcxParsedRequest = {
      modelId: "cursor/gpt-5.6-sol",
      context: {
        messages: [
          { role: "user", content: "read a file", timestamp: 1 },
          {
            role: "assistant",
            model: "cursor/gpt-5.6-sol",
            timestamp: 2,
            content: [{ type: "toolCall", id: "call_1", name: "read_file", namespace: "mcp__fs", arguments: { path: "a.txt" } }],
          },
          {
            role: "toolResult",
            toolCallId: "call_1",
            toolName: "read_file",
            toolNamespace: "mcp__fs",
            content: "FILE CONTENTS HERE",
            isError: false,
            timestamp: 3,
          },
        ],
      },
      stream: false,
      options: { reasoning: "xhigh" },
      _cursorConversationId: "cursor_corrupt",
    };

    await adapter.runTurn?.(body, { headers: new Headers() }, event => events.push(event));

    expect(attempts).toBe(2);
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe("cursor_corrupt");
    expect(seen[1]).not.toBe(seen[0]);
    expect(body._cursorConversationId).toBe(seen[1]);
    expect(events.filter(event => event.type === "error")).toHaveLength(0);
  });

  test("rotation rekeys context usage through the injectable seam", async () => {
    const rekeyCalls: Array<[string, string]> = [];
    const seen: string[] = [];
    const adapter = createCursorAdapter({
      ...provider,
      apiKey: "cursor-token",
    }, {
      createTransport: () => ({
        async *run(request) {
          seen.push(request.conversationId);
          yield { type: "done" } satisfies CursorServerMessage;
        },
        writeClient() {},
      }),
      rekeyContextUsage: (from, to) => rekeyCalls.push([from, to]),
    });

    const body: OcxParsedRequest = {
      modelId: "cursor/gpt-5.6-sol",
      context: {
        messages: [
          { role: "user", content: "read a file", timestamp: 1 },
          {
            role: "assistant",
            model: "cursor/gpt-5.6-sol",
            timestamp: 2,
            content: [{ type: "toolCall", id: "call_1", name: "read_file", namespace: "mcp__fs", arguments: { path: "a.txt" } }],
          },
          {
            role: "toolResult",
            toolCallId: "call_1",
            toolName: "read_file",
            toolNamespace: "mcp__fs",
            content: "FILE CONTENTS HERE",
            isError: false,
            timestamp: 3,
          },
        ],
      },
      stream: false,
      options: {},
      _cursorConversationId: "cursor_prior",
    };

    const events: AdapterEvent[] = [];
    await adapter.runTurn?.(body, { headers: new Headers() }, event => events.push(event));

    // External-model toolResult continuation rotates the conversation id and the
    // adapter must rekey the carry-forward context usage onto the new id.
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toBe("cursor_prior");
    expect(rekeyCalls).toEqual([["cursor_prior", seen[0]!]]);
    expect(body._cursorConversationId).toBe(seen[0]);
  });
});

  test("does not replay invalid_argument after non-heartbeat output was already emitted", async () => {
    let attempts = 0;
    const adapter = createCursorAdapter({
      ...provider,
      apiKey: "cursor-token",
    }, {
      createTransport: () => ({
        async *run() {
          attempts += 1;
          yield { type: "text", text: "partial output" } satisfies CursorServerMessage;
          throw Object.assign(
            new Error("Cursor invalid request: Cursor Connect error invalid_argument: Error"),
            { code: "invalid_argument" },
          );
        },
        writeClient() {},
      }),
    });

    const events: AdapterEvent[] = [];
    const body: OcxParsedRequest = {
      modelId: "cursor/gpt-5.6-sol",
      context: {
        messages: [
          { role: "user", content: "read a file", timestamp: 1 },
          {
            role: "assistant",
            model: "cursor/gpt-5.6-sol",
            timestamp: 2,
            content: [{ type: "toolCall", id: "call_1", name: "read_file", namespace: "mcp__fs", arguments: { path: "a.txt" } }],
          },
          {
            role: "toolResult",
            toolCallId: "call_1",
            toolName: "read_file",
            toolNamespace: "mcp__fs",
            content: "FILE CONTENTS HERE",
            isError: false,
            timestamp: 3,
          },
        ],
      },
      stream: false,
      options: { reasoning: "xhigh" },
      _cursorConversationId: "cursor_corrupt",
    };

    await adapter.runTurn?.(body, { headers: new Headers() }, event => events.push(event));

    expect(attempts).toBe(1);
    expect(events.some(event => event.type === "text_delta")).toBe(true);
    expect(events.some(event => event.type === "error")).toBe(true);
  });
