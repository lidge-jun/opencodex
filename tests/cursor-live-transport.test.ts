import { describe, expect, test } from "bun:test";
import { createLiveCursorTransport, CursorMissingCredentialError, finalizeAfterDrain, parseConnectEndStreamError, resolveCursorToken } from "../src/adapters/cursor/live-transport";
import type { CursorProtobufEventState } from "../src/adapters/cursor/protobuf-events";
import type { CursorServerMessage } from "../src/adapters/cursor/types";

describe("Cursor live transport", () => {
  test("fails before network when no Cursor credential is configured", () => {
    const prev = process.env.OPENCODEX_CURSOR_TEST_TOKEN;
    delete process.env.OPENCODEX_CURSOR_TEST_TOKEN;
    try {
      expect(() => createLiveCursorTransport({
        provider: { adapter: "cursor", baseUrl: "https://api2.cursor.sh" },
        headers: new Headers(),
      })).toThrow(CursorMissingCredentialError);
    } finally {
      if (prev === undefined) delete process.env.OPENCODEX_CURSOR_TEST_TOKEN;
      else process.env.OPENCODEX_CURSOR_TEST_TOKEN = prev;
    }
  });

  test("accepts provider apiKey without exposing it", () => {
    const transport = createLiveCursorTransport({
      provider: { adapter: "cursor", baseUrl: "https://api2.cursor.sh", apiKey: "secret-cursor-token" },
      headers: new Headers(),
    });

    expect(transport).toHaveProperty("run");
    expect(JSON.stringify(transport)).not.toContain("secret-cursor-token");
    transport.close?.();
  });

  test("seeds early-finalize usage from the request fallback before opening the wire", async () => {
    const transport = createLiveCursorTransport({
      provider: { adapter: "cursor", baseUrl: "https://api2.cursor.sh", apiKey: "test-token" },
      headers: new Headers(),
    });
    const internals = transport as unknown as {
      open(
        request: unknown,
        signal: AbortSignal | undefined,
        state: CursorProtobufEventState,
        push: (event: CursorServerMessage) => void,
        fail: (error: Error) => void,
        finish: () => void,
      ): void;
    };
    internals.open = (_request, _signal, state, push, _fail, finish) => {
      state.usage.outputTokens = 42;
      for (const event of finalizeAfterDrain(state)) push(event);
      finish();
    };

    const events: CursorServerMessage[] = [];
    for await (const event of transport.run({
      modelId: "grok-4.5",
      conversationId: "cursor-context-fallback",
      system: [],
      messages: [{ role: "user", content: "use a tool" }],
      fallbackInputTokens: 120_000,
    })) events.push(event);

    expect(events).toEqual([
      { type: "done", usage: { inputTokens: 120_000, outputTokens: 42, totalTokens: 120_042, estimated: true } },
    ]);
    await transport.close?.();
  });

  test("fails the turn when MCP preparation rejects", async () => {
    const transport = createLiveCursorTransport({
      provider: { adapter: "cursor", baseUrl: "https://api2.cursor.sh", apiKey: "test-token" },
      headers: new Headers(),
    });
    const internals = transport as unknown as {
      mcpManager?: {
        listToolHandles(): Promise<never>;
        dispose(): Promise<void>;
      };
    };
    internals.mcpManager = {
      listToolHandles: () => Promise.reject(new Error("fixture discovery failed")),
      dispose: () => Promise.resolve(),
    };

    const iterator = transport.run({
      modelId: "auto",
      conversationId: "mcp-preparation-failure",
      system: [],
      messages: [{ role: "user", content: "hello" }],
    })[Symbol.asyncIterator]();

    await expect(iterator.next()).rejects.toThrow("Cursor MCP preparation failed: fixture discovery failed");
    await transport.close?.();
  });
});

describe("Cursor end-stream classification", () => {
  const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

  test("empty success object resolves (no error)", () => {
    expect(parseConnectEndStreamError(enc("{}"))).toBeNull();
  });

  test("success trailer with metadata but no error resolves", () => {
    expect(parseConnectEndStreamError(enc('{"metadata":{"a":["b"]}}'))).toBeNull();
  });

  test("error trailer surfaces a Connect error", () => {
    const err = parseConnectEndStreamError(enc('{"error":{"code":"unauthenticated","message":"bad token"}}'));
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toContain("unauthenticated");
    expect(err?.message).toContain("bad token");
  });

  test("malformed payload is treated as an error, not a silent success", () => {
    expect(parseConnectEndStreamError(enc("not json"))).toBeInstanceOf(Error);
  });
});

describe("Cursor token precedence (R2 gap-close guard)", () => {
  test("managed apiKey beats a forwarded Authorization header", () => {
    // The unauthenticated gap (devlog 350.98/99) reopens if this ever returns the client token.
    const token = resolveCursorToken(
      { adapter: "cursor", baseUrl: "https://api2.cursor.sh", apiKey: "managed-oauth-token" },
      new Headers({ authorization: "Bearer client-forwarded-token" }),
    );
    expect(token).toBe("managed-oauth-token");
  });

  test("falls back to the forwarded Bearer header when no apiKey is configured", () => {
    const token = resolveCursorToken(
      { adapter: "cursor", baseUrl: "https://api2.cursor.sh" },
      new Headers({ authorization: "Bearer client-forwarded-token" }),
    );
    expect(token).toBe("client-forwarded-token");
  });

  test("throws CursorMissingCredentialError when no apiKey, no header, and no env token", () => {
    const prev = process.env.OPENCODEX_CURSOR_TEST_TOKEN;
    delete process.env.OPENCODEX_CURSOR_TEST_TOKEN;
    try {
      expect(() =>
        resolveCursorToken({ adapter: "cursor", baseUrl: "https://api2.cursor.sh" }, new Headers()),
      ).toThrow(CursorMissingCredentialError);
    } finally {
      if (prev === undefined) delete process.env.OPENCODEX_CURSOR_TEST_TOKEN;
      else process.env.OPENCODEX_CURSOR_TEST_TOKEN = prev;
    }
  });
});
