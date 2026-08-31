import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { autoRestoreCodexShim, buildUnixCodexShim, buildWindowsCodexShim, buildWindowsPowerShellCodexShim, diagnoseCodexShim, findCodexOnPath, inspectCodexShimBackingForCommand, installCodexShim, isLocalAbsoluteInspectionPath, isVersionManagerOwnedCodexPath, isWindowsInteropDir, lastCodexDiscoveryError, setCodexShimFreshWriteHookForTests, setCodexShimGuardedWriteHookForTests, setCodexShimProbeHookForTests, setCodexShimProbeObservationMsForTests, setCodexShimProbeShellForTests, setCodexShimRollbackRestoreHookForTests, uninstallCodexShim } from "../src/codex/shim";

const SHIM_MARKER = "opencodex codex autostart shim";
const UNIX_SHIM_REVISION_MARKER = "opencodex unix codex shim revision 2";

/**
 * A child environment with the shim's recursion-guard state stripped.
 *
 * Every one of these tests reasons about a shim invocation starting from depth 0, but a developer
 * whose shell was itself launched through an installed Codex shim exports
 * `OCX_SHIM_ACTIVE_DEPTH=1` — so the guard fires a level early and the test measures whatever
 * ancestry the machine happened to have. CI has no shimmed ancestor, which is what let that bleed
 * hide: green there, red on a real developer's machine.
 *
 * The re-entry tests are the subtle case. They assert `status === 126`, so an inherited +1 offset
 * leaves them passing for entirely the wrong reason. Sanitizing centrally is what makes their
 * green mean what it says.
 *
 * Mirrors `probeUnixShimInstall`, which already clears the same three before spawning its probe.
 */
function shimChildEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...overrides };
  delete env.OCX_SHIM_ACTIVE_PID;
  delete env.OCX_SHIM_ACTIVE_DEPTH;
  delete env.OCX_SHIM_PROBE_ACTIVE;
  return env;
}
const skipStabilityWait = () => {};
const python3Path = process.platform === "win32"
  ? ""
  : spawnSync("/bin/sh", ["-c", "command -v python3"], { encoding: "utf8" }).stdout.trim();
setCodexShimProbeObservationMsForTests(20);
afterAll(() => setCodexShimProbeObservationMsForTests(null));
const psPath = process.platform !== "win32" && existsSync("/bin/ps") ? "/bin/ps" : "";

function prependPath(dir: string, current: string | undefined): string {
  return [dir, current].filter(Boolean).join(delimiter);
}

function successfulLauncher(label: string): string {
  return process.platform === "win32" ? `${label}\r\n` : `#!/bin/sh\n# ${label}\nexit 0\n`;
}

function processState(pid: number): string {
  if (!psPath) throw new Error("/bin/ps is required for process-state assertions");
  const result = spawnSync(psPath, ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
  if (result.error || typeof result.stdout !== "string") {
    throw new Error(`/bin/ps failed during process-state assertion: ${String(result.error ?? "missing stdout")}`);
  }
  return result.stdout.trim();
}

function obsoleteUnixShim(current: string): string {
  const obsolete = current.replace(`# ${UNIX_SHIM_REVISION_MARKER}\n`, "");
  expect(obsolete).not.toBe(current);
  return obsolete;
}

function waitForProcessStop(pid: number, timeoutMs = 1_000): string {
  const deadline = Date.now() + timeoutMs;
  const waiter = new Int32Array(new SharedArrayBuffer(4));
  let state = processState(pid);
  while (state !== "" && !state.startsWith("Z") && Date.now() < deadline) {
    Atomics.wait(waiter, 0, 0, 10);
    state = processState(pid);
  }
  return state;
}

function expectProcessGroupMissing(groupId: number): void {
  let code: string | undefined;
  try {
    process.kill(-groupId, 0);
  } catch (error) {
    code = (error as NodeJS.ErrnoException).code;
  }
  expect(code).toBe("ESRCH");
}

function withInstalledShim(run: (paths: {
  binDir: string;
  home: string;
  wrappers: string[];
  backups: string[];
  statePath: string;
}) => void): void {
  const binDir = mkdtempSync(join(tmpdir(), "ocx-shim-bin-"));
  const home = mkdtempSync(join(tmpdir(), "ocx-shim-home-"));
  const oldPath = process.env.PATH;
  const oldHome = process.env.OPENCODEX_HOME;
  const wrappers = process.platform === "win32"
    ? [join(binDir, "codex.cmd"), join(binDir, "codex.ps1"), join(binDir, "codex")]
    : [join(binDir, "codex")];
  try {
    process.env.PATH = prependPath(binDir, oldPath);
    process.env.OPENCODEX_HOME = home;
    for (const wrapper of wrappers) {
      writeFileSync(wrapper, process.platform === "win32" ? `real ${wrapper}\n` : "#!/bin/sh\necho real\n", "utf8");
      if (process.platform !== "win32") chmodSync(wrapper, 0o755);
    }
    expect(installCodexShim().installed).toBe(true);
    const statePath = join(home, "codex-shim.json");
    const state = JSON.parse(readFileSync(statePath, "utf8")) as { wrappers: Array<{ wrapperPath: string; backupPath: string }> };
    run({
      binDir,
      home,
      wrappers: state.wrappers.map(file => file.wrapperPath),
      backups: state.wrappers.map(file => file.backupPath),
      statePath,
    });
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = oldHome;
    rmSync(binDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

describe("Codex autostart shim", () => {
  test("builds a Unix shim that starts ocx before execing Codex", () => {
    const script = buildUnixCodexShim("/usr/local/bin/codex-real", "/usr/local/bin/bun", "/opt/opencodex/src/cli.ts", "bundled");

    expect(script).toContain(SHIM_MARKER);
    expect(script).toContain("ensure");
    expect(script).not.toContain("sync-cache");
    expect(script).toContain("exec '/usr/local/bin/codex-real' \"$@\"");
    expect(script).toContain("OPENCODEX_API_AUTH_TOKEN");
  });

  test("every shim flavor exports the Bun provenance it was built with (#848)", () => {
    // The shim reaches the daemon through `ocx ensure`, which inherits this env;
    // without it a Codex-autostarted service reports no provenance at all.
    const unix = buildUnixCodexShim("/usr/local/bin/codex-real", "/usr/local/bin/bun", "/opt/opencodex/src/cli.ts", "override", "/tmp/token");
    // Source and the binary it describes are stamped as a pair.
    expect(unix).toContain("OCX_BUN_RUNTIME_SOURCE='override' OCX_BUN_RUNTIME_PATH='/usr/local/bin/bun' '/usr/local/bin/bun' '/opt/opencodex/src/cli.ts' ensure");

    expect(buildWindowsCodexShim("C:\\Tools\\codex-real.exe", "C:\\Bun\\bun.exe", "C:\\ocx\\cli.ts", "override"))
      .toContain('set "OCX_BUN_RUNTIME_SOURCE=override"');

    expect(buildWindowsPowerShellCodexShim("C:\\Tools\\codex-real.exe", "C:\\Bun\\bun.exe", "C:\\ocx\\cli.ts", "process"))
      .toContain("$env:OCX_BUN_RUNTIME_SOURCE = 'process'");
  });

  test("the provenance marker never leaks into the real Codex process (#848 scoping)", () => {
    // A shim wraps `codex` itself, so an exported marker would be inherited by Codex
    // and everything it spawns. A shell beneath it running a DIFFERENT Bun directly
    // would then carry provenance describing a binary it is not executing, and the
    // execPath relaunch paths would preserve that contradiction into the daemon.
    const unix = buildUnixCodexShim("/usr/local/bin/codex-real", "/usr/local/bin/bun", "/cli.ts", "override");
    expect(unix).not.toContain("export OCX_BUN_RUNTIME_SOURCE");
    // The only occurrence is the one-shot assignment prefixed onto `ensure`.
    expect((unix.match(/OCX_BUN_RUNTIME_SOURCE/g) ?? []).length).toBe(1);
    expect((unix.match(/OCX_BUN_RUNTIME_PATH/g) ?? []).length).toBe(1);
    expect(unix.indexOf("OCX_BUN_RUNTIME_SOURCE")).toBeGreaterThan(unix.indexOf("ocx_subcommand"));

    // cmd.exe: set inside a setlocal/endlocal pair around `ensure` only.
    const cmd = buildWindowsCodexShim("C:\\codex-real.exe", "C:\\bun.exe", "C:\\cli.ts", "override");
    const ensureBlock = cmd.slice(cmd.indexOf(":ensure_ocx"), cmd.indexOf(":run_codex"));
    expect(ensureBlock).toContain("setlocal");
    expect(ensureBlock).toContain('set "OCX_BUN_RUNTIME_SOURCE=override"');
    expect(ensureBlock).toContain("endlocal");
    expect(ensureBlock).toContain("OCX_BUN_RUNTIME_PATH");
    expect((cmd.match(/OCX_BUN_RUNTIME_SOURCE/g) ?? []).length).toBe(1);
    expect((cmd.match(/OCX_BUN_RUNTIME_PATH/g) ?? []).length).toBe(1);

    // PowerShell: assigned around the ensure call and restored/removed afterwards.
    const ps = buildWindowsPowerShellCodexShim("C:\\codex-real.ps1", "C:\\bun.exe", "C:\\cli.ts", "override");
    expect(ps).toContain("$priorRuntimeSource = $env:OCX_BUN_RUNTIME_SOURCE");
    expect(ps).toContain("Remove-Item Env:\\OCX_BUN_RUNTIME_SOURCE");
    expect(ps).toContain("$env:OCX_BUN_RUNTIME_SOURCE = $priorRuntimeSource");
    expect(ps.indexOf("OCX_BUN_RUNTIME_SOURCE")).toBeGreaterThan(ps.indexOf("$skipEnsure"));
  });

  test("builds a Windows shim that starts ocx before running Codex", () => {
    const script = buildWindowsCodexShim("C:\\Tools\\codex-real.exe", "C:\\Bun\\bun.exe", "C:\\ocx\\cli.ts", "bundled");

    expect(script).toContain(SHIM_MARKER);
    expect(script).toContain("ensure");
    expect(script).not.toContain("sync-cache");
    expect(script).toContain('set "OCX_REAL_CODEX=C:\\Tools\\codex-real.exe"');
    expect(script).toContain('set "OCX_API_TOKEN_FILE=');
    expect(script).toContain('set /p OPENCODEX_API_AUTH_TOKEN=<"%OCX_API_TOKEN_FILE%"');
    expect(script).toContain('"%OCX_REAL_CODEX%" %*');
  });

  test("Windows cmd shim escapes executable paths through variables", () => {
    const script = buildWindowsCodexShim(
      "C:\\Tools&A\\100%codex^\\codex-real.exe",
      "C:\\Bun&Dir\\100%bun^\\bun.exe",
      "C:\\ocx&Dir\\cli.ts",
      "bundled",
    );

    expect(script).toContain('set "OCX_REAL_CODEX=C:\\Tools&A\\100%%codex^^\\codex-real.exe"');
    expect(script).toContain('set "OCX_BUN=C:\\Bun&Dir\\100%%bun^^\\bun.exe"');
    expect(script).toContain('set "OCX_CLI=C:\\ocx&Dir\\cli.ts"');
    expect(script).toContain('"%OCX_BUN%" "%OCX_CLI%" ensure >nul 2>nul');
    expect(script).not.toContain('"C:\\Bun&Dir\\100%bun^\\bun.exe"');
    expect(script).not.toContain('"C:\\Tools&A\\100%codex^\\codex-real.exe" %*');
  });

  test("Windows cmd shim rewrites profile paths to env indirection (OEM-codepage batch parsing vs non-ASCII usernames)", () => {
    const oldUserProfile = process.env.USERPROFILE;
    const oldAppData = process.env.APPDATA;
    try {
      process.env.USERPROFILE = "C:\\Users\\한글사용자";
      process.env.APPDATA = "C:\\Users\\한글사용자\\AppData\\Roaming";
      const script = buildWindowsCodexShim(
        "C:\\Users\\한글사용자\\AppData\\Roaming\\npm\\codex.opencodex-real.cmd",
        "C:\\Users\\한글사용자\\AppData\\Roaming\\npm\\node_modules\\bun\\bin\\bun.exe",
        "C:\\Users\\한글사용자\\AppData\\Roaming\\npm\\node_modules\\opencodex\\src\\cli.ts",
        "bundled",
      );

      expect(script).toContain('set "OCX_REAL_CODEX=%APPDATA%\\npm\\codex.opencodex-real.cmd"');
      expect(script).toContain('set "OCX_BUN=%APPDATA%\\npm\\node_modules\\bun\\bin\\bun.exe"');
      expect(script).not.toContain("한글사용자");
      // No chcp in the shim: it runs in the USER's console and must not leak a codepage change.
      expect(script).not.toContain("chcp");
    } finally {
      if (oldUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = oldUserProfile;
      if (oldAppData === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = oldAppData;
    }
  });

  test("PowerShell shim is written with a UTF-8 BOM (Windows PowerShell 5.1 decodes BOM-less ps1 as ANSI)", async () => {
    const source = readFileSync(join(import.meta.dir, "..", "src", "codex", "shim.ts"), "utf8");

    expect(source).toContain("`\\uFEFF${buildWindowsPowerShellCodexShim(realCodexPath, bun, cli, bunRuntimeSource)}`");
  });

  test("Windows target discovery includes the extensionless Git-Bash launcher and writeShim emits a forward-slash sh shim for it", () => {
    const source = readFileSync(join(import.meta.dir, "..", "src", "codex", "shim.ts"), "utf8");

    expect(source).toContain('const gitBashLauncher = join(dir, "codex");');
    expect(source).toContain("for (const path of [cmd, ps1, gitBashLauncher])");
    expect(source).toContain("buildUnixCodexShim(gitBashPath(realCodexPath), gitBashPath(bun), gitBashPath(cli), bunRuntimeSource, gitBashPath(serviceApiTokenFilePath()))");
  });

  test("Unix shim accepts an injected token-file path (Git-Bash shims need forward slashes everywhere)", () => {
    const script = buildUnixCodexShim(
      "C:/Users/한글사용자/AppData/Roaming/npm/codex.opencodex-real",
      "C:/Users/한글사용자/AppData/Roaming/npm/node_modules/bun/bin/bun.exe",
      "C:/Users/한글사용자/AppData/Roaming/npm/node_modules/opencodex/src/cli.ts",
      "bundled",
      "C:/Users/한글사용자/.opencodex/service-api-token",
    );

    expect(script).toContain("exec 'C:/Users/한글사용자/AppData/Roaming/npm/codex.opencodex-real' \"$@\"");
    expect(script).toContain("[ -f 'C:/Users/한글사용자/.opencodex/service-api-token' ]");
    expect(script).not.toContain("\\\\");
  });

  test("shim builder output contains the marker that isShim() checks", () => {
    const unix = buildUnixCodexShim("/bin/codex", "/bin/bun", "/cli.ts", "bundled");
    const win = buildWindowsCodexShim("C:\\codex.exe", "C:\\bun.exe", "C:\\cli.ts", "bundled");

    const dir = mkdtempSync(join(tmpdir(), "ocx-shim-test-"));
    const unixPath = join(dir, "codex-shim");
    const winPath = join(dir, "codex-shim.cmd");

    writeFileSync(unixPath, unix, "utf8");
    writeFileSync(winPath, win, "utf8");

    expect(readFileSync(unixPath, "utf8")).toContain(SHIM_MARKER);
    expect(readFileSync(winPath, "utf8")).toContain(SHIM_MARKER);
  });

  test("non-shim file does not contain the marker", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-shim-test-"));
    const fakeBinary = join(dir, "codex");
    writeFileSync(fakeBinary, "#!/bin/sh\necho hello\n", "utf8");

    expect(readFileSync(fakeBinary, "utf8")).not.toContain(SHIM_MARKER);
  });

  test("Unix shim uses bypass env var to skip proxy start", () => {
    const script = buildUnixCodexShim("/bin/codex", "/bin/bun", "/cli.ts", "bundled");
    expect(script).toContain("OCX_SHIM_BYPASS");
  });

  test("Unix shim stops same-process re-entry through a dynamic launcher", () => {
    if (process.platform === "win32") return;

    const dir = mkdtempSync(join(tmpdir(), "ocx-shim-reentry-"));
    const bunPath = join(dir, "bun");
    const misePath = join(dir, "mise");
    const realCodexPath = join(dir, "codex.opencodex-real");
    const shimPath = join(dir, "codex");
    try {
      writeFileSync(bunPath, "#!/usr/bin/env sh\nexit 0\n", "utf8");
      writeFileSync(misePath, `#!/usr/bin/env sh
if [ "$1" = exec ] && [ "$2" = -- ] && [ "$3" = codex ]; then
  shift 3
  exec codex "$@"
fi
exit 64
`, "utf8");
      writeFileSync(realCodexPath, `#!/usr/bin/env sh\nexec "${misePath}" exec -- codex "$@"\n`, "utf8");
      writeFileSync(shimPath, buildUnixCodexShim(realCodexPath, bunPath, "/cli.ts", "bundled"), "utf8");
      chmodSync(bunPath, 0o755);
      chmodSync(misePath, 0o755);
      chmodSync(realCodexPath, 0o755);
      chmodSync(shimPath, 0o755);
      const env = shimChildEnv({ PATH: prependPath(dir, process.env.PATH) ?? "", OCX_SHIM_BYPASS: "1" });

      const result = spawnSync(shimPath, ["--help"], {
        encoding: "utf8",
        env,
        timeout: 4_000,
      });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(126);
      expect(result.stderr).toContain("saved Codex launcher resolved back to the autostart shim");
      expect(result.stderr).toContain("ocx codex-shim uninstall");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Unix install rejects a recursive dynamic launcher and restores the original", () => {
    if (process.platform === "win32") return;

    const binDir = mkdtempSync(join(tmpdir(), "ocx-shim-install-reentry-bin-"));
    const home = mkdtempSync(join(tmpdir(), "ocx-shim-install-reentry-home-"));
    const oldPath = process.env.PATH;
    const oldHome = process.env.OPENCODEX_HOME;
    const codexPath = join(binDir, "codex");
    const misePath = join(binDir, "mise");
    const original = `#!/bin/sh\nexec "${misePath}" exec -- codex "$@"\n`;
    try {
      process.env.PATH = prependPath(binDir, oldPath);
      process.env.OPENCODEX_HOME = home;
      writeFileSync(misePath, `#!/bin/sh
if [ "$1" = exec ] && [ "$2" = -- ] && [ "$3" = codex ]; then
  shift 3
  exec codex "$@"
fi
exit 64
`, "utf8");
      writeFileSync(codexPath, original, "utf8");
      chmodSync(misePath, 0o755);
      chmodSync(codexPath, 0o755);

      const installed = installCodexShim();

      expect(installed.installed).toBe(false);
      expect(installed.message).toContain("saved launcher resolved back to the generated shim");
      expect(installed.message).toContain("original launcher was restored");
      expect(readFileSync(codexPath, "utf8")).toBe(original);
      expect(existsSync(`${codexPath}.opencodex-real`)).toBe(false);
      expect(existsSync(join(home, "codex-shim.json"))).toBe(false);
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      if (oldHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = oldHome;
      rmSync(binDir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("Unix runtime guard stops argument-dependent child-process redispatch", () => {
    if (process.platform === "win32") return;

    const binDir = mkdtempSync(join(tmpdir(), "ocx-shim-runtime-child-reentry-bin-"));
    const home = mkdtempSync(join(tmpdir(), "ocx-shim-runtime-child-reentry-home-"));
    const oldPath = process.env.PATH;
    const oldHome = process.env.OPENCODEX_HOME;
    const codexPath = join(binDir, "codex");
    const original = `#!/bin/sh
if [ "$1" = "--version" ]; then
  exit 0
fi
codex "$@"
`;
    try {
      process.env.PATH = prependPath(binDir, oldPath);
      process.env.OPENCODEX_HOME = home;
      writeFileSync(codexPath, original, "utf8");
      chmodSync(codexPath, 0o755);

      expect(installCodexShim().installed).toBe(true);

      const result = spawnSync(codexPath, ["--help"], {
        encoding: "utf8",
        env: { ...process.env, OCX_SHIM_BYPASS: "1" },
        timeout: 3_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(126);
      expect(result.stderr).toContain("saved Codex launcher resolved back to the autostart shim");
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      if (oldHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = oldHome;
      rmSync(binDir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("Unix install drains an immediate recursive diagnostic before classifying the probe", () => {
    if (process.platform === "win32") return;

    const binDir = mkdtempSync(join(tmpdir(), "ocx-shim-install-immediate-reentry-bin-"));
    const home = mkdtempSync(join(tmpdir(), "ocx-shim-install-immediate-reentry-home-"));
    const oldPath = process.env.PATH;
    const oldHome = process.env.OPENCODEX_HOME;
    const codexPath = join(binDir, "codex");
    const original = `#!/bin/sh
printf '%s\\n' 'opencodex: saved Codex launcher resolved back to the autostart shim; run ocx codex-shim uninstall and reinstall Codex before enabling codexAutoStart.' >&2
exit 126
`;
    try {
      process.env.PATH = prependPath(binDir, oldPath);
      process.env.OPENCODEX_HOME = home;
      writeFileSync(codexPath, original, "utf8");
      chmodSync(codexPath, 0o755);

      const installed = installCodexShim();

      expect(installed.installed).toBe(false);
      expect(installed.message).toContain("saved launcher resolved back to the generated shim");
      expect(readFileSync(codexPath, "utf8")).toBe(original);
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      if (oldHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = oldHome;
      rmSync(binDir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32" || !existsSync("/bin/dash"))(
    "Unix install accepts a valid launcher when the probe shell is dash",
    () => {
      const binDir = mkdtempSync(join(tmpdir(), "ocx-shim-install-dash-bin-"));
      const home = mkdtempSync(join(tmpdir(), "ocx-shim-install-dash-home-"));
      const oldPath = process.env.PATH;
      const oldHome = process.env.OPENCODEX_HOME;
      const codexPath = join(binDir, "codex");
      try {
        process.env.PATH = prependPath(binDir, oldPath);
        process.env.OPENCODEX_HOME = home;
        writeFileSync(codexPath, successfulLauncher("dash-valid-launcher"), "utf8");
        chmodSync(codexPath, 0o755);
        setCodexShimProbeShellForTests("/bin/dash");

        const installed = installCodexShim();

        expect(installed.installed).toBe(true);
        expect(readFileSync(codexPath, "utf8")).toContain(SHIM_MARKER);
        expect(readFileSync(`${codexPath}.opencodex-real`, "utf8")).toBe(successfulLauncher("dash-valid-launcher"));
        expect(existsSync(join(home, "codex-shim.json"))).toBe(true);
      } finally {
        setCodexShimProbeShellForTests(null);
        if (oldPath === undefined) delete process.env.PATH;
        else process.env.PATH = oldPath;
        if (oldHome === undefined) delete process.env.OPENCODEX_HOME;
        else process.env.OPENCODEX_HOME = oldHome;
        rmSync(binDir, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
      }
    },
  );

  test("Unix install honors the injected probe shell path", () => {
    if (process.platform === "win32") return;

    const binDir = mkdtempSync(join(tmpdir(), "ocx-shim-install-missing-shell-bin-"));
    const home = mkdtempSync(join(tmpdir(), "ocx-shim-install-missing-shell-home-"));
    const oldPath = process.env.PATH;
    const oldHome = process.env.OPENCODEX_HOME;
    const codexPath = join(binDir, "codex");
    const original = successfulLauncher("missing-probe-shell");
    try {
      process.env.PATH = prependPath(binDir, oldPath);
      process.env.OPENCODEX_HOME = home;
      writeFileSync(codexPath, original, "utf8");
      chmodSync(codexPath, 0o755);
      setCodexShimProbeShellForTests(join(binDir, "does-not-exist"));

      const installed = installCodexShim();

      expect(installed.installed).toBe(false);
      expect(readFileSync(codexPath, "utf8")).toBe(original);
      expect(existsSync(`${codexPath}.opencodex-real`)).toBe(false);
    } finally {
      setCodexShimProbeShellForTests(null);
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      if (oldHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = oldHome;
      rmSync(binDir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32" || !existsSync("/usr/bin/true"))(
    "Unix install probes a concrete native executable through the generated wrapper",
    () => {
      const binDir = mkdtempSync(join(tmpdir(), "ocx-shim-install-native-bin-"));
      const home = mkdtempSync(join(tmpdir(), "ocx-shim-install-native-home-"));
      const oldPath = process.env.PATH;
      const oldHome = process.env.OPENCODEX_HOME;
      const codexPath = join(binDir, "codex");
      try {
        process.env.PATH = prependPath(binDir, oldPath);
        process.env.OPENCODEX_HOME = home;
        copyFileSync("/usr/bin/true", codexPath);
        chmodSync(codexPath, 0o755);

        const installed = installCodexShim();

        expect(installed.installed).toBe(true);
        expect(readFileSync(codexPath, "utf8")).toContain(SHIM_MARKER);
        expect(lstatSync(`${codexPath}.opencodex-real`).isFile()).toBe(true);
      } finally {
        if (oldPath === undefined) delete process.env.PATH;
        else process.env.PATH = oldPath;
        if (oldHome === undefined) delete process.env.OPENCODEX_HOME;
        else process.env.OPENCODEX_HOME = oldHome;
        rmSync(binDir, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform === "win32" || !existsSync("/usr/bin/true"))(
    "Unix install probes a symlinked native executable through the generated wrapper",
    () => {
      const binDir = mkdtempSync(join(tmpdir(), "ocx-shim-install-native-link-bin-"));
      const home = mkdtempSync(join(tmpdir(), "ocx-shim-install-native-link-home-"));
      const oldPath = process.env.PATH;
      const oldHome = process.env.OPENCODEX_HOME;
      const codexPath = join(binDir, "codex");
      try {
        process.env.PATH = prependPath(binDir, oldPath);
        process.env.OPENCODEX_HOME = home;
        symlinkSync("/usr/bin/true", codexPath);

        const installed = installCodexShim();

        expect(installed.installed).toBe(true);
        expect(readFileSync(codexPath, "utf8")).toContain(SHIM_MARKER);
        expect(lstatSync(`${codexPath}.opencodex-real`).isSymbolicLink()).toBe(true);
      } finally {
        if (oldPath === undefined) delete process.env.PATH;
        else process.env.PATH = oldPath;
        if (oldHome === undefined) delete process.env.OPENCODEX_HOME;
        else process.env.OPENCODEX_HOME = oldHome;
        rmSync(binDir, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
      }
    },
  );

  test("Unix install rejects a launcher that leaves a background descendant", () => {
    if (process.platform === "win32") return;

    const binDir = mkdtempSync(join(tmpdir(), "ocx-shim-install-child-reentry-bin-"));
    const home = mkdtempSync(join(tmpdir(), "ocx-shim-install-child-reentry-home-"));
    const oldPath = process.env.PATH;
    const oldHome = process.env.OPENCODEX_HOME;
    const codexPath = join(binDir, "codex");
    const childPidPath = join(home, "background-child.pid");
    const groupIdPath = join(home, "background-child-group.pid");
    const original = `#!/bin/sh
/bin/sleep 30 &
child=$!
printf '%s\\n' "$child" > "${childPidPath}"
printf '%s\\n' "$$" > "${groupIdPath}"
exit 0
`;
    try {
      process.env.PATH = prependPath(binDir, oldPath);
      process.env.OPENCODEX_HOME = home;
      writeFileSync(codexPath, original, "utf8");
      chmodSync(codexPath, 0o755);

      const installed = installCodexShim();

      expect(installed.installed).toBe(false);
      expect(installed.message).toContain("left background descendants running after --version");
      expect(readFileSync(codexPath, "utf8")).toBe(original);
      expect(existsSync(`${codexPath}.opencodex-real`)).toBe(false);
      expect(existsSync(join(home, "codex-shim.json"))).toBe(false);
      const childPid = Number.parseInt(readFileSync(childPidPath, "utf8").trim(), 10);
      const groupId = Number.parseInt(readFileSync(groupIdPath, "utf8").trim(), 10);
      expectProcessGroupMissing(groupId);
      const childState = processState(childPid);
      expect(childState === "" || childState.startsWith("Z")).toBe(true);
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      if (oldHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = oldHome;
      rmSync(binDir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32" || !python3Path)(
    "Unix install rejects delayed detached redispatch after the launcher closes its lease fd",
    () => {
      const binDir = mkdtempSync(join(tmpdir(), "ocx-shim-install-detached-reentry-bin-"));
      const home = mkdtempSync(join(tmpdir(), "ocx-shim-install-detached-reentry-home-"));
      const oldPath = process.env.PATH;
      const oldHome = process.env.OPENCODEX_HOME;
      const codexPath = join(binDir, "codex");
      const childPidPath = join(home, "detached-reentry.pid");
      const original = `#!${python3Path}
import os
import time
os.close(3)
pid = os.fork()
if pid == 0:
    os.setsid()
    stderr_fd = os.open(os.devnull, os.O_WRONLY)
    os.dup2(stderr_fd, 2)
    os.close(stderr_fd)
    time.sleep(0.5)
    os.execvpe("codex", ["codex", "--version"], os.environ)
with open(${JSON.stringify(childPidPath)}, "w", encoding="utf-8") as handle:
    handle.write(str(pid))
os._exit(0)
`;
      try {
        process.env.PATH = prependPath(binDir, oldPath);
        process.env.OPENCODEX_HOME = home;
        setCodexShimProbeObservationMsForTests(1_500);
        writeFileSync(codexPath, original, "utf8");
        chmodSync(codexPath, 0o755);

        const installed = installCodexShim();

        expect(installed.installed).toBe(false);
        expect(installed.message).toContain("saved launcher resolved back to the generated shim");
        expect(readFileSync(codexPath, "utf8")).toBe(original);
        expect(existsSync(`${codexPath}.opencodex-real`)).toBe(false);
        expect(existsSync(join(home, "codex-shim.json"))).toBe(false);
        const childPid = Number.parseInt(readFileSync(childPidPath, "utf8"), 10);
        const childState = waitForProcessStop(childPid);
        expect(childState === "" || childState.startsWith("Z")).toBe(true);
      } finally {
        setCodexShimProbeObservationMsForTests(20);
        if (oldPath === undefined) delete process.env.PATH;
        else process.env.PATH = oldPath;
        if (oldHome === undefined) delete process.env.OPENCODEX_HOME;
        else process.env.OPENCODEX_HOME = oldHome;
        rmSync(binDir, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
      }
    },
  );

  test("Unix install rolls back when launcher validation times out", () => {
    if (process.platform === "win32") return;

    const binDir = mkdtempSync(join(tmpdir(), "ocx-shim-install-timeout-bin-"));
    const home = mkdtempSync(join(tmpdir(), "ocx-shim-install-timeout-home-"));
    const oldPath = process.env.PATH;
    const oldHome = process.env.OPENCODEX_HOME;
    const codexPath = join(binDir, "codex");
    const childPidPath = join(home, "probe-child.pid");
    const groupIdPath = join(home, "probe-group.pid");
    const original = `#!/bin/sh
/bin/sleep 30 &
child=$!
printf '%s\\n' "$child" > "${childPidPath}"
printf '%s\\n' "$$" > "${groupIdPath}"
wait "$child"
`;
    try {
      process.env.PATH = prependPath(binDir, oldPath);
      process.env.OPENCODEX_HOME = home;
      writeFileSync(codexPath, original, "utf8");
      chmodSync(codexPath, 0o755);

      const installed = installCodexShim();

      expect(installed.installed).toBe(false);
      expect(installed.message).toContain("did not finish --version within 5000ms");
      expect(installed.message).toContain("original launcher was restored");
      expect(readFileSync(codexPath, "utf8")).toBe(original);
      expect(existsSync(`${codexPath}.opencodex-real`)).toBe(false);
      expect(existsSync(join(home, "codex-shim.json"))).toBe(false);
      const childPid = Number.parseInt(readFileSync(childPidPath, "utf8").trim(), 10);
      const groupId = Number.parseInt(readFileSync(groupIdPath, "utf8").trim(), 10);
      expect(Number.isInteger(childPid)).toBe(true);
      expect(Number.isInteger(groupId)).toBe(true);
      expectProcessGroupMissing(groupId);
      const childState = processState(childPid);
      expect(childState === "" || childState.startsWith("Z")).toBe(true);
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      if (oldHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = oldHome;
      rmSync(binDir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  }, 10_000);

  test("Unix install preserves an existing backup without probing or mutation", () => {
    if (process.platform === "win32") return;

    const binDir = mkdtempSync(join(tmpdir(), "ocx-shim-install-backup-bin-"));
    const home = mkdtempSync(join(tmpdir(), "ocx-shim-install-backup-home-"));
    const oldPath = process.env.PATH;
    const oldHome = process.env.OPENCODEX_HOME;
    const codexPath = join(binDir, "codex");
    const backupPath = `${codexPath}.opencodex-real`;
    const original = "#!/bin/sh\nprintf '%s\\n' original\n";
    const backup = "#!/bin/sh\nprintf '%s\\n' preserved-backup\n";
    try {
      process.env.PATH = prependPath(binDir, oldPath);
      process.env.OPENCODEX_HOME = home;
      writeFileSync(codexPath, original, "utf8");
      writeFileSync(backupPath, backup, "utf8");
      chmodSync(codexPath, 0o755);
      chmodSync(backupPath, 0o755);

      const installed = installCodexShim();

      expect(installed).toEqual({ installed: false, message: `Refusing to overwrite existing backup: ${backupPath}` });
      expect(readFileSync(codexPath, "utf8")).toBe(original);
      expect(readFileSync(backupPath, "utf8")).toBe(backup);
      expect(existsSync(join(home, "codex-shim.json"))).toBe(false);
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      if (oldHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = oldHome;
      rmSync(binDir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("Unix install rolls back when the saved launcher fails its version probe", () => {
    if (process.platform === "win32") return;

    const binDir = mkdtempSync(join(tmpdir(), "ocx-shim-install-failed-bin-"));
    const home = mkdtempSync(join(tmpdir(), "ocx-shim-install-failed-home-"));
    const oldPath = process.env.PATH;
    const oldHome = process.env.OPENCODEX_HOME;
    const codexPath = join(binDir, "codex");
    const original = "#!/bin/sh\nexit 127\n";
    try {
      process.env.PATH = prependPath(binDir, oldPath);
      process.env.OPENCODEX_HOME = home;
      writeFileSync(codexPath, original, "utf8");
      chmodSync(codexPath, 0o755);

      const installed = installCodexShim();

      expect(installed.installed).toBe(false);
      expect(installed.message).toContain("saved launcher failed its --version probe");
      expect(readFileSync(codexPath, "utf8")).toBe(original);
      expect(existsSync(`${codexPath}.opencodex-real`)).toBe(false);
      expect(existsSync(join(home, "codex-shim.json"))).toBe(false);
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      if (oldHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = oldHome;
      rmSync(binDir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("Unix install rolls back when probe infrastructure throws", () => {
    if (process.platform === "win32") return;

    const binDir = mkdtempSync(join(tmpdir(), "ocx-shim-install-probe-error-bin-"));
    const home = mkdtempSync(join(tmpdir(), "ocx-shim-install-probe-error-home-"));
    const oldPath = process.env.PATH;
    const oldHome = process.env.OPENCODEX_HOME;
    const codexPath = join(binDir, "codex");
    const original = successfulLauncher("probe-error-original");
    try {
      process.env.PATH = prependPath(binDir, oldPath);
      process.env.OPENCODEX_HOME = home;
      writeFileSync(codexPath, original, "utf8");
      chmodSync(codexPath, 0o755);
      setCodexShimProbeHookForTests(() => { throw new Error("synthetic probe infrastructure failure"); });

      expect(() => installCodexShim()).toThrow("synthetic probe infrastructure failure");

      expect(readFileSync(codexPath, "utf8")).toBe(original);
      expect(existsSync(`${codexPath}.opencodex-real`)).toBe(false);
      expect(existsSync(join(home, "codex-shim.json"))).toBe(false);
    } finally {
      setCodexShimProbeHookForTests(null);
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      if (oldHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = oldHome;
      rmSync(binDir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("Unix fresh install removes its marker-bearing partial wrapper before rollback", () => {
    if (process.platform === "win32") return;

    const binDir = mkdtempSync(join(tmpdir(), "ocx-shim-install-partial-write-bin-"));
    const home = mkdtempSync(join(tmpdir(), "ocx-shim-install-partial-write-home-"));
    const oldPath = process.env.PATH;
    const oldHome = process.env.OPENCODEX_HOME;
    const codexPath = join(binDir, "codex");
    const original = successfulLauncher("partial-write-original");
    try {
      process.env.PATH = prependPath(binDir, oldPath);
      process.env.OPENCODEX_HOME = home;
      writeFileSync(codexPath, original, "utf8");
      chmodSync(codexPath, 0o755);
      setCodexShimFreshWriteHookForTests(() => {
        writeFileSync(codexPath, `#!/bin/sh\n# ${SHIM_MARKER}\n`, "utf8");
        throw new Error("synthetic fresh partial write failure");
      });

      expect(() => installCodexShim()).toThrow("synthetic fresh partial write failure");

      expect(readFileSync(codexPath, "utf8")).toBe(original);
      expect(existsSync(`${codexPath}.opencodex-real`)).toBe(false);
      expect(existsSync(join(home, "codex-shim.json"))).toBe(false);
    } finally {
      setCodexShimFreshWriteHookForTests(null);
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      if (oldHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = oldHome;
      rmSync(binDir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("Unix fresh install rolls an unprobeable original back into place", () => {
    if (process.platform === "win32") return;

    // #1625. An empty launcher is a legitimate thing for a user to own, and
    // stableShimPathProbe deliberately returns null at zero bytes because it
    // answers "does this look like a healthy shim". Recording the backup with
    // that probe therefore left movedOriginalFingerprint unset, and rollback —
    // which requires a matching fingerprint before it will restore — refused,
    // stranding the launcher at codex.opencodex-real. Identity is metadata, not
    // content, so the fingerprint must not depend on the file having bytes.
    const binDir = mkdtempSync(join(tmpdir(), "ocx-shim-install-unprobeable-bin-"));
    const home = mkdtempSync(join(tmpdir(), "ocx-shim-install-unprobeable-home-"));
    const oldPath = process.env.PATH;
    const oldHome = process.env.OPENCODEX_HOME;
    const codexPath = join(binDir, "codex");
    const backupPath = `${codexPath}.opencodex-real`;
    try {
      process.env.PATH = prependPath(binDir, oldPath);
      process.env.OPENCODEX_HOME = home;
      writeFileSync(codexPath, "", "utf8");
      chmodSync(codexPath, 0o755);
      setCodexShimFreshWriteHookForTests(() => {
        throw new Error("synthetic unprobeable-original rollback");
      });

      expect(() => installCodexShim()).toThrow("synthetic unprobeable-original rollback");

      // The launcher is back where the user had it, still empty and executable,
      // and no backup residue is left behind.
      expect(existsSync(codexPath)).toBe(true);
      expect(readFileSync(codexPath, "utf8")).toBe("");
      expect(lstatSync(codexPath).mode & 0o777).toBe(0o755);
      expect(existsSync(backupPath)).toBe(false);
      expect(existsSync(join(home, "codex-shim.json"))).toBe(false);
    } finally {
      setCodexShimFreshWriteHookForTests(null);
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      if (oldHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = oldHome;
      rmSync(binDir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("Unix rollback restore refuses to replace a launcher published in the restore window", () => {
    if (process.platform === "win32") return;

    // #1625 follow-up. sourceOccupied is sampled before the backup fingerprint
    // check, so a concurrent installer can still publish a launcher at the
    // original path afterwards. renameSync would silently delete it; the restore
    // uses link()+unlink(), which fails EEXIST instead. Only a hook inside that
    // window can reach this: publishing any earlier makes sourceOccupied true and
    // skips the restore branch entirely.
    const binDir = mkdtempSync(join(tmpdir(), "ocx-shim-restore-window-bin-"));
    const home = mkdtempSync(join(tmpdir(), "ocx-shim-restore-window-home-"));
    const oldPath = process.env.PATH;
    const oldHome = process.env.OPENCODEX_HOME;
    const codexPath = join(binDir, "codex");
    const backupPath = `${codexPath}.opencodex-real`;
    const original = successfulLauncher("restore-window-original");
    const intruder = successfulLauncher("restore-window-concurrent-installer");
    try {
      process.env.PATH = prependPath(binDir, oldPath);
      process.env.OPENCODEX_HOME = home;
      writeFileSync(codexPath, original, "utf8");
      chmodSync(codexPath, 0o755);
      setCodexShimFreshWriteHookForTests(() => {
        throw new Error("synthetic restore-window failure");
      });
      setCodexShimRollbackRestoreHookForTests(() => {
        writeFileSync(codexPath, intruder, "utf8");
        chmodSync(codexPath, 0o755);
      });

      expect(() => installCodexShim()).toThrow();

      // The competing launcher is untouched and the user's original is still
      // recoverable from the backup instead of having been overwritten.
      expect(readFileSync(codexPath, "utf8")).toBe(intruder);
      expect(existsSync(backupPath)).toBe(true);
      expect(readFileSync(backupPath, "utf8")).toBe(original);
      expect(existsSync(join(home, "codex-shim.json"))).toBe(false);
    } finally {
      setCodexShimFreshWriteHookForTests(null);
      setCodexShimRollbackRestoreHookForTests(null);
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      if (oldHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = oldHome;
      rmSync(binDir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("Unix fresh install preserves a concurrent wrapper replacement after a successful probe", () => {
    if (process.platform === "win32") return;

    const binDir = mkdtempSync(join(tmpdir(), "ocx-shim-install-concurrent-bin-"));
    const home = mkdtempSync(join(tmpdir(), "ocx-shim-install-concurrent-home-"));
    const oldPath = process.env.PATH;
    const oldHome = process.env.OPENCODEX_HOME;
    const codexPath = join(binDir, "codex");
    const concurrent = successfulLauncher("fresh concurrent updater replacement");
    const original = `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\\n' '#!/bin/sh' '# fresh concurrent updater replacement' 'exit 0' > "${codexPath}"
  chmod 755 "${codexPath}"
fi
exit 0
`;
    try {
      process.env.PATH = prependPath(binDir, oldPath);
      process.env.OPENCODEX_HOME = home;
      writeFileSync(codexPath, original, "utf8");
      chmodSync(codexPath, 0o755);

      const installed = installCodexShim();

      expect(installed.installed).toBe(false);
      expect(installed.message).toContain("generated wrapper changed during its validation probe");
      expect(readFileSync(codexPath, "utf8")).toBe(concurrent);
      // The backup is kept, not deleted: the source path is occupied by a file we
      // do not own, so this backup is the only copy of the user's real launcher.
      // A stray `codex.opencodex-real` is recoverable; a deleted launcher is not.
      expect(existsSync(`${codexPath}.opencodex-real`)).toBe(true);
      expect(existsSync(join(home, "codex-shim.json"))).toBe(false);
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      if (oldHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = oldHome;
      rmSync(binDir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("Unix fresh install refuses to adopt a wrapper replaced between the write and the fingerprint", () => {
    if (process.platform === "win32") return;

    // Ownership must come from the inode we staged, not from stat-ing the path
    // afterwards. A replacement that lands in that window carries the OpenCodex
    // markers by coincidence or by design; adopting it means our rollback later
    // unlinks an executable we never wrote.
    const binDir = mkdtempSync(join(tmpdir(), "ocx-shim-adopt-bin-"));
    const home = mkdtempSync(join(tmpdir(), "ocx-shim-adopt-home-"));
    const oldPath = process.env.PATH;
    const oldHome = process.env.OPENCODEX_HOME;
    const codexPath = join(binDir, "codex");
    const original = "#!/bin/sh\nexit 0\n";
    // Marker-bearing, so a marker/prefix check alone would happily adopt it.
    const intruder = `#!/bin/sh\n# ${SHIM_MARKER}\n# concurrent updater, not ours\nexit 0\n`;
    try {
      process.env.PATH = prependPath(binDir, oldPath);
      process.env.OPENCODEX_HOME = home;
      writeFileSync(codexPath, original, "utf8");
      chmodSync(codexPath, 0o755);

      setCodexShimFreshWriteHookForTests(() => {
        // Replace the destination the way a real updater does: write a new file
        // and rename it over ours, so the path now points at a different inode.
        // (A plain writeFileSync would truncate our inode in place, which is a
        // different situation — content tampering, not replacement.)
        const replacement = `${codexPath}.updater-tmp`;
        writeFileSync(replacement, intruder, "utf8");
        chmodSync(replacement, 0o755);
        renameSync(replacement, codexPath);
      });
      const installed = installCodexShim();

      expect(installed.installed).toBe(false);
      expect(installed.message).toContain("changed during its validation probe");
      // The replacement survives: it is not ours, so rollback must not unlink it.
      expect(readFileSync(codexPath, "utf8")).toBe(intruder);
      // The user's real launcher is preserved rather than deleted, because the
      // path is occupied by a file we do not own. A stray backup is recoverable;
      // a deleted launcher is not.
      expect(existsSync(`${codexPath}.opencodex-real`)).toBe(true);
      expect(readFileSync(`${codexPath}.opencodex-real`, "utf8")).toBe(original);
      // No install state is published for a refused install.
      expect(existsSync(join(home, "codex-shim.json"))).toBe(false);
      // No staging artifact leaked into the user's PATH directory.
      expect(readdirSync(binDir).filter(name => name.includes("opencodex-staging"))).toEqual([]);
    } finally {
      setCodexShimFreshWriteHookForTests(null);
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      if (oldHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = oldHome;
      rmSync(binDir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("Unix shim permits a real Codex process to start a new child invocation", () => {
    if (process.platform === "win32") return;

    const dir = mkdtempSync(join(tmpdir(), "ocx-shim-child-"));
    const bunPath = join(dir, "bun");
    const realCodexPath = join(dir, "codex.opencodex-real");
    const shimPath = join(dir, "codex");
    try {
      writeFileSync(bunPath, "#!/usr/bin/env sh\nexit 0\n", "utf8");
      writeFileSync(realCodexPath, `#!/usr/bin/env sh
if [ -z "$OCX_TEST_CHILD" ]; then
  OCX_TEST_CHILD=1
  export OCX_TEST_CHILD
  "${shimPath}" --version
  exit $?
fi
printf '%s\\n' child-codex
`, "utf8");
      writeFileSync(shimPath, buildUnixCodexShim(realCodexPath, bunPath, "/cli.ts", "bundled"), "utf8");
      chmodSync(bunPath, 0o755);
      chmodSync(realCodexPath, 0o755);
      chmodSync(shimPath, 0o755);
      const env = shimChildEnv({ OCX_SHIM_BYPASS: "1" });

      const result = spawnSync(shimPath, ["--help"], {
        encoding: "utf8",
        env,
        timeout: 2_000,
      });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("child-codex\n");
      expect(result.stderr).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Windows shim uses bypass env var to skip proxy start", () => {
    const script = buildWindowsCodexShim("C:\\codex.exe", "C:\\bun.exe", "C:\\cli.ts", "bundled");
    expect(script).toContain("OCX_SHIM_BYPASS");
  });

  test("PowerShell shim uses bypass env var to skip proxy start", () => {
    const script = buildWindowsPowerShellCodexShim("C:\\codex-real.ps1", "C:\\bun.exe", "C:\\cli.ts", "bundled");
    expect(script).toContain("OCX_SHIM_BYPASS");
    expect(script).toContain("Test-Path -LiteralPath");
    expect(script).toContain("OPENCODEX_API_AUTH_TOKEN");
    expect(script).toContain("& 'C:\\codex-real.ps1' @args");
  });

  test("Unix shim treats executable paths as literals instead of shell interpolation", () => {
    if (process.platform === "win32") return;

    const dir = mkdtempSync(join(tmpdir(), "ocx-shim-quote-"));
    const logPath = join(dir, "calls.log");
    const bunPath = join(dir, "bun-$(touch pwned)");
    const realCodexPath = join(dir, "codex-`touch real-pwned`");
    const cliPath = join(dir, "cli'path.ts");
    const shimPath = join(dir, "codex");

    writeFileSync(bunPath, `#!/usr/bin/env sh\necho "bun:$*" >> "${logPath}"\n`, "utf8");
    writeFileSync(realCodexPath, `#!/usr/bin/env sh\necho "codex:$*" >> "${logPath}"\n`, "utf8");
    writeFileSync(shimPath, buildUnixCodexShim(realCodexPath, bunPath, cliPath, "bundled"), "utf8");
    chmodSync(bunPath, 0o755);
    chmodSync(realCodexPath, 0o755);
    chmodSync(shimPath, 0o755);

    const result = spawnSync(shimPath, ["hello"], { cwd: dir, encoding: "utf8" });

    expect(result.status).toBe(0);
    expect(existsSync(join(dir, "pwned"))).toBe(false);
    expect(existsSync(join(dir, "real-pwned"))).toBe(false);
    expect(readFileSync(logPath, "utf8")).toContain(`bun:${cliPath} ensure`);
    expect(readFileSync(logPath, "utf8")).toContain("codex:hello");
  });

  test("Unix shim exports persisted service API token before running Codex", () => {
    if (process.platform === "win32") return;

    const dir = mkdtempSync(join(tmpdir(), "ocx-shim-token-"));
    const logPath = join(dir, "calls.log");
    const bunPath = join(dir, "bun");
    const realCodexPath = join(dir, "codex-real");
    const shimPath = join(dir, "codex");
    const oldHome = process.env.OPENCODEX_HOME;
    const oldToken = process.env.OPENCODEX_API_AUTH_TOKEN;
    try {
      process.env.OPENCODEX_HOME = dir;
      delete process.env.OPENCODEX_API_AUTH_TOKEN;
      writeFileSync(join(dir, "service-api-token"), "local-secret\n", "utf8");
      writeFileSync(bunPath, `#!/usr/bin/env sh\nexit 0\n`, "utf8");
      writeFileSync(realCodexPath, `#!/usr/bin/env sh\necho "token:$OPENCODEX_API_AUTH_TOKEN" >> "${logPath}"\n`, "utf8");
      writeFileSync(shimPath, buildUnixCodexShim(realCodexPath, bunPath, "/opt/opencodex/src/cli.ts", "bundled"), "utf8");
      chmodSync(bunPath, 0o755);
      chmodSync(realCodexPath, 0o755);
      chmodSync(shimPath, 0o755);

      const result = spawnSync(shimPath, ["doctor"], { cwd: dir, encoding: "utf8" });

      expect(result.status).toBe(0);
      expect(readFileSync(logPath, "utf8")).toBe("token:local-secret\n");
    } finally {
      if (oldHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = oldHome;
      if (oldToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
      else process.env.OPENCODEX_API_AUTH_TOKEN = oldToken;
    }
  });

  test("Unix shim skips ocx startup only for Codex management commands", () => {
    if (process.platform === "win32") return;

    const dir = mkdtempSync(join(tmpdir(), "ocx-shim-test-"));
    const logPath = join(dir, "calls.log");
    const bunPath = join(dir, "bun");
    const realCodexPath = join(dir, "codex-real");
    const shimPath = join(dir, "codex");

    writeFileSync(bunPath, `#!/usr/bin/env sh\necho "bun:$*" >> "${logPath}"\n`, "utf8");
    writeFileSync(realCodexPath, `#!/usr/bin/env sh\necho "codex:$*" >> "${logPath}"\n`, "utf8");
    writeFileSync(shimPath, buildUnixCodexShim(realCodexPath, bunPath, "/opt/opencodex/src/cli.ts", "bundled"), "utf8");
    chmodSync(bunPath, 0o755);
    chmodSync(realCodexPath, 0o755);
    chmodSync(shimPath, 0o755);
    const env = { ...process.env };
    delete env.OCX_SHIM_BYPASS;

    const doctor = spawnSync(shimPath, ["doctor"], { encoding: "utf8", env });
    expect(doctor.status).toBe(0);
    expect(readFileSync(logPath, "utf8")).toBe("codex:doctor\n");

    const flaggedAppServer = spawnSync(
      shimPath,
      ["-s", "read-only", "-a", "untrusted", "app-server"],
      { encoding: "utf8", env },
    );
    expect(flaggedAppServer.status).toBe(0);
    expect(readFileSync(logPath, "utf8")).toBe(
      "codex:doctor\ncodex:-s read-only -a untrusted app-server\n",
    );

    const exec = spawnSync(shimPath, ["exec", "hello"], { encoding: "utf8", env });
    expect(exec.status).toBe(0);
    expect(readFileSync(logPath, "utf8")).toBe(
      "codex:doctor\ncodex:-s read-only -a untrusted app-server\nbun:/opt/opencodex/src/cli.ts ensure\ncodex:exec hello\n",
    );

    const prompt = spawnSync(shimPath, ["hello"], { encoding: "utf8", env });
    expect(prompt.status).toBe(0);
    expect(readFileSync(logPath, "utf8")).toBe(
      "codex:doctor\ncodex:-s read-only -a untrusted app-server\nbun:/opt/opencodex/src/cli.ts ensure\ncodex:exec hello\nbun:/opt/opencodex/src/cli.ts ensure\ncodex:hello\n",
    );
  });

  test("Windows shim skips ocx startup only for Codex management commands", () => {
    const script = buildWindowsCodexShim("C:\\Tools\\codex-real.exe", "C:\\Bun\\bun.exe", "C:\\ocx\\cli.ts", "bundled");

    expect(script).toContain(':scan_codex_args');
    expect(script).toContain('if /I "%~1"=="-s" goto skip_option_value');
    expect(script).toContain('if /I "%~1"=="-a" goto skip_option_value');
    expect(script).toContain('if /I "%~1"=="app-server" goto run_codex');
    expect(script).toContain('if /I "%~1"=="doctor" goto run_codex');
    expect(script).not.toContain('if /I "%~1"=="exec" goto run_codex');
    expect(script).not.toContain('if /I "%~1"=="resume" goto run_codex');
    expect(script).not.toContain('if /I "%~1"=="review" goto run_codex');
    expect(script).toContain('if /I "%~1"=="--help" goto run_codex');
    expect(script).toContain('"%OCX_REAL_CODEX%" %*');
  });

  test("PowerShell shim scans past value-taking global options", () => {
    const script = buildWindowsPowerShellCodexShim("C:\\codex-real.ps1", "C:\\bun.exe", "C:\\cli.ts", "bundled");

    expect(script).toContain("$valueOptions = @(");
    expect(script).toContain("'-s'");
    expect(script).toContain("'-a'");
    expect(script).toContain("if ($skipNext)");
    expect(script).toContain("$internalCommands -contains $subcommand");
    expect(script).not.toContain("$firstArg");
  });

  test("Windows install backs up cmd, ps1, and the bare Git-Bash launcher", () => {
    if (process.platform !== "win32") return;

    const dir = mkdtempSync(join(tmpdir(), "ocx-shim-bin-"));
    const home = mkdtempSync(join(tmpdir(), "ocx-shim-home-"));
    const oldPath = process.env.PATH;
    const oldHome = process.env.OPENCODEX_HOME;
    const cmd = join(dir, "codex.cmd");
    const ps1 = join(dir, "codex.ps1");
    const bare = join(dir, "codex");
    const cmdOriginal = "@echo off\r\necho real cmd %*\r\n";
    const ps1Original = "Write-Output 'real ps1'\n";
    const bareOriginal = "#!/bin/sh\necho bare\n";

    try {
      process.env.PATH = dir;
      process.env.OPENCODEX_HOME = home;
      writeFileSync(cmd, cmdOriginal, "utf8");
      writeFileSync(ps1, ps1Original, "utf8");
      writeFileSync(bare, bareOriginal, "utf8");

      const installed = installCodexShim();

      expect(installed.installed).toBe(true);
      expect(readFileSync(cmd, "utf8")).toContain(SHIM_MARKER);
      expect(readFileSync(ps1, "utf8")).toContain(SHIM_MARKER);
      expect(readFileSync(bare, "utf8")).toContain(SHIM_MARKER);
      expect(readFileSync(join(dir, "codex.opencodex-real.cmd"), "utf8")).toBe(cmdOriginal);
      expect(readFileSync(join(dir, "codex.opencodex-real.ps1"), "utf8")).toBe(ps1Original);
      expect(readFileSync(join(dir, "codex.opencodex-real"), "utf8")).toBe(bareOriginal);

      const state = JSON.parse(readFileSync(join(home, "codex-shim.json"), "utf8"));
      expect(state.wrappers).toHaveLength(3);
      expect(diagnoseCodexShim()).toMatchObject({ installed: true, healthy: true });

      const removed = uninstallCodexShim();

      expect(removed.removed).toBe(true);
      expect(diagnoseCodexShim()).toMatchObject({ installed: false, healthy: false });
      expect(readFileSync(cmd, "utf8")).toBe(cmdOriginal);
      expect(readFileSync(ps1, "utf8")).toBe(ps1Original);
      expect(readFileSync(bare, "utf8")).toBe(bareOriginal);
    } finally {
      process.env.PATH = oldPath;
      if (oldHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = oldHome;
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("shim intact -> zero-overhead path is read-only and never loads config", () => {
    withInstalledShim(({ wrappers, backups, statePath }) => {
      const paths = [...wrappers, ...backups, statePath];
      const before = paths.map(path => ({
        path,
        bytes: readFileSync(path),
        mtimeMs: statSync(path).mtimeMs,
      }));
      let enabledCalls = 0;

      expect(autoRestoreCodexShim({
        enabled: () => {
          enabledCalls += 1;
          return true;
        },
      })).toEqual({ status: "healthy" });
      expect(enabledCalls).toBe(0);
      for (const snapshot of before) {
        expect(readFileSync(snapshot.path)).toEqual(snapshot.bytes);
        expect(statSync(snapshot.path).mtimeMs).toBe(snapshot.mtimeMs);
      }
    });
  });

  test("auto-restore upgrades an obsolete Unix shim and validates its saved launcher", () => {
    if (process.platform === "win32") return;
    withInstalledShim(({ wrappers, backups, statePath }) => {
      const current = readFileSync(wrappers[0], "utf8");
      const obsolete = obsoleteUnixShim(current);
      const oldBackup = readFileSync(backups[0]);
      const oldState = readFileSync(statePath);
      expect(obsolete).not.toBe(current);
      writeFileSync(wrappers[0], obsolete, "utf8");

      const result = autoRestoreCodexShim({ enabled: () => true, stabilitySleep: skipStabilityWait });

      expect(result.status).toBe("restored");
      expect(result.message).toContain("Upgraded Codex autostart shim");
      expect(readFileSync(wrappers[0], "utf8")).toContain(UNIX_SHIM_REVISION_MARKER);
      expect(readFileSync(backups[0])).toEqual(oldBackup);
      expect(readFileSync(statePath)).toEqual(oldState);
      expect(diagnoseCodexShim()).toMatchObject({ installed: true, healthy: true });
    });
  });

  test("manual install removes an obsolete Unix shim when its saved launcher recurses", () => {
    if (process.platform === "win32") return;
    withInstalledShim(({ binDir, wrappers, backups, statePath }) => {
      const current = readFileSync(wrappers[0], "utf8");
      const obsolete = obsoleteUnixShim(current);
      const dynamicLauncher = join(binDir, "obsolete-dynamic-launcher");
      const recursiveLauncher = `#!/bin/sh\nexec "${dynamicLauncher}" "$@"\n`;
      writeFileSync(dynamicLauncher, "#!/bin/sh\nexec codex \"$@\"\n", "utf8");
      writeFileSync(backups[0], recursiveLauncher, "utf8");
      writeFileSync(wrappers[0], obsolete, "utf8");
      chmodSync(dynamicLauncher, 0o755);
      chmodSync(backups[0], 0o755);

      const result = installCodexShim();

      expect(result.installed).toBe(false);
      expect(result.message).toContain("Removed an obsolete Codex autostart shim");
      expect(result.message).toContain("original launcher was restored");
      expect(readFileSync(wrappers[0], "utf8")).toBe(recursiveLauncher);
      expect(existsSync(backups[0])).toBe(false);
      expect(existsSync(statePath)).toBe(false);
      expect(diagnoseCodexShim()).toMatchObject({ installed: false, healthy: false });
    });
  });

  test("obsolete Unix shim upgrade rolls back when probe infrastructure throws", () => {
    if (process.platform === "win32") return;
    withInstalledShim(({ wrappers, backups, statePath }) => {
      const current = readFileSync(wrappers[0], "utf8");
      const obsolete = obsoleteUnixShim(current);
      const oldBackup = readFileSync(backups[0]);
      const oldState = readFileSync(statePath);
      writeFileSync(wrappers[0], obsolete, "utf8");
      setCodexShimProbeHookForTests(() => { throw new Error("synthetic obsolete upgrade probe failure"); });

      let failure: unknown;
      try {
        installCodexShim();
      } catch (error) {
        failure = error;
      } finally {
        setCodexShimProbeHookForTests(null);
      }

      expect(failure).toBeInstanceOf(AggregateError);
      expect(readFileSync(wrappers[0], "utf8")).toBe(obsolete);
      expect(readFileSync(backups[0])).toEqual(oldBackup);
      expect(readFileSync(statePath)).toEqual(oldState);
    });
  });

  test("obsolete Unix shim upgrade preserves a concurrent wrapper replacement", () => {
    if (process.platform === "win32") return;
    withInstalledShim(({ binDir, wrappers, backups, statePath }) => {
      const current = readFileSync(wrappers[0], "utf8");
      const obsolete = obsoleteUnixShim(current);
      const concurrent = successfulLauncher("obsolete upgrade concurrent replacement");
      const oldBackup = readFileSync(backups[0]);
      const oldState = readFileSync(statePath);
      writeFileSync(wrappers[0], obsolete, "utf8");
      setCodexShimProbeHookForTests(() => {
        writeFileSync(wrappers[0], concurrent, "utf8");
        chmodSync(wrappers[0], 0o755);
      });

      let result!: ReturnType<typeof autoRestoreCodexShim>;
      try {
        result = autoRestoreCodexShim({ enabled: () => true, stabilitySleep: skipStabilityWait });
      } finally {
        setCodexShimProbeHookForTests(null);
      }

      expect(result.status).toBe("deferred");
      expect("message" in result && result.message).toContain("upgrade deferred because tracked launchers changed");
      expect(readFileSync(wrappers[0], "utf8")).toBe(concurrent);
      expect(readFileSync(backups[0])).toEqual(oldBackup);
      expect(readFileSync(statePath)).toEqual(oldState);
      expect(readdirSync(binDir).some(name => name.includes(".upgrade-"))).toBe(false);
    });
  });

  test("stable shim replacement restores through the shared install transaction", () => {
    withInstalledShim(({ wrappers, backups }) => {
      const replacements = wrappers.map((wrapper, index) => successfulLauncher(`replacement-${index}`));
      wrappers.forEach((wrapper, index) => writeFileSync(wrapper, replacements[index], "utf8"));

      const result = autoRestoreCodexShim({ enabled: () => true, stabilitySleep: skipStabilityWait });

      expect(result.status).toBe("restored");
      wrappers.forEach(wrapper => expect(readFileSync(wrapper, "utf8")).toContain(SHIM_MARKER));
      backups.forEach((backup, index) => expect(readFileSync(backup, "utf8")).toBe(replacements[index]));
    });
  });

  test("guarded auto-restore rejects a recursive replacement and restores both launcher generations", () => {
    if (process.platform === "win32") return;
    withInstalledShim(({ binDir, wrappers, backups, statePath }) => {
      const dynamicLauncher = join(binDir, "dynamic-codex-launcher");
      const replacement = `#!/bin/sh\nexec "${dynamicLauncher}" "$@"\n`;
      const oldBackup = readFileSync(backups[0]);
      const oldState = readFileSync(statePath);
      writeFileSync(dynamicLauncher, "#!/bin/sh\nexec codex \"$@\"\n", "utf8");
      writeFileSync(wrappers[0], replacement, "utf8");
      chmodSync(dynamicLauncher, 0o755);
      chmodSync(wrappers[0], 0o755);

      const result = autoRestoreCodexShim({ enabled: () => true, stabilitySleep: skipStabilityWait });

      expect(result.status).toBe("deferred");
      expect(readFileSync(wrappers[0], "utf8")).toBe(replacement);
      expect(readFileSync(backups[0])).toEqual(oldBackup);
      expect(readFileSync(statePath)).toEqual(oldState);
    });
  });

  test("guarded auto-restore rejects a replacement that fails its version probe", () => {
    if (process.platform === "win32") return;
    withInstalledShim(({ wrappers, backups, statePath }) => {
      const replacement = "#!/bin/sh\nexit 127\n";
      const oldBackup = readFileSync(backups[0]);
      const oldState = readFileSync(statePath);
      writeFileSync(wrappers[0], replacement, "utf8");

      const result = autoRestoreCodexShim({ enabled: () => true, stabilitySleep: skipStabilityWait });

      expect(result.status).toBe("deferred");
      expect(readFileSync(wrappers[0], "utf8")).toBe(replacement);
      expect(readFileSync(backups[0])).toEqual(oldBackup);
      expect(readFileSync(statePath)).toEqual(oldState);
    });
  });

  test("guarded auto-restore rolls back when probe infrastructure throws", () => {
    if (process.platform === "win32") return;
    withInstalledShim(({ wrappers, backups, statePath }) => {
      const replacement = successfulLauncher("guarded-probe-error-replacement");
      const oldBackup = readFileSync(backups[0]);
      const oldState = readFileSync(statePath);
      writeFileSync(wrappers[0], replacement, "utf8");
      setCodexShimProbeHookForTests(() => { throw new Error("synthetic guarded probe failure"); });

      let failure: unknown;
      try {
        autoRestoreCodexShim({ enabled: () => true, stabilitySleep: skipStabilityWait });
      } catch (error) {
        failure = error;
      } finally {
        setCodexShimProbeHookForTests(null);
      }

      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors.map(error => String(error))).toContain("Error: synthetic guarded probe failure");
      expect(readFileSync(wrappers[0], "utf8")).toBe(replacement);
      expect(readFileSync(backups[0])).toEqual(oldBackup);
      expect(readFileSync(statePath)).toEqual(oldState);
    });
  });

  test("guarded auto-restore removes its unfingerprinted partial wrapper before rollback", () => {
    if (process.platform === "win32") return;
    withInstalledShim(({ wrappers, backups, statePath }) => {
      const replacement = successfulLauncher("guarded-partial-write-replacement");
      const oldBackup = readFileSync(backups[0]);
      const oldState = readFileSync(statePath);
      writeFileSync(wrappers[0], replacement, "utf8");
      setCodexShimGuardedWriteHookForTests(() => { throw new Error("synthetic failure after wrapper write"); });

      let failure: unknown;
      try {
        autoRestoreCodexShim({ enabled: () => true, stabilitySleep: skipStabilityWait });
      } catch (error) {
        failure = error;
      } finally {
        setCodexShimGuardedWriteHookForTests(null);
      }

      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors.map(error => String(error))).toContain("Error: synthetic failure after wrapper write");
      expect(readFileSync(wrappers[0], "utf8")).toBe(replacement);
      expect(readFileSync(backups[0])).toEqual(oldBackup);
      expect(readFileSync(statePath)).toEqual(oldState);
    });
  });

  test("guarded auto-restore preserves a concurrent wrapper replacement after a successful probe", () => {
    if (process.platform === "win32") return;
    withInstalledShim(({ binDir, wrappers, backups, statePath }) => {
      const concurrent = successfulLauncher("concurrent updater replacement");
      const replacement = `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\\n' '#!/bin/sh' '# concurrent updater replacement' 'exit 0' > "${wrappers[0]}"
  chmod 755 "${wrappers[0]}"
fi
exit 0
`;
      const oldBackup = readFileSync(backups[0]);
      const oldState = readFileSync(statePath);
      writeFileSync(wrappers[0], replacement, "utf8");

      const result = autoRestoreCodexShim({ enabled: () => true, stabilitySleep: skipStabilityWait });

      expect(result.status).toBe("deferred");
      expect(readFileSync(wrappers[0], "utf8")).toBe(concurrent);
      expect(readFileSync(backups[0])).toEqual(oldBackup);
      expect(readFileSync(statePath)).toEqual(oldState);
      expect(readdirSync(binDir).filter(name => name.includes(".autorestore-"))).toEqual([]);
    });
  });

  test("missing-wrapper repair preserves a concurrent replacement after a successful probe", () => {
    if (process.platform === "win32") return;
    withInstalledShim(({ wrappers, backups, statePath }) => {
      const concurrent = successfulLauncher("missing-wrapper concurrent replacement");
      const mutatingBackup = `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\\n' '#!/bin/sh' '# missing-wrapper concurrent replacement' 'exit 0' > "${wrappers[0]}"
  chmod 755 "${wrappers[0]}"
fi
exit 0
`;
      const oldState = readFileSync(statePath);
      writeFileSync(backups[0], mutatingBackup, "utf8");
      chmodSync(backups[0], 0o755);
      rmSync(wrappers[0], { force: true });

      const result = installCodexShim();

      expect(result.installed).toBe(false);
      expect(readFileSync(wrappers[0], "utf8")).toBe(concurrent);
      expect(readFileSync(backups[0], "utf8")).toBe(mutatingBackup);
      expect(readFileSync(statePath)).toEqual(oldState);
    });
  });

  test("direct refresh rejects a recursive replacement without replacing the owned backup", () => {
    if (process.platform === "win32") return;
    withInstalledShim(({ binDir, wrappers, backups, statePath }) => {
      const dynamicLauncher = join(binDir, "dynamic-codex-launcher");
      const replacement = `#!/bin/sh\nexec "${dynamicLauncher}" "$@"\n`;
      const oldBackup = readFileSync(backups[0]);
      const oldState = readFileSync(statePath);
      writeFileSync(dynamicLauncher, "#!/bin/sh\nexec codex \"$@\"\n", "utf8");
      writeFileSync(wrappers[0], replacement, "utf8");
      chmodSync(dynamicLauncher, 0o755);
      chmodSync(wrappers[0], 0o755);

      const result = installCodexShim();

      expect(result.installed).toBe(false);
      expect(result.message).toContain("Refusing to overwrite existing backup");
      expect(readFileSync(wrappers[0], "utf8")).toBe(replacement);
      expect(readFileSync(backups[0])).toEqual(oldBackup);
      expect(readFileSync(statePath)).toEqual(oldState);
    });
  });

  test("direct refresh rejects a replacement that fails its version probe", () => {
    if (process.platform === "win32") return;
    withInstalledShim(({ wrappers, backups, statePath }) => {
      const replacement = "#!/bin/sh\nexit 127\n";
      const oldBackup = readFileSync(backups[0]);
      const oldState = readFileSync(statePath);
      writeFileSync(wrappers[0], replacement, "utf8");

      const result = installCodexShim();

      expect(result.installed).toBe(false);
      expect(result.message).toContain("Refusing to overwrite existing backup");
      expect(readFileSync(wrappers[0], "utf8")).toBe(replacement);
      expect(readFileSync(backups[0])).toEqual(oldBackup);
      expect(readFileSync(statePath)).toEqual(oldState);
    });
  });

  test("direct refresh rolls back when probe infrastructure throws", () => {
    if (process.platform === "win32") return;
    withInstalledShim(({ wrappers, backups, statePath }) => {
      const replacement = successfulLauncher("direct-probe-error-replacement");
      const oldBackup = readFileSync(backups[0]);
      const oldState = readFileSync(statePath);
      writeFileSync(wrappers[0], replacement, "utf8");
      setCodexShimProbeHookForTests(() => { throw new Error("synthetic direct probe failure"); });

      let failure: unknown;
      try {
        installCodexShim();
      } catch (error) {
        failure = error;
      } finally {
        setCodexShimProbeHookForTests(null);
      }

      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors.map(error => String(error))).toContain("Error: synthetic direct probe failure");
      expect(readFileSync(wrappers[0], "utf8")).toBe(replacement);
      expect(readFileSync(backups[0])).toEqual(oldBackup);
      expect(readFileSync(statePath)).toEqual(oldState);
    });
  });

  test("direct refresh preserves a concurrent wrapper replacement after an unsafe probe", () => {
    if (process.platform === "win32") return;
    withInstalledShim(({ binDir, wrappers, backups, statePath }) => {
      const concurrent = successfulLauncher("concurrent unsafe updater replacement");
      const replacement = `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\\n' '#!/bin/sh' '# concurrent unsafe updater replacement' 'exit 0' > "${wrappers[0]}"
  chmod 755 "${wrappers[0]}"
fi
exit 127
`;
      const oldBackup = readFileSync(backups[0]);
      const oldState = readFileSync(statePath);
      writeFileSync(wrappers[0], replacement, "utf8");

      const result = installCodexShim();

      expect(result.installed).toBe(false);
      expect(readFileSync(wrappers[0], "utf8")).toBe(concurrent);
      expect(readFileSync(backups[0])).toEqual(oldBackup);
      expect(readFileSync(statePath)).toEqual(oldState);
      expect(readdirSync(binDir).filter(name => name.includes(".autorestore-"))).toEqual([]);
    });
  });

  test("an aged lock held by a live restore owner is never reclaimed", async () => {
    const binDir = mkdtempSync(join(tmpdir(), "ocx-shim-concurrent-bin-"));
    const home = mkdtempSync(join(tmpdir(), "ocx-shim-concurrent-home-"));
    const readyPath = join(home, "first-lock-ready");
    const releasePath = join(home, "release-first-lock");
    const restoreLockPath = join(home, "codex-shim.autorestore.lock");
    const wrapper = join(binDir, process.platform === "win32" ? "codex.cmd" : "codex");
    const backup = join(binDir, process.platform === "win32" ? "codex.opencodex-real.cmd" : "codex.opencodex-real");
    const replacement = successfulLauncher("concurrent replacement launcher");
    const oldPath = process.env.PATH;
    const oldHome = process.env.OPENCODEX_HOME;
    let first: ReturnType<typeof Bun.spawn> | undefined;
    try {
      process.env.PATH = binDir;
      process.env.OPENCODEX_HOME = home;
      writeFileSync(wrapper, process.platform === "win32" ? "@echo off\r\necho original\r\n" : "#!/bin/sh\necho original\n", "utf8");
      if (process.platform !== "win32") chmodSync(wrapper, 0o755);
      expect(installCodexShim().installed).toBe(true);
      writeFileSync(wrapper, replacement, "utf8");
      if (process.platform !== "win32") chmodSync(wrapper, 0o755);

      const shimModule = join(import.meta.dir, "..", "src", "codex", "shim.ts");
      const firstScript = `
        import { existsSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
        import { join } from "node:path";
        const { autoRestoreCodexShim, setCodexShimProbeObservationMsForTests } = await import(${JSON.stringify(shimModule)});
        setCodexShimProbeObservationMsForTests(20);
        const result = autoRestoreCodexShim({
          enabled: () => true,
          stabilitySleep: () => {},
          afterRestoreLockAcquired: () => {
            const ownerPath = join(${JSON.stringify(restoreLockPath)}, readdirSync(${JSON.stringify(restoreLockPath)})[0]);
            const held = JSON.parse(readFileSync(ownerPath, "utf8"));
            held.createdAt = 0;
            writeFileSync(ownerPath, JSON.stringify(held) + "\\n");
            utimesSync(ownerPath, new Date(0), new Date(0));
            writeFileSync(${JSON.stringify(readyPath)}, readFileSync(ownerPath));
            while (!existsSync(${JSON.stringify(releasePath)})) Bun.sleepSync(5);
          },
        });
        console.log(JSON.stringify(result));
      `;
      const secondScript = `
        const { autoRestoreCodexShim, setCodexShimProbeObservationMsForTests } = await import(${JSON.stringify(shimModule)});
        setCodexShimProbeObservationMsForTests(20);
        console.log(JSON.stringify(autoRestoreCodexShim({ enabled: () => true, stabilitySleep: () => {} })));
      `;
      const childEnv = { ...process.env, PATH: binDir, OPENCODEX_HOME: home };
      first = Bun.spawn([process.execPath, "-e", firstScript], {
        cwd: join(import.meta.dir, ".."),
        env: childEnv,
        stdout: "pipe",
        stderr: "pipe",
      });
      const deadline = Date.now() + 5_000;
      while (!existsSync(readyPath) && Date.now() < deadline) await Bun.sleep(5);
      expect(existsSync(readyPath)).toBe(true);

      const second = spawnSync(process.execPath, ["-e", secondScript], {
        cwd: join(import.meta.dir, ".."),
        env: childEnv,
        encoding: "utf8",
      });
      expect(second.status).toBe(0);
      expect(JSON.parse(second.stdout.trim())).toEqual({ status: "deferred" });
      const heldLock = JSON.parse(readFileSync(readyPath, "utf8")) as { pid?: number; token?: string };
      expect(heldLock.pid).toBe(first.pid);
      expect(heldLock.token).toBeString();

      writeFileSync(releasePath, "release", "utf8");
      expect(await first.exited).toBe(0);
      const firstStdout = await new Response(first.stdout).text();
      expect(JSON.parse(firstStdout.trim()).status).toBe("restored");
      expect(readFileSync(wrapper, "utf8")).toContain(SHIM_MARKER);
      expect(readFileSync(backup, "utf8")).toBe(replacement);
    } finally {
      try { writeFileSync(releasePath, "release", "utf8"); } catch { /* temp dir may already be gone */ }
      if (first) await first.exited;
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      if (oldHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = oldHome;
      rmSync(binDir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("stale-lock compare-and-delete never unlinks a successor lock", () => {
    withInstalledShim(({ home, wrappers, backups }) => {
      const lockPath = join(home, "codex-shim.autorestore.lock");
      const stalePath = join(lockPath, "stale-owner.json");
      const successorPath = join(lockPath, "successor-owner.json");
      const stale = JSON.stringify({ version: 1, token: "stale-owner", pid: 2_147_483_647, createdAt: 0 }) + "\n";
      const successor = JSON.stringify({ version: 1, token: "successor-owner", pid: process.pid, createdAt: Date.now() }) + "\n";
      const oldBackups = backups.map(path => readFileSync(path));
      wrappers.forEach((path, index) => writeFileSync(path, `replacement-${index}\n`, "utf8"));
      mkdirSync(lockPath);
      writeFileSync(stalePath, stale, "utf8");
      utimesSync(stalePath, new Date(0), new Date(0));

      const result = autoRestoreCodexShim({
        enabled: () => true,
        stabilitySleep: skipStabilityWait,
        beforeStaleRestoreLockDelete: () => {
          rmSync(lockPath, { recursive: true });
          mkdirSync(lockPath);
          writeFileSync(successorPath, successor, "utf8");
        },
      });

      expect(result).toEqual({ status: "deferred" });
      expect(readdirSync(lockPath)).toEqual(["successor-owner.json"]);
      expect(readFileSync(successorPath, "utf8")).toBe(successor);
      wrappers.forEach((path, index) => expect(readFileSync(path, "utf8")).toBe(`replacement-${index}\n`));
      backups.forEach((path, index) => expect(readFileSync(path)).toEqual(oldBackups[index]));
    });
  });

  test("an unchanged stale lock from a dead owner is reclaimed", () => {
    withInstalledShim(({ home, wrappers, backups }) => {
      const lockPath = join(home, "codex-shim.autorestore.lock");
      const ownerPath = join(lockPath, "dead-owner.json");
      const replacements = wrappers.map((_, index) => successfulLauncher(`dead-owner-replacement-${index}`));
      wrappers.forEach((path, index) => writeFileSync(path, replacements[index], "utf8"));
      mkdirSync(lockPath);
      writeFileSync(ownerPath, `${JSON.stringify({
        version: 1,
        token: "dead-owner",
        pid: 2_147_483_647,
        createdAt: 0,
      })}\n`, "utf8");
      utimesSync(ownerPath, new Date(0), new Date(0));

      const result = autoRestoreCodexShim({ enabled: () => true, stabilitySleep: skipStabilityWait });

      expect(result.status).toBe("restored");
      expect(existsSync(lockPath)).toBe(false);
      wrappers.forEach(path => expect(readFileSync(path, "utf8")).toContain(SHIM_MARKER));
      backups.forEach((path, index) => expect(readFileSync(path, "utf8")).toBe(replacements[index]));
    });
  });

  test("stalled partial write changing during the observation interval is never promoted", () => {
    withInstalledShim(({ wrappers, backups }) => {
      const oldBackups = backups.map(path => readFileSync(path));
      wrappers.forEach((wrapper, index) => writeFileSync(wrapper, `partial-${index}\n`, "utf8"));

      const result = autoRestoreCodexShim({
        enabled: () => true,
        stabilitySleep: () => writeFileSync(wrappers[0], "completed after stalled partial write\n", "utf8"),
      });

      expect(result).toEqual({ status: "deferred" });
      expect(readFileSync(wrappers[0], "utf8")).toBe("completed after stalled partial write\n");
      backups.forEach((backup, index) => expect(readFileSync(backup)).toEqual(oldBackups[index]));
    });
  });

  test("mixed launcher siblings defer the whole restore without piecemeal mutation", () => {
    withInstalledShim(({ binDir, wrappers, backups, statePath }) => {
      if (wrappers.length === 1) {
        const sibling = join(binDir, "codex.ps1");
        const siblingBackup = join(binDir, "codex.opencodex-real.ps1");
        writeFileSync(sibling, readFileSync(wrappers[0]));
        chmodSync(sibling, 0o755);
        writeFileSync(siblingBackup, "prior sibling launcher\n", "utf8");
        const state = JSON.parse(readFileSync(statePath, "utf8")) as {
          wrappers: Array<{ wrapperPath: string; originalPath: string; backupPath: string }>;
        };
        state.wrappers.push({ wrapperPath: sibling, originalPath: sibling, backupPath: siblingBackup });
        writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
        wrappers.push(sibling);
        backups.push(siblingBackup);
      }
      const oldBackups = backups.map(path => readFileSync(path));
      const healthySiblings = wrappers.slice(1).map(path => readFileSync(path));
      writeFileSync(wrappers[0], "one updated sibling\n", "utf8");

      const result = autoRestoreCodexShim({ enabled: () => true, stabilitySleep: skipStabilityWait });

      expect(result.status).toBe("deferred");
      expect(result.message).toContain("mixed shim/replacement state");
      expect(readFileSync(wrappers[0], "utf8")).toBe("one updated sibling\n");
      wrappers.slice(1).forEach((path, index) => expect(readFileSync(path)).toEqual(healthySiblings[index]));
      backups.forEach((path, index) => expect(readFileSync(path)).toEqual(oldBackups[index]));
    });
  });

  test("opt-out set -> no restore and explicit install remains available", () => {
    withInstalledShim(({ wrappers }) => {
      const replacements = wrappers.map((_, index) => successfulLauncher(`disabled-${index}`));
      wrappers.forEach((wrapper, index) => writeFileSync(wrapper, replacements[index], "utf8"));

      expect(autoRestoreCodexShim({ enabled: () => false, stabilitySleep: skipStabilityWait })).toEqual({ status: "disabled" });
      wrappers.forEach((wrapper, index) => expect(readFileSync(wrapper, "utf8")).toBe(replacements[index]));
      expect(installCodexShim().installed).toBe(true);
      wrappers.forEach(wrapper => expect(readFileSync(wrapper, "utf8")).toContain(SHIM_MARKER));
    });
  });

  test("fingerprint mismatch before guarded rename defers without owned-path mutation", () => {
    withInstalledShim(({ wrappers, backups, statePath }) => {
      wrappers.forEach((wrapper, index) => writeFileSync(wrapper, `candidate-${index}\n`, "utf8"));
      const oldBackups = backups.map(path => readFileSync(path));
      const oldState = readFileSync(statePath);

      const result = autoRestoreCodexShim({
        enabled: () => true,
        stabilitySleep: skipStabilityWait,
        beforeGuardedRefresh: (wrapperPath, index) => {
          if (index === 0) writeFileSync(wrapperPath, "concurrent replacement\n", "utf8");
        },
      });

      expect(result).toEqual({ status: "deferred" });
      expect(readFileSync(wrappers[0], "utf8")).toBe("concurrent replacement\n");
      backups.forEach((backup, index) => expect(readFileSync(backup)).toEqual(oldBackups[index]));
      expect(readFileSync(statePath)).toEqual(oldState);
    });
  });

  test("multi-wrapper restore rolls back when a later sibling fingerprint changes", () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-shim-transaction-home-"));
    const binDir = mkdtempSync(join(tmpdir(), "ocx-shim-transaction-bin-"));
    const oldHome = process.env.OPENCODEX_HOME;
    try {
      process.env.OPENCODEX_HOME = home;
      const wrappers = [join(binDir, "codex.cmd"), join(binDir, "codex.ps1")];
      const backups = [join(binDir, "codex.opencodex-real.cmd"), join(binDir, "codex.opencodex-real.ps1")];
      const wrapperBytes = ["replacement cmd\n", "replacement ps1\n"];
      const backupBytes = ["prior cmd\n", "prior ps1\n"];
      wrappers.forEach((path, index) => writeFileSync(path, wrapperBytes[index], "utf8"));
      backups.forEach((path, index) => writeFileSync(path, backupBytes[index], "utf8"));
      const statePath = join(home, "codex-shim.json");
      writeFileSync(statePath, JSON.stringify({
        platform: process.platform,
        wrapperPath: wrappers[0],
        originalPath: wrappers[0],
        backupPath: backups[0],
        wrappers: wrappers.map((wrapperPath, index) => ({
          wrapperPath,
          originalPath: wrapperPath,
          backupPath: backups[index],
        })),
      }, null, 2) + "\n", "utf8");
      const stateBytes = readFileSync(statePath);
      const modes = [...wrappers, ...backups].map(path => statSync(path).mode & 0o777);

      const result = autoRestoreCodexShim({
        enabled: () => true,
        stabilitySleep: skipStabilityWait,
        beforeGuardedRefresh: (wrapperPath, index) => {
          if (index === 1) {
            const originalMtime = statSync(wrapperPath).mtime;
            utimesSync(wrapperPath, originalMtime.getTime() / 1_000 - 1, originalMtime);
          }
        },
      });

      expect(result).toEqual({ status: "deferred" });
      wrappers.forEach((path, index) => expect(readFileSync(path, "utf8")).toBe(wrapperBytes[index]));
      backups.forEach((path, index) => expect(readFileSync(path, "utf8")).toBe(backupBytes[index]));
      expect(readFileSync(statePath)).toEqual(stateBytes);
      [...wrappers, ...backups].forEach((path, index) => expect(statSync(path).mode & 0o777).toBe(modes[index]));
      expect(readdirSync(binDir).filter(name => name.includes(".autorestore-"))).toEqual([]);
    } finally {
      if (oldHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = oldHome;
      rmSync(home, { recursive: true, force: true });
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  test("missing backup, missing wrapper, corrupt state, and platform mismatch never fresh-install", () => {
    withInstalledShim(({ wrappers, backups, statePath }) => {
      rmSync(backups[0]);
      expect(autoRestoreCodexShim({ enabled: () => true, stabilitySleep: skipStabilityWait }).status).toBe("ineligible");

      writeFileSync(backups[0], "backup\n", "utf8");
      rmSync(wrappers[0]);
      expect(autoRestoreCodexShim({ enabled: () => true, stabilitySleep: skipStabilityWait }).status).toBe("ineligible");

      if (process.platform !== "win32") {
        mkdirSync(wrappers[0]);
        expect(autoRestoreCodexShim({ enabled: () => true, stabilitySleep: skipStabilityWait }).status).toBe("deferred");
        rmSync(wrappers[0], { recursive: true });
        symlinkSync(join(dirname(wrappers[0]), "missing-target"), wrappers[0]);
        expect(autoRestoreCodexShim({ enabled: () => true, stabilitySleep: skipStabilityWait }).status).toBe("ineligible");
      }

      writeFileSync(statePath, "{broken", "utf8");
      expect(autoRestoreCodexShim({ enabled: () => true }).status).toBe("ineligible");

      const otherPlatform = process.platform === "win32" ? "linux" : "win32";
      writeFileSync(statePath, JSON.stringify({
        platform: otherPlatform,
        wrapperPath: wrappers[0],
        originalPath: wrappers[0],
        backupPath: backups[0],
      }), "utf8");
      expect(autoRestoreCodexShim({ enabled: () => true }).status).toBe("ineligible");
    });
  });
});

describe("WSL PATH interop guard", () => {
  const fakeFs = (files: string[]) => ({
    exists: (p: string) => files.includes(p),
    isShimFile: () => false,
    isDirectory: () => false,
  });

  test("isWindowsInteropDir matches /mnt drive prefixes only", () => {
    expect(isWindowsInteropDir("/mnt/c/Users/example/AppData/Roaming/npm")).toBe(true);
    expect(isWindowsInteropDir("/mnt/d")).toBe(true);
    expect(isWindowsInteropDir("/mnt/wsl")).toBe(false);
    expect(isWindowsInteropDir("/usr/local/bin")).toBe(false);
    expect(isWindowsInteropDir("/home/example/mnt/c")).toBe(false);
  });

  test("on WSL, a Windows codex reached via interop is skipped with guidance", () => {
    const interop = "/mnt/c/Users/example/AppData/Roaming/npm";
    const found = findCodexOnPath({
      pathValue: `/usr/local/bin:${interop}`,
      wsl: true,
      ...fakeFs([`${interop}/codex`, `${interop}/codex.exe`]),
    });
    expect(found).toBeNull();
    expect(lastCodexDiscoveryError()).toContain("WSL PATH interop");
    expect(lastCodexDiscoveryError()).toContain(`${interop}/codex`);
  });

  test("on WSL, a Linux-side codex is preferred and returned", () => {
    const interop = "/mnt/c/Users/example/AppData/Roaming/npm";
    const linuxBin = "/usr/local/bin";
    const found = findCodexOnPath({
      pathValue: `${interop}:${linuxBin}`,
      wsl: true,
      ...fakeFs([`${interop}/codex`, `${linuxBin}/codex`]),
    });
    expect(found).toBe(`${linuxBin}/codex`);
  });

  test("off WSL, /mnt-like dirs are scanned normally", () => {
    const dir = "/mnt/c/tools";
    const found = findCodexOnPath({
      pathValue: dir,
      wsl: false,
      posixPaths: true,
      ...fakeFs([`${dir}/codex`]),
    });
    expect(found).toBe(`${dir}/codex`);
  });
});

// #2412: a version-manager upgrade (mise/asdf/volta) rewrites its install tree
// in place, destroying both the shim and its sibling .opencodex-real backup.
// The bail was silent, and the CLI warns only when a message exists, so start /
// ensure / service repair all reported success while routing stayed native.
describe("version-manager shim destruction (#2412)", () => {
  test("classifies version-manager install trees without catching ordinary paths", () => {
    expect(isVersionManagerOwnedCodexPath("/home/u/.local/share/mise/installs/codex/latest/bin/codex")).toBe(true);
    expect(isVersionManagerOwnedCodexPath("/home/u/.local/share/mise/shims/codex")).toBe(true);
    expect(isVersionManagerOwnedCodexPath("/home/u/.asdf/installs/codex/1.0/bin/codex")).toBe(true);
    expect(isVersionManagerOwnedCodexPath("/home/u/.asdf/shims/codex")).toBe(true);
    expect(isVersionManagerOwnedCodexPath("/home/u/.volta/bin/codex")).toBe(true);
    expect(isVersionManagerOwnedCodexPath("C:\\Users\\u\\.volta\\bin\\codex.cmd", "win32")).toBe(true);
    expect(isVersionManagerOwnedCodexPath("/opt/plain\\.volta\\bin/codex", "linux")).toBe(false);
    expect(isVersionManagerOwnedCodexPath("/usr/local/bin/codex")).toBe(false);
    expect(isVersionManagerOwnedCodexPath("/home/u/.npm-global/bin/codex")).toBe(false);
    expect(isVersionManagerOwnedCodexPath("/opt/homebrew/bin/codex")).toBe(false);
  });

  test("a destroyed shim reports the paths instead of bailing silently", () => {
    withInstalledShim(({ wrappers, backups }) => {
      writeFileSync(wrappers[0], "#!/bin/sh\necho version-manager codex\n", "utf8");
      if (process.platform !== "win32") chmodSync(wrappers[0], 0o755);
      rmSync(backups[0]);
      const result = autoRestoreCodexShim({ enabled: () => true, stabilitySleep: skipStabilityWait });
      expect(result.status).toBe("ineligible");
      // The silent bail is the whole defect: cli/codex-shim-autorestore.ts warns
      // only when a message exists.
      expect(result.message).toBeTruthy();
      expect(result.message).toContain("backup");
    });
  });
});

describe("Codex shim read-only backing inspection", () => {
  test("local inspection paths reject Windows remote and device namespaces", () => {
    expect(isLocalAbsoluteInspectionPath("/usr/local/bin/codex", "linux")).toBe(true);
    expect(isLocalAbsoluteInspectionPath("C:\\OpenCodex\\codex.cmd", "win32")).toBe(true);
    for (const path of [
      "\\Windows\\codex.cmd",
      "/Windows/codex.cmd",
      "\\\\server\\share\\codex.cmd",
      "//server/share/codex.cmd",
      "\\\\?\\C:\\OpenCodex\\codex.cmd",
      "//?/C:/OpenCodex/codex.cmd",
      "\\\\.\\PhysicalDrive0",
    ]) {
      expect(isLocalAbsoluteInspectionPath(path, "win32")).toBe(false);
    }
    expect(isLocalAbsoluteInspectionPath("codex.cmd", "win32")).toBe(false);
  });

  test("Windows backing inspection fails closed before pathname access on every host", () => {
    expect(inspectCodexShimBackingForCommand(
      "C:\\remote-or-local\\codex.cmd",
      "win32",
      "C:\\OpenCodex",
    )).toEqual({
      status: "unknown",
      reason: "binding_unavailable",
    });
  });

  test.skipIf(process.platform === "win32")("selects only the recorded wrapper backing and fails closed on preserve-only state", () => {
    withInstalledShim(({ wrappers, backups, statePath }) => {
      expect(inspectCodexShimBackingForCommand(wrappers[0]!)).toMatchObject({
        status: "matched",
        selectedRole: "wrapper",
        backingPath: backups[0]!,
        backingKind: "backup",
      });
      expect(inspectCodexShimBackingForCommand(backups[0]!)).toMatchObject({
        status: "matched",
        selectedRole: "backing",
        backingPath: backups[0]!,
        backingKind: "backup",
      });

      const state = JSON.parse(readFileSync(statePath, "utf8")) as { wrappers: Array<Record<string, unknown>> };
      state.wrappers[0]!.preserveOnly = true;
      writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
      expect(inspectCodexShimBackingForCommand(wrappers[0]!)).toEqual({
        status: "unknown",
        reason: "preserve_only",
      });
    });
  });

  test.skipIf(process.platform === "win32")("matches hard-link aliases of a recorded wrapper or backing by file identity", () => {
    withInstalledShim(({ wrappers, backups }) => {
      const wrapperAlias = `${wrappers[0]!}.alias`;
      const backingAlias = `${backups[0]!}.alias`;
      linkSync(wrappers[0]!, wrapperAlias);
      linkSync(backups[0]!, backingAlias);
      expect(inspectCodexShimBackingForCommand(wrapperAlias)).toMatchObject({
        status: "matched",
        selectedRole: "wrapper",
        backingPath: backups[0]!,
      });
      expect(inspectCodexShimBackingForCommand(backingAlias)).toMatchObject({
        status: "matched",
        selectedRole: "backing",
        backingPath: backups[0]!,
      });
    });
  });

  test.skipIf(process.platform === "win32")("distinguishes absent state from invalid state", () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-shim-inspect-invalid-"));
    const oldHome = process.env.OPENCODEX_HOME;
    try {
      process.env.OPENCODEX_HOME = home;
      expect(inspectCodexShimBackingForCommand(join(home, "codex"))).toEqual({ status: "not-tracked" });
      writeFileSync(join(home, "codex-shim.json"), "{broken", "utf8");
      expect(inspectCodexShimBackingForCommand(join(home, "codex"))).toEqual({
        status: "unknown",
        reason: "state_invalid",
      });
    } finally {
      if (oldHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = oldHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32")("fails closed when the recorded backing aliases the wrapper", () => {
    withInstalledShim(({ wrappers, backups }) => {
      rmSync(backups[0]!);
      linkSync(wrappers[0]!, backups[0]!);
      expect(inspectCodexShimBackingForCommand(wrappers[0]!)).toEqual({
        status: "unknown",
        reason: "ambiguous_match",
      });
    });
  });

});
