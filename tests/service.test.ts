import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { assertServiceAuthEnvironment, assertServiceEnvironmentMatchesInstall, buildPlist, buildUnit, buildWindowsSchtasksCreateArgs, buildWindowsServiceScript, serviceLogPath, serviceStatusSummary } from "../src/service";
import { serviceApiTokenFilePath } from "../src/service-secrets";
import type { OcxConfig } from "../src/types";

const TEST_DIR = join(import.meta.dir, ".tmp-service-test");
const previousOpenCodexHome = process.env.OPENCODEX_HOME;
const previousCodexHome = process.env.CODEX_HOME;
const previousApiAuthToken = process.env.OPENCODEX_API_AUTH_TOKEN;

afterEach(() => {
  if (previousOpenCodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpenCodexHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  if (previousApiAuthToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
  else process.env.OPENCODEX_API_AUTH_TOKEN = previousApiAuthToken;
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

const root = new URL("../", import.meta.url);

async function readText(path: string): Promise<string> {
  return await Bun.file(new URL(path, root)).text();
}

function pathVariants(path: string): string[] {
  return [...new Set([path, path.replace(/\\/g, "\\\\")])];
}

function expectTextToContainPath(text: string, path: string): void {
  expect(pathVariants(path).some(candidate => text.includes(candidate))).toBe(true);
}

describe("systemd service unit", () => {
  test("uses unquoted append targets for service logs", () => {
    const unit = buildUnit();

    expect(unit).toContain("StandardOutput=append:");
    expect(unit).toContain("StandardError=append:");
    expect(unit).not.toContain('StandardOutput="append:');
    expect(unit).not.toContain('StandardError="append:');
  });

  test("preserves custom Codex and OpenCodex homes", () => {
    const oldCodexHome = process.env.CODEX_HOME;
    const oldOpenCodexHome = process.env.OPENCODEX_HOME;
    const oldApiAuthToken = process.env.OPENCODEX_API_AUTH_TOKEN;
    try {
      process.env.CODEX_HOME = "/tmp/codex-home";
      process.env.OPENCODEX_HOME = "/tmp/opencodex-home";
      process.env.OPENCODEX_API_AUTH_TOKEN = "local-secret";
      const unit = buildUnit();
      expect(unit).toContain('Environment="CODEX_HOME=/tmp/codex-home"');
      expect(unit).toContain('Environment="OPENCODEX_HOME=/tmp/opencodex-home"');
      expectTextToContainPath(unit, serviceApiTokenFilePath());
      expect(unit).not.toContain("local-secret");
      expect(unit).not.toContain("Environment=\"OPENCODEX_API_AUTH_TOKEN=");
    } finally {
      if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = oldCodexHome;
      if (oldOpenCodexHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = oldOpenCodexHome;
      if (oldApiAuthToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
      else process.env.OPENCODEX_API_AUTH_TOKEN = oldApiAuthToken;
    }
  });
});

describe("service install auth preflight", () => {
  test("rejects non-loopback service install without a persisted API token", () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    delete process.env.OPENCODEX_API_AUTH_TOKEN;
    saveConfig({
      port: 10100,
      hostname: "0.0.0.0",
      providers: { openai: { adapter: "openai-chat", baseUrl: "https://api.example.test/v1" } },
      defaultProvider: "openai",
    } as OcxConfig);

    expect(() => assertServiceAuthEnvironment()).toThrow("OPENCODEX_API_AUTH_TOKEN");
  });

  test("allows non-loopback service install when the API token is in the service environment", () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    process.env.OPENCODEX_API_AUTH_TOKEN = "local-secret";
    saveConfig({
      port: 10100,
      hostname: "0.0.0.0",
      providers: { openai: { adapter: "openai-chat", baseUrl: "https://api.example.test/v1" } },
      defaultProvider: "openai",
    } as OcxConfig);

    expect(() => assertServiceAuthEnvironment()).not.toThrow();
  });

  test("rejects restore operations from a different CODEX_HOME than service install", () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    process.env.CODEX_HOME = "/tmp/current-codex-home";
    writeFileSync(join(TEST_DIR, "service-state.json"), JSON.stringify({
      version: 1,
      codexHome: "/tmp/installed-codex-home",
      opencodexHome: TEST_DIR,
    }) + "\n");

    expect(() => assertServiceEnvironmentMatchesInstall()).toThrow("Service was installed with CODEX_HOME");
  });
});

describe("Windows service task", () => {
  test("builds schtasks create args without shell interpolation", () => {
    const script = "C:\\Users\\a&b\\.opencodex\\opencodex-service.cmd";
    const args = buildWindowsSchtasksCreateArgs(script);

    expect(args).toContain("/create");
    expect(args).toContain("/tr");
    expect(args[args.indexOf("/tr") + 1]).toBe(`"${script}"`);
    expect(args[args.indexOf("/rl") + 1]).toBe("LIMITED");
    expect(args).not.toContain("highest");
    expect(args.join(" ")).toContain("a&b");
  });

  test("escapes environment values that would break out of set quotes", () => {
    const oldPath = process.env.PATH;
    const oldOpenCodexHome = process.env.OPENCODEX_HOME;
    const oldApiAuthToken = process.env.OPENCODEX_API_AUTH_TOKEN;
    try {
      process.env.PATH = 'C:\\safe" & echo PWNED & rem "';
      process.env.OPENCODEX_HOME = 'C:\\ocx" & del C:\\important & rem "';
      process.env.OPENCODEX_API_AUTH_TOKEN = 'token" & echo LEAK & rem "';
      const script = buildWindowsServiceScript();
      expect(script).toContain('set "PATH=C:\\safe & echo PWNED & rem "');
      expect(script).toContain('set "OPENCODEX_HOME=C:\\ocx & del C:\\important & rem "');
      expect(script).toContain('set "OCX_API_TOKEN_FILE=');
      expect(script).toContain('set /p OPENCODEX_API_AUTH_TOKEN=<"%OCX_API_TOKEN_FILE%"');
      expect(script).not.toContain('set "PATH=C:\\safe" & echo PWNED');
      expect(script).not.toContain('set "OPENCODEX_HOME=C:\\ocx" & del');
      expect(script).not.toContain("token & echo LEAK");
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      if (oldOpenCodexHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = oldOpenCodexHome;
      if (oldApiAuthToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
      else process.env.OPENCODEX_API_AUTH_TOKEN = oldApiAuthToken;
    }
  });

  test("escapes service executable paths through variables", () => {
    const script = buildWindowsServiceScript({
      bun: "C:\\Bun&Dir\\100%bun^\\bun.exe",
      cli: "C:\\OpenCodex&Dir\\cli.ts",
    });

    expect(script).toContain('set "OCX_BUN=C:\\Bun&Dir\\100%%bun^^\\bun.exe"');
    expect(script).toContain('set "OCX_CLI=C:\\OpenCodex&Dir\\cli.ts"');
    expect(script).toContain('"%OCX_BUN%" "%OCX_CLI%" start');
    expect(script).not.toContain('"C:\\Bun&Dir\\100%bun^\\bun.exe"');
  });

  test("writes token-safe startup identity and child output to the service log", () => {
    const oldCodexHome = process.env.CODEX_HOME;
    const oldOpenCodexHome = process.env.OPENCODEX_HOME;
    const oldApiAuthToken = process.env.OPENCODEX_API_AUTH_TOKEN;
    try {
      process.env.CODEX_HOME = "C:\\codex-home";
      process.env.OPENCODEX_HOME = TEST_DIR;
      process.env.OPENCODEX_API_AUTH_TOKEN = "local-secret";
      const script = buildWindowsServiceScript({
        bun: "C:\\OpenCodex\\bun.exe",
        cli: "C:\\OpenCodex\\cli.ts",
      });

      expectTextToContainPath(script, serviceLogPath());
      expect(script).toContain('set "OCX_SERVICE_LOG=');
      expect(script).toContain("opencodex service wrapper start");
      expect(script).toContain('echo bun="%OCX_BUN%"');
      expect(script).toContain('echo cli="%OCX_CLI%"');
      expect(script).toContain('echo opencodex_home="%OPENCODEX_HOME%"');
      expect(script).toContain('echo codex_home="%CODEX_HOME%"');
      expect(script).toContain('echo token_file="%OCX_API_TOKEN_FILE%"');
      expect(script).toContain('"%OCX_BUN%" "%OCX_CLI%" start >>"%OCX_SERVICE_LOG%" 2>&1');
      expect(script).toContain("child exited with code %ERRORLEVEL%");
      expect(script).not.toContain("local-secret");
      expect(script).not.toContain('set "OPENCODEX_API_AUTH_TOKEN=');
    } finally {
      if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = oldCodexHome;
      if (oldOpenCodexHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = oldOpenCodexHome;
      if (oldApiAuthToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
      else process.env.OPENCODEX_API_AUTH_TOKEN = oldApiAuthToken;
    }
  });
});

describe("launchd service plist", () => {
  test("preserves custom Codex and OpenCodex homes", () => {
    const oldCodexHome = process.env.CODEX_HOME;
    const oldOpenCodexHome = process.env.OPENCODEX_HOME;
    const oldApiAuthToken = process.env.OPENCODEX_API_AUTH_TOKEN;
    try {
      process.env.CODEX_HOME = "/tmp/codex-home";
      process.env.OPENCODEX_HOME = "/tmp/opencodex-home";
      process.env.OPENCODEX_API_AUTH_TOKEN = "local-secret";
      const plist = buildPlist();
      expect(plist).toContain("<key>CODEX_HOME</key><string>/tmp/codex-home</string>");
      expect(plist).toContain("<key>OPENCODEX_HOME</key><string>/tmp/opencodex-home</string>");
      expectTextToContainPath(plist, serviceApiTokenFilePath());
      expect(plist).not.toContain("local-secret");
      expect(plist).not.toContain("<key>OPENCODEX_API_AUTH_TOKEN</key>");
    } finally {
      if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = oldCodexHome;
      if (oldOpenCodexHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = oldOpenCodexHome;
      if (oldApiAuthToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
      else process.env.OPENCODEX_API_AUTH_TOKEN = oldApiAuthToken;
    }
  });
});

describe("service lifecycle cleanup ordering", () => {
  test("direct service stop kills the tracked proxy before restoring native Codex", async () => {
    const service = await readText("src/service.ts");
    const stopCase = service.slice(service.indexOf('case "stop":'), service.indexOf('case "status":'));

    expect(stopCase).toContain("ops.stop();");
    expect(stopCase).toContain("stopTrackedProxyForServiceCommand();");
    expect(stopCase).toContain("restoreNativeCodex();");
    expect(stopCase.indexOf("ops.stop();")).toBeLessThan(stopCase.indexOf("stopTrackedProxyForServiceCommand();"));
    expect(stopCase.indexOf("stopTrackedProxyForServiceCommand();")).toBeLessThan(stopCase.indexOf("restoreNativeCodex();"));
  });

  test("direct service uninstall kills the tracked proxy before deleting service assets", async () => {
    const service = await readText("src/service.ts");
    const uninstallCase = service.slice(service.indexOf('case "uninstall":'), service.indexOf("default:"));

    expect(uninstallCase).toContain("ops.stop();");
    expect(uninstallCase).toContain("stopTrackedProxyForServiceCommand();");
    expect(uninstallCase).toContain("ops.uninstall();");
    expect(uninstallCase).toContain("restoreNativeCodex();");
    expect(uninstallCase.indexOf("ops.stop();")).toBeLessThan(uninstallCase.indexOf("stopTrackedProxyForServiceCommand();"));
    expect(uninstallCase.indexOf("stopTrackedProxyForServiceCommand();")).toBeLessThan(uninstallCase.indexOf("ops.uninstall();"));
    expect(uninstallCase.indexOf("ops.uninstall();")).toBeLessThan(uninstallCase.indexOf("restoreNativeCodex();"));
  });

  test("service cleanup uses the shared process-tree killer and clears the pid file", async () => {
    const service = await readText("src/service.ts");

    expect(service).toContain('import { getConfigDir, readPid, removePid } from "./config";');
    expect(service).toContain('import { killProxy } from "./process-control";');
    expect(service).toContain("function stopTrackedProxyIfRunning(): boolean");
    expect(service).toContain("if (!pid) return false;");
    expect(service).toContain("killProxy(pid);");
    expect(service).toContain("removePid(pid);");
  });

  test("service command cleanup logs kill failures without skipping restore/delete", async () => {
    const service = await readText("src/service.ts");

    expect(service).toContain("function stopTrackedProxyForServiceCommand(): boolean");
    expect(service).toContain("catch (err)");
    expect(service).toContain("Failed to stop proxy");
    expect(service).toContain("return false;");
  });
});

describe("service diagnostics", () => {
  test("status summary exposes the service log path", () => {
    const summary = serviceStatusSummary();

    expectTextToContainPath(summary, serviceLogPath());
  });

  test("direct service status prints the diagnostics line", async () => {
    const service = await readText("src/service.ts");
    const statusCase = service.slice(service.indexOf('case "status":'), service.indexOf('case "uninstall":'));

    expect(statusCase).toContain("Diagnostics:");
    expect(statusCase).toContain("serviceDiagnosticsSummary()");
  });
});
