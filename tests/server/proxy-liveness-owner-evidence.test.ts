import { expect, test } from "bun:test";
import { isConnectionRefused, loopbackProbeHosts, observeProxyLiveness, type LivenessIo } from "../../src/server/proxy-liveness";
import { normalizeBindHostname } from "../../src/server/bind-host";

const refused = () => Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
const base: LivenessIo = {
  readPidFn: () => null, readRuntimeFn: () => null,
  configFn: () => ({ port: 10100, hostname: "127.0.0.1" }),
  attempts: 3, sleepFn: async () => {},
  loopbackAvailabilityFn: () => "available",
};

for (const [hostname, bound, families] of [
  [undefined, "127.0.0.1", ["127.0.0.1", "[::1]"]],
  ["", "127.0.0.1", ["127.0.0.1", "[::1]"]],
  ["  ", "127.0.0.1", ["127.0.0.1", "[::1]"]],
  ["localhost", "127.0.0.1", ["127.0.0.1", "[::1]"]],
  ["localhost.", "127.0.0.1", ["127.0.0.1", "[::1]"]],
  ["LOCALHOST", "127.0.0.1", ["127.0.0.1", "[::1]"]],
  [" LoCaLhOsT. ", "127.0.0.1", ["127.0.0.1", "[::1]"]],
  ["127.0.0.1", "127.0.0.1", ["127.0.0.1", "[::1]"]],
  ["::1", "::1", ["[::1]", "127.0.0.1"]],
  ["[::1]", "[::1]", ["[::1]", "127.0.0.1"]],
  ["0.0.0.0", "0.0.0.0", ["127.0.0.1", "[::1]"]],
  ["::", "::", ["127.0.0.1", "[::1]"]],
  ["[::]", "[::]", ["127.0.0.1", "[::1]"]],
  ["0.0.0.0.", "0.0.0.0.", ["127.0.0.1", "[::1]"]],
  ["00.0.0.000", "00.0.0.000", ["127.0.0.1", "[::1]"]],
  ["0::", "0::", ["127.0.0.1", "[::1]"]],
  ["::0", "::0", ["127.0.0.1", "[::1]"]],
  ["0:0:0:0:0:0:0:0", "0:0:0:0:0:0:0:0", ["127.0.0.1", "[::1]"]],
  ["*", "*", ["127.0.0.1", "[::1]"]],
  ["0", "0", ["127.0.0.1", "[::1]"]],
  ["192.0.2.1", "192.0.2.1", ["192.0.2.1"]],
  ["proxy.example", "proxy.example", ["proxy.example"]],
  ["localhost.example", "localhost.example", ["localhost.example"]],
  ["2001:db8::1", "2001:db8::1", ["[2001:db8::1]"]],
] as const) {
  test(`F5 startup bind and recovery families agree for ${JSON.stringify(hostname)}`, async () => {
    expect(normalizeBindHostname(hostname)).toBe(bound);
    expect(loopbackProbeHosts(hostname)).toEqual([...families]);
    const calls: string[] = [];
    const observation = await observeProxyLiveness({ ...base, attempts: 1,
      configFn: () => ({ port: 10100, hostname }), loopbackAvailabilityFn: () => "available",
      fetchFn: (async (url: string) => { calls.push(new URL(url).hostname); throw refused(); }) as typeof fetch,
    });
    expect(observation).toEqual({ kind: "absent", live: null });
    expect(calls).toEqual([...families]);
    // Every candidate must be definitive; a timeout in either family vetoes recovery.
    for (const uncertain of families) {
      expect(await observeProxyLiveness({ ...base, attempts: 1,
        configFn: () => ({ port: 10100, hostname }), loopbackAvailabilityFn: () => "available",
        fetchFn: (async (url: string) => {
          throw new URL(url).hostname === uncertain ? Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }) : refused();
        }) as typeof fetch,
      })).toEqual({ kind: "unknown", live: null });
    }
  });
}

for (const code of ["ETIMEDOUT", "ECONNRESET", "EADDRNOTAVAIL"]) {
  test(`F2 parent refusal cannot hide aggregate child ${code}`, async () => {
    const error = Object.assign(new AggregateError([refused(), Object.assign(new Error(code), { code })]), { code: "ECONNREFUSED" });
    let calls = 0;
    expect(await observeProxyLiveness({ ...base, fetchFn: (async () => { calls++; throw error; }) as typeof fetch }))
      .toEqual({ kind: "unknown", live: null });
    expect(calls).toBe(6); // Three existing attempts per family.
    expect(isConnectionRefused(error)).toBe(false);
  });
}

test("F2 aggregate children take precedence for nested and empty bundles", () => {
  const unanimous = Object.assign(new AggregateError([refused(), refused()]), { code: "ECONNREFUSED" });
  expect(isConnectionRefused(unanimous)).toBe(true);
  expect(isConnectionRefused(Object.assign(new AggregateError([]), { code: "ECONNREFUSED" }))).toBe(false);
  const nested = new Error("fetch failed", { cause: Object.assign(new AggregateError([
    refused(), new Error("fetch failed", { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) }),
  ]), { code: "ConnectionRefused" }) });
  expect(isConnectionRefused(nested)).toBe(false);
});

function ipv6Available(): boolean {
  try {
    const listener = Bun.listen({ hostname: "::1", port: 0, socket: { data() {} } });
    listener.stop();
    return true;
  } catch (error) {
    if (["EADDRNOTAVAIL", "EAFNOSUPPORT", "EPROTONOSUPPORT"].includes((error as { code: string }).code)) return false;
    throw error;
  }
}

for (const hostname of ["localhost", "localhost."]) {
for (const ownerHost of ["127.0.0.1", "::1"]) {
  test.skipIf(!ipv6Available())(`${hostname.endsWith(".") ? "F5" : "F3"} ${hostname} finds real owner on ${ownerHost} behind foreign other family`, async () => {
    const owner = Bun.serve({ hostname: ownerHost, port: 0,
      fetch: () => Response.json({ service: "opencodex", pid: process.pid }) });
    let foreign: ReturnType<typeof Bun.serve> | undefined;
    try {
      foreign = Bun.serve({ hostname: ownerHost === "::1" ? "127.0.0.1" : "::1", port: owner.port,
        fetch: () => Response.json({ service: "foreign" }) });
      const observation = await observeProxyLiveness({ ...base, verifyPidFn: pid => pid,
        readRuntimeFn: () => ({ pid: process.pid, port: owner.port!, hostname }),
        configFn: () => ({ port: owner.port!, hostname }),
      });
      expect(observation.kind).toBe("live");
      expect(observation.live?.pid).toBe(process.pid);
      expect(observation.live?.port).toBe(owner.port!);
      expect(observation.live?.hostname).toBe(hostname);
      expect(observation.live?.probeHostname).toBe(ownerHost === "::1" ? "[::1]" : "127.0.0.1");
    } finally {
      await foreign?.stop(true);
      await owner.stop(true);
    }
  });
}
}

test("F4 confirmed foreign reused PID permits definitive absence without signalling it", async () => {
  const foreign = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore" });
  try {
    const observation = await observeProxyLiveness({ ...base, readPidFn: () => foreign.pid,
      fetchFn: (async () => { throw refused(); }) as typeof fetch });
    expect(observation).toEqual({ kind: "absent", live: null });
    expect(foreign.exitCode).toBeNull();
  } finally { foreign.kill(); await foreign.exited; }
}, 30_000);

for (const commandLine of [undefined, "", "  ", "ocx start", "ocx update", "bun /repo/src/cli/index.ts start"]) {
  test(`F4 unreadable or OpenCodex PID remains unknown: ${JSON.stringify(commandLine)}`, async () => {
    expect(await observeProxyLiveness({ ...base, readPidFn: () => 4242, readCommandLineFn: () => commandLine,
      fetchFn: (async () => { throw refused(); }) as typeof fetch })).toEqual({ kind: "unknown", live: null });
  });
}

for (const hostname of [undefined, "localhost", "LOCALHOST", "0.0.0.0", "::"]) {
  test(`F3 both family negatives are required for ${hostname}`, async () => {
    const calls = new Map<string, number>();
    let sleeps = 0;
    expect(await observeProxyLiveness({ ...base, configFn: () => ({ port: 10100, hostname }),
      loopbackAvailabilityFn: () => "available", sleepFn: async () => { sleeps++; },
      fetchFn: (async (url: string) => {
        const host = new URL(url).hostname;
        calls.set(host, (calls.get(host) ?? 0) + 1);
        throw host === "[::1]" ? Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }) : refused();
      }) as typeof fetch,
    })).toEqual({ kind: "unknown", live: null });
    expect(Object.fromEntries(calls)).toEqual({ "127.0.0.1": 3, "[::1]": 3 });
    expect(sleeps).toBe(4); // Two existing retry sleeps per family, running concurrently.
  });
}

test("F3 unavailable family alone may be excluded; unknown availability is still probed", async () => {
  for (const availability of ["unavailable", "unknown"] as const) {
    const calls: string[] = [];
    expect(await observeProxyLiveness({ ...base, configFn: () => ({ port: 10100 }), attempts: 1,
      loopbackAvailabilityFn: host => host === "[::1]" ? availability : "available",
      fetchFn: (async (url: string) => { calls.push(new URL(url).hostname); throw refused(); }) as typeof fetch,
    })).toEqual({ kind: "absent", live: null });
    expect(calls).toEqual(availability === "unavailable" ? ["127.0.0.1"] : ["127.0.0.1", "[::1]"]);
  }
});

test("F3 family probes run concurrently and stop retrying at the shared deadline", async () => {
  let now = 0, calls = 0;
  const arrivals: Array<() => void> = [];
  expect(await observeProxyLiveness({ ...base, configFn: () => ({ port: 10100 }),
    loopbackAvailabilityFn: () => "available", deadlineAt: 50, nowFn: () => now,
    sleepFn: async () => { now = 50; },
    fetchFn: (async () => {
      calls++;
      await new Promise<void>(resolve => { arrivals.push(resolve); if (arrivals.length === 2) arrivals.forEach(done => done()); });
      throw refused();
    }) as typeof fetch,
  })).toEqual({ kind: "unknown", live: null });
  expect(calls).toBe(2);
});

test("F3 a live family retains its probe address separately from bind scope", async () => {
  const result = await observeProxyLiveness({ ...base, configFn: () => ({ port: 10100, hostname: "localhost" }),
    loopbackAvailabilityFn: () => "available", verifyPidFn: pid => pid,
    fetchFn: (async (url: string) => {
      if (new URL(url).hostname === "[::1]") return Response.json({ service: "opencodex", pid: 4242 });
      throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
    }) as typeof fetch,
  });
  expect(result).toEqual({ kind: "live", live: {
    pid: 4242, port: 10100, hostname: "localhost", probeHostname: "[::1]", source: "config",
  } });
});

test("F4 confirmed foreign PID does not erase endpoint uncertainty or an elapsed identity deadline", async () => {
  let now = 0;
  const io = { ...base, readPidFn: () => 4242, readCommandLineFn: () => { now = 50; return "unrelated.exe"; } };
  expect(await observeProxyLiveness({ ...io, fetchFn: (async () => {
    throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
  }) as typeof fetch })).toEqual({ kind: "unknown", live: null });
  expect(await observeProxyLiveness({ ...io, deadlineAt: 50, nowFn: () => now,
    fetchFn: (async () => { throw refused(); }) as typeof fetch,
  })).toEqual({ kind: "unknown", live: null });
});
