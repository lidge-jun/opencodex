import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  executeNativeProcess,
  probeNativeCodexProcesses,
  type NativeProcessExecutor,
} from "../src/codex/native-profile-processes";
import { setTrustedWindowsElevationExecutablesForTests } from "../src/lib/windows-elevation";

const TRUSTED_WMIC = "C:\\trusted-system32\\wbem\\WMIC.exe";
const TRUSTED_POWERSHELL = "C:\\trusted-system32\\WindowsPowerShell\\v1.0\\powershell.exe";

async function withTrustedWindowsWmic<T>(run: (wmic: string) => Promise<T>): Promise<T> {
  setTrustedWindowsElevationExecutablesForTests({ wmic: TRUSTED_WMIC });
  try {
    return await run(TRUSTED_WMIC);
  } finally {
    setTrustedWindowsElevationExecutablesForTests(null);
  }
}

async function withWindowsWmicAbsent<T>(run: (powershell: string) => Promise<T>): Promise<T> {
  setTrustedWindowsElevationExecutablesForTests({ wmic: null, powershell: TRUSTED_POWERSHELL });
  try {
    return await run(TRUSTED_POWERSHELL);
  } finally {
    setTrustedWindowsElevationExecutablesForTests(null);
  }
}

describe("native profile process probe", () => {
  test("uses WMIC with shell-free bounded execution and counts Codex processes", async () => {
    const calls: Parameters<NativeProcessExecutor>[] = [];
    const execFile: NativeProcessExecutor = async (file, args, options) => {
      calls.push([file, args, options]);
      // Real WMIC /format:list shape: keys in alphabetical order per block,
      // blank lines between records (ProcessId CLOSES a record).
      return [
        "CommandLine=codex app-server --serve",
        "Name=codex.exe",
        "ProcessId=41",
        "",
        'CommandLine="C:\\tools\\codex.cmd" serve',
        "Name=cmd.exe",
        "ProcessId=42",
        "",
        "CommandLine=bun D:\\tools\\opencodex\\src\\cli\\index.ts start",
        "Name=bun.exe",
        "ProcessId=99",
      ].join("\n");
    };
    await withTrustedWindowsWmic(async wmic => {
      await expect(probeNativeCodexProcesses({
        platform: "win32",
        execFile,
        pid: 99,
      })).resolves.toEqual({ status: "busy", count: 2 });

      expect(calls).toEqual([[
        wmic,
        ["process", "where", "(Name like 'codex%' or CommandLine like '%codex%')", "get", "ProcessId,Name,CommandLine", "/format:list"],
        {
          encoding: "utf8",
          timeout: 12_000,
          maxBuffer: 16 * 1024 * 1024,
          windowsHide: true,
          shell: false,
          killSignal: "SIGKILL",
        },
      ]]);
    });
  });

  test("falls back to hidden PowerShell when WMIC is absent", async () => {
    const calls: Parameters<NativeProcessExecutor>[] = [];
    const execFile: NativeProcessExecutor = async (file, args, options) => {
      calls.push([file, args, options]);
      return "2";
    };
    await withWindowsWmicAbsent(async powershell => {
      await expect(probeNativeCodexProcesses({
        platform: "win32",
        execFile,
        pid: 99,
      })).resolves.toEqual({ status: "busy", count: 2 });

      expect(calls).toHaveLength(1);
      expect(calls[0]![0]).toBe(powershell);
      expect(calls[0]![1].slice(0, 3)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive"]);
      // The PowerShell host (its script text contains "codex") and the
      // probing proxy pid are both excluded from the count.
      const script = calls[0]![1].join(" ");
      expect(script).toContain("$_.ProcessId -ne $self");
      expect(script).toContain(" $_.ProcessId -ne 99 ");
      expect(calls[0]![2].windowsHide).toBe(true);
      expect(calls[0]![2].shell).toBe(false);
    });
  });

  test("excludes its own pid on Windows", async () => {
    const execFile: NativeProcessExecutor = async () => [
      "CommandLine=codex app-server --serve",
      "Name=codex.exe",
      "ProcessId=100",
    ].join("\n");
    await withTrustedWindowsWmic(async () => {
      await expect(probeNativeCodexProcesses({
        platform: "win32",
        execFile,
        pid: 100,
      })).resolves.toEqual({ status: "clear", count: 0 });
    });
  });

  test("sets the same buffer for Unix process lists and excludes its own pid", async () => {
    const calls: Parameters<NativeProcessExecutor>[] = [];
    const execFile: NativeProcessExecutor = async (file, args, options) => {
      calls.push([file, args, options]);
      return [
        "41 codex /usr/local/bin/codex",
        "42 MainThread bun /opt/tools/codex/bin/codex.js",
        "43 bun /opt/tools/codex --serve",
      ].join("\n");
    };

    await expect(probeNativeCodexProcesses({
      platform: "linux",
      execFile,
      pid: 42,
    })).resolves.toEqual({ status: "busy", count: 2 });

    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe("ps");
    expect(calls[0]![1]).toEqual(["-eo", "pid=,comm=,args="]);
    expect(calls[0]![2].maxBuffer).toBe(16 * 1024 * 1024);
    expect(calls[0]![2].shell).toBe(false);
    expect(calls[0]![2].killSignal).toBe("SIGKILL");
  });

  test("detects Codex as the immediate entrypoint of known Unix interpreters", async () => {
    const execFile: NativeProcessExecutor = async () => [
      "43 node /usr/bin/node /usr/lib/node_modules/@openai/codex/bin/codex.js",
      "44 MainThread /home/user/.bun/bin/bun /opt/codex/bin/codex",
      "45 nodejs /usr/bin/nodejs /opt/codex/bin/codex.mjs",
      "46 bun /usr/bin/bun /opt/codex/bin/codex.cjs",
      "47 bun /usr/bin/bun /opt/codex/bin/codex.ts",
    ].join("\n");

    await expect(probeNativeCodexProcesses({
      platform: "linux",
      execFile,
      pid: 42,
    })).resolves.toEqual({ status: "busy", count: 5 });
  });

  test("does not scan beyond an exact immediate Unix interpreter entrypoint", async () => {
    const execFile: NativeProcessExecutor = async () => [
      "51 node /usr/bin/node /srv/app.js --label codex",
      "52 bun /usr/bin/bun /srv/app.ts /opt/codex.js",
      "53 node /usr/bin/node /srv/codex-helper.js",
      "54 bash /bin/bash /opt/codex",
      "55 node /usr/bin/node --require /opt/codex.js",
      "56 worker /srv/app /opt/codex",
      "57 node /usr/bin/node /srv/codex.js.backup",
      "58 codex-helper /usr/local/bin/codex-helper",
    ].join("\n");

    await expect(probeNativeCodexProcesses({
      platform: "linux",
      execFile,
      pid: 42,
    })).resolves.toEqual({ status: "clear", count: 0 });
  });

  test("does not starve an unrelated timer while a probe is pending", async () => {
    let release!: (value: string) => void;
    const execFile: NativeProcessExecutor = () => new Promise(resolve => {
      release = resolve;
    });
    const probe = probeNativeCodexProcesses({ platform: "linux", execFile, pid: 42 });

    const winner = await Promise.race([
      probe.then(() => "probe" as const),
      new Promise<"timer">(resolve => setTimeout(() => resolve("timer"), 0)),
    ]);
    expect(winner).toBe("timer");

    release("42 codex /usr/local/bin/codex\n");
    await expect(probe).resolves.toEqual({ status: "clear", count: 0 });
  });

  test("the production executor remains nonblocking while its child is pending", async () => {
    const child = executeNativeProcess(process.execPath, [
      "-e",
      "setTimeout(() => process.stdout.write('ok'), 150);",
    ], {
      encoding: "utf8",
      timeout: 2_000,
      maxBuffer: 1024,
      windowsHide: true,
      shell: false,
      killSignal: "SIGKILL",
    });

    const winner = await Promise.race([
      child.then(() => "child" as const),
      new Promise<"timer">(resolve => setTimeout(() => resolve("timer"), 0)),
    ]);
    expect(winner).toBe("timer");
    await expect(child).resolves.toBe("ok");
  });

  test("kills and settles a timed-out child", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ocx-native-probe-"));
    const survived = join(directory, "survived");
    const script = [
      `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(survived)}, 'alive'), 300);`,
      "setInterval(() => {}, 1_000);",
    ].join(" ");
    try {
      await expect(executeNativeProcess(process.execPath, ["-e", script], {
        encoding: "utf8",
        timeout: 100,
        maxBuffer: 1024,
        windowsHide: true,
        shell: false,
        killSignal: "SIGKILL",
      })).rejects.toThrow();
      await Bun.sleep(600);
      expect(existsSync(survived)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects output above the configured byte cap", async () => {
    await expect(executeNativeProcess(process.execPath, [
      "-e",
      "process.stdout.write('x'.repeat(4096));",
    ], {
      encoding: "utf8",
      timeout: 2_000,
      maxBuffer: 64,
      windowsHide: true,
      shell: false,
      killSignal: "SIGKILL",
    })).rejects.toThrow();
  });

  test("fails closed for unparseable Windows process lists", async () => {
    for (const output of ["", " ", "-1", "1.0", "garbage", "ProcessId=not-a-number", "ProcessId=9007199254740992"]) {
      await withTrustedWindowsWmic(async () => {
        await expect(probeNativeCodexProcesses({
          platform: "win32",
          execFile: async () => output,
          pid: 42,
        })).resolves.toEqual({ status: "unknown", count: 0 });
      });
    }
  });
});
