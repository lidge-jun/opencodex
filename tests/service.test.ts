import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, posix, win32 } from "node:path";
import * as serviceModule from "../src/service";
import { saveConfig } from "../src/config";
import { windowsEnvIndirectBatchValue } from "../src/lib/win-paths";
import { assertServiceAuthEnvironment, assertServiceEnvironmentMatchesInstall, bakedServicePathsDiagnostic, confirmServiceServing, launchdListenPort, systemdListenPort, buildPlist, buildUnit, buildWindowsLauncherVbs, buildWindowsSchtasksCreateArgs, buildWindowsSchtasksCreateArgsForXml, buildWindowsServiceScript, buildWindowsTaskXml, deriveWindowsServiceDiagnostic, installFreshWindowsSchedulerSafely, installServiceSafely, launchctlLoadFailed, launchdJobMatchesPlist, normalizeServiceSubcommand, parseServiceInstallState, prepareServiceInstall, readWindowsSchedulerXmlState, registerFreshWindowsSchedulerTask, removeNativeWindowsServiceForScheduler, repairService, resolveServiceListenPort, runLaunchctl, serviceLogPath, serviceStartableFromTray, serviceStatusReport, serviceRetryCommand, serviceStatusSummary, systemdNeedsDaemonReload, windowsListenPort, winswListenPort, startLaunchd, windowsTaskRegistrationHealthy } from "../src/service";
import type { ServiceDiagnostic } from "../src/service";
import { definitionCarriesCredential, resolvedProxyEnv, writeServiceDefinitionFile } from "../src/service";
import { buildWinswXml } from "../src/lib/winsw";
import { CONFIG_OWNER_FILE, CONFIG_UNINSTALL_MANIFEST, recordOwnedConfigPath, removeOwnedConfigState } from "../src/lib/config-ownership";
import { serviceApiTokenFilePath } from "../src/lib/service-secrets";
import { WindowsSchtasksError } from "../src/lib/windows-elevation";
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

function windowsBatchValue(value: string): string {
  return value
    .replace(/%/g, "%%")
    .replace(/\^/g, "^^")
    .replace(/"/g, "")
    .replace(/[\r\n]/g, "");
}

function pathVariants(path: string): string[] {
  const batchPath = windowsEnvIndirectBatchValue(path, windowsBatchValue);
  return [...new Set([
    path,
    path.replace(/\\/g, "\\\\"),
    batchPath,
    batchPath.replace(/\\/g, "\\\\"),
  ])];
}

function expectTextToContainPath(text: string, path: string): void {
  expect(pathVariants(path).some(candidate => text.includes(candidate))).toBe(true);
}

describe("service listen-port bake", () => {
  test("resolveServiceListenPort prefers override, then OCX_BAKE_PORT, then config", () => {
    process.env.OPENCODEX_HOME = TEST_DIR;
    mkdirSync(TEST_DIR, { recursive: true });
    saveConfig({ port: 10100, hostname: "127.0.0.1", defaultProvider: "openai", providers: {} } as OcxConfig);
    expect(resolveServiceListenPort(18765)).toBe(18765);
    const prev = process.env.OCX_BAKE_PORT;
    try {
      process.env.OCX_BAKE_PORT = "15555";
      expect(resolveServiceListenPort()).toBe(15555);
      delete process.env.OCX_BAKE_PORT;
      expect(resolveServiceListenPort()).toBe(10100);
      saveConfig({ port: 0, hostname: "127.0.0.1", defaultProvider: "openai", providers: {} } as OcxConfig);
      expect(resolveServiceListenPort()).toBe(10100);
    } finally {
      if (prev === undefined) delete process.env.OCX_BAKE_PORT;
      else process.env.OCX_BAKE_PORT = prev;
    }
  });

  test("Windows batch and launchd/systemd shell commands bake start --port", () => {
    process.env.OPENCODEX_HOME = TEST_DIR;
    mkdirSync(TEST_DIR, { recursive: true });
    saveConfig({ port: 13337, hostname: "127.0.0.1", defaultProvider: "openai", providers: {} } as OcxConfig);
    const script = buildWindowsServiceScript({ bun: "C:\\OpenCodex\\bun.exe", bunRuntimeSource: "bundled", cli: "C:\\OpenCodex\\cli.ts" });
    expect(script).toContain("start --port 13337");
    expect(buildPlist()).toContain("start --port 13337");
    expect(buildUnit()).toContain("start --port 13337");
  });
});

describe("systemd service unit", () => {
  test("bare service command defaults to the install/update/start path", async () => {
    expect(normalizeServiceSubcommand()).toBe("install");
    expect(normalizeServiceSubcommand("start")).toBe("start");
    expect(normalizeServiceSubcommand("nope")).toBe("nope");

    const service = await readText("src/service.ts");
    const serviceCommand = service.slice(service.indexOf("export async function serviceCommand"));
    // Args flow through parseServiceArgs (which applies the install default) into the switch.
    expect(serviceCommand).toContain("const parsed = parseServiceArgs(");
    expect(serviceCommand).toContain("const command = parsed.sub;");
    expect(serviceCommand).toContain("switch (command)");
  });

  test("uses unquoted append targets for service logs", () => {
    const unit = buildUnit();

    expect(unit).toContain("StandardOutput=append:");
    expect(unit).toContain("StandardError=append:");
    expect(unit).not.toContain('StandardOutput="append:');
    expect(unit).not.toContain('StandardError="append:');
  });

  test("bakes outbound proxy env into the unit so the service is not cut off from upstream (#2107)", () => {
    // systemd does not inherit the installing shell's environment, and ExecStart runs
    // /bin/sh -lc — which is dash on Ubuntu/WSL and reads .profile, not .bashrc. A user
    // whose proxy lives in the shell therefore gets a service that dials upstream direct,
    // the socket is reset, and the request surfaces as 502 Provider unreachable.
    //
    // The shell is passed in rather than assigned onto `process.env`. Mutating the real
    // environment here leaked `HTTP_PROXY` out of this file: Bun runs a `bun test a b`
    // invocation in ONE process, and the Lab sandbox calls `rejectProxyEnvironment()` on
    // the live `process.env`, so every Lab file that loaded afterwards died with
    // `harness_failure`. That was 73 failures on the unsharded macOS lane and zero when
    // the Lab suites ran alone.
    const proxyEnv = resolvedProxyEnv({
      HTTP_PROXY: "http://127.0.0.1:7890",
      HTTPS_PROXY: "http://127.0.0.1:7890",
      NO_PROXY: "localhost,127.0.0.1",
    });

    const unit = buildUnit(proxyEnv);
    expect(unit).toContain('Environment="HTTP_PROXY=http://127.0.0.1:7890"');
    expect(unit).toContain('Environment="HTTPS_PROXY=http://127.0.0.1:7890"');
    expect(unit).toContain("NO_PROXY=");
    // An unset key must not produce an empty assignment.
    expect(unit).not.toContain('Environment="ALL_PROXY="');

    const plist = buildPlist(proxyEnv);
    expect(plist).toContain("<key>HTTP_PROXY</key><string>http://127.0.0.1:7890</string>");
    expect(plist).not.toContain("<key>ALL_PROXY</key>");
  });

  test("omits proxy env entirely when the installing shell has none (#2107)", () => {
    const unit = buildUnit(resolvedProxyEnv({}));
    for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]) {
      expect(unit).not.toContain(`${key}=`);
    }
  });

  test("lower-case shell spellings are baked under the canonical name (#2107)", () => {
    // curl-style tooling sets the lower-case pair; only the upper-case name is emitted so a
    // definition never carries two spellings of one setting.
    const unit = buildUnit(resolvedProxyEnv({ http_proxy: "http://127.0.0.1:7890" }));

    expect(unit).toContain('Environment="HTTP_PROXY=http://127.0.0.1:7890"');
    expect(unit).not.toContain("http_proxy=");
  });

  test("the Windows wrapper bakes proxy env the same way the unit and plist do (#2107)", () => {
    // This builder was the only one of the three with no proxy assertion, because the only way
    // to reach it was to assign process.env — the pattern that leaked HTTP_PROXY across files.
    const script = buildWindowsServiceScript(
      { bun: "C:\\OpenCodex\\bun.exe", bunRuntimeSource: "bundled", cli: "C:\\OpenCodex\\cli.ts" },
      10100,
      resolvedProxyEnv({ HTTP_PROXY: "http://127.0.0.1:7890", no_proxy: "localhost" }),
    );

    expect(script).toContain("HTTP_PROXY=http://127.0.0.1:7890");
    // Lower-case spellings are baked under the canonical name, never both.
    expect(script).toContain("NO_PROXY=localhost");
    expect(script).not.toContain("no_proxy=");
    expect(script).not.toContain("HTTPS_PROXY=");
  });


  test("preserves custom Codex and OpenCodex homes", () => {
    const oldCodexHome = process.env.CODEX_HOME;
    const oldCodexSqliteHome = process.env.CODEX_SQLITE_HOME;
    const oldOpenCodexHome = process.env.OPENCODEX_HOME;
    const oldApiAuthToken = process.env.OPENCODEX_API_AUTH_TOKEN;
    try {
      process.env.CODEX_HOME = "/tmp/codex-home";
      process.env.CODEX_SQLITE_HOME = "/tmp/codex-sqlite-home";
      process.env.OPENCODEX_HOME = "/tmp/opencodex-home";
      process.env.OPENCODEX_API_AUTH_TOKEN = "local-secret";
      const unit = buildUnit();
      expect(unit).toContain('Environment="CODEX_HOME=/tmp/codex-home"');
      expect(unit).toContain('Environment="CODEX_SQLITE_HOME=/tmp/codex-sqlite-home"');
      expect(unit).toContain('Environment="OPENCODEX_HOME=/tmp/opencodex-home"');
      expectTextToContainPath(unit, serviceApiTokenFilePath());
      expect(unit).not.toContain("local-secret");
      expect(unit).not.toContain("Environment=\"OPENCODEX_API_AUTH_TOKEN=");
    } finally {
      if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = oldCodexHome;
      if (oldCodexSqliteHome === undefined) delete process.env.CODEX_SQLITE_HOME;
      else process.env.CODEX_SQLITE_HOME = oldCodexSqliteHome;
      if (oldOpenCodexHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = oldOpenCodexHome;
      if (oldApiAuthToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
      else process.env.OPENCODEX_API_AUTH_TOKEN = oldApiAuthToken;
    }
  });

  test("service start checks for the systemd user unit before shelling out", async () => {
    const service = await readText("src/service.ts");
    const installSystemd = service.slice(service.indexOf("function installSystemd()"), service.indexOf("function startSystemd()"));
    const startSystemd = service.slice(service.indexOf("function startSystemd()"), service.indexOf("function stopSystemd()"));

    const unitCheckAt = startSystemd.indexOf("existsSync(unitPath())");
    const startAt = startSystemd.indexOf("systemctl --user start");
    expect(unitCheckAt).toBeGreaterThan(-1);
    expect(startAt).toBeGreaterThan(-1);
    expect(unitCheckAt).toBeLessThan(startAt);
    expect(startSystemd).toContain("ocx service install");
    expect(startSystemd).toContain("process.exit(1)");

    // The write goes through writeServiceDefinitionFile so the unit lands 0600: it can carry a
    // proxy credential (#2107). What this test pins is the ORDER — write, then reload.
    const writeAt = installSystemd.indexOf('writeServiceDefinitionFile(unitPath(), buildUnit(), "utf8")');
    const reloadAt = installSystemd.indexOf("systemctl --user daemon-reload");
    const enableAt = installSystemd.indexOf("systemctl --user enable");
    const restartAt = installSystemd.indexOf("systemctl --user restart");
    expect(writeAt).toBeGreaterThan(-1);
    expect(writeAt).toBeLessThan(reloadAt);
    expect(reloadAt).toBeLessThan(enableAt);
    expect(enableAt).toBeLessThan(restartAt);
    expect(installSystemd).not.toContain("ocx service install");
    expect(installSystemd).not.toContain("process.exit(1)");
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
  test("builds schtasks create args from XML instead of runtime flags", () => {
    const script = "C:\\Users\\a&b\\.opencodex\\opencodex-service.cmd";
    const args = buildWindowsSchtasksCreateArgs(script);

    expect(args).toContain("/create");
    expect(args).toContain("/xml");
    expect(args[args.indexOf("/xml") + 1]).toBe(`${script}.xml`);
    expect(args).not.toContain("/tr");
    expect(args).not.toContain("/sc");
    expect(args).not.toContain("/du");
    expect(args).not.toContain("/rl");
    expect(args).not.toContain("highest");
    expect(args.join(" ")).toContain("a&b");
  });

  test("builds service-like Task Scheduler XML settings", () => {
    const script = "C:\\Users\\a&b\\.opencodex\\opencodex-service.cmd";
    const launcher = "C:\\Users\\a&b\\.opencodex\\opencodex-service-launcher.vbs";
    const xml = buildWindowsTaskXml(script, launcher);

    expect(xml).toContain('<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">');
    expect(xml).toContain("<LogonTrigger>");
    expect(xml).toContain("<RunLevel>LeastPrivilege</RunLevel>");
    expect(xml).toContain("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>");
    expect(xml).toContain("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>");
    expect(xml).toContain("<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>");
    expect(xml).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
    expect(xml).toContain("<RestartOnFailure>");
    expect(xml).toContain("<Interval>PT1M</Interval>");
    expect(xml).toContain("<Count>3</Count>");
    // The action is wscript running the hidden VBS launcher, never the console batch directly.
    expect(xml).toMatch(/<Command>.*wscript\.exe<\/Command>/);
    expect(xml).toContain('<Arguments>/b /nologo &quot;C:\\Users\\a&amp;b\\.opencodex\\opencodex-service-launcher.vbs&quot;</Arguments>');
    expect(xml).not.toContain("<Command>C:\\Users\\a&amp;b\\.opencodex\\opencodex-service.cmd</Command>");
  });

  test("validates the registered scheduler action, trigger, principal, and settings", () => {
    const wscript = "C:\\Windows\\System32\\wscript.exe";
    const launcher = "C:\\Users\\Test\\.opencodex\\service-launcher.vbs";
    const xml = buildWindowsTaskXml("ignored.cmd", launcher).replace(/<Command>.*?<\/Command>/, `<Command>${wscript}</Command>`);
    expect(windowsTaskRegistrationHealthy(xml, wscript, launcher)).toBe(true);
    for (const mutated of [
      xml.replace("<LogonTrigger>", "<BootTrigger>"),
      xml.replace("InteractiveToken", "Password"),
      xml.replace("LeastPrivilege", "InvalidLevel"),
      xml.replace("IgnoreNew", "Parallel"),
      xml.replace(wscript, "C:\\Windows\\System32\\cmd.exe"),
      xml.replace(launcher, "C:\\Temp\\foreign.vbs"),
    ]) expect(windowsTaskRegistrationHealthy(mutated, wscript, launcher)).toBe(false);
  });

  // --- #432: Task Scheduler omits schema defaults when exporting ---------------

  test("accepts canonicalized scheduler XML with omitted defaults", () => {
    const wscript = "C:\\Windows\\System32\\wscript.exe";
    const launcher = "C:\\Users\\Test\\.opencodex\\service-launcher.vbs";
    const xml = buildWindowsTaskXml("ignored.cmd", launcher)
      .replace(/<Command>.*?<\/Command>/, `<Command>${wscript}</Command>`);
    // Windows drops elements equal to their schema default when it exports a task:
    // Trigger/Settings Enabled default to true and RunLevel defaults to LeastPrivilege.
    const canonical = xml
      .replace("<LogonTrigger>\n      <Enabled>true</Enabled>\n    </LogonTrigger>", "<LogonTrigger />")
      .replace("    <RunLevel>LeastPrivilege</RunLevel>\n", "")
      .replace("    <Enabled>true</Enabled>\n    <Hidden>", "    <Hidden>");
    expect(canonical).toContain("<LogonTrigger />");
    expect(canonical).not.toContain("RunLevel");

    expect(windowsTaskRegistrationHealthy(canonical, wscript, launcher)).toBe(true);
    expect(readWindowsSchedulerXmlState(canonical, wscript, launcher)).toMatchObject({
      installed: true,
      enabled: true,
      registrationHealthy: true,
    });
  });

  // --- #608: Task Scheduler canonicalizes escaped text when exporting ---------

  test("accepts an export whose Arguments quotes were canonicalized", () => {
    const wscript = "C:\\Windows\\System32\\wscript.exe";
    const launcher = "C:\\Users\\Test\\.opencodex\\service-launcher.vbs";
    const xml = buildWindowsTaskXml("ignored.cmd", launcher)
      .replace(/<Command>.*?<\/Command>/, `<Command>${wscript}</Command>`);
    // We write `&quot;`; Task Scheduler hands the same value back with literal
    // quotes. Comparing encodings made a healthy task read as permanently stale.
    const canonical = xml.replace(
      `<Arguments>/b /nologo &quot;${launcher}&quot;</Arguments>`,
      `<Arguments>/b /nologo "${launcher}"</Arguments>`,
    );
    expect(canonical).toContain(`<Arguments>/b /nologo "${launcher}"</Arguments>`);
    expect(windowsTaskRegistrationHealthy(canonical, wscript, launcher)).toBe(true);
    // The escaped form we emit must keep working too.
    expect(windowsTaskRegistrationHealthy(xml, wscript, launcher)).toBe(true);
  });

  test("accepts a canonicalized export whose launcher path contains an ampersand", () => {
    const wscript = "C:\\Windows\\System32\\wscript.exe";
    const launcher = "C:\\Users\\a&b\\.opencodex\\service-launcher.vbs";
    const xml = buildWindowsTaskXml("ignored.cmd", launcher)
      .replace(/<Command>.*?<\/Command>/, `<Command>${wscript}</Command>`);
    // `&` stays `&amp;` (it must, or the XML is malformed); only the quotes flip.
    const canonical = xml.replace(
      "<Arguments>/b /nologo &quot;C:\\Users\\a&amp;b\\.opencodex\\service-launcher.vbs&quot;</Arguments>",
      "<Arguments>/b /nologo \"C:\\Users\\a&amp;b\\.opencodex\\service-launcher.vbs\"</Arguments>",
    );
    expect(windowsTaskRegistrationHealthy(canonical, wscript, launcher)).toBe(true);
  });

  test("the canonicalization tolerance does not weaken the launcher check", () => {
    const wscript = "C:\\Windows\\System32\\wscript.exe";
    const launcher = "C:\\Users\\Test\\.opencodex\\service-launcher.vbs";
    const xml = buildWindowsTaskXml("ignored.cmd", launcher)
      .replace(/<Command>.*?<\/Command>/, `<Command>${wscript}</Command>`);
    const canonicalArgs = `<Arguments>/b /nologo "${launcher}"</Arguments>`;
    const canonical = xml.replace(
      `<Arguments>/b /nologo &quot;${launcher}&quot;</Arguments>`,
      canonicalArgs,
    );

    for (const [reason, mutated] of [
      // A foreign launcher must still be refused in the canonical shape.
      ["foreign launcher", canonical.replace(launcher, "C:\\Temp\\foreign.vbs")],
      // A foreign interpreter, likewise.
      ["foreign command", canonical.replace(wscript, "C:\\Windows\\System32\\cmd.exe")],
      // Decoding twice would accept this; we decode once.
      ["double-encoded quotes", xml.replace(
        `<Arguments>/b /nologo &quot;${launcher}&quot;</Arguments>`,
        `<Arguments>/b /nologo &amp;quot;${launcher}&amp;quot;</Arguments>`,
      )],
      // Absence is not a schema default here — it means nothing runs.
      ["missing Arguments", canonical.replace(canonicalArgs, "")],
      // Two elements make "which one runs?" ambiguous.
      ["duplicate Arguments", canonical.replace(canonicalArgs, `${canonicalArgs}${canonicalArgs}`)],
      // A namespace-prefixed element must not read as absent.
      ["prefixed Arguments", canonical.replace("<Arguments>", "<t:Arguments>").replace("</Arguments>", "</t:Arguments>")],
    ] as const) {
      expect(windowsTaskRegistrationHealthy(mutated, wscript, launcher), reason).toBe(false);
    }
  });

  test("accepts elevated-create rewrites (HighestAvailable, path casing, raw quotes)", () => {
    const wscript = "C:\\Windows\\System32\\wscript.exe";
    const launcher = "C:\\Users\\Test\\.opencodex\\service-launcher.vbs";
    const xml = buildWindowsTaskXml("ignored.cmd", launcher)
      .replace(/<Command>.*?<\/Command>/, `<Command>C:\\WINDOWS\\System32\\wscript.exe</Command>`)
      .replace("<RunLevel>LeastPrivilege</RunLevel>", "<RunLevel>HighestAvailable</RunLevel>")
      .replace(
        `<Arguments>/b /nologo &quot;${launcher}&quot;</Arguments>`,
        `<Arguments>/b /nologo "${launcher}"</Arguments>`,
      );
    expect(windowsTaskRegistrationHealthy(xml, wscript, launcher)).toBe(true);
  });

  test("rejects explicit unsafe values even though defaults may be omitted", () => {
    const wscript = "C:\\Windows\\System32\\wscript.exe";
    const launcher = "C:\\Users\\Test\\.opencodex\\service-launcher.vbs";
    const xml = buildWindowsTaskXml("ignored.cmd", launcher)
      .replace(/<Command>.*?<\/Command>/, `<Command>${wscript}</Command>`);

    // Trigger disabled explicitly.
    expect(windowsTaskRegistrationHealthy(
      xml.replace("<LogonTrigger>\n      <Enabled>true</Enabled>", "<LogonTrigger>\n      <Enabled>false</Enabled>"),
      wscript,
      launcher,
    )).toBe(false);
    // Settings disabled explicitly.
    const settingsDisabled = xml.replace("    <Enabled>true</Enabled>\n    <Hidden>", "    <Enabled>false</Enabled>\n    <Hidden>");
    expect(windowsTaskRegistrationHealthy(settingsDisabled, wscript, launcher)).toBe(false);
    expect(readWindowsSchedulerXmlState(settingsDisabled, wscript, launcher).enabled).toBe(false);
  });

  test("a decoy trigger outside Triggers does not satisfy the logon requirement", () => {
    const wscript = "C:\\Windows\\System32\\wscript.exe";
    const launcher = "C:\\Users\\Test\\.opencodex\\service-launcher.vbs";
    const xml = buildWindowsTaskXml("ignored.cmd", launcher)
      .replace(/<Command>.*?<\/Command>/, `<Command>${wscript}</Command>`);
    const bootOnly = xml.replace("<LogonTrigger>\n      <Enabled>true</Enabled>\n    </LogonTrigger>", "<BootTrigger />");

    // The schema allows arbitrary XML under Task/Data, and comments could smuggle a
    // decoy too — neither may stand in for a real logon trigger.
    for (const decoyed of [
      bootOnly.replace("<Triggers>", "<Data><LogonTrigger /></Data>\n  <Triggers>"),
      bootOnly.replace("<Triggers>", "<!-- <LogonTrigger /> -->\n  <Triggers>"),
    ]) expect(windowsTaskRegistrationHealthy(decoyed, wscript, launcher)).toBe(false);
  });

  test("namespace-prefixed values are not mistaken for omissions", () => {
    const wscript = "C:\\Windows\\System32\\wscript.exe";
    const launcher = "C:\\Users\\Test\\.opencodex\\service-launcher.vbs";
    const xml = buildWindowsTaskXml("ignored.cmd", launcher)
      .replace(/<Command>.*?<\/Command>/, `<Command>${wscript}</Command>`);

    // A prefixed element carries a real value; reading it as "absent, use the
    // default" would turn an explicitly disabled or elevated task into a healthy one.
    for (const prefixed of [
      xml.replace("    <Enabled>true</Enabled>\n    <Hidden>", "    <t:Enabled>false</t:Enabled>\n    <Hidden>"),
      xml.replace("<RunLevel>LeastPrivilege</RunLevel>", "<t:RunLevel>HighestAvailable</t:RunLevel>"),
    ]) expect(windowsTaskRegistrationHealthy(prefixed, wscript, launcher)).toBe(false);
  });

  test("a Data block disqualifies the registration", () => {
    const wscript = "C:\\Windows\\System32\\wscript.exe";
    const launcher = "C:\\Users\\Test\\.opencodex\\service-launcher.vbs";
    const xml = buildWindowsTaskXml("ignored.cmd", launcher)
      .replace(/<Command>.*?<\/Command>/, `<Command>${wscript}</Command>`);
    // taskXmlSection() takes the first match, so a Data block placed ahead of the
    // real sections could shadow them. We never emit Data, prefixed or not.
    const shadowedSettings = xml
      .replace("    <Enabled>true</Enabled>\n    <Hidden>", "    <Enabled>false</Enabled>\n    <Hidden>")
      .replace("<Triggers>", "<Data><Settings><Enabled>true</Enabled></Settings></Data>\n  <Triggers>");
    const shadowedPrincipal = xml
      .replace("LeastPrivilege", "HighestAvailable")
      .replace("<Triggers>", "<Data><Principal><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Data>\n  <Triggers>");
    const prefixedData = xml
      .replace("    <Enabled>true</Enabled>\n    <Hidden>", "    <Enabled>false</Enabled>\n    <Hidden>")
      .replace("<Triggers>", "<t:Data><Settings><Enabled>true</Enabled></Settings></t:Data>\n  <Triggers>");

    for (const shadowed of [shadowedSettings, shadowedPrincipal, prefixedData]) {
      expect(windowsTaskRegistrationHealthy(shadowed, wscript, launcher)).toBe(false);
      expect(readWindowsSchedulerXmlState(shadowed, wscript, launcher).enabled).toBe(false);
    }
  });

  test("duplicate elements are not trusted", () => {
    const wscript = "C:\\Windows\\System32\\wscript.exe";
    const launcher = "C:\\Users\\Test\\.opencodex\\service-launcher.vbs";
    const xml = buildWindowsTaskXml("ignored.cmd", launcher)
      .replace(/<Command>.*?<\/Command>/, `<Command>${wscript}</Command>`);
    const duplicated = xml.replace(
      "    <Enabled>true</Enabled>\n    <Hidden>",
      "    <Enabled>true</Enabled>\n    <Enabled>false</Enabled>\n    <Hidden>",
    );
    expect(windowsTaskRegistrationHealthy(duplicated, wscript, launcher)).toBe(false);
  });

  test("hidden launcher VBS stays resident and escapes quotes in the wrapper path", () => {
    const vbs = buildWindowsLauncherVbs('C:\\Users\\quo"te\\.opencodex\\opencodex-service.cmd');

    // windowStyle 0 (hidden) + bWaitOnReturn True (resident, so IgnoreNew and /end keep working).
    expect(vbs).toContain(", 0, True");
    expect(vbs).toContain('shell.Run """C:\\Users\\quo""te\\.opencodex\\opencodex-service.cmd""", 0, True');
    expect(vbs).toContain('CreateObject("WScript.Shell")');
  });

  test("hidden launcher VBS carries non-ASCII profile paths verbatim", () => {
    const vbs = buildWindowsLauncherVbs("C:\\Users\\한글사용자\\.opencodex\\opencodex-service.cmd");

    expect(vbs).toContain("C:\\Users\\한글사용자\\.opencodex\\opencodex-service.cmd");
  });

  test("writes the launcher VBS with a UTF-16 BOM so non-ASCII paths survive WSH decoding", async () => {
    const service = await Bun.file(new URL("../src/service.ts", import.meta.url)).text();

    expect(service).toContain('writeServiceAssetWithRetry(windowsLauncherVbsPath(), `\\uFEFF${buildWindowsLauncherVbs(script)}`, "utf16le")');
    // Uninstall must clean the launcher asset alongside the script and task XML.
    expect(service).toContain("if (existsSync(windowsLauncherVbsPath())) unlinkSync(windowsLauncherVbsPath());");
  });

  test("writes Task Scheduler XML with a UTF-16 BOM for schtasks", async () => {
    const service = await Bun.file(new URL("../src/service.ts", import.meta.url)).text();

    expect(service).toContain('writeServiceAssetWithRetry(windowsTaskXmlPath(), `\\uFEFF${buildWindowsTaskXml(script)}`, "utf16le")');
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
      bunRuntimeSource: "bundled",
      cli: "C:\\OpenCodex&Dir\\cli.ts",
    });

    expect(script).toContain('set "OCX_BUN=C:\\Bun&Dir\\100%%bun^^\\bun.exe"');
    expect(script).toContain('set "OCX_CLI=C:\\OpenCodex&Dir\\cli.ts"');
    expect(script).toContain('"%OCX_BUN%" "%OCX_CLI%" start --port');
    expect(script).not.toContain('"C:\\Bun&Dir\\100%bun^\\bun.exe"');
  });

  test("switches the wrapper console to UTF-8 and sleeps via ping (timeout dies without console stdin)", () => {
    const script = buildWindowsServiceScript({ bun: "C:\\OpenCodex\\bun.exe", bunRuntimeSource: "bundled", cli: "C:\\OpenCodex\\cli.ts" });

    expect(script).toContain("chcp 65001 >nul");
    expect(script.indexOf("chcp 65001 >nul")).toBeLessThan(script.indexOf('set "OCX_SERVICE=1"'));
    expect(script).toContain("ping -n 6 127.0.0.1 >nul");
    expect(script).not.toContain("timeout /t");
  });

  test("stops instead of restart-looping when an update removed the baked runtime or CLI (#1849)", () => {
    const script = buildWindowsServiceScript({
      bun: "C:\\OpenCodex\\bun.exe",
      bunRuntimeSource: "bundled",
      cli: "C:\\OpenCodex\\cli.ts",
    });
    const loopAt = script.indexOf(":loop");
    const bunCheckAt = script.indexOf('if not exist "%OCX_BUN%"');
    const cliCheckAt = script.indexOf('if not exist "%OCX_CLI%"');
    const launchAt = script.indexOf('"%OCX_BUN%" "%OCX_CLI%" start --port');
    const retryAt = script.indexOf("goto loop");

    expect(loopAt).toBeGreaterThanOrEqual(0);
    expect(bunCheckAt).toBeGreaterThan(loopAt);
    expect(cliCheckAt).toBeGreaterThan(bunCheckAt);
    expect(launchAt).toBeGreaterThan(cliCheckAt);
    expect(retryAt).toBeGreaterThan(launchAt);
    expect(script).toContain("installation is incomplete: bundled Bun is missing");
    expect(script).toContain("installation is incomplete: CLI entry is missing");
    expect(script.match(/exit \/b 3/g)).toHaveLength(2);
    // #1942: each missing-artifact branch first attempts a transactional-update backup
    // restore, then re-checks before the hard stop — 2 artifacts x (probe + recheck).
    expect(script.slice(loopAt, launchAt).match(/if not exist/g)).toHaveLength(4);
    expect(script).toContain(":restore_backup");
    expect(script).toContain(".ocx-backup-*");
  });

  test("rewrites profile-relative paths to env indirection so non-ASCII usernames survive OEM-codepage batch parsing", () => {
    const oldUserProfile = process.env.USERPROFILE;
    const oldAppData = process.env.APPDATA;
    try {
      process.env.USERPROFILE = "C:\\Users\\한글사용자";
      process.env.APPDATA = "C:\\Users\\한글사용자\\AppData\\Roaming";
      const script = buildWindowsServiceScript({
        bun: "C:\\Users\\한글사용자\\AppData\\Roaming\\npm\\node_modules\\bun\\bin\\bun.exe",
        bunRuntimeSource: "bundled",
        cli: "C:\\Users\\한글사용자\\AppData\\Roaming\\npm\\node_modules\\opencodex\\src\\cli.ts",
      });

      expect(script).toContain('set "OCX_BUN=%APPDATA%\\npm\\node_modules\\bun\\bin\\bun.exe"');
      expect(script).toContain('set "OCX_CLI=%APPDATA%\\npm\\node_modules\\opencodex\\src\\cli.ts"');
      expect(script).not.toContain('set "OCX_BUN=C:\\Users\\한글사용자');
    } finally {
      if (oldUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = oldUserProfile;
      if (oldAppData === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = oldAppData;
    }
  });

  test("writes token-safe startup identity and child output to the service log", () => {
    const oldCodexHome = process.env.CODEX_HOME;
    const oldCodexSqliteHome = process.env.CODEX_SQLITE_HOME;
    const oldOpenCodexHome = process.env.OPENCODEX_HOME;
    const oldApiAuthToken = process.env.OPENCODEX_API_AUTH_TOKEN;
    try {
      process.env.CODEX_HOME = "C:\\codex-home";
      process.env.CODEX_SQLITE_HOME = "C:\\codex-sqlite-home";
      process.env.OPENCODEX_HOME = TEST_DIR;
      process.env.OPENCODEX_API_AUTH_TOKEN = "local-secret";
      const script = buildWindowsServiceScript({
        bun: "C:\\OpenCodex\\bun.exe",
        bunRuntimeSource: "bundled",
        cli: "C:\\OpenCodex\\cli.ts",
      });

      expectTextToContainPath(script, serviceLogPath());
      expect(script).toContain('set "OCX_SERVICE_LOG=');
      expect(script).toContain("opencodex service wrapper start");
      expect(script).toContain('echo bun="%OCX_BUN%"');
      expect(script).toContain('echo bun_source="');
      expect(script).toContain('echo cli="%OCX_CLI%"');
      expect(script).toContain('echo opencodex_home="%OPENCODEX_HOME%"');
      expect(script).toContain('echo codex_home="%CODEX_HOME%"');
      expect(script).toContain('set "CODEX_SQLITE_HOME=C:\\codex-sqlite-home"');
      expect(script).toContain('echo token_file="%OCX_API_TOKEN_FILE%"');
      expect(script).toMatch(/"%OCX_BUN%" "%OCX_CLI%" start --port \d+ >>"%OCX_SERVICE_LOG%" 2>&1/);
      expect(script).toContain("child exited with code %ERRORLEVEL%");
      expect(script).not.toContain("local-secret");
      expect(script).not.toContain('set "OPENCODEX_API_AUTH_TOKEN=');
    } finally {
      if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = oldCodexHome;
      if (oldCodexSqliteHome === undefined) delete process.env.CODEX_SQLITE_HOME;
      else process.env.CODEX_SQLITE_HOME = oldCodexSqliteHome;
      if (oldOpenCodexHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = oldOpenCodexHome;
      if (oldApiAuthToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
      else process.env.OPENCODEX_API_AUTH_TOKEN = oldApiAuthToken;
    }
  });
});

describe("launchd service plist", () => {
  test("every durable launcher stamps the Bun provenance paired with the binary it baked (#848)", () => {
    const inheritedOverride = process.env.OPENCODEX_BUN_PATH;
    const inheritedSource = process.env.OCX_BUN_RUNTIME_SOURCE;
    const inheritedPath = process.env.OCX_BUN_RUNTIME_PATH;
    const overrideBun = join(TEST_DIR, "provenance-override-bun.exe");
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(overrideBun, "x".repeat(2 * 1024 * 1024));
    try {
      // OPENCODEX_BUN_PATH is consumed by the Node launcher before Bun can load a
      // project dotenv. Once Bun is running, an unpaired value is untrusted and
      // must never be persisted into a durable launcher.
      delete process.env.OCX_BUN_RUNTIME_SOURCE;
      delete process.env.OCX_BUN_RUNTIME_PATH;
      process.env.OPENCODEX_BUN_PATH = overrideBun;
      const plist = buildPlist();
      expect(plist).not.toContain("<key>OCX_BUN_RUNTIME_SOURCE</key><string>override</string>");
      expect(plist).not.toContain(overrideBun);

      const unit = buildUnit();
      expect(unit).not.toContain('Environment="OCX_BUN_RUNTIME_SOURCE=override"');
      expect(unit).not.toContain(overrideBun);

      const script = buildWindowsServiceScript();
      expect(script).not.toContain('set "OCX_BUN_RUNTIME_SOURCE=override"');
      expect(script).not.toContain(overrideBun);

      // A source/path pair stamped by the Node launcher is accepted only when it
      // names the Bun executable that is actually running this process.
      process.env.OCX_BUN_RUNTIME_SOURCE = "override";
      process.env.OCX_BUN_RUNTIME_PATH = process.execPath;
      const trustedPlist = buildPlist();
      expect(trustedPlist).toContain("<key>OCX_BUN_RUNTIME_SOURCE</key><string>override</string>");
      expectTextToContainPath(trustedPlist, process.execPath);
      expect(buildUnit()).toContain('Environment="OCX_BUN_RUNTIME_SOURCE=override"');
      expect(buildWindowsServiceScript()).toContain('set "OCX_BUN_RUNTIME_SOURCE=override"');
    } finally {
      if (inheritedOverride === undefined) delete process.env.OPENCODEX_BUN_PATH;
      else process.env.OPENCODEX_BUN_PATH = inheritedOverride;
      if (inheritedSource === undefined) delete process.env.OCX_BUN_RUNTIME_SOURCE;
      else process.env.OCX_BUN_RUNTIME_SOURCE = inheritedSource;
      if (inheritedPath === undefined) delete process.env.OCX_BUN_RUNTIME_PATH;
      else process.env.OCX_BUN_RUNTIME_PATH = inheritedPath;
    }
  });

  test("preserves custom Codex and OpenCodex homes", () => {
    const oldCodexHome = process.env.CODEX_HOME;
    const oldCodexSqliteHome = process.env.CODEX_SQLITE_HOME;
    const oldOpenCodexHome = process.env.OPENCODEX_HOME;
    const oldApiAuthToken = process.env.OPENCODEX_API_AUTH_TOKEN;
    try {
      process.env.CODEX_HOME = "/tmp/codex-home";
      process.env.CODEX_SQLITE_HOME = "/tmp/codex-sqlite-home";
      process.env.OPENCODEX_HOME = "/tmp/opencodex-home";
      process.env.OPENCODEX_API_AUTH_TOKEN = "local-secret";
      const plist = buildPlist();
      expect(plist).toContain("<key>CODEX_HOME</key><string>/tmp/codex-home</string>");
      expect(plist).toContain("<key>CODEX_SQLITE_HOME</key><string>/tmp/codex-sqlite-home</string>");
      expect(plist).toContain("<key>OPENCODEX_HOME</key><string>/tmp/opencodex-home</string>");
      expectTextToContainPath(plist, serviceApiTokenFilePath());
      expect(plist).not.toContain("local-secret");
      expect(plist).not.toContain("<key>OPENCODEX_API_AUTH_TOKEN</key>");
    } finally {
      if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = oldCodexHome;
      if (oldCodexSqliteHome === undefined) delete process.env.CODEX_SQLITE_HOME;
      else process.env.CODEX_SQLITE_HOME = oldCodexSqliteHome;
      if (oldOpenCodexHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = oldOpenCodexHome;
      if (oldApiAuthToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
      else process.env.OPENCODEX_API_AUTH_TOKEN = oldApiAuthToken;
    }
  });

  // A POSIX unit must carry the literal POSIX path no matter which host writes it. The two
  // cases above are where this actually bites: on a Windows host `resolve("/tmp/x")` anchors
  // to the current drive and the generated file said `D:\tmp\codex-sqlite-home`, while
  // CODEX_HOME beside it kept `/tmp/codex-home`. The same file disagreed with itself about two
  // variables holding the same kind of value. This states the rule directly so the intent
  // survives; on a POSIX host `resolve()` is identity here, so only Windows can catch it.
  test("carries an absolute POSIX sqlite home into POSIX units without host anchoring", () => {
    const inherited = process.env.CODEX_SQLITE_HOME;
    try {
      process.env.CODEX_SQLITE_HOME = "/var/lib/opencodex/codex-sqlite";

      expect(buildPlist()).toContain(
        "<key>CODEX_SQLITE_HOME</key><string>/var/lib/opencodex/codex-sqlite</string>",
      );
      expect(buildUnit()).toContain(
        'Environment="CODEX_SQLITE_HOME=/var/lib/opencodex/codex-sqlite"',
      );
    } finally {
      if (inherited === undefined) delete process.env.CODEX_SQLITE_HOME;
      else process.env.CODEX_SQLITE_HOME = inherited;
    }
  });

  // The relative case is why the resolve() is there at all: a service unit has no meaningful
  // working directory, so a relative home must still be made absolute.
  test("still absolutizes a relative sqlite home", () => {
    const inherited = process.env.CODEX_SQLITE_HOME;
    try {
      process.env.CODEX_SQLITE_HOME = "relative-sqlite-home";
      const plist = buildPlist();

      // Assert the emitted value is actually absolute. Rejecting only the raw string would
      // stay green for any other non-absolute transform, which is the whole thing this test
      // exists to catch. The two artifact formats differ, so each is extracted on its own
      // terms: launchd is XML, systemd is a quoted Environment= line.
      const plistValue = /<key>CODEX_SQLITE_HOME<\/key>\s*<string>([^<]*)<\/string>/.exec(plist)?.[1];
      expect(plistValue).toBeDefined();
      expect(
        isAbsolute(plistValue!) || posix.isAbsolute(plistValue!) || win32.isAbsolute(plistValue!),
      ).toBe(true);
      expect(plistValue!.endsWith("relative-sqlite-home")).toBe(true);

      const unit = buildUnit();
      const unitValue = /Environment="CODEX_SQLITE_HOME=([^"]*)"/.exec(unit)?.[1];
      expect(unitValue).toBeDefined();
      expect(
        isAbsolute(unitValue!) || posix.isAbsolute(unitValue!) || win32.isAbsolute(unitValue!),
      ).toBe(true);
      expect(unitValue!.endsWith("relative-sqlite-home")).toBe(true);
    } finally {
      if (inherited === undefined) delete process.env.CODEX_SQLITE_HOME;
      else process.env.CODEX_SQLITE_HOME = inherited;
    }
  });
});

describe("service lifecycle cleanup ordering", () => {
  test("native service switch treats unknown as installed and requires confirmed absence", () => {
    const calls: string[] = [];
    const statuses: Array<"unknown" | "stopped" | "nonexistent"> = [
      "unknown",
      "stopped",
      "unknown",
      "nonexistent",
    ];
    removeNativeWindowsServiceForScheduler({
      status: () => {
        calls.push("status");
        return statuses.shift() ?? "nonexistent";
      },
      uninstall: () => { calls.push("uninstall"); },
      sleep: () => { calls.push("sleep"); },
    });
    expect(calls).toEqual([
      "status",
      "uninstall",
      "status",
      "sleep",
      "status",
      "sleep",
      "status",
    ]);

    expect(() => removeNativeWindowsServiceForScheduler({
      status: () => "stopped",
      uninstall: () => {},
      sleep: () => {},
      settleChecks: 3,
    })).toThrow(/could not be re-verified/);
  });

  const registrationAttemptNonce = "service-test-attempt";

  test("rollback preserves a task owned by another install attempt and reports residual state", async () => {
    const deleteCalls: string[] = [];
    const rollbackOwned = (serviceModule as unknown as {
      rollbackWindowsSchedulerTaskOwnedByAttempt: (
        attemptNonce: string,
        taskName: string,
        deps: {
          queryXml: () => string;
          deleteTask: () => Promise<void>;
          probe: () => { status: "absent" | "present" | "unknown"; detail: string };
        },
      ) => Promise<string | null>;
    }).rollbackWindowsSchedulerTaskOwnedByAttempt;

    const result = await rollbackOwned("attempt-a", "opencodex-proxy", {
      queryXml: () => buildWindowsTaskXml("ignored.cmd", "launcher.vbs", "attempt-b"),
      deleteTask: async () => { deleteCalls.push("delete"); },
      probe: () => ({ status: "present", detail: "present" }),
    });

    expect(deleteCalls).toEqual([]);
    expect(result).toContain("ownership could not be proven");
    expect(result).toContain("Residual scheduler state: task opencodex-proxy remains registered");
  });

  test("rollback deletes a task carrying this install attempt's nonce", async () => {
    const deleteCalls: string[] = [];
    const rollbackOwned = (serviceModule as unknown as {
      rollbackWindowsSchedulerTaskOwnedByAttempt: (
        attemptNonce: string,
        taskName: string,
        deps: {
          queryXml: () => string;
          deleteTask: () => Promise<void>;
          probe: () => { status: "absent" | "present" | "unknown"; detail: string };
        },
      ) => Promise<string | null>;
    }).rollbackWindowsSchedulerTaskOwnedByAttempt;

    const result = await rollbackOwned("attempt-a", "opencodex-proxy", {
      queryXml: () => buildWindowsTaskXml("ignored.cmd", "launcher.vbs", "attempt-a"),
      deleteTask: async () => { deleteCalls.push("delete"); },
      probe: () => ({ status: "absent", detail: "absent" }),
    });

    expect(deleteCalls).toEqual(["delete"]);
    expect(result).toBeNull();
  });

  test("fresh registration elevates only the fixed create after a structured denial", async () => {
    const calls: string[] = [];
    const parent = mkdtempSync(join(tmpdir(), "ocx-service-fixed-create-"));
    const stagedXml = join(parent, "attempt.xml");
    const expectedArgs = buildWindowsSchtasksCreateArgsForXml(stagedXml);
    const expectedXml = buildWindowsTaskXml(undefined, undefined, registrationAttemptNonce);
    try {
      writeFileSync(stagedXml, `\uFEFF${expectedXml}`, "utf16le");
      await registerFreshWindowsSchedulerTask(stagedXml, registrationAttemptNonce, {
        create: args => {
          calls.push(`create:${args.join(" ")}`);
          throw new WindowsSchtasksError("create", "access-denied", "denied");
        },
        elevate: async (taskName, xml) => {
          calls.push(`elevate:${taskName}`);
          expect(xml).toBe(expectedXml.trimEnd());
        },
        probe: () => ({ status: "present", detail: "present" }),
        queryXml: () => expectedXml,
        rollback: async () => { calls.push("rollback"); return null; },
      });

      expect(calls).toEqual([
        `create:${expectedArgs.join(" ")}`,
        "elevate:opencodex-proxy",
      ]);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("fresh registration UAC denial returns before task probing or cleanup", async () => {
    const calls: string[] = [];
    const parent = mkdtempSync(join(tmpdir(), "ocx-service-uac-denial-"));
    const stagedXml = join(parent, "attempt.xml");
    try {
      writeFileSync(stagedXml, `\uFEFF${buildWindowsTaskXml(undefined, undefined, registrationAttemptNonce)}`, "utf16le");
      await expect(registerFreshWindowsSchedulerTask(stagedXml, registrationAttemptNonce, {
        create: () => {
          calls.push("create");
          throw new WindowsSchtasksError("create", "access-denied", "denied");
        },
        elevate: async () => { calls.push("elevate"); throw new Error("UAC cancelled"); },
        probe: () => { calls.push("probe"); return { status: "present", detail: "present" }; },
        queryXml: () => { calls.push("query"); return buildWindowsTaskXml(undefined, undefined, registrationAttemptNonce); },
        rollback: async () => { calls.push("rollback"); return null; },
      })).rejects.toThrow("UAC cancelled");

      expect(calls).toEqual(["create", "elevate"]);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("fresh registration never elevates an unstructured scheduler failure", async () => {
    const calls: string[] = [];
    const parent = mkdtempSync(join(tmpdir(), "ocx-service-unstructured-"));
    const stagedXml = join(parent, "attempt.xml");
    try {
      writeFileSync(stagedXml, `\uFEFF${buildWindowsTaskXml(undefined, undefined, registrationAttemptNonce)}`, "utf16le");
      await expect(registerFreshWindowsSchedulerTask(stagedXml, registrationAttemptNonce, {
        create: () => { calls.push("create"); throw new Error("scheduler unavailable"); },
        elevate: async () => { calls.push("elevate"); },
        probe: () => { calls.push("probe"); return { status: "present", detail: "present" }; },
        queryXml: () => buildWindowsTaskXml(undefined, undefined, registrationAttemptNonce),
        rollback: async () => { calls.push("rollback"); return null; },
      })).rejects.toThrow("scheduler unavailable");

      expect(calls).toEqual(["create"]);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("create success followed by proven absence does not request a pointless rollback UAC", async () => {
    const calls: string[] = [];
    const parent = mkdtempSync(join(tmpdir(), "ocx-service-proven-absence-"));
    const stagedXml = join(parent, "attempt.xml");
    try {
      writeFileSync(stagedXml, `\uFEFF${buildWindowsTaskXml(undefined, undefined, registrationAttemptNonce)}`, "utf16le");
      await expect(registerFreshWindowsSchedulerTask(stagedXml, registrationAttemptNonce, {
        create: () => { calls.push("create"); },
        elevate: async () => { calls.push("elevate"); },
        probe: () => { calls.push("probe"); return { status: "absent", detail: "absent" }; },
        queryXml: () => { calls.push("query"); return buildWindowsTaskXml(undefined, undefined, registrationAttemptNonce); },
        rollback: async () => { calls.push("rollback"); return null; },
      })).rejects.toThrow(/registration is absent/);

      expect(calls).toEqual(["create", "probe"]);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("fresh registration requires the live Task Scheduler XML before cleanup can begin", async () => {
    const calls: string[] = [];
    const parent = mkdtempSync(join(tmpdir(), "ocx-service-live-xml-"));
    const xml = join(parent, "attempt.xml");
    try {
      writeFileSync(xml, `\uFEFF${buildWindowsTaskXml(undefined, undefined, registrationAttemptNonce)}`, "utf16le");
      await expect(registerFreshWindowsSchedulerTask(xml, registrationAttemptNonce, {
        create: () => { calls.push("create"); },
        probe: () => { calls.push("probe"); return { status: "present", detail: "present" }; },
        queryXml: () => { calls.push("query"); throw new Error("query denied"); },
        rollback: async () => { calls.push("rollback"); return null; },
      })).rejects.toThrow(/live XML could not be verified/);

      expect(calls).toEqual(["create", "probe", "query", "rollback"]);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("fresh registration elevation uses captured XML bytes after the staged file changes", async () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-service-elevated-xml-"));
    const xmlPath = join(parent, "attempt.xml");
    const originalXml = buildWindowsTaskXml(undefined, undefined, registrationAttemptNonce);
    const foreignXml = buildWindowsTaskXml("C:\\foreign.cmd", undefined, "foreign-attempt");
    let elevatedXml = "";
    try {
      writeFileSync(xmlPath, `\uFEFF${originalXml}`, "utf16le");
      await registerFreshWindowsSchedulerTask(xmlPath, registrationAttemptNonce, {
        create: () => {
          writeFileSync(xmlPath, `\uFEFF${foreignXml}`, "utf16le");
          throw new WindowsSchtasksError("create", "access-denied", "denied");
        },
        elevate: async (taskName, xml) => {
          expect(taskName).toBe("opencodex-proxy");
          elevatedXml = xml;
        },
        probe: () => ({ status: "present", detail: "present" }),
        queryXml: () => originalXml,
        rollback: async () => null,
      });

      expect(elevatedXml).toContain(`install-attempt=${registrationAttemptNonce}`);
      expect(elevatedXml).not.toContain("foreign-attempt");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("fresh registration rejects a staged definition owned by another attempt before create", async () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-service-foreign-stage-"));
    const xmlPath = join(parent, "attempt.xml");
    const calls: string[] = [];
    try {
      writeFileSync(
        xmlPath,
        `\uFEFF${buildWindowsTaskXml(undefined, undefined, "foreign-attempt")}`,
        "utf16le",
      );
      await expect(registerFreshWindowsSchedulerTask(xmlPath, registrationAttemptNonce, {
        create: () => { calls.push("create"); },
        elevate: async () => { calls.push("elevate"); },
        probe: () => { calls.push("probe"); return { status: "present", detail: "present" }; },
        queryXml: () => { calls.push("query"); return ""; },
        rollback: async () => { calls.push("rollback"); return null; },
      })).rejects.toThrow(/ownership or shape validation/);

      expect(calls).toEqual([]);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("fresh Windows scheduler install gets registration approval before destructive cleanup", async () => {
    const calls: string[] = [];
    let stagedNonce = "";
    await installFreshWindowsSchedulerSafely({
      stageRegistrationXml: nonce => { stagedNonce = nonce; calls.push("stage"); return "attempt.xml"; },
      register: async (path, nonce) => {
        expect(nonce).toBe(stagedNonce);
        calls.push(`register:${path}`);
      },
      recordOwnership: () => { calls.push("record-ownership"); return true; },
      prepare: async () => { calls.push("prepare:stop-managers-and-proxy"); },
      removeNativeService: () => { calls.push("remove-native-service"); },
      publishAssets: () => { calls.push("publish-assets"); },
      runTask: () => { calls.push("run-task"); },
      writeState: () => { calls.push("write-state"); },
      rollbackTask: async () => { calls.push("rollback-task"); return null; },
      removeStagedXml: path => { calls.push(`remove:${path}`); },
    });

    expect(calls).toEqual([
      "stage",
      "register:attempt.xml",
      "remove:attempt.xml",
      "record-ownership",
      "prepare:stop-managers-and-proxy",
      "remove-native-service",
      "publish-assets",
      "run-task",
      "write-state",
    ]);
    expect(stagedNonce).not.toBe("");
  });

  test("fresh scheduler staging hardens its private directory and XML before registration", async () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-service-stage-order-"));
    const stageDir = join(parent, "private-stage");
    const calls: string[] = [];
    try {
      await installFreshWindowsSchedulerSafely({
        stageRegistrationXml: nonce => serviceModule.stageWindowsSchedulerRegistrationXml(nonce, {
          createStageDir: () => {
            mkdirSync(stageDir, { mode: 0o700 });
            calls.push("create-stage-dir");
            return stageDir;
          },
          hardenDir: () => { calls.push("harden-dir"); },
          writeXml: (path, contents) => {
            calls.push("write-xml");
            writeFileSync(path, contents, { encoding: "utf16le", flag: "wx" });
          },
          hardenPath: () => { calls.push("harden-xml"); },
        }),
        register: async path => {
          calls.push("register");
          expect(existsSync(path)).toBe(true);
        },
        recordOwnership: () => true,
        prepare: async () => {},
        removeNativeService: () => {},
        publishAssets: () => {},
        runTask: () => {},
        writeState: () => {},
        rollbackTask: async () => null,
      });

      expect(calls).toEqual([
        "create-stage-dir",
        "harden-dir",
        "write-xml",
        "harden-xml",
        "register",
      ]);
      expect(existsSync(stageDir)).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("fresh scheduler staging removes a partially-written private directory on failure", () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-service-stage-failure-"));
    const stageDir = join(parent, "private-stage");
    try {
      expect(() => serviceModule.stageWindowsSchedulerRegistrationXml("attempt", {
        createStageDir: () => {
          mkdirSync(stageDir, { mode: 0o700 });
          return stageDir;
        },
        hardenDir: () => {},
        writeXml: (path, contents) => {
          writeFileSync(path, contents, "utf16le");
          throw new Error("synthetic partial write failure");
        },
        hardenPath: () => { throw new Error("must not harden after write failure"); },
      })).toThrow("synthetic partial write failure");
      expect(existsSync(stageDir)).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("UAC cancellation removes only staged XML and never enters cleanup or asset publication", async () => {
    const calls: string[] = [];
    mkdirSync(TEST_DIR, { recursive: true });
    const routingPath = join(TEST_DIR, "config.toml");
    const routingBefore = 'openai_base_url = "http://127.0.0.1:10100/v1"\nmodel_catalog_json = "keep.json"\n';
    writeFileSync(routingPath, routingBefore, "utf8");
    await expect(installFreshWindowsSchedulerSafely({
      stageRegistrationXml: () => { calls.push("stage"); return "attempt.xml"; },
      register: async path => {
        calls.push(`register:${path}`);
        throw new Error("UAC prompt was cancelled");
      },
      recordOwnership: () => { calls.push("record-ownership"); return true; },
      prepare: async () => { calls.push("prepare"); },
      removeNativeService: () => { calls.push("remove-native-service"); },
      publishAssets: () => { calls.push("publish-assets"); },
      runTask: () => { calls.push("run-task"); },
      writeState: () => { calls.push("write-state"); },
      rollbackTask: async () => { calls.push("rollback-task"); return null; },
      removeStagedXml: path => { calls.push(`remove:${path}`); },
    })).rejects.toThrow("UAC prompt was cancelled");

    expect(calls).toEqual([
      "stage",
      "register:attempt.xml",
      "remove:attempt.xml",
    ]);
    expect(readFileSync(routingPath, "utf8")).toBe(routingBefore);
  });

  test("a pre-run commit failure rolls back only the newly-created registration", async () => {
    const calls: string[] = [];
    await expect(installFreshWindowsSchedulerSafely({
      stageRegistrationXml: () => "attempt.xml",
      register: async () => { calls.push("register"); },
      recordOwnership: () => { calls.push("record-ownership"); return true; },
      prepare: async () => { calls.push("prepare"); throw new Error("standalone stop failed"); },
      removeNativeService: () => { calls.push("remove-native-service"); },
      publishAssets: () => { calls.push("publish-assets"); },
      runTask: () => { calls.push("run-task"); },
      writeState: () => { calls.push("write-state"); },
      rollbackTask: async () => { calls.push("rollback-task"); return null; },
      removeStagedXml: () => { calls.push("remove-stage"); },
    })).rejects.toThrow(/previous proxy\/routing state was not assumed restored/);

    expect(calls).toEqual(["register", "remove-stage", "record-ownership", "prepare", "rollback-task"]);
  });

  test("fresh scheduler install rolls back before publication when native service removal fails", async () => {
    const calls: string[] = [];
    await expect(installFreshWindowsSchedulerSafely({
      stageRegistrationXml: () => "attempt.xml",
      register: async () => { calls.push("register"); },
      recordOwnership: () => { calls.push("record-ownership"); return true; },
      prepare: async () => { calls.push("prepare"); },
      removeNativeService: () => { calls.push("remove-native-service"); throw new Error("native service remains"); },
      publishAssets: () => { calls.push("publish-assets"); },
      runTask: () => { calls.push("run-task"); },
      writeState: () => { calls.push("write-state"); },
      rollbackTask: async () => { calls.push("rollback-task"); return null; },
      removeStagedXml: () => { calls.push("remove-stage"); },
    })).rejects.toThrow("native service remains");

    expect(calls).toEqual([
      "register",
      "remove-stage",
      "record-ownership",
      "prepare",
      "remove-native-service",
      "rollback-task",
    ]);
  });

  test("fresh scheduler install removes staging before initializing config ownership", async () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-service-fresh-ownership-"));
    const home = join(parent, "config");
    const previousHome = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = home;
    let stagedPath = "";
    try {
      // Seed the exact stale-null lifecycle: a conservative legacy refusal is cached,
      // then the same root is deleted before this long-lived process installs fresh.
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, "legacy.txt"), "keep", "utf8");
      expect(recordOwnedConfigPath(home, join(home, "service-state.json"))).toBe(false);
      rmSync(home, { recursive: true, force: true });

      await installFreshWindowsSchedulerSafely({
        register: async path => {
          stagedPath = path;
          expect(existsSync(path)).toBe(true);
          expect(path.startsWith(tmpdir())).toBe(true);
          expect(existsSync(home)).toBe(false);
        },
        prepare: async () => {},
        removeNativeService: () => {},
        publishAssets: () => {},
        runTask: () => {},
        writeState: () => {},
        rollbackTask: async () => null,
      });

      expect(stagedPath.startsWith(home)).toBe(false);
      expect(existsSync(stagedPath)).toBe(false);
      expect(existsSync(join(stagedPath, ".."))).toBe(false);
      expect(JSON.parse(readFileSync(join(home, CONFIG_OWNER_FILE), "utf8"))).toMatchObject({ version: 1 });
      const manifest = JSON.parse(readFileSync(join(home, CONFIG_UNINSTALL_MANIFEST), "utf8")) as { paths: string[] };
      expect(manifest.paths).toContain("service-state.json");
      expect(removeOwnedConfigState(home)).toEqual({ status: "removed", residualPaths: [] });
      expect(existsSync(home)).toBe(false);
    } finally {
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      removeOwnedConfigState(home);
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("fresh scheduler install rolls back before cleanup when a new config root cannot be claimed", async () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-service-ownership-race-"));
    const home = join(parent, "config");
    const foreign = join(home, "foreign.txt");
    const calls: string[] = [];
    const previousHome = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = home;
    let stagedPath = "";
    try {
      await expect(installFreshWindowsSchedulerSafely({
        register: async path => {
          stagedPath = path;
          calls.push("register");
          mkdirSync(home, { recursive: true });
          writeFileSync(foreign, "keep", "utf8");
        },
        prepare: async () => { calls.push("prepare"); },
        removeNativeService: () => { calls.push("remove-native-service"); },
        publishAssets: () => { calls.push("publish-assets"); },
        runTask: () => { calls.push("run-task"); },
        writeState: () => { calls.push("write-state"); },
        rollbackTask: async () => { calls.push("rollback-task"); return null; },
      })).rejects.toThrow(/fresh OpenCodex config root could not be claimed/);

      expect(calls).toEqual(["register", "rollback-task"]);
      expect(readFileSync(foreign, "utf8")).toBe("keep");
      expect(existsSync(join(home, CONFIG_OWNER_FILE))).toBe(false);
      expect(existsSync(join(home, CONFIG_UNINSTALL_MANIFEST))).toBe(false);
      expect(existsSync(stagedPath)).toBe(false);
    } finally {
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      removeOwnedConfigState(home);
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("a state-write failure leaves the already-started task for explicit diagnosis", async () => {
    const calls: string[] = [];
    await expect(installFreshWindowsSchedulerSafely({
      stageRegistrationXml: () => "attempt.xml",
      register: async () => { calls.push("register"); },
      recordOwnership: () => { calls.push("record-ownership"); return true; },
      prepare: async () => { calls.push("prepare"); },
      removeNativeService: () => { calls.push("remove-native-service"); },
      publishAssets: () => { calls.push("publish-assets"); },
      runTask: () => { calls.push("run-task"); },
      writeState: () => { calls.push("write-state"); throw new Error("state write failed"); },
      rollbackTask: async () => { calls.push("rollback-task"); return null; },
      removeStagedXml: () => { calls.push("remove-stage"); },
    })).rejects.toThrow(/task was left in place/);

    expect(calls).toEqual([
      "register",
      "remove-stage",
      "record-ownership",
      "prepare",
      "remove-native-service",
      "publish-assets",
      "run-task",
      "write-state",
    ]);
  });

  test("service install stops the recorded backend, requested backend, and standalone before loading assets", async () => {
    const calls: string[] = [];
    const managerOps = (backend: "scheduler" | "native") => ({
      status: () => { calls.push(`status:${backend}`); return "present"; },
      stop: () => { calls.push(`stop:${backend}`); },
    });
    await installServiceSafely("native", () => { calls.push("install:native"); }, {
      platform: "win32",
      diagnose: () => ({ supported: true, installed: true, enabled: true, running: true, viable: true, startable: true, stale: false, conflict: false, backend: "scheduler", summary: "test" }),
      managerOps,
      stopTrackedProxy: async () => { calls.push("stop:standalone"); },
    });
    expect(calls).toEqual([
      "status:scheduler", "stop:scheduler",
      "status:native", "stop:native",
      "stop:standalone", "install:native",
    ]);
  });

  test("service install fails closed before install on manager or standalone cleanup errors", async () => {
    for (const failure of ["status", "stop", "standalone"] as const) {
      let installed = false;
      const run = installServiceSafely("scheduler", () => { installed = true; }, {
        platform: "win32",
        diagnose: () => ({ supported: true, installed: true, enabled: true, running: true, viable: true, startable: true, stale: false, conflict: false, backend: "scheduler", summary: "test" }),
        managerOps: () => ({
          status: () => {
            if (failure === "status") throw new Error("status failed");
            return "present";
          },
          stop: () => {
            if (failure === "stop") throw new Error("stop failed");
          },
        }),
        stopTrackedProxy: async () => {
          if (failure === "standalone") throw new Error("standalone failed");
        },
      });
      await expect(run).rejects.toThrow(`${failure} failed`);
      expect(installed).toBe(false);
    }
  });

  test("conflicting Windows install preparation stops both managers", async () => {
    const stopped: string[] = [];
    await prepareServiceInstall("scheduler", {
      platform: "win32",
      diagnose: () => ({ supported: true, installed: true, enabled: true, running: true, viable: false, startable: false, stale: false, conflict: true, backend: "scheduler", summary: "test" }),
      managerOps: backend => ({ status: () => "present", stop: () => { stopped.push(backend); } }),
      stopTrackedProxy: async () => {},
    });
    expect(stopped).toEqual(["scheduler", "native"]);
  });

  test("direct service stop kills the tracked proxy before restoring native Codex", async () => {
    const service = await readText("src/service.ts");
    const stopCase = service.slice(service.indexOf('case "stop":'), service.indexOf('case "status":'));

    expect(stopCase).toContain("ops.stop();");
    expect(stopCase).toContain("await stopTrackedProxyForServiceCommand();");
    expect(stopCase).toContain("restoreNativeCodexAsync();");
    expect(stopCase.indexOf("ops.stop();")).toBeLessThan(stopCase.indexOf("stopTrackedProxyForServiceCommand();"));
    expect(stopCase.indexOf("stopTrackedProxyForServiceCommand();")).toBeLessThan(stopCase.indexOf("restoreNativeCodexAsync();"));
  });

  test("direct service uninstall kills the tracked proxy before deleting service assets", async () => {
    const service = await readText("src/service.ts");
    const uninstallCase = service.slice(service.indexOf('case "uninstall":'), service.indexOf("default:"));

    expect(uninstallCase).toContain("ops.stop();");
    expect(uninstallCase).toContain("await stopTrackedProxyForServiceCommand();");
    expect(uninstallCase).toContain("ops.uninstall();");
    expect(uninstallCase).toContain("restoreNativeCodexAsync();");
    expect(uninstallCase.indexOf("ops.stop();")).toBeLessThan(uninstallCase.indexOf("stopTrackedProxyForServiceCommand();"));
    expect(uninstallCase.indexOf("stopTrackedProxyForServiceCommand();")).toBeLessThan(uninstallCase.indexOf("ops.uninstall();"));
    expect(uninstallCase.indexOf("ops.uninstall();")).toBeLessThan(uninstallCase.indexOf("restoreNativeCodexAsync();"));
  });

  test("Windows service install ends the running task before rewriting its assets, with write retry", async () => {
    const service = await readText("src/service.ts");
    const assetsHelper = service.slice(
      service.indexOf("function writeWindowsSchedulerAssets()"),
      service.indexOf("function installWindows()"),
    );
    const installWindows = service.slice(service.indexOf("function installWindows()"), service.indexOf("async function installWindowsNative()"));

    const stopAt = installWindows.indexOf("stopWindows();");
    const assetsAt = installWindows.indexOf("writeWindowsSchedulerAssets();");
    const createAt = installWindows.indexOf("buildWindowsSchtasksCreateArgs");
    expect(stopAt).toBeGreaterThan(-1);
    expect(assetsAt).toBeGreaterThan(-1);
    expect(createAt).toBeGreaterThan(-1);
    expect(stopAt).toBeLessThan(assetsAt);
    expect(assetsAt).toBeLessThan(createAt);
    expect(installWindows).not.toContain("writeFileSync(script");
    expect(assetsHelper).toContain("writeServiceAssetWithRetry(script");
    expect(assetsHelper).toContain("writeServiceAssetWithRetry(windowsTaskXmlPath()");
    // Retry helper tolerates transient Windows file locks from the just-ended task.
    expect(service).toContain('code !== "EBUSY" && code !== "EPERM" && code !== "EACCES"');
  });

  test("fresh Windows scheduler wiring selects the pre-registration transaction", async () => {
    const service = await readText("src/service.ts");
    const installCase = service.slice(service.indexOf('case "install":'), service.indexOf('case "start":'));
    expect(installCase).toContain('scheduler.status === "absent"');
    expect(installCase).toContain("await installFreshWindowsSchedulerSafely()");
    expect(installCase.indexOf('scheduler.status === "absent"')).toBeLessThan(
      installCase.indexOf("await installFreshWindowsSchedulerSafely()"),
    );
  });

  test("Windows service uninstall verifies task deletion before removing assets", async () => {
    const service = await readText("src/service.ts");
    const uninstallWindows = service.slice(service.indexOf("function uninstallWindows()"), service.indexOf("function serviceDiagnosticsSummary()"));

    expect(uninstallWindows).toContain("probeWindowsSchedulerTask(TASK)");
    expect(uninstallWindows).toContain("windowsServiceScriptPath()");
    expect(uninstallWindows).toContain("windowsTaskXmlPath()");
    expect(uninstallWindows).toContain("unlinkSync(windowsTaskXmlPath())");
    expect(uninstallWindows).toContain("refusing to remove service assets");
  });

  test("service cleanup falls back to findLiveProxy and clears the pid file", async () => {
    const service = await readText("src/service.ts");

    expect(service).toContain('verifyPidIdentity');
    expect(service).toContain("removeRuntimePort(pid);");
    expect(service).toContain('import { isProcessAlive, stopProxy } from "./lib/process-control";');
    expect(service).toContain('import { findLiveProxy, proxyIdentityAt, SERVICE_STOP_LIVENESS } from "./server/proxy-liveness";');
    expect(service).toContain('type TrackedProxyCleanupResult = "none" | "stale" | "stopped";');
    expect(service).toContain("async function stopTrackedProxyIfRunning(): Promise<TrackedProxyCleanupResult>");
    expect(service).toContain("...SERVICE_STOP_LIVENESS");
    expect(service).toContain("deadlineAt:");
    expect(service).toContain("SERVICE_STOP_LIVENESS");
    expect(service).toContain("await stopProxy(trackedKillPid);");
    expect(service).toContain("await stopProxy(liveKillPid);");
    expect(service).toContain("removePid(pid);");
    expect(service).toContain('return "stopped";');
  });


  test("Windows scheduler stop does not wait on schtasks /end failure", async () => {
    const service = await readText("src/service.ts");
    const stopCase = service.slice(service.indexOf('case "stop":'), service.indexOf('case "status":'));
    // #764 is an /end that succeeds while the wrapper respawns; waiting only when
    // /end errors cannot catch that path. Restart-window polling is proxyStillLiveAfterStop.
    expect(stopCase).not.toContain("WINDOWS_SCHEDULER_WRAPPER_RESTART_MS");
    expect(stopCase).not.toContain("schedulerEndOk");
    expect(stopCase).not.toContain("await Bun.sleep(");
    expect(stopCase).toContain("await proxyStillLiveAfterStop()");
  });

  test("tracked proxy cleanup verifies health-reported pids before stopProxy", async () => {
    const service = await readText("src/service.ts");
    expect(service).toContain("function verifiedKillTarget(pid: number | null | undefined): number | null");
    expect(service).toContain("const liveKillPid = verifiedKillTarget(live?.pid);");
    expect(service).toContain("const trackedKillPid = verifiedKillTarget(pid);");
  });
  test("service stop refuses success while the proxy is still live", async () => {
    const service = await readText("src/service.ts");
    const stopCase = service.slice(service.indexOf('case "stop":'), service.indexOf('case "status":'));
    expect(stopCase).toContain("await proxyStillLiveAfterStop()");
    expect(stopCase).toContain("a proxy is still listening on port");
    expect(stopCase).toContain("Native Codex was NOT restored");
    expect(stopCase).toContain("process.exitCode = 1");
  });

  test("native install refuses Microsoft-account logins before removing the scheduler backend", async () => {
    const service = await readText("src/service.ts");
    const installNative = service.slice(service.indexOf("async function installWindowsNative()"), service.indexOf("function startWindows()"));
    expect(installNative.indexOf("assertWindowsNativeServiceAccountSupported()")).toBeLessThan(installNative.indexOf("uninstallWindows()"));
    expect(service).toContain("Microsoft-account Windows login");
  });

  test("service command cleanup logs kill failures without skipping restore/delete", async () => {
    const service = await readText("src/service.ts");

    expect(service).toContain("async function stopTrackedProxyForServiceCommand(): Promise<TrackedProxyCleanupResult>");
    expect(service).toContain("catch (err)");
    expect(service).toContain("Failed to stop proxy");
    expect(service).toContain('return "none";');
  });
});

describe("service diagnostics", () => {
  // deriveWindowsServiceDiagnostic now reads the registration XML itself, so these
  // helpers express the old boolean fixtures as the documents that produce them.
  // buildWindowsTaskXml() emits exactly the Command/Arguments the validator expects
  // when both use the same defaults, so the fixture leaves the launcher default alone.
  const healthyTaskXml = () => buildWindowsTaskXml();
  /** Registered but reporting an explicitly disabled task. */
  const disabledTaskXml = () => healthyTaskXml()
    .replace("<Enabled>true</Enabled>\n    <Hidden>", "<Enabled>false</Enabled>\n    <Hidden>");

  const base = {
    schedulerXml: "",
    schedulerAssetsPresent: true,
    nativeStatus: "nonexistent" as const,
    recordedBackend: null,
    staleBakedPaths: false,
    nativeRepairAssetsOnly: false,
    diagnostics: "logs: test",
  };
  const installedEnabled = { schedulerXml: healthyTaskXml() };
  const installedDisabled = { schedulerXml: disabledTaskXml() };

  test("fails closed for disabled, stale, conflicting, stopped, and ghost Windows services", () => {
    expect(deriveWindowsServiceDiagnostic({ ...base, ...installedEnabled, recordedBackend: "scheduler" })).toMatchObject({ viable: true, backend: "scheduler" });
    expect(deriveWindowsServiceDiagnostic({ ...base, ...installedDisabled })).toMatchObject({ viable: false, enabled: false });
    expect(deriveWindowsServiceDiagnostic({ ...base, ...installedEnabled, staleBakedPaths: true })).toMatchObject({ viable: false, stale: true });
    expect(deriveWindowsServiceDiagnostic({ ...base, ...installedEnabled, nativeStatus: "started" })).toMatchObject({ viable: false, conflict: true });
    expect(deriveWindowsServiceDiagnostic({ ...base, nativeStatus: "stopped" })).toMatchObject({ installed: true, viable: false, startable: false, stale: true, running: false });
    expect(deriveWindowsServiceDiagnostic({ ...base, nativeRepairAssetsOnly: true })).toMatchObject({ installed: false, viable: false, stale: true });
    // Missing on-disk assets while the task remains registered — the post-update status line.
    const missingAssets = deriveWindowsServiceDiagnostic({
      ...base,
      ...installedEnabled,
      recordedBackend: "scheduler",
      schedulerAssetsPresent: false,
    });
    expect(missingAssets).toMatchObject({ installed: true, viable: false, stale: true, startable: false });
    expect(missingAssets.summary).toContain("stale or missing service assets");
  });

  test("a stopped healthy WinSW service remains startable from the tray", () => {
    const stoppedNative = deriveWindowsServiceDiagnostic({ ...base, nativeStatus: "stopped", recordedBackend: "native" });
    expect(serviceStartableFromTray(stoppedNative)).toBe(true);
    expect(serviceStartableFromTray({ ...stoppedNative, stale: true })).toBe(false);
    expect(serviceStartableFromTray({ ...stoppedNative, conflict: true })).toBe(false);
    expect(serviceStartableFromTray(deriveWindowsServiceDiagnostic({ ...base, nativeStatus: "unknown" }))).toBe(false);
    const disabledScheduler = deriveWindowsServiceDiagnostic({ ...base, ...installedDisabled });
    expect(serviceStartableFromTray(disabledScheduler)).toBe(false);
    const mismatchedScheduler = deriveWindowsServiceDiagnostic({
      ...base,
      ...installedEnabled,
      recordedBackend: "native",
    });
    expect(mismatchedScheduler).toMatchObject({ backend: "scheduler", stale: true, viable: false, startable: false });
  });

  test("rejects malformed service backend state instead of defaulting it to scheduler", () => {
    const valid = {
      version: 2,
      codexHome: "C:\\codex",
      opencodexHome: "C:\\opencodex",
      backend: "scheduler",
    };
    expect(parseServiceInstallState(valid)?.backend).toBe("scheduler");
    expect(parseServiceInstallState({ ...valid, backend: "garbage" })).toBeNull();
    expect(parseServiceInstallState({ ...valid, backend: undefined })).toBeNull();
    expect(parseServiceInstallState({ ...valid, version: 1, backend: "scheduler" })).toBeNull();
    expect(parseServiceInstallState({ ...valid, version: 1, backend: undefined })?.version).toBe(1);
  });

  test("status summary exposes the service log path", () => {
    const summary = serviceStatusSummary();

    expectTextToContainPath(summary, serviceLogPath());
  });

  test("flags stale baked service paths recorded at install time", () => {
    const oldOpenCodexHome = process.env.OPENCODEX_HOME;
    const stateDir = join(TEST_DIR, "baked-paths-home");
    try {
      process.env.OPENCODEX_HOME = stateDir;
      mkdirSync(stateDir, { recursive: true });
      const statePath = join(stateDir, "service-state.json");

      const missing = join(stateDir, "gone", "bun");
      writeFileSync(statePath, JSON.stringify({
        version: 1,
        codexHome: stateDir,
        opencodexHome: stateDir,
        bunPath: missing,
        cliPath: join(import.meta.dir, "service.test.ts"),
      }), "utf8");
      const diagnostic = bakedServicePathsDiagnostic();
      expect(diagnostic).toContain("STALE baked paths");
      expect(diagnostic).toContain(missing);

      writeFileSync(statePath, JSON.stringify({
        version: 1,
        codexHome: stateDir,
        opencodexHome: stateDir,
        bunPath: join(import.meta.dir, "service.test.ts"),
        cliPath: join(import.meta.dir, "service.test.ts"),
      }), "utf8");
      expect(bakedServicePathsDiagnostic()).toBeNull();

      // Pre-loop-3 state files without baked paths stay silent.
      writeFileSync(statePath, JSON.stringify({ version: 1, codexHome: stateDir, opencodexHome: stateDir }), "utf8");
      expect(bakedServicePathsDiagnostic()).toBeNull();
    } finally {
      if (oldOpenCodexHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = oldOpenCodexHome;
    }
  });

  test("direct service status prints the diagnostics line", async () => {
    const service = await readText("src/service.ts");
    const statusCase = service.slice(service.indexOf('case "status":'), service.indexOf('case "uninstall":'));

    expect(statusCase).toContain("Diagnostics:");
    expect(statusCase).toContain("serviceDiagnosticsSummary()");
  });
});

describe("service repair", () => {
  const baseDiag = {
    supported: true,
    installed: true,
    enabled: true,
    running: true,
    viable: false,
    startable: true,
    stale: true,
    conflict: false,
    backend: "scheduler" as const,
    summary: "stale",
  };

  test("scheduler repair rewrites assets and restarts without schtasks create", async () => {
    const calls: string[] = [];
    await repairService({
      platform: "win32",
      diagnose: () => baseDiag,
      assertEnv: () => { calls.push("env"); },
      assertAuth: () => { calls.push("auth"); },
      stopScheduler: () => { calls.push("stop"); },
      writeSchedulerAssets: () => { calls.push("assets"); },
      startScheduler: () => { calls.push("start"); },
      writeSchedulerState: () => { calls.push("state"); },
      repairNative: async () => { calls.push("native"); },
      repairSystemd: () => { calls.push("systemd"); },
    });
    expect(calls).toEqual(["env", "auth", "stop", "assets", "start", "state"]);
  });

  test("repair rejects when nothing is installed", async () => {
    await expect(repairService({
      platform: "win32",
      diagnose: () => ({ ...baseDiag, installed: false, backend: null, summary: "not installed" }),
      writeSchedulerAssets: () => { throw new Error("should not write"); },
      repairSystemd: () => { throw new Error("should not install systemd"); },
    })).rejects.toThrow(/not installed/i);
  });

  test("repair rejects conflict without touching assets", async () => {
    let wrote = false;
    await expect(repairService({
      platform: "win32",
      diagnose: () => ({ ...baseDiag, conflict: true, summary: "CONFLICT" }),
      writeSchedulerAssets: () => { wrote = true; },
      repairSystemd: () => { throw new Error("should not install systemd"); },
    })).rejects.toThrow(/both present/i);
    expect(wrote).toBe(false);
  });

  test("native repair uses the WinSW repair path and refreshes install state", async () => {
    const calls: string[] = [];
    await repairService({
      platform: "win32",
      diagnose: () => ({ ...baseDiag, backend: "native" }),
      assertEnv: () => {},
      assertAuth: () => {},
      repairNative: async () => { calls.push("native"); },
      writeNativeState: () => { calls.push("native-state"); },
      writeSchedulerAssets: () => { calls.push("scheduler"); },
      repairSystemd: () => { calls.push("systemd"); },
    });
    expect(calls).toEqual(["native", "native-state"]);
  });
});

/**
 * `launchctl load` reports failure on stderr and exits 0 for an already-bootstrapped
 * job, so `sh()` (execSync — throws only on a non-zero exit) treated a load that did
 * nothing as success. launchd then kept running the PREVIOUS plist while a freshly
 * written one sat unused, which is the 2026-08-02 report: `ocx service` prints a
 * checkmark, `launchctl list` shows the job, and the port answers nothing.
 *
 * Measured on macOS 27.0:
 *   $ launchctl load -w ~/Library/LaunchAgents/com.opencodex.proxy.plist
 *   Load failed: 5: Input/output error
 *   $ echo $?
 *   0
 */
describe("launchctl load verification", () => {
  describe("launchctlLoadFailed", () => {
    test("detects the legacy load failure that exits 0", () => {
      expect(launchctlLoadFailed(
        "Load failed: 5: Input/output error\nTry running `launchctl bootstrap` as root for richer errors.",
      )).toBe(true);
    });

    test("detects a bootstrap failure", () => {
      expect(launchctlLoadFailed("Bootstrap failed: 37: Operation already in progress")).toBe(true);
    });

    test("stays false for clean output", () => {
      expect(launchctlLoadFailed("")).toBe(false);
    });
  });

  describe("runLaunchctl", () => {
    test("reports ok with trimmed stdout on a clean run", () => {
      const out = runLaunchctl(["print", "gui/501/x"], {
        run: (() => ({ status: 0, stdout: "  ok  ", stderr: "" })) as never,
      });
      // `status` is carried through now: a boolean cannot tell "no such service"
      // (113) from "no such domain" (112), and only the first is an answer.
      expect(out).toEqual({ ok: true, stdout: "ok", stderr: "", status: 0 });
    });

    /**
     * The regression guard. `execFileSync` discards stderr when the child exits 0,
     * so a runner built on it returns stderr:"" here and the whole fix silently
     * no-ops on a real machine while its unit tests stay green.
     */
    test("surfaces stderr even when the child exits 0", () => {
      const out = runLaunchctl(["load", "-w", "/x.plist"], {
        run: (() => ({
          status: 0,
          stdout: "",
          stderr: "Load failed: 5: Input/output error\nTry running `launchctl bootstrap` as root...",
        })) as never,
      });
      expect(out.ok).toBe(true);
      expect(launchctlLoadFailed(out.stderr)).toBe(true);
    });

    test("reports not-ok on a real non-zero exit (bootstrap)", () => {
      const out = runLaunchctl(["bootstrap", "gui/501", "/x.plist"], {
        run: (() => ({ status: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" })) as never,
      });
      expect(out.ok).toBe(false);
      expect(launchctlLoadFailed(out.stderr)).toBe(true);
    });

    test("treats a spawn failure as not-ok rather than success", () => {
      const out = runLaunchctl(["load", "-w", "/x.plist"], {
        run: (() => ({ error: new Error("spawn /bin/launchctl ENOENT"), status: null, stdout: null, stderr: null })) as never,
      });
      expect(out.ok).toBe(false);
      expect(out.stderr).toContain("ENOENT");
    });
  });

  describe("launchdJobMatchesPlist", () => {
    // Shape captured from a real `launchctl print gui/$(id -u)/com.opencodex.proxy`
    // run on macOS 27.0: the arguments block is tab-indented one level, entries two.
    const cmd = "exec '/pkg/bun' '/pkg/src/cli/index.ts' start --port 10100";
    const printed = (command: string) => [
      "\targuments = {",
      "\t\t/bin/sh",
      "\t\t-lc",
      `\t\tif [ -f '/h/.opencodex/service-api-token' ]; then OPENCODEX_API_AUTH_TOKEN="$(cat '/h/.opencodex/service-api-token')"; export OPENCODEX_API_AUTH_TOKEN; fi; ${command}`,
      "\t}",
    ].join("\n");

    test("reports matching when print shows the current arguments", () => {
      expect(launchdJobMatchesPlist(cmd, {
        run: () => ({ ok: true, stdout: printed(cmd), stderr: "" }),
      })).toEqual({ loaded: true, matchesPlist: true });
    });

    test("reports loaded-but-stale when print shows different arguments", () => {
      const old = "exec '/old/pkg/bun' '/old/pkg/src/cli/index.ts' start --port 10100";
      expect(launchdJobMatchesPlist(cmd, {
        run: () => ({ ok: true, stdout: printed(old), stderr: "" }),
      })).toEqual({ loaded: true, matchesPlist: false });
    });

    test("reports not loaded when print fails", () => {
      expect(launchdJobMatchesPlist(cmd, {
        run: () => ({ ok: false, stdout: "", stderr: "Could not find service" }),
      })).toEqual({ loaded: false, matchesPlist: false });
    });
  });

  describe("startLaunchd", () => {
    // A runLaunchctl RESULT, not a spawnSync result.
    const failedLoad = () => ({ ok: true, stdout: "", stderr: "Load failed: 5: Input/output error" });
    const cleanLoad = () => ({ ok: true, stdout: "", stderr: "" });

    test("returns without consulting launchd when the load is clean", () => {
      expect(() => startLaunchd({
        launchctl: cleanLoad,
        matches: () => { throw new Error("must not be consulted on a clean load"); },
      })).not.toThrow();
    });

    /**
     * launchctl emits `Load failed` for EVERY already-bootstrapped job, including a
     * correct one, so `ocx service start` on a healthy service hits it every time.
     * An unconditional throw would break the most common benign invocation.
     */
    test("treats an already-loaded matching job as a no-op", () => {
      const log = spyOn(console, "log").mockImplementation(() => {});
      try {
        expect(() => startLaunchd({
          launchctl: failedLoad,
          matches: () => ({ loaded: true, matchesPlist: true }),
        })).not.toThrow();
      } finally {
        log.mockRestore();
      }
    });

    // not.toThrow() alone would still pass if the guard regressed; assert the branch.
    test("says so when the job was already loaded from the current plist", () => {
      const lines: string[] = [];
      const log = spyOn(console, "log").mockImplementation(m => { lines.push(String(m)); });
      try {
        startLaunchd({ launchctl: failedLoad, matches: () => ({ loaded: true, matchesPlist: true }) });
      } finally {
        log.mockRestore();
      }
      expect(lines.join("\n")).toContain("already loaded");
    });

    test("throws with the bootout hint when the loaded job is stale", () => {
      expect(() => startLaunchd({
        launchctl: failedLoad,
        matches: () => ({ loaded: true, matchesPlist: false }),
      })).toThrow(/bootout/);
    });

    test("throws with the repair hint when no job is loaded", () => {
      // The plist exists (this is an installed service) — reloading it is `repair`,
      // not a re-registration.
      expect(() => startLaunchd({
        launchctl: failedLoad,
        matches: () => ({ loaded: false, matchesPlist: false }),
      })).toThrow(/service repair/);
    });
  });
});

/**
 * Registration is not service. `launchctl load` succeeding (or `systemctl enable`,
 * or `schtasks /run`) proves the manager accepted the job, not that the proxy bound
 * a port — so `install`/`start` printed a green checkmark for a service that never
 * served. These helpers answer the second question.
 */
describe("auth preflight retry command (260804 #970 follow-up)", () => {
  // Calls the PRODUCTION selector, not a copy of its logic. An earlier version of this
  // test re-implemented the predicate as a local lambda and would have stayed green with
  // the fix reverted — a guard that cannot fail is worse than no guard.
  test("serviceRetryCommand picks the command that can actually succeed", () => {
    // Registered and healthy enough to refresh in place: repair, no elevation needed.
    expect(serviceRetryCommand({ installed: true, conflict: false })).toBe("ocx service repair");
    // Nothing registered: repairService() would refuse, so install is the only option.
    expect(serviceRetryCommand({ installed: false, conflict: false })).toBe("ocx service install");
    // Task Scheduler AND WinSW both present: repairService() refuses this outright
    // (see the conflict guard in repairService), and installWindows removes the native
    // backend first, so install is the valid recovery.
    expect(serviceRetryCommand({ installed: true, conflict: true })).toBe("ocx service install");
  });
});

describe("service serving confirmation", () => {
  describe("launchdListenPort", () => {
    test("reads the port baked into the plist, not the current config", () => {
      expect(launchdListenPort({
        readPlist: () => "<string>exec '/b' '/c' start --port 18222</string>",
      })).toBe(18222);
    });

    // The command's own Bun/CLI paths precede the argument; a path containing the
    // literal must not shadow it.
    test("prefers the argument tail over a path that looks like one", () => {
      expect(launchdListenPort({
        readPlist: () => "<string>exec '/opt/start --port 9999/bun' '/c' start --port 18222</string>",
      })).toBe(18222);
    });

    test("returns null when there is no port to read", () => {
      expect(launchdListenPort({ readPlist: () => "<string>no port here</string>" })).toBeNull();
    });

    test("rejects out-of-range ports rather than probing them", () => {
      expect(launchdListenPort({ readPlist: () => "<string>start --port 0</string>" })).toBeNull();
      expect(launchdListenPort({ readPlist: () => "<string>start --port 70000</string>" })).toBeNull();
    });

    // Linux/Windows hit this on every call: plistPath() has nothing to read.
    test("returns null when the plist cannot be read", () => {
      expect(launchdListenPort({ readPlist: () => { throw new Error("ENOENT"); } })).toBeNull();
    });
  });

  describe("systemdListenPort", () => {
    test("reads the port out of the unit's ExecStart line", () => {
      expect(systemdListenPort({
        readUnit: () => 'ExecStart="/bin/sh" -lc "exec \'/b\' \'/c\' start --port 18222"\n',
      })).toBe(18222);
    });

    test("returns null when the unit cannot be read", () => {
      expect(systemdListenPort({ readUnit: () => { throw new Error("ENOENT"); } })).toBeNull();
    });

    test("rejects out-of-range ports", () => {
      expect(systemdListenPort({ readUnit: () => "ExecStart=... start --port 0\n" })).toBeNull();
    });
  });

  describe("confirmServiceServing", () => {
    test("returns the baked port once the proxy answers", async () => {
      let calls = 0;
      const out = await confirmServiceServing({
        port: 10100,
        hostname: "127.0.0.1",
        probe: async () => ++calls >= 2,
        sleep: async () => {},
        now: () => 0,
        timeoutMs: 5_000,
      });
      expect(out).toEqual({ ok: true, port: 10100 });
    });

    test("gives up at the deadline instead of hanging", async () => {
      let now = 0;
      const out = await confirmServiceServing({
        port: 10100,
        probe: async () => false,
        sleep: async ms => { now += ms; },
        now: () => now,
        timeoutMs: 2_000,
      });
      expect(out).toEqual({ ok: false, port: 10100 });
    });

    test("probes at least once even with a zero budget", async () => {
      let probes = 0;
      await confirmServiceServing({
        port: 10100,
        probe: async () => { probes += 1; return false; },
        sleep: async () => {},
        now: () => 0,
        timeoutMs: 0,
      });
      expect(probes).toBe(1);
    });

    // A service reinstall invalidates the pidfile, so resolving the target through
    // it (findLiveProxy) would report a serving service as dead. Ask the baked port.
    test("probes the port it was given rather than resolving one", async () => {
      const seen: number[] = [];
      await confirmServiceServing({
        port: 18999,
        probe: async p => { seen.push(p); return true; },
        sleep: async () => {},
        now: () => 0,
      });
      expect(seen).toEqual([18999]);
    });
  });

  /**
   * `ocx service status` printed raw `launchctl list` output, which reports a
   * registered job identically whether it is serving, bound to nothing, or running
   * an older plist. The reporter hit exactly that: a checkmark next to a dead port.
   */
  describe("serviceStatusReport", () => {
    const installedDiag = (): ServiceDiagnostic => ({
      supported: true,
      installed: true,
      enabled: true,
      running: true,
      viable: true,
      startable: true,
      stale: false,
      conflict: false,
      backend: "launchd",
      summary: "installed and loaded (launchd)",
    });

    test("reports the serving port when a proxy answers", async () => {
      const out = await serviceStatusReport({
        diagnose: installedDiag,
        serving: async () => ({ ok: true, port: 10100 }),
      });
      expect(out).toContain("Serving on port 10100");
    });

    test("names the log path and the repair command when nothing answers", async () => {
      const out = await serviceStatusReport({
        diagnose: installedDiag,
        serving: async () => ({ ok: false, port: 10100 }),
        matchesPlist: () => ({ loaded: true, matchesPlist: true }),
      });
      expect(out).toContain("no proxy is answering on port 10100");
      // Registered but not serving: repair refreshes it without demanding elevation.
      expect(out).toContain("ocx service repair");
      expect(out).toContain("ocx start");
    });

    // The injected seam must win on every platform: the default is darwin-gated,
    // the dep is not, so this case has to run on Linux and Windows CI too.
    test("adds the bootout hint when launchd runs an older plist", async () => {
      const out = await serviceStatusReport({
        diagnose: installedDiag,
        serving: async () => ({ ok: false, port: 10100 }),
        matchesPlist: () => ({ loaded: true, matchesPlist: false }),
      });
      expect(out).toContain("OLDER plist");
      expect(out).toContain("bootout");
    });

    test("reports not-installed without probing", async () => {
      let probed = false;
      const out = await serviceStatusReport({
        diagnose: () => ({ ...installedDiag(), installed: false, summary: "not installed" }),
        serving: async () => { probed = true; return { ok: false, port: 0 }; },
      });
      expect(out).toContain("not installed");
      expect(probed).toBe(false);
    });
  });

  /**
   * systemd's analogue of the macOS stale-plist case: writing the unit file does not
   * change the definition systemd has loaded until `daemon-reload`, so `ocx service
   * start` would run the PREVIOUS ExecStart.
   */
  describe("systemdNeedsDaemonReload", () => {
    test("detects a unit changed on disk", () => {
      expect(systemdNeedsDaemonReload({ show: () => "NeedDaemonReload=yes" })).toBe(true);
    });

    test("is false when systemd is already in sync", () => {
      expect(systemdNeedsDaemonReload({ show: () => "NeedDaemonReload=no" })).toBe(false);
    });

    // No user bus, or not installed: never block a start we cannot judge.
    test("is false when the query fails", () => {
      expect(systemdNeedsDaemonReload({ show: () => { throw new Error("no bus"); } })).toBe(false);
    });
  });

  test("systemdListenPort reads the port out of a real generated unit", () => {
    expect(systemdListenPort({ readUnit: () => buildUnit() })).toBe(resolveServiceListenPort());
  });

  /**
   * The defect is an ORDERING property of startSystemd, and this host is macOS so the
   * systemd path cannot be executed. Pin the order in source instead — the same
   * instrument this file already uses for the adjacent install-ordering invariant.
   */
  test("service start reloads and restarts systemd for a changed unit", async () => {
    const service = await readText("src/service.ts");
    const startSystemd = service.slice(
      service.indexOf("function startSystemd()"),
      service.indexOf("function stopSystemd()"),
    );

    const needsReloadAt = startSystemd.indexOf("systemdNeedsDaemonReload()");
    const reloadAt = startSystemd.indexOf("systemctl --user daemon-reload");
    const restartAt = startSystemd.indexOf("systemctl --user restart");
    const startAt = startSystemd.indexOf("systemctl --user start");

    expect(needsReloadAt).toBeGreaterThan(-1);
    expect(needsReloadAt).toBeLessThan(reloadAt);
    expect(reloadAt).toBeLessThan(restartAt);
    // A changed unit must be RESTARTED, not started: `start` is a no-op on an active
    // unit and would leave the stale process running the old ExecStart.
    expect(restartAt).toBeLessThan(startAt);
  });

  /**
   * Windows bakes the port into two different artifacts depending on backend: the
   * scheduler wrapper (`opencodex-service.cmd`) and the WinSW XML. Both must be
   * readable or `start` probes a port the service was never told to use.
   */
  describe("windowsListenPort", () => {
    test("reads the port baked into the scheduler wrapper", () => {
      expect(windowsListenPort({
        readScript: () => '"%OCX_BUN%" "%OCX_CLI%" start --port 18222 >>"%LOG%" 2>&1',
      })).toBe(18222);
    });

    // Every `set "…"` line precedes the exec line, so a decoy in a path must lose.
    test("prefers the argument tail over a path that looks like one", () => {
      expect(windowsListenPort({
        readScript: () => 'set "OCX_BUN=C:\\start --port 9999\\bun.exe"\r\n"%OCX_BUN%" "%OCX_CLI%" start --port 18222\r\n',
      })).toBe(18222);
    });

    test("returns null when the wrapper cannot be read", () => {
      expect(windowsListenPort({ readScript: () => { throw new Error("ENOENT"); } })).toBeNull();
    });

    test("rejects out-of-range ports", () => {
      expect(windowsListenPort({ readScript: () => "start --port 0 " })).toBeNull();
      expect(windowsListenPort({ readScript: () => "start --port 70000 " })).toBeNull();
    });

    // The generated wrapper is the real contract; assert against it, not a sketch.
    test("reads the port out of a real generated wrapper", () => {
      expect(windowsListenPort({ readScript: () => buildWindowsServiceScript() }))
        .toBe(resolveServiceListenPort());
    });
  });

  describe("winswListenPort", () => {
    test("reads the port out of the WinSW <arguments> element", () => {
      expect(winswListenPort({
        readXml: () => "  <arguments>&quot;C:\\pkg\\cli.ts&quot; start --port 18222</arguments>",
      })).toBe(18222);
    });

    // Scheduler install, or any non-Windows host: the XML is simply absent.
    test("returns null when the XML cannot be read", () => {
      expect(winswListenPort({ readXml: () => { throw new Error("ENOENT"); } })).toBeNull();
    });

    test("reads the port out of a real generated WinSW XML", () => {
      const xml = buildWinswXml({ bun: "C:\\pkg\\bun.exe", bunRuntimeSource: "bundled", cli: "C:\\pkg\\src\\cli\\index.ts" });
      expect(winswListenPort({ readXml: () => xml })).toBe(resolveServiceListenPort());
    });
  });
});

// #2107 baked the outbound proxy environment into the installed service definition, and a
// proxy URL routinely carries user:password. That made these files credential-bearing, so
// they must not be written at the umask default.
describe("service definitions are not world-readable", () => {
  const modeOf = (path: string): string => (statSync(path).mode & 0o777).toString(8);

  // Windows does not implement POSIX permission bits — Bun reports 0666 for an ordinary
  // file regardless of what `mode` asked for, and the real boundary there is the NTFS ACL
  // applied by hardenSecretPath. Asserting the octal on Windows tests the emulation layer
  // rather than the security property, so these three pin the POSIX half only. The Windows
  // half is covered by the credential-detection tests below, which decide whether that ACL
  // is applied strictly.
  const posixOnly = process.platform === "win32" ? test.skip : test;

  posixOnly("a freshly written definition is owner-only", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-service-mode-"));
    try {
      const path = join(dir, "unit");
      writeServiceDefinitionFile(path, buildUnit(resolvedProxyEnv({ HTTP_PROXY: "http://u:p@127.0.0.1:7890" })), "utf8");

      expect(modeOf(path)).toBe("600");
      // The credential is still written — this test pins who can read it, not that it is absent.
      expect(readFileSync(path, "utf8")).toContain("u:p@127.0.0.1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  posixOnly("an install over a loose definition from an older version tightens it", () => {
    // `mode` applies only on creation, so a reinstall would otherwise leave 0644 standing.
    const dir = mkdtempSync(join(tmpdir(), "ocx-service-mode-"));
    try {
      const path = join(dir, "plist");
      writeFileSync(path, "stale", { encoding: "utf8", mode: 0o644 });
      expect(modeOf(path)).toBe("644");

      writeServiceDefinitionFile(path, buildPlist(resolvedProxyEnv({})), "utf8");

      expect(modeOf(path)).toBe("600");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  posixOnly("utf16le scheduler assets take the same mode", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-service-mode-"));
    try {
      const path = join(dir, "task.xml");
      writeServiceDefinitionFile(path, "\uFEFF<Task />", "utf16le");

      expect(modeOf(path)).toBe("600");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// A pre-promotion audit flagged that this file's proxy-credential write used a soft-failing
// Windows ACL while the two adjacent secret writes — the API token and the install state —
// both fail closed. On Windows the POSIX mode bits are advisory, so a soft ACL failure can
// leave a proxy password readable by other local principals.
describe("credential-bearing definitions harden the Windows ACL strictly", () => {
  test("a proxy URL with userinfo is treated as a secret publication", () => {
    // `pw@chatgpt.com` is the repo's existing URL-userinfo fixture: the privacy scanner
    // reads "pw@host" as an email otherwise, and this exact pair is already allowlisted for
    // tests/ (scripts/privacy-scan.ts:102). The shape under test is the userinfo authority,
    // not the particular credential.
    const unit = buildUnit(resolvedProxyEnv({ HTTPS_PROXY: "https://user:pw@chatgpt.com:8080" }));

    expect(definitionCarriesCredential(unit)).toBe(true);
  });

  test("a bare proxy URL is not a secret, so an icacls stall must not fail the install", () => {
    // Before #2107 these files had no hardening at all; refusing an install over a stall
    // would regress a user who has nothing to protect.
    const unit = buildUnit(resolvedProxyEnv({ HTTP_PROXY: "http://127.0.0.1:7890", NO_PROXY: "localhost" }));

    expect(definitionCarriesCredential(unit)).toBe(false);
  });

  test("lower-case spellings and the plist form are covered too", () => {
    const plist = buildPlist(resolvedProxyEnv({ all_proxy: "socks5://u:p@127.0.0.1:1080" }));

    expect(definitionCarriesCredential(plist)).toBe(true);
  });

  test("a definition with no proxy env at all carries no credential", () => {
    expect(definitionCarriesCredential(buildUnit(resolvedProxyEnv({})))).toBe(false);
  });
});
