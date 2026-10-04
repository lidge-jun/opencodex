import { describe, expect, mock, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { diagnoseCodexShim, installCodexShim, setCodexShimProbeObservationMsForTests } from "../../src/codex/shim";
import { findFirstCodexOnPath } from "../../src/codex/shim-path-resolution";
import { inspectCodexShimForConnect } from "../../src/cli/codex-shim-readiness";

function fixture(run: (f: { root: string; home: string; native: string; wrapper: string; envFile: string; earlier: string }) => void): void {
  const root = fs.mkdtempSync(join(tmpdir(), "ocx-overlay-activation-"));
  const home = join(root, "private space's home");
  const bin = join(root, "manager");
  const earlier = join(root, "earlier");
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(bin);
  fs.mkdirSync(earlier);
  const previous = { ...process.env };
  const native = join(bin, "codex");
  fs.writeFileSync(native, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  try {
    process.env.HOME = root;
    process.env.OPENCODEX_HOME = home;
    process.env.CODEX_HOME = join(root, "codex-home");
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    for (const key of ["CODEX_CLI_PATH", "OCX_SHIM_ACTIVE_PID", "OCX_SHIM_ACTIVE_DEPTH", "OCX_SHIM_PROBE", "OCX_SHIM_PROBE_ACTIVE"]) delete process.env[key];
    setCodexShimProbeObservationMsForTests(20);
    const installed = installCodexShim();
    expect(installed.installed, installed.message).toBe(true);
    run({ root, home, native, wrapper: join(home, "bin", "codex"), envFile: join(home, "codex-shell-env.sh"), earlier });
  } finally {
    mock.restore();
    setCodexShimProbeObservationMsForTests(null);
    process.env = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function shellCommand() {
  return spawnSync("/bin/sh", ["-c", "command -v codex"], { env: process.env, encoding: "utf8", timeout: 3000 });
}

describe.skipIf(process.platform === "win32")("Unix overlay PATH activation", () => {
  test("inactive installation succeeds with source guidance and never changes calling PATH", () => fixture(f => {
    const path = process.env.PATH;
    const result = installCodexShim();
    expect(result).toMatchObject({ installed: false, runnable: true });
    expect(result.message).toContain("codex-shell-env.sh");
    expect(result.message).toContain("after other PATH setup");
    expect(process.env.PATH).toBe(path);
    expect(diagnoseCodexShim()).toMatchObject({ installed: true, runnable: true, active: false, healthy: false });
    expect(findFirstCodexOnPath()).toEqual({ path: f.native, isShim: false });
    expect(shellCommand().stdout.trim()).toBe(f.native);
    const readiness = inspectCodexShimForConnect();
    expect(readiness.status).toBe("missing");
    expect(readiness.message).toContain("installed but not active");
    expect(readiness.message).toContain("OPENCODEX_API_AUTH_TOKEN");
    expect(readiness.message).toContain("codex-shell-env.sh");
  }));

  test("sourcing quoted environment twice is idempotent and moves private bin ahead of later PATH setup", () => fixture(f => {
    const shell = spawnSync("/bin/sh", ["-c", '. "$1"; PATH=/usr/bin:$PATH; . "$1"; . "$1"; command -v codex; printf "%s\\n" "$PATH"', "test", f.envFile], { env: process.env, encoding: "utf8", timeout: 3000 });
    expect(shell.error).toBeUndefined();
    expect(shell.status).toBe(0);
    const [command, path] = shell.stdout.trimEnd().split("\n");
    expect(command).toBe(f.wrapper);
    expect(path!.split(":")[0]).toBe(dirname(f.wrapper));
    expect(path!.split(":").filter(item => item === dirname(f.wrapper))).toHaveLength(1);
    process.env.PATH = path;
    expect(findFirstCodexOnPath()).toEqual({ path: f.wrapper, isShim: true });
    expect(diagnoseCodexShim()).toMatchObject({ runnable: true, active: true, healthy: true });
    expect(inspectCodexShimForConnect().status).toBe("ready");
  }));

  test.each(["file", "symlink", "directory", "fifo", "fifo-symlink"])("earlier non-command %s does not shadow the executable overlay", kind => fixture(f => {
    const command = join(f.earlier, "codex");
    if (kind === "file") fs.writeFileSync(command, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
    else if (kind === "symlink") {
      const target = join(f.root, "non-executable");
      fs.writeFileSync(target, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
      fs.symlinkSync(target, command);
    } else if (kind === "directory") fs.mkdirSync(command, { mode: 0o755 });
    else {
      const fifo = kind === "fifo" ? command : join(f.root, "pipe");
      expect(spawnSync("/usr/bin/mkfifo", [fifo], { timeout: 3000 }).status).toBe(0);
      if (kind === "fifo-symlink") fs.symlinkSync(fifo, command);
    }
    process.env.PATH = `${f.earlier}:${dirname(f.wrapper)}:${dirname(f.native)}:/usr/bin:/bin`;
    expect(shellCommand().stdout.trim()).toBe(f.wrapper);
    expect(findFirstCodexOnPath()).toEqual({ path: f.wrapper, isShim: true });
    expect(diagnoseCodexShim()).toMatchObject({ active: true, healthy: true });
    expect(inspectCodexShimForConnect().status).toBe("ready");
  }));

  test("executable native command ahead makes the runnable overlay inactive", () => fixture(f => {
    process.env.PATH = `${dirname(f.native)}:${dirname(f.wrapper)}:/usr/bin:/bin`;
    expect(shellCommand().stdout.trim()).toBe(f.native);
    expect(diagnoseCodexShim()).toMatchObject({ runnable: true, active: false, healthy: false });
    expect(inspectCodexShimForConnect().status).toBe("missing");
  }));

  test("a different marker-bearing shim ahead does not activate this tracked overlay", () => fixture(f => {
    const other = join(f.earlier, "codex");
    fs.writeFileSync(other, "#!/bin/sh\n# opencodex codex autostart shim\nexit 0\n", { mode: 0o755 });
    process.env.PATH = `${f.earlier}:${dirname(f.wrapper)}:/usr/bin:/bin`;
    expect(findFirstCodexOnPath()).toEqual({ path: other, isShim: true });
    expect(shellCommand().stdout.trim()).toBe(other);
    expect(diagnoseCodexShim()).toMatchObject({ runnable: true, active: false, healthy: false });
    expect(inspectCodexShimForConnect().status).toBe("missing");
  }));

  test("a symlink alias to this wrapper is active by effective inode identity", () => fixture(f => {
    const alias = join(f.earlier, "codex");
    fs.symlinkSync(f.wrapper, alias);
    process.env.PATH = `${f.earlier}:/usr/bin:/bin`;
    expect(findFirstCodexOnPath()).toEqual({ path: alias, isShim: true });
    expect(shellCommand().stdout.trim()).toBe(alias);
    expect(diagnoseCodexShim()).toMatchObject({ runnable: true, active: true, healthy: true });
    expect(inspectCodexShimForConnect().status).toBe("ready");
  }));

  test("absence of any PATH command reports inactive rather than damaged", () => fixture(f => {
    process.env.PATH = f.earlier;
    expect(findFirstCodexOnPath()).toBeNull();
    expect(shellCommand().status).not.toBe(0);
    expect(diagnoseCodexShim()).toMatchObject({ runnable: true, active: false, healthy: false });
    expect(inspectCodexShimForConnect().status).toBe("missing");
  }));

  test("executable but unreadable earlier command continues to shadow the overlay", () => fixture(f => {
    const command = join(f.earlier, "codex");
    fs.writeFileSync(command, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    process.env.PATH = `${f.earlier}:${dirname(f.wrapper)}:/usr/bin:/bin`;
    const open = fs.openSync;
    spyOn(fs, "openSync").mockImplementation((path, flags, mode) => {
      if (String(path) === command) throw Object.assign(new Error("denied"), { code: "EACCES" });
      return open(path, flags, mode);
    });
    expect(findFirstCodexOnPath()).toEqual({ path: command, isShim: false });
    expect(diagnoseCodexShim()).toMatchObject({ runnable: true, active: false, healthy: false });
    expect(inspectCodexShimForConnect().status).toBe("missing");
  }));

  test("failed PATH inspection stays unverified and does not claim activation", () => fixture(f => {
    process.env.PATH = `${dirname(f.wrapper)}:/usr/bin:/bin`;
    const result = inspectCodexShimForConnect({ findOnPath: () => { throw new Error("scan interrupted"); } });
    expect(result.status).toBe("unverified");
    expect(result.message).toContain("could not be verified");
    expect(result.message).toContain("OPENCODEX_API_AUTH_TOKEN");
  }));
});
