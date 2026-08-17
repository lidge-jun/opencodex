import { afterEach, describe, expect, test } from "bun:test";
import { CodexWarmupError, warmCodexAccount } from "../src/codex/warmup";

const originalFetch = globalThis.fetch;

function sseResponse(frames: string, status = 200): Response {
  return new Response(frames, { status, headers: { "Content-Type": "text/event-stream" } });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("codex warmup", () => {
  test("posts a minimal gpt-5.4-mini Responses stream request and accepts response.completed", async () => {
    let body: Record<string, unknown> | undefined;
    let auth: string | null = null;
    let account: string | null = null;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const headers = new Headers(init?.headers);
      auth = headers.get("authorization");
      account = headers.get("chatgpt-account-id");
      return sseResponse('event: response.completed\ndata: {"type":"response.completed"}\n\n');
    }) as typeof fetch;

    await warmCodexAccount({ accessToken: "access-test", chatgptAccountId: "acct-test" });

    expect(auth).toBe("Bearer access-test");
    expect(account).toBe("acct-test");
    expect(body).toMatchObject({
      model: "gpt-5.4-mini",
      instructions: "Reply with OK.",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      stream: true,
      store: false,
    });
    expect(body).not.toHaveProperty("max_output_tokens");
  });

  test("rejects streamed failure terminal", async () => {
    globalThis.fetch = (async () => sseResponse('event: response.failed\ndata: {"type":"response.failed"}\n\n')) as typeof fetch;
    await expect(warmCodexAccount({ accessToken: "a", chatgptAccountId: "c" }))
      .rejects.toMatchObject({ name: "CodexWarmupError", code: "stream_failed" });
  });

  test("rejects streamed incomplete and error terminals", async () => {
    globalThis.fetch = (async () => sseResponse('event: response.incomplete\ndata: {"type":"response.incomplete"}\n\n')) as typeof fetch;
    await expect(warmCodexAccount({ accessToken: "a", chatgptAccountId: "c" }))
      .rejects.toMatchObject({ name: "CodexWarmupError", code: "stream_incomplete" });

    globalThis.fetch = (async () => sseResponse('event: error\ndata: {"type":"error"}\n\n')) as typeof fetch;
    await expect(warmCodexAccount({ accessToken: "a", chatgptAccountId: "c" }))
      .rejects.toMatchObject({ name: "CodexWarmupError", code: "stream_error" });
  });

  test("rejects malformed SSE JSON", async () => {
    globalThis.fetch = (async () => sseResponse("event: response.completed\ndata: {not-json}\n\n")) as typeof fetch;
    await expect(warmCodexAccount({ accessToken: "a", chatgptAccountId: "c" }))
      .rejects.toMatchObject({ name: "CodexWarmupError", code: "invalid_sse" });
  });

  test("rejects an oversized unterminated SSE stream without waiting for cancellation", async () => {
    let cancelled = false;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const oversizedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        const chunk = new Uint8Array(256 * 1024).fill(65);
        for (let index = 0; index < 5; index += 1) controller.enqueue(chunk);
        closeTimer = setTimeout(() => controller.close(), 50);
      },
      cancel() {
        cancelled = true;
        if (closeTimer !== undefined) clearTimeout(closeTimer);
        return new Promise<void>(() => {});
      },
    });
    globalThis.fetch = (async () => new Response(oversizedBody, { status: 200 })) as typeof fetch;

    await expect(warmCodexAccount({ accessToken: "a", chatgptAccountId: "c" }))
      .rejects.toMatchObject({ name: "CodexWarmupError", code: "stream_too_large" });
    expect(cancelled).toBe(true);
  });

  test("aborts a silent SSE body at the warmup deadline without waiting for cancellation", async () => {
    let cancelled = false;
    const silentBody = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
        return new Promise<void>(() => {});
      },
    });
    globalThis.fetch = (async () => new Response(silentBody, { status: 200 })) as typeof fetch;

    const startedAt = performance.now();
    await expect(warmCodexAccount({
      accessToken: "a",
      chatgptAccountId: "c",
      timeoutMs: 20,
    })).rejects.toMatchObject({ name: "CodexWarmupError", code: "transport" });

    expect(cancelled).toBe(true);
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });

  test("does not retry a fallback after the deadline expires while draining a 400 body", async () => {
    let fetchCalls = 0;
    let cancellations = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      const silentBody = new ReadableStream<Uint8Array>({
        cancel() {
          cancellations += 1;
          return new Promise<void>(() => {});
        },
      });
      return new Response(silentBody, { status: 400 });
    }) as typeof fetch;

    const startedAt = performance.now();
    await expect(warmCodexAccount({
      accessToken: "a",
      chatgptAccountId: "c",
      timeoutMs: 20,
    })).rejects.toMatchObject({ name: "CodexWarmupError", code: "transport" });

    expect(fetchCalls).toBe(1);
    expect(cancellations).toBe(1);
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });

  test("accepts a completed SSE stream at the exact byte limit", async () => {
    const encoder = new TextEncoder();
    const terminal = 'data: {"type":"response.completed"}\n\n';
    const terminalBytes = encoder.encode(terminal).byteLength;
    const fillerBytes = 1024 * 1024 - terminalBytes;
    const filler = `:${"x".repeat(fillerBytes - 3)}\n\n`;
    const stream = `${filler}${terminal}`;
    expect(encoder.encode(stream).byteLength).toBe(1024 * 1024);
    globalThis.fetch = (async () => sseResponse(stream)) as typeof fetch;

    await expect(warmCodexAccount({ accessToken: "a", chatgptAccountId: "c" })).resolves.toBeUndefined();
  });

  test("accepts mixed LF and CRLF blank-line delimiters", async () => {
    for (const delimiter of ["\n\n", "\r\n\n", "\n\r\n", "\r\n\r\n"]) {
      globalThis.fetch = (async () => sseResponse(
        `data: {"type":"response.completed"}${delimiter}`,
      )) as typeof fetch;
      await expect(warmCodexAccount({ accessToken: "a", chatgptAccountId: "c" })).resolves.toBeUndefined();
    }
  });

  test("parses a heavily fragmented unterminated frame without rescanning its prefix", async () => {
    const bytes = new TextEncoder().encode(
      `:${"x".repeat(256 * 1024)}\n\r\ndata: {"type":"response.completed"}\r\n\n`,
    );
    let offset = 0;
    const fragmentedBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= bytes.byteLength) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.subarray(offset, offset + 1));
        offset += 1;
      },
    });
    globalThis.fetch = (async () => new Response(fragmentedBody, { status: 200 })) as typeof fetch;

    await expect(warmCodexAccount({
      accessToken: "a",
      chatgptAccountId: "c",
      timeoutMs: 10_000,
    })).resolves.toBeUndefined();
  }, 15_000);

  test("rejects EOF before success terminal", async () => {
    globalThis.fetch = (async () => sseResponse('event: response.created\ndata: {"type":"response.created"}\n\n')) as typeof fetch;
    await expect(warmCodexAccount({ accessToken: "a", chatgptAccountId: "c" }))
      .rejects.toMatchObject({ name: "CodexWarmupError", code: "no_terminal" });
  });

  test("rejects HTTP auth/session errors without exposing token material", async () => {
    globalThis.fetch = (async () => new Response("sensitive-access-token revoked", { status: 401 })) as typeof fetch;
    try {
      await warmCodexAccount({ accessToken: "sensitive-access-token", chatgptAccountId: "sensitive-account-id" });
      throw new Error("expected warmup to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(CodexWarmupError);
      expect((err as CodexWarmupError).code).toBe("http_status");
      expect((err as CodexWarmupError).status).toBe(401);
      expect((err as Error).message).not.toContain("sensitive-access-token");
      expect((err as Error).message).not.toContain("sensitive-account-id");
      expect((err as Error).message).not.toContain("revoked");
    }
  });

  test("classifies invalid timeout options as transport failures", async () => {
    for (const timeoutMs of [-1, 0x8000_0000]) {
      await expect(warmCodexAccount({ accessToken: "a", chatgptAccountId: "c", timeoutMs }))
        .rejects.toMatchObject({ name: "CodexWarmupError", code: "transport" });
    }
  });
});
