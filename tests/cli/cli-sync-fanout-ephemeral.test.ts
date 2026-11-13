import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runSyncCommand } from "../../src/cli/sync-command";
import type { CliDispatchDeps } from "../../src/cli/dispatch";
import * as codexSync from "../../src/codex/sync";
import * as statusApi from "../../src/cli/sync-link-status";
import * as processApi from "../../src/cli/sync-fanout-process";

// Decode the shell-quoted SSH command without executing the remote script.
function parseRemoteCommand(command: string): string[] {
  const words = command.match(/(?:[^\s'"]+|'[^']*'|"[^"]*")+/g) ?? [];
  return words.map(word => word.replace(/'([^']*)'|"([^"]*)"/g, (_, single, double) => single ?? double));
}

/** ocx sync --overwrite-conflict fans out the plain catalog sync to an ephemeral ocx-child. */
test("ocx sync never forwards overwrite flags to an ephemeral ocx-child link", async () => {
  const temp = mkdtempSync(join(tmpdir(), "ocx-sync-ephemeral-"));
  const previousHome = process.env.OPENCODEX_HOME, previousExit = process.exitCode;
  process.env.OPENCODEX_HOME = temp; process.exitCode = 0;
  const linkDir = join(temp, "link"); mkdirSync(linkDir, { recursive: true });
  const base = { direction: "hub-initiated" as const, hostKeyFingerprint: "SHA256:AAAAAAAAAAAAAAAA", apiKeyId: "test", createdAt: "2026-01-01T00:00:00Z", remotePlatform: "posix" as const };
  const links = [
    { ...base, id: "lnk_0123456789abcdef", alias: "full", tunnelPort: 27001, childKind: "full" as const },
    { ...base, id: "lnk_fedcba9876543210", alias: "devbox", tunnelPort: 27002, childKind: "ephemeral" as const },
  ];
  writeFileSync(join(temp, "config.json"), JSON.stringify({ providers: {}, defaultProvider: "openai" }));
  writeFileSync(join(linkDir, "links.json"), JSON.stringify({ version: 1, listenerPort: 27000, links }));
  const synced = { status: "catalog-only" as const, ok: true, added: 0, catalogPath: "fixture", catalogExists: true, catalogWritten: false, cacheSynced: false, message: "done", refreshOutcome: "committed" as const };
  const sync = spyOn(codexSync, "syncModelsToCodex").mockResolvedValue(synced);
  const status = spyOn(statusApi, "readHomeLinkStatus").mockResolvedValue({ role: "home", listener: { state: "listening", port: 27000 }, child: null,
    links: links.map(link => ({ ...link, state: "connected", since: link.createdAt, reason: null, lastApplyAt: null, runtimeStartedAt: null, appliedCodexSettingsDigest: null })) });
  const commands = new Map<string, string>();
  const child = spyOn(processApi, "runFanoutProcess").mockImplementation(async argv => {
    const command = argv.at(-1)!;
    commands.set(command.includes("lnk_fedcba9876543210") ? "devbox" : "full", command);
    return { code: 0, stdout: "ocx-fanout:stdout-begin\nRemote Link Home catalog synchronized.", stderr: "ocx-fanout:selected:2.100.0\n" };
  });
  const log = spyOn(console, "log").mockImplementation(() => {});
  const error = spyOn(console, "error").mockImplementation(() => {});
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const deps = { args: ["sync", "--json", "--overwrite-conflict", "--overwrite-client", "pi"], findLiveProxy: async () => null } as unknown as CliDispatchDeps;
    expect(await runSyncCommand(deps)).toBe(0);
    const full = parseRemoteCommand(commands.get("full")!);
    expect(full.slice(0, 2)).toEqual(["sh", "-c"]);
    expect(full.slice(3)).toEqual(["ocx", "sync", "--expect-link", links[0]!.id, "--json", "--overwrite-conflict", "--overwrite-client", "pi"]);
    expect(commands.get("devbox")).toBeDefined();
    const devbox = parseRemoteCommand(commands.get("devbox")!);
    expect(devbox.slice(0, 2)).toEqual(["sh", "-c"]);
    expect(devbox.slice(3)).toEqual(["ocx", "sync", "--expect-link", links[1]!.id, "--json"]);
    expect(devbox[2]).not.toContain("child-ephemeral-no-overwrite");
  } finally {
    sync.mockRestore(); status.mockRestore(); child.mockRestore(); log.mockRestore(); error.mockRestore(); warn.mockRestore();
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previousHome;
    process.exitCode = previousExit ?? 0; rmSync(temp, { recursive: true, force: true });
  }
});
