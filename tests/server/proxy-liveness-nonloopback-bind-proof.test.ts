import { expect, test } from "bun:test";
import { createServer } from "node:net";
import { canBindAddress, observeProxyLiveness, type LivenessIo } from "../../src/server/proxy-liveness";

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
