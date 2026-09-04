import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  findExecutableOnPath,
} from "../src/remote-control/workspace-executable";
import {
  remoteWorkspaceProcessInvocation,
  remoteWorkspaceThreadStartParams,
  linuxRemoteWorkspaceCommandRunnerAvailable,
  remoteWorkspaceCapabilitiesForCommandRunner,
  runRemoteWorkspaceCleanupSteps,
  stopRemoteWorkspaceProcess,
  truncateRemoteWorkspaceUtf8,
  validateRemoteWorkspaceRelativePath,
} from "../src/remote-control";

describe("Remote Workspace cross-platform boundaries", () => {
  test("resolves Windows PATH and PATHEXT with Windows grammar on every test host", () => {
    const visited: string[] = [];
    const resolved = findExecutableOnPath("claude", {
      platform: "win32",
      path: "C:\\first;D:\\npm",
      pathExt: ".PS1;.EXE;.CMD",
      probe(candidate) {
        visited.push(candidate);
        return candidate.toLowerCase() === "d:\\npm\\claude.cmd";
      },
    });
    expect(resolved).toBe("D:\\npm\\claude.cmd");
    expect(visited).toEqual([
      "C:\\first\\claude.exe",
      "C:\\first\\claude.cmd",
      "D:\\npm\\claude.exe",
      "D:\\npm\\claude.cmd",
    ]);
  });

  test("launches Windows npm shims through escaped ComSpec and leaves Unix argv direct", () => {
    const windows = remoteWorkspaceProcessInvocation(
      ["C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd", "--system-prompt", "a&b"],
      { platform: "win32", env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" } },
    );
    expect(windows.file).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(windows.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(windows.args[3]).toContain("a^&b");
    expect(windows.options.windowsVerbatimArguments).toBe(true);

    expect(remoteWorkspaceProcessInvocation(["/usr/bin/claude", "--version"], { platform: "linux" }))
      .toEqual({ file: "/usr/bin/claude", args: ["--version"], options: {} });
    expect(remoteWorkspaceProcessInvocation(["/opt/homebrew/bin/pi", "--version"], { platform: "darwin" }))
      .toEqual({ file: "/opt/homebrew/bin/pi", args: ["--version"], options: {} });
  });

  test("stops the exact Windows wrapper tree through trusted taskkill semantics", async () => {
    let settle!: (code: number) => void;
    const exited = new Promise<number>(resolve => { settle = resolve; });
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    let fallbackKills = 0;
    await stopRemoteWorkspaceProcess({
      pid: 4242,
      exitCode: null,
      exited,
      kill() { fallbackKills += 1; settle(0); },
    }, {
      platform: "win32",
      taskkillPath: "C:\\Windows\\System32\\taskkill.exe",
      execFile(file, args) { calls.push({ file, args }); settle(0); },
      waitMs: 10,
    });
    expect(calls).toEqual([{
      file: "C:\\Windows\\System32\\taskkill.exe",
      args: ["/PID", "4242", "/T", "/F"],
    }]);
    expect(fallbackKills).toBe(0);
  });

  test("escalates a Unix child that ignores SIGTERM without killing unrelated processes", async () => {
    let settle!: (code: number) => void;
    const exited = new Promise<number>(resolve => { settle = resolve; });
    const signals: Array<number | NodeJS.Signals | undefined> = [];
    await stopRemoteWorkspaceProcess({
      pid: 4243,
      exitCode: null,
      exited,
      kill(signal) {
        signals.push(signal);
        if (signal === "SIGKILL") settle(137);
      },
    }, { platform: "darwin", waitMs: 1 });
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("runs every cleanup owner even when an earlier resource fails", async () => {
    const completed: string[] = [];
    await expect(runRemoteWorkspaceCleanupSteps([
      () => { completed.push("process"); throw new Error("process cleanup failed"); },
      async () => { completed.push("bridge"); },
      () => { completed.push("isolation"); },
    ])).rejects.toThrow("process cleanup failed");
    expect(completed).toEqual(["process", "bridge", "isolation"]);
  });

  test("reports an owned child that remains alive after forced termination", async () => {
    const exited = new Promise<number>(() => {});
    await expect(stopRemoteWorkspaceProcess({
      pid: 4244,
      exitCode: null,
      exited,
      kill() {},
    }, { platform: "linux", waitMs: 1 })).rejects.toThrow("did not exit after SIGKILL");
  });

  test("reconnection cannot widen the capability grant recorded at pairing", () => {
    const runner = { async run() { return { exitCode: 0, stdout: "", stderr: "" }; } };
    expect(remoteWorkspaceCapabilitiesForCommandRunner(runner, ["workspace.read"]))
      .toEqual(["workspace.read"]);
    expect(remoteWorkspaceCapabilitiesForCommandRunner(undefined, [
      "workspace.read", "workspace.write", "workspace.exec",
    ])).toEqual(["workspace.read", "workspace.write"]);
  });

  test("bounds large UTF-8 text without quadratic trimming or split surrogate pairs", () => {
    const value = `${"가".repeat(100_000)}😀tail`;
    const truncated = truncateRemoteWorkspaceUtf8(value, 8_192);
    expect(Buffer.byteLength(truncated, "utf8")).toBeLessThanOrEqual(8_192);
    expect(truncated.endsWith("\ud83d")).toBe(false);
    expect(truncated.includes("tail")).toBe(false);
  });

  test("uses platform-native deny-local shell environments", () => {
    const windows = remoteWorkspaceThreadStartParams({
      executorName: "Windows executor",
      coordinatorIsolationPath: "/test/coordinator",
      tools: ["read_file"],
      platform: "win32",
      windowsSystemDirectory: "C:\\Windows\\System32",
      mcp: { url: "http://127.0.0.1:1/mcp", bearerTokenEnvVar: "TOKEN" },
    }) as { config: { shell_environment_policy: { set: Record<string, string> } } };
    expect(windows.config.shell_environment_policy.set).toMatchObject({
      USERPROFILE: "/test/coordinator",
      TEMP: "/test/coordinator",
      PATH: "C:\\Windows\\System32",
    });
    expect(windows.config.shell_environment_policy.set.PATH).not.toContain("/usr/");

    const mac = remoteWorkspaceThreadStartParams({
      executorName: "Mac executor",
      coordinatorIsolationPath: "/test/coordinator",
      tools: ["read_file"],
      platform: "darwin",
      mcp: { url: "http://127.0.0.1:1/mcp", bearerTokenEnvVar: "TOKEN" },
    }) as { config: { shell_environment_policy: { set: Record<string, string> } } };
    expect(mac.config.shell_environment_policy.set.PATH).toBe("/usr/bin:/bin");
  });

  test("advertises Linux exec only after the namespace probe succeeds", () => {
    if (!existsSync("/usr/bin/bwrap")) return;
    let sawNetworkIsolation = false;
    expect(linuxRemoteWorkspaceCommandRunnerAvailable({
      bubblewrapPath: "/usr/bin/bwrap",
      probe(argv) {
        sawNetworkIsolation = argv.includes("--unshare-net");
        return false;
      },
    })).toBe(false);
    expect(sawNetworkIsolation).toBe(true);
    expect(linuxRemoteWorkspaceCommandRunnerAvailable({
      bubblewrapPath: "/usr/bin/bwrap",
      probe: () => true,
    })).toBe(true);
  });

  test("rejects Windows device names, ADS, and normalized aliases without blocking POSIX names", () => {
    for (const path of ["NUL", "con.txt", "CONIN$", "CLOCK$.txt", "logs\\COM1.json", "file.txt:token", "name.", "name ", "bad\u0001name"]) {
      expect(() => validateRemoteWorkspaceRelativePath(path, undefined, "win32")).toThrow("safe Windows");
    }
    expect(validateRemoteWorkspaceRelativePath("normal\\file.txt", undefined, "win32"))
      .toBe("normal\\file.txt");
    expect(validateRemoteWorkspaceRelativePath("NUL:valid-on-posix", undefined, "linux"))
      .toBe("NUL:valid-on-posix");
  });
});
