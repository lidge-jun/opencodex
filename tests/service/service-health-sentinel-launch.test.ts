import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { configDiagnosticsFromRaw, validateConfigCandidate } from "../../src/config/diagnostics";
import { serviceHealthRecoveryEnabled } from "../../src/config/feature-flags";
import { getDefaultConfig } from "../../src/config/proxy-env";
import {
  HEALTH_SENTINEL_STANDALONE_ARG,
  decideHealthSentinelLaunch,
  healthSentinelEnvironment,
  recentRecoveryNotice,
  startServiceHealthSentinel,
  stopServiceHealthSentinel,
} from "../../src/service/health-sentinel-launch";
import { HEALTH_SENTINEL_ENV } from "../../src/service/health-sentinel-main";
import { resetOptionalShutdownHooksForTests, runDrainStartHooks } from "../../src/lib/optional-shutdown-hooks";
import { WINDOWS_WRAPPER_STAY_OUT_EXIT_CODE } from "../../src/service/windows-wrapper-exit";
import { repoPath } from "../helpers/repo-root";
import { createTempHome, type TempHome } from "../helpers/temp-home";

let home: TempHome | null = null;
afterEach(() => { stopServiceHealthSentinel(); resetOptionalShutdownHooksForTests(); home?.remove(); home = null; });

const base = { enabled: true, managedService: true, standalone: false, sibling: false, execPath: "/bun", entryPath: "/pkg/src/service/health-sentinel-main.ts", entryExists: true };

describe("service health sentinel launch gate (#6671)", () => {
  test("only an enabled, managed, non-sibling service child gets a sentinel", () => {
    expect(decideHealthSentinelLaunch(base)).toEqual({ launch: true, argv: ["/bun", base.entryPath] });
    expect(decideHealthSentinelLaunch({ ...base, standalone: true })).toEqual({ launch: true, argv: ["/bun", HEALTH_SENTINEL_STANDALONE_ARG] });
    expect(decideHealthSentinelLaunch({ ...base, enabled: false })).toEqual({ launch: false, reason: null });
    for (const blocked of [{ managedService: false }, { sibling: true }, { entryExists: false }]) {
      const decision = decideHealthSentinelLaunch({ ...base, ...blocked });
      expect(decision.launch).toBe(false);
      if (!decision.launch) expect(decision.reason).toBeString();
    }
  });

  test("the sentinel environment carries its paths and no credentials or proxy settings", () => {
    const env = healthSentinelEnvironment({
      PATH: "/usr/bin",
      SystemRoot: "C:\\Windows",
      OPENCODEX_API_AUTH_TOKEN: "secret-token",
      HTTP_PROXY: "http://proxy.invalid:8080",
      OCX_SERVICE: "1",
      [HEALTH_SENTINEL_ENV.timing]: "{}",
    }, { targetPid: 9, runtimePath: "/h/runtime-port.json", historyPath: "/h/history.json", logPath: "/h/sentinel.log", statePaths: ["/h/service-state.json"] });
    expect(env).toEqual({
      PATH: "/usr/bin",
      SystemRoot: "C:\\Windows",
      [HEALTH_SENTINEL_ENV.targetPid]: "9",
      [HEALTH_SENTINEL_ENV.runtimePath]: "/h/runtime-port.json",
      [HEALTH_SENTINEL_ENV.historyPath]: "/h/history.json",
      [HEALTH_SENTINEL_ENV.logPath]: "/h/sentinel.log",
      [HEALTH_SENTINEL_ENV.statePaths]: JSON.stringify(["/h/service-state.json"]),
      [HEALTH_SENTINEL_ENV.timing]: "{}",
    });
  });

  test("a replacement announces a recent recovery of its predecessor once", () => {
    const now = 10_000_000;
    expect(recentRecoveryNotice([], 5, now)).toBeNull();
    expect(recentRecoveryNotice([{ at: now - 30_000, pid: 5, state: "terminated" }], 5, now)).toBeNull();
    expect(recentRecoveryNotice([{ at: now - 60 * 60_000, pid: 4, state: "terminated" }], 5, now)).toBeNull();
    expect(recentRecoveryNotice([{ at: now - 30_000, pid: 4, state: "skipped" }], 5, now)).toBeNull();
    expect(recentRecoveryNotice([{ at: now - 30_000, pid: 4, state: "failed" }], 5, now)).toBeNull();
    const notice = recentRecoveryNotice([{ at: now - 30_000, pid: 4, state: "terminated" }], 5, now);
    expect(notice).toContain("terminated the previous proxy (pid 4)");
    expect(notice).toContain("not replayed");
    // Intent without a recorded outcome (Windows ends the sentinel with the proxy) is reported as an attempt.
    expect(recentRecoveryNotice([{ at: now - 30_000, pid: 4, state: "intent" }], 5, now)).toContain("tried to terminate");
  });

  test("disabled config spawns nothing; enabled outside a managed service logs why", () => {
    const spawned: string[][] = [];
    const spawn = (argv: string[]) => { spawned.push(argv); return { pid: 1, stdin: null, kill() {}, unref() {} }; };
    expect(startServiceHealthSentinel({}, { env: {}, spawn })).toBeNull();
    home = createTempHome("ocx-sentinel-launch-");
    const lines: string[] = [];
    expect(startServiceHealthSentinel({ serviceHealthRecovery: { enabled: true } }, { env: { OCX_SERVICE: "1" }, spawn, log: line => lines.push(line) })).toBeNull();
    expect(spawned).toEqual([]);
    expect(lines.join("\n")).toContain("not running as the managed service");
  });

  test("a managed service child spawns the sentinel entry and stops it on shutdown", () => {
    home = createTempHome("ocx-sentinel-launch-");
    const calls: { argv: string[]; env: Record<string, string> }[] = [];
    let killed = 0;
    let ended = 0;
    const handle = startServiceHealthSentinel({ serviceHealthRecovery: { enabled: true } }, {
      env: { OCX_SERVICE_MANAGED: "1", PATH: "/usr/bin", OPENCODEX_API_AUTH_TOKEN: "secret-token" },
      spawn: (argv, env) => { calls.push({ argv, env }); return { pid: 31337, stdin: { end: () => { ended += 1; } }, kill: () => { killed += 1; }, unref() {} }; },
      log: () => {},
    });
    expect(handle?.pid).toBe(31337);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.argv).toEqual([process.execPath, repoPath("src", "service", "health-sentinel-main.ts")]);
    expect(calls[0]!.env[HEALTH_SENTINEL_ENV.targetPid]).toBe(String(process.pid));
    expect(calls[0]!.env[HEALTH_SENTINEL_ENV.historyPath]).toBe(home.path("service-health-recovery.json"));
    expect(JSON.stringify(calls[0]!.env)).not.toContain("secret-token");
    expect(JSON.parse(calls[0]!.env[HEALTH_SENTINEL_ENV.statePaths]!)).toContain(home.path("service-state.json"));
    handle!.stop();
    handle!.stop();
    expect(killed).toBe(1);
    expect(ended).toBe(1);
  });

  test("a drain withdraws the sentinel before in-flight work is awaited", () => {
    home = createTempHome("ocx-sentinel-launch-");
    let killed = 0;
    startServiceHealthSentinel({ serviceHealthRecovery: { enabled: true } }, {
      env: { OCX_SERVICE_MANAGED: "1" },
      spawn: () => ({ pid: 1, stdin: null, kill: () => { killed += 1; }, unref() {} }),
      log: () => {},
    });
    runDrainStartHooks();
    expect(killed).toBe(1);
    runDrainStartHooks();
    expect(killed).toBe(1);
    // A drain that began before startup finished never gains a sentinel.
    expect(startServiceHealthSentinel({ serviceHealthRecovery: { enabled: true } }, {
      env: { OCX_SERVICE_MANAGED: "1" },
      spawn: () => { throw new Error("must not spawn mid-drain"); },
      log: () => {},
    })).toBeNull();
    const lifecycle = readFileSync(repoPath("src", "server", "lifecycle.ts"), "utf8");
    const drain = lifecycle.indexOf("beginShutdownDrain();");
    expect(lifecycle.indexOf("runDrainStartHooks();", drain)).toBeGreaterThan(drain);
    expect(lifecycle.indexOf("runDrainStartHooks();", drain)).toBeLessThan(lifecycle.indexOf("waitForTemporaryDrainsUntil(deadline)", drain));
  });

  test("the start path wires the sentinel after readiness and stops it in cleanup", () => {
    const source = readFileSync(repoPath("src", "cli", "index.ts"), "utf8");
    // Started only after startup reconciliation closes, never between bind and readiness.
    const ready = source.indexOf("await reconcileClientStartupBeforeReady(");
    const start = source.indexOf("healthSentinel = startServiceHealthSentinel(config)");
    expect(ready).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(ready);
    expect(source).toContain("try { healthSentinel?.stop(); }");
    expect(source).toContain("if (!cleaned && !shuttingDown) healthSentinel = startServiceHealthSentinel(config)");
    expect(source).toContain("process.argv[2] === HEALTH_SENTINEL_STANDALONE_ARG");
  });
});

describe("the managers restart a proxy the sentinel terminates", () => {
  // The sentinel never restarts anything itself; it relies on each manager treating its kill as a
  // failure. Pin those contracts so a manager change cannot silently turn recovery into a stop.
  test("Windows wrapper, launchd, systemd and WinSW all restart after an unclean exit", () => {
    // TerminateProcess(handle, 1): the wrapper restarts on anything but its stay-out code.
    expect(WINDOWS_WRAPPER_STAY_OUT_EXIT_CODE).not.toBe(1);
    const wrapper = readFileSync(repoPath("src", "service", "windows-taskxml.ts"), "utf8");
    expect(wrapper).toContain("goto stopped");
    expect(wrapper).toContain('"goto loop"');
    expect(readFileSync(repoPath("src", "service", "launchd.ts"), "utf8")).toContain("<key>SuccessfulExit</key><false/>");
    // SIGKILL, not SIGTERM: systemd treats a SIGTERM death as clean and would not restart.
    expect(readFileSync(repoPath("src", "service", "systemd.ts"), "utf8")).toContain("Restart=on-failure");
    expect(readFileSync(repoPath("src", "lib", "winsw.ts"), "utf8")).toContain('<onfailure action="restart"');
    const sentinel = readFileSync(repoPath("src", "service", "health-sentinel-main.ts"), "utf8");
    expect(sentinel).toContain('process.kill(targetPid, "SIGKILL")');
    expect(sentinel).toContain("windowsHandle.terminate(1)");
  });
});

describe("serviceHealthRecovery config admission", () => {
  test("only literal true enables it", () => {
    expect(serviceHealthRecoveryEnabled({})).toBe(false);
    expect(serviceHealthRecoveryEnabled({ serviceHealthRecovery: { enabled: false } })).toBe(false);
    expect(serviceHealthRecoveryEnabled({ serviceHealthRecovery: { enabled: true } })).toBe(true);
  });

  test("live writes reject malformed and unknown fields; persisted ones degrade to off", () => {
    const config = getDefaultConfig();
    expect(validateConfigCandidate({ ...config, serviceHealthRecovery: { enabled: "yes" } })).toMatchObject({
      ok: false,
      error: "schema_invalid: serviceHealthRecovery.enabled: must be a boolean",
    });
    expect(validateConfigCandidate({ ...config, serviceHealthRecovery: { enabled: true, intervalMs: 1 } })).toMatchObject({
      ok: false,
      error: "schema_invalid: serviceHealthRecovery: contains an unsupported field",
    });
    expect(validateConfigCandidate({ ...config, serviceHealthRecovery: { enabled: true } })).toMatchObject({ ok: true });
    for (const serviceHealthRecovery of [{ enabled: "yes" }, { enabled: true, intervalMs: 1 }, "on"]) {
      const diagnostics = configDiagnosticsFromRaw(JSON.stringify({ ...config, serviceHealthRecovery }));
      expect(diagnostics.config.serviceHealthRecovery).toBeUndefined();
      expect(diagnostics.config.providers).toEqual(config.providers);
    }
  });
});
