const port = Number(process.env.PHASE0_ORIGIN_PORT ?? "10102");
const chunk = new Uint8Array(1024 * 1024).fill(0x61);

function byteStream(size: number): ReadableStream<Uint8Array> {
  let remaining = size;
  return new ReadableStream({
    pull(controller) {
      if (remaining <= 0) {
        controller.close();
        return;
      }
      const length = Math.min(remaining, chunk.byteLength);
      controller.enqueue(length === chunk.byteLength ? chunk : chunk.slice(0, length));
      remaining -= length;
    },
  });
}

const server = Bun.serve<{ openedAt: number }>({
  hostname: "0.0.0.0",
  port,
  async fetch(request, server) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/v1(?=\/)/, "");
    if (path === "/healthz") return Response.json({ ok: true });
    if (path === "/download") {
      const size = Math.max(0, Math.min(Number(url.searchParams.get("bytes") ?? 0), 512 * 1024 * 1024));
      return new Response(byteStream(size), {
        headers: { "content-length": String(size), "content-type": "application/octet-stream" },
      });
    }
    if (path === "/upload" && request.method === "POST") {
      let size = 0;
      if (request.body) {
        for await (const part of request.body) size += part.byteLength;
      }
      return Response.json({ size });
    }
    if (path === "/sse") {
      const seconds = Math.max(1, Math.min(Number(url.searchParams.get("seconds") ?? 60), 3600));
      let elapsed = 0;
      let timer: Timer | undefined;
      return new Response(new ReadableStream({
        start(controller) {
          const send = () => {
            elapsed += 1;
            controller.enqueue(new TextEncoder().encode(`data: ${elapsed}\n\n`));
            if (elapsed >= seconds) {
              if (timer) clearInterval(timer);
              controller.close();
            }
          };
          send();
          timer = setInterval(send, 1000);
        },
        cancel() {
          if (timer) clearInterval(timer);
        },
      }), { headers: { "cache-control": "no-store", "content-type": "text/event-stream" } });
    }
    if (path === "/ws" && server.upgrade(request, { data: { openedAt: Date.now() } })) return;
    return new Response("not found", { status: 404 });
  },
  websocket: {
    message(socket, message) {
      socket.send(message);
    },
  },
});

console.log(`OpenCodex Remote Phase 0 origin listening on ${server.hostname}:${server.port}`);
