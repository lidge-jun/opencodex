import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { autoRestoreCodexShim, buildUnixCodexShim, diagnoseCodexShim, inspectCodexShimBackingForCommand, installCodexShim, setCodexShimProbeHookForTests, setCodexShimProbeObservationMsForTests, uninstallCodexShim } from "../../src/codex/shim";
import { overlayPaths } from "../../src/codex/shim-overlay";
import { setShimMigrationPublishHookForTests } from "../../src/codex/shim-migration";
import { resolveCodexRuntime } from "../../src/codex/runtime";
import { codexShimCommandCandidates } from "../../src/codex/catalog/bundled";
import { readState } from "../../src/codex/shim-state-file";
import { tryAcquireShimRestoreLock } from "../../src/codex/shim-restore-lock";

setCodexShimProbeObservationMsForTests(20);
afterAll(() => setCodexShimProbeObservationMsForTests(null));
function fixture(run: (f: { root: string; native: string; wrapper: string; envFile: string; version: (n: string) => string; legacy: () => void }) => void) {
  const root = mkdtempSync(join(tmpdir(), "ocx-overlay-"));
  const home = join(root, "private space");
  const bin = join(root, "brew", "bin");
  mkdirSync(bin, { recursive: true });
  mkdirSync(home);
  const native = join(bin, "codex");
  const old = { ...process.env };
  process.env.OPENCODEX_HOME = home;
  process.env.PATH = `${bin}:/usr/bin:/bin`;
  for (const key of ["OCX_SHIM_ACTIVE_PID", "OCX_SHIM_ACTIVE_DEPTH", "OCX_SHIM_PROBE_ACTIVE"]) delete process.env[key];
  const version = (n: string) => {
    const path = join(root, "Caskroom", n, "codex");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' '${n}' "$@"\n`, { mode: 0o755 });
    return path;
  };
  symlinkSync(version("v1"), native);
  const paths = overlayPaths();
  const legacy = () => {
    const backup = `${native}.opencodex-real`;
    renameSync(native, backup);
    writeFileSync(native, buildUnixCodexShim(backup, process.execPath, "unused", "system"), { mode: 0o755 });
    writeFileSync(join(home, "codex-shim.json"), JSON.stringify({ platform: process.platform, wrapperPath: native, originalPath: native, backupPath: backup }));
  };
  try { run({ root, native, wrapper: paths.wrapper, envFile: paths.env, version, legacy }); }
  finally {
    setCodexShimProbeHookForTests(null);
    setShimMigrationPublishHookForTests();
    process.env = old;
    rmSync(root, { recursive: true, force: true });
  }
}
function invoke(wrapper: string, args = ["--version"]) {
  return spawnSync(wrapper, args, { encoding: "utf8", env: { ...process.env, OCX_SHIM_BYPASS: "1" }, timeout: 5000 });
}

describe.skipIf(process.platform === "win32")("Unix Codex PATH overlay", () => {
  test("fresh install preserves the Homebrew symlink and follows upgrade, cleanup and rollback", () => fixture(f => {
    const before = lstatSync(f.native);
    expect(installCodexShim().installed).toBe(true);
    expect(lstatSync(f.native).ino).toBe(before.ino);
    expect(readlinkSync(f.native)).toContain("v1");
    expect(existsSync(`${f.native}.opencodex-real`)).toBe(false);
    expect(invoke(f.wrapper).stdout).toContain("v1");
    const newer = f.version("v2");
    unlinkSync(f.native);
    symlinkSync(newer, f.native);
    rmSync(join(f.root, "Caskroom", "v1"), { recursive: true });
    expect(autoRestoreCodexShim({ enabled: () => { throw Error("should stay read-only"); } }).status).toBe("healthy");
    expect(invoke(f.wrapper).stdout).toContain("v2");
    unlinkSync(f.native);
    expect(autoRestoreCodexShim({ enabled: () => true }).status).toBe("ineligible");
    expect(existsSync(f.native)).toBe(false);
    symlinkSync(f.version("rollback"), f.native);
    expect(invoke(f.wrapper).stdout).toContain("rollback");
    expect(uninstallCodexShim().removed).toBe(true);
    expect(readlinkSync(f.native)).toContain("rollback");
  }));

  test("records v2 state and inspects the stable launcher without mutation", () => fixture(f => {
    installCodexShim();
    const text = readFileSync(join(process.env.OPENCODEX_HOME!, "codex-shim.json"), "utf8");
    expect(JSON.parse(text)).toEqual({ schemaVersion: 2, mode: "path-overlay", platform: process.platform, wrapperPath: f.wrapper, launcherPath: f.native });
    expect(inspectCodexShimBackingForCommand(f.wrapper)).toMatchObject({ status: "matched", backingPath: f.native, backingKind: "real" });
    expect(inspectCodexShimBackingForCommand(f.native)).toMatchObject({ status: "matched", selectedRole: "backing" });
    expect(readFileSync(join(process.env.OPENCODEX_HOME!, "codex-shim.json"), "utf8")).toBe(text);
    expect(codexShimCommandCandidates()[0]).toBe(f.native);
    const runtime = resolveCodexRuntime({ configDir: process.env.OPENCODEX_HOME, env: { PATH: "" },
      execFileSync: () => "codex-cli 0.159.2", existsSync: path => String(path) === f.native });
    expect(runtime.runtime.command).toBe(f.native);
    expect(runtime.runtime.source).toBe("shim");
  }));

  test("reports activation separately and shell environment is idempotent with quoted paths", () => fixture(f => {
    installCodexShim();
    expect(diagnoseCodexShim()).toMatchObject({ installed: true, runnable: true, active: false, healthy: false });
    const shell = spawnSync("/bin/sh", ["-c", '. "$1"; PATH=/usr/bin:$PATH; . "$1"; . "$1"; command -v codex; printf "%s\\n" "$PATH"', "test", f.envFile], { encoding: "utf8", env: process.env });
    expect(shell.status).toBe(0);
    expect(shell.stdout.split("\n")[0]).toBe(f.wrapper);
    expect(shell.stdout.split("\n")[1]!.split(":").filter(p => p === dirname(f.wrapper))).toHaveLength(1);
    process.env.PATH = `${dirname(f.wrapper)}:${process.env.PATH}`;
    expect(diagnoseCodexShim()).toMatchObject({ healthy: true, active: true });
  }));

  test("explicit migration restores the native link and is repeatable", () => fixture(f => {
    f.legacy();
    expect(autoRestoreCodexShim({ enabled: () => true })).toMatchObject({ status: "ineligible" });
    expect(installCodexShim().installed).toBe(true);
    expect(lstatSync(f.native).isSymbolicLink()).toBe(true);
    expect(existsSync(`${f.native}.opencodex-real`)).toBe(false);
    expect(invoke(f.wrapper).stdout).toContain("v1");
    expect(installCodexShim().installed).toBe(false);
  }));

  test("broken legacy backup releases Homebrew entry but does not report success", () => fixture(f => {
    f.legacy();
    rmSync(join(f.root, "Caskroom", "v1"), { recursive: true });
    expect(installCodexShim()).toMatchObject({ installed: false });
    expect(lstatSync(f.native).isSymbolicLink()).toBe(true);
    expect(readState()?.mode).toBeUndefined();
    unlinkSync(f.native);
    symlinkSync(f.version("repaired"), f.native);
    expect(installCodexShim().installed).toBe(true);
    expect(invoke(f.wrapper).stdout).toContain("repaired");
  }));

  test("resumes after legacy wrapper evacuation without reinstalling it", () => fixture(f => {
    f.legacy();
    renameSync(f.native, `${f.native}.opencodex-migrating`);
    expect(installCodexShim().installed).toBe(true);
    expect(lstatSync(f.native).isSymbolicLink()).toBe(true);
    expect(existsSync(`${f.native}.opencodex-migrating`)).toBe(false);
  }));

  test("keeps a newer native entry when a legacy backup survives", () => fixture(f => {
    f.legacy();
    unlinkSync(f.native);
    symlinkSync(f.version("updated"), f.native);
    expect(installCodexShim().installed).toBe(true);
    expect(readlinkSync(f.native)).toContain("updated");
    expect(invoke(f.wrapper).stdout).toContain("updated");
  }));

  test("corrupt state, foreign wrapper and symlinked private directory fail closed", () => fixture(f => {
    const state = join(process.env.OPENCODEX_HOME!, "codex-shim.json");
    writeFileSync(state, "{");
    expect(installCodexShim().installed).toBe(false);
    unlinkSync(state);
    mkdirSync(dirname(f.wrapper));
    writeFileSync(f.wrapper, "foreign");
    expect(installCodexShim().installed).toBe(false);
    expect(readFileSync(f.wrapper, "utf8")).toBe("foreign");
    rmSync(dirname(f.wrapper), { recursive: true });
    symlinkSync(dirname(f.native), dirname(f.wrapper));
    expect(installCodexShim().installed).toBe(false);
    expect(lstatSync(f.native).isSymbolicLink()).toBe(true);
  }));

  test("repairs only a missing private wrapper, respects opt-out and the operation lock", () => fixture(f => {
    installCodexShim();
    unlinkSync(f.wrapper);
    expect(autoRestoreCodexShim({ enabled: () => false }).status).toBe("disabled");
    const lock = tryAcquireShimRestoreLock()!;
    try { expect(autoRestoreCodexShim({ enabled: () => true }).status).toBe("deferred"); }
    finally { lock.release(); }
    expect(autoRestoreCodexShim({ enabled: () => true }).status).toBe("restored");
    expect(lstatSync(f.native).isSymbolicLink()).toBe(true);
  }));

  test("rejects dynamic PATH redispatch and failing probes without changing the native entry", () => fixture(f => {
    unlinkSync(f.native);
    writeFileSync(f.native, '#!/bin/sh\nexec codex "$@"\n', { mode: 0o755 });
    expect(installCodexShim().message).toContain("recursive");
    expect(readFileSync(f.native, "utf8")).toContain('exec codex "$@"');
    expect(existsSync(f.wrapper)).toBe(false);
    writeFileSync(f.native, "#!/bin/sh\nexit 7\n");
    expect(installCodexShim().message).toContain("failed");
    expect(existsSync(f.wrapper)).toBe(false);
  }));

  test("probe exceptions and concurrent private files never replace the native launcher", () => fixture(f => {
    const link = readlinkSync(f.native);
    setCodexShimProbeHookForTests(() => { throw Error("probe failure"); });
    expect(() => installCodexShim()).toThrow("probe failure");
    expect(readlinkSync(f.native)).toBe(link);
    setCodexShimProbeHookForTests(() => writeFileSync(f.wrapper, "concurrent"));
    expect(installCodexShim().installed).toBe(false);
    expect(readFileSync(f.wrapper, "utf8")).toBe("concurrent");
    expect(readlinkSync(f.native)).toBe(link);
  }));

  test("migration never overwrites an entry published by a concurrent package update", () => fixture(f => {
    f.legacy();
    setShimMigrationPublishHookForTests(() => symlinkSync(f.version("concurrent"), f.native));
    expect(installCodexShim().installed).toBe(false);
    expect(readlinkSync(f.native)).toContain("concurrent");
    setShimMigrationPublishHookForTests();
    expect(installCodexShim().installed).toBe(true);
    expect(invoke(f.wrapper).stdout).toContain("concurrent");
  }));

  test("missing legacy backup releases the confirmed shim and resumes after native repair", () => fixture(f => {
    f.legacy();
    unlinkSync(`${f.native}.opencodex-real`);
    expect(installCodexShim().installed).toBe(false);
    expect(existsSync(f.native)).toBe(false);
    symlinkSync(f.version("recovered"), f.native);
    expect(installCodexShim().installed).toBe(true);
    expect(invoke(f.wrapper).stdout).toContain("recovered");
  }));

  test("probe failure after migration keeps the native entry restored for retry", () => fixture(f => {
    f.legacy();
    setCodexShimProbeHookForTests(() => { throw Error("interrupted"); });
    expect(() => installCodexShim()).toThrow("interrupted");
    expect(lstatSync(f.native).isSymbolicLink()).toBe(true);
    expect(readState()?.mode).toBeUndefined();
    setCodexShimProbeHookForTests(null);
    expect(installCodexShim().installed).toBe(true);
  }));

  test("passes arguments, stdin and exit status through exec", () => fixture(f => {
    unlinkSync(f.native);
    writeFileSync(f.native, '#!/bin/sh\n[ "$1" = --version ] && exit 0\nprintf "%s\\n" "$@"\ncat\nexit 23\n', { mode: 0o755 });
    installCodexShim();
    const run = spawnSync(f.wrapper, ["exec", "a b", "'quoted'"], { encoding: "utf8", input: "input\n", env: { ...process.env, OCX_SHIM_BYPASS: "1" } });
    expect(run.status).toBe(23);
    expect(run.stdout).toBe("exec\na b\n'quoted'\ninput\n");
  }));
});
