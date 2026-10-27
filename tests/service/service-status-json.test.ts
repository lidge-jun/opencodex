import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { buildWindowsTaskXml, setQuerySchtasksForTests } from "../../src/service";
import { parseServiceArgs, planServiceCommand, serviceCommand } from "../../src/service/cli";
import { maybeAutoRestoreCodexShim, skipsCodexShimAutoRestore } from "../../src/cli/codex-shim-autorestore";
import { repoPath } from "../helpers/repo-root";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";
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
import * as liveness from "../../src/server/proxy-liveness";

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

  test("a serving probe that throws still yields the document", async () => {
    const diag = deriveSystemdServiceDiagnostic({
      installed: true, enabled: true, running: true, stale: false, diagnostics: `logs: ${LOG}`,
    });
    const json = await collectServiceStatusJson({
      ...fixedDeps(diag, "linux"),
      serving: async () => { throw new Error("port resolution failed"); },
    });
    expect(json).toMatchObject({ installed: true, running: true, backend: "systemd" });
    expect(json.serving).toEqual({ probed: true, ok: false, port: null });
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

/**
 * The one non-allowlisted spawn the Windows read may make, accepted by exact argv only. The
 * scheduler verdict for a task whose trigger is scoped to a user needs the effective token SID,
 * and `resolveCurrentWindowsPrincipal` (the same process-cached lookup the secret-ACL code
 * uses) reads it with `WindowsIdentity::GetCurrent()`: it observes this process's own token
 * and changes nothing. Skipping it would turn every scoped task into a false "stale" verdict.
 */
const WINDOWS_IDENTITY_PROBE = "powershell.exe -NoLogo -NoProfile -NonInteractive -Command "
  + "$identity=[System.Security.Principal.WindowsIdentity]::GetCurrent();$identity.User.Value;$identity.Name";

/** Calls outside the allowlist; the identity probe is counted separately and capped at one. */
function unexpectedCalls(calls: readonly Spawned[], platform: NodeJS.Platform): Spawned[] {
  const identityProbes = calls.filter(call => call === WINDOWS_IDENTITY_PROBE);
  expect(identityProbes.length).toBeLessThanOrEqual(platform === "win32" ? 1 : 0);
  return calls.filter(call => call !== WINDOWS_IDENTITY_PROBE && !READ_ONLY_CALL.test(call));
}

/** Test switches for the Windows doubles; reset before every passive case. */
const windowsDoubles = { schedulerRegistered: true, scmAbsent: false };

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
    spyOn(childProcess, "execFileSync").mockImplementation(((file: unknown, args: unknown) => {
      const call = describeCall(file, args);
      calls.push(call);
      // sc.exe proves absence only with ERROR_SERVICE_DOES_NOT_EXIST (1060).
      if (windowsDoubles.scmAbsent && /^sc(?:\.exe)? query\b/i.test(call)) {
        throw Object.assign(new Error("[SC] OpenService FAILED 1060"), { status: 1060 });
      }
      return "";
    }) as never),
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
    windowsDoubles.schedulerRegistered = true;
    windowsDoubles.scmAbsent = false;
    const recorder = recordSubprocesses();
    calls = recorder.calls;
    restore = recorder.restore;
    // The Windows Task Scheduler double: it sits behind querySchtasks' own armed-test guard,
    // so a non-query call would throw before reaching it.
    setQuerySchtasksForTests(args => {
      calls.push(`schtasks ${args.join(" ")}`);
      return args.includes("/xml") && windowsDoubles.schedulerRegistered
        ? buildWindowsTaskXml(undefined, undefined, undefined, TEST_SID) : "";
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
        String(path) === "/.dockerenv" ? false
          : definition !== null && String(path) === definition ? installed : realExists(path)) as never);
      return run().finally(() => exists.mockRestore());
    });
  }

  for (const platform of ["darwin", "linux", "win32"] as const) {
    test(`${platform}: an installed registration is read without one mutating manager call`, async () => {
      const json = await withRegistration(platform, true, () =>
        collectServiceStatusJson({ diagnose: diagnoseService, serving: async () => ({ ok: false, port: 1 }) }));
      expect(json.schemaVersion).toBe(1);
      expect(json.platform).toBe(platform);
      // Non-vacuous: the manager really was asked, through the double (Docker is masked).
      expect(calls.length).toBeGreaterThan(0);
      expect(json.installed).toBe(true);
      expect(unexpectedCalls(calls, platform)).toEqual([]);
    });
  }

  test("the CLI verb answers before platformOps and spawns nothing that mutates", async () => {
    const lines: string[] = [];
    const log = spyOn(console, "log").mockImplementation((line: unknown) => { lines.push(String(line)); });
    const exit = spyOn(process, "exit").mockImplementation(((code?: number) => { throw new Error(`process.exit(${code})`); }) as never);
    // Nothing registered on any host, including a Windows runner where the real diagnosis
    // asks Task Scheduler and the SCM through the doubles.
    windowsDoubles.schedulerRegistered = false;
    windowsDoubles.scmAbsent = true;
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
    expect(unexpectedCalls(calls, process.platform)).toEqual([]);
  });

  test("an installed registration's real serving probe leaves the config home untouched", async () => {
    // A malformed, group-readable config is what a non-passive loadConfig() would repair:
    // it backs the file up as .invalid-* and hardens modes. The status read must do neither.
    const home = process.env.OPENCODEX_HOME!;
    const configPath = join(home, "config.json");
    writeFileSync(configPath, "{ not json", { mode: 0o644 });
    fs.chmodSync(configPath, 0o644);
    fs.chmodSync(home, 0o755);
    const before = { entries: readdirSync(home).sort(), file: statSync(configPath).mode, dir: statSync(home).mode };
    const probed: string[] = [];
    const identity = spyOn(liveness, "proxyIdentityAt").mockImplementation((async (port: number, opts?: { hostname?: string }) => {
      probed.push(`${opts?.hostname ?? "127.0.0.1"}:${port}`);
      return null;
    }) as never);
    const lines: string[] = [];
    const log = spyOn(console, "log").mockImplementation((line: unknown) => { lines.push(String(line)); });
    try {
      await withRegistration(process.platform, true, () => serviceCommand("status", "--json"));
    } finally {
      log.mockRestore();
      identity.mockRestore();
    }
    const json = JSON.parse(lines.at(-1)!);
    expect(json.installed).toBe(true);
    expect(json.serving.probed).toBe(true);
    expect(probed.length).toBeGreaterThan(0);
    expect({ entries: readdirSync(home).sort(), file: statSync(configPath).mode, dir: statSync(home).mode }).toEqual(before);
    expect(unexpectedCalls(calls, process.platform)).toEqual([]);
  }, 15_000);

  test("--json on a mutating verb is refused before Desktop checks or the Windows mutation lock", async () => {
    const errors: string[] = [];
    const error = spyOn(console, "error").mockImplementation((line: unknown) => { errors.push(String(line)); });
    const savedExitCode = process.exitCode;
    try {
      for (const args of [["--json"], ["install", "--json"], ["start", "--json"]]) {
        errors.length = 0;
        await onPlatform("win32", () => serviceCommand(...args));
        expect(errors).toEqual(["--json applies to `ocx service status` only."]);
        expect(process.exitCode).toBe(1);
        process.exitCode = 0;
      }
    } finally {
      error.mockRestore();
      process.exitCode = savedExitCode;
    }
    expect(calls).toEqual([]);
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

describe("service status --json CLI preflight", () => {
  test("Codex shim auto-restore is skipped for the JSON read and kept for the text report", () => {
    expect(skipsCodexShimAutoRestore("service", ["service", "status", "--json"])).toBe(true);
    expect(skipsCodexShimAutoRestore("service", ["service", "--json", "status"])).toBe(true);
    // The text report and mutating verbs keep their existing preflight.
    expect(skipsCodexShimAutoRestore("service", ["service", "status"])).toBe(false);
    expect(skipsCodexShimAutoRestore("service", ["service", "install", "--json"])).toBe(false);
    let restores = 0;
    maybeAutoRestoreCodexShim("service", ["service", "status", "--json"], {
      env: {}, warn: () => {}, readConfig: () => { throw new Error("must not read config"); },
      restore: (() => { restores += 1; return { status: "restored", message: "x" }; }) as never,
    });
    expect(restores).toBe(0);
  });

  test("the real CLI leaves every isolated home byte-for-byte unchanged", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-service-status-cli-"));
    try {
      const home = join(root, "home");
      const opencodexHome = join(root, "opencodex");
      const codexHome = join(root, "codex");
      for (const dir of [home, opencodexHome, codexHome]) fs.mkdirSync(dir, { recursive: true });
      // Port 9 (discard) is never an opencodex proxy; a malformed sibling file must stay unrepaired.
      writeFileSync(join(opencodexHome, "config.json"), JSON.stringify({ port: 9, hostname: "127.0.0.1", codexAutoStart: false, codexShimAutoRestore: true }));
      const snapshot = () => fs.readdirSync(root, { recursive: true, withFileTypes: true })
        .map(entry => {
          const path = join(entry.parentPath, entry.name);
          const stat = statSync(path);
          return `${path}|${stat.mode}|${stat.size}|${stat.mtimeMs}`;
        })
        .sort();
      const before = snapshot();
      const run = childProcess.spawnSync(process.execPath, [repoPath("src", "cli", "index.ts"), "service", "status", "--json"], {
        cwd: repoPath(),
        env: { ...process.env, HOME: home, USERPROFILE: home, OPENCODEX_HOME: opencodexHome, CODEX_HOME: codexHome, XDG_CONFIG_HOME: join(home, ".config") },
        encoding: "utf8",
      });
      expect(run.status).toBe(0);
      const json = JSON.parse(run.stdout);
      expect(json).toMatchObject({ schemaVersion: 1, installed: false, backend: "none" });
      expect(snapshot()).toEqual(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, SPAWN_BUDGET_MS);
});
