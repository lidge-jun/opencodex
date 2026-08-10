import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { create } from "@bufbuild/protobuf";
import { afterEach, describe, expect, test } from "bun:test";
import {
  drainAndShutdown,
  registerTurn,
  unregisterTurn,
  isDraining,
  getActiveTurnCount,
  trackStreamLifetime,
  isRecyclingForExit,
  markRecyclingForExit,
} from "../src/server";
import {
  acquireTemporaryDrain,
  acquireNativeMainProfileDrain,
  activeRegistryMetrics,
  beginShutdownDrain,
  releaseServerStartupLifecycle,
  resetLifecycleDrainStateForTests,
  setServerStartupLifecycleReleaseForTests,
  stopServerListener,
  tryAdmitTurn,
  codexAccountSelectionForTurn,
  getNativeMainProfileRequestCount,
} from "../src/server/lifecycle";
import {
  backgroundShellAdmissionMetrics,
  backgroundShellSpawnExec,
  resetBackgroundShellStateForTests,
  setBackgroundShellRuntimeForTests,
} from "../src/adapters/cursor/native-exec-shell";
import { BackgroundShellSpawnArgsSchema, ExecServerMessageSchema } from "../src/adapters/cursor/gen/agent_pb";

class ShutdownFakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 9876;
}

afterEach(async () => {
  await resetBackgroundShellStateForTests();
  resetLifecycleDrainStateForTests();
});

function installShutdownShell() {
  const child = new ShutdownFakeChild();
  setBackgroundShellRuntimeForTests({
    spawn: (() => child as unknown as ChildProcessWithoutNullStreams) as typeof import("node:child_process").spawn,
    kill: () => true,
  });
  backgroundShellSpawnExec(create(ExecServerMessageSchema, {
    id: 1,
    execId: "shutdown-shell",
    message: {
      case: "backgroundShellSpawnArgs",
      value: create(BackgroundShellSpawnArgsSchema, { command: "fixture" }),
    },
  }), "shutdown-session");
  return child;
}

function fakeServer(stopImpl?: (closeActiveConnections?: boolean) => void | Promise<void>) {
  let stops = 0;
  const stopArgs: Array<boolean | undefined> = [];
  return {
    server: {
      stop(closeActiveConnections?: boolean) {
        stops++;
        stopArgs.push(closeActiveConnections);
        return stopImpl?.(closeActiveConnections);
      },
    } as unknown as ReturnType<typeof Bun.serve>,
    stops: () => stops,
    stopArgs: () => stopArgs,
  };
}

describe("server listener shutdown", () => {
  test("single-flights stop(true) and keeps every waiter pending until close completes", async () => {
    let resolveStop!: () => void;
    const fake = fakeServer(() => new Promise<void>(resolve => { resolveStop = resolve; }));
    let firstSettled = false;
    let secondSettled = false;

    const first = stopServerListener(fake.server).then(() => { firstSettled = true; });
    const second = stopServerListener(fake.server).then(() => { secondSettled = true; });
    await Promise.resolve();

    expect(fake.stops()).toBe(1);
    expect(fake.stopArgs()).toEqual([true]);
    expect(firstSettled).toBe(false);
    expect(secondSettled).toBe(false);

    resolveStop();
    await Promise.all([first, second]);
    expect(firstSettled).toBe(true);
    expect(secondSettled).toBe(true);
    expect(fake.stops()).toBe(1);
  });

  test("retains a rejected stop flight instead of retrying an uncertain listener", async () => {
    const failure = new Error("fixture listener stop rejection");
    const fake = fakeServer(async () => { throw failure; });

    const first = stopServerListener(fake.server);
    const second = stopServerListener(fake.server);
    await expect(first).rejects.toBe(failure);
    await expect(second).rejects.toBe(failure);
    await expect(stopServerListener(fake.server)).rejects.toBe(failure);
    expect(fake.stops()).toBe(1);
    expect(fake.stopArgs()).toEqual([true]);
  });

  test("keeps socket close available while normal drain waits on held startup cleanup", async () => {
    let signalReleaseStarted!: () => void;
    const releaseStarted = new Promise<void>(resolve => { signalReleaseStarted = resolve; });
    let allowRelease!: () => void;
    const releaseGate = new Promise<void>(resolve => { allowRelease = resolve; });
    let releases = 0;
    setServerStartupLifecycleReleaseForTests(async () => {
      releases += 1;
      signalReleaseStarted();
      await releaseGate;
    });
    const fake = fakeServer();
    let drainSettled = false;
    const draining = drainAndShutdown(fake.server, 0).then(() => { drainSettled = true; });

    await releaseStarted;
    expect(fake.stops()).toBe(1);
    expect(fake.stopArgs()).toEqual([true]);
    await stopServerListener(fake.server);
    expect(drainSettled).toBe(false);

    let secondReleaseSettled = false;
    const secondRelease = releaseServerStartupLifecycle(fake.server).then(() => {
      secondReleaseSettled = true;
    });
    await Promise.resolve();
    expect(releases).toBe(1);
    expect(secondReleaseSettled).toBe(false);

    allowRelease();
    await Promise.all([draining, secondRelease]);
    expect(drainSettled).toBe(true);
    expect(secondReleaseSettled).toBe(true);
    expect(releases).toBe(1);
  });
});

describe("active turn tracking", () => {
  test("admit/bind/unregister tracks active turns through the boundary lease", () => {
    const ac1 = new AbortController();
    const ac2 = new AbortController();
    const before = getActiveTurnCount();
    const lease1 = tryAdmitTurn();
    const lease2 = tryAdmitTurn();
    expect(lease1).not.toBeNull();
    expect(lease2).not.toBeNull();
    registerTurn(ac1, lease1!);
    registerTurn(ac2, lease2!);
    expect(getActiveTurnCount()).toBe(before + 2);
    unregisterTurn(ac1);
    expect(getActiveTurnCount()).toBe(before + 1);
    unregisterTurn(ac2);
    expect(getActiveTurnCount()).toBe(before);
  });

  test("isDraining() is false by default", () => {
    expect(isDraining()).toBe(false);
  });

  test("shutdown first rejects profile leases and remains latched after scoped release attempts", () => {
    expect(beginShutdownDrain()).toBe(true);
    expect(acquireTemporaryDrain("native-profile")).toBeNull();
    expect(acquireNativeMainProfileDrain("native-main-profile")).toBeNull();
    expect(isDraining()).toBe(true);
  });

  test("terminal shutdown dominates a native-main scoped drain and prevents all new traffic", () => {
    const profileLease = acquireNativeMainProfileDrain("native-main-profile");
    expect(profileLease).not.toBeNull();
    expect(isDraining()).toBe(false);
    const admitted = tryAdmitTurn();
    expect(admitted).not.toBeNull();
    const selection = codexAccountSelectionForTurn(admitted!)!();
    expect(selection?.mainProfileDraining).toBe(true);
    expect(selection?.claimMainProfile()).toBe(false);
    selection?.release();
    admitted?.release();

    expect(beginShutdownDrain()).toBe(true);
    expect(tryAdmitTurn()).toBeNull();
    expect(acquireNativeMainProfileDrain("second-switch")).toBeNull();
    profileLease?.release();
    expect(isDraining()).toBe(true);
  });

  test("a pre-fence selector atomically converts to main turn ownership", () => {
    const turn = tryAdmitTurn();
    const selection = codexAccountSelectionForTurn(turn!)!();
    expect(selection?.mainProfileDraining).toBe(false);
    expect(getNativeMainProfileRequestCount()).toBe(1);

    const profileLease = acquireNativeMainProfileDrain("native-main-profile");
    expect(profileLease).not.toBeNull();
    expect(selection?.claimMainProfile()).toBe(true);
    selection?.release();
    expect(getNativeMainProfileRequestCount()).toBe(1);

    turn?.release();
    expect(getNativeMainProfileRequestCount()).toBe(0);
    profileLease?.release();
  });

  test("deadline forces shutdown past a never-releasing profile lease and keeps the latch terminal", async () => {
    const profileLease = acquireTemporaryDrain("native-profile");
    expect(profileLease).not.toBeNull();
    const fake = fakeServer();

    await drainAndShutdown(fake.server, 0);

    expect(fake.stops()).toBe(1);
    expect(fake.stopArgs()).toEqual([true]);
    expect(isDraining()).toBe(true);
    profileLease?.release();
    expect(isDraining()).toBe(true);
    expect(tryAdmitTurn()).toBeNull();
  });

  test("profile-first shutdown resumes on normal early lease release", async () => {
    const profileLease = acquireTemporaryDrain("native-profile");
    expect(profileLease).not.toBeNull();
    const fake = fakeServer();
    let settled = false;
    const draining = drainAndShutdown(fake.server, 1_000).then(() => { settled = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    profileLease?.release();
    await draining;

    expect(fake.stops()).toBe(1);
    expect(isDraining()).toBe(true);
  });

  test("forced shutdown releases an admitted turn before controller binding", async () => {
    const before = getActiveTurnCount();
    const releaseMissesBefore = activeRegistryMetrics().activeTurns.releaseMisses;
    const lease = tryAdmitTurn();
    expect(lease).not.toBeNull();
    expect(getActiveTurnCount()).toBe(before + 1);

    await drainAndShutdown(undefined, 0);

    expect(getActiveTurnCount()).toBe(before);
    const lateController = new AbortController();
    registerTurn(lateController, lease!);
    expect(lateController.signal.aborted).toBe(true);
    unregisterTurn(lateController);
    lease?.release();
    expect(getActiveTurnCount()).toBe(before);
    expect(activeRegistryMetrics().activeTurns.releaseMisses).toBe(releaseMissesBefore);
  });
});

describe("background shell shutdown drain", () => {
  test("drainAndShutdown awaits the global background-shell drain", async () => {
    const child = installShutdownShell();
    const fake = fakeServer();
    let settled = false;
    const draining = drainAndShutdown(fake.server, 0).then(() => { settled = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(fake.stops()).toBe(0);
    child.emit("close", 0, null);
    await draining;
    expect(fake.stops()).toBe(1);
  });

  test("shell drain rejection or unresolved termination still calls server.stop", async () => {
    const unresolvedChild = installShutdownShell();
    setBackgroundShellRuntimeForTests({
      // Collapse grace waits to next tick; keep the timer ref'd so isolate does
      // not starve the waiter the way an unref'd setTimeout can.
      setTimer(callback) {
        // Keep this fixture timer REF'D: Bun on Windows can stop servicing
        // unref'd timers while the test's only pending work is a promise,
        // which left drainAndShutdown waiting forever and hung the isolate
        // process until the 20-minute CI job timeout (same starvation the
        // OAuth queue tests hit). A ref'd 0ms timer fires immediately and
        // cannot keep the process alive.
        return setTimeout(callback, 0);
      },
    });
    const unresolvedServer = fakeServer();
    await drainAndShutdown(unresolvedServer.server, 0);
    expect(unresolvedServer.stops()).toBe(1);
    expect(backgroundShellAdmissionMetrics().active).toBe(1);
    unresolvedChild.emit("close", 0, null);
    await resetBackgroundShellStateForTests();

    const rejectedChild = installShutdownShell();
    setBackgroundShellRuntimeForTests({
      setTimer() { throw new Error("timer fixture rejection"); },
    });
    const rejectedServer = fakeServer();
    await drainAndShutdown(rejectedServer.server, 0);
    expect(rejectedServer.stops()).toBe(1);
    rejectedChild.emit("close", 0, null);
  });

  test("activeRegistryMetrics exposes cursor background-shell admission scalars", () => {
    const child = installShutdownShell();
    const metrics = activeRegistryMetrics().cursorBackgroundShells;
    expect(metrics).toEqual(backgroundShellAdmissionMetrics());
    expect(metrics.active).toBe(1);
    expect(Object.values(metrics).every(value => typeof value === "number")).toBe(true);
    child.emit("close", 0, null);
  });
});

describe("trackStreamLifetime", () => {
  test("registers on start and unregisters on stream close", async () => {
    const enc = new TextEncoder();
    const chunks = [enc.encode("hello"), enc.encode("world")];
    let i = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i < chunks.length) controller.enqueue(chunks[i++]);
        else controller.close();
      },
    });
    const ac = new AbortController();
    const before = getActiveTurnCount();
    const lease = tryAdmitTurn();
    expect(lease).not.toBeNull();
    const tracked = trackStreamLifetime(source, ac, undefined, lease!);
    expect(getActiveTurnCount()).toBe(before + 1);

    const reader = tracked.getReader();
    const dec = new TextDecoder();
    let text = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += dec.decode(value, { stream: true });
    }
    expect(text).toBe("helloworld");
    expect(getActiveTurnCount()).toBe(before);
  });

  test("unregisters on cancel", async () => {
    const source = new ReadableStream<Uint8Array>({
      pull() {
        // never closes — simulate long stream
      },
    });
    const ac = new AbortController();
    const before = getActiveTurnCount();
    const lease = tryAdmitTurn();
    expect(lease).not.toBeNull();
    const tracked = trackStreamLifetime(source, ac, undefined, lease!);
    expect(getActiveTurnCount()).toBe(before + 1);

    await tracked.cancel("test cancel");
    expect(getActiveTurnCount()).toBe(before);
    expect(ac.signal.aborted).toBe(true);
  });
});

describe("recycling exit flag (#563)", () => {
  test("markRecyclingForExit flips the recycle sentinel for syncCleanup", () => {
    expect(isRecyclingForExit()).toBe(false);
    markRecyclingForExit();
    expect(isRecyclingForExit()).toBe(true);
  });
});
