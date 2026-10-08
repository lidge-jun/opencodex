import { UsageRelayController } from './usage-controller';
import { controlledUsageSse } from './usage-sse-controller';
import { boundedJsonBody } from './json-body';

/** Inject as the listener's fetchImpl. Existing auth forwarding/TLS/WS code stays unchanged. */
export function createUsageControlledFetch(controller: UsageRelayController, upstreamFetch: typeof fetch = fetch): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const upstream = await upstreamFetch(input, init);
    const pathname = new URL(input instanceof Request ? input.url : String(input)).pathname;
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const exchange = { pathname, method, status: upstream.status };
    if (method !== 'GET' || upstream.status !== 200 || !upstream.body
      || !['/backend-api/wham/usage', '/backend-api/wham/usage/stream'].includes(pathname)) return upstream;
    const contentType = upstream.headers.get('content-type') ?? '';
    const headers = new Headers(upstream.headers);
    const output = (body: BodyInit, transformed = false) => {
      headers.delete('content-length'); headers.delete('content-encoding');
      if (transformed) {
        for (const name of ['etag', 'last-modified', 'digest', 'content-md5']) headers.delete(name);
        headers.set('cache-control', 'no-store');
      }
      return new Response(body, { status: upstream.status, statusText: upstream.statusText, headers });
    };
    if (contentType.includes('application/json') || contentType.endsWith('+json')) {
      const body = await boundedJsonBody(upstream.body);
      if ('stream' in body) return output(body.stream);
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(body.bytes); }
      catch { return output(new Uint8Array(body.bytes)); }
      const changed = await controller.rewriteJson(text, exchange);
      return output(changed ?? new Uint8Array(body.bytes), changed !== null);
    }
    if (!contentType.includes('text/event-stream') || pathname !== '/backend-api/wham/usage/stream') return upstream;
    let registration: ReturnType<UsageRelayController['registerStream']> = null;
    const reader = upstream.body.pipeThrough(controlledUsageSse(text => controller.rewriteJson(text, exchange, registration))).getReader();
    let ended = false, sink: ReadableStreamDefaultController<Uint8Array>;
    const close = async () => {
      if (ended) return;
      ended = true; registration?.release();
      const cancelled = reader.cancel();
      try { sink.close(); } catch { /* caller already cancelled */ }
      await cancelled;
    };
    const body = new ReadableStream<Uint8Array>({
      start(value) { sink = value; },
      async pull(value) {
        try {
          const next = await reader.read();
          if (ended) return;
          if (next.done) { ended = true; registration?.release(); value.close(); }
          else value.enqueue(next.value);
        } catch (error) { if (!ended) { ended = true; registration?.release(); value.error(error); } }
      },
      cancel: close,
    });
    registration = controller.registerStream(exchange, close);
    return output(body, true);
  }) as typeof fetch;
}
