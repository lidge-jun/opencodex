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
import { activeRegistryMetrics, tryAdmitTurn } from "../src/server/lifecycle";
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

function fakeServer() {
  let stops = 0;
  return {
    server: { stop() { stops++; } } as unknown as ReturnType<typeof Bun.serve>,
    stops: () => stops,
  };
}

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
      setTimer(callback) {
        const timer = setTimeout(callback, 0);
        timer.unref?.();
        return timer;
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
