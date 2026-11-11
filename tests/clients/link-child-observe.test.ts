import { describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as gated from "../../src/link/child-gated-ocx";
import { observeChild, type ObserveDeps } from "../../src/link/child-observe";
import { emptyChildObservations, patchChildObservation, withoutCarriedFields, type ChildObservation } from "../../src/link/child-observations";
import { createChildOpsEngine } from "../../src/link/child-ops-engine";
import type { ChildOpsEnv } from "../../src/link/child-ops-types";
import type { ObserveOutcome } from "../../src/link/child-observe";
import { ConfigMutationLockError } from "../../src/config/mutation-lock";
import type { LinkPeerEntry } from "../../src/link/peer-report";
import type { ParsedRemoteRuntimeInspection } from "../../src/link/remote-plant";
import { SshRunnerError, type SshRunResult } from "../../src/link/ssh-runner";
import type { LinkRecord, LinkStore } from "../../src/link/store";

const NOW = new Date("2026-11-11T00:00:00.000Z");
const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz012345_-";
const record = (overrides: Partial<LinkRecord> = {}): LinkRecord => ({ id: "lnk_0123456789abcdef", alias: "child-a", direction: "hub-initiated",
  hostKeyFingerprint: "SHA256:abcdefghijklmnopqrstuvwxyz012345", tunnelPort: 41000, apiKeyId: "key-a", createdAt: "2026-11-01T00:00:00.000Z",
  remotePlatform: "posix", ...overrides });
const peer = (version: string | null, features: string[] | null = null): LinkPeerEntry => ({
  observed: { reported: true, version, features, relayAuth: "2", observedAt: NOW.toISOString() }, refused: null });
const plan = (overrides: Record<string, unknown> = {}) => ({ schema: "ocx.update.plan/1", currentVersion: "2.97.0", targetVersion: "2.100.0",
  installer: "npm", runtimeOwner: "service", servingPath: "/opt/ocx", cliPath: "/opt/ocx", canApply: true, restartRequired: true,
  planToken: TOKEN, updateInFlight: false, mutationBoundMs: 900_000, ...overrides });
const ran = (payload: unknown, stderr = "ocx-fanout:selected:2.97.0\nocx-fanout:entry:binary\nocx-fanout:child-now:1762819200000\n"): SshResult => ({
  code: 0, stdout: "ocx-fanout:stdout-begin\n" + JSON.stringify(payload) + "\n", stderr });
type SshResult = SshRunResult;

function deps(answer: SshResult | (() => SshResult | Promise<SshResult>), overrides: Partial<ObserveDeps> = {}) {
  const calls: string[][] = [];
  const inspections: string[] = [];
  const value: ObserveDeps = {
    runner: { run: async argv => { calls.push([...argv]); return typeof answer === "function" ? answer() : answer; } },
    knownHostsFile: "/tmp/known_hosts", homeVersion: "2.100.0", peer: () => peer("2.97.0"),
    platformOf: async () => "posix",
    inspect: async (_runner, _alias, _known, platform) => {
      inspections.push(platform);
      return { runtimeKind: "full", targetTriple: null, rawArch: "x86_64", ocxVersionLine: "opencodex 2.96.0" } satisfies ParsedRemoteRuntimeInspection;
    },
    now: () => NOW,
    ...overrides,
  };
  return { value, calls, inspections };
}

describe("observeChild", () => {
  test("client-initiated and ephemeral never call SSH", async () => {
    const client = deps(ran(plan()));
    const initiated = await observeChild(record({ direction: "client-initiated", hostKeyFingerprint: null }), client.value);
    expect(initiated).toEqual({ state: "unsupported", reason: "child-initiated", probe: null, observation: {
      observedAt: NOW.toISOString(), source: "peer", installedVersion: "2.97.0", installKind: "unknown", runtimeOwner: null, updateRoute: "none",
      updateReason: "child-initiated", targetVersion: null, updateInFlight: null, catalogPulledAt: null, catalogPulledEtag: null,
      catalogSyncedEtag: null, lastOperation: null, suppressedTarget: null, autoUpdateAttempts: null, pendingUpdateRecovery: null } });
    const ephemeral = await observeChild(record({ childKind: "ephemeral" }), client.value);
    expect(ephemeral).toMatchObject({ state: "succeeded", reason: null, probe: null, observation: { source: "peer", installedVersion: null,
      installKind: "ocx-child", runtimeOwner: null, updateRoute: "replant", updateReason: "ocx-child", targetVersion: null, updateInFlight: null } });
    expect(client.calls).toEqual([]);
  });

  test("plan up-to-date, orchestrated, desktop-request (peer feature) and launcher-bypassed rows", async () => {
    const upToDate = await observeChild(record(), deps(ran(plan({ currentVersion: "2.100.0", canApply: false, reason: "up-to-date" }))).value);
    expect(upToDate).toMatchObject({ state: "succeeded", observation: { source: "plan", installedVersion: "2.100.0", installKind: "npm",
      updateRoute: "none", updateReason: "up-to-date" } });
    const orchestrated = await observeChild(record(), deps(ran(plan({ installer: "bun" }))).value);
    expect(orchestrated).toMatchObject({ state: "succeeded", observation: { installKind: "bun", updateRoute: "orchestrated", updateReason: null, targetVersion: "2.100.0" },
      probe: { childNowMs: 1762819200000, startedAt: NOW.getTime(), platform: "posix", classification: { planToken: TOKEN } } });
    const desktopPlan = plan({ installer: "desktop-app", runtimeOwner: "desktop-app", canApply: false, reason: "desktop-app-owned" });
    const desktop = await observeChild(record(), deps(ran(desktopPlan), { peer: () => peer("2.97.0", ["desktop-update-request/1"]) }).value);
    expect(desktop.observation).toMatchObject({ installKind: "desktop-app", updateRoute: "desktop-request", runtimeOwner: "desktop-app" });
    const noFeature = await observeChild(record(), deps(ran(desktopPlan)).value);
    expect(noFeature.observation).toMatchObject({ updateRoute: "owner-action" });
    const bypassed = await observeChild(record(), deps(ran(plan(), "ocx-fanout:selected:2.97.0\nocx-fanout:entry:pair\n")).value);
    expect(bypassed).toMatchObject({ state: "succeeded", observation: { updateRoute: "owner-action", updateReason: "launcher-bypassed" }, probe: { childNowMs: null } });
  });

  test("plan observation copies updateInFlight and runtimeOwner from the classification", async () => {
    const outcome = await observeChild(record(), deps(ran(plan({ updateInFlight: true, runtimeOwner: "unmanaged" }))).value);
    expect(outcome.observation).toMatchObject({ updateInFlight: true, runtimeOwner: "unmanaged" });
  });

  test("exit 121 lacks marker → inspect (POSIX) or peer (Windows) and owner-action", async () => {
    const refused: SshResult = { code: 121, stdout: "", stderr: "ocx-fanout:child-ocx-lacks-orchestrated-update\n" };
    const posix = deps(refused);
    const outcome = await observeChild(record(), posix.value);
    expect(outcome).toMatchObject({ state: "owner-action", reason: "legacy-ocx", probe: null, observation: { source: "inspect", installedVersion: "2.96.0",
      installKind: "unknown", runtimeOwner: null, updateRoute: "owner-action", updateReason: "legacy-ocx", targetVersion: null, updateInFlight: null } });
    expect(posix.inspections).toEqual(["posix"]);
    const windows = deps(refused, { peer: () => peer("2.95.0") });
    const win = await observeChild(record({ remotePlatform: "windows" }), windows.value);
    expect(win).toMatchObject({ state: "owner-action", observation: { source: "peer", installedVersion: "2.95.0", updateInFlight: null } });
    expect(windows.inspections).toEqual([]);
  });

  test("peer, ephemeral and legacy observations write updateInFlight null", async () => {
    const stored = emptyChildObservations();
    const linkId = record().id;
    stored.children[linkId] = { observedAt: "2026-11-01T00:00:00.000Z", source: "plan", installedVersion: "2.97.0", installKind: "npm",
      runtimeOwner: "service", updateRoute: "orchestrated", updateReason: null, targetVersion: "2.100.0", catalogPulledAt: 5, lastOperation: null,
      suppressedTarget: null, catalogPulledEtag: "\"e\"", catalogSyncedEtag: null, autoUpdateAttempts: null, updateInFlight: true, pendingUpdateRecovery: null };
    const outcome = await observeChild(record({ childKind: "ephemeral" }), deps(ran(plan())).value);
    patchChildObservation(stored, linkId, withoutCarriedFields(outcome.observation!), NOW);
    expect(stored.children[linkId]).toMatchObject({ updateInFlight: null, runtimeOwner: null, targetVersion: null, installKind: "ocx-child",
      catalogPulledAt: 5, catalogPulledEtag: "\"e\"", observedAt: NOW.toISOString() });
    const ephemeralVerdict = await observeChild(record(), deps({ code: 121, stdout: "", stderr: "ocx-fanout:child-ocx-ephemeral\n" }).value);
    expect(ephemeralVerdict).toMatchObject({ state: "succeeded", observation: { installKind: "ocx-child", updateInFlight: null, runtimeOwner: null, targetVersion: null } });
  });

  test("Windows plan without an entry marker is classified with platform windows", async () => {
    const spy = spyOn(gated, "classifyUpdatePlanProbe");
    try {
      const outcome = await observeChild(record({ remotePlatform: undefined }), deps(ran(plan(), "ocx-fanout:selected:2.97.0\n"), { platformOf: async () => "windows" }).value);
      expect(spy.mock.calls[0]?.[1]).toEqual({ homeVersion: "2.100.0", desktopUpdateRequest: false, platform: "windows" });
      expect(outcome).toMatchObject({ state: "succeeded", probe: { platform: "windows" }, observation: { updateRoute: "orchestrated" } });
    } finally { spy.mockRestore(); }
  });

  test("a Windows argv over the budget is failed windows-command-too-long with no SSH", async () => {
    const version = "1.0.0-a" + createHash("sha512").update("x").digest("hex").slice(0, 120);
    const windows = deps(ran(plan()), { homeVersion: version });
    expect(await observeChild(record({ remotePlatform: "windows" }), windows.value)).toEqual({ state: "failed", reason: "windows-command-too-long", observation: null, probe: null });
    const invalid = deps(ran(plan()), { homeVersion: "not-a-version" });
    expect(await observeChild(record(), invalid.value)).toEqual({ state: "failed", reason: "home-version-invalid", observation: null, probe: null });
    expect([...windows.calls, ...invalid.calls]).toEqual([]);
  });

  test("255 → offline; platform discovery throw → offline; runner throw → offline; output limit and decode → failed", async () => {
    expect(await observeChild(record(), deps({ code: 255, stdout: "", stderr: "ssh: connect" }).value)).toEqual({ state: "offline", reason: "ssh-failed", observation: null, probe: null });
    const discovery = deps(ran(plan()), { platformOf: async () => { throw new Error("unreachable"); } });
    expect(await observeChild(record({ remotePlatform: undefined }), discovery.value)).toEqual({ state: "offline", reason: "platform-unknown", observation: null, probe: null });
    expect(discovery.calls).toEqual([]);
    expect(await observeChild(record(), deps(() => { throw new SshRunnerError("spawn", "no ssh"); }).value)).toMatchObject({ state: "offline", reason: "ssh-error" });
    expect(await observeChild(record(), deps(() => { throw new SshRunnerError("timeout", "slow"); }).value)).toMatchObject({ state: "offline", reason: "ssh-error" });
    expect(await observeChild(record(), deps(() => { throw new SshRunnerError("output_limit", "big"); }).value)).toMatchObject({ state: "failed", reason: "ssh-output-limit" });
    expect(await observeChild(record(), deps(() => { throw new SshRunnerError("decode", "bytes"); }).value)).toMatchObject({ state: "failed", reason: "ssh-output-decode" });
  });

  test("malformed child-now line → failed child-output-invalid", async () => {
    const outcome = await observeChild(record(), deps(ran(plan(), "ocx-fanout:selected:2.97.0\nocx-fanout:child-now:soon\n")).value);
    expect(outcome).toEqual({ state: "failed", reason: "child-output-invalid", observation: null, probe: null });
  });

  test("invalid peer version stores installedVersion null", async () => {
    const outcome = await observeChild(record({ direction: "client-initiated" }), deps(ran(plan()), { peer: () => peer("2.97") }).value);
    expect(outcome.observation?.installedVersion).toBeNull();
    const windows = await observeChild(record({ remotePlatform: "windows" }), deps({ code: 121, stdout: "", stderr: "ocx-fanout:child-ocx-version-unknown\n" },
      { peer: () => peer("garbage") }).value);
    expect(windows).toMatchObject({ state: "owner-action", observation: { installedVersion: null } });
  });

  test("the probe is the gated update --plan for the Home version over the pinned alias", async () => {
    const observed = deps(ran(plan()));
    await observeChild(record(), observed.value);
    expect(observed.calls).toHaveLength(1);
    expect(observed.calls[0]).toContain("child-a");
    expect(observed.calls[0]!.at(-1)).toContain("--plan");
  });
});

describe("child ops engine", () => {
  const ids = Array.from({ length: 5 }, (_, index) => "lnk_" + String(index).repeat(16));
  const store = (links: LinkRecord[]) => ({ version: 1 as const, listenerPort: null, links });
  const succeeded = (now: Date): ObserveOutcome => ({ state: "succeeded", reason: null, probe: null, observation: {
    observedAt: now.toISOString(), source: "peer", installedVersion: null, installKind: "ocx-child", runtimeOwner: null, updateRoute: "replant",
    updateReason: "ocx-child", targetVersion: null, updateInFlight: null, catalogPulledAt: null, catalogPulledEtag: null, catalogSyncedEtag: null,
    lastOperation: null, suppressedTarget: null, autoUpdateAttempts: null, pendingUpdateRecovery: null } });
  /**
   * wp2's observe-only engine options on wp3's engine (Revision 6 F1): one env per submit whose cache writer never throws,
   * logging a failure by error name exactly as the route env does.
   */
  function observeEngine(deps: { readStore: () => LinkStore; observe: (target: LinkRecord) => Promise<ObserveOutcome>;
    writeObservation: (linkId: string, patch: Partial<ChildObservation>) => void; now?: () => Date; jobId?: () => string }) {
    const engine = createChildOpsEngine({ jobId: deps.jobId });
    const now = deps.now ?? (() => NOW);
    const env: ChildOpsEnv = { readStore: deps.readStore, runner: { run: async () => { throw new Error("no SSH in observe engine tests"); } },
      knownHostsFile: "/tmp/known_hosts", wireState: () => "connected", activity: () => null, homeVersion: "2.100.0", now: () => now().getTime(),
      sleep: async () => {}, observe: deps.observe, readObservation: () => null, catalogEtag: () => null,
      writeObservation: (linkId, patch) => {
        try { deps.writeObservation(linkId, patch); } catch (error) {
          console.warn(`[link] child observation write failed linkId=${linkId} error=${error instanceof Error ? error.name : "unknown"}`);
        }
      } };
    return { ...engine, submit: (request: { op: "observe"; linkIds: readonly string[] | "all"; trigger: "manual" | "auto" }) =>
      engine.submit({ ...request, restart: "none" }, env) };
  }

  test("runs three items at a time and ends refused for a link removed before its turn", async () => {
    let links = ids.map(id => record({ id }));
    let running = 0, peak = 0;
    const releases: Array<() => void> = [];
    const engine = observeEngine({ readStore: () => store(links), now: () => NOW, writeObservation: () => {}, observe: async () => {
      running += 1; peak = Math.max(peak, running);
      await new Promise<void>(resolve => releases.push(resolve));
      running -= 1;
      return succeeded(NOW);
    } });
    const submitted = engine.submit({ op: "observe", linkIds: "all", trigger: "manual" });
    if (!submitted.ok) throw new Error("submit refused");
    expect(submitted.job.items.map(item => item.state)).toEqual(["running", "running", "running", "queued", "queued"]);
    expect(engine.activeJob(ids[4]!)).toEqual({ jobId: submitted.job.jobId, op: "observe", state: "running" });
    links = links.filter(link => link.id !== ids[4]);
    while (releases.length) { releases.shift()!(); await new Promise(resolve => setTimeout(resolve, 0)); }
    await engine.settled();
    const done = engine.job(submitted.job.jobId)!;
    expect(peak).toBe(3);
    expect(done.state).toBe("done");
    expect(done.items.map(item => [item.state, item.reason])).toEqual([["succeeded", null], ["succeeded", null], ["succeeded", null], ["succeeded", null], ["refused", "link-removed"]]);
    expect(engine.activeJob(ids[0]!)).toBeNull();
  });

  test("an ephemeral observe over a stored plan entry leaves updateInFlight null and keeps observedAt for lastOperation", async () => {
    const file = emptyChildObservations();
    const linkId = ids[0]!;
    file.children[linkId] = { observedAt: "2026-11-01T00:00:00.000Z", source: "plan", installedVersion: "2.97.0", installKind: "npm",
      runtimeOwner: "service", updateRoute: "orchestrated", updateReason: null, targetVersion: "2.100.0", catalogPulledAt: 5, lastOperation: null,
      suppressedTarget: null, catalogPulledEtag: "\"e\"", catalogSyncedEtag: null, autoUpdateAttempts: null, updateInFlight: true, pendingUpdateRecovery: null };
    let clock = NOW.getTime();
    const engine = observeEngine({ readStore: () => store([record({ id: linkId, childKind: "ephemeral" })]), now: () => new Date(clock),
      writeObservation: (id, patch) => { clock += 1_000; patchChildObservation(file, id, patch, new Date(clock)); },
      observe: async target => observeChild(target, deps(ran(plan())).value) });
    engine.submit({ op: "observe", linkIds: [linkId], trigger: "manual" });
    await engine.settled();
    expect(file.children[linkId]).toMatchObject({ updateInFlight: null, runtimeOwner: null, targetVersion: null, installKind: "ocx-child",
      catalogPulledAt: 5, observedAt: new Date(NOW.getTime() + 1_000).toISOString(), lastOperation: { op: "observe", state: "succeeded", reason: null } });
  });

  test("a failed cache write is logged and leaves the item's result", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const engine = observeEngine({ readStore: () => store([record({ id: ids[0]! })]), now: () => NOW,
        writeObservation: () => { throw new ConfigMutationLockError("busy"); }, observe: async () => succeeded(NOW) });
      const submitted = engine.submit({ op: "observe", linkIds: [ids[0]!], trigger: "manual" });
      await engine.settled();
      expect(engine.job(submitted.ok ? submitted.job.jobId : "")?.items[0]).toMatchObject({ state: "succeeded", reason: null });
      expect(warn.mock.calls.map(call => String(call[0]))).toEqual([
        `[link] child observation write failed linkId=${ids[0]} error=ConfigMutationLockError`,
        `[link] child observation write failed linkId=${ids[0]} error=ConfigMutationLockError`,
      ]);
    } finally { warn.mockRestore(); }
  });

  test("three SSH observes at a time across every job of the engine", async () => {
    const links = ids.map(id => record({ id }));
    let running = 0, peak = 0;
    const releases: Array<() => void> = [];
    const engine = observeEngine({ readStore: () => store(links), now: () => NOW, writeObservation: () => {}, observe: async () => {
      running += 1; peak = Math.max(peak, running);
      await new Promise<void>(resolve => releases.push(resolve));
      running -= 1;
      return succeeded(NOW);
    } });
    const first = engine.submit({ op: "observe", linkIds: ids.slice(0, 2), trigger: "manual" });
    const second = engine.submit({ op: "observe", linkIds: ids.slice(2, 5), trigger: "manual" });
    if (!first.ok || !second.ok) throw new Error("submit refused");
    expect(running).toBe(3);
    expect(second.job.state).toBe("running");
    expect(second.job.items.map(item => item.state)).toEqual(["running", "queued", "queued"]);
    expect(engine.activeJob(ids[4]!)).toEqual({ jobId: second.job.jobId, op: "observe", state: "running" });
    while (releases.length) { releases.shift()!(); await new Promise(resolve => setTimeout(resolve, 0)); }
    await engine.settled();
    expect(peak).toBe(3);
    expect([engine.job(first.job.jobId)!.state, engine.job(second.job.jobId)!.state]).toEqual(["done", "done"]);
  });

  test("a busy item leaves the held link's lastOperation to the job that runs it", async () => {
    const links = ids.slice(0, 2).map(id => record({ id }));
    const writes: Array<{ linkId: string; jobId: string; state: string }> = [];
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const engine = observeEngine({ readStore: () => store(links), now: () => NOW, observe: async target => {
      if (target.id === ids[0]) await held;
      return succeeded(NOW);
    }, writeObservation: (linkId, patch) => { if (patch.lastOperation) writes.push({ linkId, jobId: patch.lastOperation.jobId, state: patch.lastOperation.state }); } });
    const first = engine.submit({ op: "observe", linkIds: [ids[0]!], trigger: "manual" });
    const second = engine.submit({ op: "observe", linkIds: "all", trigger: "manual" });
    if (!first.ok || !second.ok) throw new Error("submit refused");
    expect(second.job.items[0]).toMatchObject({ linkId: ids[0], state: "busy", reason: "link-operation-in-progress" });
    await new Promise(resolve => setTimeout(resolve, 0));
    release();
    await engine.settled();
    expect(writes).toEqual([{ linkId: ids[1]!, jobId: second.job.jobId, state: "succeeded" }, { linkId: ids[0]!, jobId: first.job.jobId, state: "succeeded" }]);
  });

  test("submit refusals and retention of at most 32 finished jobs for one hour", async () => {
    let clock = NOW.getTime();
    let counter = 0;
    const engine = observeEngine({ readStore: () => store([record({ id: ids[0]! })]), now: () => new Date(clock), writeObservation: () => {},
      observe: async () => succeeded(NOW), jobId: () => "ljob_" + (counter++).toString(16).padStart(16, "0") });
    expect(engine.submit({ op: "observe", linkIds: [ids[1]!], trigger: "manual" })).toEqual({ ok: false, code: "link_not_found", linkId: ids[1]! });
    const empty = observeEngine({ readStore: () => store([]), writeObservation: () => {}, observe: async () => succeeded(NOW) });
    expect(empty.submit({ op: "observe", linkIds: "all", trigger: "manual" })).toEqual({ ok: false, code: "no_eligible_links", linkId: null });
    for (let index = 0; index < 33; index++) {
      clock += 1_000;
      expect(engine.submit({ op: "observe", linkIds: [ids[0]!], trigger: "manual" }).ok).toBe(true);
      await engine.settled();
    }
    // 33 finished jobs: the oldest is dropped on the next read.
    expect(engine.job("ljob_0000000000000000")).toBeUndefined();
    expect(engine.job("ljob_0000000000000001")).toBeDefined();
    clock += 1_000;
    engine.submit({ op: "observe", linkIds: [ids[0]!], trigger: "manual" });
    await engine.settled();
    expect(engine.job("ljob_0000000000000001")).toBeUndefined();
    expect(engine.job("ljob_0000000000000002")).toBeDefined();
    clock += 60 * 60 * 1000 + 1;
    expect(engine.job("ljob_0000000000000021")).toBeUndefined();
  });
});
