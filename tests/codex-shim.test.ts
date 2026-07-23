import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildUnixCodexShim, buildWindowsCodexShim, buildWindowsPowerShellCodexShim, findCodexOnPath, installCodexShim, isWindowsInteropDir, lastCodexDiscoveryError, uninstallCodexShim } from "../src/codex/shim";

const SHIM_MARKER = "opencodex codex autostart shim";

describe("Codex autostart shim", () => {
  test("builds a Unix shim that starts ocx before execing Codex", () => {
    const script = buildUnixCodexShim("/usr/local/bin/codex-real", "/usr/local/bin/bun", "/opt/opencodex/src/cli.ts");

    expect(script).toContain(SHIM_MARKER);
    expect(script).toContain("ensure");
    expect(script).not.toContain("sync-cache");
    expect(script).toContain("exec '/usr/local/bin/codex-real' \"$@\"");
    expect(script).toContain("OPENCODEX_API_AUTH_TOKEN");
  });

  test("builds a Windows shim that starts ocx before running Codex", () => {
    const script = buildWindowsCodexShim("C:\\Tools\\codex-real.exe", "C:\\Bun\\bun.exe", "C:\\ocx\\cli.ts");

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

    expect(source).toContain("`\\uFEFF${buildWindowsPowerShellCodexShim(realCodexPath, bun, cli)}`");
  });

  test("Windows target discovery includes the extensionless Git-Bash launcher and writeShim emits a forward-slash sh shim for it", () => {
    const source = readFileSync(join(import.meta.dir, "..", "src", "codex", "shim.ts"), "utf8");

    expect(source).toContain('const gitBashLauncher = join(dir, "codex");');
    expect(source).toContain("for (const path of [cmd, ps1, gitBashLauncher])");
    expect(source).toContain("buildUnixCodexShim(gitBashPath(realCodexPath), gitBashPath(bun), gitBashPath(cli), gitBashPath(serviceApiTokenFilePath()))");
  });

  test("Unix shim accepts an injected token-file path (Git-Bash shims need forward slashes everywhere)", () => {
    const script = buildUnixCodexShim(
      "C:/Users/한글사용자/AppData/Roaming/npm/codex.opencodex-real",
      "C:/Users/한글사용자/AppData/Roaming/npm/node_modules/bun/bin/bun.exe",
      "C:/Users/한글사용자/AppData/Roaming/npm/node_modules/opencodex/src/cli.ts",
      "C:/Users/한글사용자/.opencodex/service-api-token",
    );

    expect(script).toContain("exec 'C:/Users/한글사용자/AppData/Roaming/npm/codex.opencodex-real' \"$@\"");
    expect(script).toContain("[ -f 'C:/Users/한글사용자/.opencodex/service-api-token' ]");
    expect(script).not.toContain("\\\\");
  });

  test("shim builder output contains the marker that isShim() checks", () => {
    const unix = buildUnixCodexShim("/bin/codex", "/bin/bun", "/cli.ts");
    const win = buildWindowsCodexShim("C:\\codex.exe", "C:\\bun.exe", "C:\\cli.ts");

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
    const script = buildUnixCodexShim("/bin/codex", "/bin/bun", "/cli.ts");
    expect(script).toContain("OCX_SHIM_BYPASS");
  });

  test("Windows shim uses bypass env var to skip proxy start", () => {
    const script = buildWindowsCodexShim("C:\\codex.exe", "C:\\bun.exe", "C:\\cli.ts");
    expect(script).toContain("OCX_SHIM_BYPASS");
  });

  test("PowerShell shim uses bypass env var to skip proxy start", () => {
    const script = buildWindowsPowerShellCodexShim("C:\\codex-real.ps1", "C:\\bun.exe", "C:\\cli.ts");
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
    writeFileSync(shimPath, buildUnixCodexShim(realCodexPath, bunPath, cliPath), "utf8");
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
      writeFileSync(shimPath, buildUnixCodexShim(realCodexPath, bunPath, "/opt/opencodex/src/cli.ts"), "utf8");
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
    writeFileSync(shimPath, buildUnixCodexShim(realCodexPath, bunPath, "/opt/opencodex/src/cli.ts"), "utf8");
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
    const script = buildWindowsCodexShim("C:\\Tools\\codex-real.exe", "C:\\Bun\\bun.exe", "C:\\ocx\\cli.ts");

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
    const script = buildWindowsPowerShellCodexShim("C:\\codex-real.ps1", "C:\\bun.exe", "C:\\cli.ts");

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

      const removed = uninstallCodexShim();

      expect(removed.removed).toBe(true);
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
