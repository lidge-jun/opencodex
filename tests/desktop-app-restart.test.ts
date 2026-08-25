import { describe, expect, test } from "bun:test";
import { restartCodexDesktopApp, type DesktopAppRestartIo } from "../src/codex/desktop-app-restart";
import { setTrustedWindowsElevationExecutablesForTests } from "../src/lib/windows-elevation";

/**
 * #2292: the desktop restart is the one path in the CLI that terminates a user's
 * app. Every branch is driven through the io seam so the guards are proved on
 * any platform, not asserted from a comment.
 */

const PS = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const TASKKILL = "C:\\Windows\\System32\\taskkill.exe";
const INSTALL = "C:\\Program Files\\WindowsApps\\OpenAI.Codex_2p2nqsd0c76g0";
const AUMID = "OpenAI.Codex_2p2nqsd0c76g0!App";

function withTrustedExes<T>(run: () => T): T {
  setTrustedWindowsElevationExecutablesForTests({ powershell: PS, taskkill: TASKKILL });
  try {
    return run();
  } finally {
    setTrustedWindowsElevationExecutablesForTests(null);
  }
}

interface Call { file: string; args: string[] }

/** Scripted exec seam: discovery, then process list, then whatever the branch does. */
function scriptedIo(options: {
  discovery?: string;
  processes?: string;
  aliveFor?: (pid: number, poll: number) => boolean;
  calls: Call[];
  ancestry?: number[];
  throwOn?: (file: string, args: readonly string[]) => boolean;
}): DesktopAppRestartIo {
  const polls = new Map<number, number>();
  return {
    platform: "win32",
    ancestryPids: () => options.ancestry ?? [4242],
    sleep: () => {},
    now: (() => { let t = 0; return () => (t += 500); })(),
    isAlive: pid => {
      const n = (polls.get(pid) ?? 0) + 1;
      polls.set(pid, n);
      return options.aliveFor ? options.aliveFor(pid, n) : false;
    },
    execFile: (file, args) => {
      options.calls.push({ file, args: [...args] });
      if (options.throwOn?.(file, args)) throw new Error("exec failed");
      const joined = args.join(" ");
      if (joined.includes("Get-AppxPackage")) return options.discovery ?? "MISS";
      if (joined.includes("Win32_Process")) return options.processes ?? "";
      return "";
    },
  };
}

const DISCOVERY = [AUMID.replace("!App", ""), INSTALL, AUMID].join("\n");

describe("Codex desktop app restart (#2292)", () => {
  test("is a no-op off Windows and never execs anything", () => {
    const calls: Call[] = [];
    const result = restartCodexDesktopApp({ platform: "darwin", execFile: (f, a) => { calls.push({ file: f, args: [...a] }); return ""; } });
    expect(result).toEqual({ attempted: false, stopped: [], surviving: [], relaunch: "skipped", reason: "windows_only" });
    expect(calls).toEqual([]);
  });

  test("fails closed when the package cannot be identified, killing nothing", () => {
    const calls: Call[] = [];
    const result = withTrustedExes(() => restartCodexDesktopApp(scriptedIo({ discovery: "MISS", calls })));
    expect(result.attempted).toBe(false);
    expect(result.reason).toBe("package_discovery_failed");
    expect(calls.some(c => c.file === TASKKILL)).toBe(false);
    expect(calls.some(c => c.args.join(" ").includes("Start-Process"))).toBe(false);
  });

  test("a discovery probe that throws is also fail-closed", () => {
    const calls: Call[] = [];
    const result = withTrustedExes(() => restartCodexDesktopApp(scriptedIo({
      discovery: DISCOVERY, calls, throwOn: (_f, a) => a.join(" ").includes("Get-AppxPackage"),
    })));
    expect(result.reason).toBe("package_discovery_failed");
    expect(calls.some(c => c.file === TASKKILL)).toBe(false);
  });

  test("closes the root gracefully and relaunches through the DISCOVERED aumid", () => {
    const calls: Call[] = [];
    const result = withTrustedExes(() => restartCodexDesktopApp(scriptedIo({
      discovery: DISCOVERY, processes: "1000 900 2026-08-22T10:00:00.000Z", calls,
      aliveFor: (_pid, poll) => poll <= 2,
    })));
    expect(result).toEqual({ attempted: true, stopped: [1000], surviving: [], relaunch: "started" });
    expect(calls.some(c => c.args.join(" ").includes("CloseMainWindow"))).toBe(true);
    // Graceful exit means no forced pass at all.
    expect(calls.some(c => c.file === TASKKILL)).toBe(false);
    const launch = calls.find(c => c.args.join(" ").includes("Start-Process"));
    expect(launch?.args.join(" ")).toContain(AUMID);
  });

  test("forces only after the graceful window elapses", () => {
    const calls: Call[] = [];
    const result = withTrustedExes(() => restartCodexDesktopApp(scriptedIo({
      discovery: DISCOVERY, processes: "1000 900 2026-08-22T10:00:00.000Z", calls,
      // Alive through the graceful window, dead once taskkill has run.
      aliveFor: (_pid, poll) => poll <= 31,
    })));
    expect(result.relaunch).toBe("started");
    expect(result.stopped).toEqual([1000]);
    const kill = calls.find(c => c.file === TASKKILL);
    expect(kill?.args).toEqual(["/PID", "1000", "/T", "/F"]);
  });

  test("a surviving target blocks the relaunch", () => {
    const calls: Call[] = [];
    const result = withTrustedExes(() => restartCodexDesktopApp(scriptedIo({
      discovery: DISCOVERY, processes: "1000 900 2026-08-22T10:00:00.000Z", calls, aliveFor: () => true,
    })));
    expect(result.surviving).toEqual([1000]);
    expect(result.relaunch).toBe("skipped");
    expect(result.reason).toBe("targets_survived");
    expect(calls.some(c => c.args.join(" ").includes("Start-Process"))).toBe(false);
  });

  test("refuses to kill its own ancestry", () => {
    const calls: Call[] = [];
    const result = withTrustedExes(() => restartCodexDesktopApp(scriptedIo({
      discovery: DISCOVERY, processes: "1000 900 2026-08-22T10:00:00.000Z", calls, ancestry: [1000, 55],
    })));
    expect(result.reason).toBe("self_ancestry");
    expect(calls.some(c => c.file === TASKKILL)).toBe(false);
    expect(calls.some(c => c.args.join(" ").includes("CloseMainWindow"))).toBe(false);
  });

  test("only package-tree roots are targeted, and children are not killed twice", () => {
    const calls: Call[] = [];
    // 1000 is the root; 1001 and 1002 are its children inside the package tree.
    const result = withTrustedExes(() => restartCodexDesktopApp(scriptedIo({
      discovery: DISCOVERY, processes: "1000 900 T0\n1001 1000 T1\n1002 1000 T2", calls,
      aliveFor: (_pid, poll) => poll <= 1,
    })));
    expect(result.stopped).toEqual([1000]);
    const closes = calls.filter(c => c.args.join(" ").includes("CloseMainWindow"));
    expect(closes).toHaveLength(1);
  });

  test("no running desktop app is reported rather than treated as a failure", () => {
    const calls: Call[] = [];
    const result = withTrustedExes(() => restartCodexDesktopApp(scriptedIo({
      discovery: DISCOVERY, processes: "", calls,
    })));
    expect(result.reason).toBe("no_targets");
    expect(result.attempted).toBe(false);
  });

  test("the relaunch identifier comes from discovery, never a hardcoded package", () => {
    const calls: Call[] = [];
    const betaAumid = "OpenAI.CodexBeta_9zzzzzzzzzzzz!App";
    withTrustedExes(() => restartCodexDesktopApp(scriptedIo({
      discovery: ["OpenAI.CodexBeta_9zzzzzzzzzzzz", INSTALL, betaAumid].join("\n"),
      processes: "1000 900 2026-08-22T10:00:00.000Z", calls, aliveFor: () => false,
    })));
    const launch = calls.find(c => c.args.join(" ").includes("Start-Process"));
    expect(launch?.args.join(" ")).toContain(betaAumid);
    expect(launch?.args.join(" ")).not.toContain("2p2nqsd0c76g0");
  });

  test("the process probe is scoped to the discovered install location", () => {
    const calls: Call[] = [];
    withTrustedExes(() => restartCodexDesktopApp(scriptedIo({
      discovery: DISCOVERY, processes: "1000 900 2026-08-22T10:00:00.000Z", calls, aliveFor: () => false,
    })));
    const probe = calls.find(c => c.args.join(" ").includes("Win32_Process"));
    const script = probe?.args.join(" ") ?? "";
    expect(script).toContain("Name='ChatGPT.exe'");
    expect(script).toContain(INSTALL);
    expect(script).toContain("OrdinalIgnoreCase");
  });

  test("every probe is bounded by a timeout", () => {
    const seen: (number | undefined)[] = [];
    withTrustedExes(() => restartCodexDesktopApp({
      platform: "win32",
      ancestryPids: () => [4242],
      sleep: () => {},
      isAlive: () => false,
      execFile: (_file, args, options) => {
        seen.push(options?.timeout);
        return args.join(" ").includes("Get-AppxPackage") ? DISCOVERY : "1000 900";
      },
    }));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(t => typeof t === "number" && t > 0)).toBe(true);
  });
});


describe("Codex desktop app restart — kill-authority guards (#2292)", () => {
  test("the process probe is scoped to the CURRENT USER, not just the package path", () => {
    const calls: Call[] = [];
    withTrustedExes(() => restartCodexDesktopApp(scriptedIo({
      discovery: DISCOVERY, processes: "1000 900 T0", calls, aliveFor: () => false,
    })));
    const probe = calls.find(c => c.args.join(" ").includes("Win32_Process"));
    const script = probe?.args.join(" ") ?? "";
    // An MSIX InstallLocation under WindowsApps is shared between accounts, so
    // path scoping alone would match another user's desktop app.
    expect(script).toContain("GetOwner");
    expect(script).toContain("WindowsIdentity");
  });

  test("a PID recycled during the graceful wait is never force-killed", () => {
    const calls: Call[] = [];
    let listings = 0;
    const io: DesktopAppRestartIo = {
      platform: "win32",
      ancestryPids: () => [4242],
      sleep: () => {},
      now: (() => { let t = 0; return () => (t += 500); })(),
      isAlive: () => true,           // never exits, so the forced pass is reached
      execFile: (file, args) => {
        calls.push({ file, args: [...args] });
        const joined = args.join(" ");
        if (joined.includes("Get-AppxPackage")) return DISCOVERY;
        if (joined.includes("Win32_Process")) {
          listings += 1;
          // First two listings: the process we verified. Third (pre-taskkill
          // re-check): same PID, different CreationDate — a recycled PID.
          return listings >= 3 ? "1000 900 T-RECYCLED" : "1000 900 T0";
        }
        return "";
      },
    };
    const result = withTrustedExes(() => restartCodexDesktopApp(io));
    expect(calls.some(c => c.file === TASKKILL)).toBe(false);
    expect(result.surviving).toEqual([]);
  });

  test("an unreadable ancestry chain fails closed instead of assuming we are outside it", () => {
    const calls: Call[] = [];
    const result = withTrustedExes(() => restartCodexDesktopApp({
      platform: "win32",
      sleep: () => {},
      isAlive: () => false,
      // No ancestryPids override: production walks the chain via CIM, and here
      // that walk throws.
      execFile: (file, args) => {
        calls.push({ file, args: [...args] });
        const joined = args.join(" ");
        if (joined.includes("Get-AppxPackage")) return DISCOVERY;
        if (joined.includes("ProcessId=")) throw new Error("cim unavailable");
        if (joined.includes("Win32_Process")) return "1000 900 T0";
        return "";
      },
    }));
    expect(result.reason).toBe("self_ancestry");
    expect(calls.some(c => c.file === TASKKILL)).toBe(false);
    expect(calls.some(c => c.args.join(" ").includes("CloseMainWindow"))).toBe(false);
  });

  test("the ancestry walk climbs past the immediate parent", () => {
    const calls: Call[] = [];
    const parents: Record<number, string> = { 900: "800", 800: "1000", 1000: "0" };
    const result = withTrustedExes(() => restartCodexDesktopApp({
      platform: "win32",
      sleep: () => {},
      isAlive: () => false,
      execFile: (file, args) => {
        calls.push({ file, args: [...args] });
        const joined = args.join(" ");
        if (joined.includes("Get-AppxPackage")) return DISCOVERY;
        const hop = /ProcessId=(\d+)/.exec(joined);
        // The chain is self -> 900 -> 800 -> 1000, so the target IS an ancestor
        // several hops up. A process.ppid-only check would have missed it.
        if (hop) return parents[Number(hop[1])] ?? String(900);
        if (joined.includes("Win32_Process")) return "1000 900 T0";
        return "";
      },
    }));
    expect(result.reason).toBe("self_ancestry");
    expect(calls.some(c => c.file === TASKKILL)).toBe(false);
  });
});


describe("#2557 a failed probe is not an absent app", () => {
  test("an enumeration that throws reports process_probe_failed, not no_targets", () => {
    // Returning [] on a throwing probe made "we could not look" indistinguishable from
    // "we looked and found nothing", so the CLI said the app was not running and silently
    // skipped the restart the user asked for.
    const calls: Call[] = [];
    const result = withTrustedExes(() => restartCodexDesktopApp(scriptedIo({
      discovery: DISCOVERY,
      calls,
      throwOn: (_file, args) => args.join(" ").includes("Win32_Process"),
    })));
    expect(result.reason).toBe("process_probe_failed");
    expect(result.attempted).toBe(false);
    // Fail closed: nothing was terminated and nothing was relaunched on unreadable evidence.
    expect(result.stopped).toEqual([]);
    expect(result.relaunch).toBe("skipped");
  });

  test("an empty enumeration still reports no_targets", () => {
    // The two states must stay distinguishable in both directions.
    const calls: Call[] = [];
    const result = withTrustedExes(() => restartCodexDesktopApp(scriptedIo({
      discovery: DISCOVERY, processes: "", calls,
    })));
    expect(result.reason).toBe("no_targets");
  });

  test("the probe script separates PowerShell statements with newlines", () => {
    // Joined with spaces, `$ErrorActionPreference='SilentlyContinue' $root = '...'` is one
    // malformed statement and PowerShell rejects the whole script.
    const calls: Call[] = [];
    withTrustedExes(() => restartCodexDesktopApp(scriptedIo({
      discovery: DISCOVERY, processes: "", calls,
    })));
    const probe = calls.find(call => call.args.join(" ").includes("Win32_Process"));
    expect(probe).toBeTruthy();
    const script = probe!.args[probe!.args.length - 1]!;
    expect(script).toContain("SilentlyContinue'\n");
    expect(script).not.toContain("SilentlyContinue' $root");
  });
});

