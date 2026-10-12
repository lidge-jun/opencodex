import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  executeNativeProcess,
  isCodexClientProcess,
  listCodexClientProcesses,
  probeNativeCodexProcesses,
  type NativeProcessExecutor,
} from "../../src/codex/native-profile-processes";
import { setTrustedWindowsSystemDirectoryResolverForTests } from "../../src/lib/windows-elevation";
import { removeTreeWithRetry } from "../helpers/remove-tree";

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
    removeTreeWithRetry(systemDirectory);
  }
}

describe("Codex client executable identity", () => {
  const framework = "/Applications/Codex.app/Contents/Frameworks/Codex Framework.framework/Versions/152.0.7977.83/Helpers";
  const crashpad = `${framework}/browser_crashpad_handler`;
  const crashpadArgs = `${crashpad} --monitor-self --database=/Users/<user>/Library/Application Support/Codex/Crashpad`;

  test("rejects the unquoted crashpad command reported in #6291", () => {
    expect(isCodexClientProcess(crashpad, crashpadArgs)).toBe(false);
  });

  test("does not let argv0 override a full non-client executable", () => {
    for (const helper of [crashpad, `${framework}/Codex Helper (Renderer).app/Contents/MacOS/Codex Helper (Renderer)`, "/opt/Codex Tools/worker"]) {
      expect(isCodexClientProcess(helper, `${helper} --type=utility`)).toBe(false);
      expect(isCodexClientProcess(helper, `"${helper}" --type=renderer`)).toBe(false);
    }
    expect(isCodexClientProcess("/usr/bin/vim", "codex notes.txt")).toBe(false);
  });

  test("a helper basename cannot be overridden by a truncated direct argv0", () => {
    expect(isCodexClientProcess("browser_crashpad_handler", crashpadArgs)).toBe(false);
    expect(isCodexClientProcess("Codex Helper (Renderer)", `${framework}/Codex Helper (Renderer) --type=renderer`)).toBe(false);
    expect(listCodexClientProcesses({
      pid: -1,
      listSnapshots: () => [{ pid: 51182, executable: "browser_crashpad_handler", commandLine: crashpadArgs }],
    })).toEqual({ status: "enumerated", processes: [] });
  });

  test("preserves aliases and ignores framework paths in later arguments", () => {
    expect(isCodexClientProcess("worker", "/usr/bin/codex /tmp/worker")).toBe(true);
    expect(isCodexClientProcess("MainThread", "/usr/bin/codex chat")).toBe(true);
    expect(isCodexClientProcess("worker", `/usr/bin/codex ${crashpad}`)).toBe(true);
    expect(isCodexClientProcess("worker", `/usr/bin/codex --cd ${framework}`)).toBe(true);
    expect(isCodexClientProcess("worker", '/usr/bin/node "/opt/Codex CLI/codex.js" chat')).toBe(true);
  });

  test("retains direct clients and quoted immediate interpreter entrypoints", () => {
    expect(isCodexClientProcess("/Applications/CodexCLI.app/Contents/MacOS/codex", "/Applications/CodexCLI.app/Contents/MacOS/codex app-server --listen stdio://")).toBe(true);
    expect(isCodexClientProcess("/opt/CLI Tools/codex", "/opt/CLI Tools/codex chat")).toBe(true);
    expect(isCodexClientProcess("/opt/Node Tools/node", '/opt/Node Tools/node "/opt/Codex CLI/codex.js" chat')).toBe(true);
    expect(isCodexClientProcess("node", 'node "/opt/Codex CLI/codex.js" chat')).toBe(true);
    expect(isCodexClientProcess("node", 'node server.js "/opt/Codex CLI/codex.js"')).toBe(false);
    expect(isCodexClientProcess("", '"/opt/CLI Tools/codex" chat')).toBe(true);
  });

  test("retains literal apostrophes in unquoted interpreter entrypoints", () => {
    expect(isCodexClientProcess("/usr/bin/node", "/usr/bin/node /opt/O'Brien/codex.js chat")).toBe(true);
    expect(isCodexClientProcess("MainThread", "/usr/bin/bun /opt/O'Brien/codex.js chat")).toBe(true);
    expect(isCodexClientProcess("node", "node /opt/O'Brien/server.js codex.js")).toBe(false);
  });

  test("a failed macOS comm or args read stays unknown", async () => {
    for (const failedFields of ["pid=,comm=", "pid=,args="]) {
      const execFile: NativeProcessExecutor = async (_file, args) => {
        if (args[1] === failedFields) throw new Error("ps failed");
        return "60000 /usr/local/bin/codex";
      };
      await expect(probeNativeCodexProcesses({ platform: "darwin", execFile, pid: 42 }))
        .resolves.toEqual({ status: "unknown", count: 0 });
    }
  });

  test("the macOS busy probe preserves spaces in comm and excludes itself", async () => {
    const client = "/Applications/Codex CLI.app/Contents/MacOS/codex";
    const execFile: NativeProcessExecutor = async (_file, args) => {
      if (args[1] === "pid=,comm=") return `51182 ${crashpad}\n60000 ${client}\n42 ${client}`;
      if (args[1] === "pid=,args=") return `51182 ${crashpadArgs}\n60000 ${client} app-server\n42 ${client} chat`;
      return `51182 ${crashpad} ${crashpadArgs}\n60000 ${client} ${client} app-server\n42 ${client} ${client} chat`;
    };
    await expect(probeNativeCodexProcesses({ platform: "darwin", execFile, pid: 42 }))
      .resolves.toEqual({ status: "busy", count: 1 });
  });

  test("routing adoption excludes helpers without retrying a truncated argv0", () => {
    expect(listCodexClientProcesses({
      platform: "darwin", pid: -1,
      listSnapshots: () => [
        { pid: 51182, executable: crashpad, commandLine: crashpadArgs },
        { pid: 51184, executable: crashpad, commandLine: crashpadArgs },
        { pid: 60000, executable: "/usr/local/bin/codex", commandLine: "codex chat" },
      ],
    })).toEqual({ status: "enumerated", processes: [{ pid: 60000, commandLine: "codex chat" }] });
  });
});

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
    // A child marker races the parent's timeout when its event loop is busy.
    // Check the observed exit signal instead. Normal exit is a finite fuse, so
    // disabling the executor timeout fails this assertion without orphaning a child.
    const script = "setTimeout(() => process.exit(0), 10_000);";
    await expect(executeNativeProcess(process.execPath, ["-e", script], {
      encoding: "utf8",
      timeout: 100,
      maxBuffer: 1024,
      windowsHide: true,
      shell: false,
      killSignal: "SIGKILL",
    })).rejects.toMatchObject({ killed: true, signal: "SIGKILL" });
  }, 15_000);

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
