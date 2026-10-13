import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireDesktopLaunchLease,
  DESKTOP_COLD_START_TIMEOUT_MS,
  DESKTOP_LAUNCH_LEASE_MS,
  inspectDesktopProcess,
  launchDesktopApp,
  planEnsureColdStart,
  runDesktopColdStart,
  type DesktopColdStartDeps,
  type DesktopProcessState,
} from "../../src/cli/ensure-desktop-cold-start";
import { removeTreeWithRetry } from "../helpers/remove-tree";

interface Calls { launches: number; waits: number[]; released: number }

function deps(options: {
  owned: boolean;
  process: DesktopProcessState;
  platform?: NodeJS.Platform;
  live?: boolean;
  launchOk?: boolean;
  leaseHeld?: boolean;
}, calls: Calls): DesktopColdStartDeps<{ port: number }> {
  return {
    platform: options.platform ?? "darwin",
    desktopOwned: () => options.owned,
    desktopProcess: () => options.process,
    launchDesktop: () => { calls.launches++; return options.launchOk ?? true; },
    acquireLaunchLease: () => options.leaseHeld ? null : () => { calls.released++; },
    waitForProxy: async timeoutMs => { calls.waits.push(timeoutMs); return options.live === false ? null : { port: 10100 }; },
  };
}

const fresh = (): Calls => ({ launches: 0, waits: [], released: 0 });

describe("ocx ensure cold start under OpenCodex Desktop (#6971)", () => {
  test("only an unclaimed machine without a running Desktop gets a CLI proxy", () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      expect(planEnsureColdStart({ desktopOwned: false, desktopProcess: "absent", platform })).toEqual({ kind: "spawn-cli" });
      expect(planEnsureColdStart({ desktopOwned: false, desktopProcess: "unknown", platform })).toEqual({ kind: "spawn-cli" });
      expect(planEnsureColdStart({ desktopOwned: false, desktopProcess: "running", platform })).toEqual({ kind: "wait-desktop" });
      expect(planEnsureColdStart({ desktopOwned: true, desktopProcess: "running", platform })).toEqual({ kind: "wait-desktop" });
    }
    expect(planEnsureColdStart({ desktopOwned: true, desktopProcess: "absent", platform: "darwin" })).toEqual({ kind: "launch-desktop" });
    expect(planEnsureColdStart({ desktopOwned: true, desktopProcess: "unknown", platform: "darwin" })).toEqual({ kind: "launch-desktop" });
    expect(planEnsureColdStart({ desktopOwned: true, desktopProcess: "absent", platform: "linux" })).toEqual({ kind: "refuse" });
    expect(planEnsureColdStart({ desktopOwned: true, desktopProcess: "absent", platform: "win32" })).toEqual({ kind: "refuse" });
  });

  test("a Desktop restart gap waits for Desktop's proxy instead of starting one", async () => {
    const calls = fresh();
    const result = await runDesktopColdStart(deps({ owned: false, process: "running" }, calls));
    expect(result).toEqual({ kind: "live", live: { port: 10100 } });
    expect(calls).toEqual({ launches: 0, waits: [DESKTOP_COLD_START_TIMEOUT_MS], released: 0 });
  });

  test("a Desktop that never brings its proxy back fails without a CLI fallback", async () => {
    const calls = fresh();
    const result = await runDesktopColdStart(deps({ owned: true, process: "running", live: false }, calls));
    expect(result.kind).toBe("failed");
    expect(result.kind === "failed" && result.message).toContain("Start Proxy");
    expect(calls.launches).toBe(0);
  });

  test("a quit Desktop with its claim is started once, then awaited", async () => {
    const calls = fresh();
    const result = await runDesktopColdStart(deps({ owned: true, process: "absent" }, calls));
    expect(result.kind).toBe("live");
    expect(calls).toEqual({ launches: 1, waits: [DESKTOP_COLD_START_TIMEOUT_MS], released: 1 });
  });

  test("a concurrent ensure joins the launch in progress instead of starting Desktop again", async () => {
    const calls = fresh();
    const result = await runDesktopColdStart(deps({ owned: true, process: "absent", leaseHeld: true }, calls));
    expect(result.kind).toBe("live");
    expect(calls).toEqual({ launches: 0, waits: [DESKTOP_COLD_START_TIMEOUT_MS], released: 0 });
  });

  test("a failed or unanswered Desktop launch is an explicit failure", async () => {
    const refused = fresh();
    const notStarted = await runDesktopColdStart(deps({ owned: true, process: "absent", launchOk: false }, refused));
    expect(notStarted.kind === "failed" && notStarted.message).toContain("could not be started");
    expect(refused.waits).toEqual([]);
    expect(refused.released).toBe(1);

    const silent = fresh();
    const timedOut = await runDesktopColdStart(deps({ owned: true, process: "absent", live: false }, silent));
    expect(timedOut.kind === "failed" && timedOut.message).toContain("did not answer");
    expect(silent.released).toBe(1);
  });

  test("where Desktop cannot be started for the user, a claimed proxy is refused outright", async () => {
    for (const platform of ["linux", "win32"] as const) {
      const calls = fresh();
      const result = await runDesktopColdStart(deps({ owned: true, process: "absent", platform }, calls));
      expect(result.kind === "failed" && result.message).toContain("Open OpenCodex");
      expect(calls).toEqual({ launches: 0, waits: [], released: 0 });
    }
  });

  test("an unclaimed machine keeps the CLI cold start untouched", async () => {
    const calls = fresh();
    expect(await runDesktopColdStart(deps({ owned: false, process: "absent" }, calls))).toEqual({ kind: "cli" });
    expect(calls).toEqual({ launches: 0, waits: [], released: 0 });
  });
});

describe("Desktop process detection", () => {
  const failing = (status: unknown) => () => { throw Object.assign(new Error("exit"), { status }); };

  test("POSIX uses a per-user pgrep on the executable path", () => {
    const seen: string[][] = [];
    const running = inspectDesktopProcess({ platform: "linux", uid: 501, run: (command, args) => { seen.push([command, ...args]); return "123\n"; } });
    expect(running).toBe("running");
    expect(seen[0]).toEqual(["pgrep", "-U", "501", "-f", "(^|/)opencodex-desktop( |$)"]);
    expect(inspectDesktopProcess({ platform: "darwin", uid: 501, run: failing(1) })).toBe("absent");
    expect(inspectDesktopProcess({ platform: "darwin", uid: 501, run: failing(2) })).toBe("unknown");
    expect(inspectDesktopProcess({ platform: "linux", uid: 501, run: failing(undefined) })).toBe("unknown");
  });

  test("Windows reads the tasklist image row", () => {
    const env = { SystemRoot: "C:\\Windows" };
    expect(inspectDesktopProcess({ platform: "win32", env,
      run: () => "\"opencodex-desktop.exe\",\"4242\",\"Console\",\"1\",\"80,000 K\"\r\n" })).toBe("running");
    expect(inspectDesktopProcess({ platform: "win32", env,
      run: () => "INFO: No tasks are running which match the specified criteria.\r\n" })).toBe("absent");
    expect(inspectDesktopProcess({ platform: "win32", env, run: failing(1) })).toBe("unknown");
  });

  test("only macOS launches Desktop, hidden, through its bundle identifier", () => {
    const seen: string[][] = [];
    expect(launchDesktopApp({ platform: "darwin", run: (command, args) => { seen.push([command, ...args]); return ""; } })).toBe(true);
    expect(seen).toEqual([["/usr/bin/open", "-g", "-b", "com.opencodex.desktop", "--args", "--autostart"]]);
    expect(launchDesktopApp({ platform: "darwin", run: failing(1) })).toBe(false);
    expect(launchDesktopApp({ platform: "linux", run: () => { throw new Error("must not run"); } })).toBe(false);
  });
});

describe("Desktop launch lease", () => {
  test("one holder at a time; release removes only its own lease; a stale lease is replaced", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-desktop-lease-"));
    try {
      const release = acquireDesktopLaunchLease(dir);
      expect(release).not.toBeNull();
      expect(acquireDesktopLaunchLease(dir)).toBeNull();
      release!();
      expect(existsSync(join(dir, "desktop-launch.lease"))).toBe(false);

      writeFileSync(join(dir, "desktop-launch.lease"), "999999");
      const old = (Date.now() - DESKTOP_LAUNCH_LEASE_MS - 1_000) / 1000;
      utimesSync(join(dir, "desktop-launch.lease"), old, old);
      const replaced = acquireDesktopLaunchLease(dir);
      expect(replaced).not.toBeNull();
      replaced!();
    } finally { removeTreeWithRetry(dir); }
  });

  test("an unwritable lease directory still allows the launch", () => {
    const missing = join(tmpdir(), "ocx-desktop-lease-missing", "nested");
    const release = acquireDesktopLaunchLease(missing);
    expect(release).not.toBeNull();
    release!();
  });
});

