/**
 * A fake upstream that answers any request with HTTP 200 `text/event-stream`, writes the given SSE
 * text as one chunk, and then closes the socket without the terminating zero-length chunk.
 *
 * That is a mid-stream reset as the proxy's `fetch` sees it: the response headers arrived, part of
 * the body arrived, and the next `reader.read()` rejects with ECONNRESET ("The socket connection
 * was closed unexpectedly"). `Bun.serve` cannot produce it deterministically — an errored response
 * body is sent as a connection reset by one Bun release and as a clean chunked EOF by another —
 * so the fixture speaks HTTP/1.1 over a raw socket instead.
 */
export function startTruncatedSseUpstream(sse: string): { port: number; requests: () => number; stop: () => void } {
  const body = new TextEncoder().encode(sse);
  const head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n";
  const answered = new WeakSet<object>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let requests = 0;
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket) {
        if (answered.has(socket)) return;
        answered.add(socket);
        requests += 1;
        socket.write(`${head}${body.byteLength.toString(16)}\r\n`);
        socket.write(body);
        socket.write("\r\n");
        // Give the partial body time to reach the reader before the reset: ending the socket
        // right after the write lets Bun 1.3 fail the fetch before the headers are read.
        const timer = setTimeout(() => {
          timers.delete(timer);
          socket.end();
        }, 20);
        timers.add(timer);
      },
    },
  });
  return {
    port: listener.port,
    requests: () => requests,
    stop: () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      listener.stop(true);
    },
  };
}
