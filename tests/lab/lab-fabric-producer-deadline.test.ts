import { describe, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setImmediate as nextTurn } from "node:timers";
import { runIsolatedFabricProducer } from "../../src/lab/fabric/producer-isolate";
import type { IsolatedProducerResult } from "../../src/lab/fabric/producer-protocol";
import { FabricTaskError, type FabricTaskRunResult, type SyntheticPatchV1 } from "../../src/lab/fabric/types";
import { runFabricSyntheticPatchTaskForRoute } from "../../src/lab/fabric/executor";
import { createLabDestination } from "../../src/lab/live/destination";
import { fabricCorrectPatchExecutor, fabricMockRoute } from "../helpers/fabric-task-test";

// Hand-written valid fixture: an always-reject supervisor must fail the controls.
const PATCH: SyntheticPatchV1 = {
  schemaVersion: 1,
  operations: [{ op: "replace", path: "src/value.txt", contentUtf8: "after\n" }],
};
const RESULT = JSON.stringify({ type: "result", patch: PATCH });
const ACTIVITY = '{"type":"activity"}\n';
const START = 1_000;
const IDLE_MS = 100;
const TOTAL_MS = 250;

class DeadlineChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: Array<NodeJS.Signals | number | undefined> = [];
  closed = false;

  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(signal);
    return true; // Buffered data can arrive after kill; only the test emits close.
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("close", 0, null);
  }
}

type CapturedTimer = { callback: () => void; delay: number; cleared: boolean };
type Outcome<T = IsolatedProducerResult> =
  | { status: "pending" }
  | { status: "resolved"; value: T }
  | { status: "rejected"; error: unknown };

// Drain promise adoption and stream nextTicks, without sleeping or advancing time.
const drain = () => new Promise<void>((resolve) => nextTurn(resolve));

function installTimers(restorers: Array<() => void>) {
  const timers: CapturedTimer[] = [];
  const handles = new Map<ReturnType<typeof setTimeout>, CapturedTimer>();
  const setSpy = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay: number) => {
    const timer = { callback, delay, cleared: false };
    // Only timer identity/unref are consumed by this supervisor; no real handle.
    const handle = { unref() { return this; } } as unknown as ReturnType<typeof setTimeout>;
    timers.push(timer);
    handles.set(handle, timer);
    return handle;
  }) as typeof setTimeout);
  restorers.push(() => setSpy.mockRestore());
  const clearSpy = spyOn(globalThis, "clearTimeout").mockImplementation((handle) => {
    const timer = handles.get(handle as ReturnType<typeof setTimeout>);
    if (timer) timer.cleared = true;
  });
  restorers.push(() => clearSpy.mockRestore());
  return timers;
}

type ExpectedFailure =
  | [code: "inactivity_timeout" | "timeout"]
  | [code: "harness_failure", attribution: "harness", message: string];

type Harness = {
  child: DeadlineChild;
  timers: CapturedTimer[];
  at: (time: number) => void;
  result: (newline?: boolean) => void;
  pending: () => Promise<void>;
  failure: (...expected: ExpectedFailure) => Promise<void>;
  success: (lastActivityAt?: number) => Promise<void>;
};

async function withProducer(body: (h: Harness) => Promise<void>, totalTimeoutMs = TOTAL_MS) {
  const scratchRoot = mkdtempSync(join(tmpdir(), "ocx-fabric-deadline-"));
  const child = new DeadlineChild();
  const originals = { spawn: childProcess.spawn, set: globalThis.setTimeout, clear: globalThis.clearTimeout };
  const restorers: Array<() => void> = [];
  let time = START;
  let outcome: Outcome = { status: "pending" };
  try {
    // Repository namespace-spy precedent; never delegates to the original spawn.
    const spawnSpy = spyOn(childProcess, "spawn").mockImplementation(() => child as unknown as childProcess.ChildProcess);
    restorers.push(() => spawnSpy.mockRestore());
    const timers = installTimers(restorers);
    void runIsolatedFabricProducer({
      scratchRoot, harnessKind: "deterministic_correct", totalTimeoutMs,
      inactivityTimeoutMs: IDLE_MS, now: () => time,
    }).then(
      (value) => { outcome = { status: "resolved", value }; },
      (error: unknown) => { outcome = { status: "rejected", error }; },
    );
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect(spawnSpy.mock.results[0]?.value).toBe(child);
    expect(child.stdout.listenerCount("data")).toBe(1);
    expect(child.listenerCount("close")).toBe(1);
    expect(timers.map(({ delay }) => delay).sort((a, b) => a - b)).toEqual([IDLE_MS, totalTimeoutMs]);
    await body({
      child, timers, at: (value) => { time = value; },
      result: (newline = true) => { child.stdout.write(RESULT + (newline ? "\n" : "")); },
      pending: async () => { await drain(); expect(outcome.status).toBe("pending"); },
      failure: async (...expected) => {
        const [code] = expected;
        const attribution = code === "harness_failure" ? expected[1] : "environment";
        const message = code === "harness_failure" ? expected[2]
          : code === "inactivity_timeout" ? "inactivity timeout exceeded" : "total timeout exceeded";
        child.close();
        await drain();
        expect(outcome.status).toBe("rejected");
        if (outcome.status !== "rejected") throw new Error("producer did not reject after close");
        expect(outcome.error).toBeInstanceOf(FabricTaskError);
        expect(outcome.error).toMatchObject({ code, attribution, message });
        expect(timers.every(({ cleared }) => cleared)).toBe(true);
      },
      success: async (lastActivityAt = START) => {
        await drain();
        expect(outcome).toEqual({ status: "resolved", value: { patch: PATCH, lastActivityAt } });
        expect(child.signals).toEqual([]);
        expect(timers.every(({ cleared }) => cleared)).toBe(true);
      },
    });
    expect(spawnSpy).toHaveBeenCalledTimes(1);
  } finally {
    // Always reap the fake before removing its scratch, including failed assertions.
    try {
      child.close();
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    } finally {
      for (const restore of restorers.reverse()) restore();
      rmSync(scratchRoot, { recursive: true, force: true });
      expect(childProcess.spawn).toBe(originals.spawn);
      expect(globalThis.setTimeout).toBe(originals.set);
      expect(globalThis.clearTimeout).toBe(originals.clear);
    }
  }
}

describe("isolated fabric producer deadline admission", () => {
  test("idle timer then buffered result cannot settle before child close", async () => {
    await withProducer(async (h) => {
      h.at(1_100);
      h.timers[0]!.callback();
      expect(h.child.signals).toEqual(["SIGKILL"]);
      await h.pending();
      h.result();
      await h.pending();
      await h.failure("inactivity_timeout");
    });
  });

  for (const time of [1_100, 1_101]) {
    test(`result at ${time} rejects even when no timer callback ran`, async () => {
      await withProducer(async (h) => {
        h.at(time);
        h.result();
        await h.pending();
        expect(h.child.signals).toEqual(["SIGKILL"]);
        await h.failure("inactivity_timeout");
      });
    });
  }

  test("late activity and result in the same chunk cannot renew idle", async () => {
    await withProducer(async (h) => {
      h.at(1_101);
      h.child.stdout.write(ACTIVITY + RESULT + "\n");
      await h.pending();
      expect(h.timers).toHaveLength(2);
      expect(h.child.signals).toEqual(["SIGKILL"]);
      await h.failure("inactivity_timeout");
    });
  });

  test("total deadline is fixed despite accepted activity", async () => {
    await withProducer(async (h) => {
      for (const time of [1_090, 1_180]) {
        h.at(time);
        h.child.stdout.write(ACTIVITY);
        await h.pending();
        expect(h.child.signals).toEqual([]);
      }
      h.at(1_250);
      h.result();
      await h.pending();
      expect(h.child.signals).toEqual(["SIGKILL"]);
      await h.failure("timeout");
    });
  });

  test("a delayed total callback chooses the earlier elapsed idle deadline", async () => {
    await withProducer(async (h) => {
      h.at(1_251);
      h.timers[1]!.callback();
      await h.pending();
      await h.failure("inactivity_timeout");
    });
  });

  test("inactivity wins an exact deadline tie even if total callback runs first", async () => {
    await withProducer(async (h) => {
      for (const time of [1_090, 1_150]) {
        h.at(time);
        h.child.stdout.write(ACTIVITY);
        await h.pending();
      }
      h.at(1_250);
      h.timers[1]!.callback();
      await h.pending();
      await h.failure("inactivity_timeout");
    });
  });

  test("first timeout survives later timers, protocol and process/stream errors", async () => {
    await withProducer(async (h) => {
      h.at(1_100);
      h.timers[0]!.callback();
      await h.pending();
      h.at(1_251);
      const laterEvents = [
        () => h.timers[1]!.callback(),
        () => h.child.stdout.write('{"type":"error","code":"sandbox_violation","message":"later protocol error","attribution":"harness"}\n'),
        () => h.child.stdout.write("not-json\n"),
        () => h.child.stdout.emit("error", new Error("later stdout error")),
        () => h.child.stderr.emit("error", new Error("later stderr error")),
        () => h.child.stdin.emit("error", new Error("later stdin error")),
        () => h.child.emit("error", new Error("later child error")),
        () => h.child.stdout.write(ACTIVITY),
        () => h.result(),
        () => h.timers[0]!.callback(),
      ];
      for (const event of laterEvents) {
        event();
        await h.pending();
        expect(h.child.signals).toEqual(["SIGKILL"]);
      }
      expect(h.timers).toHaveLength(2);
      await h.failure("inactivity_timeout");
    });
  });

  test("valid result just before idle boundary succeeds", async () => {
    await withProducer(async (h) => {
      h.at(1_099);
      h.result();
      await h.success();
    });
  });

  test("stderr failure stays authoritative until close across later data, errors and timers", async () => {
    await withProducer(async (h) => {
      h.child.stderr.emit("error", new Error("first stderr read failure"));
      await h.pending();
      expect(h.child.signals).toEqual(["SIGKILL"]);
      h.at(1_251);
      const laterEvents = [
        () => h.child.stdout.write(ACTIVITY + RESULT + "\n"),
        () => h.child.stdout.write('{"type":"error","code":"sandbox_violation","message":"later protocol error","attribution":"harness"}\n'),
        () => h.child.stderr.emit("error", new Error("second stderr error")),
        () => h.child.stdout.emit("error", new Error("later stdout error")),
        () => h.child.stdin.emit("error", new Error("later stdin error")),
        () => h.child.emit("error", new Error("later child error")),
        () => h.timers[0]!.callback(),
        () => h.timers[1]!.callback(),
      ];
      for (const event of laterEvents) {
        event();
        await h.pending();
        expect(h.child.signals).toEqual(["SIGKILL"]);
      }
      expect(h.timers).toHaveLength(2);
      await h.failure("harness_failure", "harness", "first stderr read failure");
    });
  });

  test("valid activity renews idle and reports its accepted timestamp", async () => {
    await withProducer(async (h) => {
      h.at(1_090);
      h.child.stdout.write(ACTIVITY);
      await h.pending();
      expect(h.timers).toHaveLength(3);
      expect(h.timers[0]!.cleared).toBe(true);
      expect(h.timers[1]!.cleared).toBe(false);
      h.at(1_189);
      h.result();
      await h.success(1_090);
    });
  });

  test("valid result just before the fixed total deadline succeeds", async () => {
    await withProducer(async (h) => {
      for (const time of [1_090, 1_180]) {
        h.at(time);
        h.child.stdout.write(ACTIVITY);
        await h.pending();
      }
      h.at(1_249);
      h.result();
      await h.success(1_180);
    });
  });

  for (const closeAt of [1_099, 1_100, 1_101]) {
    test(`unterminated result is admitted at close time ${closeAt}`, async () => {
      await withProducer(async (h) => {
        h.at(1_099);
        h.result(false);
        await h.pending();
        h.at(closeAt);
        h.child.close();
        if (closeAt < 1_100) await h.success();
        else await h.failure("inactivity_timeout");
      });
    });
  }
});

test("trusted route keeps scratch until stderr-failed child closes, then cleans it", async () => {
  const configDir = mkdtempSync(join(tmpdir(), "ocx-fabric-consumer-deadline-"));
  const child = new DeadlineChild();
  const originals = { spawn: childProcess.spawn, set: globalThis.setTimeout, clear: globalThis.clearTimeout };
  const restorers: Array<() => void> = [];
  const proxyNames = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"];
  const proxyEnv = proxyNames.map((name) => [name, process.env[name]] as const);
  const outer: { outcome: Outcome<FabricTaskRunResult> } = { outcome: { status: "pending" } };
  try {
    for (const name of proxyNames) delete process.env[name];
    // Resolve through the existing destination contract before capturing producer timers.
    const destination = await createLabDestination({
      baseUrl: "https://api.example.com/v1", labRunApproval: true, configDir,
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    });
    const spawnSpy = spyOn(childProcess, "spawn").mockImplementation(() => child as unknown as childProcess.ChildProcess);
    restorers.push(() => spawnSpy.mockRestore());
    const timers = installTimers(restorers);
    void runFabricSyntheticPatchTaskForRoute({
      routeContext: fabricMockRoute(), destination, configDir, now: () => START,
      patchExecutor: fabricCorrectPatchExecutor(),
    }).then(
      (value) => { outer.outcome = { status: "resolved", value }; },
      (error: unknown) => { outer.outcome = { status: "rejected", error }; },
    );
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect(spawnSpy.mock.results[0]?.value).toBe(child);
    const scratchRoot = spawnSpy.mock.calls[0]?.[2]?.env?.OCX_FABRIC_SCRATCH_ROOT;
    expect(typeof scratchRoot).toBe("string");
    if (!scratchRoot) throw new Error("producer spawn omitted its scratch root");
    expect(child.listenerCount("close")).toBe(1);
    expect(timers).toHaveLength(2);
    expect(existsSync(scratchRoot)).toBe(true);
    await drain();
    expect(outer.outcome.status).toBe("pending");

    child.stderr.emit("error", new Error("consumer stderr failure"));
    const assertPendingScratch = async () => {
      await drain();
      expect(outer.outcome.status).toBe("pending");
      expect(child.closed).toBe(false);
      expect(child.signals).toEqual(["SIGKILL"]);
      expect(existsSync(scratchRoot)).toBe(true);
      expect(readFileSync(join(scratchRoot, "src/value.txt"), "utf8")).toBe("before\n");
    };
    await assertPendingScratch();
    const afterFailure = [
      () => child.stdout.write(ACTIVITY + RESULT + "\n"),
      () => child.stderr.emit("error", new Error("later stderr failure")),
      () => timers[0]!.callback(),
      () => timers[1]!.callback(),
    ];
    for (const event of afterFailure) {
      event();
      await assertPendingScratch();
    }
    child.close();
    await drain();
    expect(outer.outcome.status).toBe("resolved");
    if (outer.outcome.status !== "resolved") throw new Error("route did not settle after child close");
    expect(outer.outcome.value).toMatchObject({
      executionAuthority: "trusted_route",
      outcome: {
        outcome: "inconclusive",
        failure: { class: "harness_failure", code: "harness_failure", attribution: "harness", retryable: false },
        verifier: { passed: false, reason: "harness_failure" },
        usage: { outputBytes: 0, patchOperations: 0, filesTouched: 0 },
      },
    });
    expect(existsSync(scratchRoot)).toBe(false);
    expect(timers.every(({ cleared }) => cleared)).toBe(true);
    expect(spawnSpy).toHaveBeenCalledTimes(1);
  } finally {
    try {
      child.close();
      await drain();
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    } finally {
      for (const restore of restorers.reverse()) restore();
      for (const [name, value] of proxyEnv) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(configDir, { recursive: true, force: true });
      expect(childProcess.spawn).toBe(originals.spawn);
      expect(globalThis.setTimeout).toBe(originals.set);
      expect(globalThis.clearTimeout).toBe(originals.clear);
    }
  }
});
