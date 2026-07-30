import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { windowsEnvIndirectBatchValue } from "../src/lib/win-paths";
import { assertServiceAuthEnvironment, assertServiceEnvironmentMatchesInstall, bakedServicePathsDiagnostic, buildPlist, buildUnit, buildWindowsLauncherVbs, buildWindowsSchtasksCreateArgs, buildWindowsServiceScript, buildWindowsTaskXml, deriveWindowsServiceDiagnostic, normalizeServiceSubcommand, parseServiceInstallState, readWindowsSchedulerXmlState, repairService, resolveServiceListenPort, serviceLogPath, serviceStartableFromTray, serviceStatusSummary, windowsTaskRegistrationHealthy } from "../src/service";
import { serviceApiTokenFilePath } from "../src/lib/service-secrets";
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
    const script = buildWindowsServiceScript({ bun: "C:\\OpenCodex\\bun.exe", cli: "C:\\OpenCodex\\cli.ts" });
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

    const writeAt = installSystemd.indexOf('writeFileSync(unitPath(), buildUnit(), "utf8")');
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
      cli: "C:\\OpenCodex&Dir\\cli.ts",
    });

    expect(script).toContain('set "OCX_BUN=C:\\Bun&Dir\\100%%bun^^\\bun.exe"');
    expect(script).toContain('set "OCX_CLI=C:\\OpenCodex&Dir\\cli.ts"');
    expect(script).toContain('"%OCX_BUN%" "%OCX_CLI%" start --port');
    expect(script).not.toContain('"C:\\Bun&Dir\\100%bun^\\bun.exe"');
  });

  test("switches the wrapper console to UTF-8 and sleeps via ping (timeout dies without console stdin)", () => {
    const script = buildWindowsServiceScript({ bun: "C:\\OpenCodex\\bun.exe", cli: "C:\\OpenCodex\\cli.ts" });

    expect(script).toContain("chcp 65001 >nul");
    expect(script.indexOf("chcp 65001 >nul")).toBeLessThan(script.indexOf('set "OCX_SERVICE=1"'));
    expect(script).toContain("ping -n 6 127.0.0.1 >nul");
    expect(script).not.toContain("timeout /t");
  });

  test("rewrites profile-relative paths to env indirection so non-ASCII usernames survive OEM-codepage batch parsing", () => {
    const oldUserProfile = process.env.USERPROFILE;
    const oldAppData = process.env.APPDATA;
    try {
      process.env.USERPROFILE = "C:\\Users\\한글사용자";
      process.env.APPDATA = "C:\\Users\\한글사용자\\AppData\\Roaming";
      const script = buildWindowsServiceScript({
        bun: "C:\\Users\\한글사용자\\AppData\\Roaming\\npm\\node_modules\\bun\\bin\\bun.exe",
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
      expect(script).toContain('echo bun_source="');
      expect(script).toContain('echo cli="%OCX_CLI%"');
      expect(script).toContain('echo opencodex_home="%OPENCODEX_HOME%"');
      expect(script).toContain('echo codex_home="%CODEX_HOME%"');
      expect(script).toContain('echo token_file="%OCX_API_TOKEN_FILE%"');
      expect(script).toMatch(/"%OCX_BUN%" "%OCX_CLI%" start --port \d+ >>"%OCX_SERVICE_LOG%" 2>&1/);
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
    expect(stopCase).toContain("await stopTrackedProxyForServiceCommand();");
    expect(stopCase).toContain("restoreNativeCodex();");
    expect(stopCase.indexOf("ops.stop();")).toBeLessThan(stopCase.indexOf("stopTrackedProxyForServiceCommand();"));
    expect(stopCase.indexOf("stopTrackedProxyForServiceCommand();")).toBeLessThan(stopCase.indexOf("restoreNativeCodex();"));
  });

  test("direct service uninstall kills the tracked proxy before deleting service assets", async () => {
    const service = await readText("src/service.ts");
    const uninstallCase = service.slice(service.indexOf('case "uninstall":'), service.indexOf("default:"));

    expect(uninstallCase).toContain("ops.stop();");
    expect(uninstallCase).toContain("await stopTrackedProxyForServiceCommand();");
    expect(uninstallCase).toContain("ops.uninstall();");
    expect(uninstallCase).toContain("restoreNativeCodex();");
    expect(uninstallCase.indexOf("ops.stop();")).toBeLessThan(uninstallCase.indexOf("stopTrackedProxyForServiceCommand();"));
    expect(uninstallCase.indexOf("stopTrackedProxyForServiceCommand();")).toBeLessThan(uninstallCase.indexOf("ops.uninstall();"));
    expect(uninstallCase.indexOf("ops.uninstall();")).toBeLessThan(uninstallCase.indexOf("restoreNativeCodex();"));
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

    expect(service).toContain('import { expandUserPath, getConfigDir, readPid, removePid, removeRuntimePort } from "./config";');
    expect(service).toContain("removeRuntimePort(pid);");
    expect(service).toContain('import { isProcessAlive, stopProxy } from "./lib/process-control";');
    expect(service).toContain('import { findLiveProxy } from "./server/proxy-liveness";');
    expect(service).toContain('type TrackedProxyCleanupResult = "none" | "stale" | "stopped";');
    expect(service).toContain("async function stopTrackedProxyIfRunning(): Promise<TrackedProxyCleanupResult>");
    expect(service).toContain("await findLiveProxy({ timeoutMs: 1500 })");
    expect(service).toContain("await stopProxy(pid);");
    expect(service).toContain("removePid(pid);");
    expect(service).toContain('return "stopped";');
  });

  test("service stop refuses success while the proxy is still live", async () => {
    const service = await readText("src/service.ts");
    const stopCase = service.slice(service.indexOf('case "stop":'), service.indexOf('case "status":'));
    expect(stopCase).toContain("await findLiveProxy({ timeoutMs: 1500 })");
    expect(stopCase).toContain("Service stop did not terminate the proxy");
    expect(stopCase).toContain("process.exit(1)");
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
