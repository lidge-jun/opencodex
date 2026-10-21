import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { buildWindowsTaskXml, setQuerySchtasksForTests } from "../../src/service";
import { parseServiceArgs, planServiceCommand, serviceCommand } from "../../src/service/cli";
import {
  deriveLaunchdServiceDiagnostic,
  deriveSystemdServiceDiagnostic,
  deriveWindowsServiceDiagnostic,
  diagnoseService,
  type ServiceDiagnostic,
} from "../../src/service/diagnostics";
import { collectServiceStatusJson, type ServiceStatusJsonDeps } from "../../src/service/status-json";
import { plistPath } from "../../src/service/state";
import { unitPath } from "../../src/service/systemd";

/**
 * `ocx service status --json` is what GOAT's inventory reads from an adopted install over
 * SSH, so its shape is a contract and its passivity is the whole point: an inventory read
 * that could start, stop, install or repair a service would be a mutation GOAT never asked
 * the user for.
 */

const TEST_SID = "S-1-5-21-111-222-333-1001";
const LOG = "/tmp/ocx-test/service.log";

function fixedDeps(diag: ServiceDiagnostic, platform: NodeJS.Platform, serving = { ok: true, port: 10100 }): ServiceStatusJsonDeps {
  return {
    platform,
    diagnose: () => diag,
    serving: async () => serving,
    logPath: () => LOG,
    leaseLine: () => null,
    desktopLogin: () => null,
  };
}

describe("service status JSON shape per platform branch", () => {
  test("macOS launchd, loaded from the current plist and serving", async () => {
    const diag = deriveLaunchdServiceDiagnostic({
      installed: true, stale: false, load: { state: "loaded-current" }, diagnostics: `logs: ${LOG}`,
    });
    expect(await collectServiceStatusJson(fixedDeps(diag, "darwin"))).toEqual({
      schemaVersion: 1,
      platform: "darwin",
      supported: true,
      backend: "launchd",
      label: "com.opencodex.proxy",
      installed: true,
      enabled: true,
      running: true,
      viable: true,
      stale: false,
      conflict: false,
      serving: { probed: true, ok: true, port: 10100 },
      summary: `installed and loaded (launchd; logs: ${LOG})`,
      logPath: LOG,
      ownershipLease: null,
      desktopLogin: null,
    });
  });

  test("macOS launchd whose state launchctl could not report stays installed but not running", async () => {
    const diag = deriveLaunchdServiceDiagnostic({
      installed: true, stale: false, load: { state: "unknown", detail: "launchctl timed out" }, diagnostics: `logs: ${LOG}`,
    });
    const json = await collectServiceStatusJson(fixedDeps(diag, "darwin", { ok: false, port: 10100 }));
    expect(json).toMatchObject({ backend: "launchd", installed: true, running: false, viable: true });
    expect(json.serving).toEqual({ probed: true, ok: false, port: 10100 });
  });

  test("Linux systemd user unit, enabled but not running", async () => {
    const diag = deriveSystemdServiceDiagnostic({
      installed: true, enabled: true, running: false, stale: false, diagnostics: `logs: ${LOG}`,
    });
    expect(await collectServiceStatusJson(fixedDeps(diag, "linux", { ok: false, port: 10100 }))).toEqual({
      schemaVersion: 1,
      platform: "linux",
      supported: true,
      backend: "systemd",
      label: "opencodex-proxy.service",
      installed: true,
      enabled: true,
      running: false,
      viable: false,
      stale: false,
      conflict: false,
      serving: { probed: true, ok: false, port: 10100 },
      summary: `installed, but not running (systemd user; logs: ${LOG})`,
      logPath: LOG,
      ownershipLease: null,
      desktopLogin: null,
    });
  });

  test("Windows Task Scheduler reports the schtasks backend", async () => {
    const diag = deriveWindowsServiceDiagnostic({
      schedulerXml: buildWindowsTaskXml(undefined, undefined, undefined, TEST_SID),
      schedulerExpectedUserId: TEST_SID,
      schedulerAssetsPresent: true,
      nativeStatus: "nonexistent",
      recordedBackend: "scheduler",
      staleBakedPaths: false,
      nativeRepairAssetsOnly: false,
      diagnostics: `logs: ${LOG}`,
    });
    expect(await collectServiceStatusJson(fixedDeps(diag, "win32"))).toEqual({
      schemaVersion: 1,
      platform: "win32",
      supported: true,
      backend: "schtasks",
      label: "opencodex-proxy",
      installed: true,
      enabled: true,
      running: true,
      viable: true,
      stale: false,
      conflict: false,
      serving: { probed: true, ok: true, port: 10100 },
      summary: `installed, Task Scheduler enabled (logs: ${LOG})`,
      logPath: LOG,
      ownershipLease: null,
      desktopLogin: null,
    });
  });

  test("Windows native WinSW reports the winsw backend and its service id", async () => {
    const diag = deriveWindowsServiceDiagnostic({
      schedulerXml: "",
      schedulerExpectedUserId: TEST_SID,
      schedulerAssetsPresent: false,
      nativeStatus: "stopped",
      recordedBackend: "native",
      staleBakedPaths: false,
      nativeRepairAssetsOnly: false,
      diagnostics: `logs: ${LOG}`,
    });
    const json = await collectServiceStatusJson(fixedDeps(diag, "win32", { ok: false, port: 10100 }));
    expect(json).toMatchObject({
      backend: "winsw", label: "opencodex-proxy-native", installed: true, running: false, enabled: false, conflict: false,
    });
  });

  test("nothing registered: backend none, no serving probe", async () => {
    let probed = false;
    const diag = deriveSystemdServiceDiagnostic({
      installed: false, enabled: false, running: false, stale: false, diagnostics: `logs: ${LOG}`,
    });
    const json = await collectServiceStatusJson({
      ...fixedDeps(diag, "linux"),
      serving: async () => { probed = true; return { ok: true, port: 10100 }; },
    });
    expect(probed).toBe(false);
    expect(json).toMatchObject({ supported: true, installed: false, running: false, backend: "none", label: null });
    expect(json.serving).toEqual({ probed: false, ok: false, port: null });
  });

  test("an unsupported platform still answers with a document", async () => {
    const diag: ServiceDiagnostic = {
      supported: false, installed: false, enabled: false, running: false, viable: false,
      startable: false, stale: false, conflict: false, backend: null, summary: "unsupported in Docker",
    };
    expect(await collectServiceStatusJson(fixedDeps(diag, "linux"))).toMatchObject({
      supported: false, installed: false, running: false, backend: "none", label: null, summary: "unsupported in Docker",
    });
  });
});

describe("service status --json argument gate", () => {
  test("--json is parsed for status and refused for every other verb", () => {
    expect(parseServiceArgs(["status", "--json"])).toEqual({ sub: "status", backend: null, invalid: [], json: true });
    expect(planServiceCommand(["status", "--json"])).toMatchObject({ ok: true, command: "status" });
    for (const args of [["--json"], ["install", "--json"], ["repair", "--json"], ["restart", "--json"], ["start", "--json"], ["stop", "--json"], ["uninstall", "--json"]]) {
      const plan = planServiceCommand(args, { probeInstallation: () => { throw new Error("must not probe"); } });
      expect(plan).toEqual({ ok: false, message: "--json applies to `ocx service status` only." });
    }
  });
});

type Spawned = string;

/**
 * Every subprocess the status read may start. Anything outside this list fails the guard,
 * including a verb nobody thought to deny: launchd `print`/`list`, systemd's observation
 * verbs, Task Scheduler `/query`, SCM `query`/`qc`, a registry `query` and identity reads.
 */
const READ_ONLY_CALL = new RegExp(
  "^(?:launchctl (?:print|list|print-disabled)\\b"
  + "|systemctl (?:--version|--user (?:show-environment|show|is-enabled|is-active|status)\\b)"
  + "|schtasks /query\\b"
  + "|sc(?:\\.exe)? (?:query|qc)\\b"
  + "|reg(?:\\.exe)? query\\b"
  + "|whoami(?:\\.exe)?\\b)",
  "i",
);

function describeCall(file: unknown, args: unknown): Spawned {
  if (Array.isArray(file)) return file.map(String).map((part, index) => index === 0 ? basename(part) : part).join(" ");
  if (file && typeof file === "object" && Array.isArray((file as { cmd?: unknown }).cmd)) {
    return describeCall((file as { cmd: unknown[] }).cmd, undefined);
  }
  const head = String(file);
  const rest = Array.isArray(args) ? args.map(String) : [];
  return [rest.length > 0 ? basename(head.replaceAll("\\", "/")) : head, ...rest].join(" ").trim();
}

function recordSubprocesses(): { calls: Spawned[]; restore: () => void } {
  const calls: Spawned[] = [];
  const result = { status: 0, stdout: "", stderr: "", pid: 1, output: [null, "", ""], signal: null };
  const spies = [
    spyOn(childProcess, "spawnSync").mockImplementation(((file: unknown, args: unknown) => { calls.push(describeCall(file, args)); return result; }) as never),
    spyOn(childProcess, "execSync").mockImplementation(((command: unknown) => { calls.push(describeCall(command, undefined)); return ""; }) as never),
    spyOn(childProcess, "execFileSync").mockImplementation(((file: unknown, args: unknown) => { calls.push(describeCall(file, args)); return ""; }) as never),
    spyOn(childProcess, "spawn").mockImplementation(((file: unknown, args: unknown) => { calls.push(describeCall(file, args)); throw new Error("async spawn is not expected"); }) as never),
    spyOn(childProcess, "execFile").mockImplementation(((file: unknown, args: unknown) => { calls.push(describeCall(file, args)); throw new Error("async execFile is not expected"); }) as never),
    spyOn(childProcess, "exec").mockImplementation(((command: unknown) => { calls.push(describeCall(command, undefined)); throw new Error("async exec is not expected"); }) as never),
    spyOn(Bun, "spawnSync").mockImplementation(((cmd: unknown) => { calls.push(describeCall(cmd, undefined)); return { exitCode: 0, success: true, stdout: Buffer.from(""), stderr: Buffer.from("") }; }) as never),
    spyOn(Bun, "spawn").mockImplementation(((cmd: unknown) => { calls.push(describeCall(cmd, undefined)); throw new Error("Bun.spawn is not expected"); }) as never),
  ];
  return { calls, restore: () => { for (const spy of spies) spy.mockRestore(); } };
}

function onPlatform<T>(platform: NodeJS.Platform, run: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...descriptor, value: platform });
  return run().finally(() => Object.defineProperty(process, "platform", descriptor));
}

describe("service status --json is passive", () => {
  const savedEnv = { ...process.env };
  const realExists = fs.existsSync;
  let calls: Spawned[];
  let restore: () => void;

  beforeEach(() => {
    process.env.OPENCODEX_HOME = mkdtempSync(join(tmpdir(), "ocx-service-status-json-"));
    const recorder = recordSubprocesses();
    calls = recorder.calls;
    restore = recorder.restore;
    // The Windows Task Scheduler double: it sits behind querySchtasks' own armed-test guard,
    // so a non-query call would throw before reaching it.
    setQuerySchtasksForTests(args => {
      calls.push(`schtasks ${args.join(" ")}`);
      return args.includes("/xml") ? buildWindowsTaskXml(undefined, undefined, undefined, TEST_SID) : "";
    });
  });

  afterEach(() => {
    setQuerySchtasksForTests(null);
    restore();
    const scratch = process.env.OPENCODEX_HOME!;
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    rmSync(scratch, { recursive: true, force: true });
  });

  /**
   * Registration presence is faked by answering existsSync for the definition path, never by
   * writing one: plistPath() and unitPath() resolve through os.homedir(), which does not follow
   * a HOME changed at runtime, so a written fixture would land in the developer's real home.
   */
  function withRegistration<T>(platform: NodeJS.Platform, installed: boolean, run: () => Promise<T>): Promise<T> {
    return onPlatform(platform, () => {
      const definition = platform === "darwin" ? plistPath() : platform === "linux" ? unitPath() : null;
      const exists = spyOn(fs, "existsSync").mockImplementation(((path: fs.PathLike) =>
        definition !== null && String(path) === definition ? installed : realExists(path)) as never);
      return run().finally(() => exists.mockRestore());
    });
  }

  for (const platform of ["darwin", "linux", "win32"] as const) {
    test(`${platform}: an installed registration is read without one mutating manager call`, async () => {
      const json = await withRegistration(platform, true, () =>
        collectServiceStatusJson({ diagnose: diagnoseService, serving: async () => ({ ok: false, port: 1 }) }));
      expect(json.schemaVersion).toBe(1);
      expect(json.platform).toBe(platform);
      if (platform !== "linux" || !realExists("/.dockerenv")) {
        // Non-vacuous: the manager really was asked, through the double.
        expect(calls.length).toBeGreaterThan(0);
        expect(json.installed).toBe(true);
      }
      expect(calls.filter(call => !READ_ONLY_CALL.test(call))).toEqual([]);
    });
  }

  test("the CLI verb answers before platformOps and spawns nothing that mutates", async () => {
    const lines: string[] = [];
    const log = spyOn(console, "log").mockImplementation((line: unknown) => { lines.push(String(line)); });
    const exit = spyOn(process, "exit").mockImplementation(((code?: number) => { throw new Error(`process.exit(${code})`); }) as never);
    try {
      await withRegistration(process.platform, false, () => serviceCommand("status", "--json"));
    } finally {
      log.mockRestore();
      exit.mockRestore();
    }
    expect(lines).toHaveLength(1);
    const json = JSON.parse(lines[0]!);
    expect(json).toMatchObject({ schemaVersion: 1, installed: false, running: false, backend: "none" });
    expect(json.serving).toEqual({ probed: false, ok: false, port: null });
    expect(calls.filter(call => !READ_ONLY_CALL.test(call))).toEqual([]);
  });

  test("the allowlist itself refuses every service-manager mutation verb", () => {
    const mutations = [
      "launchctl bootstrap gui/501 /x/com.opencodex.proxy.plist", "launchctl bootout gui/501/com.opencodex.proxy",
      "launchctl kickstart -k gui/501/com.opencodex.proxy", "launchctl load -w /x.plist", "launchctl unload /x.plist",
      "systemctl --user start opencodex-proxy.service", "systemctl --user stop opencodex-proxy.service",
      "systemctl --user restart opencodex-proxy.service", "systemctl --user enable opencodex-proxy.service",
      "systemctl --user disable opencodex-proxy.service", "systemctl --user daemon-reload",
      "schtasks /create /tn opencodex-proxy /xml x.xml", "schtasks /run /tn opencodex-proxy", "schtasks /end /tn opencodex-proxy",
      "schtasks /delete /tn opencodex-proxy /f", "schtasks /change /tn opencodex-proxy /enable",
      "sc.exe start opencodex-proxy-native", "sc.exe stop opencodex-proxy-native", "sc.exe delete opencodex-proxy-native",
      "opencodex-proxy-native.exe install", "opencodex-proxy-native.exe start", "reg add HKCU\\x",
    ];
    for (const command of mutations) expect(READ_ONLY_CALL.test(command)).toBe(false);
  });
});
