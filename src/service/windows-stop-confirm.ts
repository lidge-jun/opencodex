/**
 * Part B of the checked Windows service stop (#7771, 030 "Part B"), run by the caller
 * after its graceful child stop: the port is free and stays free for one relaunch period,
 * no wrapper of this home is running, and a remaining listener is classified.
 *
 * 1. Sample the port until it has been free for the 6 s hold, measured between sample
 *    starts, within the window from windowsPartBWindowMs (6-12 s, starting now). A loop that
 *    relaunches the proxy late breaks the streak.
 * 2. Then, under one 5 s cap, run the final enumeration and, if the port is still held,
 *    identify its listener. The enumeration must show no wrapper-image process carrying
 *    this home's path token; an unreadable table is non-success, and a wrapper started
 *    after bind makes the stop survived even with the port free.
 * 3. A remaining listener is ours (survived), foreign (portHeldByForeign) or left by an
 *    owner that has exited, which is not foreign: the caller's reclaim clears that one.
 *
 * Every effect is injected; nothing calls this yet.
 */
import type { WindowsStopProcessEntry } from "./windows-process-evidence";
import { windowsHomeWrapperPids } from "./windows-stop-binding";
import { runCapped, windowsStopClock, type WindowsStopClock } from "./windows-checked-stop";
import { commandLineHasPathToken } from "./windows-guarded-manager";
import { WINDOWS_STOP_CAPS, windowsPartBWindowMs } from "./windows-stop-budget";

type MaybePromise<T> = T | Promise<T>;

export type WindowsPortSample =
  | { state: "free" }
  | { state: "listening"; ownerPid: number | null }
  | { state: "unknown" };

/** ours = this installation's identity answers; exited = the owning process is gone. */
export type WindowsListenerIdentity = "ours" | "foreign" | "exited" | "unknown";

export interface WindowsStopConfirmDeps {
  clock?: WindowsStopClock;
  port: number;
  /** Time left in the caller's deadline when Part B starts. */
  remainingMs: number;
  reserveMs?: number;
  canonicalPaths: readonly string[];
  selfPid?: number;
  samplePort(port: number, timeoutMs: number): MaybePromise<WindowsPortSample>;
  identifyListener(port: number, ownerPid: number | null, timeoutMs: number): MaybePromise<WindowsListenerIdentity>;
  enumerate(timeoutMs: number): MaybePromise<readonly WindowsStopProcessEntry[] | null>;
}

export type WindowsStopConfirmOutcome = "freed" | "survived" | "port-held-by-foreign" | "unconfirmed" | "unknown";

export interface WindowsStopConfirmResult {
  outcome: WindowsStopConfirmOutcome;
  portHeldByForeign: boolean;
  reason: "evidence-unreadable" | null;
  detail: string;
  port: number;
  windowMs: number;
  listener: { ownerPid: number | null; identity: WindowsListenerIdentity } | null;
  /** Wrapper-image processes of this home found by the final enumeration. */
  lateWrappers: number[];
}

const C = WINDOWS_STOP_CAPS;
const SAMPLE_INTERVAL_MS = 250;

export async function confirmWindowsStopFreed(deps: WindowsStopConfirmDeps): Promise<WindowsStopConfirmResult> {
  const clock = deps.clock ?? windowsStopClock;
  const windowMs = windowsPartBWindowMs(deps.remainingMs, deps.reserveMs ?? C.reserve);
  const windowEnd = clock.now() + windowMs;
  const result: WindowsStopConfirmResult = {
    outcome: "unknown", portHeldByForeign: false, reason: null, detail: "",
    port: deps.port, windowMs, listener: null, lateWrappers: [],
  };
  const finish = (outcome: WindowsStopConfirmOutcome, detail: string): WindowsStopConfirmResult => {
    result.outcome = outcome;
    result.portHeldByForeign = outcome === "port-held-by-foreign";
    result.reason = outcome === "unknown" ? "evidence-unreadable" : null;
    result.detail = detail;
    return result;
  };

  let freeSince: number | null = null;
  let held = false;
  let last: WindowsPortSample = { state: "unknown" };
  for (;;) {
    const startedAt = clock.now();
    const sample = await runCapped(clock, C.partBClosingSample, timeoutMs => deps.samplePort(deps.port, timeoutMs));
    last = sample.ok ? sample.value : { state: "unknown" };
    if (last.state === "free") {
      freeSince ??= startedAt;
      if (startedAt - freeSince >= C.partBHoldFloor) {
        held = true;
        break;
      }
    } else {
      freeSince = null;
    }
    const left = windowEnd - clock.now();
    if (left <= 0) break;
    await clock.sleep(Math.min(SAMPLE_INTERVAL_MS, left));
  }

  const listening = last.state === "listening" ? last : null;
  const [snapshot, identity] = await Promise.all([
    runCapped(clock, C.partBFinalEnumeration, deps.enumerate),
    listening
      ? runCapped(clock, C.partBFinalEnumeration,
        timeoutMs => deps.identifyListener(deps.port, listening.ownerPid, timeoutMs))
      : Promise.resolve(null),
  ]);
  if (listening) {
    result.listener = {
      ownerPid: listening.ownerPid,
      identity: identity && identity.ok ? identity.value : "unknown",
    };
  }

  const processes = snapshot.ok ? snapshot.value : null;
  if (processes) {
    result.lateWrappers = windowsHomeWrapperPids(processes, deps.canonicalPaths, deps.selfPid ?? process.pid);
  }
  if (result.lateWrappers.length > 0) return finish("survived", "a wrapper of this home is running after the stop");
  if (result.listener?.identity === "ours") return finish("survived", "this installation answers on the port again");
  if (processes === null) return finish("unknown", "the final process list could not be read");
  const unnamed = processes.some(entry => entry.name === null && entry.pid !== (deps.selfPid ?? process.pid)
    && deps.canonicalPaths.some(path => commandLineHasPathToken(entry.commandLine, path)));
  if (unnamed) return finish("unknown", "a process carrying this home's paths has an unreadable image name");
  if (held) return finish("freed", "the port stayed free for the hold and no wrapper of this home is running");
  if (result.listener?.identity === "foreign") return finish("port-held-by-foreign", "another program holds the port");
  if (result.listener?.identity === "exited") {
    return finish("unconfirmed", "the port is held by a listener whose owner has exited");
  }
  if (last.state === "free") return finish("unconfirmed", "the port was not free for the whole hold within the window");
  return finish("unknown", "the port state could not be read");
}

/**
 * Which port Part B watches: the runtime-port record when present, else the port baked
 * into the wrapper script, else the configured port.
 */
export function resolveWindowsStopPort(sources: {
  runtimePort: () => number | null;
  wrapperPort: () => number | null;
  configuredPort: () => number;
}): { port: number; source: "runtime" | "wrapper" | "config" } {
  const valid = (value: number | null): value is number =>
    value !== null && Number.isSafeInteger(value) && value > 0 && value <= 65_535;
  const read = (get: () => number | null): number | null => {
    try {
      return get();
    } catch {
      return null;
    }
  };
  const runtime = read(sources.runtimePort);
  if (valid(runtime)) return { port: runtime, source: "runtime" };
  const wrapper = read(sources.wrapperPort);
  if (valid(wrapper)) return { port: wrapper, source: "wrapper" };
  return { port: sources.configuredPort(), source: "config" };
}
