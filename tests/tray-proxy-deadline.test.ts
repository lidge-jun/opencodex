import { describe, expect, test } from "bun:test";
import { discoverStableProxyForRestart } from "../src/cli/tray-proxy";

describe("restart discovery deadline", () => {
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
