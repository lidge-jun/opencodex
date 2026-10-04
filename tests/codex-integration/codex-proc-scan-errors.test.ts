import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import {
  collectCodexAppServerCatalogState,
  listCodexAppServerProcesses,
  listProcessSnapshots,
  restartCodexAppServers,
  scanCodexAppServerProcesses,
  scanCodexSessionProcesses,
} from "../../src/codex/app-server-processes";
import { createCodexCliUpdatePlan } from "../../src/codex/cli-update-plan";

const OWN_UID = 1000;
const io = { platform: "linux" as const, getuid: () => OWN_UID };
const APP_SERVER = { pid: 41, commandLine: "/bin/codex app-server" };
const restore: Array<() => void> = [];
afterEach(() => {
  for (const undo of restore.splice(0).reverse()) undo();
});

// Exercise the actual procfs enumeration and its callers, not listSnapshots.
// Only /proc reads are synthetic; never inspect or signal a real process.
function procFixture(failure?: { file: "status" | "cmdline"; error: Error }, pids = [41, 42, 43, 44]) {
  const realExists = fs.existsSync;
  const realReadDir = fs.readdirSync;
  const realRead = fs.readFileSync;
  const exists = spyOn(fs, "existsSync").mockImplementation(path => path === "/proc" || realExists(path));
  restore.push(() => exists.mockRestore());
  const readDir = spyOn(fs, "readdirSync").mockImplementation(((...args: Parameters<typeof fs.readdirSync>) =>
    args[0] === "/proc" ? pids.map(String) : realReadDir(...args)) as typeof fs.readdirSync);
  restore.push(() => readDir.mockRestore());
  const read = spyOn(fs, "readFileSync").mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
    const path = String(args[0]);
    if (!path.startsWith("/proc/")) return realRead(...args);
    if (failure && path === `/proc/42/${failure.file}`) throw failure.error;
    const match = /^\/proc\/(41|42|43|44)\/(status|cmdline)$/.exec(path);
    if (!match) throw new Error(`Unexpected procfs read: ${path}`);
    if (match[2] === "status") return `Uid:\t${match[1] === "43" ? 2000 : OWN_UID}\n`;
    return Buffer.from(match[1] === "44" ? "/bin/codex\0" : "/bin/codex\0app-server\0");
  }) as typeof fs.readFileSync);
  restore.push(() => read.mockRestore());
  return read;
}

describe("procfs process read failures", () => {
  for (const file of ["status", "cmdline"] as const) {
    for (const code of ["EACCES", "EPERM", "EIO", undefined]) {
      test(`${file} ${code ?? "uncoded error"} invalidates the whole scan`, () => {
        const error = Object.assign(new Error("synthetic procfs failure"), { code });
        procFixture({ file, error });
        // PID 41 is observed before the failure; a partial result is not evidence.
        expect(() => listProcessSnapshots(io)).toThrow(error);
        expect(scanCodexSessionProcesses({ platform: "linux" })).toEqual({ kind: "unavailable" });
        expect(scanCodexAppServerProcesses(io)).toEqual({ kind: "unavailable" });
        expect(collectCodexAppServerCatalogState({ ...io, catalogMtimeMs: () => 1000 }).state).toBe("unknown");
        expect(listCodexAppServerProcesses(io)).toEqual([]);
        const signals: number[] = [];
        restartCodexAppServers([APP_SERVER], {
          ...io, kill: pid => { signals.push(pid); }, isAlive: () => true, waitExit: () => true,
        });
        expect(signals).toEqual([]);
      });
    }

    test(`${file} ENOENT skips only the departed process`, () => {
      procFixture({ file, error: Object.assign(new Error("departed"), { code: "ENOENT" }) });
      expect(listProcessSnapshots(io).map(row => row.pid)).toEqual([41, 44]);
      expect(scanCodexSessionProcesses({ platform: "linux" })).toEqual({
        kind: "observed", processes: [APP_SERVER, { ...APP_SERVER, pid: 43 }, { pid: 44, commandLine: "/bin/codex" }],
      });
      expect(scanCodexSessionProcesses(io)).toEqual({
        kind: "observed", processes: [APP_SERVER, { pid: 44, commandLine: "/bin/codex" }],
      });
      expect(listCodexAppServerProcesses(io)).toEqual([APP_SERVER]);
      const signals: number[] = [];
      restartCodexAppServers([APP_SERVER, { ...APP_SERVER, pid: 43 }, { pid: 44, commandLine: "/bin/codex" }], {
        ...io, kill: pid => { signals.push(pid); }, isAlive: () => true, waitExit: () => true,
      });
      // Foreign-user and interactive sessions block updates, but remain outside the kill contract.
      expect(signals).toEqual([41]);
    });
  }

  test("an empty procfs observation remains distinct from an unreadable one", () => {
    procFixture(undefined, []);
    expect(scanCodexSessionProcesses({ platform: "linux" })).toEqual({ kind: "observed", processes: [] });
  });

  test("the default planner refuses an unreadable candidate instead of accepting no sessions", async () => {
    procFixture({ file: "cmdline", error: Object.assign(new Error("denied"), { code: "EACCES" }) }, [42]);
    const plan = await createCodexCliUpdatePlan({
      platform: "linux",
      processIo: { platform: "linux" },
      inspect: async () => ({
        schemaVersion: 1, candidateAvailable: true, candidateVersion: "1.0.0", candidateSource: "environment",
        selectionAttested: true, versionEvidence: { kind: "package-manifest" }, provenance: "npm-global",
        managed: true, reason: "managed_npm_global", location: "<npm-global>/@openai/codex",
        installDigest: "a".repeat(64), packageVersion: "1.0.0", shim: { status: "not-tracked", backingKind: null },
        evidence: ["package_manifest", "global_npm_layout"],
      }),
      resolveTarget: () => ({ kind: "resolved", version: "1.1.0", integrity: "sha512-AAAA" }),
    });
    expect(plan.applicable).toBe(false);
    expect(plan.refusal).toBe("blocked_process_state_unknown");
    expect(plan.session).toEqual({ state: "unknown", matches: null });
  });
});
