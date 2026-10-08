/** #6643: an explicit short grace preserves the default drain and cleanup budget. */
import { afterEach, expect, spyOn, test } from "bun:test";
import {
  acceptSystemRestart,
  setSystemRestartIoForTests,
  noteExplicitShutdownRequested,
} from "../../src/server/management/system-restart";

import {
  abortAndReleaseAllTurns,
  acquireTemporaryDrain,
  drainAndShutdown,
  getActiveTurnCount,
  isDraining,
  registerTurn,
  resetLifecycleDrainStateForTests,
  stopServerListener,
  tryAdmitTurn,
} from "../../src/server/lifecycle";
import { handleManagementAPI } from "../../src/server/management-api";
import { handleSystemRoutes } from "../../src/server/management/system-routes";
import { ManagementRequest } from "../helpers/management-auth";
import type { OcxConfig } from "../../src/types";

afterEach(() => setSystemRestartIoForTests());

const apiConfig: OcxConfig = {
  port: 10100,
  defaultProvider: "openai",
  providers: { openai: { adapter: "openai-chat", baseUrl: "https://api.example.test/v1", apiKey: "fixture", defaultModel: "fixture" } },
};

function apiRequest(body?: string) {
  return new ManagementRequest("http://127.0.0.1:10100/api/system/restart", {
    method: "POST", body, headers: body === undefined ? undefined : { "Content-Type": "application/json" },
  });
}

test("empty API requests and empty objects retain the 60-second default", async () => {
  for (const payload of [undefined, "{}"]) {
    const delays: number[] = [];
    setSystemRestartIoForTests({ isDraining: () => false, schedule: (_fn, ms) => { delays.push(ms); }, setDraining: () => {} });
    const req = apiRequest(payload);
    const res = await handleManagementAPI(req, new URL(req.url), apiConfig);
    expect(res?.status).toBe(202);
    expect((await res!.json()).drainTimeoutMs).toBe(60_000);
    expect(delays).toEqual([200]);
  }
});

test("the API explicitly opts into short grace and repeated requests retain the accepted grace", async () => {
  let scheduled = 0;
  setSystemRestartIoForTests({ isDraining: () => false, schedule: () => { scheduled += 1; }, setDraining: () => {} });
  for (const payload of ['{"drainGraceMs":2000}', undefined, '{"drainGraceMs":1000}']) {
    const req = apiRequest(payload);
    const res = await handleManagementAPI(req, new URL(req.url), apiConfig);
    expect(res?.status).toBe(202);
    expect((await res!.json()).drainTimeoutMs).toBe(2_000);
  }
  expect(scheduled).toBe(1);
});

test("a repeated API opt-in cannot shorten an existing default restart", async () => {
  setSystemRestartIoForTests({ isDraining: () => false, schedule: () => {}, setDraining: () => {} });
  for (const payload of [undefined, '{"drainGraceMs":2000}']) {
    const req = apiRequest(payload);
    const res = await handleManagementAPI(req, new URL(req.url), apiConfig);
    expect((await res!.json()).drainTimeoutMs).toBe(60_000);
  }
});

test("invalid API grace or malformed JSON is rejected without beginning a drain", async () => {
  let scheduled = 0;
  let drains = 0;
  setSystemRestartIoForTests({ isDraining: () => false, schedule: () => { scheduled += 1; }, setDraining: () => { drains += 1; } });
  const invalid = [0, -1, 60_001, 1.5, null, "2000", true];
  for (const payload of [...invalid.map(drainGraceMs => JSON.stringify({ drainGraceMs })), "{", "null", "[]", '"2000"']) {
    const req = apiRequest(payload);
    const res = await handleManagementAPI(req, new URL(req.url), apiConfig);
    expect(res?.status).toBe(400);
  }
  expect(scheduled).toBe(0);
  expect(drains).toBe(0);
});

test("the API accepts both supported grace boundaries", async () => {
  for (const drainGraceMs of [1, 60_000]) {
    setSystemRestartIoForTests({ isDraining: () => false, schedule: () => {}, scheduleDeadline: () => () => {}, setDraining: () => {} });
    const req = apiRequest(JSON.stringify({ drainGraceMs }));
    const res = await handleManagementAPI(req, new URL(req.url), apiConfig);
    expect(res?.status).toBe(202);
    expect((await res!.json()).drainTimeoutMs).toBe(drainGraceMs);
  }
});

test("a target-bound restart capability cannot opt into an unsigned grace option", async () => {
  let scheduled = 0;
  setSystemRestartIoForTests({ isDraining: () => false, schedule: () => { scheduled += 1; }, setDraining: () => {} });
  const req = apiRequest('{"drainGraceMs":2000}');
  const res = await handleSystemRoutes({ req, url: new URL(req.url), config: apiConfig, deps: {}, version: "fixture", principal: "system-restart-capability" });
  expect(res?.status).toBe(403);
  expect(scheduled).toBe(0);
  const defaultReq = apiRequest();
  const accepted = await handleSystemRoutes({ req: defaultReq, url: new URL(defaultReq.url), config: apiConfig, deps: {}, version: "fixture", principal: "system-restart-capability" });
  expect(accepted?.status).toBe(202);
  expect((await accepted!.json()).drainTimeoutMs).toBe(60_000);
  expect(scheduled).toBe(1);
});

test("restart spends at most two seconds on active turns, including the response-flush delay", async () => {
  let now = 10_000;
  let scheduled!: () => void | Promise<void>;
  let turnWaitMs = -1;
  let cleanupWaitMs = -1;
  acceptSystemRestart({
    now: () => now,
    isDraining: () => false,
    getActiveTurnCount: () => 1,
    setDraining: () => {},
    schedule: fn => { scheduled = fn; },
    scheduleDeadline: (_fn, ms) => { cleanupWaitMs = ms; return () => {}; },
    drainAndShutdown: async (_server, ms) => { turnWaitMs = ms; },
    isDesktopSupervised: () => false,
    isSupervisedServiceChild: () => false,
    listenPort: () => 10123,
    stopListener: () => {},
    spawnStart: () => {},
    markRecycling: () => {},
    exitProcess: () => {},
  }, {}, { drainGraceMs: 2_000 });
  now += 200;
  await scheduled();
  expect(turnWaitMs).toBe(1_800);
  expect(cleanupWaitMs).toBe(59_800);
});


class RestartClock {
  now = 10_000;
  private timers = new Set<{ at: number; run: () => void }>();
  schedule = (run: () => void, ms: number) => {
    const timer = { at: this.now + ms, run };
    this.timers.add(timer);
    return () => { this.timers.delete(timer); };
  };
  async settle() {
    // Let real shutdown cleanup promises settle without advancing virtual time.
    for (let i = 0; i < 40; i += 1) await Promise.resolve();
  }
  async advance(ms: number) {
    const until = this.now + ms;
    while (true) {
      const next = [...this.timers].filter(timer => timer.at <= until)
        .sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      this.now = next.at;
      this.timers.delete(next);
      next.run();
      await this.settle();
    }
    this.now = until;
    await this.settle();
  }
}

const restore: Array<() => void> = [];
afterEach(() => {
  for (const reset of restore.splice(0)) reset();
  abortAndReleaseAllTurns();
  resetLifecycleDrainStateForTests();
});

function restartFixture(options: { automatic?: boolean; supervised?: boolean; holdCleanup?: boolean; holdReadiness?: boolean; failSpawn?: boolean; flushDelayMs?: number; useDefaultGrace?: boolean; drainGraceMs?: number } = {}) {
  const clock = new RestartClock();
  const date = spyOn(Date, "now").mockImplementation(() => clock.now);
  const sleep = spyOn(Bun, "sleep").mockImplementation((ms) => new Promise(resolve => {
    clock.schedule(resolve, typeof ms === "number" ? ms : ms.getTime() - clock.now);
  }));
  restore.push(() => date.mockRestore(), () => sleep.mockRestore());
  const calls: string[] = [];
  const scheduleDelays: number[] = [];
  const deadlineDelays: number[] = [];
  const cancelledDeadlines: number[] = [];
  let finishCleanup!: () => void;
  const cleanup = new Promise<void>(resolve => { finishCleanup = resolve; });
  let finishReadiness!: () => void;
  const readiness = new Promise<void>(resolve => { finishReadiness = resolve; });
  let veto!: () => void;
  let running: void | Promise<void>;
  const server = {
    stop: () => { calls.push(`stop:${clock.now}`); },
  } as unknown as ReturnType<typeof Bun.serve>;
  const accept = () => acceptSystemRestart({
    now: () => clock.now,
    getActiveTurnCount,
    schedule: (fn, ms) => { scheduleDelays.push(ms); clock.schedule(() => { running = fn(); }, options.flushDelayMs ?? ms); },
    scheduleDeadline: (fn, ms) => {
      deadlineDelays.push(ms);
      const cancel = clock.schedule(fn, ms);
      return () => { cancelledDeadlines.push(ms); cancel(); };
    },
    drainAndShutdown: async (_server, ms) => {
      calls.push(`drain:${ms}`);
      const result = await drainAndShutdown(server, ms);
      if (options.holdCleanup) await cleanup;
      return result;
    },
    stopListener: () => stopServerListener(server),
    listenPort: () => 10123,
    isDesktopSupervised: () => false,
    isSupervisedServiceChild: () => options.supervised ?? false,
    spawnStart: async (port, waitForHealth) => {
      calls.push(`spawn:${port}:${waitForHealth}:${clock.now}`);
      if (options.failSpawn) throw Object.assign(new Error("fixture"), { code: "EACCES" });
      if (options.holdReadiness) await readiness;
    },
    markRecycling: () => { calls.push("recycle"); },
    isClientConnected: () => false,
    exitProcess: code => { calls.push(`exit:${code}`); },
  }, options.automatic ? { onAccepted: callback => { veto = callback; } } : {}, options.useDefaultGrace ? {} : { drainGraceMs: options.drainGraceMs ?? 2_000 });
  return { clock, calls, scheduleDelays, deadlineDelays, cancelledDeadlines, accept, finishCleanup, finishReadiness, veto: () => veto(), running: () => running };
}

function upstreamTurn(bindController = true) {
  const lease = tryAdmitTurn();
  expect(lease).not.toBeNull();
  const controller = new AbortController();
  if (bindController) registerTurn(controller, lease!);
  // The admitted handler may have sent work whose upstream outcome is not yet known.
  return { lease: lease!, controller };
}

for (const drainGraceMs of [1, 199]) {
  for (const supervised of [false, true]) {
    test(`${drainGraceMs}ms ${supervised ? "supervised" : "standalone"} restart cuts turns by the accepted deadline but waits 200ms to shut down`, async () => {
      const fixture = restartFixture({ drainGraceMs, supervised });
      const turn = upstreamTurn();
      const acceptedAtMs = fixture.clock.now;
      expect(fixture.accept().drainTimeoutMs).toBe(drainGraceMs);
      expect(fixture.accept().alreadyDraining).toBe(true);
      await fixture.clock.advance(drainGraceMs - 1);
      expect(turn.controller.signal.aborted).toBe(false);
      expect(getActiveTurnCount()).toBe(1);
      await fixture.clock.advance(1);
      expect(fixture.clock.now - acceptedAtMs).toBe(drainGraceMs);
      expect(turn.controller.signal.aborted).toBe(true);
      expect(getActiveTurnCount()).toBe(0);
      expect(fixture.scheduleDelays).toEqual([200]);
      expect(fixture.deadlineDelays).toEqual([drainGraceMs]);
      expect(fixture.calls).toEqual([]);
      await fixture.clock.advance(199 - drainGraceMs);
      expect(fixture.calls).toEqual([]);
      await fixture.clock.advance(1);
      await fixture.running();
      expect(fixture.calls).toContain("drain:0");
      expect(fixture.calls).toContain(`stop:${acceptedAtMs + 200}`);
      expect(fixture.calls).toContain(`exit:${supervised ? 1 : 0}`);
      expect(fixture.calls.filter(call => call.startsWith("spawn:"))).toEqual(supervised ? [] : [`spawn:10123:true:${acceptedAtMs + 200}`]);
      expect(tryAdmitTurn()).toBeNull();
    });
  }
}

for (const options of [{ drainGraceMs: 200 }, { drainGraceMs: 60_000 }, { useDefaultGrace: true }]) {
  test(`restart ${JSON.stringify(options)} arms no early cut`, () => {
    const fixture = restartFixture(options);
    fixture.accept();
    expect(fixture.scheduleDelays).toEqual([200]);
    expect(fixture.deadlineDelays).toEqual([]);
  });
}

test("vetoing a pending short-grace automatic restart cancels its early cut", async () => {
  const fixture = restartFixture({ automatic: true, drainGraceMs: 1 });
  const turn = upstreamTurn();
  fixture.accept();
  expect(fixture.deadlineDelays).toEqual([1]);
  fixture.veto();
  expect(fixture.cancelledDeadlines).toEqual([1]);
  await fixture.clock.advance(200);
  expect(turn.controller.signal.aborted).toBe(false);
  expect(getActiveTurnCount()).toBe(1);
  expect(fixture.calls).toEqual([]);
  expect(isDraining()).toBe(false);
});

for (const automatic of [false, true]) {
  const mode = automatic ? "automatic" : "manual";
  test(`${mode} default restart preserves active work beyond two seconds`, async () => {
    const fixture = restartFixture({ automatic, useDefaultGrace: true });
    const turn = upstreamTurn();
    expect(fixture.accept().drainTimeoutMs).toBe(60_000);
    await fixture.clock.advance(2_000);
    expect(turn.controller.signal.aborted).toBe(false);
    expect(getActiveTurnCount()).toBe(1);
    turn.lease.release();
    await fixture.clock.advance(100);
    await fixture.running();
    expect(turn.controller.signal.aborted).toBe(false);
    expect(fixture.calls).toContain("drain:59800");
  });
  test(`${mode} restart preserves a completed turn and hands off without spending the grace`, async () => {
    const fixture = restartFixture({ automatic });
    const turn = upstreamTurn();
    turn.lease.release();
    expect(fixture.accept().drainTimeoutMs).toBe(2_000);
    expect(tryAdmitTurn()).toBeNull();
    await fixture.clock.advance(200);
    await fixture.running();
    expect(fixture.calls).toContain("spawn:10123:true:10200");
    expect(turn.controller.signal.aborted).toBe(false);
  });

  test(`${mode} restart lets a turn finish inside the grace without abort`, async () => {
    const fixture = restartFixture({ automatic });
    const turn = upstreamTurn();
    fixture.accept();
    await fixture.clock.advance(700);
    expect(turn.controller.signal.aborted).toBe(false);
    expect(fixture.calls.some(call => call.startsWith("spawn:"))).toBe(false);
    turn.lease.release();
    await fixture.clock.advance(100);
    await fixture.running();
    expect(fixture.calls).toContain("spawn:10123:true:10800");
    expect(turn.controller.signal.aborted).toBe(false);
  });

  test(`${mode} restart cuts an ambiguous active turn at grace expiry`, async () => {
    const fixture = restartFixture({ automatic });
    const turn = upstreamTurn();
    fixture.accept();
    await fixture.clock.advance(1_999);
    expect(turn.controller.signal.aborted).toBe(false);
    expect(getActiveTurnCount()).toBe(1);
    await fixture.clock.advance(1);
    await fixture.running();
    expect(turn.controller.signal.aborted).toBe(true);
    expect(getActiveTurnCount()).toBe(0);
    expect(fixture.calls).toContain("spawn:10123:true:12000");
    // Successful cleanup/readiness does not reopen admission in the old process.
    expect(tryAdmitTurn()).toBeNull();
  });
}

test("an admitted turn without a controller is released at the same deadline", async () => {
  const fixture = restartFixture();
  upstreamTurn(false);
  fixture.accept();
  await fixture.clock.advance(2_000);
  await fixture.running();
  expect(getActiveTurnCount()).toBe(0);
  expect(fixture.calls).toContain("exit:0");
});

test("client cancellation finishes the drain without waiting out the grace", async () => {
  const fixture = restartFixture();
  const turn = upstreamTurn();
  turn.controller.signal.addEventListener("abort", () => turn.lease.release(), { once: true });
  fixture.accept();
  await fixture.clock.advance(300);
  turn.controller.abort(new Error("client cancelled"));
  await fixture.clock.advance(100);
  await fixture.running();
  expect(fixture.calls).toContain("spawn:10123:true:10400");
});

test("held cleanup retains the original 60s watchdog and ignores late completion", async () => {
  const fixture = restartFixture({ holdCleanup: true });
  fixture.accept();
  await fixture.clock.advance(2_000);
  expect(fixture.calls.some(call => call.startsWith("spawn:"))).toBe(false);
  expect(isDraining()).toBe(true);
  await fixture.clock.advance(58_000);
  await fixture.running();
  expect(fixture.calls).toContain("spawn:10123:false:70000");
  fixture.finishCleanup();
  await fixture.clock.settle();
  expect(fixture.calls.filter(call => call.startsWith("spawn:"))).toHaveLength(1);
  expect(fixture.calls.filter(call => call.startsWith("exit:"))).toEqual(["exit:0"]);
});

test("delayed replacement readiness does not reopen the old process while a cut turn stays aborted", async () => {
  const fixture = restartFixture({ holdReadiness: true });
  const turn = upstreamTurn();
  fixture.accept();
  await fixture.clock.advance(2_000);
  expect(fixture.calls).toContain("spawn:10123:true:12000");
  await fixture.clock.advance(65_000);
  expect(fixture.calls.some(call => call.startsWith("exit:"))).toBe(false);
  expect(tryAdmitTurn()).toBeNull();
  expect(turn.controller.signal.aborted).toBe(true);
  fixture.finishReadiness();
  await fixture.running();
  expect(fixture.calls).toContain("exit:0");
});

test("automatic pending cancellation releases only its admission fence", async () => {
  const fixture = restartFixture({ automatic: true });
  fixture.accept();
  expect(isDraining()).toBe(true);
  fixture.veto();
  await fixture.clock.advance(2_000);
  expect(fixture.calls).toEqual([]);
  const admitted = tryAdmitTurn();
  expect(admitted).not.toBeNull();
  admitted?.release();
});

for (const automatic of [false, true]) {
  test(`explicit stop during ${automatic ? "automatic" : "manual"} grace preserves restart ownership`, async () => {
    const fixture = restartFixture({ automatic });
    upstreamTurn();
    fixture.accept();
    await fixture.clock.advance(200);
    noteExplicitShutdownRequested();
    await fixture.clock.advance(1_800);
    await fixture.running();
    expect(fixture.calls.filter(call => call.startsWith("spawn:"))).toHaveLength(automatic ? 0 : 1);
    expect(isDraining()).toBe(true);
  });
}

test("spawn failure after a cut turn exits once without recycling", async () => {
  const fixture = restartFixture({ failSpawn: true });
  upstreamTurn();
  fixture.accept();
  await fixture.clock.advance(2_000);
  await fixture.running();
  expect(fixture.calls.filter(call => call.startsWith("exit:"))).toEqual(["exit:1"]);
  expect(fixture.calls).not.toContain("recycle");
});

test("waiting to enter the drain microtask does not renew the acceptance-based grace", async () => {
  let now = 10_000;
  let scheduled!: () => void | Promise<void>;
  let turnWaitMs = -1;
  acceptSystemRestart({
    now: () => now,
    isDraining: () => false,
    getActiveTurnCount: () => 1,
    setDraining: () => {},
    schedule: fn => { scheduled = fn; },
    scheduleDeadline: () => () => {},
    drainAndShutdown: async (_server, ms) => { turnWaitMs = ms; },
    isDesktopSupervised: () => false,
    isSupervisedServiceChild: () => false,
    listenPort: () => 10123,
    stopListener: () => {},
    spawnStart: () => {},
    markRecycling: () => {},
    exitProcess: () => {},
  }, {}, { drainGraceMs: 2_000 });
  now += 200;
  const running = scheduled();
  now += 350;
  await running;
  expect(turnWaitMs).toBe(1_450);
});

test("a non-round response-flush delay does not extend grace by a full lifecycle poll", async () => {
  const fixture = restartFixture({ flushDelayMs: 275 });
  const turn = upstreamTurn();
  fixture.accept();
  await fixture.clock.advance(1_999);
  expect(turn.controller.signal.aborted).toBe(false);
  await fixture.clock.advance(1);
  await fixture.running();
  expect(turn.controller.signal.aborted).toBe(true);
  expect(fixture.calls).toContain("drain:1725");
  expect(fixture.calls).toContain("spawn:10123:true:12000");
});

test("an existing scoped drain and active turn share the same grace", async () => {
  const fixture = restartFixture();
  const turn = upstreamTurn();
  const scoped = acquireTemporaryDrain("fixture-scoped-drain");
  expect(scoped).not.toBeNull();
  fixture.accept();
  await fixture.clock.advance(500);
  expect(fixture.calls).toEqual(["drain:1800"]);
  scoped!.release();
  await fixture.clock.settle();
  await fixture.clock.advance(1_499);
  expect(turn.controller.signal.aborted).toBe(false);
  await fixture.clock.advance(1);
  await fixture.running();
  expect(turn.controller.signal.aborted).toBe(true);
  expect(fixture.calls).toContain("spawn:10123:true:12000");
});
