import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireServerBackgroundLifecycle } from "../../src/server/background-lifecycle";
import { telemetryProfilePath } from "../../src/telemetry/profile/paths";
import { isProfileSchedulerRunning, stopProfileScheduler } from "../../src/telemetry/profile/sync";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

/**
 * Existing installs that never connect a public profile must behave exactly as before: the
 * server's background lifecycle starts no profile loop for them, with telemetry on or off. A
 * connected profile gets its loop even under OCX_TELEMETRY=0, so a pending deletion is retried.
 */
describe("public profile loop in the server background lifecycle", () => {
  let home: string;
  const saved = new Map<string, string | undefined>();
  const config = { port: 0, defaultProvider: "openai", providers: {} } as unknown as OcxConfig;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ocx-profile-lifecycle-"));
    for (const key of ["OPENCODEX_HOME", "OCX_TELEMETRY", "DO_NOT_TRACK"]) saved.set(key, process.env[key]);
    process.env.OPENCODEX_HOME = home;
    delete process.env.DO_NOT_TRACK;
    stopProfileScheduler();
  });

  afterEach(() => {
    stopProfileScheduler();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    removeTreeWithRetry(home);
  });

  async function startAndSettle() {
    const lease = acquireServerBackgroundLifecycle(() => {}, config);
    // The profile loop is started through a dynamic import; let it resolve.
    await new Promise(resolve => setTimeout(resolve, 50));
    return lease;
  }

  for (const telemetry of ["on", "off"] as const) {
    test(`no profile file: no profile loop (telemetry ${telemetry})`, async () => {
      if (telemetry === "off") process.env.OCX_TELEMETRY = "0";
      else delete process.env.OCX_TELEMETRY;
      const lease = await startAndSettle();
      try {
        expect(isProfileSchedulerRunning()).toBe(false);
      } finally {
        await lease.release();
      }
    });
  }

  test("a connected profile gets its loop even with telemetry off, and it stops with the server", async () => {
    process.env.OCX_TELEMETRY = "0";
    writeFileSync(telemetryProfilePath(home), JSON.stringify({
      version: 1, handle: "jun", displayName: "Jun", avatar: "blue", secret: "ocxp_" + "d".repeat(43),
      connectedAt: "2026-11-01T00:00:00.000Z", connectedDay: "2026-11-01", sentDays: {},
      lastSentDay: null, lastSentAt: null, retryAfterUntil: null, pendingDelete: true, revoked: false,
    }));
    const lease = await startAndSettle();
    expect(isProfileSchedulerRunning()).toBe(true);
    await lease.release();
    expect(isProfileSchedulerRunning()).toBe(false);
  });
});

