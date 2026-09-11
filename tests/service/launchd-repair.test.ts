/**
 * macOS repair/status protocol — issue #4236, defects 1 and 2.
 *
 * The reported failure: one `ocx service repair` on a hub took the public proxy, the
 * management ingress and the loopback listener down at once, printed success, and left
 * `ocx status` recommending the same repair. On darwin `repair` IS `installLaunchd`, which
 * evicted the live job with a domain-explicit `bootout`, re-registered with the
 * domain-IMPLICIT legacy `launchctl load -w`, and accepted exit-0-with-empty-stderr as
 * proof. Measured on macOS 27.0 (Darwin 27, arm64) with a throwaway
 * `com.opencodex.test-probe` label:
 *
 *   launchctl print gui/$uid/<label>      → 0 loaded | 113 no such service | 112 no such domain
 *   launchctl bootstrap gui/$uid <plist>  → 0 first time, 5 "Bootstrap failed: 5" when bootstrapped
 *   launchctl load -w <plist>             → 0 AND "Load failed: 5" when bootstrapped (the no-op)
 *   launchctl kickstart -k gui/$uid/<l>   → 0 loaded | 113 absent
 *   launchctl bootout gui/$uid/<label>    → 0 evicted | 3 "Boot-out failed: 3: No such process"
 *
 * Every case here drives the injected seam and reaches no real launchd: the
 * live-service-manager guard refuses `bootout`/`bootstrap` from an armed test process, and
 * `installLaunchd` is handed an explicit plist path because `os.homedir()` reads the
 * password database rather than `$HOME` — so the suite's HOME sandbox does NOT move
 * `~/Library/LaunchAgents`, and a case without that seam rewrites the developer's own live
 * `com.opencodex.proxy.plist`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPlist,
  deriveLaunchdServiceDiagnostic,
  installLaunchd,
  launchdEvictionTargets,
  probeLaunchdLoadState,
  repairService,
  resolvedProxyEnv,
  restartLaunchdJob,
  reusePreviousPlistPathVariable,
  runLaunchctl,
  stableLauncherEntry,
} from "../../src/service";
import type {
  LaunchdLoadProbe,
  LaunchdLoadState,
  ServiceDiagnostic,
  ServiceRepairVerb,
} from "../../src/service";
import { protectedLaunchAgentsDirForTests } from "../../src/lib/test-home-guard";
import { repoPath } from "../helpers/repo-root";

/**
 * Pin OPENCODEX_HOME per case. `buildPlist` reads config through `getConfigDir()`, and when
 * OPENCODEX_HOME is absent that falls back to `join(homedir(), ".opencodex")` — the real
 * one, because `os.homedir()` ignores `$HOME`. A sibling file in the same Bun worker that
 * clears or restores the variable would otherwise make these cases fail on the real-home
 * guard instead of on anything they assert.
 *
 * Captured and RESTORED, because the pollution runs both ways: the test preload hands every
 * worker a sandbox home, and a file that leaves its own temp directory in the variable makes
 * the next file in the same worker read a home this one deleted.
 */
const previousOpenCodexHome = process.env.OPENCODEX_HOME;
beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), "ocx-launchd-home-"));
  mkdirSync(join(home, ".opencodex"), { recursive: true });
  process.env.OPENCODEX_HOME = join(home, ".opencodex");
});
afterEach(() => {
  if (previousOpenCodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpenCodexHome;
});

type LaunchctlResult = { ok: boolean; stdout: string; stderr: string; status: number | null };

function ok(stdout = ""): LaunchctlResult {
  return { ok: true, stdout, stderr: "", status: 0 };
}
function fail(status: number, stderr: string): LaunchctlResult {
  return { ok: false, stdout: "", stderr, status };
}

/**
 * A `runLaunchctl` stand-in that records every argv and answers from a per-verb script.
 * `bootstrap` consumes its queue; exhausting it is a fixture bug, not a passing case.
 */
function recordingLaunchctl(script: {
  bootstrap?: LaunchctlResult[];
  print?: LaunchctlResult;
  kickstart?: LaunchctlResult;
  bootout?: LaunchctlResult;
}) {
  const argv: string[][] = [];
  let bootstraps = 0;
  const launchctl = ((args: string[]): LaunchctlResult => {
    argv.push([...args]);
    const verb = args[0] ?? "";
    if (verb === "bootstrap") {
      const queued = script.bootstrap?.[bootstraps++];
      if (!queued) throw new Error(`unexpected bootstrap #${bootstraps}: the fixture queued ${script.bootstrap?.length ?? 0}`);
      return queued;
    }
    // Default `print` is 113 so the settle loop sees an evicted domain and returns at once.
    if (verb === "print") return script.print ?? fail(113, "Could not find service");
    if (verb === "kickstart") return script.kickstart ?? ok();
    if (verb === "bootout") return script.bootout ?? ok();
    return ok();
  }) as typeof runLaunchctl;
  return { argv, launchctl };
}

const verbs = (argv: string[][]): string[] => argv.map(args => args[0] ?? "");

/**
 * A {@link probeLaunchdLoadState} stand-in answering from a queue, the LAST entry repeating.
 *
 * `installLaunchd` asks the tri-state probe rather than the two-state
 * `launchdJobMatchesPlist` precisely so `unknown` can be distinguished from absence, so the
 * fixture has to be able to say all four things.
 */
function scriptedProbe(...states: Array<LaunchdLoadState | LaunchdLoadProbe>) {
  const seen: LaunchdLoadState[] = [];
  let call = 0;
  const probe = ((): LaunchdLoadProbe => {
    const next = states[Math.min(call++, states.length - 1)] ?? "not-loaded";
    const answer: LaunchdLoadProbe = typeof next === "string"
      ? { state: next, ...(next.startsWith("loaded") ? { domain: "gui/501" } : {}) }
      : next;
    seen.push(answer.state);
    return answer;
  }) as typeof probeLaunchdLoadState;
  return { seen, probe };
}

/** The tri-state answer a healthy hub gives, for the cases that only need one. */
const loadedCurrent = (): { seen: LaunchdLoadState[]; probe: typeof probeLaunchdLoadState } =>
  scriptedProbe("loaded-current");

/** A fixture LaunchAgents directory plus the plist path inside it. */
function fixturePlist(): string {
  return join(mkdtempSync(join(tmpdir(), "ocx-launchd-repair-")), "com.opencodex.proxy.plist");
}

/** The plist `installLaunchd` will render in this process, for the byte-identical case. */
function renderedPlist(): string {
  return buildPlist(resolvedProxyEnv(), { launcher: stableLauncherEntry() });
}

/** Collect `console.log` lines for the one case whose contract IS the printed line. */
function captureLog(body: () => void): string[] {
  const lines: string[] = [];
  const previous = console.log;
  console.log = (...parts: unknown[]) => { lines.push(parts.join(" ")); };
  try {
    body();
  } finally {
    console.log = previous;
  }
  return lines;
}

describe("installLaunchd: repair must not be an outage (#4236 defect 1)", () => {
  test("a healthy job loaded from a byte-identical plist is a no-op — launchd is never touched", () => {
    const plistPath = fixturePlist();
    writeFileSync(plistPath, renderedPlist(), "utf8");
    const { argv, launchctl } = recordingLaunchctl({});

    installLaunchd({ launchctl, plistPath, probe: loadedCurrent().probe, sleepSync: () => {} });

    // THE regression: no bootout, no bootstrap, no kickstart. Repairing a serving hub
    // used to evict it unconditionally.
    expect(argv).toEqual([]);
    // And nothing was backed up, because nothing was overwritten.
    expect(existsSync(`${plistPath}.prev`)).toBe(false);
  });

  /**
   * Review finding 2. `buildPlist` bakes `process.env.PATH`, so the byte comparison above
   * only holds for a repair run from the same shell that installed the service. From a tray
   * helper, `ocx update`'s child or an ssh session the PATH line differs, every other byte
   * is identical, and the healthy hub was evicted anyway — with its PATH rewritten to the
   * narrower one.
   */
  test("a plist that differs ONLY in the baked PATH is still a no-op, and keeps the installed PATH", () => {
    const plistPath = fixturePlist();
    const previousPath = process.env.PATH;
    try {
      // The login shell that installed the service. The extra entry is deliberately a
      // directory that cannot exist, so both PATHs resolve the SAME launcher (none) and the
      // exec line is identical on every host.
      process.env.PATH = "/opt/ocx-login-shell-only/bin:/usr/bin:/bin";
      const installedPlist = renderedPlist();
      // The tray helper / cron context that runs the repair.
      process.env.PATH = "/usr/bin:/bin";
      const repairPlist = renderedPlist();
      // Precondition of the case: PATH is the ONLY difference (neither PATH resolves an
      // `ocx`, so the exec line is identical).
      expect(repairPlist).not.toBe(installedPlist);
      expect(repairPlist.replace(/<key>PATH<\/key><string>[^\n]*<\/string>/, "P"))
        .toBe(installedPlist.replace(/<key>PATH<\/key><string>[^\n]*<\/string>/, "P"));

      writeFileSync(plistPath, installedPlist, "utf8");
      const { argv, launchctl } = recordingLaunchctl({});

      installLaunchd({ launchctl, plistPath, probe: loadedCurrent().probe, sleepSync: () => {} });

      expect(argv).toEqual([]);
      // The installed PATH survived: a repair must not narrow the environment the service
      // runs in just because of who invoked it.
      expect(readFileSync(plistPath, "utf8")).toBe(installedPlist);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  test("an identical plist whose job is loaded from an OLDER command still reloads", () => {
    const plistPath = fixturePlist();
    writeFileSync(plistPath, renderedPlist(), "utf8");
    const { argv, launchctl } = recordingLaunchctl({ bootstrap: [ok()] });

    installLaunchd({
      launchctl,
      plistPath,
      // First answer is the no-op pre-check (stale ⇒ do the repair); the second is the
      // post-bootstrap verification.
      probe: scriptedProbe("loaded-stale", "loaded-current").probe,
      sleepSync: () => {},
    });

    expect(verbs(argv)).toContain("bootstrap");
    // Review nit 7: the rollback copy is removed once the new job is verified, so the next
    // repair's backup cannot be mistaken for this one's.
    expect(existsSync(`${plistPath}.prev`)).toBe(false);
  });

  test("the reload is domain-explicit bootstrap in BOTH domains, not legacy load -w", () => {
    const plistPath = fixturePlist();
    const { argv, launchctl } = recordingLaunchctl({ bootstrap: [ok()] });

    installLaunchd({
      launchctl,
      plistPath,
      probe: scriptedProbe("not-loaded", "loaded-current").probe,
      sleepSync: () => {},
    });

    // `load` acts on the CALLER's bootstrap domain, so from ssh/cron it deleted the
    // gui-domain job and registered nothing (defect 1a).
    expect(verbs(argv)).not.toContain("load");
    expect(verbs(argv)).not.toContain("unload");
    const bootstrap = argv.find(args => args[0] === "bootstrap");
    expect(bootstrap?.[1]).toMatch(/^gui\/\d+$/);
    expect(bootstrap?.[2]).toBe(plistPath);
    // Review finding 4: the probe reports `user/<uid>` too, so the eviction covers it.
    // Evicting gui alone left a user-domain registration of the same Label alive and then
    // bootstrapped a SECOND one into gui — two KeepAlive jobs for one port.
    const bootouts = argv.filter(args => args[0] === "bootout").map(args => args[1] ?? "");
    expect(bootouts).toEqual(launchdEvictionTargets());
    expect(bootouts[0]).toMatch(/^gui\/\d+\/com\.opencodex\.proxy$/);
    expect(bootouts[1]).toMatch(/^user\/\d+\/com\.opencodex\.proxy$/);
    // bootout before bootstrap, with the settle probe in between.
    expect(verbs(argv).indexOf("bootout")).toBeLessThan(verbs(argv).indexOf("bootstrap"));
  });

  test("the settle loop waits while print still answers 0, and is bounded", () => {
    const plistPath = fixturePlist();
    const delays: number[] = [];
    // `print` keeps answering 0: the job has not finished exiting.
    const { argv, launchctl } = recordingLaunchctl({ bootstrap: [ok()], print: ok("live") });

    installLaunchd({
      launchctl,
      plistPath,
      probe: scriptedProbe("not-loaded", "loaded-current").probe,
      sleepSync: ms => { delays.push(ms); },
    });

    // 5 × 200 ms per evicted domain, then give up and try the bootstrap anyway — a wedged
    // domain must reach the diagnosable throw rather than hang.
    expect(delays).toEqual(Array.from({ length: 10 }, () => 200));
    expect(verbs(argv).filter(v => v === "print")).toHaveLength(10);
  });

  test("a bootout that evicted nothing is not settled", () => {
    const plistPath = fixturePlist();
    const delays: number[] = [];
    // Exit 3 in both domains: nothing was loaded, so nothing is exiting to wait for.
    const { argv, launchctl } = recordingLaunchctl({
      bootstrap: [ok()],
      bootout: fail(3, "Boot-out failed: 3: No such process"),
      print: ok("live"),
    });

    installLaunchd({
      launchctl,
      plistPath,
      probe: scriptedProbe("not-loaded", "loaded-current").probe,
      sleepSync: ms => { delays.push(ms); },
    });

    expect(delays).toEqual([]);
    expect(verbs(argv)).toEqual(["bootout", "bootout", "bootstrap"]);
  });

  test("a clean bootstrap that did not take is a FAILURE, whatever stderr says", () => {
    const plistPath = fixturePlist();
    // Both bootstraps exit 0 with empty stderr — the old success condition exactly.
    const { argv, launchctl } = recordingLaunchctl({ bootstrap: [ok(), ok()] });

    expect(() => installLaunchd({
      launchctl,
      plistPath,
      probe: scriptedProbe("not-loaded").probe,
      sleepSync: () => {},
    })).toThrow(/could not bootstrap/);

    // Exit 0 + `print` disagreeing is a silent no-op, so it IS worth one more eviction.
    expect(verbs(argv).filter(v => v === "bootstrap")).toHaveLength(2);
  });

  test("'Bootstrap failed: 5' tries kickstart -k before a second eviction", () => {
    const plistPath = fixturePlist();
    // Byte-identical bytes are what makes `kickstart` legitimate here: it restarts the
    // definition launchd has CACHED, so it can only be trusted when the plist on disk is
    // unchanged. (The next case covers the other half.)
    writeFileSync(plistPath, renderedPlist(), "utf8");
    const { argv, launchctl } = recordingLaunchctl({
      bootstrap: [fail(5, "Bootstrap failed: 5: Input/output error")],
    });

    installLaunchd({
      launchctl,
      plistPath,
      // Pre-check says the job is gone, the verification right after the refused bootstrap
      // agrees, and the one after `kickstart -k` finds it.
      probe: scriptedProbe("not-loaded", "not-loaded", "loaded-current").probe,
      sleepSync: () => {},
    });

    expect(verbs(argv)).toContain("kickstart");
    const kickstart = argv.find(args => args[0] === "kickstart");
    expect(kickstart?.slice(1)).toEqual(["-k", kickstart?.[2] ?? ""]);
    expect(kickstart?.[2]).toMatch(/^gui\/\d+\/com\.opencodex\.proxy$/);
    // One bootstrap only: kickstart recovered it without a second eviction window.
    expect(verbs(argv).filter(v => v === "bootstrap")).toHaveLength(1);
  });

  /**
   * Review finding 3. `launchctl kickstart -k` restarts the definition launchd has CACHED;
   * it does NOT re-read the plist. When only `EnvironmentVariables` changed, the exec line
   * is identical, so the verification agrees, install state is written, repair reports
   * success — and launchd keeps serving with the OLD environment. New bytes therefore have
   * to go through the eviction, which is the only way to hand launchd a new definition.
   */
  test("new bytes never trust kickstart: an env-only change still takes the eviction", () => {
    const plistPath = fixturePlist();
    const rendered = renderedPlist();
    const sandboxHome = process.env.OPENCODEX_HOME ?? "";
    expect(rendered).toContain(sandboxHome);
    // Differs from the rendered plist in ONE EnvironmentVariables value; the exec line and
    // every other byte are identical, which is exactly the case kickstart would paper over.
    const installedPlist = rendered.replace(sandboxHome, join(sandboxHome, "moved"));
    expect(installedPlist).not.toBe(rendered);
    writeFileSync(plistPath, installedPlist, "utf8");
    const { argv, launchctl } = recordingLaunchctl({
      bootstrap: [fail(5, "Bootstrap failed: 5: Input/output error"), ok()],
      // Would succeed if it were asked — the point is that it is not.
      kickstart: ok(),
    });

    installLaunchd({
      launchctl,
      plistPath,
      // The live job runs the command this install bakes (only the env moved), so the
      // pre-check is `loaded-current` — and must still reload, because PATH is the only
      // difference a repair is allowed to treat as "nothing to do".
      probe: scriptedProbe("loaded-current", "not-loaded", "loaded-current").probe,
      sleepSync: () => {},
    });

    expect(verbs(argv)).not.toContain("kickstart");
    expect(verbs(argv).filter(v => v === "bootstrap")).toHaveLength(2);
    // The new definition is what is on disk for launchd to read.
    expect(readFileSync(plistPath, "utf8")).toBe(rendered);
  });

  /**
   * The second meaning of exit 5. Measured on macOS 27.0: `launchctl disable gui/$uid/<label>`
   * makes `bootstrap` fail with the SAME "Bootstrap failed: 5: Input/output error" while
   * `print` reports 113 and `kickstart -k` reports 113. Legacy `load -w` cleared that flag —
   * that is what the `-w` meant — so dropping it without `enable` would make a disabled job
   * permanently unrepairable.
   */
  test("a DISABLED job is enabled and bootstrapped, the modern spelling of load -w", () => {
    const plistPath = fixturePlist();
    writeFileSync(plistPath, renderedPlist(), "utf8");
    const { argv, launchctl } = recordingLaunchctl({
      bootstrap: [fail(5, "Bootstrap failed: 5: Input/output error"), ok()],
      kickstart: fail(113, 'Could not find service "com.opencodex.proxy" in domain for user gui: 501'),
    });

    installLaunchd({
      launchctl,
      plistPath,
      // Loaded only after the enable + second bootstrap. A failed `kickstart` skips its own
      // verification, so the probe is asked exactly three times.
      probe: scriptedProbe("not-loaded", "not-loaded", "loaded-current").probe,
      sleepSync: () => {},
    });

    expect(verbs(argv)).toEqual([
      "bootout", "print", "bootout", "print", "bootstrap",
      "kickstart", "enable",
      "bootout", "print", "bootout", "print", "bootstrap",
    ]);
    const enable = argv.find(args => args[0] === "enable");
    expect(enable?.[1]).toMatch(/^gui\/\d+\/com\.opencodex\.proxy$/);
  });

  test("an ordinary repair never runs enable, so a deliberate disable is not undone", () => {
    const plistPath = fixturePlist();
    const { argv, launchctl } = recordingLaunchctl({ bootstrap: [ok()] });

    installLaunchd({
      launchctl,
      plistPath,
      probe: scriptedProbe("not-loaded", "loaded-current").probe,
      sleepSync: () => {},
    });

    expect(verbs(argv)).not.toContain("enable");
  });

  test("a malformed plist is not retried — the real stderr reaches the operator", () => {
    const plistPath = fixturePlist();
    const { argv, launchctl } = recordingLaunchctl({
      bootstrap: [fail(1, "Could not read plist: invalid XML")],
    });

    expect(() => installLaunchd({
      launchctl,
      plistPath,
      probe: scriptedProbe("not-loaded").probe,
      sleepSync: () => {},
    })).toThrow(/invalid XML/);

    expect(verbs(argv).filter(v => v === "bootstrap")).toHaveLength(1);
    expect(verbs(argv)).not.toContain("kickstart");
  });

  test("terminal failure restores the previous plist bytes and names the manual remedy", () => {
    const plistPath = fixturePlist();
    const previous = "<plist>the definition that was serving</plist>\n";
    writeFileSync(plistPath, previous, "utf8");
    const { argv, launchctl } = recordingLaunchctl({ bootstrap: [ok(), ok(), ok()] });

    let thrown: unknown;
    try {
      installLaunchd({
        launchctl,
        plistPath,
        probe: scriptedProbe("not-loaded").probe,
        sleepSync: () => {},
      });
    } catch (error) {
      thrown = error;
    }

    const message = thrown instanceof Error ? thrown.message : String(thrown);
    // The operator must be told the job is DOWN — the silent version of this is the outage.
    expect(message).toMatch(/evicted from gui\/\d+/);
    // And given the one command that recovered the real host, which `ocx` never printed.
    expect(message).toMatch(/launchctl bootstrap gui\/\d+ /);
    expect(message).toContain(plistPath);
    // Exit 5 can also mean the label sits in the domain's disabled list, so point at it.
    expect(message).toMatch(/launchctl print-disabled gui\/\d+/);
    // Rollback: the bytes that were serving are back on disk, and backed up next to it.
    expect(readFileSync(plistPath, "utf8")).toBe(previous);
    expect(readFileSync(`${plistPath}.prev`, "utf8")).toBe(previous);
    // The third bootstrap is the rollback's own re-registration attempt.
    expect(verbs(argv).filter(v => v === "bootstrap")).toHaveLength(3);
  });

  /**
   * A job that comes back under a DIFFERENT command is running. Telling its operator
   * "nothing is listening" sends them to fix the wrong thing — and the two-state
   * `launchdJobMatchesPlist` this function used could not tell the two apart at all.
   */
  test("a job that reloaded from a different command is reported as loaded, not as down", () => {
    const plistPath = fixturePlist();
    writeFileSync(plistPath, "<plist>previous</plist>\n", "utf8");
    const { launchctl } = recordingLaunchctl({ bootstrap: [ok(), ok(), ok()] });

    expect(() => installLaunchd({
      launchctl,
      plistPath,
      probe: scriptedProbe("not-loaded", "loaded-stale").probe,
      sleepSync: () => {},
    })).toThrow(/is still loaded in gui\/501 from a DIFFERENT command/);
  });

  test("a fresh install has nothing to restore and says so without inventing a rollback", () => {
    const plistPath = fixturePlist();
    const { argv, launchctl } = recordingLaunchctl({ bootstrap: [ok(), ok()] });

    expect(() => installLaunchd({
      launchctl,
      plistPath,
      probe: scriptedProbe("not-loaded").probe,
      sleepSync: () => {},
    })).toThrow(/ocx service install/);

    expect(existsSync(`${plistPath}.prev`)).toBe(false);
    expect(verbs(argv).filter(v => v === "bootstrap")).toHaveLength(2);
  });

  /**
   * Review finding 1. `launchdJobMatchesPlist` reports `loaded: false` for EVERY non-zero
   * `launchctl print` — EPERM from a non-Aqua ssh/cron context, an unspawnable launchctl, an
   * undocumented status. Routed through that, a healthy serving hub failed the pre-check
   * (evict), failed the verification the same way (evict again, roll back) and was finally
   * declared "IS NOT RUNNING" while it was up. A probe that could not answer is not evidence.
   */
  test("an unverifiable launchd state refuses to evict and changes nothing", () => {
    const plistPath = fixturePlist();
    const installedPlist = "<plist>the definition that is serving</plist>\n";
    writeFileSync(plistPath, installedPlist, "utf8");
    const { argv, launchctl } = recordingLaunchctl({});

    let thrown: unknown;
    try {
      installLaunchd({
        launchctl,
        plistPath,
        probe: scriptedProbe({
          state: "unknown",
          detail: "launchctl print gui/501/com.opencodex.proxy exited 1",
        }).probe,
        sleepSync: () => {},
      });
    } catch (error) {
      thrown = error;
    }

    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message).toContain("could not be verified");
    expect(message).toContain("nothing was changed");
    // Never the claim that made the outage undiagnosable.
    expect(message).not.toContain("IS NOT RUNNING");
    // Named so the operator can ask the question themselves, in both domains.
    expect(message).toMatch(/launchctl print gui\/\d+\/com\.opencodex\.proxy/);
    expect(message).toMatch(/launchctl print user\/\d+\/com\.opencodex\.proxy/);
    // No launchctl verb ran, and the plist on disk is untouched.
    expect(argv).toEqual([]);
    expect(readFileSync(plistPath, "utf8")).toBe(installedPlist);
    expect(existsSync(`${plistPath}.prev`)).toBe(false);
  });

  test("a state that stops answering AFTER an accepted bootstrap is not evicted again", () => {
    const plistPath = fixturePlist();
    writeFileSync(plistPath, "<plist>previous</plist>\n", "utf8");
    const { argv, launchctl } = recordingLaunchctl({ bootstrap: [ok()] });

    installLaunchd({
      launchctl,
      plistPath,
      probe: scriptedProbe("not-loaded", { state: "unknown", detail: "launchctl could not be run: EPERM" }).probe,
      sleepSync: () => {},
    });

    // One bootstrap, no retry and no rollback: a retry is another eviction, and the rollback
    // would evict a job we cannot prove is down.
    expect(verbs(argv).filter(v => v === "bootstrap")).toHaveLength(1);
    expect(readFileSync(plistPath, "utf8")).toBe(renderedPlist());
  });

  test("a bootstrap that FAILED under an unverifiable state throws without claiming the job is down", () => {
    const plistPath = fixturePlist();
    writeFileSync(plistPath, "<plist>previous</plist>\n", "utf8");
    const { argv, launchctl } = recordingLaunchctl({
      bootstrap: [fail(1, "Bootstrap failed: 1: Operation not permitted")],
    });

    let thrown: unknown;
    try {
      installLaunchd({
        launchctl,
        plistPath,
        probe: scriptedProbe("not-loaded", { state: "unknown", detail: "launchctl could not be run: EPERM" }).probe,
        sleepSync: () => {},
      });
    } catch (error) {
      thrown = error;
    }

    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message).toContain("Operation not permitted");
    expect(message).toContain("could not be verified");
    expect(message).not.toContain("IS NOT RUNNING");
    // No rollback bootstrap: restoring means evicting, and nothing here proves the job is
    // down.
    expect(verbs(argv).filter(v => v === "bootstrap")).toHaveLength(1);
  });

  test("the armed test guard refuses the developer's real LaunchAgents directory", () => {
    // Without the seam above, every case in this file rewrote the live plist.
    expect(() => installLaunchd({
      plistPath: join(protectedLaunchAgentsDirForTests(), "com.opencodex.proxy.plist"),
      launchctl: recordingLaunchctl({}).launchctl,
      probe: loadedCurrent().probe,
      sleepSync: () => {},
    })).toThrow(/real LaunchAgents directory/);
  });
});

/**
 * The other half of the no-op (#4249).
 *
 * `ocx service restart` runs the repair path, so once `installLaunchd` learned to return
 * early on a healthy loaded-current job, `restart` of a healthy service restarted NOTHING —
 * and the operator documentation had to tell people to run
 * `launchctl kickstart -k gui/$(id -u)/com.opencodex.proxy` by hand. `repair` keeps the
 * no-op (repairing a healthy service must not be an outage); only `restart` kicks.
 *
 * `restartLaunchd` is injected in every case here. Its default is the real
 * `restartLaunchdJob`, which would kickstart the live hub on this machine.
 */
describe("restart restarts, repair stays a no-op (#4249)", () => {
  const healthyDiag: ServiceDiagnostic = {
    supported: true,
    installed: true,
    enabled: true,
    running: true,
    viable: true,
    startable: false,
    stale: false,
    conflict: false,
    backend: "launchd",
    summary: "installed and loaded (launchd; gui/501)",
  };

  /**
   * Every `repairService` seam a darwin case can reach, owned by the case. `restartLaunchd`
   * records the call AND runs the real `restartLaunchdJob` over the same scripted launchctl,
   * so the argv assertions below cover the verb it actually spawns.
   */
  function darwinDeps(
    verb: ServiceRepairVerb,
    plistPath: string,
    launchctl: typeof runLaunchctl,
    probe: typeof probeLaunchdLoadState,
    restarts: string[],
  ) {
    return {
      platform: "darwin" as const,
      verb,
      diagnose: () => healthyDiag,
      assertEnv: () => {},
      assertAuth: () => {},
      repairLaunchd: () => installLaunchd({ launchctl, plistPath, probe, sleepSync: () => {} }),
      restartLaunchd: () => {
        restarts.push("restart");
        restartLaunchdJob({ launchctl, probe });
      },
    };
  }

  test("restart of a healthy loaded-current job kickstarts the gui domain and never boots it out", async () => {
    const plistPath = fixturePlist();
    writeFileSync(plistPath, renderedPlist(), "utf8");
    const { argv, launchctl } = recordingLaunchctl({});
    const restarts: string[] = [];

    await repairService(darwinDeps("restart", plistPath, launchctl, loadedCurrent().probe, restarts));

    expect(restarts).toEqual(["restart"]);
    // THE fix: one verb, and it is not an eviction. `kickstart -k` restarts what the domain
    // already holds, so the listener never goes away.
    expect(verbs(argv)).toEqual(["kickstart"]);
    expect(argv[0]?.slice(1, 2)).toEqual(["-k"]);
    expect(argv[0]?.[2]).toMatch(/^gui\/\d+\/com\.opencodex\.proxy$/);
    expect(verbs(argv)).not.toContain("bootout");
    expect(verbs(argv)).not.toContain("bootstrap");
    // The definition was never rewritten, so there is nothing to roll back.
    expect(existsSync(`${plistPath}.prev`)).toBe(false);
  });

  test("repair of the very same state restarts nothing at all", async () => {
    const plistPath = fixturePlist();
    writeFileSync(plistPath, renderedPlist(), "utf8");
    const { argv, launchctl } = recordingLaunchctl({});
    const restarts: string[] = [];

    await repairService(darwinDeps("repair", plistPath, launchctl, loadedCurrent().probe, restarts));

    // A repair of a healthy hub is still zero launchctl calls — the #4236 property. Only the
    // restart verb may cost the operator a process.
    expect(argv).toEqual([]);
    expect(restarts).toEqual([]);
  });

  test("restart of a job that is NOT loaded takes the ordinary bootstrap path, with no kickstart", async () => {
    const plistPath = fixturePlist();
    const { argv, launchctl } = recordingLaunchctl({ bootstrap: [ok()] });
    const restarts: string[] = [];

    await repairService(darwinDeps(
      "restart",
      plistPath,
      launchctl,
      // Pre-check: absent. Verification after the bootstrap: loaded.
      scriptedProbe("not-loaded", "loaded-current").probe,
      restarts,
    ));

    // The install path already started a NEW process, so kicking it again would be a second
    // restart of a job that is one second old. (`print` is the settle probe between the two
    // evictions and the bootstrap.)
    expect(verbs(argv)).toEqual(["bootout", "print", "bootout", "print", "bootstrap"]);
    expect(verbs(argv)).not.toContain("kickstart");
    expect(restarts).toEqual([]);
  });

  test("installLaunchd reports which path it took, because that is the only way to know", () => {
    const noop = fixturePlist();
    writeFileSync(noop, renderedPlist(), "utf8");
    expect(installLaunchd({
      launchctl: recordingLaunchctl({}).launchctl,
      plistPath: noop,
      probe: loadedCurrent().probe,
      sleepSync: () => {},
    })).toEqual({ reloaded: false });

    const reloaded = fixturePlist();
    expect(installLaunchd({
      launchctl: recordingLaunchctl({ bootstrap: [ok()] }).launchctl,
      plistPath: reloaded,
      probe: scriptedProbe("not-loaded", "loaded-current").probe,
      sleepSync: () => {},
    })).toEqual({ reloaded: true });
  });

  test("restartLaunchdJob verifies with the probe and says what it ran", () => {
    const { argv, launchctl } = recordingLaunchctl({});
    const logged = captureLog(() => restartLaunchdJob({ launchctl, probe: loadedCurrent().probe }));

    expect(verbs(argv)).toEqual(["kickstart"]);
    // One line, naming the exact command, so an operator reading the output can repeat it.
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("service restarted (launchctl kickstart -k gui/");
    expect(logged[0]).toContain("/com.opencodex.proxy)");
  });

  test("a kickstart whose job is gone afterwards throws instead of claiming a restart", () => {
    const { launchctl } = recordingLaunchctl({ kickstart: fail(113, "Could not find service") });

    expect(() => restartLaunchdJob({ launchctl, probe: scriptedProbe("not-loaded").probe }))
      .toThrow(/could not restart com\.opencodex\.proxy[\s\S]*NOT loaded[\s\S]*kickstart -k gui\//);
  });

  test("an unverifiable state after the kick warns — a probe that cannot answer is not a failure", () => {
    const { launchctl } = recordingLaunchctl({});
    const warned: string[] = [];
    const previous = console.warn;
    console.warn = (...parts: unknown[]) => { warned.push(parts.join(" ")); };
    try {
      // `unknown` is never evidence: EPERM from a non-Aqua context says nothing about the job.
      restartLaunchdJob({
        launchctl,
        probe: scriptedProbe({ state: "unknown", detail: "launchctl could not be run" }).probe,
      });
    } finally {
      console.warn = previous;
    }
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("could not be verified");
  });

  test("the kick is wired to the restart verb only, and defaults to the real job restarter", () => {
    const source = readFileSync(repoPath("src", "service.ts"), "utf8");
    const branch = source.slice(
      source.indexOf('if (platform === "darwin") {', source.indexOf("export async function repairService(")),
      source.indexOf("throw new Error(`Background service repair is unsupported"),
    );
    expect(branch).toContain("const outcome = (deps.repairLaunchd ?? installLaunchd)();");
    expect(branch).toContain('if ((deps.verb ?? "repair") === "restart" && outcome?.reloaded === false) {');
    expect(branch).toContain("(deps.restartLaunchd ?? restartLaunchdJob)();");
    // Linux needs no equivalent: `installSystemd` ends in an unconditional restart, so the
    // systemd unit is bounced whichever verb asked. Windows stops and starts the task.
    expect(branch).toContain("(deps.repairSystemd ?? installSystemd)();");
    expect(source.slice(source.indexOf("function installSystemd()"), source.indexOf("function startSystemd()")))
      .toContain("sh(`systemctl --user restart ${TASK}`);");
  });
});

describe("reusePreviousPlistPathVariable: PATH is the one difference repair may ignore", () => {
  const plist = (path: string, port = 10100): string =>
    `<dict>\n  <key>PATH</key><string>${path}</string>\n  <key>Port</key><string>${port}</string>\n</dict>\n`;

  test("a PATH-only difference yields the previous definition verbatim", () => {
    const previous = plist("/opt/homebrew/bin:/usr/bin");
    const adopted = reusePreviousPlistPathVariable(previous, plist("/usr/bin"));
    expect(adopted).toBe(previous);
  });

  test("any other difference refuses — the plist must be rewritten in full", () => {
    // A repair that also changes the port is a real rewrite, and PATH goes with it.
    expect(reusePreviousPlistPathVariable(plist("/a", 10100), plist("/b", 10101))).toBe(null);
  });

  test("an identical PATH is not a difference to reuse", () => {
    expect(reusePreviousPlistPathVariable(plist("/a"), plist("/a"))).toBe(null);
  });

  test("a PATH holding regex replacement syntax survives verbatim", () => {
    // A function replacer, not `$1`: `$&` in the previous PATH would otherwise be expanded.
    const previous = plist("/opt/$&/bin:/usr/bin");
    expect(reusePreviousPlistPathVariable(previous, plist("/usr/bin"))).toBe(previous);
  });

  test("a definition with no PATH entry refuses rather than guessing", () => {
    expect(reusePreviousPlistPathVariable("<dict/>\n", plist("/usr/bin"))).toBe(null);
  });
});

describe("launchdEvictionTargets: an eviction covers every domain the probe reports", () => {
  test("both user domains, in probe order", () => {
    expect(launchdEvictionTargets(501)).toEqual([
      "gui/501/com.opencodex.proxy",
      "user/501/com.opencodex.proxy",
    ]);
  });
});

describe("probeLaunchdLoadState: a tri-state, not one swallowed bit (#4236 defect 2)", () => {
  const printed = (command: string): LaunchctlResult => ok(`{\n\targuments = {\n\t\t${command}\n\t}\n}`);

  function probeWith(answers: Array<LaunchctlResult>, expected = "exec 'ocx' start --port 10100") {
    const asked: string[] = [];
    let call = 0;
    const launchctl = ((args: string[]) => {
      asked.push(args[1] ?? "");
      return answers[call++] ?? fail(113, "Could not find service");
    }) as typeof runLaunchctl;
    return { asked, probe: probeLaunchdLoadState({ launchctl, uid: 501, expectedCommand: () => expected }) };
  }

  test("exit 0 with the expected command is loaded-current", () => {
    const { asked, probe } = probeWith([printed("exec 'ocx' start --port 10100")]);
    expect(probe.state).toBe("loaded-current");
    expect(probe.domain).toBe("gui/501");
    // The gui domain answered, so the user domain is not asked.
    expect(asked).toEqual(["gui/501/com.opencodex.proxy"]);
  });

  test("exit 0 with a different command is loaded-stale", () => {
    const { probe } = probeWith([printed("exec '/old/bun' /old/cli.ts start --port 10100")]);
    expect(probe.state).toBe("loaded-stale");
  });

  test("113 in gui is not absence — the user domain is asked too", () => {
    const { asked, probe } = probeWith([
      fail(113, "Could not find service"),
      printed("exec 'ocx' start --port 10100"),
    ]);
    // `gui/` and `user/` are independent and hold separate service sets; asking one left
    // the other free to hold a job the old `launchctl list | grep` called absent.
    expect(asked).toEqual(["gui/501/com.opencodex.proxy", "user/501/com.opencodex.proxy"]);
    expect(probe.state).toBe("loaded-current");
    expect(probe.domain).toBe("user/501");
  });

  test("113 from both domains is proof of absence", () => {
    const { probe } = probeWith([fail(113, "Could not find service"), fail(113, "Could not find service")]);
    expect(probe.state).toBe("not-loaded");
  });

  test("112 is an answer about the DOMAIN and cannot hide a job of ours", () => {
    // A headless Mac has no GUI domain and no installation either; calling that `unknown`
    // would refuse every verdict on it.
    const { probe } = probeWith([fail(112, "Could not find domain for"), fail(113, "Could not find service")]);
    expect(probe.state).toBe("not-loaded");
  });

  test("a spawn failure is unknown, never absence", () => {
    const { probe } = probeWith([{ ok: false, stdout: "", stderr: "spawn /bin/launchctl ENOENT", status: null }]);
    expect(probe.state).toBe("unknown");
    expect(probe.detail).toContain("launchctl could not be run");
  });

  test("an undocumented exit status is unknown, never absence", () => {
    // EPERM from a bootstrap server, a missing grep, an execSync maxBuffer overflow: the
    // old probe collapsed all of them into the same empty string as genuine absence.
    const { probe } = probeWith([fail(1, "Operation not permitted")]);
    expect(probe.state).toBe("unknown");
    expect(probe.detail).toContain("exited 1");
  });
});

describe("deriveLaunchdServiceDiagnostic: what status is allowed to claim", () => {
  const diagnostics = "paths ok";

  test("loaded-current is loaded and viable", () => {
    const diag = deriveLaunchdServiceDiagnostic({
      installed: true, stale: false, load: { state: "loaded-current", domain: "gui/501" }, diagnostics,
    });
    expect(diag.summary).toContain("installed and loaded (launchd;");
    expect(diag.running).toBe(true);
    expect(diag.viable).toBe(true);
  });

  test("loaded-stale says which plist, instead of claiming health", () => {
    const diag = deriveLaunchdServiceDiagnostic({
      installed: true, stale: false, load: { state: "loaded-stale", domain: "gui/501" }, diagnostics,
    });
    expect(diag.summary).toContain("loaded from an OLDER plist");
    expect(diag.running).toBe(true);
  });

  test("not-loaded keeps the actionable text", () => {
    const diag = deriveLaunchdServiceDiagnostic({
      installed: true, stale: false, load: { state: "not-loaded" }, diagnostics,
    });
    expect(diag.summary).toContain("installed, not loaded (launchd;");
    expect(diag.running).toBe(false);
    expect(diag.viable).toBe(false);
  });

  test("unknown never prints 'installed, not loaded' and never recommends repair", () => {
    const diag = deriveLaunchdServiceDiagnostic({
      installed: true,
      stale: false,
      load: { state: "unknown", detail: "launchctl print gui/501/com.opencodex.proxy exited 1" },
      diagnostics,
    });
    // The reported symptom was `installed, not loaded` above a live proxy, with
    // `re-run 'ocx service repair'` attached — the command that causes defect 1.
    expect(diag.summary).not.toContain("not loaded");
    expect(diag.summary).not.toContain("service repair");
    expect(diag.summary).toContain("could not be verified");
    expect(diag.summary).toContain("exited 1");
    // And `viable` stays true: `isServiceViable() === false` is what makes the update
    // fallback (src/update/index.ts, src/update/job.ts) treat a successful repair as a
    // dead supervisor and start a COMPETING proxy on the service's own port. A failed
    // probe is not evidence against the service.
    expect(diag.viable).toBe(true);
    expect(diag.startable).toBe(true);
  });

  test("stale baked paths still win over every load state", () => {
    for (const state of ["loaded-current", "loaded-stale", "not-loaded", "unknown"] as const) {
      const diag = deriveLaunchdServiceDiagnostic({ installed: true, stale: true, load: { state }, diagnostics });
      expect(diag.summary).toContain("installed, but stale");
      expect(diag.viable).toBe(false);
    }
  });

  test("not installed reports absence whatever the probe says", () => {
    const diag = deriveLaunchdServiceDiagnostic({
      installed: false, stale: false, load: { state: "unknown", detail: "x" }, diagnostics,
    });
    expect(diag.summary).toBe(`not installed (${diagnostics})`);
    expect(diag.viable).toBe(false);
  });
});

/**
 * Source-oracle cases. The two remaining defects are shapes of the command dispatcher and
 * the install-cleanup ops, neither of which can be driven without a live launchd or a whole
 * CLI process, so assert the shape instead of mocking the world.
 */
describe("the surfaces around the repair (#4236 defects 1f, 1h, 2)", () => {
  const source = readFileSync(repoPath("src", "service.ts"), "utf8");

  function slice(from: string, to: string): string {
    const start = source.indexOf(from);
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf(to, start + from.length);
    expect(end).toBeGreaterThan(start);
    return source.slice(start, end);
  }

  test("the repair branch still reports serving when repairService throws (1f)", () => {
    const branch = slice('if (command === "repair" || command === "restart") {', "// Non-install subcommands follow");
    // Without the catch, a throw escaped through src/cli/dispatch.ts to the top level and
    // the one command that can evict a hub never reached its own serving check.
    expect(branch).toContain("try {");
    expect(branch).toContain("await repairService({ verb });");
    expect(branch).toContain("} catch (error) {");
    expect(branch).toContain('await reportServiceServing(verb === "restart" ? "restarted" : "repaired");');
    expect(branch).toContain("process.exitCode = 1;");
    // The serving check must not be inside the try, or a throw would still skip it.
    expect(branch.indexOf("} catch (error) {")).toBeLessThan(branch.indexOf("reportServiceServing(verb ==="));
  });

  test("install cleanup uses the same probe and the modern evict verb (1h, 2)", () => {
    const ops = slice("function platformServiceInstallCleanupOps(", 'if (process.platform === "win32") {');
    // `unload` cannot evict a gui-domain job — the file's own comment on installLaunchd
    // says so — and `launchctl list` was the other half of defect 2.
    expect(ops).not.toContain("launchctl unload");
    expect(ops).not.toContain('sh("launchctl list")');
    expect(ops).toContain("probeLaunchdLoadState()");
    expect(ops).toContain('runLaunchctl(["bootout"');
    // Installing over a manager we could not query is the unsafe direction, so this probe
    // keeps failing closed on `unknown` even though `diagnoseService` does not.
    expect(ops).toContain('probe.state === "unknown"');
    // Review finding 4: the probe answers for `user/<uid>` as well, so a gui-only eviction
    // exited 3 in the wrong domain and installed new assets over a live job.
    expect(ops).toContain("for (const target of launchdEvictionTargets())");
    expect(ops).toContain("launchctlBootoutBenign(booted.status)");
  });

  /**
   * Review finding 1. The pre-check and the verification are the two places a two-state
   * "loaded / not loaded" answer turned one unreadable `launchctl print` into an eviction.
   */
  test("installLaunchd asks the tri-state probe, never launchdJobMatchesPlist", () => {
    const fn = slice("export function installLaunchd(", " * Deps are named for the layer they replace");
    expect(fn).toContain("probe?: typeof probeLaunchdLoadState;");
    expect(fn).not.toContain("launchdJobMatchesPlist");
    // Refuse before any write, and again before any retry or rollback.
    expect(fn).toContain('if (verdict.state === "unknown") {');
    expect(fn).toContain("refusing to ${wasInstalled ? \"repair\" : \"install\"}");
    expect(fn).toContain('verdict.state === "not-loaded" || verdict.state === "loaded-stale"');
    // `startLaunchd` keeps the two-state helper deliberately: it does not evict anything.
    expect(slice("export function startLaunchd(", "function stopLaunchd(")).toContain("launchdJobMatchesPlist");
  });

  test("the no-op pre-check treats a PATH-only difference as identical (finding 2)", () => {
    const fn = slice("export function installLaunchd(", " * Deps are named for the layer they replace");
    expect(fn).toContain("reusePreviousPlistPathVariable(previousPlist, rendered)");
    // Only against a job proven to run the exec line this install baked.
    expect(fn).toContain('verdict.state === "loaded-current"');
  });

  test("install state fails loudly instead of writing nowhere (nit 6)", () => {
    const filter = slice("function serviceStatePaths()", "function currentCodexHome(");
    expect(filter).toContain("isTestHomeGuardArmed()");
    // One canonicalization, the guard's own: `resolve()` alone calls /var/... and
    // /private/var/... different paths on macOS.
    expect(filter).toContain("isProtectedHomeUnderTest(dirname(path))");
    expect(filter).toContain("paths.filter(");
    expect(filter).toContain("refusing to write service install state");
    expect(slice("function writeServiceInstallState(", "function readServiceInstallState("))
      .toContain("serviceStateWritePaths()");
  });

  test("diagnoseService no longer grep-matches launchctl list (2)", () => {
    const branch = slice("export function diagnoseService()", 'if (process.platform === "win32") {');
    expect(branch).toContain("probeLaunchdLoadState()");
    expect(branch).toContain("deriveLaunchdServiceDiagnostic(");
    expect(branch).not.toContain("statusLaunchd");
    // The executable form is gone; the prose naming what it did deliberately stays.
    expect(source).not.toContain("sh(`launchctl list | grep");
  });

  /**
   * Found while building the cases above: `installLaunchd` writes install state, and
   * `serviceStatePaths()` deliberately includes a legacy `~/.opencodex/service-state.json`
   * entry for installs made before OPENCODEX_HOME existed. Under the test sandbox that
   * entry is the developer's LIVE record — one case replaced its codexHome and
   * opencodexHome with temp-directory paths before this filter existed.
   */
  test("stop and uninstall prefer bootout, in both domains, and keep unload only as a fallback (D)", () => {
    const stop = slice("function stopLaunchd(", "function statusLaunchd(");
    expect(stop).toContain('run(["bootout"');
    // Review finding 4: gui-only, a `user/<uid>` job made `ocx service stop` a silent no-op
    // — `bootout gui/<uid>/<label>` exits 3 in a domain that never held it.
    expect(stop).toContain("for (const target of launchdEvictionTargets())");
    // The legacy verb survives for exactly one case: launchctl could not be spawned at
    // all (`status === null`), which is the only state a second attempt can improve.
    expect(stop).toContain("launchctl unload");
    expect(stop.indexOf('run(["bootout"')).toBeLessThan(stop.indexOf("launchctl unload"));
    const uninstall = slice("function uninstallLaunchd(", "/**");
    // Uninstall inherits both domains by routing through stopLaunchd.
    expect(uninstall).toContain("stopLaunchd(deps)");
    expect(uninstall).not.toContain("launchctl unload");
  });

  /**
   * Review nit 8. `stableLauncherEntry` is shared with `installSystemd`, so "the recorded
   * launcher wins over a fresh PATH walk" changed Linux too. The behavioural half lives in
   * `tests/service/service.test.ts`; this pins that the two installers really do call the
   * same resolver, which is what makes that coverage transferable.
   */
  test("the recorded-launcher preference is shared with the systemd installer (nit 8)", () => {
    const systemd = slice("function installSystemd()", "function startSystemd(");
    expect(systemd).toContain("stableLauncherEntry()");
    expect(systemd).toContain("buildUnit(resolvedProxyEnv(), { launcher })");
    expect(slice("export function installLaunchd(", " * Deps are named for the layer they replace"))
      .toContain("stableLauncherEntry()");
  });
});
