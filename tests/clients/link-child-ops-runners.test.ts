import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APPLY_GRACE_MS, APPLY_MUTATION_BOUND_MAX_MS, CLOCK_SKEW_HINT, LAUNCHER_HINT, POST_UPDATE_SYNC_RETRY_MS, postUpdateSyncHint, runObserveItem, syncSkipHint, runRestartCodexItem, runSyncItem, runUpdateItem,
  UNCERTAIN_RECOVERY_WINDOW_MS } from "../../src/link/child-ops-runners";
import type { ChildOpsEnv, ChildRestart, ChildTrigger, ItemRunner } from "../../src/link/child-ops-types";
import type { ChildObservation } from "../../src/link/child-observations";
import type { ObserveOutcome } from "../../src/link/child-observe";
import type { PlanClassification } from "../../src/link/child-update-contract";
import { SshRunnerError, type SshRunResult } from "../../src/link/ssh-runner";
import type { LinkRecord } from "../../src/link/store";

const LINK = "lnk_0123456789abcdef";
const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz012345_-";
const NOW = Date.parse("2026-11-11T00:00:00.000Z");
const CHILD_NOW = 1_900_000_000_000;
const posix = test.skipIf(process.platform === "win32");

type Kind = "winprobe" | "uname" | "sync" | "restart" | "plan" | "apply" | "win";
interface Call { kind: Kind; remote: string; timeoutMs: number | undefined }
type Answer = SshRunResult | Error;

const SYNCED: SshRunResult = { code: 0, stdout: "ocx-fanout:stdout-begin\nRemote Link Home catalog synchronized.\n", stderr: "ocx-fanout:selected:2.98.0\n" };
const UPDATING: SshRunResult = { code: 7, stdout: "ocx-fanout:stdout-begin\n", stderr: "ocx-fanout:selected:2.98.0\n" };
const MISMATCH: SshRunResult = { code: 5, stdout: "ocx-fanout:stdout-begin\n", stderr: "ocx-fanout:selected:2.98.0\n{\"phase\":\"child_link_mismatch\",\"reason\":\"other_link\"}\n" };
const LACKS_EXPECT_LINK: SshRunResult = { code: 121, stdout: "", stderr: "ocx-fanout:child-ocx-lacks-expect-link\n" };
const DROPPED: SshRunResult = { code: 255, stdout: "", stderr: "" };
const OCX_CHILD_SELECTED: SshRunResult = { ...SYNCED, stderr: "ocx-fanout:selected:2.98.0\nocx-fanout:selected-kind:ocx-child\n" };
const RESULT = { schema: "ocx.update.result/1", applied: true, fromVersion: "2.98.0", toVersion: "2.100.0", installer: "bun", restarted: true, healthy: true, rolledBack: false };
const applied = (code: number, result: Record<string, unknown> = RESULT): SshRunResult =>
  ({ code, stdout: "ocx-fanout:stdout-begin\n" + JSON.stringify(result) + "\n", stderr: "ocx-fanout:selected:2.98.0\nocx-fanout:entry:pair\n" });
const timeout = () => new SshRunnerError("timeout", "ssh timed out");

function classify(remote: string): Kind {
  if (remote.includes("%OS%")) return "winprobe";
  if (remote.includes("'ocx-platform'")) return "uname";
  if (remote.includes("powershell")) return "win";
  if (remote.includes("'--restart-app-server-only'") || remote.includes("'--restart-codex'")) return "restart";
  if (remote.includes("'sync'")) return "sync";
  if (remote.includes("'--plan'")) return "plan";
  if (remote.includes("'--yes'")) return "apply";
  throw new Error("unclassified remote command");
}

/** A fake SSH runner: each kind answers from its queue (the last answer repeats); every call is recorded. */
function fakeSsh(script: Partial<Record<Kind, Answer[]>> = {}) {
  const calls: Call[] = [];
  const queues = new Map(Object.entries(script).map(([kind, answers]) => [kind, [...answers!]]));
  return {
    calls, kinds: () => calls.map(call => call.kind),
    runner: { async run(argv: string[], options?: { timeoutMs?: number }) {
      const remote = argv.at(-1)!;
      const kind = classify(remote);
      calls.push({ kind, remote, timeoutMs: options?.timeoutMs });
      const queue = queues.get(kind);
      if (!queue || queue.length === 0) throw new Error("no scripted answer for " + kind);
      const answer = queue.length > 1 ? queue.shift()! : queue[0]!;
      if (answer instanceof Error) throw answer;
      return answer;
    } },
  };
}

function record(overrides: Partial<LinkRecord> = {}): LinkRecord {
  return { id: LINK, alias: "child-01", direction: "hub-initiated", hostKeyFingerprint: "SHA256:abcdefghijklmnopqrstuvwxyz012345",
    tunnelPort: 41000, apiKeyId: "key-01", createdAt: "2026-11-01T00:00:00.000Z", remotePlatform: "posix", ...overrides };
}

function plan(overrides: Partial<PlanClassification> = {}): PlanClassification {
  return { installKind: "bun", updateRoute: "orchestrated", updateReason: null, installedVersion: "2.98.0", targetVersion: "2.100.0",
    runtimeOwner: "service", planToken: TOKEN, updateInFlight: false, mutationBoundMs: 900_000, ...overrides };
}
function observedPlan(classification: PlanClassification, probe: Partial<NonNullable<ObserveOutcome["probe"]>> = {}): ObserveOutcome {
  return { state: "succeeded", reason: null, observation: null,
    probe: { classification, childNowMs: CHILD_NOW, startedAt: NOW, platform: "posix", ...probe } };
}

function makeEnv(ssh: ReturnType<typeof fakeSsh>, overrides: Partial<ChildOpsEnv> = {}) {
  const writes: Array<Partial<ChildObservation>> = [];
  const sleeps: number[] = [];
  const observes: LinkRecord[] = [];
  const env: ChildOpsEnv = {
    readStore: () => ({ version: 1, listenerPort: 18181, links: [record()] }), runner: ssh.runner, knownHostsFile: "/tmp/ocx-test-known-hosts",
    wireState: () => "connected", activity: () => ({ idle: true, inFlight: 0 }), homeVersion: "2.100.0", now: () => NOW,
    sleep: async ms => { sleeps.push(ms); }, observe: async () => { throw new Error("observe not scripted"); },
    readObservation: () => null, writeObservation: (_linkId, patch) => { writes.push(patch); }, catalogEtag: () => null, ...overrides,
  };
  const observe = overrides.observe;
  if (observe) env.observe = async target => { observes.push(target); return observe(target); };
  return { env, writes, sleeps, observes };
}
const job = (op: "sync" | "restart-codex" | "update" | "observe", restart: ChildRestart = "none", trigger: ChildTrigger = "manual") => ({ op, restart, trigger });
const run = (runner: ItemRunner, target: LinkRecord, j: ReturnType<typeof job>, env: ChildOpsEnv) => runner(target, j, env);

describe("observe runner", () => {
  test("writes the observation without carried fields; a throwing observe is failed/observe-error", async () => {
    const observation: ChildObservation = { observedAt: "2026-11-11T00:00:00.000Z", source: "plan", installedVersion: "2.98.0", installKind: "bun",
      runtimeOwner: "service", updateRoute: "orchestrated", updateReason: null, targetVersion: "2.100.0", catalogPulledAt: 1, lastOperation: null,
      suppressedTarget: null, catalogPulledEtag: null, catalogSyncedEtag: null, autoUpdateAttempts: null, updateInFlight: false, pendingUpdateRecovery: null };
    const { env, writes } = makeEnv(fakeSsh(), { observe: async () => ({ state: "succeeded", reason: null, observation, probe: null }) });
    expect(await run(runObserveItem, record(), job("observe"), env)).toEqual({ state: "succeeded", reason: null });
    expect(Object.keys(writes[0]!).sort()).toEqual(["installKind", "installedVersion", "observedAt", "runtimeOwner", "source", "targetVersion", "updateInFlight", "updateReason", "updateRoute"]);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const failing = makeEnv(fakeSsh(), { observe: async () => { throw new TypeError("x"); } });
      expect(await run(runObserveItem, record(), job("observe"), failing.env)).toEqual({ state: "failed", reason: "observe-error" });
    } finally { warn.mockRestore(); }
  });
});

describe("sync runner", () => {
  test("a plain sync sends the pinned sync once and succeeds", async () => {
    const ssh = fakeSsh({ sync: [SYNCED] });
    const { env } = makeEnv(ssh);
    expect(await run(runSyncItem, record(), job("sync"), env)).toEqual({ state: "succeeded", reason: null, sync: { state: "synced", reason: null } });
    expect(ssh.kinds()).toEqual(["sync"]);
    expect(ssh.calls[0]!.remote).toContain("'--expect-link' '" + LINK + "' '--json'");
    expect(ssh.calls[0]!.timeoutMs).toBe(180_000);
  });

  test("restart app-server: a plain sync first, then the restarting sync ending with --json --restart-app-server-only", async () => {
    const ssh = fakeSsh({ sync: [SYNCED], restart: [SYNCED] });
    const { env } = makeEnv(ssh);
    const outcome = await run(runSyncItem, record(), job("sync", "app-server"), env);
    expect(outcome).toMatchObject({ state: "succeeded", reason: null, restart: { requested: "app-server", outcome: "requested" } });
    expect(ssh.kinds()).toEqual(["sync", "restart"]);
    expect(ssh.calls[0]!.remote).not.toContain("--restart");
    expect(ssh.calls[1]!.remote.endsWith("'--json' '--restart-app-server-only'")).toBe(true);
  });

  test("codex scope sends --restart-codex", async () => {
    const ssh = fakeSsh({ sync: [SYNCED], restart: [SYNCED] });
    const { env } = makeEnv(ssh);
    await run(runSyncItem, record(), job("sync", "codex"), env);
    expect(ssh.calls[1]!.remote.endsWith("'--json' '--restart-codex'")).toBe(true);
  });

  test("the restarting sync reads the selected-kind marker; a plain sync ignores it", async () => {
    const restarting = fakeSsh({ sync: [SYNCED], restart: [OCX_CHILD_SELECTED] });
    expect(await run(runSyncItem, record(), job("sync", "app-server"), makeEnv(restarting).env))
      .toMatchObject({ state: "succeeded", restart: { requested: "app-server", outcome: "unsupported" } });
    const plain = fakeSsh({ sync: [OCX_CHILD_SELECTED] });
    expect(await run(runSyncItem, record(), job("sync"), makeEnv(plain).env)).toEqual({ state: "succeeded", reason: null, sync: { state: "synced", reason: null } });
  });

  test("Windows and ephemeral Children get no restart flag and report restart unsupported", async () => {
    const windows = fakeSsh({ win: [SYNCED] });
    expect(await run(runSyncItem, record({ remotePlatform: "windows" }), job("sync", "app-server"), makeEnv(windows).env))
      .toMatchObject({ state: "succeeded", restart: { requested: "app-server", outcome: "unsupported" } });
    expect(windows.kinds()).toEqual(["win"]);
    const ephemeral = fakeSsh({ sync: [SYNCED] });
    expect(await run(runSyncItem, record({ childKind: "ephemeral" }), job("sync", "codex"), makeEnv(ephemeral).env))
      .toMatchObject({ state: "succeeded", restart: { requested: "codex", outcome: "unsupported" } });
    expect(ephemeral.kinds()).toEqual(["sync"]);
  });

  test.each([
    ["exit 7", UPDATING, { state: "busy", reason: "child-updating", hint: "Wait for the Child update to finish, then retry sync." }],
    ["exit 5 mismatch", MISMATCH, { state: "refused", reason: "child-link-mismatch:other_link" }],
    ["exit 121 lacks expect-link", LACKS_EXPECT_LINK, { state: "owner-action", reason: "child-ocx-lacks-expect-link" }],
    ["exit 255", DROPPED, { state: "offline", reason: "ssh-failed" }],
    ["runner timeout", timeout(), { state: "uncertain", reason: "deadline-exceeded" }],
  ] as const)("%s", async (_name, answer, expected) => {
    const ssh = fakeSsh({ sync: [answer] });
    expect(await run(runSyncItem, record(), job("sync"), makeEnv(ssh).env)).toMatchObject(expected);
  });

  test("a reconnecting tunnel or a link missing from the runtime is offline with no SSH", async () => {
    const ssh = fakeSsh();
    expect(await run(runSyncItem, record(), job("sync"), makeEnv(ssh, { wireState: () => "reconnecting" }).env)).toEqual({ state: "offline", reason: "tunnel-reconnecting" });
    expect(await run(runSyncItem, record(), job("sync"), makeEnv(ssh, { wireState: () => null }).env)).toEqual({ state: "offline", reason: "link-not-in-runtime" });
    expect(ssh.calls).toEqual([]);
  });

  test("a record without remotePlatform probes the platform first", async () => {
    const ssh = fakeSsh({ winprobe: [{ code: 1, stdout: "", stderr: "" }], uname: [{ code: 0, stdout: "Linux\n", stderr: "" }], sync: [SYNCED] });
    expect(await run(runSyncItem, record({ remotePlatform: undefined }), job("sync"), makeEnv(ssh).env)).toMatchObject({ state: "succeeded" });
    expect(ssh.kinds()).toEqual(["winprobe", "uname", "sync"]);
  });

  test("a synced item records the catalog etag read before the sync", async () => {
    const etags = ["\"A\"", "\"B\""];
    const ssh = fakeSsh({ sync: [SYNCED] });
    const { env, writes } = makeEnv(ssh, { catalogEtag: () => etags.shift() ?? null });
    await run(runSyncItem, record(), job("sync"), env);
    expect(writes).toEqual([{ catalogSyncedEtag: "\"A\"" }]);
    const failed = makeEnv(fakeSsh({ sync: [DROPPED] }), { catalogEtag: () => "\"C\"" });
    await run(runSyncItem, record(), job("sync"), failed.env);
    expect(failed.writes).toEqual([]);
  });

  test("an automatic sync re-asks eligibility when its item starts", async () => {
    const ssh = fakeSsh({ sync: [SYNCED] });
    expect(await run(runSyncItem, record(), job("sync", "none", "auto"), makeEnv(ssh, { autoSyncAllowed: () => false }).env)).toEqual({ state: "busy", reason: "link-active" });
    expect(ssh.calls).toEqual([]);
    // A manual sync never asks.
    expect(await run(runSyncItem, record(), job("sync"), makeEnv(ssh, { autoSyncAllowed: () => false }).env)).toMatchObject({ state: "succeeded" });
  });
});

describe("restart guard (A2, M8)", () => {
  test("a request in flight withholds the restart, never the sync", async () => {
    const ssh = fakeSsh({ sync: [SYNCED], restart: [SYNCED] });
    expect(await run(runSyncItem, record(), job("sync", "app-server"), makeEnv(ssh, { activity: () => ({ idle: false, inFlight: 1 }) }).env))
      .toEqual({ state: "succeeded", reason: "restart-skipped:link-active", sync: { state: "synced", reason: null }, restart: { requested: "app-server", outcome: "skipped" } });
    expect(ssh.kinds()).toEqual(["sync"]);
  });

  test("unknown activity counts as in flight; an idle link gets the flag", async () => {
    const unknown = fakeSsh({ sync: [SYNCED], restart: [SYNCED] });
    expect(await run(runSyncItem, record(), job("sync", "app-server"), makeEnv(unknown, { activity: () => null }).env)).toMatchObject({ restart: { outcome: "skipped" } });
    expect(unknown.kinds()).toEqual(["sync"]);
    const idle = fakeSsh({ sync: [SYNCED], restart: [SYNCED] });
    expect(await run(runSyncItem, record(), job("sync", "app-server"), makeEnv(idle).env)).toMatchObject({ restart: { outcome: "requested" } });
    expect(idle.kinds()).toEqual(["sync", "restart"]);
  });

  test("activity is read after the plain sync: a request that starts during it withholds the restart", async () => {
    let inFlight = 0;
    const ssh = fakeSsh({ sync: [SYNCED], restart: [SYNCED] });
    const original = ssh.runner.run;
    ssh.runner.run = async (argv, options) => { const result = await original(argv, options); inFlight = 1; return result; };
    const outcome = await run(runSyncItem, record(), job("sync", "codex"), makeEnv(ssh, { activity: () => ({ idle: inFlight === 0, inFlight }) }).env);
    expect(outcome).toMatchObject({ state: "succeeded", reason: "restart-skipped:link-active", restart: { requested: "codex", outcome: "skipped" } });
    expect(ssh.kinds()).toEqual(["sync"]);
  });

  test("restart-codex on a busy link sends nothing", async () => {
    const ssh = fakeSsh({ sync: [SYNCED], restart: [SYNCED] });
    expect(await run(runRestartCodexItem, record(), job("restart-codex", "app-server"), makeEnv(ssh, { activity: () => ({ idle: false, inFlight: 2 }) }).env))
      .toEqual({ state: "busy", reason: "restart-skipped:link-active", restart: { requested: "app-server", outcome: "skipped" } });
    expect(ssh.calls).toEqual([]);
  });

  test("restart-codex: the request starting between the two calls leaves the item busy after one sync", async () => {
    let inFlight = 0;
    const ssh = fakeSsh({ sync: [SYNCED], restart: [SYNCED] });
    const original = ssh.runner.run;
    ssh.runner.run = async (argv, options) => { const result = await original(argv, options); inFlight = 1; return result; };
    expect(await run(runRestartCodexItem, record(), job("restart-codex", "app-server"), makeEnv(ssh, { activity: () => ({ idle: inFlight === 0, inFlight }) }).env))
      .toMatchObject({ state: "busy", reason: "restart-skipped:link-active", restart: { outcome: "skipped" } });
    expect(ssh.kinds()).toEqual(["sync"]);
  });
});

describe("restart result (Revision 6 F2)", () => {
  test.each([
    ["a dropped channel (255)", DROPPED],
    ["a timeout", timeout()],
    ["a failure after selection", { code: 1, stdout: "ocx-fanout:stdout-begin\n", stderr: "ocx-fanout:selected:2.98.0\n" }],
  ] as const)("%s on the restarting sync is uncertain/restart-result-unknown with restart requested", async (_name, answer) => {
    for (const runner of [runSyncItem, runRestartCodexItem]) {
      const ssh = fakeSsh({ sync: [SYNCED], restart: [answer] });
      const outcome = await run(runner, record(), job(runner === runSyncItem ? "sync" : "restart-codex", "app-server"), makeEnv(ssh).env);
      expect(outcome).toMatchObject({ state: "uncertain", reason: "restart-result-unknown", restart: { requested: "app-server", outcome: "requested" } });
    }
  });

  test.each([
    ["a gate refusal before selection (121)", { code: 121, stdout: "", stderr: "ocx-fanout:child-ocx-version-unknown\n" }],
    ["no ocx found (127)", { code: 127, stdout: "", stderr: "" }],
    ["a skipped sync (exit 7)", UPDATING],
    ["an SSH spawn failure", new SshRunnerError("spawn", "no ssh")],
  ] as const)("%s means the restart did not run", async (_name, answer) => {
    const ssh = fakeSsh({ sync: [SYNCED], restart: [answer] });
    expect(await run(runSyncItem, record(), job("sync", "app-server"), makeEnv(ssh).env))
      .toMatchObject({ state: "succeeded", reason: null, sync: { state: "synced" }, restart: { requested: "app-server", outcome: "not-run" } });
  });
});

describe("restart-codex runner", () => {
  test("a recorded Windows Child is refused with no SSH; a probed one after the probe", async () => {
    const none = fakeSsh();
    expect(await run(runRestartCodexItem, record({ remotePlatform: "windows" }), job("restart-codex", "app-server"), makeEnv(none).env))
      .toEqual({ state: "unsupported", reason: "windows-restart", restart: { requested: "app-server", outcome: "unsupported" } });
    expect(none.calls).toEqual([]);
    const probed = fakeSsh({ winprobe: [{ code: 0, stdout: "Windows_NT\r\n", stderr: "" }] });
    expect(await run(runRestartCodexItem, record({ remotePlatform: undefined }), job("restart-codex", "codex"), makeEnv(probed).env))
      .toMatchObject({ state: "unsupported", reason: "windows-restart" });
    expect(probed.kinds()).toEqual(["winprobe"]);
  });

  test("a POSIX Child gets the plain sync, then the restart; a failed sync leaves the restart not-run", async () => {
    const ssh = fakeSsh({ sync: [SYNCED], restart: [SYNCED] });
    expect(await run(runRestartCodexItem, record(), job("restart-codex", "app-server"), makeEnv(ssh).env))
      .toEqual({ state: "succeeded", reason: null, sync: { state: "synced", reason: null }, restart: { requested: "app-server", outcome: "requested" } });
    expect(ssh.kinds()).toEqual(["sync", "restart"]);
    const failed = fakeSsh({ sync: [{ code: 1, stdout: "ocx-fanout:stdout-begin\n", stderr: "ocx-fanout:selected:2.98.0\n" }] });
    expect(await run(runRestartCodexItem, record(), job("restart-codex", "app-server"), makeEnv(failed).env))
      .toMatchObject({ state: "failed", reason: "child-sync-failed", restart: { requested: "app-server", outcome: "not-run" } });
    expect(failed.kinds()).toEqual(["sync"]);
  });

  test("ocx-child: an ephemeral record syncs without the flag; an unmarked one reports unsupported from the marker", async () => {
    const ephemeral = fakeSsh({ sync: [SYNCED] });
    expect(await run(runRestartCodexItem, record({ childKind: "ephemeral" }), job("restart-codex", "app-server"), makeEnv(ephemeral).env))
      .toMatchObject({ state: "unsupported", reason: "ephemeral-restart", restart: { outcome: "unsupported" } });
    expect(ephemeral.kinds()).toEqual(["sync"]);
    const unmarked = fakeSsh({ sync: [SYNCED], restart: [OCX_CHILD_SELECTED] });
    expect(await run(runRestartCodexItem, record(), job("restart-codex", "app-server"), makeEnv(unmarked).env))
      .toMatchObject({ state: "unsupported", reason: "ephemeral-restart", restart: { outcome: "unsupported" } });
  });
});

describe("update runner", () => {
  const updateEnv = (ssh: ReturnType<typeof fakeSsh>, outcome: ObserveOutcome, overrides: Partial<ChildOpsEnv> = {}) =>
    makeEnv(ssh, { observe: async () => outcome, ...overrides });
  const ok = () => fakeSsh({ sync: [SYNCED], apply: [applied(0)] });

  test("an ephemeral record is unsupported with no SSH", async () => {
    const ssh = fakeSsh();
    expect(await run(runUpdateItem, record({ childKind: "ephemeral" }), job("update"), makeEnv(ssh).env)).toEqual({ state: "unsupported", reason: "ephemeral" });
    expect(ssh.calls).toEqual([]);
  });

  test("the identity sync runs first; a mismatch refuses before the plan and the apply", async () => {
    const ssh = fakeSsh({ sync: [MISMATCH] });
    const { env, observes } = updateEnv(ssh, observedPlan(plan()));
    expect(await run(runUpdateItem, record(), job("update"), env)).toMatchObject({ state: "refused", reason: "child-link-mismatch:other_link" });
    expect(ssh.kinds()).toEqual(["sync"]);
    expect(observes).toEqual([]);
  });

  test("an observe outcome other than a plan passes through", async () => {
    const ssh = fakeSsh({ sync: [SYNCED] });
    expect(await run(runUpdateItem, record(), job("update"), updateEnv(ssh, { state: "offline", reason: "ssh-failed", observation: null, probe: null }).env))
      .toEqual({ state: "offline", reason: "ssh-failed" });
    expect(await run(runUpdateItem, record(), job("update"), updateEnv(ssh, { state: "owner-action", reason: "legacy-ocx", observation: null, probe: null }).env))
      .toEqual({ state: "owner-action", reason: "legacy-ocx" });
    // 4529522000: an ocx-child selected without childKind observes succeeded with no probe.
    expect(await run(runUpdateItem, record(), job("update"), updateEnv(ssh, { state: "succeeded", reason: null, observation: null, probe: null }).env))
      .toEqual({ state: "unsupported", reason: "ephemeral" });
    expect(ssh.kinds()).toEqual(["sync", "sync", "sync"]);
  });

  test.each([
    ["up-to-date", plan({ updateRoute: "none", updateReason: "up-to-date", installedVersion: "2.100.0" }), { state: "up-to-date", reason: null, fromVersion: "2.100.0", toVersion: "2.100.0" }],
    ["a refused plan", plan({ updateRoute: "none", updateReason: "refused:downgrade-refused" }), { state: "refused", reason: "refused:downgrade-refused" }],
    ["GOAT", plan({ installKind: "goat", updateRoute: "owner-action", updateReason: "goat" }), { state: "owner-action", reason: "goat" }],
    ["launcher-node-missing", plan({ installKind: "npm", updateRoute: "owner-action", updateReason: "launcher-node-missing" }),
      { state: "owner-action", reason: "launcher-node-missing", hint: LAUNCHER_HINT }],
    ["desktop request", plan({ installKind: "desktop-app", updateRoute: "desktop-request", updateReason: "desktop-app-owned" }), { state: "owner-action", reason: "desktop-app" }],
    ["update in flight", plan({ updateInFlight: true }), { state: "busy", reason: "update-in-flight" }],
  ] as const)("%s sends no apply", async (_name, classification, expected) => {
    const ssh = ok();
    expect(await run(runUpdateItem, record(), job("update"), updateEnv(ssh, observedPlan(classification)).env)).toMatchObject(expected);
    expect(ssh.kinds()).toEqual(["sync"]);
  });

  test("automatic: a suppressed target is refused and a busy link waits; manual clears the suppression", async () => {
    const suppressed = { suppressedTarget: "2.100.0" } as ChildObservation;
    const auto = ok();
    expect(await run(runUpdateItem, record(), job("update", "none", "auto"), updateEnv(auto, observedPlan(plan()), { readObservation: () => suppressed }).env))
      .toMatchObject({ state: "refused", reason: "target-failed-before" });
    expect(await run(runUpdateItem, record(), job("update", "none", "auto"), updateEnv(auto, observedPlan(plan()), { activity: () => ({ idle: false, inFlight: 0 }) }).env))
      .toMatchObject({ state: "busy", reason: "link-active" });
    expect(auto.kinds()).toEqual(["sync", "sync"]);
    const manual = ok();
    const { env, writes } = updateEnv(manual, observedPlan(plan()), { readObservation: () => suppressed, activity: () => ({ idle: false, inFlight: 3 }) });
    expect(await run(runUpdateItem, record(), job("update"), env)).toMatchObject({ state: "succeeded" });
    expect(writes[0]).toEqual({ suppressedTarget: null });
    expect(manual.kinds()).toEqual(["sync", "apply", "sync"]);
  });

  test("a success: apply bounded by mutationBoundMs + 120 s, deadline on the Child's clock, then the pinned sync", async () => {
    const ssh = ok();
    const { env, writes } = updateEnv(ssh, observedPlan(plan({ mutationBoundMs: 600_000 })), { now: () => NOW + 5_000 });
    const outcome = await run(runUpdateItem, record(), job("update"), env);
    expect(outcome).toEqual({ state: "succeeded", reason: null, fromVersion: "2.98.0", toVersion: "2.100.0", sync: { state: "synced", reason: null } });
    expect(ssh.kinds()).toEqual(["sync", "apply", "sync"]);
    const apply = ssh.calls[1]!;
    expect(apply.timeoutMs).toBe(600_000 + APPLY_GRACE_MS);
    expect(apply.remote).toContain("'update' '--yes' '--json' '--version' '2.100.0' '--expect-plan' '" + TOKEN + "' '--not-after' '" + (CHILD_NOW + 120_000) + "'");
    expect(apply.remote).toContain("launcher=none");
    expect(writes.at(-1)).toMatchObject({ installedVersion: "2.100.0", targetVersion: "2.100.0", updateRoute: "none", updateReason: "up-to-date", source: "plan" });
  });

  test("A4: npm and pnpm apply through the launcher, bun does not", async () => {
    for (const [installKind, launcher] of [["npm", "launcher=apply"], ["pnpm", "launcher=apply"], ["bun", "launcher=none"]] as const) {
      const ssh = ok();
      await run(runUpdateItem, record(), job("update"), updateEnv(ssh, observedPlan(plan({ installKind }))).env);
      expect(ssh.calls[1]!.remote).toContain(launcher);
    }
  });

  test("Child clock (M9): no marker falls back to the Home clock; a late plan is not applied", async () => {
    const homeClock = ok();
    await run(runUpdateItem, record(), job("update"), updateEnv(homeClock, observedPlan(plan(), { childNowMs: null }), { now: () => NOW + 5_000 }).env);
    expect(homeClock.calls[1]!.remote).toContain("'--not-after' '" + (NOW + 120_000) + "'");
    const late = ok();
    expect(await run(runUpdateItem, record(), job("update"), updateEnv(late, observedPlan(plan()), { now: () => NOW + 110_000 }).env))
      .toMatchObject({ state: "busy", reason: "plan-expired" });
    expect(late.kinds()).toEqual(["sync"]);
  });

  test("deadline-passed carries the clock-skew hint only on the Home-clock fallback", async () => {
    const answer = applied(10, { ...RESULT, applied: false, healthy: false, restarted: false, toVersion: null, error: "deadline-passed" });
    const homeClock = fakeSsh({ sync: [SYNCED], apply: [answer] });
    expect(await run(runUpdateItem, record(), job("update"), updateEnv(homeClock, observedPlan(plan(), { childNowMs: null })).env))
      .toMatchObject({ state: "refused", reason: "deadline-passed", hint: CLOCK_SKEW_HINT });
    const childClock = fakeSsh({ sync: [SYNCED], apply: [answer] });
    const outcome = await run(runUpdateItem, record(), job("update"), updateEnv(childClock, observedPlan(plan())).env);
    expect(outcome).toMatchObject({ state: "refused", reason: "deadline-passed" });
    expect(outcome.hint).toBeUndefined();
  });

  test("the post-update sync retries once after 30 s when the Child is still updating; a failed one keeps the update", async () => {
    const retry = fakeSsh({ sync: [SYNCED, UPDATING, SYNCED], apply: [applied(0)] });
    const first = updateEnv(retry, observedPlan(plan()));
    expect(await run(runUpdateItem, record(), job("update"), first.env)).toMatchObject({ state: "succeeded", reason: null, sync: { state: "synced" } });
    expect(first.sleeps).toEqual([POST_UPDATE_SYNC_RETRY_MS]);
    expect(retry.kinds()).toEqual(["sync", "apply", "sync", "sync"]);
    const failing = fakeSsh({ sync: [SYNCED, DROPPED], apply: [applied(0)] });
    expect(await run(runUpdateItem, record(), job("update"), updateEnv(failing, observedPlan(plan())).env))
      .toMatchObject({ state: "succeeded", reason: "post-update-sync-failed", hint: postUpdateSyncHint(LINK), sync: { state: "failed", reason: "ssh-failed" } });
  });

  test.each([
    ["exit 0 not applied", applied(0, { ...RESULT, applied: false, toVersion: "2.100.0" }), { state: "up-to-date", reason: null }, ["sync", "apply"]],
    ["exit 10 update-in-flight", applied(10, { ...RESULT, applied: false, error: "update-in-flight" }), { state: "busy", reason: "update-in-flight" }, ["sync", "apply"]],
    ["exit 10 another refusal", applied(10, { ...RESULT, applied: false, error: "plan-mismatch" }), { state: "refused", reason: "plan-mismatch" }, ["sync", "apply"]],
    ["exit 12", applied(12, { ...RESULT, healthy: false }), { state: "uncertain", reason: "outcome-unverified" }, ["sync", "apply"]],
    ["exit 255 mid-apply", DROPPED, { state: "uncertain", reason: "ssh-failed" }, ["sync", "apply"]],
    ["exit 121 legacy", { code: 121, stdout: "", stderr: "ocx-fanout:child-ocx-lacks-orchestrated-update\n" }, { state: "owner-action", reason: "legacy-ocx" }, ["sync", "apply"]],
    ["exit 121 child-node-unavailable", { code: 121, stdout: "", stderr: "ocx-fanout:selected:2.98.0\nocx-fanout:entry:pair\nocx-fanout:child-node-unavailable\n" },
      { state: "owner-action", reason: "launcher-node-missing", hint: LAUNCHER_HINT }, ["sync", "apply"]],
    ["exit 127", { code: 127, stdout: "", stderr: "" }, { state: "failed", reason: "child-ocx-not-found" }, ["sync", "apply", "sync"]],
  ] as const)("%s", async (_name, answer, expected, kinds) => {
    const ssh = fakeSsh({ sync: [SYNCED], apply: [answer] });
    expect(await run(runUpdateItem, record(), job("update"), updateEnv(ssh, observedPlan(plan())).env)).toMatchObject(expected);
    expect(ssh.kinds()).toEqual([...kinds]);
  });

  test("a rolled-back apply suppresses the target and resyncs without a restart", async () => {
    const ssh = fakeSsh({ sync: [SYNCED], apply: [applied(11, { ...RESULT, healthy: false, rolledBack: true })] });
    const { env, writes } = updateEnv(ssh, observedPlan(plan()));
    expect(await run(runUpdateItem, record(), job("update", "app-server"), env))
      .toEqual({ state: "failed", reason: "rolled-back", fromVersion: "2.98.0", toVersion: "2.100.0", sync: { state: "synced", reason: null } });
    expect(writes).toContainEqual({ suppressedTarget: "2.100.0" });
    expect(ssh.kinds()).toEqual(["sync", "apply", "sync"]);
    expect(ssh.calls[2]!.remote).not.toContain("--restart");
  });

  test("uncertain applies are recorded for recovery and never applied twice", async () => {
    for (const answer of [timeout(), new SshRunnerError("output_limit", "x"), DROPPED, applied(12, { ...RESULT, healthy: false })]) {
      const ssh = fakeSsh({ sync: [SYNCED], apply: [answer] });
      const { env, writes } = updateEnv(ssh, observedPlan(plan()));
      expect((await run(runUpdateItem, record(), job("update"), env)).state).toBe("uncertain");
      expect(writes).toContainEqual({ pendingUpdateRecovery: { target: "2.100.0", since: new Date(NOW).toISOString(),
        until: new Date(NOW + UNCERTAIN_RECOVERY_WINDOW_MS).toISOString() } });
      expect(ssh.kinds().filter(kind => kind === "apply")).toHaveLength(1);
    }
  });

  test("security L1: a Child reporting a mutation bound above 900 s cannot hold the update place longer", async () => {
    const ssh = ok();
    await run(runUpdateItem, record(), job("update"), updateEnv(ssh, observedPlan(plan({ mutationBoundMs: 3_600_000 }))).env);
    expect(ssh.calls[1]!.timeoutMs).toBe(APPLY_MUTATION_BOUND_MAX_MS + APPLY_GRACE_MS);
    expect(APPLY_MUTATION_BOUND_MAX_MS + APPLY_GRACE_MS).toBe(1_020_000);
  });

  test("final L2: an SSH spawn failure on the apply sent nothing: failed, no recovery record, no resync", async () => {
    const ssh = fakeSsh({ sync: [SYNCED], apply: [new SshRunnerError("spawn", "ssh not found")] });
    const { env, writes } = updateEnv(ssh, observedPlan(plan()));
    expect(await run(runUpdateItem, record(), job("update"), env)).toEqual({ state: "failed", reason: "ssh-spawn-failed", fromVersion: "2.98.0", toVersion: "2.100.0" });
    expect(writes.some(write => "pendingUpdateRecovery" in write)).toBe(false);
    expect(ssh.kinds()).toEqual(["sync", "apply"]);
  });

  test("final L3: a succeeded update records the version the Child reports, else the Home target", async () => {
    const reported = fakeSsh({ sync: [SYNCED], apply: [applied(0, { ...RESULT, toVersion: "2.100.1" })] });
    const first = updateEnv(reported, observedPlan(plan()));
    await run(runUpdateItem, record(), job("update"), first.env);
    expect(first.writes.at(-1)).toMatchObject({ installedVersion: "2.100.1", targetVersion: "2.100.0" });
    const silent = fakeSsh({ sync: [SYNCED], apply: [applied(0, { ...RESULT, toVersion: null })] });
    const second = updateEnv(silent, observedPlan(plan()));
    await run(runUpdateItem, record(), job("update"), second.env);
    expect(second.writes.at(-1)).toMatchObject({ installedVersion: "2.100.0", targetVersion: "2.100.0" });
  });

  test("F8: an apply argv the builder refuses fails before anything is sent and records no recovery", async () => {
    const ssh = ok();
    const { env, writes } = updateEnv(ssh, observedPlan(plan({ planToken: "short" })));
    expect(await run(runUpdateItem, record(), job("update"), env)).toMatchObject({ state: "failed", reason: "ssh-argument-invalid" });
    expect(ssh.kinds()).toEqual(["sync"]);
    expect(writes.some(write => "pendingUpdateRecovery" in write)).toBe(false);
  });

  test("Windows (H4): a recorded Windows Child is observed; orchestrated is refused, desktop-request is not windows-apply", async () => {
    const orchestrated = fakeSsh({ win: [SYNCED] });
    const first = updateEnv(orchestrated, observedPlan(plan({ installKind: "npm" }), { platform: "windows" }));
    expect(await run(runUpdateItem, record({ remotePlatform: "windows" }), job("update"), first.env)).toMatchObject({ state: "unsupported", reason: "windows-apply" });
    expect(first.observes).toHaveLength(1);
    expect(orchestrated.kinds()).toEqual(["win"]);
    const desktop = fakeSsh({ win: [SYNCED] });
    expect(await run(runUpdateItem, record({ remotePlatform: "windows" }), job("update"), updateEnv(desktop,
      observedPlan(plan({ installKind: "desktop-app", updateRoute: "desktop-request", updateReason: "desktop-app-owned" }), { platform: "windows" })).env))
      .toMatchObject({ state: "owner-action", reason: "desktop-app" });
  });
});

describe("a fake 2.96 Child on the real gated script", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  posix("never receives update --yes, even when the Home believes it can apply", async () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-runner-296-")); dirs.push(home);
    const bin = join(home, "bin"); mkdirSync(bin);
    for (const command of ["sh", "uname", "mktemp", "sleep", "cat", "awk", "dd", "wc", "rm", "date"]) symlinkSync(Bun.which(command)!, join(bin, command));
    const ocx = join(home, ".opencodex-desktop", "bin", "ocx");
    mkdirSync(join(ocx, ".."), { recursive: true });
    writeFileSync(ocx, "#!/bin/sh\nif [ \"$1\" = --version ]; then echo 'opencodex 2.96.0'; exit 0; fi\nprintf '%s\\n' \"$*\" >> \"$HOME/calls\"\n"
      + "if [ \"$1\" = sync ]; then echo 'Remote Link Home catalog synchronized.'; fi\n", { mode: 0o755 });
    const runner = { async run(argv: string[]) {
      const remote = argv.at(-1)!.replace('export PATH="$PATH:$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin"', 'export PATH="$PATH"')
        .replace('"/Applications/OpenCodex.app/Contents/MacOS/ocx"', '"$HOME/missing-app"').replace('"/usr/bin/ocx"', '"$HOME/missing-system"');
      const proc = Bun.spawnSync(["sh", "-c", remote], { env: { HOME: home, OPENCODEX_HOME: join(home, "ocx-home"), TMPDIR: home, PATH: bin }, stdout: "pipe", stderr: "pipe" });
      return { code: proc.exitCode ?? -1, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
    } };
    const { env } = makeEnv(fakeSsh(), { runner, observe: async () => observedPlan(plan()) });
    const outcome = await run(runUpdateItem, record(), job("update"), env);
    expect(outcome).toMatchObject({ state: "owner-action", reason: "legacy-ocx" });
    const calls = existsSync(join(home, "calls")) ? readFileSync(join(home, "calls"), "utf8") : "";
    expect(calls).toBe("sync --expect-link " + LINK + " --json\n");
    expect(calls).not.toContain("update");
  });
});

describe("hints (final L4)", () => {
  const SKIP_REASONS = [null, "child-ocx-lacks-expect-link", "child-updating", "child-link-mismatch", "child-link-mismatch:pending_operation",
    "child-link-mismatch:disconnect_pending", "child-link-mismatch:disconnected", "child-link-mismatch:other_link", "child-link-mismatch:other_key",
    "child-ocx-version-unknown", "child-platform-unsupported", "child-sync-skipped"];

  test("every hint a runner can write fits the job document's 256-character strings", () => {
    const hints = [...SKIP_REASONS.map(reason => syncSkipHint(reason)), LAUNCHER_HINT, CLOCK_SKEW_HINT, postUpdateSyncHint("lnk_ffffffffffffffff")];
    for (const hint of hints) {
      expect(hint.length).toBeLessThanOrEqual(256);
      expect(hint.endsWith(".")).toBe(true);
    }
  });

  test("a 253-character alias never reaches a hint, so nothing is cut", async () => {
    const alias = "a".repeat(253);
    for (const answer of [UPDATING, MISMATCH, LACKS_EXPECT_LINK]) {
      const outcome = await run(runSyncItem, record({ alias }), job("sync"), makeEnv(fakeSsh({ sync: [answer] })).env);
      expect(outcome.hint).toBeDefined();
      expect(outcome.hint!.length).toBeLessThanOrEqual(256);
      expect(outcome.hint).not.toContain(alias);
    }
    const failing = fakeSsh({ sync: [SYNCED, DROPPED], apply: [applied(0)] });
    const updated = await run(runUpdateItem, record({ alias }), job("update"), makeEnv(failing, { observe: async () => observedPlan(plan()) }).env);
    expect(updated).toMatchObject({ state: "succeeded", reason: "post-update-sync-failed", hint: postUpdateSyncHint(LINK) });
  });
});


describe("automatic restart needs the idle window (050 Revision 6)", () => {
  test("idle when queued, active when its item starts: the sync runs, the restart is withheld", async () => {
    const ssh = fakeSsh({ sync: [SYNCED], restart: [SYNCED] });
    let reads = 0;
    // Nothing in flight, last data end inside the idle window at item start; idle again by the time the restart would go.
    const activity = () => (reads++ === 0 ? { idle: false, inFlight: 0 } : { idle: true, inFlight: 0 });
    expect(await run(runSyncItem, record(), job("sync", "app-server", "auto"), makeEnv(ssh, { activity }).env))
      .toEqual({ state: "succeeded", reason: "restart-skipped:link-active", sync: { state: "synced", reason: null }, restart: { requested: "app-server", outcome: "skipped" } });
    expect(ssh.kinds()).toEqual(["sync"]);
  });

  test("an automatic restart is withheld when the link stops being idle during the sync; a manual one only needs nothing in flight", async () => {
    let idle = true;
    const auto = fakeSsh({ sync: [SYNCED], restart: [SYNCED] });
    const original = auto.runner.run;
    auto.runner.run = async (argv, options) => { const result = await original(argv, options); idle = false; return result; };
    expect(await run(runSyncItem, record(), job("sync", "app-server", "auto"), makeEnv(auto, { activity: () => ({ idle, inFlight: 0 }) }).env))
      .toMatchObject({ state: "succeeded", reason: "restart-skipped:link-active", restart: { outcome: "skipped" } });
    expect(auto.kinds()).toEqual(["sync"]);
    const manual = fakeSsh({ sync: [SYNCED], restart: [SYNCED] });
    expect(await run(runSyncItem, record(), job("sync", "app-server"), makeEnv(manual, { activity: () => ({ idle: false, inFlight: 0 }) }).env))
      .toMatchObject({ state: "succeeded", reason: null, restart: { outcome: "requested" } });
    expect(manual.kinds()).toEqual(["sync", "restart"]);
    const autoIdle = fakeSsh({ sync: [SYNCED], restart: [SYNCED] });
    expect(await run(runSyncItem, record(), job("sync", "app-server", "auto"), makeEnv(autoIdle).env)).toMatchObject({ restart: { outcome: "requested" } });
    expect(autoIdle.kinds()).toEqual(["sync", "restart"]);
  });
});
