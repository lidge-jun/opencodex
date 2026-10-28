import { createCodexCliTestRoot } from "./codex-cli-fixture-root";
import { trustWindowsTempFixtureAncestry } from "./windows-temp-ancestry";
/** A3/A4 owned native fixtures. No application, npm installer, or production recovery API. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, parse } from "node:path";
import { ptr } from "bun:ffi";
import { createCodexCliWorkerLifetime } from "../../src/codex/cli-update-worker";
import { WindowsChildNative, WIN64_CHILD_ABI } from "../../src/codex/windows-cli-child-native";
import { WindowsChildPipe } from "../../src/codex/windows-cli-child-pipe";
import { cleanupUnstartedWindowsChild, startWindowsCliChildWithNative,
  type WindowsCliChild, type WindowsCliChildResult } from "../../src/codex/windows-cli-child";
import { fixturePath } from "./repo-root";

type CaseId = "A3" | "A4";
type Ids = { runNonce: string; caseId: CaseId; requestId: string; jobId: string };
type Kernel = WindowsChildNative["k"];
declare const self: Worker;
const own: {
  ids?: Ids; root?: string; gate?: string; native?: WindowsChildNative; child?: WindowsCliChild; pipe?: WindowsChildPipe;
  nativeOwnerId?: string;
  dispatchBoundaryVerified: boolean;
  realQuery?: Kernel["QueryInformationJobObject"]; realOverlapped?: Kernel["GetOverlappedResult"]; realClose?: Kernel["CloseHandle"];
  token?: { release(): void }; tokenCount: number; tokenReleases: number;
  sequence: number; stage: string; runSettled: boolean; runInFlight: boolean; recovering: boolean;
  failed: boolean; stateNonce?: string; nativeConstruction: string; nativeDisposed: boolean;
  queryFaultInstalled: boolean; syntheticQueryCalls: number; unknownResult?: Readonly<WindowsCliChildResult>;
  originalResult?: Record<string, unknown>; primaryAndDescendantObserved: boolean;
  gateWriteAttempted: boolean; gateReleased: boolean; cooperativeReleaseObserved: boolean; fixtureStartedAt?: number;
  cancellationAttempted: boolean; cancellationReturned?: boolean; cancellationError?: number;
  overlappedCompletion?: { ok: boolean; error: number; internalPending: boolean };
  pendingReadObserved: boolean; closeWhilePending: boolean; settledPipeCloses: number; buffer?: Buffer; overlapped?: Buffer;
} = { tokenCount: 0, tokenReleases: 0, sequence: 0, stage: "BEFORE_RUN", runSettled: false,
  runInFlight: false, recovering: false, failed: false, nativeConstruction: "NOT_STARTED", nativeDisposed: false,
  queryFaultInstalled: false, syntheticQueryCalls: 0, primaryAndDescendantObserved: false,
  gateWriteAttempted: false, gateReleased: false, cooperativeReleaseObserved: false,
  cancellationAttempted: false, pendingReadObserved: false, closeWhilePending: false, settledPipeCloses: 0,
  dispatchBoundaryVerified: false };
const commands = new Set<string>();
const lifetime = createCodexCliWorkerLifetime(() => { self.onmessage = null; });
class FixtureError extends Error {}
function need(value: unknown, phase: string): asserts value { if (!value) throw new FixtureError(phase); }
/** Fixture-only runtime check of the repository-owned spread copies; never writes DLL symbols. */
function verifyOwnedDispatch(n: WindowsChildNative) {
  const librarySymbols = (name: "kernel" | "advapi"): object => {
    const library: unknown = Object.getOwnPropertyDescriptor(n, name)?.value;
    need(library !== null && typeof library === "object", "LIBRARY_BOUNDARY_UNAVAILABLE");
    const symbols: unknown = Reflect.get(library, "symbols");
    need(symbols !== null && typeof symbols === "object" && !Array.isArray(symbols), "SYMBOL_BOUNDARY_UNAVAILABLE");
    return symbols;
  };
  const kernelSymbols = librarySymbols("kernel"), advapiSymbols = librarySymbols("advapi");
  need(n.k !== kernelSymbols && n.a !== advapiSymbols && !Object.is(n.k, n.a)
    && Object.getOwnPropertyDescriptor(n, "k")?.value === n.k
    && Object.getOwnPropertyDescriptor(n, "a")?.value === n.a
    && Object.getPrototypeOf(n.k) === Object.prototype && Object.getPrototypeOf(n.a) === Object.prototype,
  "DISPATCH_IS_NOT_AN_OWNED_COPY");
  for (const name of ["QueryInformationJobObject", "GetOverlappedResult", "CloseHandle"] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(n.k, name);
    need(descriptor && "value" in descriptor && descriptor.writable === true
      && typeof descriptor.value === "function" && descriptor.value === Reflect.get(kernelSymbols, name), "DISPATCH_SLOT_NOT_WRITABLE_COPY");
  }
  const tokenDescriptor = Object.getOwnPropertyDescriptor(n.a, "OpenProcessToken");
  need(tokenDescriptor && "value" in tokenDescriptor && tokenDescriptor.writable === true
    && tokenDescriptor.value === Reflect.get(advapiSymbols, "OpenProcessToken"), "ADVAPI_SLOT_NOT_OWNED_COPY");
  const original = n.k.QueryInformationJobObject;
  const probe: Kernel["QueryInformationJobObject"] = (...args: Parameters<Kernel["QueryInformationJobObject"]>) => original(...args);
  let installed = false;
  try {
    n.k.QueryInformationJobObject = probe; installed = true; // No call: verify only this copy's write boundary.
    need(n.k.QueryInformationJobObject === probe && Reflect.get(kernelSymbols, "QueryInformationJobObject") === original,
      "DISPATCH_PROBE_CHANGED_LIBRARY_SYMBOLS");
  } finally {
    if (installed) n.k.QueryInformationJobObject = original;
  }
  need(n.k.QueryInformationJobObject === original && Reflect.get(kernelSymbols, "QueryInformationJobObject") === original,
    "DISPATCH_PROBE_RESTORE_UNVERIFIED");
  own.dispatchBoundaryVerified = true;
}
function emit(type: string, fields: Record<string, unknown> = {}) {
  self.postMessage({ ...own.ids, sequence: ++own.sequence, type, ...fields });
}
async function until(check: () => boolean, phase: string, budgetMs = 5000) {
  const deadline = performance.now() + budgetMs;
  while (!check()) { if (performance.now() >= deadline) throw new FixtureError(phase); await Bun.sleep(5); }
}
/** Always queries the original handles using the saved real API, never child.observe's cache. */
function realJobObservation() {
  const n = own.native, child = own.child, query = own.realQuery;
  if (!n || !child?.process || !child.job || !query || own.nativeDisposed
    || !n.handles.has(child.process) || !n.handles.has(child.job)) return null;
  const accounting = Buffer.alloc(WIN64_CHILD_ABI.jobAccounting);
  const wait = Number(n.k.WaitForSingleObject(child.process, 0));
  const queried = Boolean(query(child.job, 1, ptr(accounting), accounting.length, null));
  if (![0, 258].includes(wait) || !queried) return null;
  return { primarySignaled: wait === 0, activeProcesses: accounting.readUInt32LE(WIN64_CHILD_ABI.activeProcesses) };
}
function realPendingRead(): boolean | null {
  if (own.ids?.caseId === "A4" && own.native && own.pipe && own.realOverlapped && !own.nativeDisposed
    && own.native.handles.has(own.pipe.handle) && own.native.handles.has(own.pipe.event)) {
    const ok = own.realOverlapped(own.pipe.handle, ptr(own.pipe.overlapped), ptr(own.pipe.count), 0);
    const error = ok ? 0 : Number(own.native.k.GetLastError());
    return !ok && error === 996 && own.pipe.overlapped.readBigUInt64LE(0) === 0x103n;
  }
  return null;
}
function state() {
  own.stateNonce = crypto.randomUUID();
  return { stateNonce: own.stateNonce, stage: own.stage, runSettled: own.runSettled, runInFlight: own.runInFlight,
    nativeOwnerId: own.nativeOwnerId, dispatchBoundaryVerified: own.dispatchBoundaryVerified,
    settledUnknown: own.unknownResult?.terminal === false && own.unknownResult.cleanupComplete === false,
    fixtureElapsedMs: own.fixtureStartedAt === undefined ? null : performance.now() - own.fixtureStartedAt,
    recovering: own.recovering, caseFailed: own.failed, nativeConstruction: own.nativeConstruction,
    nativeDisposed: own.nativeDisposed, knownNativeOwner: !!own.native,
    handles: own.native?.handles.size ?? null, borrowedBuffers: own.native?.borrowedMemory.size ?? null,
    tokenCount: own.tokenCount, tokenReleases: own.tokenReleases, job: realJobObservation(),
    queryFaultInstalled: own.queryFaultInstalled, gateWriteAttempted: own.gateWriteAttempted, gateReleased: own.gateReleased,
    pipePending: own.pipe?.pending ?? null, pipeEOF: own.pipe?.eof ?? null,
    ioNativePending: realPendingRead(), pendingReadObserved: own.pendingReadObserved,
    pipeEndsOwned: !!own.native && !!own.pipe && own.native.handles.has(own.pipe.handle)
      && own.native.handles.has(own.pipe.event) && own.native.handles.has(own.pipe.child),
    buffersStillRooted: !!own.pipe && own.buffer === own.pipe.buffer && own.overlapped === own.pipe.overlapped,
    cancellationAttempted: own.cancellationAttempted, cancellationReturned: own.cancellationReturned ?? null,
    overlappedCompletion: own.overlappedCompletion ?? null };
}
function fail(phase: string) {
  own.failed = true;
  emit("fixture-error", { phase, knownOwnership: state(), originalResult: own.originalResult });
}
function adoptPipe(pipe: WindowsChildPipe) {
  own.pipe = pipe; own.buffer = pipe.buffer; own.overlapped = pipe.overlapped;
}
async function run(ids: Ids) {
  own.ids = ids;
  need(process.platform === "win32" && process.arch === "x64", "WINDOWS_X64_REQUIRED");
  own.root = createCodexCliTestRoot("ocx-native-worker-");
  own.gate = join(own.root, "descendant-release");
  emit("started", { fixtureRoot: own.root, caseName: ids.caseId === "A3" ? "native Job unknown observation" : "overlapped cancellation settlement" });
  const token = lifetime.retain(own); own.tokenCount++;
  own.nativeOwnerId = crypto.randomUUID();
  let released = false;
  own.token = { release() { if (released) return; released = true; own.tokenCount--; own.tokenReleases++; token.release(); } };
  own.nativeConstruction = "IN_FLIGHT";
  try { own.native = new WindowsChildNative(); own.nativeConstruction = "CREATED"; }
  catch (error) { own.nativeConstruction = "UNKNOWN_FAILURE"; throw error; }
  const n = own.native;
  verifyOwnedDispatch(n); // A failed descriptor/copy contract stops before any fixture process or pipe opens.
  if (ids.caseId === "A3") {
    own.stage = "STARTING_OWNED_FIXTURE"; own.realQuery = n.k.QueryInformationJobObject;
    own.fixtureStartedAt = performance.now();
    own.child = startWindowsCliChildWithNative({ executable: process.execPath,
      args: [fixturePath("windows-cli-child.ts"), "descendant", own.gate], cwd: own.root,
      env: process.env, policy: "installer" }, n);
    adoptPipe(own.child.pipe);
    need(!own.child.setupFailure && own.child.process && own.child.job, "NATIVE_FIXTURE_SETUP_FAILED");
    await until(() => {
      const observed = realJobObservation();
      return !!observed?.primarySignaled && observed.activeProcesses > 0 && existsSync(own.gate! + ".ready");
    }, "PRIMARY_DESCENDANT_CHECKPOINT_TIMEOUT");
    own.primaryAndDescendantObserved = true;
    const beforeFault = realJobObservation();
    need(beforeFault?.primarySignaled && beforeFault.activeProcesses > 0, "DESCENDANT_ALREADY_LEFT");
    n.k.QueryInformationJobObject = (job, kind, output, length, returned) => {
      if (job === own.child!.job) { own.syntheticQueryCalls++; return 0; }
      return own.realQuery!(job, kind, output, length, returned);
    };
    own.queryFaultInstalled = true;
    const unknown = await own.child.wait();
    own.unknownResult = Object.freeze(unknown);
    need(!unknown.terminal && !unknown.cleanupComplete && own.syntheticQueryCalls > 0 && n.handles.size > 0,
      "SYNTHETIC_QUERY_DID_NOT_RETAIN_NATIVE_OWNER");
    own.stage = "UNKNOWN_JOB_RETAINED";
    own.originalResult = Object.freeze({ outcome: "EXPECTED_UNKNOWN", terminal: unknown.terminal,
      cleanupComplete: unknown.cleanupComplete, reason: unknown.reason });
    emit("native-observation", { nativeOwnerId: own.nativeOwnerId, dispatchBoundaryVerified: own.dispatchBoundaryVerified,
      faultKind: "SYNTHETIC_QUERY_RETURN_ON_REAL_JOB", primarySignaled: beforeFault.primarySignaled,
      activeProcesses: beforeFault.activeProcesses, primaryPid: own.child.pid, primaryCreationTime: own.child.creationTime,
      syntheticQueryCalls: own.syntheticQueryCalls, handles: n.handles.size, tokenCount: own.tokenCount });
  } else {
    own.stage = "OPENING_OWNED_PIPE";
    const pipe = new WindowsChildPipe(n); adoptPipe(pipe); pipe.open();
    own.realOverlapped = n.k.GetOverlappedResult; own.realClose = n.k.CloseHandle;
    // Observation only: every API result is the real native result for this exact pipe.
    n.k.GetOverlappedResult = (handle, overlapped, count, wait) => {
      const result = own.realOverlapped!(handle, overlapped, count, wait);
      if (handle === pipe.handle) {
        const error = result ? 0 : Number(n.k.GetLastError());
        own.overlappedCompletion = { ok: Boolean(result), error, internalPending: pipe.overlapped.readBigUInt64LE(0) === 0x103n };
      }
      return result;
    };
    n.k.CloseHandle = handle => {
      if ((handle === pipe.handle || handle === pipe.event) && pipe.pending) {
        own.closeWhilePending = true; throw new FixtureError("PIPE_CLOSE_BEFORE_IO_SETTLEMENT");
      }
      const result = own.realClose!(handle);
      if (result && (handle === pipe.handle || handle === pipe.event)) own.settledPipeCloses++;
      return result;
    };
    pipe.pump(() => { throw new FixtureError("UNEXPECTED_PIPE_DATA"); });
    need(pipe.pending && !pipe.eof && n.handles.has(pipe.handle) && n.handles.has(pipe.event)
      && n.handles.has(pipe.child) && pipe.overlapped.readBigUInt64LE(0) === 0x103n, "REAL_PENDING_READ_NOT_OBSERVED");
    own.pendingReadObserved = true; own.stage = "PENDING_IO_RETAINED";
    own.originalResult = Object.freeze({ outcome: "PENDING_IO", pending: true, cleanupComplete: false });
    emit("native-observation", { nativeOwnerId: own.nativeOwnerId, dispatchBoundaryVerified: own.dispatchBoundaryVerified,
      faultKind: "NONE_REAL_PENDING_OVERLAPPED_READ", pending: true,
      internalPending: true, bufferBytes: pipe.buffer.length, handles: n.handles.size, tokenCount: own.tokenCount });
  }
  emit("case-result", { result: own.originalResult });
  lifetime.finish(); // Retained exact owner is the only reason this run-once Worker stays available.
}
function restoreQuery() {
  if (own.native && own.realQuery) own.native.k.QueryInformationJobObject = own.realQuery;
  own.queryFaultInstalled = false;
}
async function recoverA3(expectedOnly: boolean) {
  const n = own.native, child = own.child;
  need(n && child && own.gate, "JOB_OWNER_NOT_AVAILABLE"); restoreQuery();
  if (!child.process) {
    need(!expectedOnly, "AUTOMATIC_UNSTARTED_CHILD_HOLD");
    need(await cleanupUnstartedWindowsChild(child), "UNSTARTED_CLEANUP_UNVERIFIED");
    own.nativeDisposed = n.dispose();
    return { primarySignaled: false, jobEmpty: false, freshWait: false, pipeEOF: child.pipe.eof, noProcessCreated: true };
  }
  const before = realJobObservation(); need(before, "REAL_JOB_QUERY_UNAVAILABLE");
  if (expectedOnly) need(!own.failed && own.unknownResult?.terminal === false && own.unknownResult.cleanupComplete === false
    && before.primarySignaled && before.activeProcesses > 0 && !own.gateWriteAttempted && own.fixtureStartedAt !== undefined
    && performance.now() - own.fixtureStartedAt < 10_000, "AUTOMATIC_JOB_STATE_CHANGED_HOLD");
  if (!own.gateWriteAttempted) {
    if (before.activeProcesses === 0) fail("DESCENDANT_EXITED_BEFORE_COOPERATIVE_RELEASE");
    else {
      own.gateWriteAttempted = true;
      writeFileSync(own.gate, "release", { flag: "wx" });
      own.gateReleased = readFileSync(own.gate, "utf8") === "release";
      // Existing descendant fixture has a 15s self-exit bound. Require margin
      // from primary creation, which precedes descendant startup, for PASS.
      own.cooperativeReleaseObserved = own.gateReleased && own.fixtureStartedAt !== undefined
        && performance.now() - own.fixtureStartedAt < 10_000;
      if (!own.cooperativeReleaseObserved) fail("COOPERATIVE_RELEASE_OUTSIDE_PROVEN_TIME_WINDOW");
    }
  } else if (!own.gateReleased && existsSync(own.gate)) {
    // Read back a possibly applied exact write; never repeat the write on an uncertain outcome.
    own.gateReleased = readFileSync(own.gate, "utf8") === "release";
  }
  await until(() => { const now = realJobObservation(); return !!now?.primarySignaled && now.activeProcesses === 0; }, "JOB_NOT_DRAINED");
  const finalNative = realJobObservation();
  need(finalNative?.primarySignaled && finalNative.activeProcesses === 0, "FRESH_TERMINAL_QUERY_MISSING");
  let realRequeries = 0;
  n.k.QueryInformationJobObject = (job, kind, output, length, returned) => {
    const result = own.realQuery!(job, kind, output, length, returned);
    if (job === child.job && result) realRequeries++;
    return result;
  };
  let settled: WindowsCliChildResult;
  try { settled = await child.wait(); } finally { restoreQuery(); }
  // Require actual successful native queries from THIS wait, not just inequality
  // with an earlier result or child.observe's cached terminal observation.
  const freshWait = settled !== own.unknownResult && settled.terminal && settled.cleanupComplete && realRequeries > 0;
  need(freshWait && child.pipe.eof && !child.pipe.pending && n.handles.size === 0 && n.borrowedMemory.size === 0,
    "JOB_PIPE_CLEANUP_UNVERIFIED");
  own.nativeDisposed = n.dispose();
  return { primarySignaled: true, jobEmpty: true, freshWait, realRequeries, pipeEOF: true, noProcessCreated: false,
    cooperativeReleaseObserved: own.cooperativeReleaseObserved, originalUnknownPreserved: own.unknownResult?.terminal === false };
}
async function recoverA4(expectedOnly: boolean) {
  const n = own.native, pipe = own.pipe;
  need(n && pipe, "PIPE_OWNER_NOT_AVAILABLE");
  need(own.buffer === pipe.buffer && own.overlapped === pipe.overlapped, "IO_BUFFER_OWNER_CHANGED");
  if (expectedOnly) need(!own.failed && own.pendingReadObserved && pipe.pending && !own.cancellationAttempted
    && n.handles.has(pipe.child) && realPendingRead() === true, "AUTOMATIC_PIPE_STATE_CHANGED_HOLD");
  if (pipe.pending && !own.cancellationAttempted) {
    own.cancellationAttempted = true; // Exact pending operation; never automatically issue another request.
    own.cancellationReturned = Boolean(n.k.CancelIoEx(pipe.handle, ptr(pipe.overlapped)));
    own.cancellationError = own.cancellationReturned ? 0 : Number(n.k.GetLastError());
    emit("cancellation-request", { returned: own.cancellationReturned, error: own.cancellationError,
      pendingAfterRequest: pipe.pending, buffersStillRooted: own.buffer === pipe.buffer && own.overlapped === pipe.overlapped });
    if (!own.cancellationReturned) {
      fail("CANCEL_REQUEST_NOT_ACCEPTED");
      if (expectedOnly) throw new FixtureError("AUTOMATIC_CANCEL_FAILURE_HOLD");
    }
  }
  if (!expectedOnly && pipe.pending && own.cancellationAttempted && own.cancellationReturned === false) pipe.closeChild();
  await until(() => { pipe.pump(() => fail("UNEXPECTED_PIPE_DATA")); return !pipe.pending; }, "IO_COMPLETION_NOT_OBSERVED");
  const completion = own.overlappedCompletion;
  const cancelled = own.cancellationReturned === true && completion?.ok === false
    && completion.error === 995 && !completion.internalPending;
  if (!cancelled) {
    fail("EXPECTED_ABORTED_IO_COMPLETION_NOT_PROVEN");
    if (expectedOnly) throw new FixtureError("AUTOMATIC_IO_COMPLETION_CHANGED_HOLD");
  }
  need(!pipe.pending && pipe.eof && own.buffer === pipe.buffer && own.overlapped === pipe.overlapped, "PIPE_NOT_SETTLED");
  // dispose sees no pending operation, so it cannot issue a second CancelIoEx request.
  await pipe.dispose();
  need(n.handles.size === 0 && n.borrowedMemory.size === 0 && own.settledPipeCloses === 2, "PIPE_DISPOSAL_UNVERIFIED");
  if (own.closeWhilePending) fail("PREMATURE_PIPE_CLOSE_WAS_BLOCKED");
  if (own.realOverlapped) n.k.GetOverlappedResult = own.realOverlapped;
  if (own.realClose) n.k.CloseHandle = own.realClose;
  own.nativeDisposed = n.dispose();
  return { childCount: 0, cancellationAccepted: own.cancellationReturned === true, abortedCompletionObserved: cancelled,
    pending: pipe.pending, pipeEOF: pipe.eof, closeWhilePending: own.closeWhilePending,
    nativePipeCloseAfterSettlement: true, buffersUnborrowedAfterSettlement: true, bufferRootsHeldThroughCompletion: true };
}
async function recover(nonce: unknown, expectedOnly = false) {
  need(own.runSettled && !own.runInFlight && !own.recovering && typeof nonce === "string" && nonce === own.stateNonce, "FRESH_STATE_REQUIRED");
  own.stateNonce = undefined; own.recovering = true;
  try {
    own.stage = "EXACT_RECOVERY";
    if (!expectedOnly && own.nativeConstruction === "CREATED" && own.native && !own.child && !own.pipe
      && own.native.handles.size === 0 && own.native.borrowedMemory.size === 0) {
      own.nativeDisposed = own.native.dispose();
      need(own.nativeDisposed && own.token, "EMPTY_NATIVE_OWNER_NOT_DISPOSED");
      own.token.release();
      emit("cleanup-receipt", { noFixtureCreated: true, handles: 0, borrowedBuffers: 0,
        tokenCount: own.tokenCount, tokenReleases: own.tokenReleases, nativeDisposed: true,
        caseFailed: true, fixtureRootRetained: true });
      lifetime.finish(); return;
    }
    const proof = own.ids!.caseId === "A3" ? await recoverA3(expectedOnly) : await recoverA4(expectedOnly);
    need(own.nativeDisposed && own.native?.handles.size === 0 && own.native.borrowedMemory.size === 0 && own.token, "OWNED_RESOURCES_NOT_DISPOSED");
    own.token.release(); need(own.tokenCount === 0 && own.tokenReleases === 1, "TOKEN_RELEASE_UNVERIFIED");
    own.stage = "CLEANUP_PROVEN";
    emit("cleanup-receipt", { ...proof, handles: 0, borrowedBuffers: 0, tokenCount: 0, tokenReleases: 1,
      nativeDisposed: true, caseFailed: own.failed, originalResult: own.originalResult, fixtureRootRetained: true });
    lifetime.finish();
  } finally { own.recovering = false; }
}
if (Bun.isMainThread === false) {
  self.onmessage = async event => {
    const input = event.data;
    try {
      if (!own.ids) {
        need(input?.type === "run" && ["A3", "A4"].includes(input.caseId)
          && [input.runNonce, input.requestId, input.jobId].every(value => typeof value === "string" && value.length >= 16), "BAD_FIRST_ENVELOPE");
        own.runInFlight = true;
        try { await run(input); } finally { own.runInFlight = false; own.runSettled = true; }
      } else {
        need(input?.runNonce === own.ids.runNonce && input.caseId === own.ids.caseId
          && input.requestId === own.ids.requestId && input.jobId === own.ids.jobId, "UNCORRELATED_COMMAND");
        need(typeof input.commandId === "string" && input.commandId.length >= 16 && !commands.has(input.commandId), "DUPLICATE_OR_MISSING_COMMAND");
        commands.add(input.commandId); emit("command-ack", { commandId: input.commandId });
        if (input.type === "inspect") emit("owned-state", state());
        else if (input.type === "probe") {
          need(own.runSettled && own.tokenCount === 1, "PROBE_NOT_RETAINED");
          emit("lifetime-probe-ack", { probeNonce: input.probeNonce, tokenCount: own.tokenCount, runSettled: true });
        } else if (input.type === "recover") await recover(input.stateNonce, input.expectedOnly === true);
        else throw new FixtureError("UNKNOWN_COMMAND");
      }
    } catch (error) { fail(error instanceof FixtureError ? error.message : "UNEXPECTED_FIXTURE_ERROR"); }
  };
}
