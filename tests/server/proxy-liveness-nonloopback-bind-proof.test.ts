import { expect, spyOn, test } from "bun:test";
import { createServer } from "node:net";
import { canBindAddress, findLiveProxy, observeProxyLiveness, probeEndpointLiveness, probePortOwner, type LivenessIo } from "../../src/server/proxy-liveness";

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

for (const [hostname, primary] of [
  ["127.0.0.2", "127.0.0.2"],
  ["::0:1", "[::1]"],
  ["::ffff:127.0.0.1", "[::ffff:7f00:1]"],
] as const) {
  for (const caller of ["endpoint", "port-owner"] as const) test(`${caller} does not adopt another family's owner for ${hostname}`, async () => {
    const calls: string[] = [];
    const fetchFn = (async (url: string) => {
      const host = new URL(url).hostname;
      calls.push(host);
      if (host !== primary) return Response.json({ service: "opencodex", pid: 4242 });
      throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
    }) as typeof fetch;
    if (caller === "endpoint") expect(await probeEndpointLiveness({ port: 10100, hostname }, { fetchFn })).toBe("dead");
    else expect(await probePortOwner(10100, { hostname }, { fetchFn })).toBeNull();
    expect(calls).toEqual([primary]);
  });
  test(`recovery still checks both families for ${hostname}`, async () => {
    const calls: string[] = [];
    const io = ioFor(undefined, hostname, { fetchFn: (async (url: string) => {
      const host = new URL(url).hostname;
      calls.push(host);
      if (host !== primary) return Response.json({ service: "opencodex", pid: 4242 });
      throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
    }) as typeof fetch });
    expect(await observeProxyLiveness(io)).toMatchObject({ kind: "live", live: { pid: 4242, hostname } });
    expect(calls).toHaveLength(2);
    expect(calls).toContain(primary);
  });
}

for (const [hostname, primary, other] of [
  ["127.0.0.2", "127.0.0.2", "[::1]"],
  ["127.255.255.254", "127.255.255.254", "[::1]"],
  ["::0:1", "[::1]", "127.0.0.1"],
  ["[0:0:0:0:0:0:0:1]", "[::1]", "127.0.0.1"],
  ["::ffff:127.0.0.1", "[::ffff:7f00:1]", "[::1]"],
  ["[0:0:0:0:0:ffff:7fff:fffe]", "[::ffff:7fff:fffe]", "[::1]"],
] as const) {
  for (const source of ["config", "runtime"] as const) {
    test(`loopback ${hostname} ${source} probes both families without bind proof`, async () => {
      const calls: string[] = [];
      let proofs = 0;
      const extra: Partial<LivenessIo> = source === "runtime"
        ? { readRuntimeFn: () => ({ port: 10100, hostname }) } : {};
      const io = ioFor(async () => { proofs++; return true; }, hostname, {
        ...extra, fetchFn: (async (url: string) => {
          calls.push(new URL(url).hostname);
          throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
        }) as typeof fetch,
      });
      expect(await observeProxyLiveness(io)).toEqual({ kind: "unknown", live: null });
      expect(calls).toEqual(source === "runtime" ? [primary, other, primary, other] : [primary, other]);
      expect(proofs).toBe(0);
      for (const uncertain of [primary, other]) {
        const result = await observeProxyLiveness({ ...io, fetchFn: (async (url: string) => {
          throw Object.assign(new Error("probe failed"), {
            code: new URL(url).hostname === uncertain ? "ETIMEDOUT" : "ECONNREFUSED",
          });
        }) as typeof fetch });
        expect(result).toEqual({ kind: "unknown", live: null });
      }
      expect(proofs).toBe(0);
    });
  }
  test(`loopback ${hostname} retains runtime owner evidence on its concrete address`, async () => {
    const observation = await observeProxyLiveness(ioFor(async () => true, hostname, {
      readRuntimeFn: () => ({ pid: process.pid, port: 10100, hostname }),
      fetchFn: (async (url: string) => new URL(url).hostname === primary
        ? Response.json({ service: "opencodex", pid: process.pid })
        : Promise.reject(Object.assign(new Error("refused"), { code: "ECONNREFUSED" }))) as typeof fetch,
    }));
    expect(observation.kind).toBe("live");
    expect(observation.live).toMatchObject({ pid: process.pid, port: 10100, hostname, source: "runtime" });
    expect(new URL(`http://${observation.live?.probeHostname}:10100`).hostname).toBe(primary);
  });
  test(`loopback ${hostname} finds an owner on the other family`, async () => {
    const observation = await observeProxyLiveness(ioFor(async () => true, hostname, {
      fetchFn: (async (url: string) => new URL(url).hostname === other
        ? Response.json({ service: "opencodex", pid: process.pid })
        : Promise.reject(Object.assign(new Error("refused"), { code: "ECONNREFUSED" }))) as typeof fetch,
    }));
    expect(observation.kind).toBe("live");
    expect(observation.live).toMatchObject({ pid: process.pid, hostname, probeHostname: other, source: "config" });
  });
  test(`loopback ${hostname} requires both negative probes and checks the runtime PID`, async () => {
    const io = ioFor(async () => { throw new Error("loopback bind proof called"); }, hostname, {
      fetchFn: (async () => { throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" }); }) as typeof fetch,
    });
    expect(await observeProxyLiveness(io)).toEqual({ kind: "absent", live: null });
    expect(await observeProxyLiveness({ ...io,
      readRuntimeFn: () => ({ pid: process.pid, port: 10100, hostname }),
      readCommandLineFn: () => "ocx start",
    })).toEqual({ kind: "unknown", live: null });
  });
}

test("mapped non-loopback IPv4 remains eligible for the bind proof", async () => {
  let socketHost = "";
  const observation = await observeProxyLiveness(ioFor(async host => { socketHost = host; return true; }, "[::ffff:192.0.2.1]"));
  expect(observation.kind).toBe("absent");
  expect(socketHost).toBe("::ffff:192.0.2.1");
});

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
