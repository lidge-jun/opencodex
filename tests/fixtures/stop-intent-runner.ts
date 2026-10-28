/** Real management stop intent/restart admission; teardown and host effects are controlled. */
import { mock } from "bun:test";
import type { StopTeardownBody } from "../../src/server/stop-teardown";

const mode = process.argv[2]!;
const waiting: Array<{ resolve(body: StopTeardownBody): void; reject(error: Error): void }> = [];
const service = await import("../../src/service");
mock.module("../../src/service", () => ({ ...service,
  installedServiceRespawnRisk: () => "none", stopServiceIfInstalledDetailed: () => "absent",
}));
const teardown = await import("../../src/server/stop-teardown");
mock.module("../../src/server/stop-teardown", () => ({ ...teardown,
  performStopTeardown: () => new Promise<StopTeardownBody>((resolve, reject) => { waiting.push({ resolve, reject }); }),
}));
const { handleManagementAPI } = await import("../../src/server/management-api");
const { acceptSystemRestart, noteExplicitShutdownRequested } = await import("../../src/server/management/system-restart");
const config = { port: 10100, hostname: "127.0.0.1", providers: {}, defaultProvider: "openai" };
const refused: StopTeardownBody = { success: false, sharedTeardown: "refused", message: "fixture ownership pending" };
const accepted: StopTeardownBody = { success: true, sharedTeardown: "performed", message: "fixture restored" };
const scheduledStops: Array<() => void> = [];
const nativeTimeout = globalThis.setTimeout;
let now = 10_000;
let enteredDrain!: () => void;
let releaseDrain!: () => void;
const drainEntered = new Promise<void>(resolve => { enteredDrain = resolve; });
const heldDrain = new Promise<void>(resolve => { releaseDrain = resolve; });
let enteredListener!: () => void;
let releaseListener!: () => void;
const listenerEntered = new Promise<void>(resolve => { enteredListener = resolve; });
const heldListener = new Promise<void>(resolve => { releaseListener = resolve; });
const drainBudgets: number[] = [];
const healthWaits: boolean[] = [];
// Accepted stop timers are observed, never executed: this fixture must not exit or drain the host.
globalThis.setTimeout = ((work: () => void, ms?: number, ...args: unknown[]) => {
  if (ms === 200) { scheduledStops.push(work); return 0; }
  return nativeTimeout(work, ms, ...args);
}) as typeof setTimeout;
async function beginStop() {
  const req = new Request("http://127.0.0.1:10100/api/stop", { method: "POST", headers: { Host: "127.0.0.1:10100" } });
  let early: unknown;
  const settled = handleManagementAPI(req, new URL(req.url), config as never, {}, "admin-token")
    .then(response => ({ status: response?.status }), error => ({ error: String(error) }))
    .then(result => { early = result; return result; });
  while (!waiting.length) {
    if (early) throw new Error(`stop did not enter teardown: ${JSON.stringify(early)}`);
    await new Promise(resolve => nativeTimeout(resolve, 1));
  }
  return { settled, work: waiting.shift()! };
}
function startRestart() {
  const observed = { spawned: 0 };
  let scheduled: (() => void | Promise<void>) | undefined;
  acceptSystemRestart({
    now: () => now,
    isShutdownDraining: () => false, getActiveTurnCount: () => 0,
    acquireTemporaryDrain: () => ({ release() {} }), beginShutdownDrain() {},
    schedule: work => { scheduled = work; }, scheduleDeadline: () => () => {},
    drainAndShutdown: async (_server, ms) => {
      drainBudgets.push(ms ?? -1); enteredDrain();
      if (mode.startsWith("drain-")) await heldDrain;
      return true;
    }, stopListener: async () => {
      enteredListener();
      if (mode.startsWith("listener-")) await heldListener;
    }, listenPort: () => 10100,
    isDesktopSupervised: () => false, isSupervisedServiceChild: () => false,
    spawnStart(_port, waitForHealth) { observed.spawned++; healthWaits.push(waitForHealth ?? true); }, markRecycling() {}, exitProcess() {},
  }, { onAccepted() {}, beforeScheduledDrain: () => true });
  if (!scheduled) throw new Error("restart probe was not scheduled");
  return { observed, done: Promise.resolve(scheduled()) };
}
try {
  const restartBeforeStop = mode.startsWith("drain-") || mode.startsWith("listener-") ? startRestart() : undefined;
  if (restartBeforeStop) await (mode.startsWith("listener-") ? listenerEntered : drainEntered);
  const first = await beginStop();
  const outcomes: unknown[] = [];
  const restart = restartBeforeStop ?? startRestart();
  if (restartBeforeStop) releaseDrain();
  if (mode.startsWith("listener-")) releaseListener();
  for (let i = 0; i < 20; i++) await Promise.resolve();
  const probes: number[] = [restart.observed.spawned];
  if (mode === "concurrent-refusals" || mode === "accepted-control") {
    const second = await beginStop();
    first.work.resolve(mode === "accepted-control" ? accepted : refused);
    outcomes.push(await first.settled);
    await Promise.resolve();
    probes.push(restart.observed.spawned);
    second.work.resolve(refused);
    outcomes.push(await second.settled);
  } else {
    if (mode === "signal-control") noteExplicitShutdownRequested();
    if (mode.includes("deadline-")) now += 60_001;
    if (mode === "throws" || mode === "drain-throws") first.work.reject(new Error("fixture teardown error"));
    else first.work.resolve(refused);
    outcomes.push(await first.settled);
  }
  await restart.done;
  probes.push(restart.observed.spawned);
  console.log(JSON.stringify({ probes, outcomes, scheduledStops: scheduledStops.length, drainBudgets, healthWaits }));
} finally { globalThis.setTimeout = nativeTimeout; }
