/**
 * The Home side of the link WebSocket transport-only RSS acceptance (design T4 6.3). Runs in its own
 * process so the test's clients and fake upstream do not count against the Home's RSS. Setup comes on
 * stdin as one JSON line; commands follow, one per line: "gc-rss" (collect, then reset the high-water
 * mark to the current RSS), "peak" (the high-water mark since then), "heap" (a diagnostic breakdown of what
 * the process holds now: memoryUsage and the largest JSC heap classes by retained size), "stop". When "stalls" link pumps
 * are waiting for a drain, or relayed HTTP responses for their reader, and have stayed so through a quiet window in
 * which the high-water mark did not rise, the fixture prints {"stalled":true, quietWindowMs, settleMs} once; a load
 * that does not settle by the deadline prints {"settleFailed":true} instead.
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
const { setLinkWebsocketTransportReadyForTests, setLinkPumpWaitObserverForTests, setLinkRelayWaitObserverForTests } = await import("../../src/server/index/link-websocket-limits");

// Peak RSS. On Linux the kernel keeps the process high-water mark (VmHWM in /proc/self/status), so
// a peak that rises and falls inside one synchronous operation is still counted; writing "5" to
// /proc/self/clear_refs resets it to the current RSS (Linux 4.0 and later). Elsewhere the fixture
// falls back to sampling on this event loop, which can miss such a peak, and says so in "method".
const readKernelPeak = (): number | null => {
  try {
    const match = /^VmHWM:\s+(\d+) kB$/m.exec(readFileSync("/proc/self/status", "utf8"));
    return match ? Number(match[1]) * 1024 : null;
  } catch { return null; }
};
const resetKernelPeak = (): boolean => {
  try { writeFileSync("/proc/self/clear_refs", "5"); return true; } catch { return false; }
};
const kernel = readKernelPeak() !== null && resetKernelPeak();
let highWater = process.memoryUsage().rss;
const sample = (): void => { highWater = Math.max(highWater, process.memoryUsage().rss); };
if (!kernel) setInterval(sample, 2).unref();
// A kernel run whose peak read or reset fails reports a method that cannot satisfy the acceptance.
let resetFailed = false;
const peakAnswer = (): { rss: number | null; method: string } => {
  if (!kernel) { sample(); return { rss: highWater, method: "sampled" }; }
  const value = readKernelPeak();
  if (value === null) return { rss: null, method: "kernel-unreadable" };
  return { rss: value, method: resetFailed ? "kernel-reset-failed" : "kernel-vmhwm" };
};
let waiting = 0;
// The load's stall, settled (#8600 review). Every reader waiting at once can come before the sustained stall (a paused
// reader's kernel buffer still takes bytes in flight; a relay also waits between two chunks), and VmHWM is read after the
// cut, so a cut taken too early lowers that run's peak: early on the WebSocket run it makes passing easier. So the stall
// is announced only once, for QUIET_WINDOW_MS of wall time, every reader stayed waiting and the high-water mark did not
// rise; either break restarts the window. A load that has not settled SETTLE_DEADLINE_MS after the idle reading fails the
// run: the deadline never announces. Real time is right here and only here: this is an opt-in physical measurement.
const QUIET_WINDOW_MS = 2_500;
const SETTLE_DEADLINE_MS = 180_000;
const QUIET_TICK_MS = 100;
let armedAt: number | null = null;
let windowStart: number | null = null;
let windowPeak = 0;
let settle: ReturnType<typeof setInterval> | undefined;
const currentPeak = (): number => {
  if (!kernel) { sample(); return highWater; }
  return readKernelPeak() ?? 0;
};
const tick = (): void => {
  const now = Date.now();
  if (now - armedAt! >= SETTLE_DEADLINE_MS) {
    clearInterval(settle);
    console.log(JSON.stringify({ settleFailed: true, waiting, stalls: setup.stalls, settleDeadlineMs: SETTLE_DEADLINE_MS }));
    return;
  }
  const peak = currentPeak();
  if (waiting < setup.stalls) { windowStart = null; return; }
  if (windowStart === null || peak > windowPeak) { windowStart = now; windowPeak = peak; return; }
  if (now - windowStart < QUIET_WINDOW_MS) return;
  clearInterval(settle);
  console.log(JSON.stringify({ stalled: true, quietWindowMs: QUIET_WINDOW_MS, settleMs: now - armedAt! }));
};
const observeWait = (isWaiting: boolean): void => {
  waiting += isWaiting ? 1 : -1;
  sample();
  // A reader that moved, even between two ticks, breaks the window.
  if (waiting < setup.stalls) windowStart = null;
};
setLinkPumpWaitObserverForTests(observeWait);
setLinkRelayWaitObserverForTests(observeWait);

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
  if (command === "peak") console.log(JSON.stringify(peakAnswer()));
  else if (command === "gc-rss") {
    Bun.gc(true);
    if (kernel && !resetKernelPeak()) resetFailed = true;
    highWater = process.memoryUsage().rss;
    // The first idle reading arms the settle check, so the warm-up turn's waits never count toward the load's stall.
    if (armedAt === null) { armedAt = Date.now(); settle = setInterval(tick, QUIET_TICK_MS); }
    console.log(JSON.stringify({ rss: highWater }));
  }
  else if (command === "heap") {
    const usage = process.memoryUsage();
    // JSC heap snapshot: nodes come in fours (id, size, class index, flags); sum the size per class.
    const snapshot = Bun.generateHeapSnapshot() as unknown as { nodes: number[]; nodeClassNames: string[] };
    const byClass = new Map<string, number>();
    for (let index = 0; index + 3 < snapshot.nodes.length; index += 4) {
      const name = snapshot.nodeClassNames[snapshot.nodes[index + 2]!] ?? "?";
      byClass.set(name, (byClass.get(name) ?? 0) + snapshot.nodes[index + 1]!);
    }
    const top = [...byClass.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, bytes]) => [name, Math.round(bytes / 1048576)]);
    console.log(JSON.stringify({ heap: true, rssMiB: Math.round(usage.rss / 1048576), heapUsedMiB: Math.round(usage.heapUsed / 1048576),
      externalMiB: Math.round(usage.external / 1048576), arrayBuffersMiB: Math.round(usage.arrayBuffers / 1048576), topClassesMiB: top }));
  }
  else if (command === "stop") break;
}
await server.stop(true);
process.exit(0);
