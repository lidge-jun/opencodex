import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseSyncFanoutFlags } from "../../src/cli/sync-flags";
import { readRestartScope } from "../../src/cli/restart-scope";
import { runSyncCommand } from "../../src/cli/sync-command";
import type { CliDispatchDeps } from "../../src/cli/dispatch";
import * as codexSync from "../../src/codex/sync";
import * as shim from "../../src/cli/codex-shim-autorestore";
import * as statusApi from "../../src/cli/sync-link-status";
import * as processApi from "../../src/cli/sync-fanout-process";

const A = "lnk_0123456789abcdef";
const OK = { code: 0, stdout: "ocx-fanout:stdout-begin\nRemote Link Home catalog synchronized.", stderr: "ocx-fanout:selected:2.93.0\n" };

describe("parseSyncFanoutFlags", () => {
  test("--child and --restart-children", () => {
    expect(parseSyncFanoutFlags(["--child", A])).toEqual({ ok: true, localOnly: false, json: false, children: [A], restartChildren: null });
    expect(parseSyncFanoutFlags(["--child=" + A, "--child", A])).toMatchObject({ ok: true, children: [A] });
    expect(parseSyncFanoutFlags([])).toMatchObject({ ok: true, children: null, restartChildren: null });
    expect(parseSyncFanoutFlags(["--restart-children"])).toMatchObject({ ok: true, restartChildren: "app-server" });
    expect(parseSyncFanoutFlags(["--restart-children=app-server"])).toMatchObject({ ok: true, restartChildren: "app-server" });
    expect(parseSyncFanoutFlags(["--restart-children=codex", "--yes"])).toMatchObject({ ok: true, restartChildren: "codex" });
    for (const bad of [["--child", "lnk_123"], ["--child"], ["--child="], ["--restart-children=desktop"],
      ["--restart-children", "--restart-children"], ["--local-only", "--child", A], ["--local-only", "--restart-children"]]) {
      expect(parseSyncFanoutFlags(bad).ok).toBe(false);
    }
    const codex = parseSyncFanoutFlags(["--restart-children=codex"]);
    expect(codex.ok).toBe(false);
    if (!codex.ok) expect(codex.message).toContain("--yes");
  });

  test("the Home's own restart scope ignores --restart-children", () => {
    const log = { error: () => {} };
    expect(readRestartScope(["--restart-children=codex", "--yes"], log)).toEqual({ appServers: false, desktopApp: false });
    expect(readRestartScope(["--restart-children"], log)).toEqual({ appServers: false, desktopApp: false });
  });
});

const temps: string[] = [];
const restores: Array<() => void> = [];
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function home(links: Array<Record<string, unknown>>) {
  const temp = mkdtempSync(join(tmpdir(), "ocx-sync-child-flags-")); temps.push(temp);
  const previous = { home: process.env.OPENCODEX_HOME, codex: process.env.CODEX_HOME, exit: process.exitCode };
  process.env.OPENCODEX_HOME = join(temp, "ocx"); process.env.CODEX_HOME = join(temp, "codex"); process.exitCode = 0;
  restores.push(() => {
    if (previous.home === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previous.home;
    if (previous.codex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous.codex;
    process.exitCode = previous.exit ?? 0;
  });
  mkdirSync(join(temp, "ocx", "link"), { recursive: true });
  writeFileSync(join(temp, "ocx", "config.json"), JSON.stringify({ providers: {}, defaultProvider: "openai" }));
  const records = links.map(extra => ({ id: A, alias: "fake", direction: "hub-initiated", hostKeyFingerprint: "SHA256:AAAAAAAAAAAAAAAA", tunnelPort: 27001, apiKeyId: "test", createdAt: "2026-01-01T00:00:00Z", ...extra }));
  writeFileSync(join(temp, "ocx", "link", "links.json"), JSON.stringify({ version: 1, listenerPort: 27000, links: records }));
  const base = { status: "catalog-only" as const, ok: true, added: 0, catalogPath: "fixture", catalogExists: true, catalogWritten: false, cacheSynced: false, message: "done", refreshOutcome: "committed" as const };
  const sync = spyOn(codexSync, "syncModelsToCodex").mockResolvedValue(base);
  const restore = spyOn(shim, "runCodexShimAutoRestoreAsync").mockResolvedValue(undefined as never);
  const output: string[] = [], errors: string[] = [];
  const log = spyOn(console, "log").mockImplementation((...parts) => { output.push(parts.map(String).join(" ")); });
  const error = spyOn(console, "error").mockImplementation((...parts) => { errors.push(parts.map(String).join(" ")); });
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  restores.push(() => { sync.mockRestore(); restore.mockRestore(); log.mockRestore(); error.mockRestore(); warn.mockRestore(); });
  return { sync, output, errors, records };
}

const activity = (inFlight: number, activeJob: unknown = null) => ({
  homeVersion: "2.99.0", runningVersion: null, installedVersion: null, installKind: null, versionSkew: "unknown",
  update: { route: null, reason: null, observedAt: null }, catalog: { state: "unknown", pulledAt: null, homeChangedAt: null },
  codex: null, activity: { idle: inFlight === 0, inFlight, lastDataEndAt: null }, activeJob, lastOperation: null,
});

async function fanout(args: string[], opts: { link?: Record<string, unknown>; reads: Array<unknown>; runs: Array<typeof OK>; afterFirstRun?: () => void }) {
  const h = home([{ remotePlatform: "posix", ...opts.link }]);
  let reads = 0;
  const statusSpy = spyOn(statusApi, "readHomeLinkStatus").mockImplementation(async () => {
    const child = opts.reads[Math.min(reads++, opts.reads.length - 1)];
    if (child instanceof Error) throw child;
    const record = h.records[0]!;
    return { role: "home", listener: { state: "listening", port: 27000 }, child: null,
      links: [{ ...record, state: "connected", since: record.createdAt, reason: null, lastApplyAt: null, runtimeStartedAt: null, appliedCodexSettingsDigest: null, ...(child ? { child } : {}) }] } as never;
  });
  const commands: string[] = [];
  const processSpy = spyOn(processApi, "runFanoutProcess").mockImplementation(async argv => {
    commands.push(argv.at(-1)!);
    const next = opts.runs.shift();
    if (!next) throw new Error("unexpected Child process");
    if (commands.length === 1) opts.afterFirstRun?.();
    return next;
  });
  restores.push(() => { statusSpy.mockRestore(); processSpy.mockRestore(); });
  const code = await runSyncCommand({ args: ["sync", "--json", ...args], findLiveProxy: async () => null } as unknown as CliDispatchDeps);
  const document = JSON.parse(h.output.at(-1)!) as { children: Array<Record<string, unknown>> };
  return { code, row: document.children[0]!, commands, reads, sync: h.sync };
}

describe("ocx sync runChild with --child and --restart-children", () => {
  test("an unknown --child exits 2 before the Home sync", async () => {
    const h = home([{}]);
    const code = await runSyncCommand({ args: ["sync", "--child", "lnk_ffffffffffffffff"], findLiveProxy: async () => null } as unknown as CliDispatchDeps);
    expect(code).toBe(2);
    expect(h.sync).not.toHaveBeenCalled();
    expect(h.errors.join("\n")).toContain("lnk_ffffffffffffffff");
  });

  test("--restart-children=codex without --yes exits 2 before the Home sync", async () => {
    const h = home([{}]);
    const code = await runSyncCommand({ args: ["sync", "--restart-children=codex"], findLiveProxy: async () => null } as unknown as CliDispatchDeps);
    expect(code).toBe(2);
    expect(h.sync).not.toHaveBeenCalled();
    expect(h.errors.join("\n")).toContain("--yes");
  });

  test("without the new flags: one plain pinned sync and one status read", async () => {
    const run = await fanout([], { reads: [activity(0)], runs: [OK] });
    expect(run).toMatchObject({ code: 0, row: { state: "synced", reason: null, exit: 0 }, reads: 1 });
    expect(run.commands).toHaveLength(1);
    expect(run.commands[0]).not.toContain("--restart-");
  });

  test("a busy Child is skipped without SSH even without flags", async () => {
    const run = await fanout([], { reads: [activity(0, { jobId: "job_1", op: "update", state: "running" })], runs: [] });
    expect(run).toMatchObject({ code: 0, row: { state: "skipped", reason: "child-busy", exit: null } });
    expect(run.commands).toEqual([]);
  });

  test("idle POSIX Child: plain sync, then a restarting sync", async () => {
    const appServer = await fanout(["--child", A, "--restart-children"], { reads: [activity(0)], runs: [OK, OK] });
    expect(appServer).toMatchObject({ code: 0, row: { state: "synced", reason: null, exit: 0 }, reads: 2 });
    expect(appServer.commands[0]).not.toContain("--restart-");
    expect(appServer.commands[1]).toContain("--restart-app-server-only");
    expect(appServer.commands[1]).not.toContain("--restart-codex");
    const codex = await fanout(["--restart-children=codex", "--yes"], { reads: [activity(0)], runs: [OK, OK] });
    expect(codex.code).toBe(0);
    expect(codex.commands[1]).toContain("--restart-codex");
    expect(codex.commands[1]).not.toContain("--restart-app-server-only");
  });

  test("a relayed request in flight withholds the restart, never the sync", async () => {
    const run = await fanout(["--restart-children"], { reads: [activity(0), activity(1)], runs: [OK] });
    expect(run).toMatchObject({ code: 6, row: { state: "synced", reason: "restart-skipped:link-active", exit: 0 } });
    expect(run.commands).toHaveLength(1);
  });

  test("a failed activity re-read withholds the restart", async () => {
    const run = await fanout(["--restart-children"], { reads: [activity(0), new statusApi.LinkStatusError("home-link-status-timeout")], runs: [OK] });
    expect(run).toMatchObject({ code: 6, row: { state: "synced", reason: "restart-skipped:activity-unknown" } });
    expect(run.commands).toHaveLength(1);
  });

  test("a Windows Child gets the plain sync only", async () => {
    const run = await fanout(["--restart-children"], { link: { remotePlatform: "windows" }, reads: [activity(0)], runs: [OK] });
    expect(run).toMatchObject({ code: 6, row: { state: "synced", reason: "restart-skipped:windows" } });
    expect(run.commands).toHaveLength(1);
    expect(run.commands[0]).not.toContain("--restart-");
  });

  test("ocx-child selected by the restarting sync is unsupported", async () => {
    const run = await fanout(["--restart-children"], { reads: [activity(0)], runs: [OK, { ...OK, stderr: "ocx-fanout:selected:2.93.0\nocx-fanout:selected-kind:ocx-child\n" }] });
    expect(run).toMatchObject({ code: 6, row: { state: "synced", reason: "restart-unsupported:ocx-child", exit: 0 } });
    expect(run.row).not.toHaveProperty("executable");
  });

  test("a restarting sync that certainly ran nothing reports restart-not-run", async () => {
    const run = await fanout(["--restart-children"], { reads: [activity(0)], runs: [OK, { code: 121, stdout: "", stderr: "warning\n" }] });
    expect(run).toMatchObject({ code: 6, row: { state: "synced", reason: "restart-not-run", exit: 0 } });
  });

  test("a restarting sync with an unknown result reports restart-result-unknown with its exit", async () => {
    const run = await fanout(["--restart-children"], { reads: [activity(0)], runs: [OK, { code: 255, stdout: "", stderr: "" }] });
    expect(run).toMatchObject({ code: 6, row: { state: "synced", reason: "restart-result-unknown", exit: 255 } });
    expect(run.row).not.toHaveProperty("executable");
  });

  test("a spent deadline before the restarting sync sends nothing and reports restart-not-run", async () => {
    let now: ReturnType<typeof spyOn> | undefined;
    const real = Date.now;
    const run = await fanout(["--restart-children"], { reads: [activity(0)], runs: [OK, OK], afterFirstRun: () => {
      const later = real() + 3_600_000;
      now = spyOn(Date, "now").mockImplementation(() => later);
    } }).finally(() => now?.mockRestore());
    expect(run).toMatchObject({ code: 6, row: { state: "synced", reason: "restart-not-run", exit: 0 } });
    expect(run.commands).toHaveLength(1);
  });
});

describe("readHomeLinkStatus", () => {
  const wireRow = (id: string, child: unknown) => ({ id, alias: id, direction: "hub-initiated", state: "connected", since: "2026-01-01T00:00:00Z", reason: null, tunnelPort: 27001, child });
  test("asks for Child activity and drops only a malformed child block", async () => {
    const urls: string[] = [];
    const body = { role: "home", listener: { state: "listening", port: 27000 }, child: null,
      links: [wireRow("lnk_aaaaaaaaaaaaaaaa", activity(1)), wireRow("lnk_bbbbbbbbbbbbbbbb", { ...activity(0), activity: { idle: "no" } })] };
    const payload = await statusApi.readHomeLinkStatus(5000, { baseUrl: async () => "http://127.0.0.1:1", headers: () => new Headers(),
      fetchImpl: (async (url: string) => { urls.push(String(url)); return new Response(JSON.stringify(body)); }) as unknown as typeof fetch });
    expect(urls).toEqual(["http://127.0.0.1:1/api/link/status?children=1"]);
    expect(payload.links[0]!.child?.activity.inFlight).toBe(1);
    expect(payload.links[1]).not.toHaveProperty("child");
    expect(payload.links[1]!.id).toBe("lnk_bbbbbbbbbbbbbbbb");
  });
});
