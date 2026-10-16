import { describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoRestoreCodexShim, buildUnixCodexShim, codexShimStatus, diagnoseCodexShim, installCodexShim, setCodexShimProbeHookForTests, setCodexShimProbeObservationMsForTests, uninstallCodexShim } from "../../src/codex/shim";
import { readState, type ShimState } from "../../src/codex/shim-state-file";

function fixture(run: (f: { root: string; home: string; native: string; backup: string; quarantine: string; wrapper: string; statePath: string; state: ShimState; legacyBytes: string; version: (name: string) => string }) => void, homeName = "home"): void {
  const root = fs.mkdtempSync(join(tmpdir(), "ocx-overlay-migration-"));
  const home = join(root, homeName);
  const bin = join(root, "manager");
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(bin);
  const previous = { ...process.env };
  const native = join(bin, "codex");
  const backup = `${native}.opencodex-real`;
  const quarantine = `${native}.opencodex-migrating`;
  const statePath = join(home, "codex-shim.json");
  const state: ShimState = { platform: process.platform, wrapperPath: native, originalPath: native, backupPath: backup };
  const version = (name: string) => {
    const path = join(root, name);
    fs.writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' '${name}'\n`, { mode: 0o755 });
    return path;
  };
  try {
    process.env.HOME = root;
    process.env.OPENCODEX_HOME = home;
    process.env.CODEX_HOME = join(root, "codex-home");
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    for (const key of ["CODEX_CLI_PATH", "OCX_SHIM_ACTIVE_PID", "OCX_SHIM_ACTIVE_DEPTH", "OCX_SHIM_PROBE", "OCX_SHIM_PROBE_ACTIVE"]) delete process.env[key];
    setCodexShimProbeObservationMsForTests(20);
    fs.symlinkSync(version("v1"), backup);
    const legacyBytes = buildUnixCodexShim(backup, process.execPath, "unused", "system");
    fs.writeFileSync(native, legacyBytes, { mode: 0o755 });
    fs.writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
    run({ root, home, native, backup, quarantine, wrapper: join(home, "bin", "codex"), statePath, state, legacyBytes, version });
  } finally {
    mock.restore();
    setCodexShimProbeHookForTests(null);
    setCodexShimProbeObservationMsForTests(null);
    process.env = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const lexical = (path: string) => { try { return fs.lstatSync(path); } catch { return null; } };

describe.skipIf(process.platform === "win32")("legacy Unix shim migration", () => {
  test("healthy legacy status advises explicit migration without changing health or files", () => fixture(f => {
    const raw = fs.readFileSync(f.statePath, "utf8");
    const diagnostic = diagnoseCodexShim();
    expect(diagnostic).toMatchObject({ installed: true, healthy: true });
    expect(codexShimStatus()).toBe(diagnostic.summary);
    expect(diagnostic.summary).toContain("Legacy Unix shim installed in place; automatic repair does not migrate it.");
    expect(diagnostic.summary).toContain("Run ocx codex-shim install, then source the printed codex-shell-env.sh path");
    expect(diagnostic.summary).toContain("after PATH setup in your shell startup file");
    expect(fs.readFileSync(f.statePath, "utf8")).toBe(raw);
    expect(fs.readFileSync(f.native, "utf8")).toBe(f.legacyBytes);
    expect(lexical(join(f.home, "codex-shell-env.sh"))).toBeNull();
  }));

  test("Windows legacy diagnostics omit Unix migration and sourcing advice", () => fixture(f => {
    fs.writeFileSync(f.statePath, JSON.stringify({ ...f.state, platform: "win32" }));
    const diagnostic = diagnoseCodexShim();
    expect(diagnostic).toMatchObject({ installed: true, healthy: true });
    expect(diagnostic.summary).not.toContain("Legacy Unix");
    expect(diagnostic.summary).not.toContain("codex-shell-env.sh");
  }));

  test("explicit install restores backup symlink and commits schema 2 without in-place wrapping", () => fixture(f => {
    const target = fs.readlinkSync(f.backup);
    expect(autoRestoreCodexShim({ enabled: () => true }).status).toBe("ineligible");
    const installed = installCodexShim();
    expect(installed.installed, installed.message).toBe(true);
    expect(fs.readlinkSync(f.native)).toBe(target);
    expect(lexical(f.backup)).toBeNull();
    expect(lexical(f.quarantine)).toBeNull();
    expect(readState()).toMatchObject({ schema: 2, launcherPath: f.native });
    expect(diagnoseCodexShim().summary).not.toContain("Legacy Unix");
    expect(installCodexShim()).toMatchObject({ installed: false, runnable: true });
  }));

  test("group-writable legacy state (umask 002) refuses with the path and the chmod that unblocks migration", () => fixture(f => {
    fs.chmodSync(f.statePath, 0o664);
    const raw = fs.readFileSync(f.statePath, "utf8");
    const refused = installCodexShim();
    expect(refused).toMatchObject({ installed: false, refused: true });
    expect(refused.message).toContain(`Private Codex artifact is not an owned regular file: ${f.statePath}`);
    expect(refused.message).toContain("group- or world-writable (mode 0664)");
    expect(refused.message).toContain(`run chmod 600 '${f.statePath}' and retry`);
    expect(fs.readFileSync(f.statePath, "utf8")).toBe(raw);
    expect(fs.readFileSync(f.native, "utf8")).toBe(f.legacyBytes);
    fs.chmodSync(f.statePath, 0o600);
    const installed = installCodexShim();
    expect(installed.installed, installed.message).toBe(true);
    expect(readState()).toMatchObject({ schema: 2, launcherPath: f.native });
  }));

  test("printed chmod hint handles spaces and apostrophes and permits legacy migration", () => fixture(f => {
    fs.chmodSync(f.statePath, 0o664);
    const raw = fs.readFileSync(f.statePath, "utf8");
    const refused = installCodexShim();
    expect(refused).toMatchObject({ installed: false, refused: true });
    expect(refused.message).toContain(`run chmod 600 '${f.root}/owner'\\''s home/codex-shim.json' and retry`);
    expect(fs.readFileSync(f.statePath, "utf8")).toBe(raw);
    expect(fs.lstatSync(f.statePath).mode & 0o777).toBe(0o664);
    const hint = refused.message.match(/run (chmod 600 .+) and retry/)?.[1];
    expect(hint).toBeDefined();
    const result = Bun.spawnSync(["/bin/sh", "-c", hint!]);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(fs.lstatSync(f.statePath).mode & 0o777).toBe(0o600);
    const installed = installCodexShim();
    expect(installed.installed, installed.message).toBe(true);
    expect(readState()).toMatchObject({ schema: 2, launcherPath: f.native });
    expect(fs.lstatSync(f.statePath).mode & 0o777).toBe(0o600);
  }, "owner's home"));

  test("regular backup restoration retains its inode", () => fixture(f => {
    fs.unlinkSync(f.backup);
    fs.writeFileSync(f.backup, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const inode = fs.lstatSync(f.backup).ino;
    expect(installCodexShim().installed).toBe(true);
    expect(fs.lstatSync(f.native).ino).toBe(inode);
    expect(lexical(f.backup)).toBeNull();
  }));

  test("newer native entry wins over a surviving older backup", () => fixture(f => {
    const oldTarget = fs.readlinkSync(f.backup);
    fs.unlinkSync(f.native);
    fs.symlinkSync(f.version("newer"), f.native);
    const inode = fs.lstatSync(f.native).ino;
    expect(installCodexShim().installed).toBe(true);
    expect(fs.lstatSync(f.native).ino).toBe(inode);
    expect(fs.readlinkSync(f.native)).toContain("newer");
    expect(fs.readlinkSync(f.backup)).toBe(oldTarget);
  }));

  test("broken backup is restored lexically, retains recovery state and resumes after manager repair", () => fixture(f => {
    const target = fs.readlinkSync(f.backup);
    fs.unlinkSync(target);
    const before = fs.readFileSync(f.statePath, "utf8");
    expect(installCodexShim().installed).toBe(false);
    expect(fs.lstatSync(f.native).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(f.native)).toBe(target);
    expect(fs.readFileSync(f.statePath, "utf8")).toBe(before);
    fs.writeFileSync(target, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const installed = installCodexShim();
    expect(installed.installed, installed.message).toBe(true);
    expect(lexical(f.quarantine)).toBeNull();
  }));

  test("missing backup refuses without destroying confirmed legacy wrapper or state", () => fixture(f => {
    fs.unlinkSync(f.backup);
    const raw = fs.readFileSync(f.statePath, "utf8");
    expect(installCodexShim().installed).toBe(false);
    expect(fs.readFileSync(f.native, "utf8")).toBe(f.legacyBytes);
    expect(fs.readFileSync(f.statePath, "utf8")).toBe(raw);
    expect(lexical(f.wrapper)).toBeNull();
  }));

  test.each(["multiple", "preserve-only", "alternate-real", "wrong-backup", "wrong-wrapper"])("ambiguous %s layout refuses and preserves all artifacts", kind => fixture(f => {
    const file = { wrapperPath: f.native, originalPath: f.native, backupPath: f.backup };
    const state = kind === "multiple" ? { ...f.state, wrappers: [file, { ...file }] }
      : kind === "preserve-only" ? { ...f.state, wrappers: [{ ...file, preserveOnly: true }] }
      : kind === "alternate-real" ? { ...f.state, wrappers: [{ ...file, realPath: f.backup }] }
      : kind === "wrong-backup" ? { ...f.state, backupPath: join(f.root, "other") }
      : { ...f.state, wrapperPath: join(f.root, "other") };
    const raw = JSON.stringify(state);
    fs.writeFileSync(f.statePath, raw);
    const backup = fs.readlinkSync(f.backup);
    const result = installCodexShim();
    expect(result.installed).toBe(false);
    expect(result.message).toContain("ambiguous");
    expect(fs.readFileSync(f.native, "utf8")).toBe(f.legacyBytes);
    expect(fs.readlinkSync(f.backup)).toBe(backup);
    expect(fs.readFileSync(f.statePath, "utf8")).toBe(raw);
  }));

  test("unrecorded quarantine refuses rather than guessing ownership", () => fixture(f => {
    fs.renameSync(f.native, f.quarantine);
    expect(installCodexShim().installed).toBe(false);
    expect(fs.readFileSync(f.quarantine, "utf8")).toBe(f.legacyBytes);
    expect(lexical(f.native)).toBeNull();
    expect(lexical(f.backup)?.isSymbolicLink()).toBe(true);
  }));

  test("retry after journaled evacuation restores native without resurrecting old wrapper", () => fixture(f => {
    const unlink = fs.unlinkSync;
    let injected = false;
    const hook = spyOn(fs, "unlinkSync").mockImplementation(path => {
      if (String(path) === f.backup && !injected) { injected = true; throw new Error("interrupted migration cleanup"); }
      return unlink(path);
    });
    expect(installCodexShim().installed).toBe(false);
    hook.mockRestore();
    expect(injected).toBe(true);
    expect(fs.lstatSync(f.native).isSymbolicLink()).toBe(true);
    expect(lexical(f.quarantine)).not.toBeNull();
    const retry = installCodexShim();
    expect(retry.installed, retry.message).toBe(true);
    expect(fs.lstatSync(f.native).isSymbolicLink()).toBe(true);
    expect(lexical(f.quarantine)).toBeNull();
  }));

  test("concurrent manager publication is preserved during no-replace backup restoration", () => fixture(f => {
    const publish = fs.symlinkSync;
    let injected = false;
    const newTarget = f.version("concurrent");
    const hook = spyOn(fs, "symlinkSync").mockImplementation((target, path, type) => {
      if (String(path) === f.native && !injected) {
        injected = true;
        publish(newTarget, path, type);
      }
      return publish(target, path, type);
    });
    const result = installCodexShim();
    hook.mockRestore();
    expect(injected).toBe(true);
    expect(result.installed, result.message).toBe(true);
    expect(fs.readlinkSync(f.native)).toBe(newTarget);
    expect(lexical(f.backup)?.isSymbolicLink()).toBe(true);
  }));

  test("probe failure after migration keeps native restored and legacy state for retry", () => fixture(f => {
    const raw = fs.readFileSync(f.statePath, "utf8");
    setCodexShimProbeHookForTests(() => { throw new Error("overlay probe interrupted"); });
    const failed = installCodexShim();
    expect(failed).toMatchObject({ installed: false, refused: true });
    expect(failed.message).toContain("overlay probe interrupted");
    expect(fs.lstatSync(f.native).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(f.statePath, "utf8")).toBe(raw);
    expect(lexical(f.quarantine)).toBeNull();
    setCodexShimProbeHookForTests(null);
    expect(installCodexShim().installed).toBe(true);
  }));

  test("legacy uninstall restores native and removes only the recorded state", () => fixture(f => {
    const removed = uninstallCodexShim();
    expect(removed.removed, removed.message).toBe(true);
    expect(fs.lstatSync(f.native).isSymbolicLink()).toBe(true);
    expect(lexical(f.statePath)).toBeNull();
    expect(lexical(f.backup)).toBeNull();
  }));

  test.each(["missing", "broken"])("legacy uninstall with %s backup retains recovery state and reports failure", kind => fixture(f => {
    if (kind === "missing") fs.unlinkSync(f.backup);
    else fs.unlinkSync(fs.readlinkSync(f.backup));
    const raw = fs.readFileSync(f.statePath, "utf8");
    expect(uninstallCodexShim().removed).toBe(false);
    expect(fs.readFileSync(f.statePath, "utf8")).toBe(raw);
    if (kind === "missing") expect(fs.readFileSync(f.native, "utf8")).toBe(f.legacyBytes);
    else expect(lexical(f.native)?.isSymbolicLink()).toBe(true);
  }));

  test("a partially written journal is discarded so the next install can migrate", () => fixture(f => {
    const realWrite = fs.writeFileSync;
    const journal = join(f.home, "codex-shim.migration.json");
    const hook = spyOn(fs, "writeFileSync").mockImplementation(((target: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions) => {
      if (typeof target === "number" && String(data).includes('"original"')) {
        fs.writeSync(target, "{");
        throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
      }
      return realWrite(target, data, options);
    }) as typeof fs.writeFileSync);
    expect(installCodexShim().installed).toBe(false);
    expect(hook).toHaveBeenCalled();
    hook.mockRestore();
    expect(lexical(journal)).toBeNull();
    expect(fs.readFileSync(f.native, "utf8")).toBe(f.legacyBytes);
    expect(lexical(f.backup)?.isSymbolicLink()).toBe(true);
    expect(lexical(f.quarantine)).toBeNull();
    const retry = installCodexShim();
    expect(retry.installed, retry.message).toBe(true);
    expect(lexical(journal)).toBeNull();
    expect(readState()).toMatchObject({ schema: 2, launcherPath: f.native });
  }));

  test("a journal replaced during creation is preserved and migration refuses", () => fixture(f => {
    const realWrite = fs.writeFileSync;
    const journal = join(f.home, "codex-shim.migration.json");
    const foreign = join(f.root, "foreign-journal");
    realWrite(foreign, "foreign journal\n", { mode: 0o600 });
    const hook = spyOn(fs, "writeFileSync").mockImplementation(((target: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions) => {
      realWrite(target, data, options);
      if (typeof target === "number" && String(data).includes('"original"')) fs.renameSync(foreign, journal);
    }) as typeof fs.writeFileSync);
    expect(installCodexShim().installed).toBe(false);
    expect(hook).toHaveBeenCalled();
    hook.mockRestore();
    expect(fs.readFileSync(journal, "utf8")).toBe("foreign journal\n");
    expect(fs.readFileSync(f.native, "utf8")).toBe(f.legacyBytes);
    expect(lexical(f.backup)?.isSymbolicLink()).toBe(true);
    expect(lexical(f.quarantine)).toBeNull();
    expect(installCodexShim().installed).toBe(false);
    expect(fs.readFileSync(journal, "utf8")).toBe("foreign journal\n");
  }));
});
