/**
 * Activation evidence for the real-home write guard.
 *
 * A green suite proves nothing here: the guard's whole job is to THROW on a path this
 * suite must never write. So every deny case runs in a child process against a temp
 * SENTINEL home handed over via OCX_REAL_HOME, exercising the same capture path the
 * real run uses. The only assertion that touches the developer's actual home reads a
 * hash; nothing here can write it.
 *
 * Incident: devlog/_fin/260730_codex_rs_upstream_v2_live_handoff/070.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertNotRealHomeUnderTest, isTestHomeGuardArmed, protectedHomeForTests } from "../../src/lib/test-home-guard";
import { getConfigDir } from "../../src/config";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoRoot } from "../helpers/repo-root";
import { watchdogMs } from "../helpers/ci-watchdog";
import { captureTestOutput } from "../../scripts/test";

/**
 * Two different things are needed from the repo root, and conflating them is
 * what broke Windows.
 *
 * `cwd` needs a real filesystem path. `URL.pathname` is not one on Windows: it
 * yields `/D:/a/opencodex/opencodex/`, whose leading slash makes the directory
 * invalid, and `Bun.spawnSync` then reports the failure against the
 * *executable* — `ENOENT ... 'C:\Users\runneradmin\.bun\bin\bun.exe'` — even
 * though Bun sits exactly where setup-bun left it. That misdirection is why
 * this read as a missing-Bun problem for four CI runs.
 */
const REPO_ROOT = repoRoot();
/**
 * The probe source needs a module SPECIFIER, not a path. A Windows path
 * (`D:\a\...`) embedded in an import string would have its backslashes eaten as
 * escapes, so keep the `file://` URL form for anything interpolated into code.
 */
const REPO_ROOT_URL = pathToFileURL(repoRoot() + "/").href;

// Scale only execution: cleanup retains room below CI's existing 60-second ceiling.
const PROBE_EXECUTION_MS = watchdogMs(5_000);
const PROBE_TERM_MS = 5_000;
const PROBE_REAP_MS = 2_000;
const PROBE_DRAIN_MS = 1_000;

function beginProbe(id: string): string {
  console.warn(`[home-guard:${id}] 01 fixture setup`);
  return id;
}

async function waitForProbe(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

type ProbeOutcome = {
  pid: number | null;
  code: number | null;
  signal: NodeJS.Signals | null;
  reaped: boolean;
  complete: boolean;
  stdout: string;
  stderr: string;
  root: string | undefined;
};

class ProbeFailure extends Error {
  constructor(readonly id: string, readonly failures: string[], readonly outcome: ProbeOutcome) {
    super(`[home-guard:${id}] ${failures.join(", ")}; pid=${outcome.pid} exit=${outcome.code} signal=${outcome.signal} reaped=${outcome.reaped} complete=${outcome.complete}`);
    this.name = "ProbeFailure";
  }
}

/** Keep the startup home contract; own execution, reaping and pipe draining separately. */
async function runProbe(id: string, source: string, env: Record<string, string | undefined>): Promise<ProbeOutcome> {
  const outcome: ProbeOutcome = {
    pid: null, code: null, signal: null, reaped: false, complete: false,
    stdout: "", stderr: "", root: undefined,
  };
  const failures: string[] = [];
  let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  let exited: Promise<void> | undefined;
  let capture: ReturnType<typeof captureTestOutput> | undefined;
  const stage = (message: string) => console.warn(`[home-guard:${id}] ${message}`);
  try {
    stage("02 probe file setup");
    outcome.root = mkdtempSync(join(tmpdir(), "ocx-guard-probe-"));
    const file = join(outcome.root, "probe.ts");
    writeFileSync(file, source, "utf8");
    const childEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries({ ...process.env, ...env })) {
      if (value !== undefined) childEnv[key] = value;
    }
    stage("03 spawn requested");
    child = Bun.spawn([process.execPath, "run", file], { cwd: REPO_ROOT, env: childEnv, stdout: "pipe", stderr: "pipe" });
    const owned = child;
    outcome.pid = owned.pid;
    stage(`04 pid=${owned.pid}`);
    // Rejection is an observation failure, never evidence that the process was reaped.
    exited = owned.exited.then(code => {
      outcome.code = code;
      outcome.signal = owned.signalCode ?? null;
      outcome.reaped = true;
      stage(`08 exit pid=${owned.pid} code=${code} signal=${outcome.signal}`);
    }, () => {
      failures.push("exit-observation-failed");
      stage(`08 exit observation failed pid=${owned.pid}`);
    });
    capture = captureTestOutput(owned.stdout, owned.stderr);
    if (!await waitForProbe(exited, PROBE_EXECUTION_MS)) {
      failures.push("execution-timeout");
      stage(`05 execution timeout pid=${owned.pid}`);
    }
  } catch {
    failures.push("setup-or-observation-failed");
  } finally {
    if (child && !outcome.reaped) {
      stage(`06 TERM pid=${child.pid}`);
      try { child.kill("SIGTERM"); } catch { stage("06 TERM request failed"); }
      if (exited) await waitForProbe(exited, PROBE_TERM_MS);
      if (!outcome.reaped) {
        stage(`07 KILL pid=${child.pid}`);
        try { child.kill("SIGKILL"); } catch { stage("07 KILL request failed"); }
        if (exited) await waitForProbe(exited, PROBE_REAP_MS);
      }
      if (!outcome.reaped) failures.push("reap-timeout");
    }
    if (capture) {
      try { Object.assign(outcome, await capture.finish(PROBE_DRAIN_MS)); }
      catch { failures.push("capture-failed"); }
      stage(`09 capture complete=${outcome.complete}`);
      if (!outcome.complete) failures.push("incomplete-output");
    }
    if (outcome.root && (!child || outcome.reaped)) {
      try {
        removeTreeWithRetry(outcome.root);
        stage("10 probe files removed");
      } catch {
        failures.push("cleanup-failed");
        stage("10 probe cleanup failed");
      }
    } else if (outcome.root) {
      stage(`10 probe files retained: child unreaped pid=${outcome.pid}`);
    }
  }
  if (outcome.code !== 0) failures.push("nonzero-exit");
  if (outcome.signal !== null) failures.push("signal-exit");
  // A timeout remains a failure even if TERM subsequently permits a natural exit 0.
  if (failures.length) throw new ProbeFailure(id, failures, { ...outcome });
  return outcome;
}

async function probeFailure(pending: Promise<ProbeOutcome>): Promise<ProbeFailure> {
  const failure: unknown = await pending.then(() => undefined, error => error);
  expect(failure).toBeInstanceOf(ProbeFailure);
  if (!(failure instanceof ProbeFailure)) throw new Error("Expected a failed guard probe");
  return failure;
}

function expectOwnedProbeGone(outcome: ProbeOutcome): void {
  expect(outcome.reaped).toBe(true);
  if (outcome.pid === null || outcome.root === undefined) throw new Error("Probe never spawned");
  expect(outcome.pid).toBeGreaterThan(0);
  let code: string | undefined;
  try { process.kill(outcome.pid, 0); }
  catch (error) { code = (error as NodeJS.ErrnoException).code; }
  expect(code).toBe("ESRCH");
  expect(existsSync(outcome.root)).toBe(false);
}

describe("guard probe lifecycle", () => {
  test("nonzero exit retains output, reports failure and reaps the owned child", async () => {
    const failure = await probeFailure(runProbe(beginProbe("control-nonzero"), `
      console.log("OCX_GUARD_NONZERO");
      process.exitCode = 23;
    `, {}));
    expect(failure.failures).toEqual(["nonzero-exit"]);
    expect(failure.outcome.code).toBe(23);
    expect(failure.outcome.signal).toBeNull();
    expect(failure.outcome.complete).toBe(true);
    expect(failure.outcome.stdout.trim()).toBe("OCX_GUARD_NONZERO");
    expectOwnedProbeGone(failure.outcome);
  });

  test("a referenced handle times out and is reaped even if TERM permits exit zero", async () => {
    const failure = await probeFailure(runProbe(beginProbe("control-hanging"), `
      const keepAlive = setInterval(() => {}, 1000);
      const stop = () => {
        clearInterval(keepAlive);
        process.off("SIGTERM", stop);
      };
      process.on("SIGTERM", stop);
      console.log("OCX_GUARD_HANG_READY");
    `, {}));
    expect(failure.failures).toContain("execution-timeout");
    expect(failure.failures).not.toContain("reap-timeout");
    expect(failure.outcome.stdout.trim()).toBe("OCX_GUARD_HANG_READY");
    expect(failure.outcome.complete).toBe(true);
    // POSIX can handle TERM and exit naturally; Windows may terminate directly.
    if (process.platform !== "win32") {
      expect(failure.outcome.code).toBe(0);
      expect(failure.outcome.signal).toBeNull();
    }
    expectOwnedProbeGone(failure.outcome);
  }, 60_000); // Match the existing CI ceiling; include bounded TERM/reap/drain locally too.

  test("exit zero with an open output pipe is incomplete, never a successful probe", async () => {
    let cancelled = false;
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("OCX_GUARD_PARTIAL\n")); },
      cancel() { cancelled = true; },
    });
    const stderr = new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });
    // Exercise runProbe's integration with real capture; no unmanaged descendant is needed.
    const spawn = spyOn(Bun, "spawn").mockReturnValue({
      pid: 0, stdout, stderr, exited: Promise.resolve(0), signalCode: null,
      kill() { throw new Error("Exited synthetic child must not be killed"); },
    } as unknown as ReturnType<typeof Bun.spawn>);
    try {
      const pending = runProbe(beginProbe("control-open-pipe"), "", {});
      spawn.mockRestore(); // runProbe spawns synchronously before its first await.
      const failure = await probeFailure(pending);
      expect(failure.failures).toEqual(["incomplete-output"]);
      expect(failure.outcome.code).toBe(0);
      expect(failure.outcome.signal).toBeNull();
      expect(failure.outcome.reaped).toBe(true);
      expect(failure.outcome.complete).toBe(false);
      expect(failure.outcome.stdout).toBe("OCX_GUARD_PARTIAL\n");
      expect(cancelled).toBe(true);
      expect(failure.outcome.root).toBeDefined();
      expect(existsSync(failure.outcome.root!)).toBe(false);
    } finally {
      spawn.mockRestore();
    }
  });
});

/** A fake "real home" the guard will protect, so no deny case aims at the true one. */
function sentinelHome(): { realHome: string; opencodexHome: string; codexHome: string } {
  const realHome = mkdtempSync(join(tmpdir(), "ocx-sentinel-home-"));
  const opencodexHome = join(realHome, ".opencodex");
  const codexHome = join(realHome, ".codex");
  mkdirSync(opencodexHome, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  return { realHome, opencodexHome, codexHome };
}

describe("real-home write guard", () => {

/**
 * Windows without Developer Mode or admin cannot create symlinks (EPERM). The
 * escape cases below need a real link to prove the guard resolves through one, so
 * detect the privilege once and take a visible skip rather than failing in setup.
 */
const canSymlink = (() => {
  const probeDir = mkdtempSync(join(tmpdir(), "ocx-home-guard-symlink-probe-"));
  try {
    symlinkSync(join(probeDir, "probe-target"), join(probeDir, "probe-link"));
    return true;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "EPERM") return false;
    throw e;
  } finally {
    removeTreeWithRetry(probeDir);
  }
})();
  test("armed + the protected home: all three writers throw", async () => {
    const probeId = beginProbe("01-protected-writers");
    const { realHome, opencodexHome } = sentinelHome();
    const probe = await runProbe(probeId, `
      import { saveConfig } from "${REPO_ROOT_URL}src/config";
      import { mutateStore } from "${REPO_ROOT_URL}src/oauth/store";
      import { saveCodexAccountCredential } from "${REPO_ROOT_URL}src/codex/account-store";
      const threw: string[] = [];
      const REFUSAL = "refusing to write the real OpenCodex home";
      try { saveConfig({ providers: {}, defaultProvider: "openai", port: 10100 } as never); }
      catch (err) { if (String(err).includes(REFUSAL)) threw.push("config"); }
      // auth.json is written by the private persist() behind mutateStore.
      try { await mutateStore(store => { (store as Record<string, unknown>).probe = { accounts: {} }; }); }
      catch (err) { if (String(err).includes(REFUSAL)) threw.push("auth"); }
      try { saveCodexAccountCredential("probe", { accessToken: "x", refreshToken: "y", accountId: "probe" } as never); }
      catch (err) { if (String(err).includes(REFUSAL)) threw.push("accounts"); }
      console.log(JSON.stringify(threw));
    `, { OCX_TEST_HOME_GUARD: "1", OCX_REAL_HOME: realHome, OPENCODEX_HOME: opencodexHome });

    expect(probe.stdout).toContain("config");
    expect(probe.stdout).toContain("auth");
    expect(probe.stdout).toContain("accounts");
    // Refused before any write: the guard runs ahead of mkdir/chmod, so none of the
    // three store files the writers would have created may exist.
    expect(() => readFileSync(join(opencodexHome, "config.json"))).toThrow();
    expect(() => readFileSync(join(opencodexHome, "auth.json"))).toThrow();
    expect(() => readFileSync(join(opencodexHome, "codex-accounts.json"))).toThrow();
  });

  test("armed native credential writes reject the protected Codex home", async () => {
    const probeId = beginProbe("02-native-credentials");
    const { realHome, codexHome } = sentinelHome();
    const probe = await runProbe(probeId, `
      import { assertNotRealCodexHomeUnderTest } from "${REPO_ROOT_URL}src/lib/test-home-guard";
      try {
        // JSON.stringify, not raw interpolation: a Windows temp path is
        // C:\\Users\\..., and pasting it between quotes makes every backslash an
        // escape sequence in the probe's own source. \U and \p are not valid
        // escapes, so the path the guard compared was not the path under test and
        // it correctly reported WRITE_ALLOWED for a directory it never saw.
        assertNotRealCodexHomeUnderTest(${JSON.stringify(codexHome)});
        console.log("WRITE_ALLOWED");
      } catch (err) {
        console.log(String(err).includes("refusing to write the real Codex home") ? "REFUSED" : "OTHER");
      }
    `, { OCX_TEST_HOME_GUARD: "1", OCX_REAL_HOME: realHome, CODEX_HOME: codexHome });

    expect(probe.stdout).toContain("REFUSED");
    expect(probe.stdout).not.toContain("WRITE_ALLOWED");
  });

  test.skipIf(!canSymlink)("armed + a symlink escaping a temp home into the protected home: refused", async () => {
    const probeId = beginProbe("03-symlink-file");
    // Atomic writes resolve their destination through symlinks, so a temp home whose
    // config.json points into the protected home would otherwise pass the caller's
    // dir-level check and then write the real file anyway.
    const { realHome, opencodexHome } = sentinelHome();
    const protectedFile = join(opencodexHome, "config.json");
    writeFileSync(protectedFile, '{"sentinel":true}', "utf8");
    const dir = mkdtempSync(join(tmpdir(), "ocx-escape-home-"));
    symlinkSync(protectedFile, join(dir, "config.json"));

    const probe = await runProbe(probeId, `
      import { saveConfig } from "${REPO_ROOT_URL}src/config";
      const REFUSAL = "refusing to write the real OpenCodex home";
      try {
        saveConfig({ providers: {}, defaultProvider: "openai", port: 10100 } as never);
        console.log("wrote");
      } catch (err) {
        console.log(String(err).includes(REFUSAL) ? "refused" : "other");
      }
    `, { OCX_TEST_HOME_GUARD: "1", OCX_REAL_HOME: realHome, OPENCODEX_HOME: dir });

    expect(probe.stdout).toContain("refused");
    // The protected file must be byte-for-byte untouched.
    expect(readFileSync(protectedFile, "utf8")).toBe('{"sentinel":true}');
  });

  test("armed + an unregistered temp home: writers succeed", async () => {
    const probeId = beginProbe("04-unregistered-home");
    // The 54 suites that mkdtemp their own home must keep working with no opt-in.
    const dir = mkdtempSync(join(tmpdir(), "ocx-plain-home-"));
    const probe = await runProbe(probeId, `
      import { saveConfig } from "${REPO_ROOT_URL}src/config";
      saveConfig({ providers: {}, defaultProvider: "openai", port: 10100 } as never);
      console.log("wrote");
    `, { OCX_TEST_HOME_GUARD: "1", OCX_REAL_HOME: join(tmpdir(), "ocx-nonexistent-real-home"), OPENCODEX_HOME: dir });

    expect(probe.stdout).toContain("wrote");
    expect(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).port).toBe(10100);
  });

  test.skipIf(!canSymlink)("armed + a first write beneath a symlinked PARENT escaping into the protected home: refused", async () => {
    const probeId = beginProbe("05-symlink-parent");
    // The file does not exist yet, so resolveWriteTarget returns the literal
    // path and target === path; the guard must resolve the parent directory
    // instead of skipping (review: symlinked config dir + absent destination).
    const { realHome, opencodexHome } = sentinelHome();
    const dir = mkdtempSync(join(tmpdir(), "ocx-parent-escape-"));
    const linkDir = join(dir, "home-link");
    symlinkSync(opencodexHome, linkDir);
    const modeBefore = statSync(opencodexHome).mode;

    const probe = await runProbe(probeId, `
      import { atomicWriteFile, writePid } from "${REPO_ROOT_URL}src/config";
      const REFUSAL = "refusing to write the real OpenCodex home";
      try {
        // Same escaping hazard as the Codex-home probe above: JSON.stringify the
        // path, then join in the child so no backslash reaches the source text.
        atomicWriteFile(${JSON.stringify(linkDir)} + "/never-created.json", "x");
        console.log("WRITE_SUCCEEDED");
      } catch (err) {
        console.log(String(err).includes(REFUSAL) ? "REFUSED" : "OTHER:" + String(err));
      }
      try {
        writePid(424242);
        console.log("PID_SUCCEEDED");
      } catch (err) {
        console.log(String(err).includes(REFUSAL) ? "PID_REFUSED" : "PID_OTHER:" + String(err));
      }
    `, { OCX_TEST_HOME_GUARD: "1", OCX_REAL_HOME: realHome, OPENCODEX_HOME: linkDir });

    expect(probe.stdout).toContain("REFUSED");
    expect(probe.stdout).not.toContain("WRITE_SUCCEEDED");
    expect(probe.stdout).toContain("PID_REFUSED");
    expect(probe.stdout).not.toContain("PID_SUCCEEDED");
    // Nothing landed in the protected home, not even via the resolved parent.
    expect(() => readFileSync(join(opencodexHome, "never-created.json"))).toThrow();
    expect(() => readFileSync(join(opencodexHome, "ocx.pid"))).toThrow();
    // The protected directory's mode is untouched by the refused write.
    expect(statSync(opencodexHome).mode).toBe(modeBefore);
  });

  test("disarmed: the protected home is allowed (production stays inert)", async () => {
    const probeId = beginProbe("06-disarmed");
    const { realHome, opencodexHome } = sentinelHome();
    const probe = await runProbe(probeId, `
      import { saveConfig } from "${REPO_ROOT_URL}src/config";
      saveConfig({ providers: {}, defaultProvider: "openai", port: 10100 } as never);
      console.log("wrote");
    `, { OCX_TEST_HOME_GUARD: undefined, OCX_REAL_HOME: realHome, OPENCODEX_HOME: opencodexHome });

    expect(probe.stdout).toContain("wrote");
  });

  test("the protected path comes from OCX_REAL_HOME, not the sandboxed HOME", async () => {
    const probeId = beginProbe("07-captured-home");
    // The inversion this guards against: if the guard read homedir() after the harness
    // replaced HOME, it would protect the sandbox and leave the real home writable.
    const { realHome } = sentinelHome();
    const decoyHome = mkdtempSync(join(tmpdir(), "ocx-decoy-home-"));
    const probe = await runProbe(probeId, `
      import { protectedHomeForTests } from "${REPO_ROOT_URL}src/lib/test-home-guard";
      console.log(protectedHomeForTests());
    `, { OCX_TEST_HOME_GUARD: "1", OCX_REAL_HOME: realHome, HOME: decoyHome });

    expect(probe.stdout).toContain(".opencodex");
    expect(probe.stdout).not.toContain("ocx-decoy-home-");
  });

  test.skipIf(!canSymlink)("a symlink pointing at the protected home is rejected", async () => {
    const probeId = beginProbe("08-symlink-home");
    const { realHome, opencodexHome } = sentinelHome();
    const linkDir = mkdtempSync(join(tmpdir(), "ocx-symlink-"));
    const link = join(linkDir, "looks-like-temp");
    symlinkSync(opencodexHome, link);
    const probe = await runProbe(probeId, `
      import { assertNotRealHomeUnderTest } from "${REPO_ROOT_URL}src/lib/test-home-guard";
      try { assertNotRealHomeUnderTest(${JSON.stringify(link)}); console.log("allowed"); }
      catch { console.log("rejected"); }
    `, { OCX_TEST_HOME_GUARD: "1", OCX_REAL_HOME: realHome });

    expect(probe.stdout.trim()).toBe("rejected");
  });

  test("/var and /private/var spellings of one path agree", async () => {
    const probeId = beginProbe("09-path-alias");
    // macOS hands out /var/folders/... whose realpath is /private/var/folders/...;
    // a lexical comparison would disagree with itself across those two spellings.
    const { realHome } = sentinelHome();
    const aliased = realHome.startsWith("/var/") ? join("/private", realHome) : realHome.replace(/^\/private/, "");
    const probe = await runProbe(probeId, `
      import { assertNotRealHomeUnderTest } from "${REPO_ROOT_URL}src/lib/test-home-guard";
      const results: string[] = [];
      for (const path of [${JSON.stringify(join(realHome, ".opencodex"))}, ${JSON.stringify(join(aliased, ".opencodex"))}]) {
        try { assertNotRealHomeUnderTest(path); results.push("allowed"); } catch { results.push("rejected"); }
      }
      console.log(JSON.stringify(results));
    `, { OCX_TEST_HOME_GUARD: "1", OCX_REAL_HOME: realHome });

    expect(JSON.parse(probe.stdout.trim())).toEqual(["rejected", "rejected"]);
  });

  test("the preload sandboxes this very process", () => {
    expect(isTestHomeGuardArmed()).toBe(true);
    expect(process.env.OCX_TEST_PRELOAD_PID).toBe(String(process.pid));
    // OPENCODEX_HOME is redirected for this process, so ordinary resolution sandboxes.
    expect(process.env.OPENCODEX_HOME).toBeDefined();
    expect(process.env.OPENCODEX_HOME).not.toBe(protectedHomeForTests());
    // `homedir()` is fixed at process START and does not follow an in-process HOME
    // reassignment, so its value depends on HOW the suite was launched:
    //   bare `bun test`  -> the real home (preload's HOME swap came too late for it)
    //   `bun run test`   -> the wrapper's sandbox (HOME was already rewritten at spawn)
    // Both are correct, and asserting either one alone breaks under the other runner.
    // What must hold in BOTH is the property that actually protects the user: the
    // config home this process resolves is never the protected real home.
    expect(homedir()).toBeTruthy();
    expect(getConfigDir()).not.toBe(protectedHomeForTests());
  });

  /*
   * The preload must arm the guard BEFORE it acquires the run lock.
   *
   * This is not a style preference. Taking the lock resolves a user-scoped path, which on
   * Windows spawns PowerShell for the effective SID; under four-shard load that spawn timed
   * out, the refusal threw straight out of the preload, and every statement below it —
   * including the arming — never ran. The worker executed its whole file unguarded, and
   * because `src/lib/windows-elevation.ts` and `src/service.ts` refuse live elevation and
   * machine-global Task Scheduler mutation only while armed, one such worker launched a real
   * PowerShell process and reached real scheduler registration on the developer's machine.
   *
   * The ordering is the whole fix, so it is asserted on the source itself: a reader of the
   * runtime state cannot tell "armed before the lock" from "armed after a lock that happened
   * to succeed", and the failure only reproduces when the lock throws.
   */
  test("the preload arms the guard before it can throw on the run lock", async () => {
    const source = await Bun.file(new URL("../preload.ts", import.meta.url)).text();

    const armAt = source.indexOf('process.env.OCX_TEST_HOME_GUARD = "1"');
    const assertAt = source.indexOf("test home guard failed to arm");
    const lockAt = source.indexOf("await acquireTestRunLock(");
    const sandboxAt = source.indexOf("createIsolatedTestEnvironment()");

    expect(armAt).toBeGreaterThan(-1);
    expect(assertAt).toBeGreaterThan(-1);
    expect(lockAt).toBeGreaterThan(-1);
    expect(sandboxAt).toBeGreaterThan(-1);

    // sandbox -> arm -> assert -> lock. Arming before the sandbox would leave a window that
    // is merely over-protective, but arming after the lock is the defect above.
    expect(sandboxAt).toBeLessThan(armAt);
    expect(armAt).toBeLessThan(assertAt);
    expect(assertAt).toBeLessThan(lockAt);
  });

  /*
   * And the guard has to hold for a process that never reached the lock at all, which is the
   * state the timed-out worker was actually in.
   */
  test("a process that arms the guard is protected even with no lock and a real HOME", async () => {
    const probeId = beginProbe("10-no-lock");
    const { realHome } = sentinelHome();
    const probe = await runProbe(probeId, `
      import { assertNotRealHomeUnderTest, isTestHomeGuardArmed } from "${REPO_ROOT_URL}src/lib/test-home-guard";
      let rejected = false;
      try { assertNotRealHomeUnderTest(${JSON.stringify(join(realHome, ".opencodex"))}); } catch { rejected = true; }
      console.log(JSON.stringify({ armed: isTestHomeGuardArmed(), rejected }));
    `, { OCX_TEST_HOME_GUARD: "1", OCX_REAL_HOME: realHome, HOME: realHome, OPENCODEX_HOME: undefined });

    expect(JSON.parse(probe.stdout.trim())).toEqual({ armed: true, rejected: true });
  });
});
