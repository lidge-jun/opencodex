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
});
