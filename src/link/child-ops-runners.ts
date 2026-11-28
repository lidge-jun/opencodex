import { buildExecArgv, LinkSshArgumentError, remotePinnedSyncArgv } from "./ssh-argv";
import { classifyUpdateApply, remoteUpdateApplyArgv } from "./child-gated-ocx";
import { requireRemotePlatform } from "./remote-platform";
import { SshRunnerError, type SshRunResult } from "./ssh-runner";
import { classifySyncResult, childSkipHint } from "./sync-fanout-classify";
import { parseStrictSemver } from "../lib/strict-semver";
import type { LinkRecord } from "./store";
import { RESTART_SKIPPED, type ChildJob, type ChildJobItem, type ChildOpsEnv, type ChildRestart, type ItemOutcome,
  type ItemRunner } from "./child-ops-types";
import { withoutCarriedFields } from "./child-observations";
import { pinnedSyncRanNothing, RESTART_RESULT_UNKNOWN, syncThenRestart } from "./sync-then-restart";

export const SYNC_TIMEOUT_MS = 180_000;
/** The --not-after window, counted on the Child's clock from the plan probe (M9). */
export const APPLY_NOT_AFTER_MS = 120_000;
/** Less than this left of the window when the apply would be sent ⇒ do not send; the next run re-plans. */
export const APPLY_MIN_REMAINING_MS = 15_000;
export const APPLY_GRACE_MS = 120_000;
/**
 * The documented bound of an orchestrated apply (ORCHESTRATED_MUTATION_BOUND_MS on the Child). A Child that reports a
 * larger mutationBoundMs (its contract allows up to an hour) cannot hold the engine's single update place longer.
 */
export const APPLY_MUTATION_BOUND_MAX_MS = 900_000;
export const POST_UPDATE_SYNC_RETRY_MS = 30_000;
/** Revision 4: how long an uncertain update stays recorded for recovery (070 imports it from here). */
export const UNCERTAIN_RECOVERY_WINDOW_MS = 3_600_000;
const iso = (ms: number): string => new Date(ms).toISOString();
type Platform = "posix" | "windows";
type SyncResult = NonNullable<ChildJobItem["sync"]>;
type RestartReport = NonNullable<ChildJobItem["restart"]>;
/** A pinned sync's verdict plus whether it certainly ran nothing on the Child (Revision 6 F2). */
interface PinnedSyncRun { sync: SyncResult; notRun: boolean }

function unreachable(record: LinkRecord, env: ChildOpsEnv): ItemOutcome | null {
  const wire = env.wireState(record.id);
  if (wire === null) return { state: "offline", reason: "link-not-in-runtime" };
  return wire === "connected" ? null : { state: "offline", reason: `tunnel-${wire}` };
}

async function platformOf(record: LinkRecord, env: ChildOpsEnv): Promise<Platform | ItemOutcome> {
  if (record.remotePlatform) return record.remotePlatform;
  try { return await requireRemotePlatform(env.runner, record.alias, record.explicitRoute ?? null, env.knownHostsFile); }
  catch (error) {
    return error instanceof SshRunnerError && error.code === "timeout"
      ? { state: "offline", reason: "ssh-timeout" } : { state: "failed", reason: "platform-probe-failed" };
  }
}

/** A2 / M8: read when the item runs, not when the job was queued. Unknown activity counts as in flight (020). */
function linkBusy(record: LinkRecord, env: ChildOpsEnv): boolean {
  return (env.activity(record.id)?.inFlight ?? 1) > 0;
}

/**
 * D8: the operator's explicit restart past activity (--ignore-activity): a manual job only, never an automatic one.
 * It overrides the activity gate alone; platform, Child kind and sync refusals still apply. Logged with counts only.
 */
function ignoresActivity(record: LinkRecord, job: Readonly<Pick<ChildJob, "trigger" | "ignoreActivity">>, env: ChildOpsEnv): boolean {
  if (job.ignoreActivity !== true || job.trigger !== "manual") return false;
  const inFlight = env.activity(record.id)?.inFlight;
  console.log(`[link] restart past activity by the operator linkId=${record.id} inFlight=${inFlight ?? "unknown"}`);
  return true;
}

/**
 * Item hints never embed the SSH alias (up to 253 characters, and already on the item as alias), so each one is a
 * bounded sentence under the job document's 256-character string limit and is never cut by the engine's cap.
 */
export const HINT_SUBJECT = "this Child";
/** A4 owner action: the npm or pnpm launcher route needs a Node the Child's SSH session can find. */
export const LAUNCHER_HINT = "Install Node.js where the npm or pnpm that installed OpenCodex on this Child can find it, or update there with ocx update.";
export const CLOCK_SKEW_HINT = "The clocks of this Home and this Child differ (clock-skew); correct the Child's clock or run the update again.";
export function syncSkipHint(reason: string | null): string {
  return childSkipHint(reason, HINT_SUBJECT);
}
/** Revision 4 (4529522006): the update stands, but routing may be gone. linkId is always lnk_ plus 16 hex. */
export function postUpdateSyncHint(linkId: string): string {
  return `The update stands, but routing may be gone; run ocx link sync --link-id ${linkId} to restore it.`;
}

async function runPinnedSync(record: LinkRecord, platform: Platform, restart: ChildRestart, env: ChildOpsEnv): Promise<PinnedSyncRun> {
  let argv: string[];
  try {
    argv = buildExecArgv({ alias: record.alias, knownHostsFile: env.knownHostsFile, route: record.explicitRoute ?? null,
      argv: remotePinnedSyncArgv(record.id, platform, restart === "none" ? {} : { restart }) });
  } catch (error) {
    if (error instanceof LinkSshArgumentError) return { sync: { state: "failed", reason: "ssh-argument-invalid" }, notRun: true };
    throw error;
  }
  // Revision 4 (4529521968): read the etag before the sync. If the catalog changes during the sync, the recorded etag
  // is the older one, so the fan-out sees the Child as behind and syncs again; it is never credited with a newer one.
  const etag = env.catalogEtag();
  let result: SshRunResult;
  try {
    result = await env.runner.run(argv, { timeoutMs: SYNC_TIMEOUT_MS });
  } catch (error) {
    // A spawn failure sent nothing; a timeout, an output limit or a decode failure may follow a run.
    return { sync: error instanceof SshRunnerError && error.code === "timeout"
      ? { state: "timed-out", reason: "deadline-exceeded" } : { state: "failed", reason: "ssh-runner-failed" },
    notRun: error instanceof SshRunnerError && error.code === "spawn" };
  }
  // wp1's classifier reads the selected-kind marker only when asked, and remotePinnedSyncArgv prints it only for a
  // restarting sync; without the option executable is never set.
  const sync: SyncResult = classifySyncResult(result, { expectSelectedKind: restart !== "none" });
  // Only a synced Home-run sync proves the Child applied the catalog; a GET of /v1/catalog proves only a fetch.
  if (sync.state === "synced" && etag !== null) env.writeObservation(record.id, { catalogSyncedEtag: etag });
  return { sync, notRun: pinnedSyncRanNothing(sync, result) };
}

/** The pinned sync --expect-link of one Child, with an optional restart flag (D13). */
export async function pinnedSync(record: LinkRecord, platform: Platform, restart: ChildRestart, env: ChildOpsEnv): Promise<SyncResult> {
  return (await runPinnedSync(record, platform, restart, env)).sync;
}

/**
 * The pinned sync with an optional restart that obeys A2: unsupported where it cannot run, withheld while busy. The
 * sequence lives in sync-then-restart.ts, shared with ocx sync --restart-children.
 */
async function syncWithRestart(record: LinkRecord, platform: Platform, requested: ChildRestart,
  env: ChildOpsEnv, idleGate?: { idleAtStart: boolean }, ignoreActivity = false): Promise<{ sync: SyncResult; restart?: RestartReport; restartUnknown?: true }> {
  const { sync, restart, restartUnknown } = await syncThenRestart({ requested, platform, childKind: record.childKind,
    runPinned: next => runPinnedSync(record, platform, next, env),
    // linkBusy's rule: unknown (null) counts as in flight. An automatic restart (050 Revision 6) also needs the idle
    // window, both when its item started and just before the restart goes out; a link short of it reads as active.
    // The operator's explicit override (manual only) reads as idle.
    readActivity: async () => {
      if (ignoreActivity) return { inFlight: 0 };
      const activity = env.activity(record.id);
      if (!idleGate || activity === null) return activity;
      return idleGate.idleAtStart && activity.idle ? activity : { inFlight: Math.max(1, activity.inFlight) };
    } });
  return { sync, ...(restart ? { restart } : {}), ...(restartUnknown ? { restartUnknown } : {}) };
}

export function syncOutcome(sync: SyncResult): ItemOutcome {
  if (sync.state === "synced") return { state: "succeeded", reason: null, sync };
  if (sync.state === "timed-out") return { state: "uncertain", reason: "deadline-exceeded", sync };
  if (sync.state === "skipped") {
    const reason = sync.reason ?? "child-sync-skipped";
    const hint = syncSkipHint(reason);
    if (reason === "child-updating") return { state: "busy", reason, hint, sync };
    if (reason === "child-ocx-lacks-expect-link") return { state: "owner-action", reason, hint, sync };
    if (reason === "child-platform-unsupported") return { state: "unsupported", reason, hint, sync };
    return { state: "refused", reason, hint, sync };          // child-link-mismatch:*, version unknown
  }
  return sync.reason === "ssh-failed" ? { state: "offline", reason: "ssh-failed", sync }
    : { state: "failed", reason: sync.reason ?? "child-sync-failed", sync };
}

/** wp2's observe dispatch as a runner: fresh fields only, so every carried field survives. */
export const runObserveItem: ItemRunner = async (record, _job, env) => {
  let outcome: Awaited<ReturnType<ChildOpsEnv["observe"]>>;
  // wp2 reports a throwing observe as failed/observe-error, not the engine's internal-error; keep that reason.
  try { outcome = await env.observe(record); } catch (error) {
    console.warn(`[link] child observe failed linkId=${record.id} error=${error instanceof Error ? error.name : "unknown"}`);
    return { state: "failed", reason: "observe-error" };
  }
  // Revision 4: every carried field (010 CARRIED_OBSERVATION_FIELDS) survives, including the three revision 4 added.
  if (outcome.observation) env.writeObservation(record.id, withoutCarriedFields(outcome.observation));
  return { state: outcome.state, reason: outcome.reason };
};

export const runSyncItem: ItemRunner = async (record, job, env) => {
  // 4529522063: the scheduler checked idle and the settings digest when it queued the job; the item may have waited
  // behind other Children since. Re-ask at item start; a no answer is busy with no SSH, retried at the next poll.
  if (job.trigger === "auto" && env.autoSyncAllowed?.(record.id) === false) return { state: "busy", reason: "link-active" };
  // 050 Revision 6: an automatic job's restart was chosen for an idle link; it stands only if the link is still idle now.
  const idleGate = job.trigger === "auto" && job.restart !== "none" ? { idleAtStart: env.activity(record.id)?.idle === true } : undefined;
  const offline = unreachable(record, env);
  if (offline) return offline;
  const platform = await platformOf(record, env);
  if (typeof platform !== "string") return platform;
  const ignore = job.restart !== "none" && ignoresActivity(record, job, env);
  const { sync, restart, restartUnknown } = await syncWithRestart(record, platform, job.restart, env, idleGate, ignore);
  if (restartUnknown) return { state: "uncertain", reason: RESTART_RESULT_UNKNOWN, sync, restart };
  const outcome = syncOutcome(sync);
  if (restart) outcome.restart = restart;
  // The sync is the job's purpose here; a withheld restart is reported, not a failure (A2).
  if (restart?.outcome === "skipped" && outcome.state === "succeeded") outcome.reason = RESTART_SKIPPED;
  return outcome;
};

export const runRestartCodexItem: ItemRunner = async (record, job, env) => {
  const requested = job.restart === "codex" ? "codex" : "app-server";
  const refused = (reason: string): ItemOutcome =>
    ({ state: "unsupported", reason, restart: { requested, outcome: "unsupported" } });
  if (record.remotePlatform === "windows") return refused("windows-restart");   // D20, no SSH at all
  const offline = unreachable(record, env);
  if (offline) return offline;
  const platform = await platformOf(record, env);
  if (typeof platform !== "string") return platform;
  if (platform === "windows") return refused("windows-restart");
  if (record.childKind === "ephemeral") {
    // ocx-child accepts and ignores the restart flags (F2): sync without them, report unsupported.
    const sync = await pinnedSync(record, platform, "none", env);
    const outcome = syncOutcome(sync);
    return outcome.state === "succeeded" ? { ...refused("ephemeral-restart"), sync } : { ...outcome, restart: { requested, outcome: "not-run" } };
  }
  // A2 / M8: the restart is the purpose of this op, so a busy link runs nothing (no SSH) and reports partial (exit 6).
  const ignore = ignoresActivity(record, job, env);
  if (!ignore && linkBusy(record, env)) return { state: "busy", reason: RESTART_SKIPPED, restart: { requested, outcome: "skipped" } };
  // Revision 4: same two-step path as sync with a restart, so activity is read again just before the restart goes out.
  const { sync, restart, restartUnknown } = await syncWithRestart(record, platform, requested, env, undefined, ignore);
  if (restartUnknown) return { state: "uncertain", reason: RESTART_RESULT_UNKNOWN, sync, restart };
  if (restart!.outcome === "unsupported") return syncOutcome(sync).state === "succeeded"
    ? { ...refused("ephemeral-restart"), sync } : { ...syncOutcome(sync), restart: { requested, outcome: "not-run" } };
  if (restart!.outcome === "skipped") return { state: "busy", reason: RESTART_SKIPPED, sync, restart };
  return { ...syncOutcome(sync), restart };
};

export const runUpdateItem: ItemRunner = async (record, job, env) => {
  if (record.childKind === "ephemeral") return { state: "unsupported", reason: "ephemeral" };     // D10
  const offline = unreachable(record, env);
  if (offline) return offline;
  // Revision 4 (4529521925): bind the Child's identity before anything can mutate it. The pinned sync is the Child's own
  // check (sync --expect-link, under its lifecycle lock): a Child that disconnected or linked to another Home answers
  // child-link-mismatch:* and nothing below runs. It precedes the plan probe, so the probe's 120 s window is not spent
  // on it; the gap left before apply is the probe itself (at most 60 s).
  const identityPlatform = await platformOf(record, env);
  if (typeof identityPlatform !== "string") return identityPlatform;
  const identity = await pinnedSync(record, identityPlatform, "none", env);
  if (identity.state !== "synced") return syncOutcome(identity);
  // D3: a fresh plan every time. Windows Children are observed too: desktop-request is the one route they can take (H4, A5).
  const observed = await env.observe(record);
  if (observed.observation) env.writeObservation(record.id, withoutCarriedFields(observed.observation));
  const probe = observed.probe;
  // 4529522000: observe ends "succeeded" with probe null for a record without childKind whose Child runs ocx-child.
  // Nothing was updated, so this is unsupported, never a success.
  if (observed.state === "succeeded" && probe === null) return { state: "unsupported", reason: "ephemeral" };
  if (observed.state !== "succeeded" || probe === null) return { state: observed.state, reason: observed.reason };
  const plan = probe.classification;
  const target = env.homeVersion;
  const versions = { ...(plan.installedVersion ? { fromVersion: plan.installedVersion } : {}), toVersion: target };
  if (plan.updateRoute === "none") return plan.updateReason === "up-to-date"
    ? { state: "up-to-date", reason: null, ...(plan.installedVersion ? { fromVersion: plan.installedVersion, toVersion: plan.installedVersion } : {}) }
    : { state: "refused", reason: plan.updateReason ?? "plan-unavailable", ...versions };
  if (plan.updateRoute === "owner-action" || plan.updateRoute === "replant") return { state: "owner-action", reason: plan.updateReason,
    ...(plan.updateReason === "launcher-node-missing" ? { hint: LAUNCHER_HINT } : {}), ...versions };
  if (plan.updateInFlight) return { state: "busy", reason: "update-in-flight", ...versions };
  const suppressed = env.readObservation(record.id)?.suppressedTarget ?? null;
  if (job.trigger === "auto") {
    if (suppressed === target) return { state: "refused", reason: "target-failed-before", ...versions };
    if (env.activity(record.id)?.idle !== true) return { state: "busy", reason: "link-active", ...versions };
  } else if (suppressed !== null) {
    env.writeObservation(record.id, { suppressedTarget: null });    // a manual update clears it (D12 step 2)
  }
  // H4: the Desktop branch precedes the Windows refusal. 080 replaces this line with the Desktop request runner.
  if (plan.updateRoute === "desktop-request") return { state: "owner-action", reason: "desktop-app", ...versions };
  if (probe.platform === "windows") return { state: "unsupported", reason: "windows-apply", ...versions }; // D20
  // updateRoute === "orchestrated" on POSIX.
  // M9: --not-after is evaluated on the Child's clock. childNowMs was printed at the start of the plan probe, so the
  // window counts from the plan; what is left of it is the window minus the Home's own elapsed time since the probe.
  // Defensive (audit r2 R3): the 60 s probe bound and no queueing between observe and apply make it unreachable today.
  const remaining = APPLY_NOT_AFTER_MS - (env.now() - probe.startedAt);
  if (remaining < APPLY_MIN_REMAINING_MS) return { state: "busy", reason: "plan-expired", ...versions };
  const homeClock = probe.childNowMs === null;       // marker missing (should not happen): fall back to the Home clock
  const notAfter = homeClock ? env.now() + remaining : probe.childNowMs! + APPLY_NOT_AFTER_MS;
  const viaLauncher = plan.installKind === "npm" || plan.installKind === "pnpm";      // A4 (H2): apply only, npm/pnpm only
  // F8: built before anything is sent, so a builder refusal is a plain failure with no recovery record.
  let argv: string[];
  try {
    if (plan.planToken === null) throw new LinkSshArgumentError("invalid plan token");
    argv = buildExecArgv({ alias: record.alias, knownHostsFile: env.knownHostsFile, route: record.explicitRoute ?? null,
      argv: remoteUpdateApplyArgv({ homeVersion: target, planToken: plan.planToken, notAfter, viaLauncher }, "posix") });
  } catch (error) {
    if (error instanceof LinkSshArgumentError) return { state: "failed", reason: "ssh-argument-invalid", ...versions };
    throw error;
  }
  let result: SshRunResult;
  try {
    result = await env.runner.run(argv, { timeoutMs: Math.min(plan.mutationBoundMs, APPLY_MUTATION_BOUND_MAX_MS) + APPLY_GRACE_MS });
  } catch (error) {
    // A spawn failure sent nothing to the Child (as for the sync path), so there is nothing to recover.
    if (error instanceof SshRunnerError && error.code === "spawn") return { state: "failed", reason: "ssh-spawn-failed", ...versions };
    // The Child's update keeps running or has finished; only a re-observe can tell (R2 hazard 4).
    // Revision 4 (4529522112, 4529521944): recorded apart from lastOperation, which the next observe replaces; 070
    // re-observes it, never re-applies, and resyncs once the Child reports no update in flight.
    env.writeObservation(record.id, { pendingUpdateRecovery: { target, since: iso(env.now()),
      until: iso(env.now() + UNCERTAIN_RECOVERY_WINDOW_MS) } });
    return { state: "uncertain", reason: error instanceof SshRunnerError && error.code === "timeout"
      ? "deadline-exceeded" : "ssh-runner-failed", ...versions };
  }
  const verdict = classifyUpdateApply(result);
  if (verdict.suppressTarget) env.writeObservation(record.id, { suppressedTarget: target });
  const verdictVersions = { ...versions, ...(verdict.fromVersion ? { fromVersion: verdict.fromVersion } : {}),
    ...(verdict.toVersion ? { toVersion: verdict.toVersion } : {}) };
  if (verdict.state === "refused" && verdict.reason === "deadline-passed") return { state: "refused", reason: "deadline-passed",
    ...(homeClock ? { hint: CLOCK_SKEW_HINT } : {}),
    ...verdictVersions };
  if (verdict.state === "up-to-date") return { state: "up-to-date", reason: null, ...verdictVersions };
  if (verdict.state === "owner-action" && verdict.reason === "launcher-node-missing") {
    return { state: "owner-action", reason: verdict.reason, hint: LAUNCHER_HINT, ...verdictVersions };
  }
  if (verdict.state === "uncertain") env.writeObservation(record.id, { pendingUpdateRecovery: { target,
    since: iso(env.now()), until: iso(env.now() + UNCERTAIN_RECOVERY_WINDOW_MS) } });
  // 4529521944: a failed or rolled-back apply may already have stopped the proxy unsupervised, which removes routing.
  // Resync without a restart; the verdict (and any suppressedTarget written above) stands, the sync is reported beside it.
  if (verdict.state === "failed") return { state: "failed", reason: verdict.reason, ...verdictVersions,
    sync: await pinnedSync(record, "posix", "none", env) };
  if (verdict.state !== "succeeded") return { state: verdict.state, reason: verdict.reason, ...verdictVersions };
  // Always resync: an unsupervised stop removed routing and start alone does not reapply it. The restart obeys A2.
  let { sync, restart, restartUnknown } = await syncWithRestart(record, "posix", job.restart, env);
  if (sync.state === "skipped" && sync.reason === "child-updating") {
    await env.sleep(POST_UPDATE_SYNC_RETRY_MS);
    ({ sync, restart, restartUnknown } = await syncWithRestart(record, "posix", job.restart, env));
  }
  // The Child's own result names the version it now runs; the Home target stands in when that is not a strict version.
  const installed = verdict.toVersion && verdict.toVersion.length <= 128 && parseStrictSemver(verdict.toVersion) ? verdict.toVersion : target;
  env.writeObservation(record.id, { installedVersion: installed, targetVersion: target, updateRoute: "none",
    updateReason: "up-to-date", observedAt: iso(env.now()), source: "plan" });
  const extra = { ...verdictVersions, sync, ...(restart ? { restart } : {}) };
  // The update stands in every branch below; only what follows it is reported.
  if (restartUnknown) return { state: "succeeded", reason: RESTART_RESULT_UNKNOWN, ...extra };
  return sync.state === "synced"
    ? { state: "succeeded", reason: restart?.outcome === "skipped" ? RESTART_SKIPPED : null, ...extra }
    // Revision 4 (4529522006): the update stands, but routing may be gone; the CLI exits 6 for this reason (Section 3).
    : { state: "succeeded", reason: "post-update-sync-failed",
      hint: postUpdateSyncHint(record.id), ...extra };
};
