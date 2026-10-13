import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireDesktopLaunchLease,
  DESKTOP_COLD_START_TIMEOUT_MS,
  inspectDesktopProcess,
  launchDesktopApp,
  planEnsureColdStart,
  runDesktopColdStart,
  type DesktopColdStartDeps,
  type DesktopOwnershipState,
  type DesktopProcessState,
} from "../../src/cli/ensure-desktop-cold-start";
import { removeTreeWithRetry } from "../helpers/remove-tree";

interface Calls { launches: number; waits: number[]; released: number }

function deps(options: {
  ownership: DesktopOwnershipState;
  process: DesktopProcessState;
  platform?: NodeJS.Platform;
  live?: boolean;
  launchOk?: boolean;
  leaseHeld?: boolean;
}, calls: Calls): DesktopColdStartDeps<{ port: number }> {
  return {
    platform: options.platform ?? "darwin",
    ownership: () => options.ownership,
    desktopProcess: () => options.process,
    launchDesktop: () => { calls.launches++; return options.launchOk ?? true; },
    acquireLaunchLease: () => options.leaseHeld ? null : () => { calls.released++; },
    waitForProxy: async timeoutMs => { calls.waits.push(timeoutMs); return options.live === false ? null : { port: 10100 }; },
  };
}

const fresh = (): Calls => ({ launches: 0, waits: [], released: 0 });

describe("ocx ensure cold start under OpenCodex Desktop (#6971)", () => {
  test("only an unclaimed machine with no running Desktop gets a CLI proxy; unknown evidence refuses", () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      expect(planEnsureColdStart({ ownership: "other", desktopProcess: "absent", platform })).toEqual({ kind: "spawn-cli" });
      expect(planEnsureColdStart({ ownership: "other", desktopProcess: "running", platform })).toEqual({ kind: "wait-desktop" });
      expect(planEnsureColdStart({ ownership: "desktop", desktopProcess: "running", platform })).toEqual({ kind: "wait-desktop" });
      expect(planEnsureColdStart({ ownership: "unknown", desktopProcess: "running", platform })).toEqual({ kind: "wait-desktop" });
      for (const ownership of ["other", "desktop", "unknown"] as const) {
        expect(planEnsureColdStart({ ownership, desktopProcess: "unknown", platform })).toEqual({ kind: "refuse", reason: "unverified" });
      }
      expect(planEnsureColdStart({ ownership: "unknown", desktopProcess: "absent", platform })).toEqual({ kind: "refuse", reason: "unverified" });
    }
    expect(planEnsureColdStart({ ownership: "desktop", desktopProcess: "absent", platform: "darwin" })).toEqual({ kind: "launch-desktop" });
    expect(planEnsureColdStart({ ownership: "desktop", desktopProcess: "absent", platform: "linux" })).toEqual({ kind: "refuse", reason: "desktop-unlaunchable" });
    expect(planEnsureColdStart({ ownership: "desktop", desktopProcess: "absent", platform: "win32" })).toEqual({ kind: "refuse", reason: "desktop-unlaunchable" });
  });

  test("a Desktop restart gap waits for Desktop's proxy instead of starting one", async () => {
    const calls = fresh();
    expect(await runDesktopColdStart(deps({ ownership: "other", process: "running" }, calls))).toEqual({ kind: "live", live: { port: 10100 } });
    expect(calls).toEqual({ launches: 0, waits: [DESKTOP_COLD_START_TIMEOUT_MS], released: 0 });
  });

  test("a Desktop that never brings its proxy back fails without a CLI fallback", async () => {
    const calls = fresh();
    const result = await runDesktopColdStart(deps({ ownership: "desktop", process: "running", live: false }, calls));
    expect(result.kind === "failed" && result.message).toContain("Start Proxy");
    expect(calls.launches).toBe(0);
  });

  test("a quit Desktop with its claim is started once, then awaited", async () => {
    const calls = fresh();
    expect((await runDesktopColdStart(deps({ ownership: "desktop", process: "absent" }, calls))).kind).toBe("live");
    expect(calls).toEqual({ launches: 1, waits: [DESKTOP_COLD_START_TIMEOUT_MS], released: 1 });
  });

  test("a concurrent ensure joins the launch in progress instead of starting Desktop again", async () => {
    const calls = fresh();
    expect((await runDesktopColdStart(deps({ ownership: "desktop", process: "absent", leaseHeld: true }, calls))).kind).toBe("live");
    expect(calls).toEqual({ launches: 0, waits: [DESKTOP_COLD_START_TIMEOUT_MS], released: 0 });
  });

  test("a failed or unanswered Desktop launch is an explicit failure", async () => {
    const refused = fresh();
    const notStarted = await runDesktopColdStart(deps({ ownership: "desktop", process: "absent", launchOk: false }, refused));
    expect(notStarted.kind === "failed" && notStarted.message).toContain("could not be started");
    expect(refused.waits).toEqual([]);
    expect(refused.released).toBe(1);

    const silent = fresh();
    const timedOut = await runDesktopColdStart(deps({ ownership: "desktop", process: "absent", live: false }, silent));
    expect(timedOut.kind === "failed" && timedOut.message).toContain("did not answer");
    expect(silent.released).toBe(1);
  });

  test("where Desktop cannot be started for the user, a claimed proxy is refused outright", async () => {
    for (const platform of ["linux", "win32"] as const) {
      const calls = fresh();
      const result = await runDesktopColdStart(deps({ ownership: "desktop", process: "absent", platform }, calls));
      expect(result.kind === "failed" && result.message).toContain("Open OpenCodex");
      expect(calls).toEqual({ launches: 0, waits: [], released: 0 });
    }
  });

  test("unreadable ownership or process state never reaches a CLI proxy", async () => {
    for (const facts of [{ ownership: "unknown" as const, process: "absent" as const }, { ownership: "other" as const, process: "unknown" as const }]) {
      const calls = fresh();
      const result = await runDesktopColdStart(deps(facts, calls));
      expect(result.kind === "failed" && result.message).toContain("Could not verify");
      expect(calls).toEqual({ launches: 0, waits: [], released: 0 });
    }
  });

  test("an unclaimed machine keeps the CLI cold start untouched", async () => {
    const calls = fresh();
    expect(await runDesktopColdStart(deps({ ownership: "other", process: "absent" }, calls))).toEqual({ kind: "cli" });
    expect(calls).toEqual({ launches: 0, waits: [], released: 0 });
  });
});

describe("Desktop process detection by executable identity", () => {
  test("Linux reads this user's process executables, so arguments naming Desktop do not count", () => {
    const seen: number[] = [];
    const scan = (paths: string[] | "unverified") => (uid: number) => { seen.push(uid); return paths; };
    expect(inspectDesktopProcess({ platform: "linux", uid: 1000, linuxExecutables: scan(["/usr/bin/tail", "/usr/lib/opencodex-desktop/opencodex-desktop"]) })).toBe("running");
    expect(seen).toEqual([1000]);
    expect(inspectDesktopProcess({ platform: "linux", uid: 1000, linuxExecutables: scan(["/usr/bin/tail", "/usr/bin/bash"]) })).toBe("absent");
    expect(inspectDesktopProcess({ platform: "linux", uid: 1000, linuxExecutables: scan("unverified") })).toBe("unknown");
    expect(inspectDesktopProcess({ platform: "linux", uid: 1000, linuxExecutables: () => { throw new Error("no /proc"); } })).toBe("unknown");
  });

  test.skipIf(process.platform !== "linux" && process.platform !== "darwin")("the real process scan answers on this host", () => {
    // An unanswerable scan would refuse every plain CLI cold start, so it must not be the norm.
    expect(["running", "absent"]).toContain(inspectDesktopProcess());
  });

  test("macOS lists this user's executables and requires an app bundle", () => {
    const seen: string[][] = [];
    const ps = (out: string) => (command: string, args: string[]) => { seen.push([command, ...args]); return out; };
    expect(inspectDesktopProcess({ platform: "darwin", uid: 501, run: ps("/usr/sbin/cfprefsd\n/Applications/OpenCodex.app/Contents/MacOS/opencodex-desktop\n") })).toBe("running");
    expect(seen[0]).toEqual(["/bin/ps", "-U", "501", "-o", "comm="]);
    expect(inspectDesktopProcess({ platform: "darwin", uid: 501, run: ps("/usr/bin/tail\n/tmp/opencodex-desktop\n") })).toBe("absent");
    expect(inspectDesktopProcess({ platform: "darwin", uid: 501, run: () => { throw new Error("ps failed"); } })).toBe("unknown");
  });

  test("Windows filters tasklist by image and current user", () => {
    const env = { SystemRoot: "C:\\Windows", USERNAME: "me" };
    let args: string[] = [];
    const tasklist = (out: string) => (_command: string, given: string[]) => { args = given; return out; };
    expect(inspectDesktopProcess({ platform: "win32", env, run: tasklist("\"opencodex-desktop.exe\",\"4242\",\"Console\",\"1\",\"80,000 K\"\r\n") })).toBe("running");
    expect(args).toContain("USERNAME eq me");
    expect(inspectDesktopProcess({ platform: "win32", env, run: tasklist("INFO: No tasks are running which match the specified criteria.\r\n") })).toBe("absent");
    expect(inspectDesktopProcess({ platform: "win32", env, run: () => { throw new Error("denied"); } })).toBe("unknown");
  });

  test("only macOS launches Desktop, hidden, through its bundle identifier", () => {
    const seen: string[][] = [];
    expect(launchDesktopApp({ platform: "darwin", run: (command, args) => { seen.push([command, ...args]); return ""; } })).toBe(true);
    expect(seen).toEqual([["/usr/bin/open", "-g", "-b", "com.opencodex.desktop", "--args", "--autostart"]]);
    expect(launchDesktopApp({ platform: "darwin", run: () => { throw new Error("no app"); } })).toBe(false);
    expect(launchDesktopApp({ platform: "linux", run: () => { throw new Error("must not run"); } })).toBe(false);
  });
});

describe("Desktop launch lease", () => {
  const withDir = (body: (dir: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-desktop-lease-"));
    try { body(dir); } finally { removeTreeWithRetry(dir); }
  };
  const leases = (dir: string) => readdirSync(dir).sort();

  test("a live holder keeps the lease however long its launch takes; release removes only its own", () => withDir(dir => {
    const release = acquireDesktopLaunchLease(dir, { pid: 100, alive: () => true });
    expect(release).not.toBeNull();
    expect(leases(dir)).toEqual(["desktop-launch.1.lease"]);
    expect(acquireDesktopLaunchLease(dir, { pid: 200, alive: () => true })).toBeNull();
    writeFileSync(join(dir, "desktop-launch.1.lease"), "300");
    release!();
    expect(readFileSync(join(dir, "desktop-launch.1.lease"), "utf8")).toBe("300");
  }));

  test("a dead holder is superseded by the next generation, which only one contender can create", () => withDir(dir => {
    writeFileSync(join(dir, "desktop-launch.4.lease"), "100");
    const alive = (pid: number) => pid !== 100;
    const first = acquireDesktopLaunchLease(dir, { pid: 200, alive });
    expect(first).not.toBeNull();
    expect(leases(dir)).toEqual(["desktop-launch.5.lease"]);
    expect(acquireDesktopLaunchLease(dir, { pid: 300, alive })).toBeNull();
    first!();
    expect(leases(dir)).toEqual([]);
  }));

  test("a contender that loses the race for a generation joins the winner instead of launching", () => withDir(dir => {
    writeFileSync(join(dir, "desktop-launch.1.lease"), "100");
    // Between this caller's check of generation 1 and its publish, a peer published generation 2.
    let checked = false;
    const alive = (pid: number) => {
      if (pid === 100 && !checked) { checked = true; writeFileSync(join(dir, "desktop-launch.2.lease"), "999"); return false; }
      return pid !== 100;
    };
    expect(acquireDesktopLaunchLease(dir, { pid: 200, alive })).toBeNull();
    expect(readFileSync(join(dir, "desktop-launch.2.lease"), "utf8")).toBe("999");
    expect(leases(dir).filter(name => name.endsWith(".tmp"))).toEqual([]);
  }));

  test("a stale contender that publishes below the winner stands down", () => withDir(dir => {
    writeFileSync(join(dir, "desktop-launch.3.lease"), "100");
    // While this caller checks generation 3, the winner publishes generation 5 and cleans up 3 and 4.
    const alive = (pid: number) => {
      if (pid === 100) { writeFileSync(join(dir, "desktop-launch.5.lease"), "999"); return false; }
      return true;
    };
    expect(acquireDesktopLaunchLease(dir, { pid: 200, alive })).toBeNull();
    expect(leases(dir)).toEqual(["desktop-launch.3.lease", "desktop-launch.5.lease"]);
  }));

  test("an unreadable lease directory still allows the launch", () => {
    const release = acquireDesktopLaunchLease(join(tmpdir(), "ocx-desktop-lease-missing", "nested"));
    expect(release).not.toBeNull();
    release!();
  });
});
