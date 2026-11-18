/**
 * The Child side of the link WebSocket transport-only RSS acceptance (design T4 6.3, 11.2-9). Runs the real Child
 * listener and relay (src/client/machine-listener.ts, src/client/link-websocket.ts, src/client/link-relay.ts) in its own
 * process, so the test's Codex-side clients and its stand-in Home do not count against the Child's RSS. The Child's
 * release gate is opened for this process only, through the relay's ready seam. Setup comes on stdin as one JSON line;
 * commands follow, one per line, as in the Home fixture (tests/fixtures/link-ws-rss-home.ts): "gc-rss" (collect, then
 * reset the high-water mark to the current RSS, and arm the settle check), "peak", "stop".
 *
 * The stall is the Child's own. For the WebSocket, every link leg toward Codex has paused its Home leg (more than 1 MiB
 * waits toward Codex; the relay's onDownlinkPause seam). A paused leg that ends reports "resumed" as it finishes, which
 * drops the count; the fixture also counts the relay's releases (onReleased, once a leg's Home connection has closed and
 * its slot is freed): the idle reading waits for the warm-up socket's release (30 s at most, else the run is invalid),
 * and a release after it and before the stall is announced reports the run invalid, so a load that lost a leg can never
 * settle. For HTTP, every relayed response waits for its reader
 * (setLinkChildRelayWaitObserverForTests, #8680): the reader holds a chunk and the relay may hold one more queued, since
 * the relay reads one Home chunk ahead. The observer reports every relayed response, management reads included, so the
 * fixture counts every transition from the start: the idle reading reports how many waits are open (the test requires
 * none), and from then on the fixture reports a run invalid ({"invalid":true}) if more readers wait than the load has or
 * the count goes below zero; the "peak" answer carries the extremes through the measurement, which the test checks too.
 * The test sends nothing else through this Child during the load.
 * Otherwise a wrong HTTP signal can only make that run settle early or never: an early HTTP settle lowers the HTTP peak,
 * which makes the acceptance harder to pass, and a load that never settles fails at the deadline.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const lines = console[Symbol.asyncIterator]();
const first = await lines.next();
const setup = JSON.parse(String(first.value)) as {
  homePort: number; identity: { keyId: string; linkId: string; secret: string }; transport: "websocket" | "http"; stalls: number;
};
const home = process.env.OPENCODEX_HOME!;
mkdirSync(home, { recursive: true });
writeFileSync(join(home, "config.json"), JSON.stringify({ port: 0, hostname: "127.0.0.1", providers: {}, defaultProvider: "openai" }));

const { setLinkChildRelayWaitObserverForTests } = await import("../../src/client/link-websocket-limits");
const { probeLinkRelayPreflight } = await import("../../src/client/link-relay-transport");
const { startChild } = await import("../helpers/link-ws-child");

// Peak RSS, exactly as the Home fixture reads it: VmHWM, reset through /proc/self/clear_refs; elsewhere a sampled peak
// that cannot satisfy the acceptance.
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
let resetFailed = false;
const peakAnswer = (): { rss: number | null; method: string } => {
  if (!kernel) { sample(); return { rss: highWater, method: "sampled" }; }
  const value = readKernelPeak();
  if (value === null) return { rss: null, method: "kernel-unreadable" };
  return { rss: value, method: resetFailed ? "kernel-reset-failed" : "kernel-vmhwm" };
};

// The settle rule of the Home fixture (#8647), copied so the Home acceptance's own fixture stays as it was measured: the
// stall is announced only once, for QUIET_WINDOW_MS of wall time, every reader stayed waiting and the high-water mark did
// not rise; either break restarts the window. A load that has not settled SETTLE_DEADLINE_MS after the idle reading fails.
// Real time is right here and only here: this is an opt-in physical measurement.
const QUIET_WINDOW_MS = 2_500;
const SETTLE_DEADLINE_MS = 180_000;
const QUIET_TICK_MS = 100;
const RELEASE_DEADLINE_MS = 30_000;
let waiting = 0;
let maxWaiting = 0;
let minWaiting = 0;
let armedAt: number | null = null;
let windowStart: number | null = null;
let windowPeak = 0;
let settle: ReturnType<typeof setInterval> | undefined;
let done = false;
const currentPeak = (): number => {
  if (!kernel) { sample(); return highWater; }
  return readKernelPeak() ?? 0;
};
const tick = (): void => {
  if (done) return;
  const now = Date.now();
  if (releasedWhileLoaded > 0) {
    done = true; clearInterval(settle);
    console.log(JSON.stringify({ invalid: true, reason: "a link socket was released before the stall was announced", releasedWhileLoaded }));
    return;
  }
  if (maxWaiting > setup.stalls || minWaiting < 0) {
    done = true; clearInterval(settle);
    console.log(JSON.stringify({ invalid: true, reason: maxWaiting > setup.stalls ? "more readers waited than the load has" : "a wait ended that began before the idle reading", maxWaiting, minWaiting, stalls: setup.stalls }));
    return;
  }
  if (now - armedAt! >= SETTLE_DEADLINE_MS) {
    done = true; clearInterval(settle);
    console.log(JSON.stringify({ settleFailed: true, waiting, stalls: setup.stalls, settleDeadlineMs: SETTLE_DEADLINE_MS }));
    return;
  }
  const peak = currentPeak();
  if (waiting < setup.stalls) { windowStart = null; return; }
  if (windowStart === null || peak > windowPeak) { windowStart = now; windowPeak = peak; return; }
  if (now - windowStart < QUIET_WINDOW_MS) return;
  done = true; clearInterval(settle);
  console.log(JSON.stringify({ stalled: true, quietWindowMs: QUIET_WINDOW_MS, settleMs: now - armedAt! }));
};
const observeWait = (isWaiting: boolean): void => {
  // Counted from the start, so a warm-up wait still open at the idle reading shows there.
  waiting += isWaiting ? 1 : -1;
  maxWaiting = Math.max(maxWaiting, waiting);
  minWaiting = Math.min(minWaiting, waiting);
  sample();
  if (waiting < setup.stalls) windowStart = null;
};
if (setup.transport === "http") setLinkChildRelayWaitObserverForTests(observeWait);
// Link socket releases (the Home connection closed): before the idle reading only the warm-up's; after it, any release
// before the stall is announced invalidates the run.
let releasedWhileLoaded = 0;
let warmReleased!: () => void;
const warmRelease = new Promise<void>(resolve => { warmReleased = resolve; });
const onReleased = (): void => {
  if (armedAt === null) { warmReleased(); return; }
  if (!done) releasedWhileLoaded += 1;
};

// The Child learns the Home's advertisement from one preflight, before anything is measured.
const preflight = await probeLinkRelayPreflight({ tunnelPort: setup.homePort, admissionKey: setup.identity.secret, linkId: setup.identity.linkId, apiKeyId: setup.identity.keyId });
const listener = startChild(setup.homePort, setup.identity, {
  websocket: { ready: () => true, ...(setup.transport === "websocket" ? { onDownlinkPause: observeWait, onReleased } : {}) },
});
Bun.gc(true);
console.log(JSON.stringify({ ready: true, port: listener.port, preflight, rss: process.memoryUsage().rss }));

for (;;) {
  const next = await lines.next();
  if (next.done) break;
  const command = String(next.value).trim();
  if (command === "peak") console.log(JSON.stringify({ ...peakAnswer(), maxWaiting, minWaiting }));
  else if (command === "gc-rss") {
    // The WebSocket run's warm-up socket must have released its slot before the idle reading, within a bound that fails.
    if (armedAt === null && setup.transport === "websocket") {
      let bound: ReturnType<typeof setTimeout> | undefined;
      const released = await Promise.race([warmRelease.then(() => true), new Promise<boolean>(resolve => { bound = setTimeout(() => resolve(false), RELEASE_DEADLINE_MS); })]);
      clearTimeout(bound);
      if (!released) { console.log(JSON.stringify({ invalid: true, reason: "the warm-up socket was not released before the idle reading", releaseDeadlineMs: RELEASE_DEADLINE_MS })); continue; }
    }
    Bun.gc(true);
    if (kernel && !resetKernelPeak()) resetFailed = true;
    highWater = process.memoryUsage().rss;
    const first = armedAt === null;
    if (first) { armedAt = Date.now(); maxWaiting = waiting; minWaiting = waiting; settle = setInterval(tick, QUIET_TICK_MS); }
    console.log(JSON.stringify({ rss: highWater, ...(first ? { waitingAtIdle: waiting } : {}) }));
  }
  else if (command === "stop") break;
}
clearInterval(settle);
await listener.stop(true);
process.exit(0);
