import { describe, expect, test } from "bun:test";
import { discoverStableProxyForRestart, recheckRestartFailedStart, runProxyRestart } from "../../src/cli/tray-proxy";

describe("restart discovery deadline", () => {
  test("production recovery binding retries an exited child after the shared deadline", async () => {
    const sharedDeadline = Date.now() - 1;
    const previous = { pid: 10, port: 10100, source: "runtime" } as const;
    let launches = 0;
    let freshEnd = 0;
    const result = await runProxyRestart({
      findLive: async () => ({ status: "live", live: previous }),
      startWhenStopped: async recovering => {
        expect(recovering).toBe(true);
        return ++launches === 1
        ? { status: "failed", launch: "exited" }
        : { status: "started" };
      },
      requestInPlaceRestart: async () => ({ accepted: true }),
      waitForReplacement: async () => null,
      reobserveAfterReplacement: async () => ({ status: "absent" }),
      waitBetweenAttempts: async () => {},
      recheckAfterFailedStart: () => recheckRestartFailedStart(end => {
        freshEnd = end;
        return discoverStableProxyForRestart({
          // Absent after the exited first child; the second launch's confirmation sees it.
          findLive: async () => launches >= 2 ? { pid: 20, port: 10100, source: "runtime" } : null,
          waitBetweenChecks: async () => {},
          expired: () => Date.now() >= end,
        });
      }),
    });
    expect(sharedDeadline).toBeLessThan(Date.now());
    expect(freshEnd).toBeGreaterThan(sharedDeadline);
    expect(freshEnd).toBeGreaterThan(Date.now() + 4_000);
    expect(result).toEqual({ ok: true, mode: "started" });
    expect(launches).toBe(2);
  });
  test("fails closed when the deadline expires after the first absence observation", async () => {
    let calls = 0;
    let expiryChecks = 0;
    const result = await discoverStableProxyForRestart({
      findLive: async () => { calls += 1; return null; },
      waitBetweenChecks: async () => { throw new Error("must not wait after expiry"); },
      expired: () => { expiryChecks += 1; return true; },
    });
    expect(result.status).toBe("uncertain");
    expect(result.status === "uncertain" ? result.error.message : "")
      .toBe("restart_discovery_deadline_expired");
    expect(calls).toBe(1);
    expect(expiryChecks).toBe(1);
  });

  test("fails closed when the deadline expires after the second absence observation", async () => {
    let calls = 0;
    let expiryChecks = 0;
    const result = await discoverStableProxyForRestart({
      findLive: async () => { calls += 1; return null; },
      waitBetweenChecks: async () => {},
      expired: () => { expiryChecks += 1; return expiryChecks === 2; },
    });
    expect(result.status).toBe("uncertain");
    expect(result.status === "uncertain" ? result.error.message : "")
      .toBe("restart_discovery_deadline_expired");
    expect(calls).toBe(2);
    expect(expiryChecks).toBe(2);
  });
});
