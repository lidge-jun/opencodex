import { expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { armClaudeCodeBaseline, loadConfig, mutatePersistedConfig, saveConfig, saveConfigPreservingClaudeCode } from "../../src/config";
import { claudeKeychain } from "../../src/lib/claude-keychain";
import * as contextWindows from "../../src/claude/context-windows";
import { applySystemEnvToggle, captureSystemEnvFollowup, injectSystemEnv } from "../../src/server/system-env";
import type { OcxConfig } from "../../src/types";

test("live reconciliation permits both toggles while fencing stale snapshots and followups", async () => {
  const config = {
    port: 4567, hostname: "127.0.0.1",
    providers: { fixture: { adapter: "openai-chat", baseUrl: "https://fixture.example.test" } }, defaultProvider: "fixture",
    claudeCode: { systemEnv: false, authMode: "auto" },
  } as OcxConfig;
  saveConfig(config);
  const live = loadConfig();
  armClaudeCodeBaseline(live);
  expect(mutatePersistedConfig(disk => {
    disk.unauthenticatedLoopbackListener = { enabled: true, port: 4568 };
    return { changed: true, value: null };
  }).status).toBe("committed");
  live.claudeCode!.systemEnv = true;
  saveConfigPreservingClaudeCode(live);
  expect(live.unauthenticatedLoopbackListener).toBeUndefined();
  expect(loadConfig().unauthenticatedLoopbackListener).toEqual({ enabled: true, port: 4568 });

  const launchd = new Map<string, string>();
  const exec = spyOn(childProcess, "execFileSync").mockImplementation(((file: string, args?: string[]) => {
    if (file !== "/bin/launchctl") throw new Error("unexpected synthetic child");
    if (args?.[0] === "getenv") return launchd.get(args[1]!) ?? "";
    if (args?.[0] === "setenv") launchd.set(args[1]!, args[2]!);
    if (args?.[0] === "unsetenv") launchd.delete(args[1]!);
    return "";
  }) as never);
  const keychain = spyOn(claudeKeychain, "probe").mockResolvedValue({ status: "absent" });
  const windows = spyOn(contextWindows, "boundedContextWindows").mockResolvedValue({});
  const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ data: [] }));
  const platform = process.platform;
  Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
  try {
    const untrusted = structuredClone(live);
    expect(await injectSystemEnv(live.port, untrusted)).toMatchObject({ injected: false, reason: "superseded" });
    const result = await applySystemEnvToggle(live, live.port);
    expect(result).toEqual({ injected: true });
    expect(launchd.get("ANTHROPIC_BASE_URL")).toBe("http://127.0.0.1:4567");
    const followup = captureSystemEnvFollowup(live, result as { injected: boolean });
    let writes = 0;
    expect(followup?.(() => { writes++; })).toBe(true);
    Object.defineProperty(process, "platform", { configurable: true, value: platform });
    expect(mutatePersistedConfig(disk => {
      disk.claudeCode!.authMode = "subscription";
      return { changed: true, value: null };
    }).status).toBe("committed");
    Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
    expect(followup?.(() => { writes++; })).toBe(false);
    expect(writes).toBe(1);
    expect(await applySystemEnvToggle(live, live.port)).toMatchObject({ injected: false, reason: "superseded" });
    live.claudeCode!.systemEnv = false;
    Object.defineProperty(process, "platform", { configurable: true, value: platform });
    saveConfigPreservingClaudeCode(live);
    Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
    expect(await applySystemEnvToggle(structuredClone(live), live.port)).toEqual({ reverted: false, reason: "superseded" });
    expect(launchd.has("ANTHROPIC_BASE_URL")).toBe(true);
    expect(await applySystemEnvToggle(live, live.port)).toEqual({ reverted: true });
    expect(launchd.has("ANTHROPIC_BASE_URL")).toBe(false);
    const disabledFollowup = captureSystemEnvFollowup(live, await injectSystemEnv(live.port, live));
    expect(disabledFollowup?.(() => { writes++; })).toBe(true);
  } finally {
    Object.defineProperty(process, "platform", { configurable: true, value: platform });
    fetchSpy.mockRestore(); windows.mockRestore(); keychain.mockRestore(); exec.mockRestore();
  }
});
