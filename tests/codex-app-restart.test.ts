import { describe, expect, test } from "bun:test";
import { scheduleCodexAppRestart } from "../src/codex/restart-app";
import { handleManagementAPI } from "../src/server/management-api";

describe("Codex Desktop restart", () => {
  test("schedules the Windows package restart without killing unrelated processes", () => {
    const callbacks: Array<() => void> = [];
    const execCalls: Array<[string, string[]]> = [];
    const spawnCalls: Array<[string, string[]]> = [];
    const result = scheduleCodexAppRestart({
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
      execFile: (file, args) => {
        execCalls.push([file, args]);
        return file.endsWith("powershell.exe")
          ? JSON.stringify({ appId: "OpenAI.Codex_abc!App", pids: [321] })
          : "";
      },
      spawnDetached: (file, args) => { spawnCalls.push([file, args]); },
      schedule: callback => { callbacks.push(callback); return 0; },
    });

    expect(result).toEqual({ ok: true, scheduled: true });
    callbacks.shift()?.();
    callbacks.shift()?.();
    expect(execCalls.some(([file, args]) => file.endsWith("taskkill.exe") && args.join(" ") === "/PID 321 /T /F")).toBe(true);
    expect(spawnCalls).toEqual([["C:\\Windows\\explorer.exe", ["shell:AppsFolder\\OpenAI.Codex_abc!App"]]]);
  });

  test("management API schedules restart through its injectable boundary", async () => {
    let calls = 0;
    const url = new URL("http://127.0.0.1:10100/api/codex/restart");
    const response = await handleManagementAPI(
      new Request(url, { method: "POST" }),
      url,
      { providers: [] } as never,
      { restartCodexApp: () => { calls += 1; return { ok: true, scheduled: true }; } },
    );
    expect(response?.status).toBe(202);
    expect(calls).toBe(1);
  });
});
