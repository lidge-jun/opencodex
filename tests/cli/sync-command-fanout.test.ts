import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { repoPath } from "../helpers/repo-root";
import { parseSyncFanoutFlags } from "../../src/cli/sync-flags";
import { runSyncCommand } from "../../src/cli/sync-command";
import type { CliDispatchDeps } from "../../src/cli/dispatch";
import * as codexSync from "../../src/codex/sync";
import * as statusApi from "../../src/cli/sync-link-status";
import * as processApi from "../../src/cli/sync-fanout-process";

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
    writeFileSync(join(temp, "ssh"), `#!/bin/sh\nprintf called > '${join(temp, "ssh-called")}'\nexit 1\n`, { mode: 0o755 });
    const child = Bun.spawn([process.execPath, "run", repoPath("src/cli/index.ts"), "sync", "--local-only", "--json"], {
      env: { HOME: temp, OPENCODEX_HOME: home, CODEX_HOME: join(temp, "codex"), PATH: `${temp}:/usr/bin:/bin` },
      stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    const document = JSON.parse(stdout);
    expect(document.schema).toBe("ocx.sync.fanout/1");
    expect(document.home.exit).toBe(code);
    expect(document.fanout).toEqual({ state: "disabled", reason: null });
    expect(document.children).toEqual([]);
    expect(existsSync(join(temp, "ssh-called"))).toBe(false);
  } finally { server.stop(true); rmSync(temp, { recursive: true, force: true }); }
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
    const child = Bun.spawn([process.execPath, "run", repoPath("src/cli/index.ts"), "sync"], {
      env: { HOME: temp, OPENCODEX_HOME: home, CODEX_HOME: join(temp, "codex"), PATH: `${temp}:/usr/bin:/bin` },
      stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
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
