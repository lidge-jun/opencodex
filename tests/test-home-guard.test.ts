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
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertNotRealHomeUnderTest, isTestHomeGuardArmed, protectedHomeForTests } from "../src/lib/test-home-guard";
import { getConfigDir } from "../src/config";

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
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
/**
 * The probe source needs a module SPECIFIER, not a path. A Windows path
 * (`D:\a\...`) embedded in an import string would have its backslashes eaten as
 * escapes, so keep the `file://` URL form for anything interpolated into code.
 */
const REPO_ROOT_URL = new URL("..", import.meta.url).href;

/**
 * Run a probe in a child process so we control OCX_REAL_HOME at STARTUP — the guard
 * captures its protected path at module load, which is exactly the property under test.
 */
function runProbe(source: string, env: Record<string, string | undefined>): { code: number; stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), "ocx-guard-probe-"));
  const file = join(dir, "probe.ts");
  writeFileSync(file, source, "utf8");
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...process.env, ...env })) {
    if (value !== undefined) childEnv[key] = value;
  }
  const result = Bun.spawnSync([process.execPath, "run", file], { cwd: REPO_ROOT, env: childEnv, stdout: "pipe", stderr: "pipe" });
  return {
    code: result.exitCode ?? 1,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

/** A fake "real home" the guard will protect, so no deny case aims at the true one. */
function sentinelHome(): { realHome: string; opencodexHome: string } {
  const realHome = mkdtempSync(join(tmpdir(), "ocx-sentinel-home-"));
  const opencodexHome = join(realHome, ".opencodex");
  mkdirSync(opencodexHome, { recursive: true });
  return { realHome, opencodexHome };
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
    rmSync(probeDir, { recursive: true, force: true });
  }
})();
  test("armed + the protected home: all three writers throw", () => {
    const { realHome, opencodexHome } = sentinelHome();
    const probe = runProbe(`
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

  test.skipIf(!canSymlink)("armed + a symlink escaping a temp home into the protected home: refused", () => {
    // Atomic writes resolve their destination through symlinks, so a temp home whose
    // config.json points into the protected home would otherwise pass the caller's
    // dir-level check and then write the real file anyway.
    const { realHome, opencodexHome } = sentinelHome();
    const protectedFile = join(opencodexHome, "config.json");
    writeFileSync(protectedFile, '{"sentinel":true}', "utf8");
    const dir = mkdtempSync(join(tmpdir(), "ocx-escape-home-"));
    symlinkSync(protectedFile, join(dir, "config.json"));

    const probe = runProbe(`
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

  test("armed + an unregistered temp home: writers succeed", () => {
    // The 54 suites that mkdtemp their own home must keep working with no opt-in.
    const dir = mkdtempSync(join(tmpdir(), "ocx-plain-home-"));
    const probe = runProbe(`
      import { saveConfig } from "${REPO_ROOT_URL}src/config";
      saveConfig({ providers: {}, defaultProvider: "openai", port: 10100 } as never);
      console.log("wrote");
    `, { OCX_TEST_HOME_GUARD: "1", OCX_REAL_HOME: join(tmpdir(), "ocx-nonexistent-real-home"), OPENCODEX_HOME: dir });

    expect(probe.stdout).toContain("wrote");
    expect(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).port).toBe(10100);
  });

  test.skipIf(!canSymlink)("armed + a first write beneath a symlinked PARENT escaping into the protected home: refused", () => {
    // The file does not exist yet, so resolveWriteTarget returns the literal
    // path and target === path; the guard must resolve the parent directory
    // instead of skipping (review: symlinked config dir + absent destination).
    const { realHome, opencodexHome } = sentinelHome();
    const dir = mkdtempSync(join(tmpdir(), "ocx-parent-escape-"));
    const linkDir = join(dir, "home-link");
    symlinkSync(opencodexHome, linkDir);
    const modeBefore = statSync(opencodexHome).mode;

    const probe = runProbe(`
      import { atomicWriteFile, writePid } from "${REPO_ROOT_URL}src/config";
      const REFUSAL = "refusing to write the real OpenCodex home";
      try {
        atomicWriteFile("${linkDir}/never-created.json", "x");
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

  test("disarmed: the protected home is allowed (production stays inert)", () => {
    const { realHome, opencodexHome } = sentinelHome();
    const probe = runProbe(`
      import { saveConfig } from "${REPO_ROOT_URL}src/config";
      saveConfig({ providers: {}, defaultProvider: "openai", port: 10100 } as never);
      console.log("wrote");
    `, { OCX_TEST_HOME_GUARD: undefined, OCX_REAL_HOME: realHome, OPENCODEX_HOME: opencodexHome });

    expect(probe.stdout).toContain("wrote");
  });

  test("the protected path comes from OCX_REAL_HOME, not the sandboxed HOME", () => {
    // The inversion this guards against: if the guard read homedir() after the harness
    // replaced HOME, it would protect the sandbox and leave the real home writable.
    const { realHome } = sentinelHome();
    const decoyHome = mkdtempSync(join(tmpdir(), "ocx-decoy-home-"));
    const probe = runProbe(`
      import { protectedHomeForTests } from "${REPO_ROOT_URL}src/lib/test-home-guard";
      console.log(protectedHomeForTests());
    `, { OCX_TEST_HOME_GUARD: "1", OCX_REAL_HOME: realHome, HOME: decoyHome });

    expect(probe.stdout).toContain(".opencodex");
    expect(probe.stdout).not.toContain("ocx-decoy-home-");
  });

  test.skipIf(!canSymlink)("a symlink pointing at the protected home is rejected", () => {
    const { realHome, opencodexHome } = sentinelHome();
    const linkDir = mkdtempSync(join(tmpdir(), "ocx-symlink-"));
    const link = join(linkDir, "looks-like-temp");
    symlinkSync(opencodexHome, link);
    const probe = runProbe(`
      import { assertNotRealHomeUnderTest } from "${REPO_ROOT_URL}src/lib/test-home-guard";
      try { assertNotRealHomeUnderTest(${JSON.stringify(link)}); console.log("allowed"); }
      catch { console.log("rejected"); }
    `, { OCX_TEST_HOME_GUARD: "1", OCX_REAL_HOME: realHome });

    expect(probe.stdout.trim()).toBe("rejected");
  });

  test("/var and /private/var spellings of one path agree", () => {
    // macOS hands out /var/folders/... whose realpath is /private/var/folders/...;
    // a lexical comparison would disagree with itself across those two spellings.
    const { realHome } = sentinelHome();
    const aliased = realHome.startsWith("/var/") ? join("/private", realHome) : realHome.replace(/^\/private/, "");
    const probe = runProbe(`
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
});
