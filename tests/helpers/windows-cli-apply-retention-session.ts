/** Explicitly invoked private harness. No top-level execution or bun:test teardown. */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { createCodexCliTestRoot } from "./codex-cli-fixture-root";
import { trustWindowsTempFixtureAncestry, windowsTempAncestryPreload } from "./windows-temp-ancestry";
import { hardenSecretDirAsync } from "../../src/lib/windows-secret-acl";
import { admitCodexCliUpdateJob, readCodexCliUpdateJob, runCodexCliUpdateJob } from "../../src/codex/cli-update-job";
import { runCodexCliUpdateApplyInWorker, codexCliUpdateUnjoinedWorkerCount,
  codexCliUpdateUnjoinedWorkerClosedTotal } from "../../src/codex/cli-update-job-worker";
import type { CodexCliApplyResult } from "../../src/codex/cli-update-apply";

export const ACTUAL_APPLY_SOURCE = "ea4a38ec513cc18179989833fe8290a6d1ba737d";
const OFFICIAL_BUN = "CB1D8E6564E655E49D30CEAD359750A1CBBD12F42651CAA4B62244D7BD93C244";
type Case = "close-within-grace" | "close-after-ledger-fallback";
type Frame = Record<string, unknown> & { phase: string };
type Operation = { id: number; name: string; promise: Promise<unknown>; status: "pending" | "fulfilled" | "rejected"; value?: unknown; error?: unknown };
type RecoveryStep = "native" | "acl" | "staging" | "toolchain" | "authority" | "token";
const need: (value: unknown, code: string) => asserts value = (value, code) => { if (!value) throw new Error(code); };

/** Caller owns recorder, exact process/controller, and root cleanup after exit/EOF proof.
 * Do NOT attach this to an unconditional test afterEach. On uncertainty the session stays live.
 */
export function createActualApplyRetentionSession(options: {
  executionAuthorized: true; sourceVerified: typeof ACTUAL_APPLY_SOURCE; fixtureVolumeRoot: string;
  caseId: Case; record: (event: Record<string, unknown>) => void;
}) {
  need(options.executionAuthorized === true && options.sourceVerified === ACTUAL_APPLY_SOURCE, "SOURCE_AND_EXECUTION_ADMISSION_REQUIRED");
  need(process.platform === "win32" && process.arch === "x64" && Bun.version === "1.4.4"
    && createHash("sha256").update(readFileSync(process.execPath)).digest("hex").toUpperCase() === OFFICIAL_BUN, "OFFICIAL_RUNTIME_REQUIRED");
  const temporaryRoot = realpathSync.native(options.fixtureVolumeRoot), within = relative(realpathSync.native(tmpdir()), temporaryRoot);
  need(!within.startsWith("..") && !isAbsolute(within), "OS_TEMP_ANCHOR_REQUIRED");
  need(["close-within-grace", "close-after-ledger-fallback"].includes(options.caseId), "EXACT_CASE_REQUIRED");
  const root = createCodexCliTestRoot("ocx-actual-apply-", temporaryRoot);
  const nonce = randomUUID(), configDir = join(root, "config"), began = performance.now();
  const state = { root, configDir, caseId: options.caseId, source: ACTUAL_APPLY_SOURCE,
    status: "PREPARED", failure: null as string | null, workerClosed: false, cleanupProven: false,
    commandAttempts: [] as { id: string; action: string; acknowledged: boolean }[],
    canonicalReplies: 0, starts: 0, runCalls: 0, nativeIdentity: null as Record<string, unknown> | null };
  let worker: Worker | undefined, sequence = 0, ownerNonce: string | undefined;
  let hostRequestId: string | undefined, hostJobId: string | undefined;
  let canonical: CodexCliApplyResult | undefined, hostResult: CodexCliApplyResult | undefined;
  let hostSettled = false, doneAt: number | undefined;
  const stopFlag = new SharedArrayBuffer(4), operations: Operation[] = [];
  let wakeFailure!: () => void, failureSerial = 0, manualBusy = false;
  let latestInspection: Frame | undefined;
  const failureSignal = new Promise<void>(resolve => { wakeFailure = resolve; });
  const frames: Frame[] = [];
  const keepalive = setInterval(() => {}, 1000); // Observer remains owned on uncertainty, never a kill timer.
  const record = (phase: string, data: Record<string, unknown> = {}) => options.record({ phase,
    caseId: options.caseId, elapsedMs: Math.round(performance.now() - began), ...data });
  function failure(code: string) {
    state.failure ??= code; failureSerial++; Atomics.store(new Int32Array(stopFlag), 0, 1);
    wakeFailure(); state.status = "UNRESOLVED"; record("hold", { code }); maybeFailClean();
  }
  function maybeFailClean() {
    if (state.failure && state.cleanupProven && state.workerClosed && operations.every(op => op.status !== "pending")) {
      state.status = "FAIL_CLEAN"; clearTimeout(budget); clearInterval(keepalive);
    }
  }
  const budget = setTimeout(() => failure("OBSERVATION_120S_OWNER_RETAINED"), 120000);
  function healthy() {
    // Check the monotonic deadline even if a delayed timer has not run yet.
    if (performance.now() - began >= 120000 && !state.failure) failure("OBSERVATION_120S_OWNER_RETAINED");
    need(!state.failure, state.failure ?? "UNKNOWN");
  }
  function startOperation<T>(name: string, work: () => Promise<T>): { entry: Operation; promise: Promise<T> } {
    healthy();
    let promise: Promise<T>;
    try { promise = work(); } catch (error) { promise = Promise.reject(error); }
    const entry: Operation = { id: operations.length + 1, name, promise, status: "pending" }; operations.push(entry);
    void promise.then(value => { entry.status = "fulfilled"; entry.value = value; record("operation-terminal", { id: entry.id, name, status: entry.status }); maybeFailClean(); },
      error => { entry.status = "rejected"; entry.error = error; failure(`OPERATION_REJECTED:${name}`); });
    return { entry, promise }; // Original Promise and owner survive the observation race.
  }
  async function observe<T>(op: { entry: Operation; promise: Promise<T> }): Promise<T> {
    healthy();
    const value = await Promise.race([op.promise, failureSignal.then(() => { throw new Error(state.failure ?? "OBSERVATION_HELD"); })]);
    healthy(); return value; // A late fulfilled Promise cannot restore PASS.
  }
  const perform = <T>(name: string, work: () => Promise<T>) => observe(startOperation(name, work));
  async function until(check: () => boolean) {
    while (!check()) { healthy(); await Bun.sleep(5); }
    healthy();
  }
  async function next(phase: string) {
    await until(() => frames.some(frame => frame.phase === phase));
    return frames.splice(frames.findIndex(frame => frame.phase === phase), 1)[0]!;
  }
  async function control(action: string, fields: Record<string, unknown> = {}) {
    healthy();
    need(worker && ownerNonce && hostRequestId && hostJobId && !state.failure, "CONTROL_OWNER_REQUIRED");
    const id = randomUUID(), attempt = { id, action, acknowledged: false };
    state.commandAttempts.push(attempt); record("control-attempt", { id, action });
    try { worker.postMessage({ type: "fixture-control", commandId: id, action, nonce, ownerNonce,
      hostRequestId, hostJobId, ...fields }); } catch { failure("DELIVERY_UNKNOWN_NO_RETRY"); }
    await until(() => attempt.acknowledged);
  }
  async function probe() {
    const probeNonce = randomUUID(); await control("probe", { probeNonce }); const observed = await next("probe");
    need(observed.probeNonce === probeNonce && observed.tokens === 1 && observed.releases === 0
      && observed.authorityVerified === true && observed.toolchainHeld === true && observed.stagingHeld === true
      && typeof observed.stateNonce === "string", "LIVE_OWNER_PROBE_REQUIRED");
    return observed.stateNonce;
  }
  async function manualRequest(action: "inspect" | "recover-step", fields: Record<string, unknown> = {}) {
    need(!manualBusy && worker && !state.workerClosed && ownerNonce, "MANUAL_OWNER_UNAVAILABLE");
    if (!state.failure) failure("MANUAL_INTERVENTION_NOT_A_PASS");
    manualBusy = true;
    const serial = failureSerial, deadline = performance.now() + 5000;
    const id = randomUUID(), attempt = { id, action, acknowledged: false };
    state.commandAttempts.push(attempt); // Never reuse this ID or replay an uncertain send.
    const wait = async (check: () => boolean) => {
      while (!check()) {
        need(failureSerial === serial, "NEW_FAILURE_DURING_MANUAL_OBSERVATION");
        need(performance.now() < deadline, "MANUAL_OBSERVATION_5S_OWNER_RETAINED"); await Bun.sleep(5);
      }
      need(failureSerial === serial && performance.now() < deadline, "MANUAL_OBSERVATION_HELD");
    };
    try {
      record("manual-control-attempt", { id, action, ...fields });
      try { worker.postMessage({ type: "fixture-control", manual: true, commandId: id, action,
        nonce, ownerNonce, hostRequestId, hostJobId, ...fields }); }
      catch { failure("MANUAL_DELIVERY_UNKNOWN_NO_REPLAY"); throw new Error("MANUAL_DELIVERY_UNKNOWN_NO_REPLAY"); }
      await wait(() => attempt.acknowledged);
      const phase = action === "inspect" ? "inspection" : "recovery-step";
      await wait(() => frames.some(frame => frame.phase === phase && frame.commandId === id));
      const frame = frames.splice(frames.findIndex(frame => frame.phase === phase && frame.commandId === id), 1)[0]!;
      maybeFailClean(); return frame;
    } catch (error) {
      failure(error instanceof Error ? error.message : "MANUAL_OBSERVATION_UNKNOWN"); throw error;
    } finally { manualBusy = false; }
  }
  async function manualInspect() {
    latestInspection = undefined;
    const frame = await manualRequest("inspect"); latestInspection = frame; return frame;
  }
  async function manualRecoverStep(step: RecoveryStep, inspectedNonce: string) {
    const order: RecoveryStep[] = ["native", "acl", "staging", "toolchain", "authority", "token"];
    const s = latestInspection, phases = s?.phases as Record<RecoveryStep, string> | undefined;
    need(order.includes(step) && s && s.stateNonce === inspectedNonce && typeof inspectedNonce === "string"
      && s.ownerNonce === ownerNonce && s.busy === false && s.applySettled === true && s.sameOwner === true
      && s.observationError === null && phases?.[step] === "pending"
      && order.slice(0, order.indexOf(step)).every(prior => phases[prior] === "done"), "FRESH_REMAINING_STEP_ONLY");
    // An unacknowledged mutation might still have been delivered. Inspection is
    // allowed, but never turn that uncertainty into another mutation attempt.
    need(state.commandAttempts.filter(a => !["inspect", "probe"].includes(a.action)).every(a => a.acknowledged),
      "UNACKNOWLEDGED_MUTATION_NO_REPLAY");
    latestInspection = undefined;
    return manualRequest("recover-step", { step, stateNonce: inspectedNonce });
  }
  async function runCase() {
    healthy(); need(state.runCalls++ === 0, "NO_SESSION_REPLAY"); state.status = "RUNNING";
    record("start", { root, configDir, processPid: process.pid, parentPid: process.ppid });
    const unjoinedBefore = codexCliUpdateUnjoinedWorkerCount(), closedBefore = codexCliUpdateUnjoinedWorkerClosedTotal();
    try {
      await perform("harden-root", () => hardenSecretDirAsync(root, { required: true }));
      trustWindowsTempFixtureAncestry(root); healthy(); mkdirSync(configDir);
      await perform("harden-config", () => hardenSecretDirAsync(configDir, { required: true })); healthy();
      worker = new Worker(new URL("./windows-cli-apply-retention-worker.ts", import.meta.url).href,
        { type: "module", preload: windowsTempAncestryPreload(root) });
      worker.addEventListener("error", () => failure("WORKER_ERROR_PRESERVE_OWNER"));
      worker.addEventListener("messageerror", () => failure("WORKER_MESSAGE_ERROR_PRESERVE_OWNER"));
      worker.addEventListener("close", () => {
        state.workerClosed = true; record("worker-close", { cleanupProven: state.cleanupProven });
        if (!state.cleanupProven) failure("CLOSE_WITHOUT_RESOURCE_PROOF");
        maybeFailClean();
      }, { once: true });
      worker.addEventListener("message", event => {
        try {
          const m = event.data;
          need(m && typeof m === "object" && !Array.isArray(m), "MALFORMED_FRAME");
          if (m.type === "fixture-telemetry") {
            need(m.nonce === nonce && m.requestId === `telemetry:${nonce}` && m.jobId === `telemetry:${nonce}`
              && m.sequence === ++sequence && typeof m.ownerNonce === "string", "TELEMETRY_CORRELATION");
            ownerNonce ??= m.ownerNonce; need(ownerNonce === m.ownerNonce, "OWNER_CHANGED");
            if (m.hostRequestId !== undefined) {
              hostRequestId ??= m.hostRequestId; hostJobId ??= m.hostJobId;
              need(hostRequestId === m.hostRequestId && hostJobId === m.hostJobId, "HOST_CORRELATION_CHANGED");
            }
            if (m.phase === "failure") failure(String(m.code));
            if (m.phase === "native-start") {
              need(state.nativeIdentity === null, "ONE_NATIVE_IDENTITY_ONLY");
              state.nativeIdentity = { primaryPid: m.primaryPid, primaryCreationTime: m.primaryCreationTime,
                setupFailure: m.setupFailure, starts: m.starts };
            }
            if (m.phase === "native-checkpoint") {
              need(state.nativeIdentity && state.nativeIdentity.primaryPid === m.primaryPid
                && state.nativeIdentity.primaryCreationTime === m.primaryCreationTime, "NATIVE_CHECKPOINT_IDENTITY");
              state.nativeIdentity.descendantPid = m.descendantPid;
            }
            if (m.phase === "ack") {
              const attempt = state.commandAttempts.find(item => item.id === m.commandId);
              need(attempt && !attempt.acknowledged, "UNKNOWN_OR_DUPLICATE_ACK"); attempt.acknowledged = true;
            } else frames.push(m);
            if (m.phase === "retained") {
              need(m.starts === 1 && m.ownerAdopted === true && m.primarySignaled === true && m.active > 0
                && m.fault === "SYNTHETIC_QUERY_RETURN_ON_REAL_JOB", "NATIVE_APPLY_EVIDENCE_REQUIRED"); state.starts = m.starts;
            }
            if (m.phase === "clean") {
              need(JSON.stringify(m.cleanupOrder) === JSON.stringify(["nativeEOFHandles0", "ACLreapflush", "staging", "toolchain", "authority", "token"])
                && m.tokens === 0 && m.releases === 1 && m.handles === 0 && m.borrowedBuffers === 0
                && m.pipeEOF === true && m.nativeSettled === true && m.freshQueries > 0 && m.starts === 1
                && (canonical ? JSON.stringify(m.result) === JSON.stringify(canonical) : !!state.failure)
                && m.phases && Object.values(m.phases).every(value => value === "done"), "EXACT_CLEANUP_AND_ORIGINAL_RESULT_REQUIRED");
              state.cleanupProven = true;
              if (m.failed === true && !state.failure) failure("WORKER_FAILURE_CLEANED_NOT_PASS");
              maybeFailClean();
            }
            // Controlled fixed-schema fixture frames only: no body, argv or environment.
            record("telemetry", { event: m });
          } else {
            need(m.type === "done" && m.operation === "apply" && m.requestId === hostRequestId && m.jobId === hostJobId
              && ++state.canonicalReplies === 1, "ONE_CANONICAL_DONE_ONLY");
            canonical = m.result; doneAt = performance.now();
            need(canonical?.outcome === "ambiguous" && canonical.reason === "installer_state_unknown"
              && canonical.leaseRetained === true && canonical.cleanupErrors.length === 0, "CANONICAL_APPLY_RESULT");
          }
        } catch (error) { failure(error instanceof Error ? error.message : "FRAME_ERROR"); }
      });
      healthy(); worker.postMessage({ type: "fixture-init", executionAuthorized: true, root, nonce, stopFlag });
      const ready = await next("ready"); need(typeof ready.planId === "string", "WORKER_REAL_PLAN_REQUIRED");
      const requestId = randomUUID();
      const admittedPlan = ready.planId;
      const admission = await perform("admit", () => admitCodexCliUpdateJob({ requestId, planId: admittedPlan, confirmed: true, configDir }));
      need(admission.kind === "accepted", "FRESH_ADMISSION_REQUIRED");
      let spawned = false;
      const ledgerOperation = startOperation("run-ledger", () => runCodexCliUpdateJob(admission.job.jobId, admission.generation, async () => {
        healthy(); // A late begin/admission never starts a Worker after the failure fence.
        const hostOperation = startOperation("host-dispatch", () => runCodexCliUpdateApplyInWorker(ready.planId as string,
          { jobId: admission.job.jobId, snapshot: null,
            spawnWorkerFn: () => { healthy(); need(!spawned && worker, "ONE_WORKER_DISPATCH"); spawned = true; return worker; } }));
        // The observer can time out; the ORIGINAL persistence producer must still
        // receive the actual eventual result, not a manufactured timeout outcome.
        hostResult = await hostOperation.promise;
        hostSettled = true; return hostResult;
      }, configDir));
      await next("retained"); await until(() => canonical !== undefined);
      need(!hostSettled && !state.workerClosed, "DONE_IS_NOT_TERMINAL");
      const running = await perform("read-running", () => readCodexCliUpdateJob(admission.job.jobId, configDir));
      need(running?.status === "running" && running.childState === "active_or_not_observed"
        && running.leaseState === "unknown", "REAL_RUNNING_LEDGER_REQUIRED");
      let fresh = await probe();
      if (options.caseId === "close-within-grace") {
        await control("all", { stateNonce: fresh });
      } else {
        // Keep the 15s descendant unchanged. Reap it within 10s, then retain real
        // authority/staging/toolchain/token past the DEFAULT 10s host close grace.
        await control("native-only", { stateNonce: fresh }); await next("native-clean");
        await until(() => hostSettled);
        need(!state.workerClosed && doneAt !== undefined && performance.now() - doneAt >= 10000
          && hostResult?.reason === "job_result_unknown" && hostResult.leaseRetained === true,
          "DEFAULT_GRACE_FALLBACK_REQUIRED");
        const stored = await observe(ledgerOperation);
        need(stored?.status === "ambiguous" && stored.reason === "job_result_unknown"
          && stored.childState === "unknown" && stored.leaseState === "unknown", "FALLBACK_LEDGER_REQUIRED");
        need(codexCliUpdateUnjoinedWorkerCount() === unjoinedBefore + 1, "UNJOINED_TRACKING_REQUIRED");
        const before = JSON.stringify(stored);
        fresh = await probe(); await control("release", { stateNonce: fresh });
        await next("clean"); await until(() => state.workerClosed);
        need(JSON.stringify(await perform("read-after-cleanup", () => readCodexCliUpdateJob(admission.job.jobId, configDir))) === before, "LATE_CLEANUP_MUST_NOT_REWRITE_LEDGER");
        need(codexCliUpdateUnjoinedWorkerCount() === unjoinedBefore
          && codexCliUpdateUnjoinedWorkerClosedTotal() === closedBefore + 1, "LATE_CLOSE_ACCOUNTING_REQUIRED");
      }
      if (options.caseId === "close-within-grace") { await next("clean"); await until(() => state.workerClosed && hostSettled); }
      const final = await observe(ledgerOperation);
      need(final?.outcome === "ambiguous" && final.childState === "unknown", "FINAL_AMBIGUITY_PRESERVED");
      if (options.caseId === "close-within-grace") need(hostResult && JSON.stringify(hostResult) === JSON.stringify(canonical)
        && final.reason === "installer_state_unknown" && final.leaseState === "retained", "ORIGINAL_WITHIN_GRACE_RESULT_REQUIRED");
      const duplicate = await perform("duplicate-admission", () => admitCodexCliUpdateJob({ requestId, planId: admittedPlan, confirmed: true, configDir }));
      need(duplicate.kind === "duplicate" && duplicate.job.jobId === admission.job.jobId && state.starts === 1
        && state.canonicalReplies === 1 && state.cleanupProven && state.workerClosed, "NO_REPEAT_INSTALLER");
      healthy(); need(operations.every(op => op.status !== "pending"), "OPERATIONS_STILL_OWNED");
      state.status = "PASS_SOURCE_UNIT"; clearTimeout(budget); clearInterval(keepalive);
      record("complete", { hostResult, final, cleanupProven: true, workerClosed: true, fixtureRootRetained: true });
      healthy();
      return { ...state, hostResult, final, fixtureRootRetained: true };
    } catch (error) {
      failure(error instanceof Error ? error.message : "UNKNOWN");
      maybeFailClean();
      throw error; // Unknown owner: keep observer/Worker/root. No automatic retry or terminate.
    }
  }
  return { state, run: runCase, manualInspect, manualRecoverStep, get worker() { return worker; }, operations };
}
