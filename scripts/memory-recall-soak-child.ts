/**
 * #820 memory-recall soak probe child.
 *
 * The parent owns the mock provider and clients. This child owns only the real
 * OpenCodex proxy plus a loopback-only control listener for payload-free scalar
 * metrics, which keeps process RSS attributable to the proxy rather than the
 * load generator. This is an offline probe, not a CI test or production route.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OcxConfig } from "../src/types";

function optionValue(name: string): string | null {
  const index = Bun.argv.indexOf(name);
  if (index === -1 || index + 1 >= Bun.argv.length) return null;
  return Bun.argv[index + 1] ?? null;
}

const upstreamBaseUrl = optionValue("--upstream");
if (!upstreamBaseUrl) {
  console.error("memory-recall-soak-child: --upstream is required");
  process.exit(2);
}

let upstreamUrl: URL;
try {
  upstreamUrl = new URL(upstreamBaseUrl);
} catch {
  console.error("memory-recall-soak-child: --upstream must be a URL");
  process.exit(2);
}
if (upstreamUrl.hostname !== "127.0.0.1" && upstreamUrl.hostname !== "localhost" && upstreamUrl.hostname !== "::1") {
  console.error("memory-recall-soak-child: upstream must be loopback");
  process.exit(2);
}

const home = mkdtempSync(join(tmpdir(), "ocx-memory-recall-soak-"));
process.env.OPENCODEX_HOME = home;

const [configModule, serverModule, memoryModule, lifecycleModule, relayModule, responseStateModule] = await Promise.all([
  import("../src/config"),
  import("../src/server"),
  import("../src/lib/app-owned-memory"),
  import("../src/server/lifecycle"),
  import("../src/server/relay"),
  import("../src/responses/state"),
]);

const config = {
  port: 0,
  defaultProvider: "mock",
  providers: {
    mock: {
      adapter: "openai-chat",
      baseUrl: `${upstreamUrl.toString().replace(/\/$/, "")}/v1`,
      apiKey: "memory-soak-local-only",
      allowPrivateNetwork: true,
    },
  },
} as OcxConfig;
configModule.saveConfig(config);
const proxy = serverModule.startServer(0);

function metrics() {
  const usage = process.memoryUsage();
  return {
    atMs: Date.now(),
    pid: process.pid,
    platform: process.platform,
    bunVersion: Bun.version,
    bunRevision: Bun.revision,
    uptimeSeconds: process.uptime(),
    rss: usage.rss,
    heapUsed: usage.heapUsed,
    heapTotal: usage.heapTotal,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers,
    activeTurnCount: lifecycleModule.getActiveTurnCount(),
    appOwnedBytes: memoryModule.appOwnedBytesSnapshot(),
    inspectionCounters: relayModule.getInspectionCounters(),
    responseState: responseStateModule.responseStateMetrics(),
  };
}

let closing = false;
let control: ReturnType<typeof Bun.serve> | undefined;

async function closeAndExit(code: number): Promise<never> {
  if (closing) {
    await Bun.sleep(25);
    process.exit(code);
  }
  closing = true;
  try { await proxy.stop(true); } catch { /* best-effort probe teardown */ }
  try { control?.stop(true); } catch { /* best-effort probe teardown */ }
  try { rmSync(home, { recursive: true, force: true }); } catch { /* temp cleanup only */ }
  process.exit(code);
}

control = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/metrics" && req.method === "GET") {
      return Response.json(metrics(), {
        headers: { "cache-control": "no-store" },
      });
    }
    if (url.pathname === "/shutdown" && req.method === "POST") {
      setTimeout(() => { void closeAndExit(0); }, 0);
      return Response.json({ ok: true });
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(JSON.stringify({
  type: "ready",
  proxyUrl: proxy.url.toString(),
  controlUrl: control.url.toString(),
  pid: process.pid,
  platform: process.platform,
  bunVersion: Bun.version,
  bunRevision: Bun.revision,
}));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => { void closeAndExit(128); });
}
