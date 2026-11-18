import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { helperPath, repoPath } from "../helpers/repo-root";
import { claimOwnedServiceHome, withOwnedServiceHomePreload } from "../helpers/owned-service-home";
import { parseSyncFanoutFlags } from "../../src/cli/sync-flags";
import { runSyncCommand } from "../../src/cli/sync-command";
import type { CliDispatchDeps } from "../../src/cli/dispatch";
import * as codexSync from "../../src/codex/sync";
import * as statusApi from "../../src/cli/sync-link-status";
import * as processApi from "../../src/cli/sync-fanout-process";

const SSH_SENTINEL_PRELOAD = helperPath("ssh-spawn-sentinel-preload.ts");
// Below the 15 s case budget, so a stalled child is reported with its stderr instead of a bare timeout.
const CHILD_TIMEOUT_MS = 12_000;

/**
 * The environment a real CLI child gets on every platform: the inherited one (Windows needs
 * SystemRoot, PATHEXT and the rest), temp user and product homes, the owned-service-home fixture
 * that isolates the Codex write admission probe from the runner's own service manager, the ssh
 * sentinel marker, and `fixtureBin` ahead of PATH. Overrides replace inherited keys
 * case-insensitively, so Windows never sees both `Path` and `PATH`.
 */
function cliChildEnv(temp: string, opencodexHome: string, codexHome: string, fixtureBin: string): Record<string, string> {
  const userHome = join(temp, "home");
  mkdirSync(userHome, { recursive: true });
  mkdirSync(opencodexHome, { recursive: true });
  const owned = claimOwnedServiceHome(codexHome, opencodexHome, userHome);
  const overrides: Record<string, string> = {
    HOME: userHome, USERPROFILE: userHome, OPENCODEX_HOME: opencodexHome, CODEX_HOME: codexHome, ...owned.env,
    PATH: [fixtureBin, owned.env.PATH ?? process.env.PATH ?? ""].filter(Boolean).join(delimiter),
    OCX_TEST_SSH_SENTINEL: join(temp, "ssh-sentinel"),
  };
  const replaced = new Set(Object.keys(overrides).map(key => key.toLowerCase()));
  const inherited = Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && !replaced.has(entry[0].toLowerCase()));
  return { ...Object.fromEntries(inherited), ...overrides };
}

function cliChildArgv(args: readonly string[]): string[] {
  return [process.execPath, ...withOwnedServiceHomePreload(["run", "--preload", SSH_SENTINEL_PRELOAD, ...args])];
}

async function runCliChild(argv: string[], env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(argv, { env, stdout: "pipe", stderr: "pipe", timeout: CHILD_TIMEOUT_MS });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
}

function parseOneDocument(result: { code: number; stdout: string; stderr: string }): Record<string, unknown> {
  try { return JSON.parse(result.stdout) as Record<string, unknown>; }
  catch { throw new Error(`expected one JSON document on stdout; exit ${result.code}, stderr:\n${result.stderr}`); }
}

test.each(["--json", "--local-only"])("parser rejects repeated %s", flag => {
  expect(parseSyncFanoutFlags([flag, flag]).ok).toBe(false);
});

test.each(["--json", "--local-only"])("repeated %s is refused before preflight", flag => {
  const temp = mkdtempSync(join(tmpdir(), "ocx-sync-flags-"));
  try {
    const result = Bun.spawnSync(["bun", "run", repoPath("src/cli/index.ts"), "sync", flag, flag], {
      env: { ...process.env, OPENCODEX_HOME: join(temp, "ocx"), CODEX_HOME: join(temp, "codex") },
      stdout: "pipe", stderr: "pipe",
    });
    expect(result.exitCode).toBe(2);
    expect(result.stdout.toString()).toBe("");
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("pinned JSON mismatch is one document and does not invoke ssh", () => {
  const temp = mkdtempSync(join(tmpdir(), "ocx-sync-pinned-"));
  try {
    const result = Bun.spawnSync([process.execPath, "run", repoPath("src/cli/index.ts"), "sync", "--expect-link", "lnk_0123456789abcdef", "--json"], {
      env: { ...process.env, OPENCODEX_HOME: join(temp, "ocx"), CODEX_HOME: join(temp, "codex"), PATH: temp },
      stdout: "pipe", stderr: "pipe",
    });
    expect(result.exitCode).toBe(5);
    expect(JSON.parse(result.stdout.toString())).toEqual({ schema: "ocx.sync.fanout/1", home: { state: "failed", exit: 5 }, fanout: { state: "not-applicable", reason: null }, children: [] });
    expect(result.stderr.toString()).toContain('"phase":"child_link_mismatch"');
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("local-only JSON does not invoke ssh", async () => {
  const temp = mkdtempSync(join(tmpdir(), "ocx-sync-local-"));
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("not ocx", { status: 404 }) });
  try {
    const home = join(temp, "ocx"), linkDir = join(home, "link");
    mkdirSync(linkDir, { recursive: true });
    writeFileSync(join(home, "config.json"), JSON.stringify({ port: server.port, providers: {}, defaultProvider: "openai" }));
    writeFileSync(join(linkDir, "links.json"), JSON.stringify({ version: 1, listenerPort: 27000, links: [{ id: "lnk_0123456789abcdef", alias: "fake", direction: "hub-initiated", hostKeyFingerprint: "SHA256:AAAAAAAAAAAAAAAA", tunnelPort: 27001, apiKeyId: "test", createdAt: "2026-01-01T00:00:00Z" }] }));
    // A second, POSIX-only check: Windows cannot execute this script, which is why the preload sentinel exists.
    writeFileSync(join(temp, "ssh"), `#!/bin/sh\nprintf called > '${join(temp, "ssh-called")}'\nexit 1\n`, { mode: 0o755 });
    const env = cliChildEnv(temp, home, join(temp, "codex"), temp);
    const result = await runCliChild(cliChildArgv([repoPath("src/cli/index.ts"), "sync", "--local-only", "--json"]), env);
    const document = parseOneDocument(result) as { schema: unknown; home: { exit: unknown }; fanout: unknown; children: unknown };
    expect(document.schema).toBe("ocx.sync.fanout/1");
    expect(document.home.exit).toBe(result.code);
    // The Home step ran to the outcome this fixture is built for (Codex on, no Codex home yet), so
    // the document is not the residue of an earlier, unexpected failure.
    expect(document.home).toEqual({ state: "failed", exit: 1 });
    expect(result.stderr).toContain("does not exist yet, so there is no config.toml to route");
    expect(document.fanout).toEqual({ state: "disabled", reason: null });
    expect(document.children).toEqual([]);
    expect(existsSync(env.OCX_TEST_SSH_SENTINEL!)).toBe(false);
    expect(existsSync(join(temp, "ssh-called"))).toBe(false);
  } finally { server.stop(true); rmSync(temp, { recursive: true, force: true }); }
}, 15000);

test("the ssh sentinel stops both Bun spawn APIs and passes every other command through", async () => {
  const temp = mkdtempSync(join(tmpdir(), "ocx-sync-sentinel-"));
  try {
    const script = join(temp, "control.ts");
    writeFileSync(script, [
      'import { spawnSync } from "node:child_process";',
      'for (const start of [() => Bun.spawn(["ssh", "-V"]), () => Bun.spawnSync(["C:\\\\fixture\\\\SSH.EXE", "-V"])]) { try { start(); console.log("ssh-started"); } catch { /* the sentinel refused */ } }',
      'console.log(`passthrough ${Bun.spawnSync([process.execPath, "--version"]).exitCode}`);',
      'if (process.platform === "win32") console.log(`service ${spawnSync("schtasks.exe", ["/query", "/tn", "opencodex-proxy", "/xml"], { encoding: "buffer" }).stderr.toString()}`);',
    ].join("\n"));
    const env = cliChildEnv(temp, join(temp, "ocx"), join(temp, "codex"), temp);
    const result = await runCliChild(cliChildArgv([script]), env);
    expect(result.code).toBe(0);
    expect(readFileSync(env.OCX_TEST_SSH_SENTINEL!, "utf8")).toBe("Bun.spawn ssh\nBun.spawnSync ssh.exe\n");
    expect(result.stdout).not.toContain("ssh-started");
    expect(result.stdout).toContain("passthrough 0");
    // The Windows service fixture still answers beside the sentinel, so the CLI cases keep both.
    if (process.platform === "win32") expect(result.stdout).toContain("[OCX_TEST_SERVICE_HOME]");
  } finally { rmSync(temp, { recursive: true, force: true }); }
}, 15000);

test("human sync reports a damaged link store without exposing its path", async () => {
  const temp = mkdtempSync(join(tmpdir(), "ocx-sync-damaged-"));
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("not ocx", { status: 404 }) });
  try {
    const home = join(temp, "ocx"), linkDir = join(home, "link");
    mkdirSync(linkDir, { recursive: true });
    mkdirSync(join(temp, "codex"));
    writeFileSync(join(temp, "codex", "config.toml"), `model_catalog_json = ${JSON.stringify(join(temp, "missing-catalog.json"))}\n`);
    writeFileSync(join(home, "config.json"), JSON.stringify({ port: server.port, providers: {}, defaultProvider: "openai", clientIntegrations: { codex: false } }));
    writeFileSync(join(linkDir, "links.json"), "invalid");
    const { code, stdout, stderr } = await runCliChild(cliChildArgv([repoPath("src/cli/index.ts"), "sync"]), cliChildEnv(temp, home, join(temp, "codex"), temp));
    expect(code).toBe(6);
    expect(stderr).toContain("Children were not synced: the Remote Link store could not be read.");
    expect(stderr).not.toContain(join(linkDir, "links.json"));
    expect(stdout).not.toContain("link-store-unreadable");
  } finally { server.stop(true); rmSync(temp, { recursive: true, force: true }); }
}, 15000);

test("committed Home catalog fans out after the Home step; refused refresh does not", async () => {
  const temp = mkdtempSync(join(tmpdir(), "ocx-sync-gate-"));
  const previousHome = process.env.OPENCODEX_HOME, previousExit = process.exitCode;
  process.env.OPENCODEX_HOME = temp; process.exitCode = 0;
  const linkDir = join(temp, "link"); mkdirSync(linkDir, { recursive: true });
  const link = { id: "lnk_0123456789abcdef", alias: "fake", direction: "hub-initiated" as const, hostKeyFingerprint: "SHA256:AAAAAAAAAAAAAAAA", tunnelPort: 27001, apiKeyId: "test", createdAt: "2026-01-01T00:00:00Z", remotePlatform: "posix" as const };
  writeFileSync(join(temp, "config.json"), JSON.stringify({ providers: {}, defaultProvider: "openai" }));
  writeFileSync(join(linkDir, "links.json"), JSON.stringify({ version: 1, listenerPort: 27000, links: [link] }));
  const base = { status: "catalog-only" as const, ok: true, added: 0, catalogPath: "fixture", catalogExists: true, catalogWritten: false, cacheSynced: false, message: "done" };
  const events: string[] = [], output: string[] = [], errors: string[] = [];
  const sync = spyOn(codexSync, "syncModelsToCodex").mockImplementation(async () => { events.push("home"); return { ...base, refreshOutcome: "committed" }; });
  const status = spyOn(statusApi, "readHomeLinkStatus").mockImplementation(async () => { events.push("status"); return { role: "home", listener: { state: "listening", port: 27000 }, child: null, links: [{ ...link, state: "connected", since: link.createdAt, reason: null, lastApplyAt: null, runtimeStartedAt: null, appliedCodexSettingsDigest: null }] }; });
  const child = spyOn(processApi, "runFanoutProcess").mockImplementation(async argv => { events.push("child"); expect(argv.join(" ")).not.toContain("--restart-codex"); return { code: 0, stdout: "ocx-fanout:stdout-begin\nRemote Link Home catalog synchronized.", stderr: "ocx-fanout:selected:2.93.0+build.5\n" }; });
  const log = spyOn(console, "log").mockImplementation((...parts) => { output.push(parts.map(String).join(" ")); });
  const error = spyOn(console, "error").mockImplementation((...parts) => { errors.push(parts.map(String).join(" ")); });
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const deps = { args: ["sync", "--json"], findLiveProxy: async () => null } as unknown as CliDispatchDeps;
    expect(await runSyncCommand(deps)).toBe(0);
    expect(events).toEqual(["home", "status", "child"]);
    expect(JSON.parse(output.at(-1)!).children[0]).toMatchObject({ state: "synced", reason: null });
    events.length = 0; output.length = 0;
    child.mockResolvedValue({ code: 121, stdout: "", stderr: "ocx-fanout:child-ocx-lacks-expect-link\n" });
    expect(await runSyncCommand(deps)).toBe(6);
    expect(JSON.parse(output.at(-1)!).children[0]).toMatchObject({ alias: "fake", state: "skipped", reason: "child-ocx-lacks-expect-link", hint: expect.stringContaining("2.93.0") });
    output.length = 0;
    expect(await runSyncCommand({ ...deps, args: ["sync"] })).toBe(6);
    expect(output.some(line => line.includes("fake") && line.includes("Check for Updates"))).toBe(true);
    events.length = 0; output.length = 0;
    sync.mockImplementation(async () => { events.push("home"); return { ...base, refreshOutcome: "refused" }; });
    expect(await runSyncCommand(deps)).toBe(0);
    expect(events).toEqual(["home"]);
    expect(JSON.parse(output.at(-1)!).children[0]).toMatchObject({ state: "skipped", reason: "home-catalog-not-current" });
    const original = new Error("fixture Home failure\n\u001b[31m");
    sync.mockImplementation(async () => { throw original; });
    output.length = 0; errors.length = 0;
    expect(await runSyncCommand(deps)).toBe(1);
    expect(output).toHaveLength(1);
    expect(JSON.parse(output.at(-1)!)).toMatchObject({ home: { state: "failed", exit: 1 }, children: [{ state: "skipped", reason: "home-sync-failed" }] });
    expect(errors).toEqual(["Sync failed: fixture Home failure\\x0a\\x1b[31m"]);
    errors.length = 0;
    await expect(runSyncCommand({ ...deps, args: ["sync"] })).rejects.toBe(original);
    expect(errors).toEqual(["Children were not synced because the Home sync failed."]);
    writeFileSync(join(linkDir, "links.json"), "invalid"); errors.length = 0;
    await expect(runSyncCommand({ ...deps, args: ["sync"] })).rejects.toBe(original);
    expect(errors).toEqual([]);
  } finally {
    sync.mockRestore(); status.mockRestore(); child.mockRestore(); log.mockRestore(); error.mockRestore(); warn.mockRestore();
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previousHome;
    process.exitCode = previousExit ?? 0; rmSync(temp, { recursive: true, force: true });
  }
});

test("fan-out discovers unstored platforms despite shell startup output", async () => {
  const temp = mkdtempSync(join(tmpdir(), "ocx-sync-platform-"));
  const previousHome = process.env.OPENCODEX_HOME, previousExit = process.exitCode;
  process.env.OPENCODEX_HOME = temp; process.exitCode = 0;
  const linkDir = join(temp, "link"); mkdirSync(linkDir, { recursive: true });
  const link = { id: "lnk_0123456789abcdef", alias: "fake", direction: "hub-initiated" as const, hostKeyFingerprint: "SHA256:AAAAAAAAAAAAAAAA", tunnelPort: 27001, apiKeyId: "test", createdAt: "2026-01-01T00:00:00Z" };
  writeFileSync(join(temp, "config.json"), JSON.stringify({ providers: {}, defaultProvider: "openai" }));
  writeFileSync(join(linkDir, "links.json"), JSON.stringify({ version: 1, listenerPort: 27000, links: [link] }));
  const base = { status: "catalog-only" as const, ok: true, added: 0, catalogPath: "fixture", catalogExists: true, catalogWritten: false, cacheSynced: false, message: "done", refreshOutcome: "committed" as const };
  const sync = spyOn(codexSync, "syncModelsToCodex").mockResolvedValue(base);
  const status = spyOn(statusApi, "readHomeLinkStatus").mockResolvedValue({ role: "home", listener: { state: "listening", port: 27000 }, child: null, links: [{ ...link, state: "connected", since: link.createdAt, reason: null, lastApplyAt: null, runtimeStartedAt: null, appliedCodexSettingsDigest: null }] });
  const output: string[] = [], commands: string[] = [], probes: string[][] = [];
  const log = spyOn(console, "log").mockImplementation((...parts) => { output.push(parts.map(String).join(" ")); });
  const error = spyOn(console, "error").mockImplementation(() => {});
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  let responses: Array<{ code: number; stdout: string; stderr: string }> = [];
  const runner = spyOn(processApi, "fanoutSshRunner").mockImplementation(() => ({ run: async (argv, options) => { probes.push([...argv]); expect(options?.timeoutMs).toBe(10_000); return responses.shift()!; } }));
  const child = spyOn(processApi, "runFanoutProcess").mockImplementation(async argv => { commands.push(argv.at(-1)!); return { code: 0, stdout: "ocx-fanout:stdout-begin\nRemote Link Home catalog synchronized.", stderr: "ocx-fanout:selected:2.93.0\n" }; });
  try {
    const deps = { args: ["sync", "--json"], findLiveProxy: async () => null } as unknown as CliDispatchDeps;
    const startup = "shell startup warning\n";
    responses = [{ code: 127, stdout: startup, stderr: startup }, { code: 0, stdout: `${startup}ocx-platform:Linux\n`, stderr: startup }];
    expect(await runSyncCommand(deps)).toBe(0);
    expect(JSON.parse(output.at(-1)!).children[0]).toMatchObject({ state: "synced", reason: null });
    expect(commands.at(-1)).toContain("sh ");
    expect(probes[0]!.at(-1)).toBe("cmd /c echo %OS%");
    expect(probes[1]!.at(-1)).toContain("ocx-platform:%s");
    expect(probes[1]).toContain("StrictHostKeyChecking=yes");
    responses = [{ code: 0, stdout: `${startup} Windows_NT \n`, stderr: startup }]; output.length = 0; commands.length = 0; probes.length = 0;
    expect(await runSyncCommand(deps)).toBe(0);
    expect(JSON.parse(output.at(-1)!).children[0]).toMatchObject({ state: "synced", reason: null });
    expect(commands.at(-1)).toContain("powershell.exe");
    expect(probes).toHaveLength(1);
    responses = [{ code: 127, stdout: startup, stderr: startup }, { code: 0, stdout: `${startup}ocx-platform:Linux\nocx-platform:Linux\n`, stderr: startup }]; output.length = 0; commands.length = 0; probes.length = 0;
    expect(await runSyncCommand(deps)).toBe(6);
    expect(JSON.parse(output.at(-1)!).children[0]).toMatchObject({ state: "failed", reason: "platform-probe-failed" });
    expect(commands).toEqual([]);
    responses = [{ code: 127, stdout: startup, stderr: startup }, { code: 0, stdout: startup, stderr: startup }]; output.length = 0; commands.length = 0; probes.length = 0;
    expect(await runSyncCommand(deps)).toBe(6);
    expect(JSON.parse(output.at(-1)!).children[0]).toMatchObject({ state: "failed", reason: "platform-probe-failed" });
    expect(commands).toEqual([]);
    responses = [{ code: 127, stdout: startup, stderr: startup }, { code: 0, stdout: `${startup}ocx-platform:MINGW64_NT-10.0\n`, stderr: startup }]; output.length = 0; commands.length = 0; probes.length = 0;
    expect(await runSyncCommand(deps)).toBe(0);
    expect(commands.at(-1)).toContain("powershell.exe");
    responses = [{ code: 255, stdout: `${startup}Windows_NT\n`, stderr: startup }]; output.length = 0; commands.length = 0; probes.length = 0;
    expect(await runSyncCommand(deps)).toBe(6);
    expect(JSON.parse(output.at(-1)!).children[0]).toMatchObject({ state: "failed", reason: "platform-probe-failed" });
    expect(probes).toHaveLength(1);
    expect(commands).toEqual([]);
    responses = [{ code: 127, stdout: startup, stderr: startup }, { code: 255, stdout: "ocx-platform:Linux\n", stderr: startup }]; output.length = 0; commands.length = 0; probes.length = 0;
    expect(await runSyncCommand(deps)).toBe(6);
    expect(JSON.parse(output.at(-1)!).children[0]).toMatchObject({ state: "failed", reason: "platform-probe-failed" });
    expect(probes).toHaveLength(2);
    expect(commands).toEqual([]);
  } finally {
    sync.mockRestore(); status.mockRestore(); runner.mockRestore(); child.mockRestore(); log.mockRestore(); error.mockRestore(); warn.mockRestore();
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previousHome;
    process.exitCode = previousExit ?? 0; rmSync(temp, { recursive: true, force: true });
  }
});

test("local-only never reads link status or starts a Child process, even when fan-out would run", async () => {
  const temp = mkdtempSync(join(tmpdir(), "ocx-sync-local-inprocess-"));
  const previousHome = process.env.OPENCODEX_HOME, previousExit = process.exitCode;
  process.env.OPENCODEX_HOME = temp; process.exitCode = 0;
  const linkDir = join(temp, "link"); mkdirSync(linkDir, { recursive: true });
  const link = { id: "lnk_0123456789abcdef", alias: "fake", direction: "hub-initiated" as const, hostKeyFingerprint: "SHA256:AAAAAAAAAAAAAAAA", tunnelPort: 27001, apiKeyId: "test", createdAt: "2026-01-01T00:00:00Z", remotePlatform: "windows" as const };
  writeFileSync(join(temp, "config.json"), JSON.stringify({ providers: {}, defaultProvider: "openai" }));
  writeFileSync(join(linkDir, "links.json"), JSON.stringify({ version: 1, listenerPort: 27000, links: [link] }));
  const base = { status: "catalog-only" as const, ok: true, added: 0, catalogPath: "fixture", catalogExists: true, catalogWritten: false, cacheSynced: false, message: "done", refreshOutcome: "committed" as const };
  const calls: string[] = [], output: string[] = [];
  const sync = spyOn(codexSync, "syncModelsToCodex").mockImplementation(async () => { calls.push("home"); return base; });
  const status = spyOn(statusApi, "readHomeLinkStatus").mockImplementation(async () => { calls.push("status"); return { role: "home", listener: { state: "listening", port: 27000 }, child: null, links: [{ ...link, state: "connected", since: link.createdAt, reason: null, lastApplyAt: null, runtimeStartedAt: null, appliedCodexSettingsDigest: null }] }; });
  const runner = spyOn(processApi, "fanoutSshRunner").mockImplementation(() => { calls.push("ssh-runner"); return { run: async () => ({ code: 255, stdout: "", stderr: "" }) }; });
  const child = spyOn(processApi, "runFanoutProcess").mockImplementation(async () => { calls.push("child"); return { code: 255, stdout: "", stderr: "" }; });
  const log = spyOn(console, "log").mockImplementation((...parts) => { output.push(parts.map(String).join(" ")); });
  const error = spyOn(console, "error").mockImplementation(() => {});
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const deps = { findLiveProxy: async () => null } as unknown as CliDispatchDeps;
    // The same Home result and store fan out without --local-only, so the spies can be reached.
    expect(await runSyncCommand({ ...deps, args: ["sync", "--json"] })).toBe(6);
    expect(calls).toEqual(["home", "status", "ssh-runner", "child"]);
    calls.length = 0; output.length = 0;
    expect(await runSyncCommand({ ...deps, args: ["sync", "--local-only", "--json"] })).toBe(0);
    expect(calls).toEqual(["home"]);
    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0]!)).toEqual({ schema: "ocx.sync.fanout/1", home: { state: "synced", exit: 0 }, fanout: { state: "disabled", reason: null }, children: [] });
  } finally {
    sync.mockRestore(); status.mockRestore(); runner.mockRestore(); child.mockRestore(); log.mockRestore(); error.mockRestore(); warn.mockRestore();
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previousHome;
    process.exitCode = previousExit ?? 0; rmSync(temp, { recursive: true, force: true });
  }
});
