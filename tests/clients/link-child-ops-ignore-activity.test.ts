import { describe, expect, spyOn, test } from "bun:test";
import { runRestartCodexItem, runSyncItem } from "../../src/link/child-ops-runners";
import { createChildOpsEngine } from "../../src/link/child-ops-engine";
import type { ChildOpsEnv, ChildRestart, ChildTrigger, ItemRunner } from "../../src/link/child-ops-types";
import type { SshRunResult } from "../../src/link/ssh-runner";
import type { LinkRecord } from "../../src/link/store";
import { parseOperation } from "../../src/server/management/link-child-ops-routes";

// Lane T5d3b: the operator's explicit restart past activity (owner decision D8, --ignore-activity). Manual, one link,
// a restart only; the scheduler and every automatic path keep the activity gate.

const LINK = "lnk_0123456789abcdef";
const OTHER = "lnk_fedcba9876543210";
const SYNCED: SshRunResult = { code: 0, stdout: "ocx-fanout:stdout-begin\nRemote Link Home catalog synchronized.\n", stderr: "ocx-fanout:selected:2.98.0\n" };

function fakeSsh() {
  const kinds: string[] = [];
  return { kinds, runner: { async run(argv: string[]) {
    const remote = argv.at(-1)!;
    kinds.push(remote.includes("'--restart-app-server-only'") || remote.includes("'--restart-codex'") ? "restart" : "sync");
    return SYNCED;
  } } };
}
function record(overrides: Partial<LinkRecord> = {}): LinkRecord {
  return { id: LINK, alias: "child-01", direction: "hub-initiated", hostKeyFingerprint: "SHA256:abcdefghijklmnopqrstuvwxyz012345",
    tunnelPort: 41000, apiKeyId: "key-01", createdAt: "2026-11-01T00:00:00.000Z", remotePlatform: "posix", ...overrides };
}
function env(ssh: ReturnType<typeof fakeSsh>, activity: ChildOpsEnv["activity"]): ChildOpsEnv {
  return { readStore: () => ({ version: 1, listenerPort: 18181, links: [record()] }), runner: ssh.runner, knownHostsFile: "/tmp/ocx-test-known-hosts",
    wireState: () => "connected", activity, homeVersion: "2.100.0", now: () => Date.parse("2026-11-12T00:00:00.000Z"), sleep: async () => {},
    observe: async () => { throw new Error("not scripted"); }, readObservation: () => null, writeObservation: () => {}, catalogEtag: () => null };
}
const job = (op: "sync" | "restart-codex", restart: ChildRestart, trigger: ChildTrigger = "manual", ignoreActivity = true) =>
  ({ op, restart, trigger, ...(ignoreActivity ? { ignoreActivity: true as const } : {}) });
const busy = () => ({ idle: false, inFlight: 2 });
const quiet = <T>(fn: () => Promise<T>) => { const log = spyOn(console, "log").mockImplementation(() => {}); return fn().finally(() => log.mockRestore()); };

describe("runners", () => {
  test.each([["busy", busy], ["unknown", () => null]] as const)("a manual sync with a restart and ignoreActivity restarts a %s link", async (_label, activity) => {
    const ssh = fakeSsh();
    const outcome = await quiet(() => runSyncItem(record(), job("sync", "app-server"), env(ssh, activity)));
    expect(outcome).toMatchObject({ state: "succeeded", reason: null, restart: { requested: "app-server", outcome: "requested" } });
    expect(ssh.kinds).toEqual(["sync", "restart"]);
  });

  test("restart-codex with ignoreActivity restarts a busy link", async () => {
    const ssh = fakeSsh();
    const outcome = await quiet(() => runRestartCodexItem(record(), job("restart-codex", "codex"), env(ssh, busy)));
    expect(outcome).toMatchObject({ state: "succeeded", restart: { requested: "codex", outcome: "requested" } });
    expect(ssh.kinds).toEqual(["sync", "restart"]);
  });

  test("the override is logged with the link id and the activity it passed, nothing else", async () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      await runRestartCodexItem(record(), job("restart-codex", "app-server"), env(fakeSsh(), busy));
      expect(log.mock.calls.map(call => String(call[0]))).toEqual([`[link] restart past activity by the operator linkId=${LINK} inFlight=2`]);
    } finally { log.mockRestore(); }
  });

  test("an automatic job never ignores activity, even if the flag were set on it", async () => {
    const ssh = fakeSsh();
    const outcome = await runSyncItem(record(), job("sync", "app-server", "auto"), env(ssh, () => ({ idle: false, inFlight: 1 })));
    expect(outcome).toMatchObject({ restart: { outcome: "skipped" } });
    expect(ssh.kinds).toEqual(["sync"]);
  });

  test("without the flag a busy link is still withheld (unchanged)", async () => {
    const ssh = fakeSsh();
    expect(await runRestartCodexItem(record(), job("restart-codex", "app-server", "manual", false), env(ssh, busy)))
      .toEqual({ state: "busy", reason: "restart-skipped:link-active", restart: { requested: "app-server", outcome: "skipped" } });
    expect(ssh.kinds).toEqual([]);
  });

  test("the flag overrides activity only: Windows and ocx-child stay unsupported", async () => {
    expect(await runRestartCodexItem(record({ remotePlatform: "windows" }), job("restart-codex", "app-server"), env(fakeSsh(), busy)))
      .toMatchObject({ state: "unsupported", reason: "windows-restart" });
    expect(await runRestartCodexItem(record({ childKind: "ephemeral" }), job("restart-codex", "app-server"), env(fakeSsh(), busy)))
      .toMatchObject({ state: "unsupported", reason: "ephemeral-restart" });
  });
});

describe("engine", () => {
  const capture = () => {
    const seen: unknown[] = [];
    const runner: ItemRunner = async (_record, j) => {
      seen.push({ op: j.op, restart: j.restart, trigger: j.trigger, ...("ignoreActivity" in j ? { ignoreActivity: j.ignoreActivity } : {}) });
      return { state: "succeeded", reason: null };
    };
    return { seen, engine: createChildOpsEngine({ runners: { sync: runner, "restart-codex": runner } }) };
  };

  test("a manual request carries ignoreActivity onto the job and its runner", async () => {
    const { seen, engine } = capture();
    const result = engine.submit({ op: "sync", linkIds: [LINK], restart: "app-server", trigger: "manual", ignoreActivity: true }, env(fakeSsh(), busy));
    expect(result.ok && result.job.ignoreActivity).toBe(true);
    await engine.settled();
    expect(seen).toEqual([{ op: "sync", restart: "app-server", trigger: "manual", ignoreActivity: true }]);
  });

  test("an automatic request drops it, and a request without it leaves the job document unchanged", async () => {
    const { seen, engine } = capture();
    const auto = engine.submit({ op: "sync", linkIds: [LINK], restart: "app-server", trigger: "auto", ignoreActivity: true }, env(fakeSsh(), busy));
    expect(auto.ok && "ignoreActivity" in auto.job).toBe(false);
    await engine.settled();
    const plain = engine.submit({ op: "sync", linkIds: [LINK], restart: "app-server", trigger: "manual" }, env(fakeSsh(), busy));
    expect(plain.ok && "ignoreActivity" in plain.job).toBe(false);
    await engine.settled();
    expect(seen.every(j => !("ignoreActivity" in (j as object)))).toBe(true);
  });
});

describe("route body", () => {
  test("accepted only as true, with exactly one link and a restart", () => {
    expect(parseOperation({ op: "sync", linkIds: [LINK], restart: "app-server", ignoreActivity: true }))
      .toEqual({ op: "sync", linkIds: [LINK], restart: "app-server", ignoreActivity: true });
    expect(parseOperation({ op: "restart-codex", linkIds: [LINK], ignoreActivity: true }))
      .toEqual({ op: "restart-codex", linkIds: [LINK], restart: "app-server", ignoreActivity: true });
    for (const body of [
      { op: "sync", linkIds: [LINK], ignoreActivity: true },
      { op: "sync", linkIds: "all", restart: "app-server", ignoreActivity: true },
      { op: "sync", linkIds: [LINK, OTHER], restart: "app-server", ignoreActivity: true },
      { op: "update", linkIds: [LINK], ignoreActivity: true },
      { op: "update", linkIds: [LINK], restart: "app-server", ignoreActivity: true },
      { op: "observe", linkIds: [LINK], ignoreActivity: true },
      { op: "sync", linkIds: [LINK], restart: "app-server", ignoreActivity: false },
      { op: "sync", linkIds: [LINK], restart: "app-server", ignoreActivity: "yes" },
    ]) expect(parseOperation(body)).toBeNull();
    expect(parseOperation({ op: "sync", linkIds: [LINK], restart: "app-server" })).toEqual({ op: "sync", linkIds: [LINK], restart: "app-server" });
  });
});
