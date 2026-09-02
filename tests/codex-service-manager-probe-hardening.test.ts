import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createWindowsTaskListingCache,
  inspectServiceManagerInstallation,
  type ServiceManagerInstallation,
  type RawProbeRunner,
} from "../src/service-manager-probe";
import { inspectNativeCodexOwnership } from "../src/integrations/native/ownership-preflight";
import { setTrustedWindowsSystemDirectoryResolverForTests } from "../src/lib/windows-elevation";
import { getDefaultConfig } from "../src/config";
import { startServer } from "../src/server";
import { removeTreeWithRetry } from "./helpers/remove-tree";

let home = "";
let configDir = "";
let trustedSystem32 = "";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-probe-hardening-"));
  configDir = join(home, "custom-opencodex");
  trustedSystem32 = join(home, "System32");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(trustedSystem32, { recursive: true });
  writeFileSync(join(trustedSystem32, "schtasks.exe"), "");
  writeFileSync(join(trustedSystem32, "sc.exe"), "");
  setTrustedWindowsSystemDirectoryResolverForTests(() => trustedSystem32);
});

afterEach(() => {
  setTrustedWindowsSystemDirectoryResolverForTests(null);
  removeTreeWithRetry(home);
});

function raw(
  status: number | null,
  stdout = "",
  stderr = "",
  extra: Partial<ReturnType<RawProbeRunner>> = {},
): ReturnType<RawProbeRunner> {
  return {
    status,
    stdout: Buffer.from(stdout, "utf8"),
    stderr: Buffer.from(stderr, "utf8"),
    timedOut: false,
    spawnFailed: false,
    ...extra,
  };
}

function cp949KoreanFixture(value: string): Buffer {
  const parts = value.split("한글");
  if (parts.length !== 2) throw new Error("fixture must contain exactly one Korean marker");
  return Buffer.concat([
    Buffer.from(parts[0]!, "ascii"),
    Buffer.from([0xc7, 0xd1, 0xb1, 0xdb]),
    Buffer.from(parts[1]!, "ascii"),
  ]);
}

function schedulerXml(launcherPath: string): string {
  const escaped = launcherPath.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    "<Task>",
    "  <Actions>",
    "    <Exec>",
    `      <Arguments>/b /nologo &quot;${escaped}&quot;</Arguments>`,
    "    </Exec>",
    "  </Actions>",
    "</Task>",
  ].join("\n");
}

function writeSchedulerChain(
  dir: string,
  codexHome: string,
  opencodexHome: string,
  options: { writeTaskXml?: boolean } = {},
): { launcher: string; wrapper: string; taskXml: string } {
  mkdirSync(dir, { recursive: true });
  const wrapper = join(dir, "opencodex-service.cmd");
  const launcher = join(dir, "opencodex-service-launcher.vbs");
  const taskXml = join(dir, "opencodex-service-task.xml");
  writeFileSync(wrapper, [
    "@echo off",
    "setlocal",
    `set "CODEX_HOME=${codexHome}"`,
    `set "OPENCODEX_HOME=${opencodexHome}"`,
    'set "OCX_BUN=C:\\bun\\bun.exe"',
    'set "OCX_CLI=C:\\opencodex\\src\\cli\\index.ts"',
    ":loop",
    '"%OCX_BUN%" "%OCX_CLI%" start --port 10100',
  ].join("\r\n"));
  writeFileSync(launcher, `shell.Run """${wrapper}""", 0, True\r\n`);
  if (options.writeTaskXml !== false) writeFileSync(taskXml, schedulerXml(launcher));
  return { launcher, wrapper, taskXml };
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function writeWinsw(
  dir: string,
  codexHome: string,
  opencodexHome: string,
): void {
  const winswDir = join(dir, "winsw");
  mkdirSync(winswDir, { recursive: true });
  writeFileSync(join(winswDir, "opencodex-proxy-native.exe"), "not-executable-test-placeholder");
  writeFileSync(join(winswDir, "opencodex-proxy-native.xml"), [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<service>",
    "  <id>opencodex-proxy-native</id>",
    `  <env name="CODEX_HOME" value="${xmlEscape(codexHome)}"/>`,
    `  <env name="OPENCODEX_HOME" value="${xmlEscape(opencodexHome)}"/>`,
    '  <arguments>"C:\\cli\\index.ts" start --port 10100</arguments>',
    "</service>",
  ].join("\n"));
}

function taskAbsentRunner(calls: Array<{ file: string; args: readonly string[] }>): RawProbeRunner {
  return (file, args) => {
    calls.push({ file, args });
    if (args[0]?.toLowerCase() === "query" && args.includes("/xml")) {
      return raw(1, "", "ERROR: The system cannot find the file specified.");
    }
    if (args[0]?.toLowerCase() === "/query" && args.includes("/xml")) {
      return raw(1, "", "ERROR: The system cannot find the file specified.");
    }
    if (args.includes("/fo")) return raw(0, "");
    return raw(1, "", "ERROR: The system cannot find the file specified.");
  };
}

describe("Windows ownership probe hardening regressions", () => {
  /*
   * #2914, the reported host: zh-CN Windows, no task, no service, 401 scheduled
   * tasks. The targeted query answers in CP936, which the English regex cannot
   * match, so absence is settled by the locale-neutral listing — and that
   * listing needed 12.3s while the probe killed it at 2s, leaving `unknown` and
   * an `ocx sync` that refused to write for want of ownership proof.
   */
  const GBK_TASK_NOT_FOUND = Buffer.from(
    "b4edcef33a20cfb5cdb3d5d2b2bbb5bdd6b8b6a8b5c4cec4bcfea1a3",
    "hex",
  );

  test("the reported zh-CN host reaches absence through the listing (#2914)", () => {
    const calls: Array<{ file: string; args: readonly string[]; timeoutMs?: number }> = [];
    const runRaw: RawProbeRunner = (file, args, runnerOptions) => {
      calls.push({ file, args, timeoutMs: runnerOptions?.timeoutMs });
      if (file.toLowerCase().endsWith("sc.exe")) return raw(1, "", "1060");
      if (args.includes("/xml")) {
        return { status: 1, stdout: Buffer.alloc(0), stderr: GBK_TASK_NOT_FOUND, timedOut: false, spawnFailed: false };
      }
      // 401 tasks, none of them ours.
      if (args.includes("/fo")) return raw(0, '"\\SomeOtherTask","N/A","Ready"\r\n');
      return raw(1, "", "");
    };

    const result = inspectServiceManagerInstallation({
      platform: "win32",
      home,
      configDir,
      windowsLocale: "zh-CN",
      runRaw,
      winswStatus: () => "nonexistent",
    });

    // "absent" is the answer that admits the write; "unknown" is what refused it.
    expect(result.kind).toBe("absent");
    // The listing is the only locale-neutral evidence, so it MUST get the budget
    // that a 401-task host can actually finish inside.
    const listing = calls.find(call => call.args.includes("/fo"));
    expect(listing?.timeoutMs).toBe(20_000);
    // Targeted queries keep the short admission ceiling: this is not a general
    // relaxation of the probe's budget.
    for (const call of calls.filter(c => c.args.includes("/xml"))) {
      expect(call.timeoutMs).toBeUndefined();
    }
  });

  test("a listing that outruns even the wider budget stays unknown (#2914)", () => {
    const runRaw: RawProbeRunner = (file, args) => {
      if (file.toLowerCase().endsWith("sc.exe")) return raw(1, "", "1060");
      if (args.includes("/xml")) {
        return { status: 1, stdout: Buffer.alloc(0), stderr: GBK_TASK_NOT_FOUND, timedOut: false, spawnFailed: false };
      }
      if (args.includes("/fo")) return raw(null, "", "", { timedOut: true });
      return raw(1, "", "");
    };

    const result = inspectServiceManagerInstallation({
      platform: "win32",
      home,
      configDir,
      windowsLocale: "zh-CN",
      runRaw,
      winswStatus: () => "nonexistent",
    });

    // A wider budget must not become an excuse to guess when it still expires.
    expect(result.kind).toBe("unknown");
  });

  test("one startup keeps two targeted queries but shares one unchanged full listing (#2923)", async () => {
    const codexHome = join(home, "codex");
    mkdirSync(codexHome, { recursive: true });
    process.env.CODEX_HOME = codexHome;
    process.env.OPENCODEX_HOME = configDir;
    writeFileSync(join(configDir, "config.json"), JSON.stringify({
      ...getDefaultConfig(),
      port: 0,
      hostname: "127.0.0.1",
      clientIntegrations: { codex: false },
      subagentModels: [],
    }, null, 2));

    let targetedQueries = 0;
    let fullListings = 0;
    const runRaw: RawProbeRunner = (file, args) => {
      if (!file.toLowerCase().endsWith("schtasks.exe")) return raw(1, "", "unexpected executable");
      if (args.includes("/xml")) {
        targetedQueries += 1;
        return { status: 1, stdout: Buffer.alloc(0), stderr: GBK_TASK_NOT_FOUND, timedOut: false, spawnFailed: false };
      }
      if (args.includes("/fo")) {
        fullListings += 1;
        return raw(0, '"\\SomeOtherTask","N/A","Ready"\r\n');
      }
      return raw(1, "", "unexpected query");
    };
    const ownerships: string[] = [];
    const server = startServer(0, {
      resolveServiceHomes: () => ({ codexHome, opencodexHome: configDir }),
      inspectNativeCodexOwnership: scope => {
        const answer = inspectNativeCodexOwnership({
          ...scope,
          // `startServer` derives statePaths from the sandbox home AND the default
          // `homedir()` mirror, which no test env moves — so without pinning this the
          // fixture reads the developer's real installation and calls it foreign.
          statePaths: [join(configDir, "service-state.json")],
          platform: "win32",
          home,
          configDir,
          windowsLocale: "zh-CN",
          runRaw,
          winswStatus: () => "nonexistent",
        });
        ownerships.push(answer.ownership);
        return answer;
      },
    });
    try {
      expect(ownerships.slice(0, 2)).toEqual(["owned", "owned"]);
      expect(targetedQueries).toBe(2);
      expect(fullListings).toBe(1);
    } finally {
      await server.stop(true);
    }
  });

  test("a task that appears between cached-listing checks is not reported absent (#2923)", () => {
    const cache = createWindowsTaskListingCache();
    let targetedQueries = 0;
    let fullListings = 0;
    const launcher = join(configDir, "opencodex-service-launcher.vbs");
    const runRaw: RawProbeRunner = (file, args) => {
      if (!file.toLowerCase().endsWith("schtasks.exe")) return raw(1, "", "unexpected executable");
      if (args.includes("/xml")) {
        targetedQueries += 1;
        return targetedQueries === 1
          ? { status: 1, stdout: Buffer.alloc(0), stderr: GBK_TASK_NOT_FOUND, timedOut: false, spawnFailed: false }
          : raw(0, schedulerXml(launcher));
      }
      if (args.includes("/fo")) {
        fullListings += 1;
        return raw(0, '"\\SomeOtherTask","N/A","Ready"\r\n');
      }
      return raw(1, "", "unexpected query");
    };

    const first = inspectServiceManagerInstallation({
      platform: "win32",
      home,
      configDir,
      windowsLocale: "zh-CN",
      runRaw,
      winswStatus: () => "nonexistent",
      windowsTaskListingCache: cache,
    });
    const second = inspectServiceManagerInstallation({
      platform: "win32",
      home,
      configDir,
      windowsLocale: "zh-CN",
      runRaw,
      winswStatus: () => "nonexistent",
      windowsTaskListingCache: cache,
    });

    expect(first.kind).toBe("absent");
    expect(second.kind).toBe("unknown");
    expect(targetedQueries).toBe(2);
    expect(fullListings).toBe(1);
  });

  test("changed targeted evidence cannot reuse an earlier absence listing (#2923)", () => {
    const cache = createWindowsTaskListingCache();
    let targetedQueries = 0;
    let fullListings = 0;
    const runRaw: RawProbeRunner = (file, args) => {
      if (!file.toLowerCase().endsWith("schtasks.exe")) return raw(1, "", "unexpected executable");
      if (args.includes("/xml")) {
        targetedQueries += 1;
        return targetedQueries === 1
          ? { status: 1, stdout: Buffer.alloc(0), stderr: GBK_TASK_NOT_FOUND, timedOut: false, spawnFailed: false }
          : raw(1, "", "ERROR: Access is denied. (0x80070005)");
      }
      if (args.includes("/fo")) {
        fullListings += 1;
        return fullListings === 1
          ? raw(0, '"\\SomeOtherTask","N/A","Ready"\r\n')
          : raw(0, '"\\opencodex-proxy","N/A","Ready"\r\n');
      }
      return raw(1, "", "unexpected query");
    };

    const first = inspectServiceManagerInstallation({
      platform: "win32",
      home,
      configDir,
      windowsLocale: "zh-CN",
      runRaw,
      winswStatus: () => "nonexistent",
      windowsTaskListingCache: cache,
    });
    const second = inspectServiceManagerInstallation({
      platform: "win32",
      home,
      configDir,
      windowsLocale: "zh-CN",
      runRaw,
      winswStatus: () => "nonexistent",
      windowsTaskListingCache: cache,
    });

    expect(first.kind).toBe("absent");
    expect(second.kind).toBe("unknown");
    expect(targetedQueries).toBe(2);
    expect(fullListings).toBe(2);
  });

  test("a cached listing failure remains fail-closed (#2923)", () => {
    const cache = createWindowsTaskListingCache();
    let fullListings = 0;
    const runRaw: RawProbeRunner = (file, args) => {
      if (!file.toLowerCase().endsWith("schtasks.exe")) return raw(1, "", "unexpected executable");
      if (args.includes("/xml")) {
        return { status: 1, stdout: Buffer.alloc(0), stderr: GBK_TASK_NOT_FOUND, timedOut: false, spawnFailed: false };
      }
      if (args.includes("/fo")) {
        fullListings += 1;
        return raw(null, "", "", { timedOut: true });
      }
      return raw(1, "", "unexpected query");
    };

    const answers = [0, 1].map(() => inspectServiceManagerInstallation({
      platform: "win32",
      home,
      configDir,
      windowsLocale: "zh-CN",
      runRaw,
      winswStatus: () => "nonexistent",
      windowsTaskListingCache: cache,
    }));

    expect(answers.map(answer => answer.kind)).toEqual(["unknown", "unknown"]);
    // Fail-closed on both passes, and the stall was NOT retained as evidence: a
    // transient timeout must not make ownership unprovable for the whole startup.
    expect(fullListings).toBe(2);
  });

  test("a listing that recovers after a stall is not masked by the failed one (#2923)", () => {
    const cache = createWindowsTaskListingCache();
    let stall = true;
    let fullListings = 0;
    const runRaw: RawProbeRunner = (file, args) => {
      if (!file.toLowerCase().endsWith("schtasks.exe")) return raw(1, "", "unexpected executable");
      if (args.includes("/xml")) {
        // Byte-identical on both passes, so the identity check cannot be what
        // forces the retry — only refusing to cache the stall can.
        return { status: 1, stdout: Buffer.alloc(0), stderr: GBK_TASK_NOT_FOUND, timedOut: false, spawnFailed: false };
      }
      if (args.includes("/fo")) {
        fullListings += 1;
        if (stall) return raw(null, "", "", { timedOut: true });
        return raw(0, '"\\SomeOtherTask","N/A","Ready"\r\n');
      }
      return raw(1, "", "unexpected query");
    };
    const probe = (): ServiceManagerInstallation => inspectServiceManagerInstallation({
      platform: "win32",
      home,
      configDir,
      windowsLocale: "zh-CN",
      runRaw,
      winswStatus: () => "nonexistent",
      windowsTaskListingCache: cache,
    });

    expect(probe().kind).toBe("unknown");
    stall = false;
    expect(probe().kind).toBe("absent");
    expect(fullListings).toBe(2);
  });

  test("a scheduler registered for another OpenCodex home does not claim the current home (#2800)", () => {
    const foreignConfigDir = join(home, "foreign-opencodex");
    const foreignLauncher = join(foreignConfigDir, "opencodex-service-launcher.vbs");
    const runRaw: RawProbeRunner = (file, args) => {
      if (file.toLowerCase().endsWith("sc.exe")) return raw(1, "", "1060");
      if (args.includes("/xml")) return raw(0, schedulerXml(foreignLauncher));
      return raw(1, "", "unexpected query");
    };

    const result = inspectNativeCodexOwnership({
      platform: "win32",
      home,
      configDir,
      runRaw,
      winswStatus: () => "nonexistent",
      statePaths: [],
      currentHomes: {
        codexHome: join(home, "current-codex"),
        opencodexHome: configDir,
      },
    });

    expect(result).toEqual({
      ownership: "owned",
      reason: "no service state and no service manager claim",
    });
  });

  test("a current-home scheduler with missing local task XML remains unproven", () => {
    const localLauncher = join(configDir, "opencodex-service-launcher.vbs");
    const runRaw: RawProbeRunner = (file, args) => {
      if (file.toLowerCase().endsWith("sc.exe")) return raw(1, "", "1060");
      if (args.includes("/xml")) return raw(0, schedulerXml(localLauncher));
      return raw(1, "", "unexpected query");
    };

    const result = inspectNativeCodexOwnership({
      platform: "win32",
      home,
      configDir,
      runRaw,
      winswStatus: () => "nonexistent",
      statePaths: [],
      currentHomes: {
        codexHome: join(home, "current-codex"),
        opencodexHome: configDir,
      },
    });

    expect(result).toEqual({
      ownership: "unknown",
      reason: "Task Scheduler holds opencodex-proxy but its task XML is missing",
    });
  });

  test("registered CP949 task XML preserves a Korean profile path", () => {
    const koreanConfigDir = join(home, "한글", ".opencodex");
    const codexHome = join(home, "한글", ".codex");
    const chain = writeSchedulerChain(koreanConfigDir, codexHome, koreanConfigDir);
    const runRaw: RawProbeRunner = (file, args) => {
      if (file.toLowerCase().endsWith("sc.exe")) return raw(1, "", "1060");
      if (args.includes("/xml")) {
        return {
          ...raw(0),
          stdout: cp949KoreanFixture(schedulerXml(chain.launcher)),
        };
      }
      return raw(1, "", "unexpected query");
    };

    const result = inspectServiceManagerInstallation({
      platform: "win32",
      home,
      configDir: koreanConfigDir,
      runRaw,
      windowsLocale: "ko-KR",
    });

    expect(result.kind).toBe("present");
    if (result.kind !== "present") return;
    expect(result.claims[0].registration).toBe("present");
    expect(result.claims[0].homes).toEqual({ codexHome, opencodexHome: koreanConfigDir });
  });

  test("ownership inspects the effective current OPENCODEX_HOME without an injected configDir", () => {
    const currentCodexHome = "C:\\current\\.codex";
    const foreignCodexHome = "C:\\foreign\\.codex";
    writeSchedulerChain(configDir, foreignCodexHome, configDir);
    const statePath = join(configDir, "service-state.json");
    writeFileSync(statePath, JSON.stringify({
      version: 2,
      backend: "scheduler",
      codexHome: currentCodexHome,
      opencodexHome: configDir,
    }));
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const runRaw = taskAbsentRunner(calls);

    const result = inspectNativeCodexOwnership({
      platform: "win32",
      home,
      runRaw,
      winswStatus: () => "nonexistent",
      statePaths: [statePath],
      currentHomes: { codexHome: currentCodexHome, opencodexHome: configDir },
    });

    expect(result.ownership).toBe("unknown");
    expect(result.reason).toContain("different homes");
  });

  test("the default WinSW registration probe uses bounded trusted sc.exe instead of executing the WinSW binary", () => {
    const codexHome = "C:\\owned\\.codex";
    writeWinsw(configDir, codexHome, configDir);
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const runRaw: RawProbeRunner = (file, args) => {
      calls.push({ file, args });
      if (file.toLowerCase().endsWith("sc.exe")) return raw(0, "SERVICE_NAME: opencodex-proxy-native");
      if (args.includes("/xml")) return raw(1, "", "ERROR: Das System kann die angegebene Datei nicht finden.");
      if (args.includes("/fo")) return raw(0, "");
      return raw(1, "", "unexpected query");
    };

    const result = inspectServiceManagerInstallation({ platform: "win32", home, configDir, runRaw });

    expect(result.kind).toBe("present");
    if (result.kind !== "present") return;
    expect(result.claims[0].backend).toBe("winsw");
    expect(calls.some(call => call.file.toLowerCase().endsWith("sc.exe")
      && call.args[0] === "query"
      && call.args[1] === "opencodex-proxy-native")).toBe(true);
    expect(calls.every(call => call.file.toLowerCase().includes("system32"))).toBe(true);
  });

  test("registered scheduler plus registered WinSW conflicts even when staged task XML is missing", () => {
    const codexHome = "C:\\owned\\.codex";
    const scheduler = writeSchedulerChain(configDir, codexHome, configDir, { writeTaskXml: false });
    writeWinsw(configDir, codexHome, configDir);
    const runRaw: RawProbeRunner = (_file, args) => {
      if (args.includes("/xml")) return raw(0, schedulerXml(scheduler.launcher));
      return raw(1, "", "unexpected query");
    };

    const result = inspectServiceManagerInstallation({
      platform: "win32",
      home,
      configDir,
      runRaw,
      winswStatus: () => "started",
    });

    expect(result.kind).toBe("conflict");
    if (result.kind !== "conflict") return;
    expect(result.claims.map(claim => claim.backend).sort()).toEqual(["scheduler", "winsw"]);
  });

  test("a scheduler definition cannot make the probe follow a launcher outside the generated config chain", () => {
    const foreignDir = join(home, "foreign");
    const foreign = writeSchedulerChain(foreignDir, "C:\\foreign\\.codex", foreignDir);
    writeFileSync(join(configDir, "opencodex-service-task.xml"), schedulerXml(foreign.launcher));
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const runRaw = taskAbsentRunner(calls);

    const result = inspectServiceManagerInstallation({
      platform: "win32",
      home,
      configDir,
      runRaw,
      winswStatus: () => "nonexistent",
    });

    expect(result.kind).toBe("unknown");
    expect(result.kind === "unknown" && result.reason).toContain("expected launcher");
  });

  test("localized schtasks task-not-found output falls back to the task listing before declaring absence", () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const runRaw: RawProbeRunner = (file, args) => {
      calls.push({ file, args });
      if (args.includes("/xml")) {
        return raw(1, "", "FEHLER: Das System kann die angegebene Datei nicht finden.");
      }
      if (args.includes("/fo")) {
        return raw(0, '"\\SomeOtherTask","N/A","Ready"\r\n');
      }
      return raw(1, "", "unexpected query");
    };

    const result = inspectServiceManagerInstallation({
      platform: "win32",
      home,
      configDir,
      runRaw,
      winswStatus: () => "nonexistent",
    });

    expect(result.kind).toBe("absent");
    expect(calls.some(call => call.args.includes("/fo"))).toBe(true);
  });

  test("a staged but unregistered WinSW definition remains visible as a present claim", () => {
    const codexHome = "C:\\staged\\.codex";
    writeWinsw(configDir, codexHome, configDir);
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const runRaw = taskAbsentRunner(calls);

    const result = inspectServiceManagerInstallation({
      platform: "win32",
      home,
      configDir,
      runRaw,
      winswStatus: () => "nonexistent",
    });

    expect(result.kind).toBe("present");
    if (result.kind !== "present") return;
    expect(result.claims[0].backend).toBe("winsw");
    expect(result.claims[0].registration).toBe("absent");
  });

  test("legacy v1 service state means scheduler and cannot authorize a WinSW manager", () => {
    const codexHome = "C:\\owned\\.codex";
    writeWinsw(configDir, codexHome, configDir);
    const statePath = join(configDir, "service-state.json");
    writeFileSync(statePath, JSON.stringify({
      version: 1,
      codexHome,
      opencodexHome: configDir,
    }));
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const runRaw = taskAbsentRunner(calls);

    const result = inspectNativeCodexOwnership({
      platform: "win32",
      home,
      configDir,
      runRaw,
      winswStatus: () => "started",
      statePaths: [statePath],
      currentHomes: { codexHome, opencodexHome: configDir },
    });

    expect(result.ownership).toBe("unknown");
    expect(result.reason).toContain("backend scheduler");
  });

  test("WinSW home values are XML-unescaped before ownership comparison", () => {
    const codexHome = "C:\\Users\\A&B\\.codex";
    writeWinsw(configDir, codexHome, configDir);
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const runRaw = taskAbsentRunner(calls);

    const result = inspectServiceManagerInstallation({
      platform: "win32",
      home,
      configDir,
      runRaw,
      winswStatus: () => "started",
    });

    expect(result.kind).toBe("present");
    if (result.kind !== "present") return;
    expect(result.claims[0].homes.codexHome).toBe(codexHome);
  });
});
