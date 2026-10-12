/**
 * A restart replacement that finds its own draining parent waits for it instead of refusing it.
 *
 * The deadline and listener-stop-fallback handoffs spawn the replacement before the old listener is
 * certainly gone. Its owner probe then found the parent, `decideStartWithLiveOwner` answered
 * "refuse" (same port, no service context), and once the parent exited there was no proxy at all.
 */
import { describe, expect, test } from "bun:test";
import {
  probeOwnerPastRestartParent,
  RESTART_PARENT_EXIT_TIMEOUT_MS,
  takeRestartHandoffMarkers,
  takeRestartParentMarker,
  type OwnerProbeResult,
} from "../../src/cli/restart-handoff";
import { RESTART_PARENT_PID_ENV, withRestartParentMarker } from "../../src/lib/system-restart-contract";
import { RESTART_HANDOFF_LOG_ENV } from "../../src/server/restart-replacement";

const PARENT = 4242;
const PORT = 10100;
const input = { restartParentPid: PARENT, requestedPort: PORT, ocxService: undefined };

function clock() {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms: number) => { now += ms; },
    advance: (ms: number) => { now += ms; },
  };
}

describe("probeOwnerPastRestartParent", () => {
  test("waits for the restart parent to exit, then returns a fresh probe", async () => {
    const time = clock();
    let parentAlive = true;
    const probes: OwnerProbeResult[] = [];
    const owner = await probeOwnerPastRestartParent(async () => {
      const result: OwnerProbeResult = { live: parentAlive ? { pid: PARENT, port: PORT } : null };
      probes.push(result);
      return result;
    }, input, {
      now: time.now,
      sleep: async ms => {
        await time.sleep(ms);
        if (time.now() >= 2_500) parentAlive = false;
      },
      isAlive: pid => pid === PARENT && parentAlive,
      log: () => {},
    });

    expect(owner.live).toBeNull();
    expect(time.now()).toBeGreaterThanOrEqual(2_500);
    expect(time.now()).toBeLessThan(RESTART_PARENT_EXIT_TIMEOUT_MS);
    // First probe, one re-probe per second while waiting, and the fresh probe after the exit.
    expect(probes.at(-1)?.live).toBeNull();
    expect(probes.length).toBeGreaterThanOrEqual(3);
  });

  test("stops waiting as soon as a re-probe no longer finds the parent answering", async () => {
    const time = clock();
    let probes = 0;
    const owner = await probeOwnerPastRestartParent(async () => {
      probes += 1;
      // The parent closed its listener but lingers (a zombie or a slow exit).
      return { live: probes === 1 ? { pid: PARENT, port: PORT } : null };
    }, input, { now: time.now, sleep: time.sleep, isAlive: () => true, log: () => {} });

    expect(owner.live).toBeNull();
    expect(probes).toBe(2);
    expect(time.now()).toBeLessThanOrEqual(1_100);
  });

  test("a parent still alive past the budget is handed back for the caller to refuse", async () => {
    const time = clock();
    const lines: string[] = [];
    const owner = await probeOwnerPastRestartParent(
      async () => ({ live: { pid: PARENT, port: PORT } }),
      input,
      { now: time.now, sleep: time.sleep, isAlive: () => true, log: line => lines.push(line) },
    );

    expect(owner.live).toEqual({ pid: PARENT, port: PORT });
    expect(time.now()).toBe(RESTART_PARENT_EXIT_TIMEOUT_MS);
    expect(lines.at(-1)).toContain(`PID ${PARENT}`);
    expect(lines.at(-1)).toContain("did not exit within 30s");
  });

  test("never waits for a live proxy that is not this start's restart parent", async () => {
    for (const probeResult of [
      { live: { pid: PARENT + 1, port: PORT } },
      { live: { pid: null, port: PORT } },
      { live: null },
    ] satisfies OwnerProbeResult[]) {
      let probes = 0;
      let slept = 0;
      const owner = await probeOwnerPastRestartParent(async () => {
        probes += 1;
        return probeResult;
      }, input, { sleep: async () => { slept += 1; }, isAlive: () => true, log: () => {} });
      expect(owner).toBe(probeResult);
      expect(probes).toBe(1);
      expect(slept).toBe(0);
    }
  });

  test("an ordinary start without a marker probes exactly once", async () => {
    let probes = 0;
    const live = { live: { pid: PARENT, port: PORT } };
    const owner = await probeOwnerPastRestartParent(async () => {
      probes += 1;
      return live;
    }, { ...input, restartParentPid: null }, { isAlive: () => { throw new Error("must not poll"); } });
    expect(owner).toBe(live);
    expect(probes).toBe(1);
  });
});

describe("restart-parent marker", () => {
  test("is honored only for this process's actual parent and always consumed", () => {
    const own = 5000;
    const env: Record<string, string | undefined> = withRestartParentMarker({ PATH: "/bin" }, PARENT);
    expect(env[RESTART_PARENT_PID_ENV]).toBe(String(PARENT));
    expect(takeRestartParentMarker(env, PARENT, own)).toBe(PARENT);
    expect(env[RESTART_PARENT_PID_ENV]).toBeUndefined();
    expect(env.PATH).toBe("/bin");

    // A marker inherited past its real parent (reparented, or set by hand) is inert.
    const stale: Record<string, string | undefined> = { [RESTART_PARENT_PID_ENV]: String(PARENT) };
    expect(takeRestartParentMarker(stale, 1, own)).toBeNull();
    expect(stale[RESTART_PARENT_PID_ENV]).toBeUndefined();

    for (const raw of ["", "0", "-1", "12a", "1e3", " ", "99999999999", String(own)]) {
      const junk: Record<string, string | undefined> = { [RESTART_PARENT_PID_ENV]: raw };
      expect(takeRestartParentMarker(junk, Number(raw) || PARENT, own)).toBeNull();
      expect(junk[RESTART_PARENT_PID_ENV]).toBeUndefined();
    }
  });

  test("handleStart's taker consumes the parent marker and the handoff-log flag together", () => {
    const env: Record<string, string | undefined> = withRestartParentMarker(
      { [RESTART_HANDOFF_LOG_ENV]: "1", PATH: "/bin" },
      process.ppid,
    );
    // A never-due check on a path nobody writes: this only proves both markers are consumed.
    const pid = takeRestartHandoffMarkers(env, { path: "/nonexistent/restart-handoff.log", intervalMs: 2_000_000_000 });
    expect(pid).toBe(process.ppid);
    expect(env[RESTART_PARENT_PID_ENV]).toBeUndefined();
    expect(env[RESTART_HANDOFF_LOG_ENV]).toBeUndefined();
    expect(env.PATH).toBe("/bin");
  });
});
