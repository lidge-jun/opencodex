/**
 * The Home side of the link WebSocket transport-only RSS acceptance (design T4 6.3). Runs in its own
 * process so the test's clients and fake upstream do not count against the Home's RSS. Setup comes on
 * stdin as one JSON line; commands follow, one per line: "gc-rss" (collect, then reset the high-water
 * mark to the current RSS), "peak" (the high-water mark since then), "stop". When "stalls" link pumps
 * are waiting for a drain at the same time, the fixture prints {"stalled":true} once.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const lines = console[Symbol.asyncIterator]();
const first = await lines.next();
const setup = JSON.parse(String(first.value)) as {
  upstreamPort: number;
  keys: Array<{ id: string; key: string; linkId: string }>;
  stalls: number;
};
const home = process.env.OPENCODEX_HOME!;
const codexHome = process.env.CODEX_HOME!;
mkdirSync(home, { recursive: true });
mkdirSync(codexHome, { recursive: true });
writeFileSync(join(codexHome, "opencodex-catalog.json"), JSON.stringify({ models: [{ slug: "fixture/fixture" }] }));

const { writeLinkStore } = await import("../../src/link/store");
const { linkStorePath } = await import("../../src/link/paths");
const { saveConfig } = await import("../../src/config");
const { setLinkWebsocketTransportReadyForTests, setLinkPumpWaitObserverForTests } = await import("../../src/server/index/link-websocket-limits");

// High-water RSS, sampled continuously in this process (measurement only; nothing waits on it).
let highWater = process.memoryUsage().rss;
const sample = (): void => { highWater = Math.max(highWater, process.memoryUsage().rss); };
setInterval(sample, 2).unref();
let waiting = 0;
let announced = false;
setLinkPumpWaitObserverForTests(isWaiting => {
  waiting += isWaiting ? 1 : -1;
  sample();
  if (!announced && waiting >= setup.stalls) { announced = true; console.log(JSON.stringify({ stalled: true })); }
});

writeLinkStore(linkStorePath(), {
  version: 1,
  listenerPort: null,
  links: setup.keys.map(entry => ({
    id: entry.linkId, alias: "rss-" + entry.id, direction: "client-initiated", hostKeyFingerprint: "SHA256:abcdefghijklmnop",
    tunnelPort: 2222, apiKeyId: entry.id, createdAt: "2026-11-12T00:00:00.000Z",
  })) as never,
});
saveConfig({
  port: 0, hostname: "127.0.0.1", defaultProvider: "fixture", websockets: true, linkResponsesWebsocket: true,
  codexAutoStart: false, clientIntegrations: { codex: false },
  providers: { fixture: {
    adapter: "openai-responses", baseUrl: "http://127.0.0.1:" + setup.upstreamPort + "/v1",
    authMode: "key", apiKey: "fixture-upstream-key", allowPrivateNetwork: true, models: ["fixture"],
  } },
  apiKeys: setup.keys.map(entry => ({ id: entry.id, name: entry.id, key: entry.key, createdAt: "2026-11-12T00:00:00.000Z" })),
} as never);
setLinkWebsocketTransportReadyForTests(true);
const { startServer } = await import("../../src/server");
const server = startServer(0);
const linkPort = (JSON.parse(readFileSync(linkStorePath(), "utf8")) as { listenerPort: number }).listenerPort;
Bun.gc(true);
console.log(JSON.stringify({ ready: true, linkPort, rss: process.memoryUsage().rss }));

for (;;) {
  const next = await lines.next();
  if (next.done) break;
  const command = String(next.value).trim();
  if (command === "peak") { sample(); console.log(JSON.stringify({ rss: highWater })); }
  else if (command === "gc-rss") { Bun.gc(true); highWater = process.memoryUsage().rss; console.log(JSON.stringify({ rss: highWater })); }
  else if (command === "stop") break;
}
await server.stop(true);
process.exit(0);

