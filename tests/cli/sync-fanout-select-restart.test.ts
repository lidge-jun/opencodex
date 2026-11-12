import { describe, expect, test } from "bun:test";
import { fanoutExitCode, restartNote, runHomeFanout, type ChildRunOptions, type RestartNote } from "../../src/cli/sync-fanout";
import { LinkStatusError } from "../../src/cli/sync-link-status";
import type { LinkStatusPayload } from "../../src/cli/link";
import type { LinkRecord, LinkStore } from "../../src/link/store";
import type { SyncThenRestart } from "../../src/link/sync-then-restart";

const A = "lnk_aaaaaaaaaaaaaaaa", B = "lnk_bbbbbbbbbbbbbbbb", C = "lnk_cccccccccccccccc";
const link = (id: string, alias: string, extra: Partial<LinkRecord> = {}): LinkRecord => ({ id, alias, direction: "hub-initiated",
  hostKeyFingerprint: "SHA256:AAAAAAAAAAAAAAAA", tunnelPort: 27001, apiKeyId: "k", createdAt: "2026-01-01T00:00:00Z", ...extra }) as LinkRecord;
const childBlock = (inFlight: number, activeJob: { jobId: string; op: string; state: "queued" | "running" } | null = null) => ({
  homeVersion: "2.99.0", runningVersion: null, installedVersion: null, installKind: null, versionSkew: "unknown",
  update: { route: null, reason: null, observedAt: null }, catalog: { state: "unknown", pulledAt: null, homeChangedAt: null },
  codex: null, activity: { idle: inFlight === 0, inFlight, lastDataEndAt: null }, activeJob, lastOperation: null,
});
const row = (record: LinkRecord, child?: ReturnType<typeof childBlock>) => ({ id: record.id, alias: record.alias, direction: record.direction,
  state: "connected", since: record.createdAt, reason: null, tunnelPort: 27001, lastApplyAt: null, runtimeStartedAt: null,
  appliedCodexSettingsDigest: null, ...(child ? { child } : {}) });
const status = (rows: ReturnType<typeof row>[]): LinkStatusPayload => ({ role: "home", listener: { state: "listening", port: 27000 }, child: null, links: rows }) as unknown as LinkStatusPayload;
const store = (links: LinkRecord[]): LinkStore => ({ version: 1, listenerPort: 27000, links }) as LinkStore;
type Row = Awaited<ReturnType<Parameters<typeof runHomeFanout>[0]["runChild"]>>;

function harness(links: LinkRecord[], reads: Array<LinkStatusPayload | Error>, run: (record: LinkRecord, options: ChildRunOptions) => Promise<Row> = async () => ({ state: "synced", reason: null, exit: 0 })) {
  const calls: Array<{ id: string; options: ChildRunOptions }> = [];
  let statusReads = 0;
  const deps = {
    home: { state: "synced" as const, exit: 0 }, catalogCurrent: true, readStore: () => store(links),
    readLinkStatus: async () => { const next = reads[Math.min(statusReads++, reads.length - 1)]!; if (next instanceof Error) throw next; return next; },
    runChild: async (record: LinkRecord, _deadline: number, options: ChildRunOptions) => { calls.push({ id: record.id, options }); return run(record, options); },
  };
  return { deps, calls, reads: () => statusReads };
}

describe("ocx sync --child selection", () => {
  test("--child runs only the selected link", async () => {
    const a = link(A, "alpha"), b = link(B, "beta");
    const h = harness([a, b], [status([row(a), row(b)])]);
    const document = await runHomeFanout({ ...h.deps, selected: new Set([A]) });
    expect(h.calls.map(call => call.id)).toEqual([A]);
    expect(document.children[1]).toEqual({ linkId: B, alias: "beta", state: "skipped", reason: "not-selected", exit: null });
    expect(fanoutExitCode(document)).toBe(0);
  });

  test("selection wins in every branch, including client-initiated links and a failed Home or status read", async () => {
    const a = link(A, "alpha"), b = link(B, "beta"), c = link(C, "gamma", { direction: "client-initiated" });
    const failedHome = harness([a, b, c], [status([row(a), row(b)])]);
    const home = await runHomeFanout({ ...failedHome.deps, home: { state: "failed", exit: 1 }, selected: new Set([A]) });
    expect(home.children.map(child => child.reason)).toEqual(["home-sync-failed", "not-selected", "not-selected"]);
    const unreadable = harness([a, b, c], [new LinkStatusError("home-link-status-invalid")]);
    const invalid = await runHomeFanout({ ...unreadable.deps, selected: new Set([A]) });
    expect(invalid.children.map(child => [child.state, child.reason])).toEqual([["failed", "home-link-status-invalid"], ["skipped", "not-selected"], ["skipped", "not-selected"]]);
    const notCurrent = await runHomeFanout({ ...harness([a, b], [status([])]).deps, catalogCurrent: false, selected: new Set([B]) });
    expect(notCurrent.children.map(child => child.reason)).toEqual(["not-selected", "home-catalog-not-current"]);
    expect(fanoutExitCode(invalid)).toBe(6);
  });

  test("a Child held by a Child operation is skipped as child-busy without flags, SSH or exit 6", async () => {
    const a = link(A, "alpha"), b = link(B, "beta");
    const h = harness([a, b], [status([row(a, childBlock(0, { jobId: "job_1", op: "update", state: "running" })), row(b, childBlock(0))])]);
    const document = await runHomeFanout(h.deps);
    expect(document.children[0]).toEqual({ linkId: A, alias: "alpha", state: "skipped", reason: "child-busy", exit: null });
    expect(h.calls.map(call => call.id)).toEqual([B]);
    expect(fanoutExitCode(document)).toBe(0);
  });
});

describe("ocx sync --restart-children fan-out", () => {
  test("the restart request reaches runChild; without it there is no restart and no second status read", async () => {
    const a = link(A, "alpha");
    const asked = harness([a], [status([row(a, childBlock(0))])]);
    await runHomeFanout({ ...asked.deps, restartChildren: "codex" });
    expect(asked.calls[0]!.options.restart).toBe("codex");
    const plain = harness([a], [status([row(a, childBlock(0))])]);
    await runHomeFanout(plain.deps);
    expect(plain.calls[0]!.options.restart).toBeUndefined();
    expect(plain.reads()).toBe(1);
  });

  test("readActivity reads status afresh for that link", async () => {
    const a = link(A, "alpha");
    let seen: unknown;
    const h = harness([a], [status([row(a, childBlock(0))]), status([row(a, childBlock(1))])], async (_record, options) => {
      seen = await options.readActivity(); return { state: "synced", reason: null, exit: 0 };
    });
    await runHomeFanout({ ...h.deps, restartChildren: "app-server" });
    expect(seen).toMatchObject({ inFlight: 1 });
    expect(h.reads()).toBe(2);
  });

  test("a row without child and a failed re-read are both unknown, with different hints", async () => {
    const a = link(A, "alpha");
    const results: unknown[] = [];
    const unknownRow = async (_record: LinkRecord, options: ChildRunOptions): Promise<Row> => {
      results.push(await options.readActivity()); return { state: "synced", reason: "restart-skipped:activity-unknown", exit: 0 };
    };
    const absent = await runHomeFanout({ ...harness([a], [status([row(a, childBlock(0))]), status([row(a)])], unknownRow).deps, restartChildren: "app-server" });
    const failed = await runHomeFanout({ ...harness([a], [status([row(a, childBlock(0))]), new LinkStatusError("home-link-status-timeout")], unknownRow).deps, restartChildren: "codex" });
    expect(results).toEqual([null, null]);
    expect(absent.children[0]!.hint).toContain("did not report");
    expect(absent.children[0]!.hint).toContain("ocx sync --child " + A + " --restart-children");
    expect(failed.children[0]!.hint).toContain("could not read");
    expect(failed.children[0]!.hint).toContain("ocx sync --child " + A + " --restart-children=codex --yes");
    expect(failed.children[0]!.hint).not.toContain("update");
    expect(fanoutExitCode(absent)).toBe(6);
  });

  const notes: RestartNote[] = ["restart-skipped:link-active", "restart-skipped:activity-unknown", "restart-skipped:windows",
    "restart-unsupported:ocx-child", "restart-not-run", "restart-result-unknown"];
  test.each(notes)("%s on a synced row carries a hint and exits 6", async note => {
    const a = link(A, "alpha");
    const h = harness([a], [status([row(a, childBlock(0))])], async () => ({ state: "synced", reason: note, exit: 0 }));
    const document = await runHomeFanout({ ...h.deps, restartChildren: "app-server" });
    expect(document.children[0]).toMatchObject({ state: "synced", reason: note });
    expect(typeof document.children[0]!.hint).toBe("string");
    expect(fanoutExitCode(document)).toBe(6);
  });

  test("a synced row without a restart note exits 0 and runner-only keys never reach the document", async () => {
    const a = link(A, "alpha");
    const h = harness([a], [status([row(a, childBlock(0))])], async () => ({ state: "synced", reason: null, exit: 0, executable: "ocx-child" }) as Row);
    const document = await runHomeFanout({ ...h.deps, restartChildren: "app-server" });
    expect(fanoutExitCode(document)).toBe(0);
    for (const child of document.children) {
      expect(Object.keys(child).every(key => ["linkId", "alias", "state", "reason", "exit", "hint"].includes(key))).toBe(true);
    }
  });
});

describe("restartNote", () => {
  type Done = SyncThenRestart<{ state: string; reason: string | null }>;
  const synced = { state: "synced", reason: null };
  const failed = { state: "failed", reason: "child-sync-failed" };
  const r = (outcome: "requested" | "unsupported" | "not-run" | "skipped") => ({ requested: "app-server" as const, outcome });
  test.each<[string, Done, RestartNote | null]>([
    ["no restart requested", { sync: synced }, null],
    ["restart requested", { sync: synced, restart: r("requested"), second: synced }, null],
    ["windows", { sync: synced, restart: r("unsupported"), withheld: "platform" }, "restart-skipped:windows"],
    ["ocx-child", { sync: synced, restart: r("unsupported"), withheld: "ocx-child" }, "restart-unsupported:ocx-child"],
    ["plain sync failed", { sync: failed, restart: r("not-run"), withheld: "sync-failed" }, null],
    ["failed plain sync on windows", { sync: failed, restart: r("unsupported"), withheld: "platform" }, null],
    ["failed plain sync on ephemeral", { sync: failed, restart: r("unsupported"), withheld: "ocx-child" }, null],
    ["activity unknown", { sync: synced, restart: r("skipped"), withheld: "activity-unknown" }, "restart-skipped:activity-unknown"],
    ["link active", { sync: synced, restart: r("skipped"), withheld: "link-active" }, "restart-skipped:link-active"],
    ["second ran nothing", { sync: synced, restart: r("not-run"), withheld: "second-not-run", second: failed }, "restart-not-run"],
    ["result unknown", { sync: failed, restart: r("requested"), restartUnknown: true, second: failed }, "restart-result-unknown"],
  ])("%s", (_name, done, expected) => {
    expect(restartNote(done)).toBe(expected);
  });
});
