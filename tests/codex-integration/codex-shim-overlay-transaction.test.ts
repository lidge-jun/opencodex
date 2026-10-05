import { describe, expect, mock, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { autoRestoreCodexShim, diagnoseCodexShim, installCodexShim, setCodexShimProbeHookForTests, setCodexShimProbeObservationMsForTests, uninstallCodexShim } from "../../src/codex/shim";
import { tryAcquireShimRestoreLock } from "../../src/codex/shim-restore-lock";

function fixture(run: (f: { root: string; home: string; native: string; wrapper: string; envFile: string; statePath: string }) => void): void {
  const root = fs.mkdtempSync(join(tmpdir(), "ocx-overlay-transaction-"));
  const home = join(root, "home");
  const bin = join(root, "manager");
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(bin);
  const previous = { ...process.env };
  const native = join(bin, "codex");
  fs.writeFileSync(native, "#!/bin/sh\nprintf 'native\\n'\n", { mode: 0o755 });
  try {
    process.env.HOME = root;
    process.env.OPENCODEX_HOME = home;
    process.env.CODEX_HOME = join(root, "codex-home");
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    for (const key of ["CODEX_CLI_PATH", "OCX_SHIM_ACTIVE_PID", "OCX_SHIM_ACTIVE_DEPTH", "OCX_SHIM_PROBE", "OCX_SHIM_PROBE_ACTIVE"]) delete process.env[key];
    setCodexShimProbeObservationMsForTests(20);
    run({ root, home, native, wrapper: join(home, "bin", "codex"), envFile: join(home, "codex-shell-env.sh"), statePath: join(home, "codex-shim.json") });
  } finally {
    mock.restore();
    setCodexShimProbeHookForTests(null);
    setCodexShimProbeObservationMsForTests(null);
    process.env = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function saved(path: string) {
  const stat = fs.lstatSync(path);
  return { bytes: fs.readFileSync(path, "utf8"), ino: stat.ino, mode: stat.mode & 0o777 };
}
function privateDebris(home: string): string[] {
  return [home, join(home, "bin")].flatMap(dir => fs.existsSync(dir) ? fs.readdirSync(dir) : [])
    .filter(name => /\.(stage|rollback)$|^\.probe-|^codex-shim.transaction.json$/.test(name));
}

describe.skipIf(process.platform === "win32")("Codex overlay publication transactions", () => {
  for (const installedBefore of [false, true]) {
    test.each(["stage", "probe", "publish", "env-write", "env-publish", "state-commit"])(`${installedBefore ? "refresh" : "fresh install"} rolls back on %s failure`, phase => fixture(f => {
      if (installedBefore) {
        const result = installCodexShim();
        expect(result.installed, result.message).toBe(true);
        // Mode drift forces refresh while the prior wrapper still executes native Codex.
        fs.chmodSync(f.envFile, 0o644);
      }
      const priorRunnable = installedBefore ? diagnoseCodexShim().runnable : undefined;
      const targets = [f.wrapper, f.envFile, f.statePath];
      const prior = targets.map(path => fs.existsSync(path) ? saved(path) : null);
      const native = saved(f.native);
      const open = fs.openSync;
      const write = fs.writeFileSync;
      const link = fs.linkSync;
      const rename = fs.renameSync;
      let envFd: number | undefined;
      let hit = false;
      const fail = () => { hit = true; throw new Error(`injected ${phase}`); };
      spyOn(fs, "openSync").mockImplementation((path, flags, mode) => {
        const text = String(path);
        if (!hit && phase === "stage" && text.startsWith(`${f.wrapper}.`) && text.endsWith(".stage")) return fail();
        const fd = open(path, flags, mode);
        if (text.startsWith(`${f.envFile}.`) && text.endsWith(".stage")) envFd = fd;
        return fd;
      });
      spyOn(fs, "writeFileSync").mockImplementation((file, data, options) => {
        if (!hit && phase === "env-write" && envFd !== undefined && file === envFd) return fail();
        return write(file, data, options);
      });
      const target = phase === "publish" ? f.wrapper : phase === "env-publish" ? f.envFile : phase === "state-commit" ? f.statePath : null;
      spyOn(fs, "linkSync").mockImplementation((from, to) => {
        if (!hit && !installedBefore && String(to) === target && String(from).endsWith(".stage")) return fail();
        return link(from, to);
      });
      spyOn(fs, "renameSync").mockImplementation((from, to) => {
        if (!hit && installedBefore && String(to) === target && String(from).endsWith(".stage")) return fail();
        return rename(from, to);
      });
      if (phase === "probe") setCodexShimProbeHookForTests(fail);
      const result = installCodexShim();
      mock.restore();
      setCodexShimProbeHookForTests(null);
      expect(hit).toBe(true);
      expect(result).toMatchObject({ installed: false, refused: true });
      expect(result.message).toContain(`injected ${phase}`);
      targets.forEach((path, index) => {
        if (prior[index]) expect(saved(path)).toEqual(prior[index]);
        else expect(fs.existsSync(path)).toBe(false);
      });
      expect(saved(f.native)).toEqual(native);
      expect(privateDebris(f.home)).toEqual([]);
      if (installedBefore) {
        expect(diagnoseCodexShim().runnable).toBe(priorRunnable);
        expect(spawnSync(f.wrapper, ["--version"], { env: process.env, encoding: "utf8", timeout: 5000 }).stdout).toBe("native\n");
      }
      expect(installCodexShim().installed).toBe(true);
    }));
  }

  test("chmod-lost owned wrapper is unhealthy, respects opt-out, and repairs with opt-in", () => fixture(f => {
    expect(installCodexShim().installed).toBe(true);
    const native = saved(f.native);
    fs.chmodSync(f.wrapper, 0o644);
    expect(diagnoseCodexShim()).toMatchObject({ runnable: false, healthy: false });
    expect(autoRestoreCodexShim({ enabled: () => false }).status).toBe("disabled");
    expect(fs.lstatSync(f.wrapper).mode & 0o777).toBe(0o644);
    expect(autoRestoreCodexShim({ enabled: () => true, stabilitySleep: () => {} }).status).toBe("restored");
    expect(diagnoseCodexShim().runnable).toBe(true);
    expect(saved(f.native)).toEqual(native);
  }));

  for (const operation of ["diagnosis", "auto-restore", "install"] as const) {
    test.each(["env-replace", "env-chmod", "state-chmod"])(`${operation} rejects late %s during executable inspection`, mutation => fixture(f => {
      expect(installCodexShim().installed).toBe(true);
      process.env.PATH = `${dirname(f.wrapper)}:${process.env.PATH}`;
      const targets = [f.statePath, f.wrapper, f.envFile, f.native];
      const before = targets.map(saved);
      const path = mutation === "state-chmod" ? f.statePath : f.envFile;
      let hit = false;
      let changed: ReturnType<typeof saved> | undefined;
      const change = () => {
        hit = true;
        if (mutation === "env-replace") {
          // Keep bytes and mode identical so inode replacement alone must be rejected.
          fs.renameSync(path, `${path}.original`);
          fs.writeFileSync(path, before[2]!.bytes, { mode: 0o600 });
        } else {
          fs.chmodSync(path, 0o666);
        }
        changed = saved(path);
      };
      if (operation === "install") {
        const access = fs.accessSync;
        spyOn(fs, "accessSync").mockImplementation((candidate, mode) => {
          if (!hit && String(candidate) === f.wrapper && mode === fs.constants.X_OK) change();
          return access(candidate, mode);
        });
      } else {
        const open = fs.openSync;
        spyOn(fs, "openSync").mockImplementation((candidate, flags, mode) => {
          if (!hit && String(candidate) === f.native) change();
          return open(candidate, flags, mode);
        });
      }
      let message: string;
      if (operation === "diagnosis") {
        const result = diagnoseCodexShim();
        expect(result).toMatchObject({ healthy: false, runnable: false, active: null });
        message = result.summary;
      } else if (operation === "auto-restore") {
        const result = autoRestoreCodexShim({ enabled: () => { throw new Error("unsafe artifact must not consult opt-in"); } });
        expect(result.status).toBe("ineligible");
        message = result.message ?? "";
      } else {
        const result = installCodexShim();
        expect(result).toMatchObject({ installed: false, refused: true });
        expect(result.runnable).not.toBe(true);
        message = result.message;
      }
      mock.restore();
      expect(hit).toBe(true);
      expect(message).toMatch(/changed.*preserving|not an owned regular file/i);
      expect(message).not.toMatch(/For sh\/bash\/zsh|run \. /);
      targets.forEach((target, index) => expect(saved(target)).toEqual(target === path ? changed : before[index]));
      expect(privateDebris(f.home)).toEqual([]);
      if (mutation === "env-replace") {
        expect(changed!.ino).not.toBe(before[2]!.ino);
        expect(saved(`${path}.original`)).toEqual(before[2]);
      } else {
        expect(changed!.mode).toBe(0o666);
      }
    }));
  }

  test("foreign replacement with identical marker-bearing bytes is preserved by install, repair and uninstall", () => fixture(f => {
    expect(installCodexShim().installed).toBe(true);
    const original = saved(f.wrapper);
    fs.renameSync(f.wrapper, `${f.wrapper}.previous`);
    fs.writeFileSync(f.wrapper, original.bytes, { mode: 0o755 });
    const foreign = saved(f.wrapper);
    expect(foreign.ino).not.toBe(original.ino);
    const rawState = fs.readFileSync(f.statePath, "utf8");
    expect(diagnoseCodexShim().runnable).toBe(false);
    expect(autoRestoreCodexShim({ enabled: () => true }).status).toBe("ineligible");
    expect(installCodexShim().installed).toBe(false);
    expect(uninstallCodexShim().removed).toBe(false);
    expect(saved(f.wrapper)).toEqual(foreign);
    expect(fs.readFileSync(f.statePath, "utf8")).toBe(rawState);
  }));

  test.each(["uninstall", "install", "auto-repair"])("identity-less schema 2 does not authorize %s of a foreign marker-bearing wrapper", operation => fixture(f => {
    expect(installCodexShim().installed).toBe(true);
    const state = JSON.parse(fs.readFileSync(f.statePath, "utf8"));
    delete state.wrapperIdentity;
    delete state.envIdentity;
    fs.writeFileSync(f.statePath, JSON.stringify(state));
    const original = saved(f.wrapper);
    fs.renameSync(f.wrapper, `${f.wrapper}.previous`);
    fs.writeFileSync(f.wrapper, `${original.bytes}\n# FOREIGN FILE: not owned by OpenCodex\n`, { mode: 0o755 });
    const foreign = saved(f.wrapper);
    const stateBefore = saved(f.statePath);
    const envBefore = saved(f.envFile);
    const nativeBefore = saved(f.native);
    expect(foreign.ino).not.toBe(original.ino);
    const result = operation === "uninstall" ? uninstallCodexShim()
      : operation === "install" ? installCodexShim()
      : autoRestoreCodexShim({ enabled: () => true, stabilitySleep: () => {} });
    expect(saved(f.wrapper)).toEqual(foreign);
    expect(saved(f.statePath)).toEqual(stateBefore);
    expect(saved(f.envFile)).toEqual(envBefore);
    expect(saved(f.native)).toEqual(nativeBefore);
    if (operation === "uninstall") expect(result).toMatchObject({ removed: false });
    else if (operation === "install") expect(result).toMatchObject({ installed: false, refused: true });
    else expect(result).toMatchObject({ status: "ineligible" });
    expect(result.message).toMatch(/not.*owned|unowned|replaced|identity|ownership/i);
  }));

  for (const artifact of ["environment", "state"] as const) {
    test(`${artifact} chmod 0666 is not diagnosed healthy`, () => fixture(f => {
      expect(installCodexShim().installed).toBe(true);
      process.env.PATH = `${dirname(f.wrapper)}:${process.env.PATH}`;
      expect(diagnoseCodexShim().healthy).toBe(true);
      const path = artifact === "environment" ? f.envFile : f.statePath;
      fs.chmodSync(path, 0o666);
      const before = saved(path);
      expect(diagnoseCodexShim().healthy).toBe(false);
      expect(saved(path)).toEqual(before);
    }));

    test(`${artifact} chmod 0666 bypasses no ownership checks on automatic healthy fast path`, () => fixture(f => {
      expect(installCodexShim().installed).toBe(true);
      process.env.PATH = `${dirname(f.wrapper)}:${process.env.PATH}`;
      const path = artifact === "environment" ? f.envFile : f.statePath;
      fs.chmodSync(path, 0o666);
      const before = saved(path);
      const wrapper = saved(f.wrapper);
      const native = saved(f.native);
      const result = autoRestoreCodexShim({ enabled: () => { throw new Error("unsafe artifact must not consult opt-in"); } });
      expect(result.status).toBe("ineligible");
      expect(result.message).toMatch(/owned|permission|writable|private|unsafe/i);
      expect(saved(path)).toEqual(before);
      expect(saved(f.wrapper)).toEqual(wrapper);
      expect(saved(f.native)).toEqual(native);
    }));
  }

  test.each(["identical", "foreign-content"])("a replaced %s activation file is unhealthy and preserved by auto-repair", kind => fixture(f => {
    expect(installCodexShim().installed).toBe(true);
    process.env.PATH = `${dirname(f.wrapper)}:${process.env.PATH}`;
    const original = saved(f.envFile);
    fs.renameSync(f.envFile, `${f.envFile}.previous`);
    fs.writeFileSync(f.envFile, kind === "identical" ? original.bytes : "# foreign shell environment\nexport FOREIGN_ENV=1\n", { mode: 0o600 });
    const foreign = saved(f.envFile);
    expect(foreign.ino).not.toBe(original.ino);
    expect(diagnoseCodexShim().healthy).toBe(false);
    const result = autoRestoreCodexShim({ enabled: () => true, stabilitySleep: () => {} });
    expect(result.status).toBe("ineligible");
    expect(result.message).toMatch(/not.*owned|unowned|replaced|identity|ownership/i);
    expect(saved(f.envFile)).toEqual(foreign);
  }));

  test("missing owned activation file is unhealthy, respects opt-out and repairs on opt-in", () => fixture(f => {
    expect(installCodexShim().installed).toBe(true);
    process.env.PATH = `${dirname(f.wrapper)}:${process.env.PATH}`;
    const env = saved(f.envFile);
    const native = saved(f.native);
    fs.unlinkSync(f.envFile);
    expect(diagnoseCodexShim().healthy).toBe(false);
    expect(autoRestoreCodexShim({ enabled: () => false }).status).toBe("disabled");
    expect(fs.existsSync(f.envFile)).toBe(false);
    const result = autoRestoreCodexShim({ enabled: () => true, stabilitySleep: () => {} });
    expect(result.status).toBe("restored");
    expect(fs.readFileSync(f.envFile, "utf8")).toBe(env.bytes);
    expect(fs.lstatSync(f.envFile).mode & 0o777).toBe(0o600);
    expect(diagnoseCodexShim().healthy).toBe(true);
    expect(saved(f.native)).toEqual(native);
  }));

  test("concurrent marker-bearing publication during probe is never removed", () => fixture(f => {
    let foreign: ReturnType<typeof saved> | undefined;
    setCodexShimProbeHookForTests(() => {
      fs.writeFileSync(f.wrapper, "#!/bin/sh\n# opencodex codex autostart shim\nprintf 'foreign\\n'\n", { mode: 0o755 });
      foreign = saved(f.wrapper);
    });
    expect(installCodexShim().installed).toBe(false);
    expect(saved(f.wrapper)).toEqual(foreign);
    expect(fs.existsSync(f.statePath)).toBe(false);
    expect(privateDebris(f.home)).toEqual([]);
  }));

  test("a staged-path replacement cannot be adopted as the inode created by OpenCodex", () => fixture(f => {
    const open = fs.openSync;
    const write = fs.writeFileSync;
    let stagedFd: number | undefined;
    let stagedPath: string | undefined;
    let foreign: ReturnType<typeof saved> | undefined;
    spyOn(fs, "openSync").mockImplementation((path, flags, mode) => {
      const fd = open(path, flags, mode);
      if (String(path).startsWith(`${f.wrapper}.`) && String(path).endsWith(".stage")) {
        stagedFd = fd;
        stagedPath = String(path);
      }
      return fd;
    });
    spyOn(fs, "writeFileSync").mockImplementation((file, bytes, options) => {
      write(file, bytes, options);
      if (file === stagedFd && stagedPath && !foreign) {
        fs.renameSync(stagedPath, `${stagedPath}.original`);
        write(stagedPath, "# foreign staged replacement\n", { mode: 0o600 });
        foreign = saved(stagedPath);
      }
    });
    const result = installCodexShim();
    mock.restore();
    expect(foreign).toBeDefined();
    expect(result).toMatchObject({ installed: false, refused: true });
    expect(result.message).toContain("Staged Codex file replaced");
    expect(saved(stagedPath!)).toEqual(foreign);
    expect(fs.existsSync(f.wrapper)).toBe(false);
    expect(fs.existsSync(f.statePath)).toBe(false);
  }));

  test("incomplete rollback retains its journal and retry recovers before fresh installation", () => fixture(f => {
    const link = fs.linkSync;
    const unlink = fs.unlinkSync;
    let publicationFailed = false;
    let recoveryFailed = false;
    spyOn(fs, "linkSync").mockImplementation((from, to) => {
      if (String(to) === f.statePath && String(from).endsWith(".stage")) {
        publicationFailed = true;
        throw new Error("interrupted state commit");
      }
      return link(from, to);
    });
    spyOn(fs, "unlinkSync").mockImplementation(path => {
      if (publicationFailed && String(path) === f.wrapper) {
        recoveryFailed = true;
        throw new Error("interrupted rollback");
      }
      return unlink(path);
    });
    const result = installCodexShim();
    mock.restore();
    expect(publicationFailed).toBe(true);
    expect(recoveryFailed).toBe(true);
    expect(result).toMatchObject({ installed: false, refused: true });
    expect(result.message).toContain("recovery");
    expect(fs.existsSync(join(f.home, "codex-shim.transaction.json"))).toBe(true);
    expect(fs.existsSync(f.wrapper)).toBe(true);
    expect(fs.existsSync(f.statePath)).toBe(false);
    const retry = installCodexShim();
    expect(retry.installed, retry.message).toBe(true);
    expect(privateDebris(f.home)).toEqual([]);
    expect(diagnoseCodexShim().runnable).toBe(true);
  }));

  test.each([0o770, 0o707, 0o777])("private bin mode %d is refused without changing it", mode => fixture(f => {
    const bin = dirname(f.wrapper);
    fs.mkdirSync(bin);
    fs.chmodSync(bin, mode);
    const native = saved(f.native);
    const result = installCodexShim();
    expect(result.installed).toBe(false);
    expect(result.message).toContain("group/world writable");
    expect(fs.lstatSync(bin).mode & 0o777).toBe(mode);
    expect(saved(f.native)).toEqual(native);
    expect(fs.existsSync(f.wrapper)).toBe(false);
  }));

  test("symlinked private bin is refused and does not touch its target", () => fixture(f => {
    const native = saved(f.native);
    fs.symlinkSync(dirname(f.native), dirname(f.wrapper));
    expect(installCodexShim().installed).toBe(false);
    expect(fs.lstatSync(dirname(f.wrapper)).isSymbolicLink()).toBe(true);
    expect(saved(f.native)).toEqual(native);
    expect(fs.existsSync(f.statePath)).toBe(false);
  }));

  test("group-writable private home is refused", () => fixture(f => {
    fs.chmodSync(f.home, 0o770);
    expect(installCodexShim().installed).toBe(false);
    expect(fs.lstatSync(f.home).mode & 0o777).toBe(0o770);
    expect(fs.existsSync(f.wrapper)).toBe(false);
  }));

  test("shared operation lock defers repair and allows retry after release", () => fixture(f => {
    expect(installCodexShim().installed).toBe(true);
    fs.unlinkSync(f.wrapper);
    const lock = tryAcquireShimRestoreLock();
    expect(lock).not.toBeNull();
    try {
      expect(autoRestoreCodexShim({ enabled: () => true }).status).toBe("deferred");
      expect(fs.existsSync(f.wrapper)).toBe(false);
    } finally { lock?.release(); }
    expect(autoRestoreCodexShim({ enabled: () => true, stabilitySleep: () => {} }).status).toBe("restored");
  }));
});
