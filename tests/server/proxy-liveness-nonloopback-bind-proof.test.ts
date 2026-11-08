import { expect, spyOn, test } from "bun:test";
import { createServer } from "node:net";
import { canBindAddress, findLiveProxy, observeProxyLiveness, type LivenessIo } from "../../src/server/proxy-liveness";

// Connecting to this machine's own non-loopback address (a Tailscale IP) with nothing listening can
// time out instead of being refused. A timeout is "unknown", which startup refuses forever; only a
// bind proof may turn it into "absent".
function ioFor(bindProofFn: LivenessIo["bindProofFn"], hostname = "100.88.46.13", extra: Partial<LivenessIo> = {}): LivenessIo {
  return {
    readPidFn: () => null,
    readRuntimeFn: () => null,
    verifyPidFn: pid => pid,
    configFn: () => ({ port: 10100, hostname }),
    loopbackAvailabilityFn: () => "available",
    attempts: 1,
    timeoutMs: 50,
    fetchFn: (async () => { throw Object.assign(new Error("timed out"), { name: "TimeoutError" }); }) as typeof fetch,
    ...(bindProofFn ? { bindProofFn } : {}),
    ...extra,
  };
}

test("a timed-out probe of a non-loopback bind is absent when the address can be bound", async () => {
  let asked: [string, number] | undefined;
  const observation = await observeProxyLiveness(ioFor(async (host, port) => { asked = [host, port]; return true; }));
  expect(observation.kind).toBe("absent");
  expect(asked).toEqual(["100.88.46.13", 10100]);
});

test("a timed-out probe of a non-loopback bind stays unknown when the address cannot be bound", async () => {
  const observation = await observeProxyLiveness(ioFor(async () => false));
  expect(observation.kind).toBe("unknown");
});

for (const source of ["config", "runtime"] as const) {
  test(`an inconclusive ${source} hostname stays unknown without a bind proof`, async () => {
    let proofCalls = 0;
    const hostname = "multi-address.fixture.invalid";
    const extra: Partial<LivenessIo> = source === "runtime"
      ? { readRuntimeFn: () => ({ port: 10100, hostname }) }
      : {};
    const observation = await observeProxyLiveness(ioFor(async () => { proofCalls++; return true; }, hostname, extra));
    expect(observation.kind).toBe("unknown");
    expect(proofCalls).toBe(0);
  });
}

test("a hostname listener that identifies itself remains live", async () => {
  let proofCalls = 0;
  const observation = await observeProxyLiveness(ioFor(async () => { proofCalls++; return true; }, "multi-address.fixture.invalid", {
    fetchFn: (async () => Response.json({ service: "opencodex" })) as typeof fetch,
  }));
  expect(observation.kind).toBe("live");
  expect(proofCalls).toBe(0);
});

for (const commandLine of ["ocx start", undefined, ""]) {
  test(`an orphan runtime PID with ${JSON.stringify(commandLine)} identity blocks bind-proof recovery`, async () => {
    const io = ioFor(async () => true, undefined, {
      readRuntimeFn: () => ({ pid: process.pid, port: 10100, hostname: "100.88.46.13" }),
      readCommandLineFn: () => commandLine,
    });
    expect(await observeProxyLiveness(io)).toEqual({ kind: "unknown", live: null });
  });
}

test("dead and confirmed foreign orphan runtime PIDs permit bind-proof recovery", async () => {
  const exited = Bun.spawn([process.execPath, "-e", ""], { stdout: "ignore", stderr: "ignore" });
  await exited.exited;
  for (const [pid, commandLine] of [[exited.pid, undefined], [process.pid, "foreign-server"]] as const) {
    const io = ioFor(async () => true, undefined, {
      readRuntimeFn: () => ({ pid, port: 10100, hostname: "100.88.46.13" }),
      readCommandLineFn: () => commandLine,
    });
    expect(await observeProxyLiveness(io)).toEqual({ kind: "absent", live: null });
  }
});

test("a foreign PID file does not erase a different live runtime owner", async () => {
  const io = ioFor(async () => true, undefined, {
    readPidFn: () => 4242,
    readRuntimeFn: pid => pid === undefined ? { pid: process.pid, port: 10100, hostname: "100.88.46.13" } : null,
    readCommandLineFn: pid => pid === 4242 ? "foreign-server" : "ocx start",
  });
  expect(await observeProxyLiveness(io)).toEqual({ kind: "unknown", live: null });
});

test("an indeterminate orphan process probe cannot authorize recovery", async () => {
  const kill = spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("denied"), { code: "EPERM" }); });
  try {
    const io = ioFor(async () => true, undefined, {
      readRuntimeFn: () => ({ pid: process.pid, port: 10100, hostname: "100.88.46.13" }),
      readCommandLineFn: () => "foreign-server",
    });
    expect(await observeProxyLiveness(io)).toEqual({ kind: "unknown", live: null });
    expect(kill).toHaveBeenCalledWith(process.pid, 0);
  } finally { kill.mockRestore(); }
});

test("runtime PID identity inspection cannot outlive the recovery deadline", async () => {
  let clock = 0;
  const io = ioFor(async () => true, undefined, {
    readRuntimeFn: () => ({ pid: process.pid, port: 10100, hostname: "100.88.46.13" }),
    readCommandLineFn: () => { clock = 1000; return "foreign-server"; },
    nowFn: () => clock, deadlineAt: 1000,
  });
  expect(await observeProxyLiveness(io)).toEqual({ kind: "unknown", live: null });
});

test("a dead PID probe finishing after the deadline remains unknown", async () => {
  let clock = 0;
  const kill = spyOn(process, "kill").mockImplementation(() => {
    clock = 1000;
    throw Object.assign(new Error("no process"), { code: "ESRCH" });
  });
  try {
    const io = ioFor(async () => true, undefined, {
      readRuntimeFn: () => ({ pid: process.pid, port: 10100, hostname: "100.88.46.13" }),
      nowFn: () => clock, deadlineAt: 1000,
    });
    expect(await observeProxyLiveness(io)).toEqual({ kind: "unknown", live: null });
  } finally { kill.mockRestore(); }
});

test("an orphan PID is never returned for a pidless responding proxy", async () => {
  const io = ioFor(async () => true, undefined, {
    readRuntimeFn: () => ({ pid: process.pid, port: 10100, hostname: "100.88.46.13" }),
    fetchFn: (async () => Response.json({ service: "opencodex" })) as typeof fetch,
  });
  expect((await findLiveProxy(io))?.pid).toBeNull();
  expect(await observeProxyLiveness(io)).toMatchObject({ kind: "live", live: { pid: null, port: 10100 } });
});

test("a non-loopback IPv6 bind is proven with the unbracketed socket address", async () => {
  for (const hostname of ["fd7a:115c:a1e0::1234", "[fd7a:115c:a1e0::1234]"]) {
    let asked: string | undefined;
    const observation = await observeProxyLiveness(ioFor(async host => { asked = host; return true; }, hostname));
    expect(observation.kind).toBe("absent");
    expect(asked).toBe("fd7a:115c:a1e0::1234");
  }
});

test("the bind proof stays within the discovery deadline", async () => {
  let clock = 0;
  let budget: number | undefined;
  const overran = await observeProxyLiveness(ioFor(async (_host, _port, timeoutMs) => {
    budget = timeoutMs;
    clock = 2_000;
    return true;
  }, undefined, { nowFn: () => clock, deadlineAt: 1_000 }));
  expect(budget).toBeLessThanOrEqual(1_000);
  expect(overran.kind).toBe("unknown");
});

test("canBindAddress is true for a free port and false while another listener holds it", async () => {
  const holder = createServer();
  await new Promise<void>(resolve => holder.listen({ host: "127.0.0.1", port: 0 }, resolve));
  const { port } = holder.address() as { port: number };
  try {
    expect(await canBindAddress("127.0.0.1", port)).toBe(false);
  } finally {
    await new Promise<void>(resolve => holder.close(() => resolve()));
  }
  expect(await canBindAddress("127.0.0.1", port)).toBe(true);
  expect(await canBindAddress("127.0.0.1", 0)).toBe(false);
});
