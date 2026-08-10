import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  executeNativeProcess,
  probeNativeCodexProcesses,
  type NativeProcessExecutor,
} from "../src/codex/native-profile-processes";
import { setTrustedWindowsSystemDirectoryResolverForTests } from "../src/lib/windows-elevation";

async function withTrustedWindowsPowerShell<T>(run: (powershell: string) => Promise<T>): Promise<T> {
  const systemDirectory = mkdtempSync(join(tmpdir(), "ocx-system32-"));
  const powershell = join(systemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe");
  mkdirSync(dirname(powershell), { recursive: true });
  writeFileSync(powershell, "");
  setTrustedWindowsSystemDirectoryResolverForTests(() => systemDirectory);
  try {
    return await run(powershell);
  } finally {
    setTrustedWindowsSystemDirectoryResolverForTests(null);
    rmSync(systemDirectory, { recursive: true, force: true });
  }
}

describe("native profile process probe", () => {
  test("uses the trusted PowerShell path with shell-free bounded execution", async () => {
    const calls: Parameters<NativeProcessExecutor>[] = [];
    const execFile: NativeProcessExecutor = async (file, args, options) => {
      calls.push([file, args, options]);
      return "2\n";
    };
    const script = [
      "$ErrorActionPreference='Stop';",
      "$self=$PID;",
      "$items=Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $self -and ($_.Name -match '^(?i:codex)(?:\\.exe)?$' -or $_.CommandLine -match '(?i)(?:^|[\\\\/\"\\s])codex(?:\\.exe|\\.cmd)?(?:[\"\\s]|$)') };",
      "@($items).Count",
    ].join(" ");
    await withTrustedWindowsPowerShell(async powershell => {
      await expect(probeNativeCodexProcesses({
        platform: "win32",
        execFile,
      })).resolves.toEqual({ status: "busy", count: 2 });

      expect(calls).toEqual([[
        powershell,
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
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

  test("fails closed for non-decimal or unsafe Windows counts", async () => {
    await withTrustedWindowsPowerShell(async () => {
      for (const output of ["", " ", "-1", "1.0", "1e2", "0x10", "9007199254740992"]) {
        await expect(probeNativeCodexProcesses({
          platform: "win32",
          execFile: async () => output,
        })).resolves.toEqual({ status: "unknown", count: 0 });
      }
    });
  });
});
