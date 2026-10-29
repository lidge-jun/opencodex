import { expect, test } from "bun:test";
import { findLiveProxy, observeProxyLiveness, type LivenessIo } from "../../src/server/proxy-liveness";

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
