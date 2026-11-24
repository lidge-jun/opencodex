import { expect, test } from "bun:test";
import { findLiveProxy, observeProxyLiveness, START_OWNERSHIP_LIVENESS, type LivenessIo } from "../../src/server/proxy-liveness";
import { localConnectTimeoutFetch } from "../helpers/local-connect-timeout";
import { decideStartWithLiveOwner } from "../../src/cli/dispatch";

const refused = () => Object.assign(new Error("connect refused"), { code: "ECONNREFUSED" });
const timeout = () => Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
const io: LivenessIo = {
  readPidFn: () => null, readRuntimeFn: () => null, verifyPidFn: pid => pid,
  configFn: () => ({ port: 10100, hostname: "127.0.0.1" }), sleepFn: async () => {}, attempts: 3,
  readCommandLineFn: () => "ocx start",
  loopbackAvailabilityFn: () => "available",
};

for (const [name, fetchFn, kind, attempts] of [
  ["refusal", async () => { throw refused(); }, "absent", 3],
  ["nested refusal", async () => { throw new Error("fetch failed", { cause: refused() }); }, "absent", 3],
  ["unanimous refusal", async () => { throw new AggregateError([refused(), refused()]); }, "absent", 3],
  ["timeout", async () => { throw timeout(); }, "unknown", 3],
  ["reset", async () => { throw Object.assign(new Error("reset"), { code: "ECONNRESET" }); }, "unknown", 3],
  ["mixed refusal and timeout", async () => { throw new AggregateError([refused(), timeout()]); }, "unknown", 3],
  ["foreign identity", async () => Response.json({ service: "foreign" }), "absent", 1],
  ["unreadable body", async () => new Response("not JSON"), "unknown", 1],
  ["HTTP 503", async () => Response.json({ service: "opencodex" }, { status: 503 }), "unknown", 1],
  ["foreign non-200", async () => Response.json({ service: "foreign" }, { status: 201 }), "unknown", 1],
] as const) {
  test(`recovery classifies ${name} without changing the retry budget`, async () => {
    let calls = 0;
    const fetchProbe = (async () => { calls++; return fetchFn(); }) as unknown as typeof fetch;
    expect(await observeProxyLiveness({ ...io, fetchFn: fetchProbe })).toEqual({ kind, live: null });
    expect(calls).toBe(attempts * 2); // Existing budget independently bounds each loopback family.
    // Legacy callers still collapse every negative into null.
    expect(await findLiveProxy({ ...io, fetchFn: fetchProbe })).toBeNull();
  });
}

test("an alive recorded PID forbids recovery even after definitive endpoint negatives", async () => {
  for (const fetchFn of [async () => { throw refused(); }, async () => Response.json({ service: "foreign" })]) {
    expect(await observeProxyLiveness({ ...io, readPidFn: () => 4242, fetchFn: fetchFn as typeof fetch }))
      .toEqual({ kind: "unknown", live: null });
  }
});

test("a runtime timeout cannot be erased by a configured-port refusal", async () => {
  const fetchFn = (async (url: string) => {
    if (url.includes(":20200/")) throw timeout();
    throw refused();
  }) as typeof fetch;
  expect(await observeProxyLiveness({ ...io, readRuntimeFn: () => ({ pid: 4242, port: 20200 }), fetchFn }))
    .toEqual({ kind: "unknown", live: null });
});

test("an opencodex PID mismatch leaves runtime ownership unknown", async () => {
  const fetchFn = (async (url: string) => {
    if (url.includes(":20200/")) return Response.json({ service: "opencodex", pid: 4343 });
    throw refused();
  }) as typeof fetch;
  expect(await observeProxyLiveness({ ...io, readRuntimeFn: () => ({ pid: 4242, port: 20200 }), fetchFn }))
    .toEqual({ kind: "unknown", live: null });
});

test("a live owner wins over an earlier runtime timeout", async () => {
  const fetchFn = (async (url: string) => {
    if (url.includes(":20200/")) throw timeout();
    return Response.json({ service: "opencodex", pid: 4343, role: "client" });
  }) as typeof fetch;
  const probeIo = { ...io, readRuntimeFn: () => ({ pid: 4242, port: 20200 }), fetchFn };
  const observation = await observeProxyLiveness(probeIo);
  expect(observation.kind).toBe("live");
  expect(observation.live).toMatchObject((await findLiveProxy(probeIo))!);
  expect(observation.live?.probeHostname).toBe("127.0.0.1");
  expect(observation.live?.role).toBe("client");
});

test("deadline exhaustion is unknown without spending another attempt", async () => {
  let calls = 0;
  expect(await observeProxyLiveness({ ...io, deadlineAt: 10, nowFn: () => 10,
    fetchFn: (async () => { calls++; throw refused(); }) as typeof fetch,
  })).toEqual({ kind: "unknown", live: null });
  expect(calls).toBe(0);
});

test("a timeout followed by refusals remains unknown within the existing attempt budget", async () => {
  let calls = 0;
  expect(await observeProxyLiveness({ ...io,
    fetchFn: (async () => { throw ++calls === 1 ? timeout() : refused(); }) as typeof fetch,
  })).toEqual({ kind: "unknown", live: null });
  expect(calls).toBe(6); // Three existing attempts in each family, with uncertainty retained.
});

test("port zero cannot name an owner, but an ambiguous runtime still blocks recovery", async () => {
  const fetchFn = (async () => { throw timeout(); }) as typeof fetch;
  const dynamicIo = { ...io, configFn: () => ({ port: 0 }), fetchFn };
  expect(await observeProxyLiveness(dynamicIo)).toEqual({ kind: "absent", live: null });
  expect(await observeProxyLiveness({ ...dynamicIo, readRuntimeFn: () => ({ pid: 4242, port: 20200 }) }))
    .toEqual({ kind: "unknown", live: null });
});

function windowsStartup(hostname: string, overrides: LivenessIo = {}): LivenessIo {
  return {
    ...io, ...START_OWNERSHIP_LIVENESS, platform: "win32", timeoutMs: 100,
    configFn: () => ({ port: 10100, hostname }),
    fetchFn: localConnectTimeoutFetch(host => host === hostname ? "timeout" : "refused"),
    ...overrides,
  };
}

test.each([["127.0.0.1", "0.0.0.0"], ["::1", "::"]])(
  "Windows startup can prove a timed-out %s endpoint absent",
  async (host, wildcard) => {
    const binds: Array<[string, number]> = [];
    const opts = windowsStartup(host, {
      bindProofFn: async (address, port) => { binds.push([address, port]); return true; },
    });
    expect(await observeProxyLiveness(opts)).toEqual({ kind: "absent", live: null, loopbackBindProven: true });
    expect(binds).toEqual([[host, 10100], [wildcard, 10100]]);
    expect(await observeProxyLiveness({ ...opts, platform: "darwin" })).toEqual({ kind: "unknown", live: null });
    expect(binds).toHaveLength(2);
  },
);

test.each(["127.0.0.1", "0.0.0.0", "error"])("Windows startup refuses when the bind at %s is unprovable", async blocked => {
  const binds: string[] = [];
  const opts = windowsStartup("127.0.0.1", { bindProofFn: async address => {
    binds.push(address);
    if (blocked === "error") throw new Error("unavailable");
    return address !== blocked;
  } });
  expect(await observeProxyLiveness(opts)).toEqual({ kind: "unknown", live: null });
  expect(binds).toEqual(blocked === "0.0.0.0" ? ["127.0.0.1", "0.0.0.0"] : ["127.0.0.1"]);
});

test.each(["deadline", "cancel"])("Windows startup discards a bind proof after %s", async stop => {
  const controller = new AbortController();
  let clock = 10;
  const binds: Array<[string, number]> = [];
  const opts = windowsStartup("127.0.0.1", {
    deadlineAt: 60, nowFn: () => clock, signal: controller.signal,
    bindProofFn: async (address, _port, budget) => {
      binds.push([address, budget]);
      if (stop === "cancel") controller.abort();
      else clock = 60;
      return true;
    },
  });
  expect(await observeProxyLiveness(opts)).toEqual({ kind: "unknown", live: null });
  expect(binds).toEqual([["127.0.0.1", 50]]);
});

test("a Windows connect timeout does not supersede live PID or runtime evidence", async () => {
  let binds = 0;
  const opts = windowsStartup("127.0.0.1", { bindProofFn: async () => { binds++; return true; } });
  expect(await observeProxyLiveness({ ...opts, readPidFn: () => process.pid })).toEqual({ kind: "unknown", live: null });
  expect(await observeProxyLiveness({ ...opts, readRuntimeFn: () => ({ pid: process.pid, port: 10100 }) }))
    .toEqual({ kind: "unknown", live: null });
  expect(binds).toBeGreaterThanOrEqual(4);
});

test("the final startup probe sees a listener that takes the port after the bind proof", async () => {
  const released = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
  const port = released.port;
  await released.stop(true);
  const opts = windowsStartup("127.0.0.1", { configFn: () => ({ port }) });
  expect(await observeProxyLiveness(opts)).toEqual({ kind: "absent", live: null, loopbackBindProven: true });

  // This is a real bind on the endpoint that the temporary proof has just released.
  const owner = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => Response.json({ service: "opencodex", pid: process.pid }) });
  try {
    const live = await findLiveProxy({ ...opts, fetchFn: undefined, timeoutMs: 1_500 });
    if (!live) throw new Error("the final probe missed the late listener");
    expect(live).toMatchObject({ pid: process.pid, port });
    expect(decideStartWithLiveOwner({ livePid: live.pid, livePort: live.port, requestedPort: undefined, ocxService: undefined })).toBe("refuse");
  } finally { await owner.stop(true); }
});

test("a response timeout or a mixed reset and connect timeout provides no bind evidence", async () => {
  let ipv4Calls = 0;
  const connected = localConnectTimeoutFetch(host => host === "127.0.0.1" ? "connected" : "refused");
  const connecting = localConnectTimeoutFetch(host => host === "127.0.0.1" ? "timeout" : "refused");
  let bindAttempts = 0;
  const bindProofFn = async () => { bindAttempts++; return true; };
  expect((await observeProxyLiveness(windowsStartup("127.0.0.1", { fetchFn: connected, bindProofFn }))).kind).toBe("unknown");
  const mixed = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (new URL(String(input)).hostname === "127.0.0.1" && ++ipv4Calls === 1) throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
    return connecting(input, init);
  }) as typeof fetch;
  expect((await observeProxyLiveness(windowsStartup("127.0.0.1", { fetchFn: mixed, bindProofFn }))).kind).toBe("unknown");
  expect(ipv4Calls).toBe(3);
  expect(bindAttempts).toBe(0);
});

const deniedConnect = (code = "EACCES", syscall: string | null = "connect") => (async (input: RequestInfo | URL) => {
  if (new URL(String(input)).hostname === "[::1]") throw Object.assign(new Error(`connect ${code} ::1:10100`), { code, syscall });
  throw refused();
}) as typeof fetch;

test("Windows startup can prove a ::1 endpoint absent when the connect is denied with EACCES", async () => {
  const binds: string[] = [];
  const opts = windowsStartup("::1", { fetchFn: deniedConnect(), bindProofFn: async address => { binds.push(address); return true; } });
  expect(await observeProxyLiveness(opts)).toEqual({ kind: "absent", live: null, loopbackBindProven: true });
  expect(binds).toEqual(["::1", "::"]);
  expect(await observeProxyLiveness({ ...opts, platform: "darwin" })).toEqual({ kind: "unknown", live: null });
  expect(await observeProxyLiveness({ ...opts, bindProofFn: async () => false })).toEqual({ kind: "unknown", live: null });
});

test.each([["EACCES", null], ["EACCES", "bind"], ["EPERM", "connect"]] as const)(
  "a %s failure outside connect (syscall %s) provides no bind evidence",
  async (code, syscall) => {
    let binds = 0;
    const opts = windowsStartup("::1", { fetchFn: deniedConnect(code, syscall), bindProofFn: async () => { binds++; return true; } });
    expect(await observeProxyLiveness(opts)).toEqual({ kind: "unknown", live: null });
    expect(binds).toBe(0);
  },
);
