/**
 * Part A of the checked Windows service stop (#7771, 030 "Steps"): stop the manager, end
 * the bound wrappers, then prove the manager inactive and every bound wrapper exited.
 *
 * Part A covers the manager and the wrappers only. The proxy child is stopped afterwards
 * by the caller's graceful path (it may refuse, and a refusal forbids a forced stop), and
 * the port is confirmed by Part B (src/service/windows-stop-confirm.ts).
 *
 * 1. Probe registration (task, WinSW; 2 s caps). An unreadable answer is unknown with
 *    nothing changed. With nothing registered, one enumeration (5 s) looks for a stray
 *    wrapper of a deleted task; unreadable, or nothing found, is absent.
 *    With a task registered or a stray sweep running, the Schedule host PID is read (2 s).
 *    Admission runs here, after the probe and before anything changes.
 * 2. Bind (src/service/windows-stop-binding.ts) and open an exit watch per wrapper.
 * 3. Ask the manager: schtasks /end (2 s); WinSW a non-waiting stop (2 s) and an SCM poll
 *    capped at <stoptimeout> + 2 s. Denied is denied; an overrun is unknown; neither goes on.
 * 4. Terminate the bound survivors through the checked primitive, deepest first.
 * 5. Wait on the bind-time watches (steps 4 and 5 share 3 s), then read the manager state
 *    once (1 s). No enumeration and no PowerShell run in the wait.
 *
 * Every external effect is injected; nothing here touches the machine by itself, and
 * nothing calls it yet.
 */
import type { WinswStatus } from "../lib/winsw";
import type { WindowsProcessWatch, WindowsTerminateResult } from "./windows-process-native";
import type { WindowsStopProcessEntry } from "./windows-process-evidence";
import type { WindowsSchedulerTaskProbe } from "./windows-scheduler";
import { bindWindowsStopWrappers, type WindowsBoundWrapper, type WindowsStopBinding } from "./windows-stop-binding";
import {
  DEFAULT_WINSW_STOP_TIMEOUT_MS,
  WINDOWS_STOP_CAPS,
  windowsStopWorstCase,
  type WindowsStopBudgetInput,
} from "./windows-stop-budget";

type MaybePromise<T> = T | Promise<T>;

/** Monotonic clock and cancellable sleep; tests inject a virtual one. */
export interface WindowsStopClock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const windowsStopClock: WindowsStopClock = {
  now: () => performance.now(),
  sleep: (ms, signal) => new Promise(resolve => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, Math.max(0, ms));
    signal?.addEventListener("abort", done, { once: true });
  }),
};

export type WindowsStopReason = "access-denied" | "evidence-unreadable" | "unbound-wrapper" | "unverified-budget";
export type WindowsCheckedStopOutcome = "absent" | "stopped" | "survived" | "denied" | "unknown" | "unverified-budget";
export type WindowsTaskEndResult = "ended" | "not-running" | "denied" | "failed";
export type WindowsWinswStopResult = "sent" | "denied" | "failed";
export type WindowsWinswScmState = "stopped" | "running" | "pending" | "nonexistent" | "unknown";

export interface WindowsCheckedStopDeps {
  clock?: WindowsStopClock;
  /** This home's canonical launcher VBS and service script paths. */
  canonicalPaths: readonly string[];
  /** The identity-checked proxy child (readPid), when known. */
  childPid: number | null;
  selfPid?: number;
  probeScheduler(timeoutMs: number): MaybePromise<WindowsSchedulerTaskProbe>;
  probeWinsw(timeoutMs: number): MaybePromise<WinswStatus>;
  enumerate(timeoutMs: number): MaybePromise<readonly WindowsStopProcessEntry[] | null>;
  scheduleServicePid(timeoutMs: number): MaybePromise<number | null>;
  endTask(timeoutMs: number): MaybePromise<WindowsTaskEndResult>;
  /** Running state of the task (schtasks /query); the final manager-state read. */
  taskState(timeoutMs: number): MaybePromise<"running" | "not-running" | "unknown">;
  winswStop(timeoutMs: number): MaybePromise<WindowsWinswStopResult>;
  winswState(timeoutMs: number): MaybePromise<WindowsWinswScmState>;
  /** The WinSW definition's <stoptimeout>; 20 s for the generated one. */
  winswStopTimeoutMs?: number;
  /** After WinSW reports stopped: is the proxy still alive? null = cannot tell. */
  proxyAlive(timeoutMs: number): MaybePromise<boolean | null>;
  openWatch(pid: number, startTime: number): MaybePromise<WindowsProcessWatch>;
  terminate(pid: number, startTime: number, timeoutMs: number): MaybePromise<WindowsTerminateResult>;
}

export interface WindowsStopAdmission {
  /** Absolute deadline on the deps clock. */
  deadlineAt: number;
  budget: Omit<WindowsStopBudgetInput, "managers" | "enumerationReused">;
}

export interface WindowsCheckedStopOptions {
  /** A snapshot that already ran (guarded: revalidateManager's), reused for the bind. */
  bindSnapshot?: readonly WindowsStopProcessEntry[];
  admission?: WindowsStopAdmission;
  /** Throws to refuse. Runs at entry and before each terminate. */
  authorize?: () => MaybePromise<void>;
}

export interface WindowsCheckedStopResult {
  outcome: WindowsCheckedStopOutcome;
  reason: WindowsStopReason | null;
  /** Fixed text for logs and output; it never carries a path or a command line. */
  detail: string;
  registration: { scheduler: "present" | "absent" | "unknown"; winsw: WinswStatus };
  /** The bound set (pid + creation time) for the later receipt record. */
  bound: WindowsBoundWrapper[];
  unbound: number[];
  terminated: number[];
  /** True once a manager stop or a terminate was attempted. */
  changed: boolean;
  budget?: { requiredMs: number; remainingMs: number };
}

/** The authorizer refused; partial says what had already happened. */
export class WindowsCheckedStopRefusedError extends Error {
  constructor(readonly partial: WindowsCheckedStopResult, options: { cause: unknown }) {
    super("The checked Windows service stop was refused by its authorizer.", options);
    this.name = "WindowsCheckedStopRefusedError";
  }
}

const C = WINDOWS_STOP_CAPS;
const WINSW_POLL_INTERVAL_MS = 250;
const WATCH_POLL_INTERVAL_MS = 100;
const TIMED_OUT = Symbol("timed-out");

type Capped<T> = { ok: true; value: T } | { ok: false; timedOut: boolean };

/**
 * Run one step under a cap. The race ends the wait for an asynchronous dependency; the
 * elapsed check catches one that blocked past the cap anyway. Either is an overrun.
 */
export async function runCapped<T>(
  clock: WindowsStopClock,
  capMs: number,
  run: (timeoutMs: number) => MaybePromise<T>,
): Promise<Capped<T>> {
  if (capMs <= 0) return { ok: false, timedOut: true };
  const started = clock.now();
  const abort = new AbortController();
  const work = Promise.resolve().then(() => run(capMs));
  work.catch(() => undefined);
  try {
    const value = await Promise.race([work, clock.sleep(capMs, abort.signal).then(() => TIMED_OUT)]);
    if (value === TIMED_OUT || clock.now() - started > capMs) return { ok: false, timedOut: true };
    return { ok: true, value: value as T };
  } catch {
    return { ok: false, timedOut: false };
  } finally {
    abort.abort();
  }
}

export async function stopWindowsServiceChecked(
  deps: WindowsCheckedStopDeps,
  options: WindowsCheckedStopOptions = {},
): Promise<WindowsCheckedStopResult> {
  const clock = deps.clock ?? windowsStopClock;
  const watches = new Map<number, Extract<WindowsProcessWatch, { status: "open" }>>();
  const result: WindowsCheckedStopResult = {
    outcome: "unknown", reason: null, detail: "",
    registration: { scheduler: "unknown", winsw: "unknown" },
    bound: [], unbound: [], terminated: [], changed: false,
  };
  const finish = (outcome: WindowsCheckedStopOutcome, reason: WindowsStopReason | null, detail: string) => {
    result.outcome = outcome;
    result.reason = reason;
    result.detail = detail;
    return result;
  };
  const authorize = async (): Promise<void> => {
    if (!options.authorize) return;
    try {
      await options.authorize();
    } catch (cause) {
      throw new WindowsCheckedStopRefusedError({ ...result, detail: "the authorizer refused the stop" }, { cause });
    }
  };
  try {
    await authorize();

    // Step 1: registration.
    const [scheduler, winsw] = await Promise.all([
      runCapped(clock, C.registrationProbe, deps.probeScheduler),
      runCapped(clock, C.registrationProbe, deps.probeWinsw),
    ]);
    result.registration = {
      scheduler: scheduler.ok && scheduler.value.status !== "unknown" ? scheduler.value.status : "unknown",
      winsw: winsw.ok ? winsw.value : "unknown",
    };
    if (result.registration.scheduler === "unknown" || result.registration.winsw === "unknown") {
      return finish("unknown", "evidence-unreadable", "the service registration could not be read");
    }
    const taskRegistered = result.registration.scheduler === "present";
    const winswRegistered = result.registration.winsw !== "nonexistent";
    const winswStarted = result.registration.winsw === "started";
    const readSchedulePid = async (): Promise<number | null> => {
      const pid = await runCapped(clock, C.scheduleServicePid, deps.scheduleServicePid);
      return pid.ok ? pid.value : null;
    };
    const bindContext = {
      canonicalPaths: deps.canonicalPaths,
      childPid: deps.childPid,
      selfPid: deps.selfPid ?? process.pid,
    };

    let binding: WindowsStopBinding | null = null;
    let schedulePid: number | null = null;
    const stray = !taskRegistered && !winswRegistered;
    if (stray) {
      const snapshot = await runCapped(clock, C.enumeration, deps.enumerate);
      // Nothing registered and nothing readable: today's best-effort sweep skips too.
      if (!snapshot.ok || snapshot.value === null) {
        return finish("absent", null, "no service is registered; the process list could not be read");
      }
      schedulePid = await readSchedulePid();
      binding = bindWindowsStopWrappers({
        ...bindContext, processes: snapshot.value, taskRegistered: false, managerRegistered: false,
        scheduleServicePid: schedulePid,
      });
      if (binding.bound.length === 0 && binding.unbound.length === 0 && binding.unreadable.length === 0) {
        return finish("absent", null, "no service is registered and no wrapper of this home is running");
      }
      // Neither of these changes anything, so neither waits for admission.
      result.unbound = binding.unbound.map(entry => entry.pid);
      if (binding.unreadable.length > 0) {
        return finish("unknown", "evidence-unreadable", "a possible wrapper of this home has unreadable evidence");
      }
      if (binding.bound.length === 0) {
        return await unboundOnlyVerdict(binding, deps, watches)
          ? finish("survived", "unbound-wrapper", "a wrapper of this home is running but cannot be tied to a manager")
          : finish("absent", null, "no service is registered and no wrapper of this home is running");
      }
    } else if (taskRegistered) {
      schedulePid = await readSchedulePid();
    }

    // Admission: everything still to come must fit before anything changes.
    if (options.admission) {
      const budget = windowsStopWorstCase({
        ...options.admission.budget,
        managers: { scheduler: taskRegistered, winsw: winswStarted, stray },
        enumerationReused: stray || options.bindSnapshot !== undefined,
        winswStopTimeoutMs: options.admission.budget.winswStopTimeoutMs ?? deps.winswStopTimeoutMs,
      });
      const remainingMs = options.admission.deadlineAt - clock.now();
      result.budget = { requiredMs: budget.totalMs, remainingMs };
      if (remainingMs < budget.totalMs) {
        return finish("unverified-budget", "unverified-budget", "the remaining time cannot hold the worst case of the stop");
      }
    }

    // Step 2: bind.
    if (taskRegistered) {
      let processes = options.bindSnapshot ?? null;
      if (processes === null) {
        const snapshot = await runCapped(clock, C.enumeration, deps.enumerate);
        if (!snapshot.ok || snapshot.value === null) {
          return finish("unknown", "evidence-unreadable", "the process list could not be read");
        }
        processes = snapshot.value;
      }
      binding = bindWindowsStopWrappers({
        ...bindContext, processes, taskRegistered: true, managerRegistered: true,
        scheduleServicePid: schedulePid,
      });
    }
    if (binding) {
      result.unbound = binding.unbound.map(entry => entry.pid);
      if (binding.unreadable.length > 0) {
        return finish("unknown", "evidence-unreadable", "a possible wrapper of this home has unreadable evidence");
      }
    }
    const targets: WindowsBoundWrapper[] = [];
    for (const wrapper of binding?.bound ?? []) {
      const watch = await deps.openWatch(wrapper.pid, wrapper.startTime);
      if (watch.status === "gone" || watch.status === "reused") continue;
      if (watch.status === "denied") {
        return finish("denied", "access-denied", "a bound wrapper cannot be opened by this account");
      }
      if (watch.status === "open") watches.set(wrapper.pid, watch);
      targets.push(wrapper);
    }
    result.bound = targets;
    const unboundWatches = new Map<number, WindowsProcessWatch>();
    for (const entry of binding?.unbound ?? []) {
      if (entry.startTime === null) continue;
      const watch = await deps.openWatch(entry.pid, entry.startTime);
      unboundWatches.set(entry.pid, watch);
      if (watch.status === "open") watches.set(entry.pid, watch);
    }

    // Step 3: ask the manager.
    if (taskRegistered) {
      result.changed = true;
      const ended = await runCapped(clock, C.taskEnd, deps.endTask);
      if (!ended.ok) return finish("unknown", "evidence-unreadable", "the task end command did not answer within its cap");
      if (ended.value === "denied") return finish("denied", "access-denied", "ending the task was denied");
      if (ended.value === "failed") return finish("unknown", "evidence-unreadable", "the task end command failed");
    }
    if (winswStarted) {
      result.changed = true;
      const stop = await runCapped(clock, C.winswStopCommand, deps.winswStop);
      if (!stop.ok) return finish("unknown", "evidence-unreadable", "the native service stop did not answer within its cap");
      if (stop.value === "denied") return finish("denied", "access-denied", "stopping the native service was denied");
      if (stop.value === "failed") return finish("unknown", "evidence-unreadable", "the native service stop failed");
      const pollEnd = clock.now() + (deps.winswStopTimeoutMs ?? DEFAULT_WINSW_STOP_TIMEOUT_MS) + C.winswPollMargin;
      for (;;) {
        const left = pollEnd - clock.now();
        const state = await runCapped(clock, Math.min(C.managerState, left), deps.winswState);
        if (state.ok && (state.value === "stopped" || state.value === "nonexistent")) break;
        if (pollEnd - clock.now() <= 0) {
          return finish("unknown", "evidence-unreadable", "the native service did not report stopped within its stop timeout");
        }
        await clock.sleep(Math.min(WINSW_POLL_INTERVAL_MS, pollEnd - clock.now()));
      }
    }

    // Steps 4 and 5: terminate the bound survivors, then wait on the bind-time watches.
    const windowEnd = clock.now() + C.terminateAndWait;
    const exited = new Map<number, boolean>();
    for (const wrapper of targets) {
      if (watches.get(wrapper.pid)?.exited() === true) {
        exited.set(wrapper.pid, true);
        continue;
      }
      await authorize();
      result.changed = true;
      const outcome = await runCapped(clock, windowEnd - clock.now(),
        timeoutMs => deps.terminate(wrapper.pid, wrapper.startTime, timeoutMs));
      if (!outcome.ok) return finish("unknown", "evidence-unreadable", "terminating a bound wrapper did not answer within its cap");
      const status = outcome.value.status;
      if (status === "denied") return finish("denied", "access-denied", "terminating a bound wrapper was denied");
      if (status === "unavailable") return finish("unknown", "evidence-unreadable", "a bound wrapper could not be terminated");
      if (status === "terminated") {
        result.terminated.push(wrapper.pid);
        if (outcome.value.exited === true) exited.set(wrapper.pid, true);
      } else {
        // gone, or reused: the bound process no longer exists either way, and a reused PID
        // is a different process that is left untouched.
        exited.set(wrapper.pid, true);
      }
    }
    const pending = (): WindowsBoundWrapper[] => targets.filter(wrapper => {
      if (exited.get(wrapper.pid)) return false;
      if (watches.get(wrapper.pid)?.exited() === true) {
        exited.set(wrapper.pid, true);
        return false;
      }
      return true;
    });
    while (pending().length > 0 && clock.now() < windowEnd) {
      await clock.sleep(Math.min(WATCH_POLL_INTERVAL_MS, windowEnd - clock.now()));
    }
    let boundAlive = false;
    let unreadable = false;
    for (const wrapper of pending()) {
      const state = watches.get(wrapper.pid)?.exited();
      if (state === false) boundAlive = true;
      else unreadable = true;
    }

    // Step 5: the manager state, read once.
    let managerActive = false;
    if (taskRegistered) {
      const state = await runCapped(clock, C.managerState, deps.taskState);
      if (state.ok && state.value === "running") managerActive = true;
      else if (!state.ok || state.value === "unknown") unreadable = true;
    }
    if (winswStarted) {
      const stepEnd = clock.now() + C.managerState;
      const state = await runCapped(clock, C.managerState, deps.winswState);
      if (state.ok && (state.value === "running" || state.value === "pending")) managerActive = true;
      else if (!state.ok || state.value === "unknown") unreadable = true;
      const alive = await runCapped(clock, stepEnd - clock.now(), deps.proxyAlive);
      if (alive.ok && alive.value === true) managerActive = true;
    }

    const unboundAlive = binding ? unboundStillAlive(binding, unboundWatches) : false;
    if (unboundAlive) {
      return finish("survived", "unbound-wrapper", "a wrapper of this home is running but cannot be tied to a manager");
    }
    if (boundAlive || managerActive) return finish("survived", null, "the manager or a bound wrapper is still running");
    if (unreadable) return finish("unknown", "evidence-unreadable", "the stop could not be verified");
    return finish("stopped", null, "the manager is stopped and every bound wrapper has exited");
  } finally {
    for (const watch of watches.values()) {
      try { watch.close(); } catch { /* closing a handle cannot change the verdict */ }
    }
  }
}

/** An unbound wrapper counts as alive unless its watch proves it exited. */
function unboundStillAlive(binding: WindowsStopBinding, watches: ReadonlyMap<number, WindowsProcessWatch>): boolean {
  return binding.unbound.some(entry => {
    const watch = watches.get(entry.pid);
    if (!watch) return true;
    if (watch.status === "gone" || watch.status === "reused") return false;
    return watch.status !== "open" || watch.exited() !== true;
  });
}

/** Stray path with nothing bound: are the unbound wrappers still there? Read-only. */
async function unboundOnlyVerdict(
  binding: WindowsStopBinding,
  deps: WindowsCheckedStopDeps,
  opened: Map<number, Extract<WindowsProcessWatch, { status: "open" }>>,
): Promise<boolean> {
  const watches = new Map<number, WindowsProcessWatch>();
  for (const entry of binding.unbound) {
    if (entry.startTime === null) continue;
    const watch = await deps.openWatch(entry.pid, entry.startTime);
    watches.set(entry.pid, watch);
    if (watch.status === "open") opened.set(entry.pid, watch);
  }
  return unboundStillAlive(binding, watches);
}

/** The updater's variant: the authorizer runs at entry and before every terminate. */
export function guardedStopWindowsServiceChecked(
  authorize: () => MaybePromise<void>,
  deps: WindowsCheckedStopDeps,
  options: Omit<WindowsCheckedStopOptions, "authorize"> = {},
): Promise<WindowsCheckedStopResult> {
  return stopWindowsServiceChecked(deps, { ...options, authorize });
}
