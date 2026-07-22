import { describe, expect, test } from "bun:test";
import { restartCodexApp, type RestartCodexAppResult } from "../src/codex/restart-app";
import { handleManagementAPI } from "../src/server/management-api";

describe("Codex Desktop restart", () => {
  test("Windows waits for a scoped package stop and verified relaunch", async () => {
    const calls: Array<[string, string[]]> = [];
    const result = await restartCodexApp({
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
      execFile: async (file, args) => {
        calls.push([file, args]);
        return JSON.stringify({ appId: "OpenAI.Codex_abc!App", restarted: true });
      },
    });

    expect(result).toEqual({ ok: true, restarted: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    const script = calls[0]?.[1].at(-1) ?? "";
    expect(script).toContain("OpenAI.Codex_*!App");
    expect(script).toContain("\\WindowsApps\\OpenAI.Codex_*\\app\\ChatGPT.exe");
    expect(script).toContain("Codex Desktop did not restart");
  });

  test("macOS waits until Codex reports running", async () => {
    const calls: Array<[string, string[]]> = [];
    const waits: number[] = [];
    let probes = 0;
    const result = await restartCodexApp({
      platform: "darwin",
      execFile: async (file, args) => {
        calls.push([file, args]);
        if (file === "/usr/bin/osascript" && args[1] === "application \"Codex\" is running") {
          probes += 1;
          return probes === 1 ? "false\n" : "true\n";
        }
        return "";
      },
      wait: async delayMs => { waits.push(delayMs); },
    });

    expect(result).toEqual({ ok: true, restarted: true });
    expect(calls).toContainEqual(["/usr/bin/open", ["-Ra", "Codex"]]);
    expect(calls).toContainEqual(["/usr/bin/open", ["-a", "Codex"]]);
    expect(waits).toEqual([700, 250]);
  });

  test("returns an error when the platform restart command fails", async () => {
    const result = await restartCodexApp({
      platform: "win32",
      execFile: async () => { throw new Error("permission denied"); },
    });
    expect(result).toEqual({ ok: false, error: "permission denied" });
  });

  test("management API waits for completion before returning success", async () => {
    let finish!: (result: RestartCodexAppResult) => void;
    const completed = new Promise<RestartCodexAppResult>(resolve => { finish = resolve; });
    const url = new URL("http://127.0.0.1:10100/api/codex/restart");
    let settled = false;
    const pending = handleManagementAPI(
      new Request(url, { method: "POST" }),
      url,
      { providers: [] } as never,
      { restartCodexApp: () => completed },
    ).then(response => { settled = true; return response; });

    await Promise.resolve();
    expect(settled).toBe(false);
    finish({ ok: true, restarted: true });
    expect((await pending)?.status).toBe(200);
  });

  test("management API returns a restart failure to the client", async () => {
    const url = new URL("http://127.0.0.1:10100/api/codex/restart");
    const response = await handleManagementAPI(
      new Request(url, { method: "POST" }),
      url,
      { providers: [] } as never,
      { restartCodexApp: async () => ({ ok: false, error: "launch failed" }) },
    );
    expect(response?.status).toBe(500);
    expect(await response?.json()).toEqual({ ok: false, error: "launch failed" });
  });
});
