import { expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { armClaudeCodeBaseline, loadConfig, mutatePersistedConfig, saveConfig, saveConfigPreservingClaudeCode } from "../../src/config";
import { readConfigFileSnapshot } from "../../src/config/diagnostics";
import { runClaudeAuthModeMigration } from "../../src/claude/auth-mode-migration";
import { syncClaudeAgentDefsAtProxyStartup } from "../../src/cli/claude-agent-startup-sync";
import { claudeKeychain } from "../../src/lib/claude-keychain";
import * as contextWindows from "../../src/claude/context-windows";
import { applySystemEnvToggle, captureSystemEnvFollowup, injectSystemEnv } from "../../src/server/system-env";
import type { OcxConfig } from "../../src/types";

test("loaded configuration matches the valid diagnostics snapshot", () => {
  mkdirSync(process.env.OPENCODEX_HOME!, { recursive: true });
  writeFileSync(join(process.env.OPENCODEX_HOME!, "config.json"), JSON.stringify({
    port: 0, hostname: "127.0.0.1", codexAutoStart: true, syncResumeHistory: false,
    checkForUpdates: false, clientIntegrations: { codex: false, grok: true, "claude-desktop": false },
    claudeCode: { injectAgents: false, systemEnv: false }, providers: {}, defaultProvider: "openai",
  }));
  const loaded = loadConfig();
  const snapshot = readConfigFileSnapshot().diagnostics;
  expect(snapshot.source).toBe("file");
  expect(snapshot.error).toBeNull();
  expect(JSON.stringify(loaded)).toBe(JSON.stringify(snapshot.config));
});

test.each(["linux", "darwin"] as const)("%s startup prunes with the migrated owner and rejects stale or foreign state", async platform => {
  const root = mkdtempSync(join(tmpdir(), "ocx-startup-owner-"));
  const previousOcx = process.env.OPENCODEX_HOME, previousClaude = process.env.CLAUDE_CONFIG_DIR;
  process.env.OPENCODEX_HOME = join(root, "ocx");
  process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
  mkdirSync(process.env.OPENCODEX_HOME, { recursive: true });
  const agents = join(process.env.CLAUDE_CONFIG_DIR, "agents");
  mkdirSync(agents, { recursive: true });
  const roster = join(agents, "ocx-existing.md");
  writeFileSync(join(process.env.OPENCODEX_HOME, "config.json"), JSON.stringify({
    port: 4567, hostname: "127.0.0.1", providers: {}, defaultProvider: "openai",
    claudeCode: { injectAgents: false, systemEnv: false },
  }));
  const stale = loadConfig();
  const active = loadConfig();
  expect(runClaudeAuthModeMigration(active, new Date("2026-01-01T00:00:00Z"))).toBe(true);
  saveConfig(active);
  armClaudeCodeBaseline(active);
  const nativePlatform = process.platform;
  const exec = spyOn(childProcess, "execFileSync").mockImplementation(((file: string) => {
    if (file !== "/bin/launchctl") throw new Error("unexpected synthetic child");
    return "";
  }) as never);
  try {
    Object.defineProperty(process, "platform", { configurable: true, value: platform });
    const staleResult = await injectSystemEnv(active.port, stale);
    expect(captureSystemEnvFollowup(stale, staleResult)).toBeUndefined();
    const result = await injectSystemEnv(active.port, active);
    const followup = captureSystemEnvFollowup(active, result);
    expect(followup).toBeDefined();
    writeFileSync(roster, "---\ngenerated-by: opencodex\n---\nstale roster\n");
    await syncClaudeAgentDefsAtProxyStartup(active, active.port, { runIfCurrent: followup });
    expect(existsSync(roster)).toBe(false);

    Object.defineProperty(process, "platform", { configurable: true, value: nativePlatform });
    const newer = structuredClone(active);
    newer.claudeCode!.injectAgents = true;
    saveConfig(newer);
    Object.defineProperty(process, "platform", { configurable: true, value: platform });
    writeFileSync(roster, "---\ngenerated-by: opencodex\n---\nstale roster\n");
    await syncClaudeAgentDefsAtProxyStartup(active, active.port, { runIfCurrent: followup });
    expect(existsSync(roster)).toBe(true);
    expect(captureSystemEnvFollowup(active, result)).toBeUndefined();

    Object.defineProperty(process, "platform", { configurable: true, value: nativePlatform });
    saveConfig(active);
    writeFileSync(join(process.env.OPENCODEX_HOME, "system-env-port"), JSON.stringify({
      pid: process.pid + 1, port: 4568, injectedAt: "synthetic-foreign",
    }));
    Object.defineProperty(process, "platform", { configurable: true, value: platform });
    expect(captureSystemEnvFollowup(active, result)).toBeUndefined();
    expect(existsSync(roster)).toBe(true);
  } finally {
    Object.defineProperty(process, "platform", { configurable: true, value: nativePlatform });
    exec.mockRestore();
    if (previousOcx === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previousOcx;
    if (previousClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previousClaude;
  }
});

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
