import { afterEach, describe, expect, test } from "bun:test";
import { fetchWithHeaderTimeout } from "../src/server/responses";

const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

function startHeaderEchoServer(): ReturnType<typeof Bun.serve> {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      return new Response(req.headers.get("accept-encoding") ?? "");
    },
  });
  servers.push(server);
  return server;
}

async function observedEncoding(headers: HeadersInit | undefined, streaming: boolean): Promise<string> {
  const server = startHeaderEchoServer();
  const response = await fetchWithHeaderTimeout(
    server.url.toString(),
    { headers },
    new AbortController().signal,
    1_000,
    streaming,
  );
  return response.text();
}

function delayedSseStream(delayMs = 80): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode("data: first\n\n"));
      setTimeout(() => {
        controller.enqueue(encoder.encode("data: second\n\n"));
        controller.close();
      }, delayMs);
    },
  });
}

function startCompressionAwareSseServer(): ReturnType<typeof Bun.serve> {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const acceptsGzip = req.headers.get("accept-encoding")?.includes("gzip") === true;
      const body = acceptsGzip
        ? delayedSseStream().pipeThrough(new CompressionStream("gzip"))
        : delayedSseStream();
      return new Response(body, {
        headers: {
          "content-type": "text/event-stream",
          ...(acceptsGzip ? { "content-encoding": "gzip" } : {}),
        },
      });
    },
  });
  servers.push(server);
  return server;
}

async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const chunk = await reader.read();
  return new TextDecoder().decode(chunk.value);
}

describe("fetchWithHeaderTimeout content-encoding policy", () => {
  test("streaming defaults to identity while non-streaming keeps Bun negotiation", async () => {
    expect(await observedEncoding(undefined, true)).toBe("identity");
    const nonStreaming = await observedEncoding(undefined, false);
    expect(nonStreaming).toContain("gzip");
    expect(nonStreaming).not.toBe("identity");
  });

  test("explicit caller encoding wins for every HeadersInit shape", async () => {
    expect(await observedEncoding({ "Accept-Encoding": "gzip" }, true)).toBe("gzip");
    expect(await observedEncoding([["aCcEpT-EnCoDiNg", "br"]], true)).toBe("br");
    expect(await observedEncoding(new Headers({ "ACCEPT-ENCODING": "deflate" }), true)).toBe("deflate");
  });

  test("identity keeps SSE frames incremental instead of waiting for a gzip block", async () => {
    const server = startCompressionAwareSseServer();

    const compressed = await fetchWithHeaderTimeout(
      server.url.toString(),
      {},
      new AbortController().signal,
      1_000,
      false,
    );
    const compressedReader = compressed.body!.getReader();
    expect(await readChunk(compressedReader)).toBe("data: first\n\ndata: second\n\n");

    const identity = await fetchWithHeaderTimeout(
      server.url.toString(),
      {},
      new AbortController().signal,
      1_000,
      true,
    );
    const identityReader = identity.body!.getReader();
    expect(await readChunk(identityReader)).toBe("data: first\n\n");
    expect(await readChunk(identityReader)).toBe("data: second\n\n");
  });
});

describe("#2567 the upstream fetch disables Bun's per-request idle timeout", () => {
  /**
   * Bun's default socket idle timeout kills a long-quiet upstream turn even though the
   * application-level deadline (AbortSignal) has not fired. Passing `timeout: 0` disables the
   * per-request idle timer; the signal remains the only deadline that can end the request.
   *
   * These pin the propagation on all three call sites, because the value is easy to drop in a
   * refactor and its absence is invisible until a slow provider stalls in production.
   */
  function recordingFetch(): { calls: RequestInit[]; fetch: typeof globalThis.fetch } {
    const calls: RequestInit[] = [];
    const fetch = (async (_input: unknown, init?: RequestInit) => {
      calls.push(init ?? {});
      return new Response("ok");
    }) as unknown as typeof globalThis.fetch;
    return { calls, fetch };
  }

  test("providerFetch passes timeout: 0 to the underlying fetch", async () => {
    const { providerFetch } = await import("../src/server/responses/fetch-helpers");
    const { calls, fetch } = recordingFetch();
    const provider = {
      adapter: "openai-chat",
      baseUrl: "https://upstream.example.test/v1",
      fetch,
    } as unknown as Parameters<typeof providerFetch>[0];

    await providerFetch(provider)("https://upstream.example.test/v1/chat/completions", { method: "POST" });

    expect(calls.length).toBe(1);
    expect((calls[0] as { timeout?: number }).timeout).toBe(0);
  });

  test("fetchWithHeaderTimeout passes timeout: 0 while keeping its abort signal", async () => {
    const server = startHeaderEchoServer();
    const seen: RequestInit[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      seen.push(init ?? {});
      return originalFetch(input as string, init);
    }) as unknown as typeof globalThis.fetch;
    try {
      await fetchWithHeaderTimeout(
        server.url.toString(),
        {},
        new AbortController().signal,
        1_000,
        false,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(seen.length).toBeGreaterThan(0);
    const init = seen[0] as { timeout?: number; signal?: AbortSignal };
    expect(init.timeout).toBe(0);
    // The application deadline must survive: disabling the idle timer is not the same as
    // removing the deadline.
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  test("fetchWithHeaderDeadline passes timeout: 0 to its injected fetch", async () => {
    const { fetchWithHeaderDeadline } = await import("../src/server/claude-messages");
    const { calls, fetch } = recordingFetch();

    const result = await fetchWithHeaderDeadline(
      "https://upstream.example.test/v1/messages",
      { method: "POST" },
      1_000,
      undefined,
      undefined,
      fetch,
    );

    expect(result.kind).toBe("response");
    expect(calls.length).toBe(1);
    const init = calls[0] as { timeout?: number; signal?: AbortSignal };
    expect(init.timeout).toBe(0);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
