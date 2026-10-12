import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

import { HEALTH_SENTINEL_ENV, readRecoveryEntries } from "../../src/service/health-sentinel-main";
import { helperPath } from "../helpers/repo-root";
import { createTempHome, type TempHome } from "../helpers/temp-home";

/**
 * The sentinel against real processes (#6671): a fixture proxy spawns it through the real
 * launcher with a stdin pipe, and the sentinel must terminate the fixture once it stops answering,
 * or leave on its own once the fixture exits. On Windows this drives the kernel32 handle path; on
 * POSIX the live-ppid path. Short timings come from the test-only override.
 */
// Generous per-probe deadline and lag tolerance: a slow Windows runner must not miss arming or
// discard every timeout as sentinel lag.
const FAST = JSON.stringify({ intervalMs: 50, failureIntervalMs: 20, probeTimeoutMs: 2_000, startupGraceMs: 0, minUnhealthyMs: 0, suspendSlackMs: 10_000, lagToleranceMs: 10_000 });

let home: TempHome | null = null;
let fixture: ReturnType<typeof Bun.spawn> | null = null;

function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await Bun.sleep(25);
  }
  return check();
}

function startFixture(mode: "hang" | "exit") {
  home = createTempHome("ocx-sentinel-process-");
  fixture = Bun.spawn([process.execPath, helperPath("health-sentinel-hung-proxy.ts")], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
    env: {
      ...process.env,
      OPENCODEX_HOME: home.root,
      CODEX_HOME: home.codexHome,
      OCX_SERVICE_MANAGED: "1",
      SENTINEL_FIXTURE_MODE: mode,
      [HEALTH_SENTINEL_ENV.timing]: FAST,
    },
  });
  return { home, fixture };
}

async function sentinelPid(root: string): Promise<number> {
  const path = `${root}/sentinel.pid`;
  await waitFor(() => existsSync(path) && readFileSync(path, "utf8").length > 0, 10_000);
  const pid = existsSync(path) ? Number(readFileSync(path, "utf8")) : 0;
  sentinelToReap = pid;
  return pid;
}

let sentinelToReap = 0;

afterEach(async () => {
  // Bounded on every path: a failed assertion must not leave a process holding the CI shard.
  if (fixture && fixture.exitCode === null && fixture.signalCode === null) fixture.kill("SIGKILL");
  if (fixture) await Promise.race([fixture.exited, Bun.sleep(5_000)]);
  if (sentinelToReap && alive(sentinelToReap)) {
    try { process.kill(sentinelToReap, "SIGKILL"); } catch { /* already gone */ }
    await waitFor(() => !alive(sentinelToReap), 5_000);
  }
  sentinelToReap = 0;
  fixture = null;
  home?.remove();
  home = null;
});

describe("service health sentinel process (#6671)", () => {
  test("terminates a proxy that stays alive but stops answering, and leaves with it", async () => {
    const { home: root, fixture: proxy } = startFixture("hang");
    const sentinel = await sentinelPid(root.root);
    expect(sentinel).toBeGreaterThan(0);
    const exited = await Promise.race([proxy.exited.then(() => true), Bun.sleep(40_000).then(() => false)]);
    expect(exited).toBe(true);
    if (process.platform === "win32") expect(proxy.exitCode).toBe(1);
    else expect(proxy.signalCode).toBe("SIGKILL");
    // The sentinel settles its entry before it leaves, so read the history only after it is gone.
    expect(await waitFor(() => !alive(sentinel), 10_000)).toBe(true);
    const entries = readRecoveryEntries(root.path("service-health-recovery.json"));
    expect(entries).toHaveLength(1);
    expect(entries![0]!.pid).toBe(proxy.pid);
    // Windows may end the sentinel together with the proxy before it settles the entry.
    expect(process.platform === "win32" ? ["intent", "terminated"] : ["terminated"]).toContain(entries![0]!.state);
    expect(readFileSync(root.path("service-health-sentinel.log"), "utf8")).toContain(`recovering pid ${proxy.pid}`);
  }, 75_000);

  test("leaves without acting when the proxy exits on its own", async () => {
    const { home: root, fixture: proxy } = startFixture("exit");
    const sentinel = await sentinelPid(root.root);
    expect(sentinel).toBeGreaterThan(0);
    expect(await Promise.race([proxy.exited, Bun.sleep(15_000).then(() => "timeout")])).toBe(0);
    expect(await waitFor(() => !alive(sentinel), 10_000)).toBe(true);
    expect(existsSync(root.path("service-health-recovery.json"))).toBe(false);
  }, 75_000);
});
