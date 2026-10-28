import { createCodexCliTestRoot } from "./codex-cli-fixture-root";
import { trustWindowsTempFixtureAncestry } from "./windows-temp-ancestry";
/** Private A1/A2 driver. No installer, provider or production request DTO seam. */
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { dlopen, ptr } from "bun:ffi";
import type { Library } from "bun:ffi";
import { applyCodexCliUpdate } from "../../src/codex/cli-update-apply";
import type { CodexCliApplyResult } from "../../src/codex/cli-update-apply";
import { createCodexCliUpdatePlan } from "../../src/codex/cli-update-plan";
import { createCodexCliWorkerLifetime } from "../../src/codex/cli-update-worker";
import type { WindowsApplyAcquisition, WindowsApplyAuthorityPins } from "../../src/codex/cli-update-job-store-windows";
import { hardenSecretDirAsync } from "../../src/lib/windows-secret-acl";
import { fixtureArtifact, fixtureTar } from "./codex-cli-apply-artifact";
import { fixturePath } from "./repo-root";
import { readFileSync } from "node:fs";

export const NATIVE_ACQUISITION_CASES = {
  A1: "authority acquisition rejection retains a real protected pin and Worker until exact recovery",
  A2: "authority acquisition rejection with real successful pin disposal releases token and joins Worker",
} as const;
type Ids = { runNonce: string; caseId: "A1" | "A2"; requestId: string; jobId: string };
const FLAGS = {
  SetHandleInformation: { args: ["u64", "u32", "u32"], returns: "i32" },
  GetHandleInformation: { args: ["u64", "ptr"], returns: "i32" },
  GetLastError: { args: [], returns: "u32" },
} as const;
type Pins = WindowsApplyAuthorityPins;
type Kernel = Parameters<Pins["release"]>[1];
type Context = { pins: Pins; kernel: Kernel };
declare const self: Worker;

// Every resource is rooted here before checking or reporting any observation.
const owned: {
  ids?: Ids; root?: string; prefix?: string; handle?: bigint; acquisition?: WindowsApplyAcquisition;
  context?: Context; flags?: Library<typeof FLAGS>; keep?: Pins["keep"]; release?: Pins["release"];
  token?: { release(): void }; tokenCount: number; releaseCount: number;
  closeAttempts: number; closeResult?: boolean; closeError?: number; protected?: boolean;
  protectionVerified?: boolean;
  stage: string; runSettled: boolean; runInFlight: boolean; caseFailed: boolean; stateNonce?: string;
  originalResult?: CodexCliApplyResult; faultError?: string;
  preparation: string; planning: string; flagsLifecycle: string; applyInvoked: boolean; retentionAdopted: boolean;
  applyFinished: boolean; recoveryStarted: boolean; sequence: number;
} = { tokenCount: 0, releaseCount: 0, closeAttempts: 0, applyFinished: false, recoveryStarted: false, sequence: 0,
  stage: "BEFORE_RUN", runSettled: false, runInFlight: false, caseFailed: false,
  preparation: "NOT_STARTED", planning: "NOT_STARTED", flagsLifecycle: "NOT_LOADED", applyInvoked: false, retentionAdopted: false };
const commandIds = new Set<string>();
function emit(type: string, fields: Record<string, unknown> = {}) {
  self.postMessage({ ...owned.ids, sequence: ++owned.sequence, type, ...fields });
}
class FixtureCheckError extends Error {}
function need(value: unknown, phase: string): asserts value {
  if (!value) throw new FixtureCheckError(phase);
}
function handleFlags(): number {
  const value = Buffer.alloc(4);
  need(owned.handle !== undefined && owned.flags, "missing_owned_handle");
  need(owned.flags.symbols.GetHandleInformation(owned.handle, ptr(value)), "GetHandleInformation_failed");
  return value.readUInt32LE(0);
}
const lifetime = createCodexCliWorkerLifetime(() => { self.onmessage = null; });
function closeFlagsLibrary() {
  need(owned.flags && owned.flagsLifecycle === "OPEN", "auxiliary_library_not_proven_open");
  owned.flagsLifecycle = "CLOSING";
  try { owned.flags.close(); }
  catch (error) { owned.flagsLifecycle = "UNKNOWN_CLOSE_FAILURE"; throw error; }
  owned.flags = undefined; owned.flagsLifecycle = "CLOSED";
}
function cleanupReceipt() {
  need(owned.context && owned.prefix, "missing_context");
  return {
    childCount: 0, lockCreated: false, stagingCreated: false,
    allOriginalProcessesSignaled: "NOT_CREATED", allOwnedJobsEmpty: "NOT_CREATED",
    allPipesEOFOrSettledCancellation: "NOT_CREATED", allBorrowedBuffersReleased: "NOT_CREATED",
    nativeHandleCount: owned.context.pins.remaining, authorityPinCount: owned.context.pins.remaining,
    retentionTokenCount: owned.tokenCount, tokenReleaseCount: owned.releaseCount,
    toolchainReleased: "NOT_ACQUIRED", stagingDisposition: "NOT_CREATED",
    leaseDisposition: existsSync(join(owned.prefix, ".ocx-codex-cli-apply.lock")) ? "UNEXPECTED_PRESENT" : "NOT_CREATED",
    closeAttempts: owned.closeAttempts, protectionCleared: owned.protected !== true,
  };
}
function restoreInstrumentation() {
  need(owned.context && owned.keep && owned.release, "missing_instance_instrumentation");
  owned.context.pins.keep = owned.keep;
  owned.context.pins.release = owned.release;
}
async function prepareFixture() {
  owned.root = createCodexCliTestRoot("ocx-native-acquire-");
  emit("started", { fixtureRoot: owned.root, name: NATIVE_ACQUISITION_CASES[owned.ids!.caseId] });
  await hardenSecretDirAsync(owned.root, { required: true });
  trustWindowsTempFixtureAncestry(owned.root);
  owned.prefix = join(owned.root, "prefix");
  const mainRoot = join(owned.prefix, "node_modules/@openai/codex");
  const backingRoot = join(owned.prefix, "node_modules/@openai/codex-win32-x64");
  const npmRoot = join(owned.prefix, "node_modules/npm");
  const write = (path: string, value: string | Buffer) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); };
  write(join(mainRoot, "package.json"), JSON.stringify({ name: "@openai/codex", version: "1.0.0", bin: { codex: "bin/codex.js" } }));
  write(join(mainRoot, "bin/codex.js"), 'throw new Error("fixture candidate must not execute");');
  write(join(backingRoot, "package.json"), JSON.stringify({ name: "@openai/codex-win32-x64", version: "1.0.0" }));
  write(join(backingRoot, "vendor/x86_64-pc-windows-msvc/bin/codex.exe"), "owned backing observation bytes");
  write(join(npmRoot, "package.json"), JSON.stringify({ name: "npm", version: "11.0.0", bin: { npm: "bin/npm-cli.js" } }));
  write(join(npmRoot, "bin/npm-cli.js"), 'throw new Error("fixture npm must not execute");');
  const pe = Buffer.alloc(128); pe.write("MZ"); pe.writeUInt32LE(64, 60); pe.write("PE\0\0", 64); pe.writeUInt16LE(0x8664, 68);
  write(join(owned.prefix, "node.exe"), pe); // Header observation only; never executed in acquisition cases.
  const shims = JSON.parse(readFileSync(fixturePath("codex-windows-npm-shims.json"), "utf8"));
  for (const [name, bytes] of Object.entries(shims.files)) write(join(owned.prefix, name), String(bytes));
  for (const path of [owned.prefix, join(owned.prefix, "node_modules"), join(owned.prefix, "node_modules/@openai"), mainRoot]) {
    await hardenSecretDirAsync(path, { required: true });
  }
  const tar = fixtureTar({ "package.json": JSON.stringify({ name: "@openai/codex", version: "1.1.0" }) });
  const main = fixtureArtifact(tar, "1.1.0");
  const backing = fixtureArtifact(tar, "1.1.0", "@openai/codex-win32-x64", "@openai/codex-win32-x64");
  return {
    platform: "win32" as const,
    inspectionDeps: { env: { CODEX_CLI_PATH: join(owned.prefix, "codex.cmd"), PATH: owned.prefix, PATHEXT: ".EXE;.CMD" },
      configDir: join(owned.root, "absent-home"), selectionAttested: true, arch: "x64" as const, observeInstallContent: true },
    resolveTarget: () => ({ kind: "resolved" as const, version: "1.1.0", integrity: main.integrity,
      artifacts: { platform: "win32" as const, arch: "x64" as const, main, backing } }),
    scanProcesses: () => ({ kind: "observed" as const, processes: [] }),
  };
}
function observeAcquisition(value: WindowsApplyAcquisition) {
  owned.acquisition = value;
  const context = owned.context = value.resources as Context;
  owned.keep = context.pins.keep; owned.release = context.pins.release;
  context.pins.release = function(handle, kernel) {
    const result = Reflect.apply(owned.release!, this, [handle, kernel]);
    if (handle === owned.handle) {
      owned.closeResult = result; owned.closeAttempts++;
      owned.closeError = Number(owned.flags!.symbols.GetLastError());
    }
    return result;
  };
  context.pins.keep = function(handle) {
    const result = Reflect.apply(owned.keep!, this, [handle]);
    owned.handle = handle; // Exact real registered handle is rooted before any flag assertion.
    owned.stage = "REAL_PIN_REGISTERED";
    try {
      if (owned.ids!.caseId === "A1") {
        need(owned.flags!.symbols.SetHandleInformation(handle, 2, 2), "SetHandleInformation_failed");
        owned.protected = true; owned.stage = "PROTECT_SET_READBACK_PENDING";
        need((handleFlags() & 2) === 2, "protection_readback_failed");
      } else need((handleFlags() & 2) === 0, "counterarm_unexpected_protection");
      owned.protectionVerified = true; owned.stage = "FLAG_OBSERVED";
    } catch (error) {
      owned.faultError = error instanceof FixtureCheckError ? error.message : "flag_observation_error";
      throw error; // Production catch/finally still attempts the real close.
    }
    throw new Error("fixture-induced-acquisition-rejection");
  };
}
async function run(ids: Ids) {
  owned.ids = ids;
  owned.stage = "PREPARING_FIXTURE";
  need(process.platform === "win32" && process.arch === "x64", "native_platform_unavailable");
  owned.preparation = "IN_FLIGHT";
  let deps: Awaited<ReturnType<typeof prepareFixture>>;
  try { deps = await prepareFixture(); owned.preparation = "COMPLETED"; }
  catch (error) { owned.preparation = "FAILED"; throw error; }
  owned.planning = "IN_FLIGHT";
  owned.stage = "PLANNING";
  let plan: Awaited<ReturnType<typeof createCodexCliUpdatePlan>>;
  try { plan = await createCodexCliUpdatePlan(deps); owned.planning = "RETURNED"; }
  catch (error) { owned.planning = "THREW"; throw error; }
  need(plan.applicable && plan.planId, "fixture_plan_not_applicable");
  owned.flagsLifecycle = "LOADING";
  owned.stage = "AUXILIARY_NATIVE_LOAD";
  try { owned.flags = dlopen("kernel32.dll", FLAGS); owned.flagsLifecycle = "OPEN"; }
  catch (error) { owned.flagsLifecycle = "UNKNOWN_LOAD_FAILURE"; throw error; }
  owned.stage = "APPLY_ACQUISITION";
  owned.applyInvoked = true;
  const result = await applyCodexCliUpdate(plan.planId, { ...deps,
    retainExecution: anchor => {
      owned.retentionAdopted = true;
      const token = lifetime.retain(anchor); owned.tokenCount++;
      let released = false;
      owned.token = { release() { if (released) return; released = true; owned.tokenCount--; owned.releaseCount++; token.release(); } };
      Object.defineProperty(anchor, "acquisition", { configurable: true, set: observeAcquisition, get: () => owned.acquisition });
      return owned.token;
    },
    startWindowsChild: () => { emit("native-start"); throw new Error("unexpected_child_start"); },
  });
  owned.originalResult = result;
  owned.applyFinished = true;
  need(owned.context && owned.handle !== undefined && owned.acquisition, "acquisition_seam_not_reached");
  restoreInstrumentation();
  if (owned.faultError) throw new FixtureCheckError(owned.faultError);
  emit("native-observation", { closeAttempts: owned.closeAttempts, closeReturned: owned.closeResult,
    closeLastError: owned.closeError, protectedFlag: owned.protected === true,
    protectionVerified: owned.protectionVerified === true,
    remainingPins: owned.context.pins.remaining, tokenCount: owned.tokenCount, tokenReleaseCount: owned.releaseCount,
    fault: ids.caseId === "A1" ? "REAL_OS_PROTECT_FROM_CLOSE_WITH_SYNTHETIC_ACQUISITION_THROW" : "SYNTHETIC_ACQUISITION_THROW_REAL_OS_CLOSE" });
  emit("apply-result", { result }); // Immutable first outcome; recovery never republishes it.
  if (ids.caseId === "A2") {
    need(owned.context.pins.remaining === 0 && owned.tokenCount === 0 && owned.releaseCount === 1, "counterarm_cleanup_unverified");
    closeFlagsLibrary();
    emit("cleanup-receipt", cleanupReceipt());
  }
  lifetime.finish();
}
function inspectOwnedState() {
  owned.stateNonce = crypto.randomUUID();
  let protection: number | "UNOBSERVED" | "UNAVAILABLE" = "UNOBSERVED";
  if (owned.context?.pins.remaining && owned.handle !== undefined && owned.flags) {
    try { protection = handleFlags() & 2; } catch { protection = "UNAVAILABLE"; }
  }
  return { stage: owned.stage, runSettled: owned.runSettled, caseFailed: owned.caseFailed,
    runInFlight: owned.runInFlight,
    stateNonce: owned.stateNonce, knownOwnedPin: !!owned.context && owned.handle !== undefined,
    remainingPins: owned.context?.pins.remaining ?? 0, protection, tokenCount: owned.tokenCount,
    hasAcquisition: !!owned.acquisition, flagsLibraryOpen: !!owned.flags,
    preparation: owned.preparation, planning: owned.planning, flagsLifecycle: owned.flagsLifecycle,
    applyInvoked: owned.applyInvoked, retentionAdopted: owned.retentionAdopted };
}
function recoverNoAcquisition() {
  // This is evidence of fixture/apply acquisition scope only, not an audit of
  // every internal native handle used by the already-returned production planner.
  need(owned.preparation === "COMPLETED" && owned.planning === "RETURNED"
    && !owned.applyInvoked && !owned.retentionAdopted && !owned.acquisition && !owned.context
    && !owned.token && owned.handle === undefined && owned.tokenCount === 0
    && owned.releaseCount === 0 && owned.closeAttempts === 0 && owned.prefix, "no_acquisition_not_proven");
  need((owned.flagsLifecycle === "NOT_LOADED" && !owned.flags) || (owned.flagsLifecycle === "OPEN" && owned.flags), "auxiliary_load_state_unknown");
  if (owned.flags) closeFlagsLibrary();
  need(!existsSync(join(owned.prefix, ".ocx-codex-cli-apply.lock")), "unexpected_pre_acquisition_lock");
  emit("cleanup-receipt", {
    cleanupBranch: "NO_ACQUISITION_PREPARATION_SETTLED", preparation: owned.preparation, planning: owned.planning,
    flagsLifecycle: owned.flagsLifecycle, applyInvoked: false, retentionAdopted: false,
    childCount: 0, lockCreated: false, stagingCreated: false, nativeHandleCount: 0,
    authorityPinCount: 0, retentionTokenCount: 0, tokenReleaseCount: 0, protectionCleared: true,
    leaseDisposition: "NOT_CREATED", stagingDisposition: "NOT_CREATED", toolchainReleased: "NOT_ACQUIRED",
    nativeHandleScope: "FIXTURE_APPLY_ACQUISITION_ONLY", planningNativeInternals: "RETURNED_NOT_EXHAUSTIVELY_AUDITED",
  });
  lifetime.finish();
}
function recover(stateNonce: unknown) {
  need(owned.runSettled && !owned.runInFlight && typeof stateNonce === "string" && stateNonce === owned.stateNonce, "fresh_inspect_required");
  owned.stateNonce = undefined; // Consumed before action; uncertain actions are never auto-replayed.
  if (!owned.acquisition && !owned.context && !owned.token) { recoverNoAcquisition(); return; }
  need(owned.context && owned.acquisition && owned.token, "recovery_owner_missing");
  restoreInstrumentation();
  owned.stage = "EXACT_RECOVERY";
  if (owned.context.pins.remaining !== 0) {
    need(owned.context.pins.remaining === 1 && owned.handle !== undefined && owned.flags, "recovery_identity_state_mismatch");
    const flags = handleFlags(); // Fresh query of the exact still-owned pin, not cached success.
    if ((flags & 2) !== 0) {
      need(owned.flags.symbols.SetHandleInformation(owned.handle, 2, 0), "clear_protect_failed");
      need((handleFlags() & 2) === 0, "clear_protect_readback_failed");
    }
    owned.protected = false;
    need(owned.context.pins.release(owned.handle, owned.context.kernel), "explicit_exact_pin_release_failed");
  }
  need(owned.context.pins.remaining === 0, "pins_not_empty_after_recovery");
  if (owned.flags) closeFlagsLibrary();
  owned.protected = false;
  need(owned.acquisition.releaseIfClean(owned.token), "token_release_not_clean");
  need(owned.tokenCount === 0 && owned.releaseCount === 1, "token_release_count_mismatch");
  emit("cleanup-receipt", cleanupReceipt());
  lifetime.finish();
}
if (Bun.isMainThread === false) {
  self.onmessage = async event => {
    const input = event.data;
    try {
      if (!owned.ids) {
        need(input?.type === "run" && ["A1", "A2"].includes(input.caseId)
          && [input.runNonce, input.requestId, input.jobId].every(value => typeof value === "string" && value.length >= 16), "bad_first_envelope");
        owned.runInFlight = true;
        try { await run(input); }
        finally { owned.runInFlight = false; owned.runSettled = true; }
      } else {
        need(input?.runNonce === owned.ids.runNonce && input.caseId === owned.ids.caseId
          && input.requestId === owned.ids.requestId && input.jobId === owned.ids.jobId, "uncorrelated_command");
        need(typeof input.commandId === "string" && !commandIds.has(input.commandId), "duplicate_or_missing_command");
        commandIds.add(input.commandId);
        emit("command-ack", { commandId: input.commandId });
        if (input.type === "inspect") {
          emit("owned-state", inspectOwnedState());
        } else if (input.type === "probe") {
          need(owned.applyFinished && owned.tokenCount === 1, "probe_not_retained");
          emit("lifetime-probe-ack", { probeNonce: input.probeNonce, remainingPins: owned.context!.pins.remaining, tokenCount: owned.tokenCount });
        } else if (input.type === "recover") recover(input.stateNonce);
        else throw new Error("unknown_command");
      }
    } catch (error) {
      // No finally-disposal here: an unexplained error keeps every recorded root/handle.
      owned.caseFailed = true;
      emit("fixture-error", { phase: error instanceof FixtureCheckError ? error.message : "unexpected_fixture_error",
        knownOwnership: inspectOwnedState(), originalApplyResult: owned.originalResult });
    }
  };
}
