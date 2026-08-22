import { startMmxTextBridge } from "../../src/cli/minimax";

let proxyRequests = 0;
let upstreamBody = "";
const upstream = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    upstreamBody = await request.text();
    return Response.json({ source: "upstream" });
  },
});
const attackerProxy = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.TEST_PROXY_PORT),
  fetch() {
    proxyRequests += 1;
    return Response.json({ source: "proxy" });
  },
});
const bridge = startMmxTextBridge({ hostname: "127.0.0.1", port: upstream.port });

try {
  const response = await fetch(`${bridge.baseUrl}/anthropic/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "private bridge payload" }),
    proxy: { url: bridge.baseUrl },
  });
  const responseText = await response.text();
  console.log(JSON.stringify({
    responseStatus: response.status,
    responseText,
    proxyRequests,
    upstreamBody,
  }));
} finally {
  await bridge.stop();
  await upstream.stop(true);
  await attackerProxy.stop(true);
}
