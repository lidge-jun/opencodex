import { describe, expect, test } from "bun:test";
import { findLiveProxy, isOpencodexHealthz, probeHostname, proxyIdentityAt } from "../src/server/proxy-liveness";

function healthz(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const OURS = { status: "ok", service: "opencodex", version: "2.6.17", uptime: 12, pid: 4242, port: 10100 };

describe("isOpencodexHealthz", () => {
  test("accepts the explicit service marker", () => {
    expect(isOpencodexHealthz(OURS)).toBe(true);
  });

  test("accepts the legacy pre-identity body (still-running old proxy after update)", () => {
    expect(isOpencodexHealthz({ status: "ok", version: "2.6.16", uptime: 5 })).toBe(true);
  });

  test("rejects foreign bodies", () => {
    expect(isOpencodexHealthz(null)).toBe(false);
    expect(isOpencodexHealthz({ status: "ok" })).toBe(false);
    expect(isOpencodexHealthz({ service: "something-else", status: "ok", version: "1", uptime: 1 })).toBe(false);
    expect(isOpencodexHealthz({ healthy: true } as never)).toBe(false);
  });
});

describe("probeHostname", () => {
  test("wildcards and empty answer on IPv4 loopback; concrete hosts pass through", () => {
    expect(probeHostname(undefined)).toBe("127.0.0.1");
    expect(probeHostname("0.0.0.0")).toBe("127.0.0.1");
    expect(probeHostname("::")).toBe("127.0.0.1");
    expect(probeHostname("192.168.1.20")).toBe("192.168.1.20");
  });

  test("raw IPv6 hosts are bracketed so the healthz URL stays valid", () => {
    expect(probeHostname("::1")).toBe("[::1]");
    expect(probeHostname("[::1]")).toBe("[::1]");
    expect(probeHostname("2001:db8::5")).toBe("[2001:db8::5]");
  });
});

describe("proxyIdentityAt", () => {
  test("returns the reported pid for our proxy", async () => {
    const identity = await proxyIdentityAt(10100, {}, { fetchFn: (async () => healthz(OURS)) as typeof fetch });
    expect(identity).toEqual({ pid: 4242 });
  });

  test("rejects foreign 200s, non-OK responses, and pid mismatches", async () => {
    expect(await proxyIdentityAt(10100, {}, { fetchFn: (async () => healthz({ ok: true })) as typeof fetch })).toBeNull();
    expect(await proxyIdentityAt(10100, {}, { fetchFn: (async () => healthz(OURS, 503)) as typeof fetch })).toBeNull();
    expect(await proxyIdentityAt(10100, { expectedPid: 1 }, { fetchFn: (async () => healthz(OURS)) as typeof fetch })).toBeNull();
    expect(await proxyIdentityAt(10100, {}, { fetchFn: (async () => { throw new Error("refused"); }) as typeof fetch })).toBeNull();
  });
});

describe("findLiveProxy", () => {
  test("prefers the runtime-port record over config.port (fallback-port starts are found)", async () => {
    const urls: string[] = [];
    const live = await findLiveProxy({
      readPidFn: () => 4242,
      readRuntimeFn: pid => (pid === 4242 ? { port: 58195 } : null),
      configFn: () => ({ port: 10100 }),
      fetchFn: (async (url: string | URL | Request) => {
        urls.push(String(url));
        return healthz(OURS);
      }) as typeof fetch,
    });

    expect(live).toEqual({ pid: 4242, port: 58195 });
    expect(urls).toEqual(["http://127.0.0.1:58195/healthz"]);
  });

  test("falls back to config.port only when no runtime record answers, taking pid from the body", async () => {
    const live = await findLiveProxy({
      readPidFn: () => null,
      readRuntimeFn: () => null,
      configFn: () => ({ port: 10100 }),
      fetchFn: (async () => healthz(OURS)) as typeof fetch,
    });

    expect(live).toEqual({ pid: 4242, port: 10100 });
  });

  test("a foreign listener on the configured port is not treated as our proxy", async () => {
    const live = await findLiveProxy({
      readPidFn: () => null,
      readRuntimeFn: () => null,
      configFn: () => ({ port: 10100 }),
      fetchFn: (async () => healthz({ status: "ok" })) as typeof fetch,
    });

    expect(live).toBeNull();
  });

  test("adopts an orphaned runtime record when the pid file is lost (identity-checked)", async () => {
    const urls: string[] = [];
    const live = await findLiveProxy({
      readPidFn: () => null,
      readRuntimeFn: () => ({ pid: 4242, port: 58195, hostname: "::1" }),
      configFn: () => ({ port: 10100 }),
      fetchFn: (async (url: string | URL | Request) => {
        urls.push(String(url));
        return healthz(OURS);
      }) as typeof fetch,
    });

    expect(live).toEqual({ pid: 4242, port: 58195, hostname: "::1" });
    expect(urls).toEqual(["http://[::1]:58195/healthz"]);
  });

  test("an orphaned record backed by a pidless legacy proxy yields pid null (never a killable stale pid)", async () => {
    const legacyBody = { status: "ok", version: "2.6.16", uptime: 5 }; // pre-identity healthz: no pid
    const live = await findLiveProxy({
      readPidFn: () => null,
      readRuntimeFn: () => ({ pid: 1111, port: 58195, hostname: undefined }),
      configFn: () => ({ port: 10100 }),
      fetchFn: (async (url: string | URL | Request) =>
        String(url).includes("58195") ? healthz(legacyBody) : healthz({ status: "ok" })) as typeof fetch,
    });

    // The record's pid 1111 may be dead/reused — synthesizing it would let `ocx stop`
    // kill an unrelated process via the taskkill/kill fallback.
    expect(live).toEqual({ pid: null, port: 58195, hostname: undefined });
  });

  test("an orphaned record whose healthz pid mismatches is rejected (config fallback still runs)", async () => {
    const live = await findLiveProxy({
      readPidFn: () => null,
      readRuntimeFn: () => ({ pid: 1111, port: 58195, hostname: undefined }),
      configFn: () => ({ port: 10100 }),
      fetchFn: (async (url: string | URL | Request) =>
        String(url).includes("58195") ? healthz({ ...OURS, pid: 9999 }) : healthz({ status: "ok" })) as typeof fetch,
    });

    expect(live).toBeNull();
  });

  test("a runtime record whose healthz reports a different pid is rejected", async () => {
    const live = await findLiveProxy({
      readPidFn: () => 1111,
      readRuntimeFn: () => ({ port: 58195 }),
      configFn: () => ({ port: 58195 }),
      fetchFn: (async () => healthz({ ...OURS, pid: 9999 })) as typeof fetch,
    });

    // The runtime probe fails the pid check; the config fallback probes the same port
    // without a pid expectation and adopts the reported live pid instead.
    expect(live).toEqual({ pid: 9999, port: 58195 });
  });
});
