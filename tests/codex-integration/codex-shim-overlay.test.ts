import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { autoRestoreCodexShim, inspectCodexShimBackingForCommand, installCodexShim, setCodexShimProbeObservationMsForTests, uninstallCodexShim } from "../../src/codex/shim";
import { readState, stateFiles } from "../../src/codex/shim-state-file";

function fixture(run: (f: { root: string; home: string; native: string; wrapper: string; envFile: string; statePath: string; version: (name: string) => string }) => void): void {
  const root = mkdtempSync(join(tmpdir(), "ocx-overlay-contract-"));
  const home = join(root, "private space's home");
  const bin = join(root, "brew", "bin");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(bin, { recursive: true });
  const previous = { ...process.env };
  const native = join(bin, "codex");
  const wrapper = join(home, "bin", "codex");
  const version = (name: string) => {
    const path = join(root, "Caskroom", name, "codex");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' '${name}' "$@"\n`, { mode: 0o755 });
    return path;
  };
  try {
    process.env.HOME = root;
    process.env.OPENCODEX_HOME = home;
    process.env.CODEX_HOME = join(root, "codex-home");
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    for (const key of ["CODEX_CLI_PATH", "OCX_SHIM_ACTIVE_PID", "OCX_SHIM_ACTIVE_DEPTH", "OCX_SHIM_PROBE", "OCX_SHIM_PROBE_ACTIVE", "OPENCODEX_API_AUTH_TOKEN"]) delete process.env[key];
    setCodexShimProbeObservationMsForTests(20);
    symlinkSync(version("v1"), native);
    run({ root, home, native, wrapper, envFile: join(home, "codex-shell-env.sh"), statePath: join(home, "codex-shim.json"), version });
  } finally {
    setCodexShimProbeObservationMsForTests(null);
    process.env = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

function invoke(wrapper: string) {
  return spawnSync(wrapper, ["--version"], { encoding: "utf8", env: process.env, timeout: 5000 });
}

describe.skipIf(process.platform === "win32")("Unix private Codex overlay", () => {
  test("fresh install preserves the native symlink inode and creates no manager backup", () => fixture(f => {
    const native = lstatSync(f.native);
    const target = readlinkSync(f.native);
    const path = process.env.PATH;
    const installed = installCodexShim();
    expect(installed.installed, installed.message).toBe(true);
    expect(lstatSync(f.native).ino).toBe(native.ino);
    expect(readlinkSync(f.native)).toBe(target);
    expect(existsSync(`${f.native}.opencodex-real`)).toBe(false);
    expect(process.env.PATH).toBe(path);
    expect(invoke(f.wrapper)).toMatchObject({ status: 0, stdout: "v1\n--version\n" });
  }));

  test("fresh install also leaves a regular native launcher inode and bytes unchanged", () => fixture(f => {
    unlinkSync(f.native);
    const bytes = "#!/bin/sh\nprintf 'regular\\n'\n";
    writeFileSync(f.native, bytes, { mode: 0o755 });
    const inode = lstatSync(f.native).ino;
    expect(installCodexShim().installed).toBe(true);
    expect(lstatSync(f.native).ino).toBe(inode);
    expect(readFileSync(f.native, "utf8")).toBe(bytes);
    expect(existsSync(`${f.native}.opencodex-real`)).toBe(false);
  }));

  test("native symlink upgrades, old-version cleanup and rollback work without rewriting overlay", () => fixture(f => {
    expect(installCodexShim().installed).toBe(true);
    const wrapper = readFileSync(f.wrapper, "utf8");
    const inode = lstatSync(f.wrapper).ino;
    const upgraded = f.version("v2");
    unlinkSync(f.native);
    symlinkSync(upgraded, f.native);
    rmSync(join(f.root, "Caskroom", "v1"), { recursive: true });
    expect(invoke(f.wrapper).stdout).toBe("v2\n--version\n");
    expect(autoRestoreCodexShim({ enabled: () => { throw new Error("healthy overlay must not load config"); } }).status).toBe("healthy");
    unlinkSync(f.native);
    symlinkSync(f.version("rollback"), f.native);
    expect(invoke(f.wrapper).stdout).toBe("rollback\n--version\n");
    expect(readFileSync(f.wrapper, "utf8")).toBe(wrapper);
    expect(lstatSync(f.wrapper).ino).toBe(inode);
  }));

  test("fnm multishell removal leaves the recorded durable launcher and wrapper usable", () => fixture(f => {
    const installation = join(f.root, "node-versions", "v24", "installation");
    const stableBin = join(installation, "bin");
    const temporaryRoot = join(f.root, "fnm_multishells");
    const temporaryInstallation = join(temporaryRoot, "session");
    mkdirSync(stableBin, { recursive: true });
    mkdirSync(temporaryRoot);
    const launcher = join(stableBin, "codex");
    symlinkSync(f.version("fnm"), launcher);
    symlinkSync(installation, temporaryInstallation);
    process.env.PATH = `${join(temporaryInstallation, "bin")}:/usr/bin:/bin`;
    const inode = lstatSync(launcher).ino;
    const result = installCodexShim();
    expect(result.installed, result.message).toBe(true);
    expect(JSON.parse(readFileSync(f.statePath, "utf8"))).toMatchObject({ launcherPath: join(realpathSync(stableBin), "codex") });
    expect(readFileSync(f.statePath, "utf8")).not.toContain("fnm_multishells");
    rmSync(temporaryRoot, { recursive: true });
    expect(lstatSync(launcher).ino).toBe(inode);
    expect(invoke(f.wrapper)).toMatchObject({ status: 0, stdout: "fnm\n--version\n" });
    expect(autoRestoreCodexShim({ enabled: () => { throw new Error("durable launcher needs no repair"); } }).status).toBe("healthy");
  }));

  test("schema 2 exposes the durable launcher as read-only backing", () => fixture(f => {
    expect(installCodexShim().installed).toBe(true);
    const raw = readFileSync(f.statePath, "utf8");
    expect(JSON.parse(raw)).toMatchObject({ schema: 2, mode: "path-overlay", platform: process.platform, wrapperPath: f.wrapper, launcherPath: f.native });
    const state = readState()!;
    expect(stateFiles(state)).toEqual([{ wrapperPath: f.wrapper, originalPath: f.native, backupPath: f.native, realPath: f.native }]);
    expect(inspectCodexShimBackingForCommand(f.wrapper)).toMatchObject({ status: "matched", selectedRole: "wrapper", backingPath: f.native, backingKind: "real" });
    expect(inspectCodexShimBackingForCommand(f.native)).toMatchObject({ status: "matched", selectedRole: "backing", backingPath: f.native });
    expect(readFileSync(f.statePath, "utf8")).toBe(raw);
    expect(lstatSync(f.statePath).mode & 0o777).toBe(0o600);
    expect(lstatSync(f.envFile).mode & 0o777).toBe(0o600);
  }));

  test("management bypass preserves token, arguments, stdin, both output streams and exit code", () => fixture(f => {
    unlinkSync(f.native);
    writeFileSync(f.native, '#!/bin/sh\n[ "$1" = --version ] && exit 0\nprintf "token=%s\\n" "$OPENCODEX_API_AUTH_TOKEN"\nprintf "%s\\n" "$@"\ncat\nprintf "native stderr\\n" >&2\nexit 23\n', { mode: 0o755 });
    const token = "fixture-overlay-token";
    writeFileSync(join(f.home, "service-api-token"), `${token}\n`, { mode: 0o600 });
    expect(installCodexShim().installed).toBe(true);
    // A management command skips ensure without OCX_SHIM_BYPASS, so no live proxy starts.
    const result = spawnSync(f.wrapper, ["login", "a b", "'quoted'"], { env: { ...process.env, OCX_SHIM_BYPASS: "" }, encoding: "utf8", input: "input\n", timeout: 5000 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(23);
    expect(result.stdout).toBe(`token=${token}\nlogin\na b\n'quoted'\ninput\n`);
    expect(result.stderr).toBe("native stderr\n");
    const inherited = spawnSync(f.wrapper, ["login"], { env: { ...process.env, OPENCODEX_API_AUTH_TOKEN: "inherited-token" }, encoding: "utf8", timeout: 5000 });
    expect(inherited.stdout).toBe("token=inherited-token\nlogin\n");
    expect(readFileSync(f.wrapper, "utf8")).not.toContain(token);
    expect(readFileSync(f.statePath, "utf8")).not.toContain(token);
    expect(readFileSync(f.envFile, "utf8")).not.toContain(token);
  }));

  test("a missing recorded native launcher is never rediscovered from a different PATH installation", () => fixture(f => {
    expect(installCodexShim().installed).toBe(true);
    const state = readFileSync(f.statePath, "utf8");
    unlinkSync(f.native);
    const other = join(f.root, "other");
    mkdirSync(other);
    symlinkSync(f.version("decoy"), join(other, "codex"));
    process.env.PATH = `${other}:/usr/bin:/bin`;
    expect(autoRestoreCodexShim({ enabled: () => true }).status).toBe("ineligible");
    expect(installCodexShim().installed).toBe(false);
    expect(existsSync(f.native)).toBe(false);
    expect(readFileSync(f.statePath, "utf8")).toBe(state);
    expect(readlinkSync(join(other, "codex"))).toContain("decoy");
  }));

  test("missing private wrapper respects opt-out and repairs only after opt-in", () => fixture(f => {
    expect(installCodexShim().installed).toBe(true);
    const native = lstatSync(f.native).ino;
    unlinkSync(f.wrapper);
    expect(autoRestoreCodexShim({ enabled: () => false }).status).toBe("disabled");
    expect(existsSync(f.wrapper)).toBe(false);
    expect(autoRestoreCodexShim({ enabled: () => true, stabilitySleep: () => {} }).status).toBe("restored");
    expect(lstatSync(f.native).ino).toBe(native);
    expect(invoke(f.wrapper).status).toBe(0);
  }));

  test("uninstall removes only private artifacts and preserves native and unrelated files", () => fixture(f => {
    expect(installCodexShim().installed).toBe(true);
    const native = lstatSync(f.native).ino;
    const unrelated = join(dirname(f.wrapper), "my-tool");
    writeFileSync(unrelated, "user-owned tool");
    const removed = uninstallCodexShim();
    expect(removed.removed, removed.message).toBe(true);
    expect(existsSync(f.wrapper)).toBe(false);
    expect(existsSync(f.envFile)).toBe(false);
    expect(existsSync(f.statePath)).toBe(false);
    expect(lstatSync(f.native).ino).toBe(native);
    expect(readFileSync(unrelated, "utf8")).toBe("user-owned tool");
    expect(removed.message).toContain("source line");
  }));
});
