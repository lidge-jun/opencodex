import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { windowsEnvIndirectBatchValue } from "../src/lib/win-paths";
import { assertServiceAuthEnvironment, assertServiceEnvironmentMatchesInstall, bakedServicePathsDiagnostic, buildPlist, buildUnit, buildWindowsLauncherVbs, buildWindowsSchtasksCreateArgs, buildWindowsServiceScript, buildWindowsTaskXml, deriveWindowsServiceDiagnostic, normalizeServiceSubcommand, parseServiceInstallState, readWindowsSchedulerXmlState, resolveServiceListenPort, serviceLogPath, serviceStartableFromTray, serviceStatusSummary, windowsTaskRegistrationHealthy } from "../src/service";
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
      xml.replace("LeastPrivilege", "HighestAvailable"),
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

  test("accepts scheduler-exported literal quotes in launcher arguments", () => {
    const wscript = "C:\\Windows\\System32\\wscript.exe";
    const launcher = "C:\\Users\\a&b\\.opencodex\\service-launcher.vbs";
    const xml = buildWindowsTaskXml("ignored.cmd", launcher)
      .replace(/<Command>.*?<\/Command>/, `<Command>${wscript}</Command>`);
    // Task Scheduler exports quotation marks literally in element text while
    // retaining required XML escaping for characters such as ampersands.
    const exported = xml.replaceAll("&quot;", '"');

    expect(exported).toContain('<Arguments>/b /nologo "C:\\Users\\a&amp;b\\.opencodex\\service-launcher.vbs"</Arguments>');
    expect(windowsTaskRegistrationHealthy(exported, wscript, launcher)).toBe(true);
    expect(windowsTaskRegistrationHealthy(
      exported.replace("service-launcher.vbs", "foreign.vbs"),
      wscript,
      launcher,
    )).toBe(false);
  });

  test("rejects explicit unsafe values even though defaults may be omitted", () => {
    const wscript = "C:\\Windows\\System32\\wscript.exe";
    const launcher = "C:\\Users\\Test\\.opencodex\\service-launcher.vbs";
    const xml = buildWindowsTaskXml("ignored.cmd", launcher)
      .replace(/<Command>.*?<\/Command>/, `<Command>${wscript}</Command>`);

    // Trigger disabled explicitly.
Û¾x¶‰žËkºwµçM±¤¹ÑÌˆô¤ì((€€€•áÁ•Ð¡ÍÉ¥ÁÐ¤¹Ñ½½¹Ñ…¥¸ ‰¡À€ØÔÀÀÄ€ù¹Õ°ˆ¤ì(€€€•áÁ•Ð¡ÍÉ¥ÁÐ¹¥¹‘•á=˜ ‰¡À€ØÔÀÀÄ€ù¹Õ°ˆ¤¤¹Ñ½	•1•ÍÍQ¡…¸¡ÍÉ¥ÁÐ¹¥¹‘•á=˜ Í•Ð€‰=a}MIY%ôÄˆœ¤¤ì(€€€•áÁ•Ð¡ÍÉ¥ÁÐ¤¹Ñ½½¹Ñ…¥¸ ‰Á¥¹œ€µ¸€Ø€ÄÈÜ¸À¸À¸Ä€ù¹Õ°ˆ¤ì(€€€•áÁ•Ð¡ÍÉ¥ÁÐ¤¹¹½Ð¹Ñ½½¹Ñ…¥¸ ‰Ñ¥µ•½ÕÐ€½Ðˆ¤ì(€ô¤ì((€Ñ•ÍÐ ‰É•ÝÉ¥Ñ•ÌÁÉ½™¥±”µÉ•±…Ñ¥Ù”Á…Ñ¡ÌÑ¼•¹Ø¥¹‘¥É•Ñ¥½¸Í¼¹½¸µM%$ÕÍ•É¹…µ•ÌÍÕÉÙ¥Ù”=4µ½‘•Á…”‰…Ñ Á…ÉÍ¥¹œˆ°€ ¤€ôøì(€€€½¹ÍÐ½±‘UÍ•ÉAÉ½™¥±”€ôÁÉ½•ÍÌ¹•¹Ø¹UMIAI=%1ì(€€€½¹ÍÐ½±‘ÁÁ…Ñ„€ôÁÉ½•ÍÌ¹•¹Ø¹AAQì(€€€ÑÉäì(€€€€€ÁÉ½•ÍÌ¹•¹Ø¹UMIAI=%1€ô€‰éqqUÍ•ÉÍqs¶Vsªâ²
³²j§²z@ˆì(€€€€€ÁÉ½•ÍÌ¹•¹Ø¹AAQ€ô€‰éqqUÍ•ÉÍqs¶Vsªâ²
³²j§²zAqqÁÁ…Ñ…qqI½…µ¥¹œˆì(€€€€€½¹ÍÐÍÉ¥ÁÐ€ô‰Õ¥±‘]¥¹‘½ÝÍM•ÉÙ¥•MÉ¥ÁÐ¡ì(€€€€€€€‰Õ¸è€‰éqqUÍ•ÉÍqs¶Vsªâ²
³²j§²zAqqÁÁ…Ñ…qqI½…µ¥¹qq¹Áµqq¹½‘•}µ½‘Õ±•Íqq‰Õ¹qq‰¥¹qq‰Õ¸¹•á”ˆ°(€€€€€€€±¤è€‰éqqUÍ•ÉÍqs¶Vsªâ²
³²j§²zAqqÁÁ…Ñ…qqI½…µ¥¹qq¹Áµqq¹½‘•}µ½‘Õ±•Íqq½Á•¹½‘•áqqÍÉqq±¤¹ÑÌˆ°(€€€€€ô¤ì((€€€€€•áÁ•Ð¡ÍÉ¥ÁÐ¤¹Ñ½½¹Ñ…¥¸ Í•Ð€‰=a}	U8ô•AAQ•qq¹Áµqq¹½‘•}µ½‘Õ±•Íqq‰Õ¹qq‰¥¹qq‰Õ¸¹•á”ˆœ¤ì(€€€€€•áÁ•Ð¡ÍÉ¥ÁÐ¤¹Ñ½½¹Ñ…¥¸ Í•Ð€‰=a}1$ô•AAQ•qq¹Áµqq¹½‘•}µ½‘Õ±•Íqq½Á•¹½‘•áqqÍÉqq±¤¹ÑÌˆœ¤ì(€€€€€•áÁ•Ð¡ÍÉ¥ÁÐ¤¹¹½Ð¹Ñ½½¹Ñ…¥¸ Í•Ð€‰=a}	U8õéqqUÍ•ÉÍqs¶Vsªâ²
³²j§²z@œ¤ì(€€€ô™¥¹…±±äì(€€€€€¥˜€¡½±‘UÍ•ÉAÉ½™¥±”€ôôôÕ¹‘•™¥¹•¤‘•±•Ñ”ÁÉ½•ÍÌ¹•¹Ø¹UMIAI=%1ì(€€€€€•±Í”ÁÉ½•ÍÌ¹•¹Ø¹UMIAI=%1€ô½±‘UÍ•ÉAÉ½™¥±”ì(€€€€€¥˜€¡½±‘ÁÁ…Ñ„€ôôôÕ¹‘•™¥¹•¤‘•±•Ñ”ÁÉ½•ÍÌ¹•¹Ø¹AAQì(€€€€€•±Í”ÁÉ½•ÍÌ¹•¹Ø¹AAQ€ô½±‘ÁÁ…Ñ„ì(€€€ô(€ô¤ì((€Ñ•ÍÐ ‰ÝÉ¥Ñ•ÌÑ½­•¸µÍ…™”ÍÑ…ÉÑÕÀ¥‘•¹Ñ¥Ñä…¹¡¥±½ÕÑÁÕÐÑ¼Ñ¡”Í•ÉÙ¥”±½œˆ°€ ¤€ôøì(€€€½¹ÍÐ½±‘½‘•á!½µ”€ôÁÉ½•ÍÌ¹•¹Ø¹=a}!=5ì(€€€½¹ÍÐ½±‘=Á•¹½‘•á!½µ”€ôÁÉ½•ÍÌ¹•¹Ø¹=A9=a}!=5ì(€€€½¹ÍÐ½±‘Á¥ÕÑ¡Q½­•¸€ôÁÉ½•ÍÌ¹•¹Ø¹=A9=a}A%}UQ!}Q=-8ì(€€€ÑÉäì(€€€€€ÁÉ½•ÍÌ¹•¹Ø¹=a}!=5€ô€‰éqq½‘•àµ¡½µ”ˆì(€€€€€ÁÉ½•ÍÌ¹•¹Ø¹=A9=a}!=5€ôQMQ}%Hì(€€€€€ÁÉ½•ÍÌ¹•¹Ø¹=A9=a}A%}UQ!}Q=-8€ô€‰±½…°µÍ•É•Ðˆì(€€€€€½¹ÍÐÍÉ¥ÁÐ€ô‰Õ¥±‘]¥¹‘½ÝÍM•ÉÙ¥•MÉ¥ÁÐ¡ì(€€€€€€€‰Õ¸è€‰éqq=Á•¹½‘•áqq‰Õ¸¹•á”ˆ°(€€€€€€€±¤è€‰éqq=Á•¹½‘•áqq±¤¹ÑÌˆ°(€€€€€ô¤ì((€€€€€•áÁ•ÑQ•áÑQ½½¹Ñ…¥¹A…Ñ ¡ÍÉ¥ÁÐ°Í•ÉÙ¥•1½A…Ñ  ¤¤ì(€€€€€•áÁ•Ð¡ÍÉ¥ÁÐ¤¹Ñ½½¹Ñ…¥¸ Í•Ð€‰=a}MIY%}1=ôœ¤ì(€€€€€•áÁ•Ð¡ÍÉ¥ÁÐ¤¹Ñ½½¹Ñ…¥¸ ‰½Á•¹½‘•àÍ•ÉÙ¥”ÝÉ…ÁÁ•ÈÍÑ…ÉÐˆ¤ì(€€€€€•áÁ•Ð¡ÍÉ¥ÁÐ¤¹Ñ½½¹Ñ…¥¸ •¡¼‰Õ¸ôˆ•=a}	U8”ˆœ¤ì(€€€€€•áÁ•Ð¡ÍÉ¥ÁÐ¤¹Ñ½½¹Ñ…¥¸ •¡¼‰Õ¹}Í½ÕÉ”ôˆœ¤ì(€€€€€•áÁ•Ð¡ÍÉ¥ÁÐ¤¹Ñ½½¹Ñ…¥¸ •¡¼±¤ôˆ•=a}1$”ˆœ¤ì(€€€€€•áÁ•Ð¡ÍÉ¥ÁÐ¤¹Ñ½½¹Ñ…¥¸ •¡¼½Á•¹½‘•á}¡½µ”ôˆ•=A9=a}!=5”ˆœ¤ì(€€€€€•áÁ•Ð¡ÍÉ¥ÁÐ¤¹Ñ½½¹Ñ…¥¸ •¡¼½‘•á}¡½µ”ôˆ•=a}!=5”ˆœ¤ì(€€€€€•áÁ•Ð¡ÍÉ¥ÁÐ¤¹Ñ½½¹Ñ…¥¸ •¡¼Ñ½­•¹}™¥±”ôˆ•=a}A%}Q=-9}%1”ˆœ¤ì(€€€€€•áÁ•Ð¡ÍÉ¥ÁÐ¤¹Ñ½5…Ñ  ¼ˆ•=a}	U8”ˆ€ˆ•=a}1$”ˆÍÑ…ÉÐ€´µÁ½ÉÐq¬€øøˆ•=a}MIY%}1=”ˆ€Èø˜Ä¼¤ì(€€€€€•áÁ•Ð¡ÍÉ¥ÁÐ¤¹Ñ½½¹Ñ…¥¸ ‰¡¥±•á¥Ñ•Ý¥Ñ ½‘”€•II=I1Y0”ˆ¤ì(€€€€€•áÁ•Ð¡ÍÉ¥ÁÐ¤¹¹½Ð¹Ñ½½¹Ñ…¥¸ ‰±½…°µÍ•É•Ðˆ¤ì(€€€€€•áÁ•Ð¡ÍÉ¥ÁÐ¤¹¹½Ð¹Ñ½½¹Ñ…¥¸ Í•Ð€‰=A9=a}A%}UQ!}Q=-8ôœ¤ì(€€€ô™¥¹…±±äì(€€€€€¥˜€¡½±‘½‘•á!½µ”€ôôôÕ¹‘•™¥¹•¤‘•±•Ñ”ÁÉ½•ÍÌ¹•¹Ø¹=a}!=5ì(€€€€€•±Í”ÁÉ½•ÍÌ¹•¹Ø¹=a}!=5€ô½±‘½‘•á!½µ”ì(€€€€€¥˜€¡½±‘=Á•¹½‘•á!½µ”€ôôôÕ¹‘•™¥¹•¤‘•±•Ñ”ÁÉ½•ÍÌ¹•¹Ø¹=A9=a}!=5ì(€€€€€•±Í”ÁÉ½•ÍÌ¹•¹Ø¹=A9=a}!=5€ô½±‘=Á•¹½‘•á!½µ”ì(€€€€€¥˜€¡½±‘Á¥ÕÑ¡Q½­•¸€ôôôÕ¹‘•™¥¹•¤‘•±•Ñ”ÁÉ½•ÍÌ¹•¹Ø¹=A9=a}A%}UQ!}Q=-8ì(€€€€€•±Í”ÁÉ½•ÍÌ¹•¹Ø¹=A9=a}A%}UQ!}Q=-8€ô½±‘Á¥ÕÑ¡Q½­•¸ì(€€€ô(€ô¤ì)ô¤ì()‘•ÍÉ¥‰” ‰±…Õ¹¡Í•ÉÙ¥”Á±¥ÍÐˆ°€ ¤€ôøì(€Ñ•ÍÐ ‰ÁÉ•Í•ÉÙ•ÌÕÍÑ½´½‘•à…¹=Á•¹½‘•à¡½µ•Ìˆ°€ ¤€ôøì(€€€½¹ÍÐ½±‘½‘•á!½µ”€ôÁÉ½•ÍÌ¹•¹Ø¹=a}!=5ì(€€€½¹ÍÐ½±‘=Á•¹½‘•á!½µ”€ôÁÉ½•ÍÌ¹•¹Ø¹=A9=a}!=5ì(€€€½¹ÍÐ½±‘Á¥ÕÑ¡Q½­•¸€ôÁÉ½•ÍÌ¹•¹Ø¹=A9=a}A%}UQ!}Q=-8ì(€€€ÑÉäì(€€€€€ÁÉ½•ÍÌ¹•¹Ø¹=a}!=5€ô€ˆ½ÑµÀ½½‘•àµ¡½µ”ˆì(€€€€€ÁÉ½•ÍÌ¹•¹Ø¹=A9=a}!=5€ô€ˆ½ÑµÀ½½Á•¹½‘•àµ¡½µ”ˆì(€€€€€ÁÉ½•ÍÌ¹•¹Ø¹=A9=a}A%}UQ!}Q=-8€ô€‰±½…°µÍ•É•Ðˆì(€€€€€½¹ÍÐÁ±¥ÍÐ€ô‰Õ¥±‘A±¥ÍÐ ¤ì(€€€€€•áÁ•Ð¡Á±¥ÍÐ¤¹Ñ½½¹Ñ…¥¸ ˆñ­•äù=a}!=5ð½­•äøñÍÑÉ¥¹œø½ÑµÀ½½‘•àµ¡½µ”ð½ÍÑÉ¥¹œøˆ¤ì(€€€€€•áÁ•Ð¡Á±¥ÍÐ¤¹Ñ½½¹Ñ…¥¸ ˆñ­•äù=A9=a}!=5ð½­•äøñÍÑÉ¥¹œø½ÑµÀ½½Á•¹½‘•àµ¡½µ”ð½ÍÑÉ¥¹œøˆ¤ì(€€€€€•áÁ•ÑQ•áÑQ½½¹Ñ…¥¹A…Ñ ¡Á±¥ÍÐ°Í•ÉÙ¥•Á¥Q½­•¹¥±•A…Ñ  ¤¤ì(€€€€€•áÁ•Ð¡Á±¥ÍÐ¤¹¹½Ð¹Ñ½½¹Ñ…¥¸ ‰±½…°µÍ•É•Ðˆ¤ì(€€€€€•áÁ•Ð¡Á±¥ÍÐ¤¹¹½Ð¹Ñ½½¹Ñ…¥¸ ˆñ­•äù=A9=a}A%}UQ!}Q=-8ð½­•äøˆ¤ì(€€€ô™¥¹…±±äì(€€€€€¥˜€¡½±‘½‘•á!½µ”€ôôôÕ¹‘•™¥¹•¤‘•±•Ñ”ÁÉ½•ÍÌ¹•¹Ø¹=a}!=5ì(€€€€€•±Í”ÁÉ½•ÍÌ¹•¹Ø¹=a}!=5€ô½±‘½‘•á!½µ”ì(€€€€€¥˜€¡½±‘=Á•¹½‘•á!½µ”€ôôôÕ¹‘•™¥¹•¤‘•±•Ñ”ÁÉ½•ÍÌ¹•¹Ø¹=A9=a}!=5ì(€€€€€•±Í”ÁÉ½•ÍÌ¹•¹Ø¹=A9=a}!=5€ô½±‘=Á•¹½‘•á!½µ”ì(€€€€€¥˜€¡½±‘Á¥ÕÑ¡Q½­•¸€ôôôÕ¹‘•™¥¹•¤‘•±•Ñ”ÁÉ½•ÍÌ¹•¹Ø¹=A9=a}A%}UQ!}Q=-8ì(€€€€€•±Í”ÁÉ½•ÍÌ¹•¹Ø¹=A9=a}A%}UQ!}Q=-8€ô½±‘Á¥ÕÑ¡Q½­•¸ì(€€€ô(€ô¤ì)ô¤ì()‘•ÍÉ¥‰” ‰Í•ÉÙ¥”±¥™•å±”±•…¹ÕÀ½É‘•É¥¹œˆ°€ ¤€ôøì(€Ñ•ÍÐ ‰‘¥É•ÐÍ•ÉÙ¥”ÍÑ½À­¥±±ÌÑ¡”ÑÉ…­•ÁÉ½áä‰•™½É”É•ÍÑ½É¥¹œ¹…Ñ¥Ù”½‘•àˆ°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍÐÍ•ÉÙ¥”€ô…Ý…¥ÐÉ•…‘Q•áÐ ‰ÍÉŒ½Í•ÉÙ¥”¹ÑÌˆ¤ì(€€€½¹ÍÐÍÑ½Á…Í”€ôÍ•ÉÙ¥”¹Í±¥”¡Í•ÉÙ¥”¹¥¹‘•á=˜ …Í”€‰ÍÑ½Àˆèœ¤°Í•ÉÙ¥”¹¥¹‘•á=˜ …Í”€‰ÍÑ…ÑÕÌˆèœ¤¤ì((€€€•áÁ•Ð¡ÍÑ½Á…Í”¤¹Ñ½½¹Ñ…¥¸ ‰½ÁÌ¹ÍÑ½À ¤ìˆ¤ì(€€€•áÁ•Ð¡ÍÑ½Á…Í”¤¹Ñ½½¹Ñ…¥¸ ‰…Ý…¥ÐÍÑ½ÁQÉ…­•‘AÉ½áå½ÉM•ÉÙ¥•½µµ…¹ ¤ìˆ¤ì(€€€•áÁ•Ð¡ÍÑ½Á…Í”¤¹Ñ½½¹Ñ…¥¸ ‰É•ÍÑ½É•9…Ñ¥Ù•½‘•à ¤ìˆ¤ì(€€€•áÁ•Ð¡ÍÑ½Á…Í”¹¥¹‘•á=˜ ‰½ÁÌ¹ÍÑ½À ¤ìˆ¤¤¹Ñ½	•1•ÍÍQ¡…¸¡ÍÑ½Á…Í”¹¥¹‘•á=˜ ‰ÍÑ½ÁQÉ…­•‘AÉ½áå½ÉM•ÉÙ¥•½µµ…¹ ¤ìˆ¤¤ì(€€€•áÁ•Ð¡ÍÑ½Á…Í”¹¥¹‘•á=˜ ‰ÍÑ½ÁQÉ…­•‘AÉ½áå½ÉM•ÉÙ¥•½µµ…¹ ¤ìˆ¤¤¹Ñ½	•1•ÍÍQ¡…¸¡ÍÑ½Á…Í”¹¥¹‘•á=˜ ‰É•ÍÑ½É•9…Ñ¥Ù•½‘•à ¤ìˆ¤¤ì(€ô¤ì((€Ñ•ÍÐ ‰‘¥É•ÐÍ•ÉÙ¥”Õ¹¥¹ÍÑ…±°­¥±±ÌÑ¡”ÑÉ…­•ÁÉ½áä‰•™½É”‘•±•Ñ¥¹œÍ•ÉÙ¥”…ÍÍ•ÑÌˆ°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍÐÍ•ÉÙ¥”€ô…Ý…¥ÐÉ•…‘Q•áÐ ‰ÍÉŒ½Í•ÉÙ¥”¹ÑÌˆ¤ì(€€€½¹ÍÐÕ¹¥¹ÍÑ…±±…Í”€ôÍ•ÉÙ¥”¹Í±¥”¡Í•ÉÙ¥”¹¥¹‘•á=˜ …Í”€‰Õ¹¥¹ÍÑ…±°ˆèœ¤°Í•ÉÙ¥”¹¥¹‘•á=˜ ‰‘•™…Õ±Ðèˆ¤¤ì((€€€•áÁ•Ð¡Õ¹¥¹ÍÑ…±±…Í”¤¹Ñ½½¹Ñ…¥¸ ‰½ÁÌ¹ÍÑ½À ¤ìˆ¤ì(€€€•áÁ•Ð¡Õ¹¥¹ÍÑ…±±…Í”¤¹Ñ½½¹Ñ…¥¸ ‰…Ý…¥ÐÍÑ½ÁQÉ…­•‘AÉ½áå½ÉM•ÉÙ¥•½µµ…¹ ¤ìˆ¤ì(€€€•áÁ•Ð¡Õ¹¥¹ÍÑ…±±…Í”¤¹Ñ½½¹Ñ…¥¸ ‰½ÁÌ¹Õ¹¥¹ÍÑ…±° ¤ìˆ¤ì(€€€•áÁ•Ð¡Õ¹¥¹ÍÑ…±±…Í”¤¹Ñ½½¹Ñ…¥¸ ‰É•ÍÑ½É•9…Ñ¥Ù•½‘•à ¤ìˆ¤ì(€€€•áÁ•Ð¡Õ¹¥¹ÍÑ…±±…Í”¹¥¹‘•á=˜ ‰½ÁÌ¹ÍÑ½À ¤ìˆ¤¤¹Ñ½	•1•ÍÍQ¡…¸¡Õ¹¥¹ÍÑ…±±…Í”¹¥¹‘•á=˜ ‰ÍÑ½ÁQÉ…­•‘AÉ½áå½ÉM•ÉÙ¥•½µµ…¹ ¤ìˆ¤¤ì(€€€•áÁ•Ð¡Õ¹¥¹ÍÑ…±±…Í”¹¥¹‘•á=˜ ‰ÍÑ½ÁQÉ…­•‘AÉ½áå½ÉM•ÉÙ¥•½µµ…¹ ¤ìˆ¤¤¹Ñ½	•1•ÍÍQ¡…¸¡Õ¹¥¹ÍÑ…±±…Í”¹¥¹‘•á=˜ ‰½ÁÌ¹Õ¹¥¹ÍÑ…±° ¤ìˆ¤¤ì(€€€•áÁ•Ð¡Õ¹¥¹ÍÑ…±±…Í”¹¥¹‘•á=˜ ‰½ÁÌ¹Õ¹¥¹ÍÑ…±° ¤ìˆ¤¤¹Ñ½	•1•ÍÍQ¡…¸¡Õ¹¥¹ÍÑ…±±…Í”¹¥¹‘•á=˜ ‰É•ÍÑ½É•9…Ñ¥Ù•½‘•à ¤ìˆ¤¤ì(€ô¤ì((€Ñ•ÍÐ ‰]¥¹‘½ÝÌÍ•ÉÙ¥”¥¹ÍÑ…±°•¹‘ÌÑ¡”ÉÕ¹¹¥¹œÑ…Í¬‰•™½É”É•ÝÉ¥Ñ¥¹œ¥ÑÌ…ÍÍ•ÑÌ°Ý¥Ñ ÝÉ¥Ñ”É•ÑÉäˆ°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍÐÍ•ÉÙ¥”€ô…Ý…¥ÐÉ•…‘Q•áÐ ‰ÍÉŒ½Í•ÉÙ¥”¹ÑÌˆ¤ì(€€€½¹ÍÐ¥¹ÍÑ…±±]¥¹‘½ÝÌ€ôÍ•ÉÙ¥”¹Í±¥”¡Í•ÉÙ¥”¹¥¹‘•á=˜ ‰™Õ¹Ñ¥½¸¥¹ÍÑ…±±]¥¹‘½ÝÌ ¤ˆ¤°Í•ÉÙ¥”¹¥¹‘•á=˜ ‰™Õ¹Ñ¥½¸ÍÑ…ÉÑ]¥¹‘½ÝÌ ¤ˆ¤¤ì((€€€½¹ÍÐÍÑ½ÁÐ€ô¥¹ÍÑ…±±]¥¹‘½ÝÌ¹¥¹‘•á=˜ ‰ÍÑ½Á]¥¹‘½ÝÌ ¤ìˆ¤ì(€€€½¹ÍÐÍÉ¥ÁÑ]É¥Ñ•Ð€ô¥¹ÍÑ…±±]¥¹‘½ÝÌ¹¥¹‘•á=˜ ‰ÝÉ¥Ñ•M•ÉÙ¥•ÍÍ•Ñ]¥Ñ¡I•ÑÉä¡ÍÉ¥ÁÐˆ¤ì(€€€½¹ÍÐáµ±]É¥Ñ•Ð€ô¥¹ÍÑ…±±]¥¹‘½ÝÌ¹¥¹‘•á=˜ ‰ÝÉ¥Ñ•M•ÉÙ¥•ÍÍ•Ñ]¥Ñ¡I•ÑÉä¡Ý¥¹‘½ÝÍQ…Í­aµ±A…Ñ  ¤ˆ¤ì(€€€•áÁ•Ð¡ÍÑ½ÁÐ¤¹Ñ½	•É•…Ñ•ÉQ¡…¸ ´Ä¤ì(€€€•áÁ•Ð¡ÍÉ¥ÁÑ]É¥Ñ•Ð¤¹Ñ½	•É•…Ñ•ÉQ¡…¸ ´Ä¤ì(€€€•áÁ•Ð¡áµ±]É¥Ñ•Ð¤¹Ñ½	•É•…Ñ•ÉQ¡…¸ ´Ä¤ì(€€€•áÁ•Ð¡ÍÑ½ÁÐ¤¹Ñ½	•1•ÍÍQ¡…¸¡ÍÉ¥ÁÑ]É¥Ñ•Ð¤ì(€€€•áÁ•Ð¡ÍÉ¥ÁÑ]É¥Ñ•Ð¤¹Ñ½	•1•ÍÍQ¡…¸¡áµ±]É¥Ñ•Ð¤ì(€€€•áÁ•Ð¡¥¹ÍÑ…±±]¥¹‘½ÝÌ¤¹¹½Ð¹Ñ½½¹Ñ…¥¸ ‰ÝÉ¥Ñ•¥±•Må¹Œ¡ÍÉ¥ÁÐˆ¤ì(€€€€¼¼I•ÑÉä¡•±Á•ÈÑ½±•É…Ñ•ÌÑÉ…¹Í¥•¹Ð]¥¹‘½ÝÌ™¥±”±½­Ì™É½´Ñ¡”©ÕÍÐµ•¹‘•Ñ…Í¬¸(€€€•áÁ•Ð¡Í•ÉÙ¥”¤¹Ñ½½¹Ñ…¥¸ ½‘”€„ôô€‰	UMdˆ€˜˜½‘”€„ôô€‰AI4ˆ€˜˜½‘”€„ôô€‰Lˆœ¤ì(€ô¤ì((€Ñ•ÍÐ ‰]¥¹‘½ÝÌÍ•ÉÙ¥”Õ¹¥¹ÍÑ…±°É•µ½Ù•Ì•¹•É…Ñ•Ñ…Í¬a50ˆ°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍÐÍ•ÉÙ¥”€ô…Ý…¥ÐÉ•…‘Q•áÐ ‰ÍÉŒ½Í•ÉÙ¥”¹ÑÌˆ¤ì(€€€½¹ÍÐÕ¹¥¹ÍÑ…±±]¥¹‘½ÝÌ€ôÍ•ÉÙ¥”¹Í±¥”¡Í•ÉÙ¥”¹¥¹‘•á=˜ ‰™Õ¹Ñ¥½¸Õ¹¥¹ÍÑ…±±]¥¹‘½ÝÌ ¤ˆ¤°Í•ÉÙ¥”¹¥¹‘•á=˜ ‰™Õ¹Ñ¥½¸Í•ÉÙ¥•¥…¹½ÍÑ¥ÍMÕµµ…Éä ¤ˆ¤¤ì((€€€•áÁ•Ð¡Õ¹¥¹ÍÑ…±±]¥¹‘½ÝÌ¤¹Ñ½½¹Ñ…¥¸ ‰Ý¥¹‘½ÝÍM•ÉÙ¥•MÉ¥ÁÑA…Ñ  ¤ˆ¤ì(€€€•áÁ•Ð¡Õ¹¥¹ÍÑ…±±]¥¹‘½ÝÌ¤¹Ñ½½¹Ñ…¥¸ ‰Ý¥¹‘½ÝÍQ…Í­aµ±A…Ñ  ¤ˆ¤ì(€€€•áÁ•Ð¡Õ¹¥¹ÍÑ…±±]¥¹‘½ÝÌ¤¹Ñ½½¹Ñ…¥¸ ‰Õ¹±¥¹­Må¹Œ¡Ý¥¹‘½ÝÍQ…Í­aµ±A…Ñ  ¤¤ˆ¤ì(€ô¤ì((€Ñ•ÍÐ ‰Í•ÉÙ¥”±•…¹ÕÀÍÑ½ÁÌÉ…•™Õ±±ä™¥ÉÍÐÙ¥„Ñ¡”Í¡…É•ÍÑ½ÁÁ•È…¹±•…ÉÌÑ¡”Á¥™¥±”ˆ°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍÐÍ•ÉÙ¥”€ô…Ý…¥ÐÉ•…‘Q•áÐ ‰ÍÉŒ½Í•ÉÙ¥”¹ÑÌˆ¤ì((€€€•áÁ•Ð¡Í•ÉÙ¥”¤¹Ñ½½¹Ñ…¥¸ ¥µÁ½ÉÐì•áÁ…¹‘UÍ•ÉA…Ñ °•Ñ½¹™¥¥È°É•…‘A¥°É•µ½Ù•A¥°É•µ½Ù•IÕ¹Ñ¥µ•A½ÉÐô™É½´€ˆ¸½½¹™¥œˆìœ¤ì(€€€•áÁ•Ð¡Í•ÉÙ¥”¤¹Ñ½½¹Ñ…¥¸ ‰É•µ½Ù•IÕ¹Ñ¥µ•A½ÉÐ¡Á¥¤ìˆ¤ì(€€€•áÁ•Ð¡Í•ÉÙ¥”¤¹Ñ½½¹Ñ…¥¸ ¥µÁ½ÉÐì¥ÍAÉ½•ÍÍ±¥Ù”°ÍÑ½ÁAÉ½áäô™É½´€ˆ¸½±¥ˆ½ÁÉ½•ÍÌµ½¹ÑÉ½°ˆìœ¤ì(€€€•áÁ•Ð¡Í•ÉÙ¥”¤¹Ñ½½¹Ñ…¥¸ ÑåÁ”QÉ…­•‘AÉ½áå±•…¹ÕÁI•ÍÕ±Ð€ô€‰¹½¹”ˆð€‰ÍÑ…±”ˆð€‰ÍÑ½ÁÁ•ˆìœ¤ì(€€€•áÁ•Ð¡Í•ÉÙ¥”¤¹Ñ½½¹Ñ…¥¸ ‰…Íå¹Œ™Õ¹Ñ¥½¸ÍÑ½ÁQÉ…­•‘AÉ½áå%™IÕ¹¹¥¹œ ¤èAÉ½µ¥Í”ñQÉ…­•‘AÉ½áå±•…¹ÕÁI•ÍÕ±Ðøˆ¤ì(€€€•áÁ•Ð¡Í•ÉÙ¥”¤¹Ñ½½¹Ñ…¥¸ ¥˜€ …Á¥¤É•ÑÕÉ¸€‰¹½¹”ˆìœ¤ì(€€€•áÁ•Ð¡Í•ÉÙ¥”¤¹Ñ½½¹Ñ…¥¸ ‰¥˜€ …¥ÍAÉ½•ÍÍ±¥Ù”¡Á¥¤¤ˆ¤ì(€€€•áÁ•Ð¡Í•ÉÙ¥”¤¹Ñ½½¹Ñ…¥¸ É•ÑÕÉ¸€‰ÍÑ…±”ˆìœ¤ì(€€€•áÁ•Ð¡Í•ÉÙ¥”¤¹Ñ½½¹Ñ…¥¸ ‰…Ý…¥ÐÍÑ½ÁAÉ½áä¡Á¥¤ìˆ¤ì(€€€•áÁ•Ð¡Í•ÉÙ¥”¤¹Ñ½½¹Ñ…¥¸ ‰É•µ½Ù•A¥¡Á¥¤ìˆ¤ì(€€€•áÁ•Ð¡Í•ÉÙ¥”¤¹Ñ½½¹Ñ…¥¸ É•ÑÕÉ¸€‰ÍÑ½ÁÁ•ˆìœ¤ì(€ô¤ì((€Ñ•ÍÐ ‰Í•ÉÙ¥”½µµ…¹±•…¹ÕÀ±½Ì­¥±°™…¥±ÕÉ•ÌÝ¥Ñ¡½ÕÐÍ­¥ÁÁ¥¹œÉ•ÍÑ½É”½‘•±•Ñ”ˆ°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍÐÍ•ÉÙ¥”€ô…Ý…¥ÐÉ•…‘Q•áÐ ‰ÍÉŒ½Í•ÉÙ¥”¹ÑÌˆ¤ì((€€€•áÁ•Ð¡Í•ÉÙ¥”¤¹Ñ½½¹Ñ…¥¸ ‰…Íå¹Œ™Õ¹Ñ¥½¸ÍÑ½ÁQÉ…­•‘AÉ½áå½ÉM•ÉÙ¥•½µµ…¹ ¤èAÉ½µ¥Í”ñQÉ…­•‘AÉ½áå±•…¹ÕÁI•ÍÕ±Ðøˆ¤ì(€€€•áÁ•Ð¡Í•ÉÙ¥”¤¹Ñ½½¹Ñ…¥¸ ‰…Ñ €¡•ÉÈ¤ˆ¤ì(€€€•áÁ•Ð¡Í•ÉÙ¥”¤¹Ñ½½¹Ñ…¥¸ ‰…¥±•Ñ¼ÍÑ½ÀÁÉ½áäˆ¤ì(€€€•áÁ•Ð¡Í•ÉÙ¥”¤¹Ñ½½¹Ñ…¥¸ É•ÑÕÉ¸€‰¹½¹”ˆìœ¤ì(€ô¤ì)ô¤ì()‘•ÍÉ¥‰” ‰Í•ÉÙ¥”‘¥…¹½ÍÑ¥Ìˆ°€ ¤€ôøì(€€¼¼‘•É¥Ù•]¥¹‘½ÝÍM•ÉÙ¥•¥…¹½ÍÑ¥Œ¹½ÜÉ•…‘ÌÑ¡”É•¥ÍÑÉ…Ñ¥½¸a50¥ÑÍ•±˜°Í¼Ñ¡•Í”(€€¼¼¡•±Á•ÉÌ•áÁÉ•ÍÌÑ¡”½±‰½½±•…¸™¥áÑÕÉ•Ì…ÌÑ¡”‘½Õµ•¹ÑÌÑ¡…ÐÁÉ½‘Õ”Ñ¡•´¸(€€¼¼‰Õ¥±‘]¥¹‘½ÝÍQ…Í­aµ° ¤•µ¥ÑÌ•á…Ñ±äÑ¡”½µµ…¹½ÉÕµ•¹ÑÌÑ¡”Ù…±¥‘…Ñ½È•áÁ•ÑÌ(€€¼¼Ý¡•¸‰½Ñ ÕÍ”Ñ¡”Í…µ”‘•™…Õ±ÑÌ°Í¼Ñ¡”™¥áÑÕÉ”±•…Ù•ÌÑ¡”±…Õ¹¡•È‘•™…Õ±Ð…±½¹”¸(€½¹ÍÐ¡•…±Ñ¡åQ…Í­aµ°€ô€ ¤€ôø‰Õ¥±‘]¥¹‘½ÝÍQ…Í­aµ° ¤ì(€€¼¨¨I•¥ÍÑ•É•‰ÕÐÉ•Á½ÉÑ¥¹œ…¸•áÁ±¥¥Ñ±ä‘¥Í…‰±•Ñ…Í¬¸€¨¼(€½¹ÍÐ‘¥Í…‰±•‘Q…Í­aµ°€ô€ ¤€ôø¡•…±Ñ¡åQ…Í­aµ° ¤(€€€€¹É•Á±…” ˆñ¹…‰±•ùÑÉÕ”ð½¹…‰±•ùq¸€€€€ñ!¥‘‘•¸øˆ°€ˆñ¹…‰±•ù™…±Í”ð½¹…‰±•ùq¸€€€€ñ!¥‘‘•¸øˆ¤ì((€½¹ÍÐ‰…Í”€ôì(€€€Í¡•‘Õ±•Éaµ°è€ˆˆ°(€€€Í¡•‘Õ±•ÉÍÍ•ÑÍAÉ•Í•¹ÐèÑÉÕ”°(€€€¹…Ñ¥Ù•MÑ…ÑÕÌè€‰¹½¹•á¥ÍÑ•¹Ðˆ…Ì½¹ÍÐ°(€€€É•½É‘•‘	…­•¹è¹Õ±°°(€€€ÍÑ…±•	…­•‘A…Ñ¡Ìè™…±Í”°(€€€¹…Ñ¥Ù•I•Á…¥ÉÍÍ•ÑÍ=¹±äè™…±Í”°(€€€‘¥…¹½ÍÑ¥Ìè€‰±½ÌèÑ•ÍÐˆ°(€ôì(€½¹ÍÐ¥¹ÍÑ…±±•‘¹…‰±•€ôìÍ¡•‘Õ±•Éaµ°è¡•…±Ñ¡åQ…Í­aµ° ¤ôì(€½¹ÍÐ¥¹ÍÑ…±±•‘¥Í…‰±•€ôìÍ¡•‘Õ±•Éaµ°è‘¥Í…‰±•‘Q…Í­aµ° ¤ôì((€Ñ•ÍÐ ‰™…¥±Ì±½Í•™½È‘¥Í…‰±•°ÍÑ…±”°½¹™±¥Ñ¥¹œ°ÍÑ½ÁÁ•°…¹¡½ÍÐ]¥¹‘½ÝÌÍ•ÉÙ¥•Ìˆ°€ ¤€ôøì(€€€•áÁ•Ð¡‘•É¥Ù•]¥¹‘½ÝÍM•ÉÙ¥•¥…¹½ÍÑ¥Œ¡ì€¸¸¹‰…Í”°€¸¸¹¥¹ÍÑ…±±•‘¹…‰±•°É•½É‘•‘	…­•¹è€‰Í¡•‘Õ±•Èˆô¤¤¹Ñ½5…Ñ¡=‰©•Ð¡ìÙ¥…‰±”èÑÉÕ”°‰…­•¹è€‰Í¡•‘Õ±•Èˆô¤ì(€€€•áÁ•Ð¡‘•É¥Ù•]¥¹‘½ÝÍM•ÉÙ¥•¥…¹½ÍÑ¥Œ¡ì€¸¸¹‰…Í”°€¸¸¹¥¹ÍÑ…±±•‘¥Í…‰±•ô¤¤¹Ñ½5…Ñ¡=‰©•Ð¡ìÙ¥…‰±”è™…±Í”°•¹…‰±•è™…±Í”ô¤ì(€€€•áÁ•Ð¡‘•É¥Ù•]¥¹‘½ÝÍM•ÉÙ¥•¥…¹½ÍÑ¥Œ¡ì€¸¸¹‰…Í”°€¸¸¹¥¹ÍÑ…±±•‘¹…‰±•°ÍÑ…±•	…­•‘A…Ñ¡ÌèÑÉÕ”ô¤¤¹Ñ½5…Ñ¡=‰©•Ð¡ìÙ¥…‰±”è™…±Í”°ÍÑ…±”èÑÉÕ”ô¤ì(€€€•áÁ•Ð¡‘•É¥Ù•]¥¹‘½ÝÍM•ÉÙ¥•¥…¹½ÍÑ¥Œ¡ì€¸¸¹‰…Í”°€¸¸¹¥¹ÍÑ…±±•‘¹…‰±•°¹…Ñ¥Ù•MÑ…ÑÕÌè€‰ÍÑ…ÉÑ•ˆô¤¤¹Ñ½5…Ñ¡=‰©•Ð¡ìÙ¥…‰±”è™…±Í”°½¹™±¥ÐèÑÉÕ”ô¤ì(€€€•áÁ•Ð¡‘•É¥Ù•]¥¹‘½ÝÍM•ÉÙ¥•¥…¹½ÍÑ¥Œ¡ì€¸¸¹‰…Í”°¹…Ñ¥Ù•MÑ…ÑÕÌè€‰ÍÑ½ÁÁ•ˆô¤¤¹Ñ½5…Ñ¡=‰©•Ð¡ì¥¹ÍÑ…±±•èÑÉÕ”°Ù¥…‰±”è™…±Í”°ÍÑ…ÉÑ…‰±”è™…±Í”°ÍÑ…±”èÑÉÕ”°ÉÕ¹¹¥¹œè™…±Í”ô¤ì(€€€•áÁ•Ð¡‘•É¥Ù•]¥¹‘½ÝÍM•ÉÙ¥•¥…¹½ÍÑ¥Œ¡ì€¸¸¹‰…Í”°¹…Ñ¥Ù•I•Á…¥ÉÍÍ•ÑÍ=¹±äèÑÉÕ”ô¤¤¹Ñ½5…Ñ¡=‰©•Ð¡ì¥¹ÍÑ…±±•è™…±Í”°Ù¥…‰±”è™…±Í”°ÍÑ…±”èÑÉÕ”ô¤ì(€ô¤ì((€Ñ•ÍÐ ‰„ÍÑ½ÁÁ•¡•…±Ñ¡ä]¥¹M\Í•ÉÙ¥”É•µ…¥¹ÌÍÑ…ÉÑ…‰±”™É½´Ñ¡”ÑÉ…äˆ°€ ¤€ôøì(€€€½¹ÍÐÍÑ½ÁÁ•‘9…Ñ¥Ù”€ô‘•É¥Ù•]¥¹‘½ÝÍM•ÉÙ¥•¥…¹½ÍÑ¥Œ¡ì€¸¸¹‰…Í”°¹…Ñ¥Ù•MÑ…ÑÕÌè€‰ÍÑ½ÁÁ•ˆ°É•½É‘•‘	…­•¹è€‰¹…Ñ¥Ù”ˆô¤ì(€€€•áÁ•Ð¡Í•ÉÙ¥•MÑ…ÉÑ…‰±•É½µQÉ…ä¡ÍÑ½ÁÁ•‘9…Ñ¥Ù”¤¤¹Ñ½	”¡ÑÉÕ”¤ì(€€€•áÁ•Ð¡Í•ÉÙ¥•MÑ…ÉÑ…‰±•É½µQÉ…ä¡ì€¸¸¹ÍÑ½ÁÁ•‘9…Ñ¥Ù”°ÍÑ…±”èÑÉÕ”ô¤¤¹Ñ½	”¡™…±Í”¤ì(€€€•áÁ•Ð¡Í•ÉÙ¥•MÑ…ÉÑ…‰±•É½µQÉ…ä¡ì€¸¸¹ÍÑ½ÁÁ•‘9…Ñ¥Ù”°½¹™±¥ÐèÑÉÕ”ô¤¤¹Ñ½	”¡™…±Í”¤ì(€€€•áÁ•Ð¡Í•ÉÙ¥•MÑ…ÉÑ…‰±•É½µQÉ…ä¡‘•É¥Ù•]¥¹‘½ÝÍM•ÉÙ¥•¥…¹½ÍÑ¥Œ¡ì€¸¸¹‰…Í”°¹…Ñ¥Ù•MÑ…ÑÕÌè€‰Õ¹­¹½Ý¸ˆô¤¤¤¹Ñ½	”¡™…±Í”¤ì(€€€½¹ÍÐ‘¥Í…‰±•‘M¡•‘Õ±•È€ô‘•É¥Ù•]¥¹‘½ÝÍM•ÉÙ¥•¥…¹½ÍÑ¥Œ¡ì€¸¸¹‰…Í”°€¸¸¹¥¹ÍÑ…±±•‘¥Í…‰±•ô¤ì(€€€•áÁ•Ð¡Í•ÉÙ¥•MÑ…ÉÑ…‰±•É½µQÉ…ä¡‘¥Í…‰±•‘M¡•‘Õ±•È¤¤¹Ñ½	”¡™…±Í”¤ì(€€€½¹ÍÐµ¥Íµ…Ñ¡•‘M¡•‘Õ±•È€ô‘•É¥Ù•]¥¹‘½ÝÍM•ÉÙ¥•¥…¹½ÍÑ¥Œ¡ì(€€€€€€¸¸¹‰…Í”°(€€€€€€¸¸¹¥¹ÍÑ…±±•‘¹…‰±•°(€€€€€É•½É‘•‘	…­•¹è€‰¹…Ñ¥Ù”ˆ°(€€€ô¤ì(€€€•áÁ•Ð¡µ¥Íµ…Ñ¡•‘M¡•‘Õ±•È¤¹Ñ½5…Ñ¡=‰©•Ð¡ì‰…­•¹è€‰Í¡•‘Õ±•Èˆ°ÍÑ…±”èÑÉÕ”°Ù¥…‰±”è™…±Í”°ÍÑ…ÉÑ…‰±”è™…±Í”ô¤ì(€ô¤ì((€Ñ•ÍÐ ‰É•©•ÑÌµ…±™½Éµ•Í•ÉÙ¥”‰…­•¹ÍÑ…Ñ”¥¹ÍÑ•…½˜‘•™…Õ±Ñ¥¹œ¥ÐÑ¼Í¡•‘Õ±•Èˆ°€ ¤€ôøì(€€€½¹ÍÐÙ…±¥€ôì(€€€€€Ù•ÉÍ¥½¸è€È°(€€€€€½‘•á!½µ”è€‰éqq½‘•àˆ°(€€€€€½Á•¹½‘•á!½µ”è€‰éqq½Á•¹½‘•àˆ°(€€€€€‰…­•¹è€‰Í¡•‘Õ±•Èˆ°(€€€ôì(€€€•áÁ•Ð¡Á…ÉÍ•M•ÉÙ¥•%¹ÍÑ…±±MÑ…Ñ”¡Ù…±¥¤ü¹‰…­•¹¤¹Ñ½	” ‰Í¡•‘Õ±•Èˆ¤ì(€€€•áÁ•Ð¡Á…ÉÍ•M•ÉÙ¥•%¹ÍÑ…±±MÑ…Ñ”¡ì€¸¸¹Ù…±¥°‰…­•¹è€‰…É‰…”ˆô¤¤¹Ñ½	•9Õ±° ¤ì(€€€•áÁ•Ð¡Á…ÉÍ•M•ÉÙ¥•%¹ÍÑ…±±MÑ…Ñ”¡ì€¸¸¹Ù…±¥°‰…­•¹èÕ¹‘•™¥¹•ô¤¤¹Ñ½	•9Õ±° ¤ì(€€€•áÁ•Ð¡Á…ÉÍ•M•ÉÙ¥•%¹ÍÑ…±±MÑ…Ñ”¡ì€¸¸¹Ù…±¥°Ù•ÉÍ¥½¸è€Ä°‰…­•¹è€‰Í¡•‘Õ±•Èˆô¤¤¹Ñ½	•9Õ±° ¤ì(€€€•áÁ•Ð¡Á…ÉÍ•M•ÉÙ¥•%¹ÍÑ…±±MÑ…Ñ”¡ì€¸¸¹Ù…±¥°Ù•ÉÍ¥½¸è€Ä°‰…­•¹èÕ¹‘•™¥¹•ô¤ü¹Ù•ÉÍ¥½¸¤¹Ñ½	” Ä¤ì(€ô¤ì((€Ñ•ÍÐ ‰ÍÑ…ÑÕÌÍÕµµ…Éä•áÁ½Í•ÌÑ¡”Í•ÉÙ¥”±½œÁ…Ñ ˆ°€ ¤€ôøì(€€€½¹ÍÐÍÕµµ…Éä€ôÍ•ÉÙ¥•MÑ…ÑÕÍMÕµµ…Éä ¤ì((€€€•áÁ•ÑQ•áÑQ½½¹Ñ…¥¹A…Ñ ¡ÍÕµµ…Éä°Í•ÉÙ¥•1½A…Ñ  ¤¤ì(€ô¤ì((€Ñ•ÍÐ ‰™±…ÌÍÑ…±”‰…­•Í•ÉÙ¥”Á…Ñ¡ÌÉ•½É‘•…Ð¥¹ÍÑ…±°Ñ¥µ”ˆ°€ ¤€ôøì(€€€½¹ÍÐ½±‘=Á•¹½‘•á!½µ”€ôÁÉ½•ÍÌ¹•¹Ø¹=A9=a}!=5ì(€€€½¹ÍÐÍÑ…Ñ•¥È€ô©½¥¸¡QMQ}%H°€‰‰…­•µÁ…Ñ¡Ìµ¡½µ”ˆ¤ì(€€€ÑÉäì(€€€€€ÁÉ½•ÍÌ¹•¹Ø¹=A9=a}!=5€ôÍÑ…Ñ•¥Èì(€€€€€µ­‘¥ÉMå¹Œ¡ÍÑ…Ñ•¥È°ìÉ•ÕÉÍ¥Ù”èÑÉÕ”ô¤ì(€€€€€½¹ÍÐÍÑ…Ñ•A…Ñ €ô©½¥¸¡ÍÑ…Ñ•¥È°€‰Í•ÉÙ¥”µÍÑ…Ñ”¹©Í½¸ˆ¤ì((€€€€€½¹ÍÐµ¥ÍÍ¥¹œ€ô©½¥¸¡ÍÑ…Ñ•¥È°€‰½¹”ˆ°€‰‰Õ¸ˆ¤ì(€€€€€ÝÉ¥Ñ•¥±•Må¹Œ¡ÍÑ…Ñ•A…Ñ °)M=8¹ÍÑÉ¥¹¥™ä¡ì(€€€€€€€Ù•ÉÍ¥½¸è€Ä°(€€€€€€€½‘•á!½µ”èÍÑ…Ñ•¥È°(€€€€€€€½Á•¹½‘•á!½µ”èÍÑ…Ñ•¥È°(€€€€€€€‰Õ¹A…Ñ èµ¥ÍÍ¥¹œ°(€€€€€€€±¥A…Ñ è©½¥¸¡¥µÁ½ÉÐ¹µ•Ñ„¹‘¥È°€‰Í•ÉÙ¥”¹Ñ•ÍÐ¹ÑÌˆ¤°(€€€€€ô¤°€‰ÕÑ˜àˆ¤ì(€€€€€½¹ÍÐ‘¥…¹½ÍÑ¥Œ€ô‰…­•‘M•ÉÙ¥•A…Ñ¡Í¥…¹½ÍÑ¥Œ ¤ì(€€€€€•áÁ•Ð¡‘¥…¹½ÍÑ¥Œ¤¹Ñ½½¹Ñ…¥¸ ‰MQ1‰…­•Á…Ñ¡Ìˆ¤ì(€€€€€•áÁ•Ð¡‘¥…¹½ÍÑ¥Œ¤¹Ñ½½¹Ñ…¥¸¡µ¥ÍÍ¥¹œ¤ì((€€€€€ÝÉ¥Ñ•¥±•Må¹Œ¡ÍÑ…Ñ•A…Ñ °)M=8¹ÍÑÉ¥¹¥™ä¡ì(€€€€€€€Ù•ÉÍ¥½¸è€Ä°(€€€€€€€½‘•á!½µ”èÍÑ…Ñ•¥È°(€€€€€€€½Á•¹½‘•á!½µ”èÍÑ…Ñ•¥È°(€€€€€€€‰Õ¹A…Ñ è©½¥¸¡¥µÁ½ÉÐ¹µ•Ñ„¹‘¥È°€‰Í•ÉÙ¥”¹Ñ•ÍÐ¹ÑÌˆ¤°(€€€€€€€±¥A…Ñ è©½¥¸¡¥µÁ½ÉÐ¹µ•Ñ„¹‘¥È°€‰Í•ÉÙ¥”¹Ñ•ÍÐ¹ÑÌˆ¤°(€€€€€ô¤°€‰ÕÑ˜àˆ¤ì(€€€€€•áÁ•Ð¡‰…­•‘M•ÉÙ¥•A…Ñ¡Í¥…¹½ÍÑ¥Œ ¤¤¹Ñ½	•9Õ±° ¤ì((€€€€€€¼¼AÉ”µ±½½À´ÌÍÑ…Ñ”™¥±•ÌÝ¥Ñ¡½ÕÐ‰…­•Á…Ñ¡ÌÍÑ…äÍ¥±•¹Ð¸(€€€€€ÝÉ¥Ñ•¥±•Må¹Œ¡ÍÑ…Ñ•A…Ñ °)M=8¹ÍÑÉ¥¹¥™ä¡ìÙ•ÉÍ¥½¸è€Ä°½‘•á!½µ”èÍÑ…Ñ•¥È°½Á•¹½‘•á!½µ”èÍÑ…Ñ•¥Èô¤°€‰ÕÑ˜àˆ¤ì(€€€€€•áÁ•Ð¡‰…­•‘M•ÉÙ¥•A…Ñ¡Í¥…¹½ÍÑ¥Œ ¤¤¹Ñ½	•9Õ±° ¤ì(€€€ô™¥¹…±±äì(€€€€€¥˜€¡½±‘=Á•¹½‘•á!½µ”€ôôôÕ¹‘•™¥¹•¤‘•±•Ñ”ÁÉ½•ÍÌ¹•¹Ø¹=A9=a}!=5ì(€€€€€•±Í”ÁÉ½•ÍÌ¹•¹Ø¹=A9=a}!=5€ô½±‘=Á•¹½‘•á!½µ”ì(€€€ô(€ô¤ì((€Ñ•ÍÐ ‰‘¥É•ÐÍ•ÉÙ¥”ÍÑ…ÑÕÌÁÉ¥¹ÑÌÑ¡”‘¥…¹½ÍÑ¥Ì±¥¹”ˆ°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍÐÍ•ÉÙ¥”€ô…Ý…¥ÐÉ•…‘Q•áÐ ‰ÍÉŒ½Í•ÉÙ¥”¹ÑÌˆ¤ì(€€€½¹ÍÐÍÑ…ÑÕÍ…Í”€ôÍ•ÉÙ¥”¹Í±¥”¡Í•ÉÙ¥”¹¥¹‘•á=˜ …Í”€‰ÍÑ…ÑÕÌˆèœ¤°Í•ÉÙ¥”¹¥¹‘•á=˜ …Í”€‰Õ¹¥¹ÍÑ…±°ˆèœ¤¤ì((€€€•áÁ•Ð¡ÍÑ…ÑÕÍ…Í”¤¹Ñ½½¹Ñ…¥¸ ‰¥…¹½ÍÑ¥Ìèˆ¤ì(€€€•áÁ•Ð¡ÍÑ…ÑÕÍ…Í”¤¹Ñ½½¹Ñ…¥¸ ‰Í•ÉÙ¥•¥…¹½ÍÑ¥ÍMÕµµ…Éä ¤ˆ¤ì(€ô¤ì)ô¤ì