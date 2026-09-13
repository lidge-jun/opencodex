import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restartCodexDesktopApp, type DesktopAppRestartIo } from "../../src/codex/desktop-app-restart";
import { isUnderRoot } from "../../src/codex/desktop-app/types";
import {
  acquireDesktopRestartLock,
  releaseDesktopRestartLock,
  transferDesktopRestartLock,
} from "../../src/codex/desktop-app/lock";

/**
 * The macOS and Linux halves of the desktop restart, plus the singleton lock.
 *
 * The Windows cases live in desktop-app-restart.test.ts and still pass unchanged,
 * which is what shows the move to a shared ladder preserved that platform.
 */

/**
 * A REAL directory, not the conventional `/Applications/ChatGPT.app`.
 *
 * Discovery resolves the bundle through `realpathSync`, which touches the actual
 * filesystem and cannot be intercepted by the exec seam. Pointing these cases at the
 * conventional path made them pass on a machine with Codex installed and fail on a
 * Linux CI runner without it - the local pass was an accident of the developer's own
 * machine. Building the bundle under a temp directory makes the case hermetic and
 * exercises the same code path everywhere.
 */
const BUNDLE = (() => {
  const root = join(mkdtempSync(join(tmpdir(), "ocx-bundle-")), "ChatGPT.app");
  mkdirSync(join(root, "Contents", "MacOS"), { recursive: true });
  // realpath it HERE so the fixture and the adapter agree. Discovery resolves the
  // bundle, and on macOS the temp directory lives under /var, which is a symlink to
  // /private/var - leaving the fixture unresolved makes every enumerated process fall
  // outside the resolved root and the tree reads as empty.
  return realpathSync(root);
})();
const SHELL = BUNDLE + "/Contents/MacOS/ChatGPT";
const HELPER = BUNDLE + "/Contents/Frameworks/Codex Framework.framework/Versions/152.0.7977.83/Helpers/Codex (Service).app/Contents/MacOS/Codex (Service)";
const CRASHPAD = BUNDLE + "/Contents/Frameworks/Codex Framework.framework/Versions/152.0.7977.83/Helpers/browser_crashpad_handler";
const WHEN = "Sun Sep 13 18:06:22 2026";

interface Call { file: string; args: string[] }

function isolatedLock(): { lockPath: string } {
  return { lockPath: join(mkdtempSync(join(tmpdir(), "ocx-posix-restart-")), "lock") };
}

/** Rows are "pid ppid lstart uid comm", exactly as /bin/ps -o ... prints them. */
function psRows(rows: Array<[number, number, string]>): string {
  return rows.map(([pid, ppid, exe]) => `${pid} ${ppid} ${WHEN}   ${process.getuid?.() ?? 0} ${exe}`).join("\n");
}

function darwinIo(options: {
  calls: Call[];
  rows?: Array<[number, number, string]>;
  ancestry?: number[];
  psThrows?: boolean;
  bundleId?: string;
}): DesktopAppRestartIo {
  // A process that has exited must also STOP BEING LISTED. Modelling exit only through
  // isAlive is what let a ladder claim a stop the enumeration still contradicted.
  const dead = new Set<number>();
  return {
    platform: "darwin",
    lock: isolatedLock(),
    ancestryPids: () => options.ancestry ?? [99_999],
    isAlive: (pid: number) => { dead.add(pid); return false; },
    sleep: () => {},
    now: (() => { let t = 0; return () => (t += 500); })(),
    execFile: (file, args) => {
      options.calls.push({ file, args: [...args] });
      if (file === "/bin/ps") {
        if (options.psThrows) throw new Error("ps failed");
        const rows = (options.rows ?? [[15901, 1, SHELL]] as Array<[number, number, string]>)
          .filter(([pid]) => !dead.has(pid));
        return psRows(rows);
      }
      if (file === "/usr/libexec/PlistBuddy") return options.bundleId ?? "com.openai.codex";
      // Spotlight resolves to the fixture bundle. Returning nothing here let discovery
      // fall through to the conventional /Applications path, which exists on a developer
      // Mac and not on a CI runner - so a case meant to exercise a FAILED PROCESS PROBE
      // reported a failed package discovery instead, depending on the machine.
      if (file === "/usr/bin/mdfind") return BUNDLE;
      return "";
    },
  };
}

describe("desktop restart membership is a path boundary, not a prefix", () => {
  test("a sibling directory sharing the prefix is not a member", () => {
    expect(isUnderRoot(BUNDLE + "/Contents/MacOS/ChatGPT", BUNDLE)).toBe(true);
    expect(isUnderRoot(BUNDLE, BUNDLE)).toBe(true);
    // The whole reason isUnderRoot exists: the same user can create these.
    expect(isUnderRoot("/Applications/ChatGPT.app-evil/Contents/MacOS/ChatGPT", BUNDLE)).toBe(false);
    expect(isUnderRoot("/usr/lib/chatgpt-evil/ChatGPT", "/usr/lib/chatgpt")).toBe(false);
    expect(isUnderRoot("/usr/lib/chatgpt/ChatGPT", "/usr/lib/chatgpt")).toBe(true);
  });
});

describe("macOS desktop restart", () => {
  test("quits through the Apple event and relaunches by bundle id", () => {
    const calls: Call[] = [];
    const result = restartCodexDesktopApp(darwinIo({ calls }));
    expect(result.relaunch).toBe("started");
    expect(result.stopped).toEqual([15901]);
    const quit = calls.find(call => call.file === "/usr/bin/osascript");
    expect(quit?.args.join(" ")).toContain('quit app id "com.openai.codex"');
    const open = calls.find(call => call.file === "/usr/bin/open");
    // Relaunch is by the DISCOVERED identifier, and never -n: a second instance is
    // both unreliable to obtain and unwanted.
    expect(open?.args).toEqual(["-b", "com.openai.codex"]);
    expect(calls.some(call => call.args.includes("-n"))).toBe(false);
  });

  test("a crashpad handler at ppid 1 is never a restart target", () => {
    // Measured live: the running app owns crashpad handlers at ppid 1, and an instance
    // that already exited leaves more behind. Under a plain "parent is not a member"
    // rule every one of them is a root, so they would be signalled and a survivor would
    // block the relaunch forever.
    const calls: Call[] = [];
    const result = restartCodexDesktopApp(darwinIo({
      calls,
      rows: [[15901, 1, SHELL], [15903, 1, CRASHPAD], [15905, 1, CRASHPAD], [15910, 15901, HELPER]],
    }));
    expect(result.stopped).toEqual([15901]);
    const quits = calls.filter(call => call.file === "/usr/bin/osascript");
    expect(quits).toHaveLength(1);
  });

  test("an executable path containing spaces and parentheses still parses", () => {
    // ps prints the full untruncated path in comm, and this app's helpers are literally
    // named "Codex (Service)". A parser that split on whitespace would drop them.
    const calls: Call[] = [];
    restartCodexDesktopApp(darwinIo({ calls, rows: [[15901, 1, SHELL], [15910, 15901, HELPER]] }));
    expect(calls.some(call => call.file === "/usr/bin/open")).toBe(true);
  });

  test("a ps probe that throws reports process_probe_failed, not no_targets", () => {
    // #2557 in its macOS form: "we could not look" must never be reported as
    // "the app is not running".
    const calls: Call[] = [];
    const result = restartCodexDesktopApp(darwinIo({ calls, psThrows: true }));
    expect(result.reason).toBe("process_probe_failed");
    expect(result.attempted).toBe(false);
  });

  test("a bundle whose identifier is not com.openai.codex is not discovered", () => {
    // The bundle is named ChatGPT.app and that name is shared with another product, so
    // identity has to come from the identifier.
    const calls: Call[] = [];
    const result = restartCodexDesktopApp(darwinIo({ calls, bundleId: "com.openai.chat" }));
    expect(result.reason).toBe("package_discovery_failed");
  });

  test("being inside the app tree refuses instead of killing its own session", () => {
    const calls: Call[] = [];
    const result = restartCodexDesktopApp(darwinIo({ calls, ancestry: [4242, 15901, 1] }));
    expect(result.reason).toBe("self_ancestry");
    expect(calls.some(call => call.file === "/usr/bin/osascript")).toBe(false);
  });

  test("an unreadable ancestry chain fails closed", () => {
    const calls: Call[] = [];
    const result = restartCodexDesktopApp(darwinIo({ calls, ancestry: [] }));
    expect(result.reason).toBe("self_ancestry");
    expect(calls.some(call => call.file === "/usr/bin/osascript")).toBe(false);
  });

  test("a failed relaunch is reported as relaunch_failed, not targets_survived", () => {
    // Everything DID die; it is the relaunch that failed. Reporting the two as one sent
    // operators looking for processes that were not there.
    const calls: Call[] = [];
    // This double overrides execFile wholesale, so it has to model exit itself: the
    // shell stops being listed once liveness has reported it dead, exactly as the real
    // enumeration behaves.
    const dead = new Set<number>();
    const result = restartCodexDesktopApp({
      ...darwinIo({ calls }),
      isAlive: (pid: number) => { dead.add(pid); return false; },
      execFile: (file, args) => {
        calls.push({ file, args: [...args] });
        if (file === "/usr/bin/open") throw new Error("LSCopyApplicationURLsForBundleIdentifier() failed");
        if (file === "/bin/ps") {
          return psRows(([[15901, 1, SHELL]] as Array<[number, number, string]>)
            .filter(([pid]) => !dead.has(pid)));
        }
        if (file === "/usr/libexec/PlistBuddy") return "com.openai.codex";
        return "";
      },
    });
    expect(result.reason).toBe("relaunch_failed");
    expect(result.surviving).toEqual([]);
    expect(result.stopped).toEqual([15901]);
  });
});

describe("a stop is only ever claimed when the enumeration agrees (measured on Windows)", () => {
  // The defect this pins was invisible to ten rounds of code review and surfaced in the
  // first thirty seconds of running the ladder on a real Windows host: it reported
  // {"stopped":[27788],"surviving":[],"relaunch":"started"} while the app kept its
  // original pid AND start time throughout. A pid-based liveness probe is a weaker
  // instrument than the platform's own process list, and when the two disagree the list
  // wins - otherwise the ladder relaunches into an app that never quit and tells the
  // operator it restarted.
  test("liveness saying dead does not override an enumeration that still lists the process", () => {
    const calls: Call[] = [];
    const result = restartCodexDesktopApp({
      platform: "darwin",
      lock: isolatedLock(),
      ancestryPids: () => [99_999],
      // Liveness lies: it claims the process is gone.
      isAlive: () => false,
      sleep: () => {},
      now: (() => { let t = 0; return () => (t += 500); })(),
      execFile: (file, args) => {
        calls.push({ file, args: [...args] });
        // The enumeration keeps listing it, unchanged, which is the truth.
        if (file === "/bin/ps") return psRows([[15901, 1, SHELL]]);
        if (file === "/usr/libexec/PlistBuddy") return "com.openai.codex";
        return "";
      },
    });
    expect(result.stopped).toEqual([]);
    expect(result.surviving).toEqual([15901]);
    expect(result.relaunch).toBe("skipped");
    expect(result.reason).toBe("targets_survived");
    // And crucially: no relaunch beside a live app.
    expect(calls.some(call => call.file === "/usr/bin/open")).toBe(false);
  });

  test("a re-probe that cannot run is a survivor, never a silent success", () => {
    // "We could not look" must not read as "it exited". Reporting a survivor blocks the
    // relaunch, which is the right outcome when the tree state is unknown.
    const calls: Call[] = [];
    let probes = 0;
    const result = restartCodexDesktopApp({
      platform: "darwin",
      lock: isolatedLock(),
      ancestryPids: () => [99_999],
      isAlive: () => false,
      sleep: () => {},
      now: (() => { let t = 0; return () => (t += 500); })(),
      execFile: (file, args) => {
        calls.push({ file, args: [...args] });
        if (file === "/usr/libexec/PlistBuddy") return "com.openai.codex";
        if (file === "/bin/ps") {
          probes += 1;
          // Discovery and the first enumeration succeed; the re-verification fails.
          if (probes > 2) throw new Error("ps failed");
          return psRows([[15901, 1, SHELL]]);
        }
        return "";
      },
    });
    expect(result.stopped).toEqual([]);
    expect(result.surviving).toEqual([15901]);
    expect(result.reason).toBe("targets_survived");
    expect(calls.some(call => call.file === "/usr/bin/open")).toBe(false);
  });
});

describe("the restart singleton lock", () => {
  const alive = new Set<number>([1001, 1002, 2001]);
  const io = (lockPath: string, pid: number) => ({
    lockPath, pid, isAlive: (p: number) => alive.has(p), now: () => 1_000_000,
  });

  test("a second caller is refused rather than queued", () => {
    // Two ladders at once are destructive, not merely wasteful: the second re-enumerates
    // during the first's relaunch and kills the app that was just started.
    const { lockPath } = isolatedLock();
    expect(acquireDesktopRestartLock(io(lockPath, 1001)).acquired).toBe(true);
    expect(acquireDesktopRestartLock(io(lockPath, 1002))).toEqual({ acquired: false, heldBy: 1001 });
  });

  test("the owner re-acquires its own lock, which is what lets a helper inherit one", () => {
    const { lockPath } = isolatedLock();
    acquireDesktopRestartLock(io(lockPath, 1001));
    expect(acquireDesktopRestartLock(io(lockPath, 1001)).acquired).toBe(true);
    expect(transferDesktopRestartLock(2001, io(lockPath, 1001))).toBe(true);
    expect(acquireDesktopRestartLock(io(lockPath, 2001)).acquired).toBe(true);
    expect(acquireDesktopRestartLock(io(lockPath, 1002))).toEqual({ acquired: false, heldBy: 2001 });
  });

  test("releasing a lock owned by somebody else is a no-op", () => {
    const { lockPath } = isolatedLock();
    acquireDesktopRestartLock(io(lockPath, 1001));
    releaseDesktopRestartLock(io(lockPath, 1002));
    expect(acquireDesktopRestartLock(io(lockPath, 1002))).toEqual({ acquired: false, heldBy: 1001 });
  });

  test("a lock whose owner is gone is reclaimed", () => {
    const { lockPath } = isolatedLock();
    acquireDesktopRestartLock(io(lockPath, 1001));
    alive.delete(1001);
    expect(acquireDesktopRestartLock(io(lockPath, 1002)).acquired).toBe(true);
    alive.add(1001);
  });

  test("a corrupt lock file does not wedge every future restart", () => {
    // Reachable whenever a writer dies between creating the file and writing it.
    const { lockPath } = isolatedLock();
    writeFileSync(lockPath, "{not json");
    expect(acquireDesktopRestartLock(io(lockPath, 1001)).acquired).toBe(true);
  });
});

describe("a restart already in flight does not start a second one", () => {
  test("the ladder reports restart_in_flight and touches nothing", () => {
    const { lockPath } = isolatedLock();
    const holder = process.pid + 1;
    // Liveness is stated on BOTH sides. Leaving the restart's own lock io to the real
    // isAlive made the case depend on whether pid+1 happened to exist: alone it passed,
    // alongside other files the holder read as dead, the lock was reclaimed as stale and
    // the restart proceeded. The behaviour under test is contention, not pid roulette.
    acquireDesktopRestartLock({ lockPath, pid: holder, isAlive: () => true });
    const calls: Call[] = [];
    const result = restartCodexDesktopApp({
      ...darwinIo({ calls }),
      lock: { lockPath, isAlive: () => true },
    });
    expect(result.reason).toBe("restart_in_flight");
    expect(calls).toEqual([]);
  });
});

