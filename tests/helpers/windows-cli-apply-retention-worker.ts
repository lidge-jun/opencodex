/** Private source candidate. Controlled installer + synthetic QueryInformationJobObject fault. */
import { existsSync, readFileSync, writeFileSync, openSync, closeSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { ptr } from "bun:ffi";
import { applyCodexCliUpdate, type CodexCliApplyResult } from "../../src/codex/cli-update-apply";
import { createCodexCliUpdatePlan } from "../../src/codex/cli-update-plan";
import { createCodexCliWorkerLifetime, type CodexCliUpdateWorkerRunMessage } from "../../src/codex/cli-update-worker";
import { createWorkerCommitWindow, codexCliUpdateIsCancelled } from "../../src/codex/cli-update-selection-gate";
import { openWindowsCliApplyAuthority } from "../../src/codex/cli-update-job-store-windows";
import { holdWindowsCodexCliPlanToolchain } from "../../src/codex/cli-windows-plan-provenance";
import { WindowsChildNative, WIN64_CHILD_ABI } from "../../src/codex/windows-cli-child-native";
import { startWindowsCliChildWithNative, type WindowsCliChild, type WindowsCliChildResult } from "../../src/codex/windows-cli-child";
import { flushWindowsSecretAclReapsBeforeRemoval } from "../../src/lib/windows-secret-acl";
import { fixturePath } from "./repo-root";
import { prepareRetentionFixture } from "./windows-cli-apply-retention-fixture";

type Authority = Awaited<ReturnType<typeof openWindowsCliApplyAuthority>>;
type Toolchain = NonNullable<Awaited<ReturnType<typeof holdWindowsCodexCliPlanToolchain>>>;
type Owner = { authority: Authority; staging: string; toolchain: Toolchain | null; child?: WindowsCliChild };
type Anchor = { acquisition?: object; authority?: Authority; owner?: Owner };
declare const self: Worker;
const need: (value: unknown, code: string) => asserts value = (value, code) => { if (!value) throw new Error(code); };
const lifetime = createCodexCliWorkerLifetime(() => { self.onmessage = null; });
const abort = new AbortController();
let telemetryNonce = "", ownerNonce = randomUUID(), seq = 0, stateNonce: string | undefined;
let fixture: Awaited<ReturnType<typeof prepareRetentionFixture>> | undefined;
let anchor: Anchor | undefined, adopted: Owner | undefined, toolchain: Toolchain | undefined;
let native: WindowsChildNative | undefined, child: WindowsCliChild | undefined;
let realQuery: WindowsChildNative["k"]["QueryInformationJobObject"] | undefined;
let unknownResult: WindowsCliChildResult | undefined, result: CodexCliApplyResult | undefined;
let run: CodexCliUpdateWorkerRunMessage | undefined, planId: string | undefined;
let failed = false, busy = false, ran = false, nativeSettled = false, gateAttempted = false;
let childStarted = 0, starts = 0, tokens = 0, releases = 0, queryFaults = 0, freshQueries = 0;
let token: { release(): void } | undefined;
let stopFlag: Int32Array | undefined, applySettled = false;
let originalChildWait: (() => Promise<WindowsCliChildResult>) | undefined;
type Step = "native" | "acl" | "staging" | "toolchain" | "authority" | "token";
type Phase = "pending" | "in_flight" | "done" | "unknown";
const phases: Record<Step, Phase> = { native: "pending", acl: "pending", staging: "pending", toolchain: "pending", authority: "pending", token: "pending" };
const operations: { step: Step; promise: Promise<void> }[] = []; // Never replace an earlier operation's evidence.
let gateWriteState: Phase = "pending", gateReleased = false;
let nativeWaitAttempted = false;
function automaticAllowed() {
  if (stopFlag && Atomics.load(stopFlag, 0) !== 0) failed = true;
  need(!failed, "AUTOMATIC_PROGRESSION_HELD");
}
const cleanupOrder: string[] = [], cleanupCalls = { staging: 0, toolchain: 0, authority: 0 };
const commandIds = new Set<string>();
function emit(phase: string, data: Record<string, unknown> = {}) {
  self.postMessage({ type: "fixture-telemetry", requestId: `telemetry:${telemetryNonce}`, jobId: `telemetry:${telemetryNonce}`,
    nonce: telemetryNonce, ownerNonce, sequence: ++seq, phase, hostRequestId: run?.requestId, hostJobId: run?.jobId, ...data });
}
async function until(check: () => boolean, code: string, ms = 5000) {
  const end = performance.now() + ms;
  while (!check()) { need(performance.now() < end, code); await Bun.sleep(5); }
}
function realJob() {
  need(native && child && realQuery && native.handles.has(child.process) && native.handles.has(child.job), "ORIGINAL_HANDLES_REQUIRED");
  const accounting = Buffer.alloc(WIN64_CHILD_ABI.jobAccounting);
  const wait = Number(native.k.WaitForSingleObject(child.process, 0));
  need([0, 258].includes(wait) && realQuery(child.job, 1, ptr(accounting), accounting.length, null), "NATIVE_QUERY_UNKNOWN");
  return { primarySignaled: wait === 0, active: accounting.readUInt32LE(WIN64_CHILD_ABI.activeProcesses) };
}
function owner() {
  need(adopted && anchor?.owner === adopted && anchor.authority === adopted.authority
    && anchor.acquisition && adopted.child === child && adopted.toolchain === toolchain, "APPLY_OWNER_IDENTITY_CHANGED");
  return adopted;
}
async function heldEvidence() {
  const o = owner();
  need(tokens === 1 && releases === 0 && cleanupCalls.staging + cleanupCalls.toolchain + cleanupCalls.authority === 0,
    "OWNER_ALREADY_RELEASED");
  o.authority.verifyIdentitySync(); await o.authority.verify();
  need(existsSync(o.staging) && existsSync(o.authority.lock) && toolchain, "HELD_PATHS_MISSING");
  // Owned npm fixture only: attempt open-for-write without writing any byte.
  let writable: number | undefined;
  try { writable = openSync(fixture!.npmCli, "r+"); } catch { /* exact pin must deny write access */ }
  if (writable !== undefined) { closeSync(writable); throw new Error("TOOLCHAIN_PIN_NOT_HELD"); }
  return { authorityVerified: true, stagingHeld: true, toolchainHeld: true, ownerAdopted: true,
    tokens, releases, nativeSettled, starts, cleanupCalls: { ...cleanupCalls } };
}
function instrumentOwner() {
  const value = anchor?.owner;
  need(value?.toolchain, "REAL_APPLY_OWNER_REQUIRED"); adopted = value; toolchain = value.toolchain;
  const a = adopted.authority, remove = a.removeStaging.bind(a), release = a.release.bind(a), unpin = toolchain.release.bind(toolchain);
  a.removeStaging = async () => { cleanupCalls.staging++; return remove(); };
  a.release = async () => { cleanupCalls.authority++; return release(); };
  toolchain.release = async () => { cleanupCalls.toolchain++; return unpin(); };
}
async function apply(message: CodexCliUpdateWorkerRunMessage) {
  need(fixture && planId && message.operation === "apply" && message.planId === planId && !ran, "ONE_MATCHING_APPLY_ONLY");
  ran = true; run = message;
  const gate = new Int32Array(message.gate), fence = new Int32Array(message.fence);
  try { result = await applyCodexCliUpdate(planId, { ...fixture.deps, signal: abort.signal,
    isCancelled: codexCliUpdateIsCancelled(message.fence),
    commitWindow: createWorkerCommitWindow({ gate: message.gate, fence: message.fence, owner: message.owner }),
    retainExecution(value) {
      need(!anchor, "ONE_ACQUISITION_ONLY"); anchor = value as Anchor;
      const held = lifetime.retain(value); tokens++;
      token = { release() { need(tokens === 1 && releases === 0, "TOKEN_RELEASE_ONCE"); tokens--; releases++; held.release(); } };
      return token;
    },
    startWindowsChild(invocation) {
      automaticAllowed();
      need(invocation.policy === "installer" && ++starts === 1, "NO_PACK_VERSION_OR_SECOND_CHILD");
      need(Atomics.load(gate, 0) === message.owner && Atomics.load(fence, 0) === 2, "REAL_COMMIT_CAS_REQUIRED");
      instrumentOwner(); native = new WindowsChildNative(); realQuery = native.k.QueryInformationJobObject;
      childStarted = performance.now();
      // Trusted seam substitutes ONLY the owned Bun descendant fixture for npm.
      // Allowlisted fixture env; no credential or entire process.env propagation.
      const env = { SystemRoot: process.env.SystemRoot, PATH: dirname(process.execPath),
        HOME: fixture!.root, USERPROFILE: fixture!.root, TEMP: fixture!.root, TMP: fixture!.root,
        CODEX_HOME: fixture!.configDir, OPENCODEX_HOME: fixture!.configDir };
      child = startWindowsCliChildWithNative({ executable: process.execPath,
        args: [fixturePath("windows-cli-child.ts"), "descendant", join(fixture!.root, "release")],
        cwd: fixture!.root, env, policy: "installer" }, native);
      emit("native-start", { primaryPid: child.pid, primaryCreationTime: child.creationTime,
        setupFailure: child.setupFailure, handles: native.handles.size, starts });
      const originalWait = child.wait.bind(child);
      originalChildWait = originalWait;
      child.wait = async () => {
        need(Atomics.load(gate, 0) === 0 && anchor?.owner?.child === child, "GATE_FREE_AND_OWNER_ADOPTED_BEFORE_WAIT");
        if (!unknownResult) {
          await until(() => { const j = realJob(); return j.primarySignaled && j.active > 0
            && existsSync(join(fixture!.root, "release.ready")); }, "DESCENDANT_CHECKPOINT");
          const marker = readFileSync(join(fixture!.root, "release.primary"), "utf8");
          need(marker.length < 128, "DESCENDANT_MARKER_BOUNDS");
          const descendantPid: unknown = JSON.parse(marker).pid;
          need(Number.isSafeInteger(descendantPid) && Number(descendantPid) > 0, "DESCENDANT_ID_REQUIRED");
          emit("native-checkpoint", { primaryPid: child!.pid, primaryCreationTime: child!.creationTime,
            descendantPid, ...realJob() }); // PID is a locator; original Job remains cleanup authority.
          native!.k.QueryInformationJobObject = (job, ...args) => {
            if (job === child!.job) { queryFaults++; return 0; } return realQuery!(job, ...args);
          };
          unknownResult = Object.freeze(await originalWait());
          need(!unknownResult.terminal && !unknownResult.cleanupComplete && unknownResult.reason === "job_query_failed"
            && queryFaults > 0, "EXPECTED_NATIVE_RETURN_FAILURE_REQUIRED");
          return unknownResult;
        }
        return originalWait();
      };
      return child;
    },
  }); } finally { applySettled = true; }
  need(result.outcome === "ambiguous" && result.reason === "installer_state_unknown" && result.leaseRetained
    && result.cleanupErrors.length === 0 && Object.isFrozen(result) && Object.isFrozen(result.cleanupErrors), "REAL_APPLY_RESULT_REQUIRED");
  const j = realJob(); need(j.primarySignaled && j.active > 0, "DESCENDANT_MUST_STILL_BE_ACTIVE");
  emit("retained", { ...await heldEvidence(), ...j, fault: "SYNTHETIC_QUERY_RETURN_ON_REAL_JOB", result });
  self.postMessage({ type: "done", requestId: message.requestId, jobId: message.jobId, operation: "apply", result });
  lifetime.finish(); // Retained actual apply token must keep the handler/realm available.
}
async function settleNative(manual = false) {
  need(applySettled && child && native && realQuery && originalChildWait && !nativeSettled, "NATIVE_RECOVERY_NOT_ADMITTED");
  owner(); const before = realJob();
  need(before.primarySignaled, "PRIMARY_NOT_TERMINAL");
  if (!manual) need(before.active > 0 && performance.now() - childStarted < 10000 && !gateAttempted, "COOPERATIVE_WINDOW_REQUIRED");
  native.k.QueryInformationJobObject = realQuery;
  if (before.active > 0) {
    // No replay of a successful OR uncertain write. Manual inspection may only read it back.
    if (gateAttempted) need(gateReleased, "GATE_DELIVERY_UNKNOWN_NO_RETRY");
    else {
      if (!manual) automaticAllowed(); gateAttempted = true; gateWriteState = "in_flight";
      try { writeFileSync(join(fixture!.root, "release"), "release", { flag: "wx" });
        gateReleased = readFileSync(join(fixture!.root, "release"), "utf8") === "release";
        need(gateReleased, "GATE_READBACK_UNKNOWN"); gateWriteState = "done";
      } catch (error) { gateWriteState = "unknown"; throw error; }
    }
  }
  if (!manual) need(performance.now() - childStarted < 10000, "GATE_WRITE_TOO_LATE");
  await until(() => { const j = realJob(); return j.primarySignaled && j.active === 0; }, "JOB_DRAIN_UNKNOWN");
  if (!manual) automaticAllowed();
  native.k.QueryInformationJobObject = (job, ...args) => {
    const ok = realQuery!(job, ...args); if (job === child!.job && ok) freshQueries++; return ok;
  };
  let terminal: WindowsCliChildResult;
  nativeWaitAttempted = true;
  try { terminal = await originalChildWait(); } finally { native.k.QueryInformationJobObject = realQuery; }
  need(terminal !== unknownResult && terminal.terminal && terminal.cleanupComplete && freshQueries > 0
    && child.pipe.eof && !child.pipe.pending && native.handles.size === 0 && native.borrowedMemory.size === 0
    && native.dispose(), "NATIVE_TERMINAL_CLEANUP_NOT_PROVEN");
  nativeSettled = true; cleanupOrder.push("nativeEOFHandles0");
  emit("native-terminal", { primaryPid: child.pid, primaryCreationTime: child.creationTime,
    freshQueries, handles: native.handles.size, borrowedBuffers: native.borrowedMemory.size,
    pipeEOF: child.pipe.eof, pendingIO: child.pipe.pending });
}
const order: Step[] = ["native", "acl", "staging", "toolchain", "authority", "token"];
async function cleanupStep(step: Step, manual = false) {
  if (!manual) automaticAllowed();
  need(applySettled && phases[step] === "pending" && order.slice(0, order.indexOf(step)).every(s => phases[s] === "done"), "STEP_NOT_PENDING_OR_PREDECESSOR_UNKNOWN");
  owner(); phases[step] = "in_flight"; // Consume before any side effect; never retry an unknown phase.
  const operation = (async () => {
    try {
      const o = owner();
      if (step === "native") await settleNative(manual);
      else {
        need(nativeSettled && native?.handles.size === 0 && native.borrowedMemory.size === 0 && child?.pipe.eof && !child.pipe.pending, "NATIVE_CLEANUP_FIRST");
        if (step === "acl") { await flushWindowsSecretAclReapsBeforeRemoval(o.staging); cleanupOrder.push("ACLreapflush"); }
        if (step === "staging") { await o.authority.removeStaging(); need(!existsSync(o.staging), "STAGING_REMAINS"); cleanupOrder.push("staging"); }
        if (step === "toolchain") { need(await toolchain!.release(), "TOOLCHAIN_RELEASE_UNKNOWN"); cleanupOrder.push("toolchain"); }
        if (step === "authority") { need(await o.authority.release(), "AUTHORITY_RELEASE_UNKNOWN"); cleanupOrder.push("authority"); }
        if (step === "token") {
          need(cleanupCalls.staging === 1 && cleanupCalls.toolchain === 1 && cleanupCalls.authority === 1, "CLEANUP_ONCE");
          token!.release(); cleanupOrder.push("token"); lifetime.finish();
        }
      }
      phases[step] = "done";
    } catch (error) {
      // The observations/gate can fail before the cleanup wait was ever invoked.
      // That leaves a remaining native obligation, not permission to repeat a wait.
      phases[step] = step === "native" && nativeSettled ? "done"
        : step === "native" && !nativeWaitAttempted ? "pending" : "unknown";
      throw error;
    }
  })(); operations.push({ step, promise: operation });
  await operation;
  if (step === "token") emit("clean", { cleanupOrder, tokens, releases, starts, freshQueries, handles: native!.handles.size,
    borrowedBuffers: native!.borrowedMemory.size, pipeEOF: child!.pipe.eof, nativeSettled, result,
    failed: failed || !!(stopFlag && Atomics.load(stopFlag, 0)), phases: { ...phases } });
  if (!manual) automaticAllowed(); // A late successful phase is evidence, never permission to continue after failure.
}
async function releaseResources() {
  automaticAllowed(); await heldEvidence(); automaticAllowed();
  for (const step of order.slice(1)) await cleanupStep(step);
}
function inspectState() {
  if (stopFlag && Atomics.load(stopFlag, 0)) failed = true;
  stateNonce = undefined;
  let sameOwner = false, job: ReturnType<typeof realJob> | null = null, observationError: string | null = null;
  try {
    owner(); sameOwner = true;
    if (!nativeSettled) job = realJob();
    else need(native?.handles.size === 0 && native.borrowedMemory.size === 0 && child?.pipe.eof && !child.pipe.pending, "NATIVE_PROOF_CHANGED");
    if (gateAttempted && !gateReleased && existsSync(join(fixture!.root, "release"))) {
      gateReleased = readFileSync(join(fixture!.root, "release"), "utf8") === "release";
      if (gateReleased) gateWriteState = "done"; // Readback only, not another write or native-wait retry.
    }
    if (phases.authority === "pending") adopted!.authority.verifyIdentitySync();
  } catch (error) { observationError = error instanceof Error ? error.message : "UNKNOWN"; }
  if (!busy && applySettled && sameOwner && observationError === null && !Object.values(phases).includes("in_flight")) stateNonce = randomUUID();
  return { stateNonce: stateNonce ?? null, busy, applySettled, sameOwner, observationError, job, failed,
    phases: { ...phases }, gateWriteState, gateAttempted, gateReleased, nativeSettled, tokens, releases,
    nativeWaitAttempted, seenCommands: [...commandIds],
    handles: native?.handles.size ?? null, borrowedBuffers: native?.borrowedMemory.size ?? null,
    pipeEOF: child?.pipe.eof ?? null, pendingIO: child?.pipe.pending ?? null, cleanupOrder: [...cleanupOrder] };
}
if (!Bun.isMainThread) self.onmessage = async event => {
  const m = event.data;
  let acquired = false;
  try {
    if (m?.type === "cancel" && run && m.requestId === run.requestId && m.jobId === run.jobId) { abort.abort(); return; }
    const manual = m?.type === "fixture-control" && m.manual === true;
    // Manual inspection is read-only even while an earlier operation is still pending.
    const inspecting = manual && m.action === "inspect";
    if (!inspecting) { need(!busy, "BUSY_OWNER_HOLD"); if (!manual) automaticAllowed(); busy = true; acquired = true; }
    if (m?.type === "fixture-init") {
      need(!fixture && !telemetryNonce && m.executionAuthorized === true && process.platform === "win32" && process.arch === "x64"
        && typeof m.nonce === "string" && m.nonce.length === 36 && /^[A-Z]:[\\/]ocx-actual-apply-[^\\/]+$/i.test(m.root), "EXPLICIT_FIXTURE_INIT_REQUIRED");
      need(m.stopFlag instanceof SharedArrayBuffer && m.stopFlag.byteLength === 4, "PRIVATE_FAILURE_FENCE_REQUIRED");
      telemetryNonce = m.nonce; stopFlag = new Int32Array(m.stopFlag);
      fixture = await prepareRetentionFixture(m.root);
      automaticAllowed();
      const plan = await createCodexCliUpdatePlan(fixture.deps);
      automaticAllowed();
      need(plan.applicable && plan.planId && /^[a-f0-9]{32}$/.test(plan.planId), "REAL_PLAN_NOT_APPLICABLE");
      planId = plan.planId; emit("ready", { planId });
    } else if (m?.type === "run") await apply(m);
    else {
      need(m?.type === "fixture-control" && m.nonce === telemetryNonce && m.ownerNonce === ownerNonce
        && m.hostRequestId === run?.requestId && m.hostJobId === run?.jobId && typeof m.commandId === "string"
        && !commandIds.has(m.commandId), "CONTROL_CORRELATION_REQUIRED");
      commandIds.add(m.commandId); // Delivery/operation uncertainty never permits replay.
      emit("ack", { commandId: m.commandId });
      if (inspecting) emit("inspection", { ...inspectState(), commandId: m.commandId });
      else if (manual) {
        need(m.action === "recover-step" && order.includes(m.step) && typeof m.stateNonce === "string"
          && m.stateNonce === stateNonce, "MANUAL_FRESH_STEP_REQUIRED"); stateNonce = undefined;
        await cleanupStep(m.step, true);
        emit("recovery-step", { commandId: m.commandId, step: m.step, phases: { ...phases }, failed });
      } else if (m.action === "probe") {
        need(result && tokens === 1, "RETAINED_PROBE_REQUIRED"); stateNonce = randomUUID();
        emit("probe", { ...await heldEvidence(), stateNonce, probeNonce: m.probeNonce });
      } else {
        need(m.stateNonce === stateNonce && typeof stateNonce === "string", "FRESH_STATE_REQUIRED"); stateNonce = undefined;
        if (m.action === "native-only") { await cleanupStep("native"); emit("native-clean", await heldEvidence()); }
        else if (m.action === "all") { await cleanupStep("native"); await releaseResources(); }
        else if (m.action === "release") await releaseResources();
        else throw new Error("UNKNOWN_CONTROL");
      }
    }
  } catch (error) {
    failed = true; emit("failure", { code: error instanceof Error ? error.message : "UNKNOWN", starts, tokens, releases,
      nativeSettled, gateAttempted, handles: native?.handles.size ?? null, borrowedBuffers: native?.borrowedMemory.size ?? null });
    // No automatic cleanup, token release, retry, terminate or root deletion on failure.
  } finally { if (acquired) busy = false; }
};
