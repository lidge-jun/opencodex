const originalFetch = globalThis.fetch;

export interface UpstreamFixture {
  server: ReturnType<typeof Bun.serve>;
  captured: CapturedUpstreamRequest[];
  restoreFetch: () => void;
}

export interface CapturedUpstreamRequest {
  method: string;
  path: string;
  headers: Headers;
  body: string;
}

export function installUpstreamFixture(
  upstreamHost: string,
  handler: (req: Request, captured: CapturedUpstreamRequest) => Response | Promise<Response>,
): UpstreamFixture {
  const captured: CapturedUpstreamRequest[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = await req.text();
      const entry: CapturedUpstreamRequest = {
        method: req.method,
        path: url.pathname + url.search,
        headers: req.headers,
        body,
      };
      captured.push(entry);
      return handler(req, entry);
    },
  });

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const url = new URL(requestUrl);
    if (url.hostname === upstreamHost) {
      const target = new URL(`${url.pathname}${url.search}`, server.url);
      return originalFetch(target, init);
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  return {
    server,
    captured,
    restoreFetch: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

export function chunkedSseResponse(
  chunks: string[],
  delayMs = 0,
): Response {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) {
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream" },
  });
}
