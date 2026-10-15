import { describe, expect, test } from "bun:test";
import { readdirSync, readlinkSync } from "node:fs";
import { runHealthSentinel, type HealthSentinelDeps } from "../../src/service/health-sentinel-main";
import { openParentPidfd, type PidfdSyscalls } from "../../src/service/health-sentinel-linux";

function fixture() {
  const calls: unknown[][] = [];
  let parent = true;
  let openError = 0;
  let descriptor = 17;
  let signalError = 0;
  let duringOpen = () => {};
  let duringProbe = () => {};
  const api: PidfdSyscalls = {
    open: pid => { calls.push(["open", pid]); duringOpen(); return { value: openError ? -1 : descriptor, errno: openError }; },
    signal: (fd, signal) => { calls.push(["signal", fd, signal]); if (!signal) duringProbe(); return { value: signalError ? -1 : 0, errno: signalError }; },
    close: fd => { calls.push(["close", fd]); },
    dispose: () => { calls.push(["dispose"]); },
  };
  return {
    calls, api,
    open: (arch = "x64") => openParentPidfd(4242, () => parent, { arch, load: () => api }),
    parent: (value: boolean) => { parent = value; },
    descriptor: (value: number) => { descriptor = value; },
    openError: (value: number) => { openError = value; },
    signalError: (value: number) => { signalError = value; },
    duringOpen: (fn: () => void) => { duringOpen = fn; },
    duringProbe: (fn: () => void) => { duringProbe = fn; },
  };
}

describe("Linux sentinel pidfd binding (#6987)", () => {
  test.each(["x64", "arm64"])("holds identity on %s even after parent PID reuse, and signals only once", arch => {
    const f = fixture();
    const opened = f.open(arch);
    expect(opened.kind).toBe("bound");
    if (opened.kind !== "bound") throw new Error("not bound");
    // Simulate exit/reparenting and the numeric PID being reused after verification.
    // The adapter still addresses the old kernel object (the runner also checks EOF/ppid).
    f.parent(false);

    expect(opened.handle.terminate()).toBe("terminated");
    const count = f.calls.length;
    expect(opened.handle.terminate()).toBe("not_target");
    expect(f.calls.length).toBe(count);
    opened.handle.close();
    opened.handle.close();
    expect(f.calls.slice(-2)).toEqual([["close", 17], ["dispose"]]);
    expect(opened.handle.terminate()).toBe("not_target");
  });

  test("descriptor zero is valid and an already-exited target is never signalled by PID", () => {
    const f = fixture();
    f.descriptor(0);
    const opened = f.open();
    if (opened.kind !== "bound") throw new Error("not bound");
    f.signalError(3);
    expect(opened.handle.terminate()).toBe("not_target");
    opened.handle.close();
    expect(f.calls).toEqual([["open", 4242], ["signal", 0, 0], ["signal", 0, 9], ["close", 0], ["dispose"]]);
  });

  test.each(["open", "probe"])("refuses reparenting during %s and releases the acquired descriptor", when => {
    const f = fixture();
    if (when === "open") f.duringOpen(() => f.parent(false));
    else f.duringProbe(() => f.parent(false));
    expect(f.open().kind).toBe("refused");
    expect(f.calls.slice(-2)).toEqual([["close", 17], ["dispose"]]);
    expect(f.calls).not.toContainEqual(["signal", 17, 9]);
  });

  test("wrong parent and unsupported architecture never call a syscall", () => {
    const f = fixture();
    f.parent(false);
    expect(f.open().kind).toBe("refused");
    f.parent(true);
    expect(f.open("riscv64").kind).toBe("unsupported");
    expect(f.calls).toEqual([]);
  });

  test.each([1, 3, 12, 13, 22, 23, 24])("open errno %s refuses recovery instead of downgrading", errno => {
    const f = fixture();
    f.openError(errno);
    expect(f.open().kind).toBe("refused");
    expect(f.calls).toEqual([["open", 4242], ["dispose"]]);
  });

  test.each([1, 3, 9, 22, 24])("signal-check errno %s refuses recovery and closes", errno => {
    const f = fixture();
    f.signalError(errno);
    expect(f.open().kind).toBe("refused");
    expect(f.calls.slice(-2)).toEqual([["close", 17], ["dispose"]]);
  });

  test.each(["open", "signal"])("only ENOSYS at %s permits old-kernel fallback", when => {
    const f = fixture();
    if (when === "open") f.openError(38);
    else f.signalError(38);
    expect(f.open().kind).toBe("unsupported");
    expect(f.calls.at(-1)).toEqual(["dispose"]);
    expect(f.calls.filter(call => call[0] === "close")).toHaveLength(when === "open" ? 0 : 1);
  });

  test("loader and unexpected syscall exceptions refuse and release resources", () => {
    expect(openParentPidfd(4242, () => true, { arch: "x64", load: () => { throw new Error("dlopen"); } }).kind).toBe("refused");
    const f = fixture();
    f.duringProbe(() => { throw new Error("ffi"); });
    expect(f.open().kind).toBe("refused");
    expect(f.calls.slice(-2)).toEqual([["close", 17], ["dispose"]]);
    const bound = fixture();
    const opened = bound.open();
    if (opened.kind !== "bound") throw new Error("not bound");
    bound.api.signal = () => { throw new Error("ffi"); };
    expect(opened.handle.terminate()).toBe("failed");
  });

  test.each([1, 38])("termination errno %s never falls back to a numeric PID", errno => {
    const f = fixture();
    const opened = f.open();
    if (opened.kind !== "bound") throw new Error("not bound");
    f.signalError(errno);
    expect(opened.handle.terminate()).toBe("failed");
    opened.handle.close();
    expect(f.calls).toEqual([["open", 4242], ["signal", 17, 0], ["signal", 17, 9], ["close", 17], ["dispose"]]);
  });

  test.each(["EOF", "refusal", "exception", "recovered", "failed", "not_target"])("runner releases the pidfd on %s", async mode => {
    const f = fixture();
    const opened = f.open();
    if (opened.kind !== "bound") throw new Error("not bound");
    let resolveExit = () => {};
    const targetExited = new Promise<void>(resolve => { resolveExit = resolve; });
    let clock = 1_000;
    let probes = 0;
    const deps: HealthSentinelDeps = {
      targetPid: 4242,
      now: () => clock,
      sleep: async ms => { clock += ms; },
      probe: async () => {
        if (mode === "exception") throw new Error("probe failed");
        if (mode === "EOF") { resolveExit(); return new Promise(() => {}); }
        const startedAt = clock;
        clock += 20;
        return probes++ === 0
          ? { kind: "answered", pid: 4242, startedAt, endedAt: clock }
          : { kind: "timeout", startedAt, endedAt: clock, sentinelLagMs: 0 };
      },
      readRuntime: () => ({ pid: 4242, port: 4100, sibling: false }),
      targetExited,
      isTargetGone: () => false,
      bindTarget: () => mode === "refusal" ? { ok: false, reason: "refused" } : { ok: true },
      closeTarget: opened.handle.close,
      terminateTarget: () => {
        f.signalError(mode === "failed" ? 1 : mode === "not_target" ? 3 : 0);
        const result = opened.handle.terminate();
        if (result === "terminated") resolveExit();
        return result;
      },
      withOwnershipLease: run => run(),
      readHistory: () => [],
      writeHistory: () => true,
      log: () => {},
      timing: { intervalMs: 0, startupGraceMs: 0, failureThreshold: 1, minUnhealthyMs: 0 },
    };
    if (mode === "exception") await expect(runHealthSentinel(deps)).rejects.toThrow("probe failed");
    else {
      const result = await runHealthSentinel(deps);
      expect(result.outcome).toBe(mode === "refusal" || mode === "failed" ? "stood_down" : mode === "recovered" ? "recovered" : "target_exited");
    }
    expect(f.calls.slice(-2)).toEqual([["close", 17], ["dispose"]]);
    const count = f.calls.length;
    opened.handle.close();
    expect(opened.handle.terminate()).toBe("not_target");
    expect(f.calls.length).toBe(count);
  });
});

function pidfdCount(): number {
  // Before Linux 6.9 a pidfd is an anonymous inode; pidfs (6.9+) names it pidfd:[<inode>].
  return readdirSync("/proc/self/fd").filter(fd => {
    try { return /^(anon_inode:\[pidfd\]|pidfd:\[\d+\])$/.test(readlinkSync(`/proc/self/fd/${fd}`)); } catch { return false; }
  }).length;
}

test.if(process.platform === "linux")("native pidfd signals a disposable fixture and releases its descriptor", async () => {
  // Bun may hold its own pidfd for a spawned child and release it on exit, so the leak check
  // compares against the count taken before the fixture exists.
  const baseline = pidfdCount();
  const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  const before = pidfdCount();
  const opened = openParentPidfd(child.pid, () => true);
  try {
    if (opened.kind === "unsupported") {
      expect(opened.reason).toMatch(/unsupported/);
      return; // Old kernels still exercise the real launcher's fallback in the process suite.
    }
    expect(opened.kind).toBe("bound");
    if (opened.kind !== "bound") throw new Error(JSON.stringify(opened));
    expect(pidfdCount()).toBe(before + 1);
    expect(opened.handle.terminate()).toBe("terminated");
    await child.exited;
    expect(child.signalCode).toBe("SIGKILL");
  } finally {
    if (opened.kind === "bound") opened.handle.close();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await child.exited;
  }
  expect(pidfdCount()).toBe(baseline);
}, 10_000);


test.if(process.platform === "linux")("native pidfd cannot signal an already-exited fixture", async () => {
  const child = Bun.spawn([process.execPath, "-e", "await Bun.stdin.text()"], { stdin: "pipe", stdout: "ignore", stderr: "pipe" });
  const opened = openParentPidfd(child.pid, () => true);
  try {
    if (opened.kind === "unsupported") {
      expect(opened.reason).toMatch(/unsupported/);
      return; // Old kernels still exercise the real launcher's fallback in the process suite.
    }
    expect(opened.kind).toBe("bound");
    if (opened.kind !== "bound") throw new Error(JSON.stringify(opened));
    child.stdin.end();
    await child.exited;
    expect(opened.handle.terminate()).toBe("not_target");
  } finally {
    if (opened.kind === "bound") opened.handle.close();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await child.exited;
  }
}, 10_000);
