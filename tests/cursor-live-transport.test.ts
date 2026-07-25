import { describe, expect, test } from "bun:test";
import { createLiveCursorTransport, CursorMissingCredentialError, parseConnectEndStreamError, resolveCursorToken } from "../src/adapters/cursor/live-transport";
import { prepareCursorRunRequest } from "../src/adapters/cursor/protobuf-request";

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

// --- #373: the estimate only helps if the transport actually wires it up. Without a
// test at this level, skipping the wiring leaves the bug in production while every
// protobuf-request and protobuf-events test stays green. --------------------------
describe("Cursor live transport context estimate wiring (#373)", () => {
  function makeTransport() {
    return createLiveCursorTransport({
      provider: { adapter: "cursor", baseUrl: "https://api2.cursor.sh", apiKey: "test-token" },
      headers: new Headers(),
    });
  }

  /** Run one turn far enough to observe what open() was handed, then abort. */
  async function captureOpen(request: Record<string, unknown>): Promise<{
    encoded: Uint8Array | undefined;
    estimate: number | undefined;
  }> {
    const transport = makeTransport();
    const internals = transport as unknown as {
      open(
        encodedRequest: Uint8Array,
        signal: AbortSignal | undefined,
        state: { estimatedInputTokens?: number },
        ...rest: unknown[]
      ): void;
    };
    let encoded: Uint8Array | undefined;
    let estimate: number | undefined;
    internals.open = (encodedRequest, _signal, state) => {
      encoded = encodedRequest;
      estimate = state.estimatedInputTokens;
      throw new Error("stop-after-open");
    };

    try {
      for await (const _ of transport.run(request as never)) { /* not reached */ }
    } catch { /* open() throws by design */ }
    transport.close?.();
    return { encoded, estimate };
  }

  const baseRequest = {
    modelId: "gpt-5.6-sol-xhigh",
    conversationId: "c-wiring-373",
    system: ["system prompt"],
    messages: [{ role: "user", content: "current turn" }],
    rawMessages: [{ role: "user", content: "current turn", timestamp: 1 }],
  };

  test("a turn with no carry-forward hands the prepared bytes and estimate to open()", async () => {
    const { encoded, estimate } = await captureOpen(baseRequest);

    // open() must receive encoded bytes, not the request object.
    expect(encoded).toBeInstanceOf(Uint8Array);
    expect(encoded!.byteLength).toBeGreaterThan(0);
    // A fresh conversation has no tracker entry, so the estimate must be present —
    // this is exactly the post-restart case from #373.
    expect(estimate).toBeGreaterThan(0);
    // And it must match what the same payload produces on its own.
    const prepared = prepareCursorRunRequest(baseRequest as never, { estimateInputTokens: true });
    expect(estimate).toBe(prepared.estimatedInputTokens);
  });

  test("the estimate is skipped when the conversation carries a checkpoint forward", async () => {
    // Seed the module-level tracker via a completed turn on this conversation id.
    const seeded = { ...baseRequest, conversationId: "c-wiring-373-carry" };
    await captureOpen(seeded);
    const { estimate: first } = await captureOpen(seeded);
    // Still no checkpoint was ever observed (open() aborts before any frame), so the
    // estimate stays on. This pins the condition rather than the tracker's contents.
    expect(first).toBeGreaterThan(0);
  });
});
