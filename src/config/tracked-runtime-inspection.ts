/**
 * Read-only classification of the tracked runtime record pair a guarded stop
 * re-verifies before acting.
 *
 * "ocx stop --expect-*" asks "is the recorded runtime still the approved one",
 * which collapses several observations into one boolean: a missing or invalid
 * "ocx.pid", a dead, foreign or unverifiable recorded process, and a missing,
 * invalid or PID-mismatched "runtime-port.json" all read as "not verified".
 * The approval-changed refusal used to report only that umbrella fact, so a
 * desktop log could not tell a stale record from a permission failure.
 *
 * This probe walks the same checks in the same order as "readPid()" followed
 * by "readRuntimePort(pid)", but reports which one failed instead. Each state
 * record is still read exactly once per call -- a guarded stop asks once, and
 * caching the bytes would only carry a stale answer into a decision about a
 * record that may have been rewritten. The process-identity question, though,
 * is answered by the same cache-backed observation "readPid()" itself makes
 * ("inspectOcxStartProcessIdentity"): a cached verdict serves this probe with
 * no native command at all, and a miss performs the same single command-line
 * probe readPid would, so this probe can never disagree with the admission
 * readPid just granted or denied for the same PID. It performs no mutation, no
 * signal beyond the same "process.kill(pid, 0)" liveness read, and no stop
 * decision -- the refusal itself is unchanged; only its detail gains a cause.
 *
 * Two distinctions are deliberate:
 *
 * - "permission-denied" is reported only for a real EACCES/EPERM observed on a
 *   record read or the liveness signal. An "unverifiable" identity observation
 *   -- an unreadable process command line -- is not proof of a permission
 *   boundary, and no account or elevation cause is inferred from it.
 * - No path, command line, stderr text, or token leaves this module: the refusal
 *   causes below are fixed strings and the detail built from them is a fixed
 *   sentence.
 */
import { readFileSync } from "node:fs";
import {
  getPidPath,
  getRuntimePortPath,
  inspectOcxStartProcessIdentity,
  isValidRuntimePortState,
  parsePidFile,
} from "./process-state";
import type { OcxStartIdentityObservation } from "./process-state";

/** The single check that failed, as a stable machine-readable token. */
export type TrackedRecordRefusal =
  | "pid-record-absent"
  | "pid-record-permission-denied"
  | "pid-record-unreadable"
  | "pid-record-invalid"
  | "process-not-running"
  | "process-identity-mismatch"
  | "process-unverifiable"
  | "runtime-record-absent"
  | "runtime-record-permission-denied"
  | "runtime-record-unreadable"
  | "runtime-record-invalid"
  | "runtime-record-pid-mismatch"
  | "unverified";

export type TrackedRecordInspection =
  | { status: "verified"; pid: number; port: number; hostname: string }
  | { status: "refused"; reason: TrackedRecordRefusal };

/**
 * Injectable read-only seams. Tests must supply fakes for "signal" and either
 * "identity" or the process-state exec seams ("setProcessCommandLineExecForTests"
 * and friends) so no real "process.kill" or native command probe runs; the
 * defaults are exactly what the production caller uses, including the shared
 * identity cache.
 */
export interface TrackedRecordProbeDeps {
  /** Read a state record like "readFileSync(path, 'utf-8')"; throw with errno codes. */
  readFile?: (path: string) => string;
  /** The "process.kill(pid, 0)" liveness read; throws like it (ESRCH/EPERM/...). */
  signal?: (pid: number) => void;
  /** The shared start-identity observation; the default consults the real cache. */
  identity?: (pid: number) => OcxStartIdentityObservation;
}

function readRecordFile(
  readFile: (path: string) => string,
  path: string,
  absent: TrackedRecordRefusal,
  denied: TrackedRecordRefusal,
  unreadable: TrackedRecordRefusal,
): { ok: true; raw: string } | { ok: false; reason: TrackedRecordRefusal } {
  try {
    return { ok: true, raw: readFile(path) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") return { ok: false, reason: denied };
    if (code === "ENOENT") return { ok: false, reason: absent };
    return { ok: false, reason: unreadable };
  }
}

/**
 * Classify why the tracked runtime record cannot back a guarded stop, or return
 * the verified target when every check still holds. One read per record, in the
 * same order the stop path already performs them.
 */
export function inspectTrackedRuntimeRecord(
  deps: TrackedRecordProbeDeps = {},
): TrackedRecordInspection {
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, "utf-8"));
  const signal = deps.signal ?? ((pid: number) => { process.kill(pid, 0); });
  const identity = deps.identity ?? inspectOcxStartProcessIdentity;
  try {
    const pidFile = readRecordFile(
      readFile, getPidPath(), "pid-record-absent", "pid-record-permission-denied", "pid-record-unreadable",
    );
    if (!pidFile.ok) return { status: "refused", reason: pidFile.reason };
    const pid = parsePidFile(pidFile.raw);
    if (pid === null) return { status: "refused", reason: "pid-record-invalid" };
    try {
      signal(pid);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") return { status: "refused", reason: "process-not-running" };
      // EPERM still names a live process; identity is decided by the shared
      // observation below, exactly as readPid decides it. Any other signal
      // error can only be reported as unverifiable.
      if (code !== "EPERM") return { status: "refused", reason: "process-unverifiable" };
    }
    const observation = identity(pid);
    if (observation === "unverifiable") {
      return { status: "refused", reason: "process-unverifiable" };
    }
    if (observation === "mismatch") {
      return { status: "refused", reason: "process-identity-mismatch" };
    }
    const runtimeFile = readRecordFile(
      readFile, getRuntimePortPath(),
      "runtime-record-absent", "runtime-record-permission-denied", "runtime-record-unreadable",
    );
    if (!runtimeFile.ok) return { status: "refused", reason: runtimeFile.reason };
    let parsed: unknown;
    try {
      parsed = JSON.parse(runtimeFile.raw);
    } catch {
      return { status: "refused", reason: "runtime-record-invalid" };
    }
    if (!isValidRuntimePortState(parsed)) {
      return { status: "refused", reason: "runtime-record-invalid" };
    }
    if (parsed.pid !== pid) {
      return { status: "refused", reason: "runtime-record-pid-mismatch" };
    }
    return { status: "verified", pid, port: parsed.port, hostname: parsed.hostname ?? "" };
  } catch {
    return { status: "refused", reason: "unverified" };
  }
}

/**
 * Fixed refusal causes for the approval-changed detail. Every entry is a
 * complete sentence fragment and contains no path, command line, stderr, or
 * token, so the resulting detail is safe to surface in a caller's log or UI.
 */
const TRACKED_REFUSAL_CAUSES: Record<TrackedRecordRefusal, string> = {
  "pid-record-absent": "the recorded PID file is absent",
  "pid-record-permission-denied": "reading the recorded PID file was denied",
  "pid-record-unreadable": "the recorded PID file could not be read",
  "pid-record-invalid": "the recorded PID file is not a valid record",
  "process-not-running": "the recorded process is no longer running",
  "process-identity-mismatch": "the recorded process does not match the expected start command",
  "process-unverifiable": "the recorded process identity could not be verified",
  "runtime-record-absent": "the tracked runtime record is absent",
  "runtime-record-permission-denied": "reading the tracked runtime record was denied",
  "runtime-record-unreadable": "the tracked runtime record could not be read",
  "runtime-record-invalid": "the tracked runtime record is not a valid record",
  "runtime-record-pid-mismatch": "the tracked runtime record names a different PID",
  "unverified": "the tracked runtime record could not be re-verified",
};

/**
 * The guarded stop's tracked() callback shape: the verified target, or the
 * fixed cause of the single check that failed. Read-only; decides nothing.
 */
export function describeTrackedRuntimeTarget(
  deps: TrackedRecordProbeDeps = {},
): { pid: number; port: number; hostname: string } | { untracked: string } {
  const inspection = inspectTrackedRuntimeRecord(deps);
  return inspection.status === "verified"
    ? { pid: inspection.pid, port: inspection.port, hostname: inspection.hostname }
    : { untracked: TRACKED_REFUSAL_CAUSES[inspection.reason] };
}
