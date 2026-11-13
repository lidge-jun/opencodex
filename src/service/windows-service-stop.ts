/**
 * Caller side of the checked Windows service stop (#7771, 030 "Where it sits").
 *
 * Every Windows stop path reaches Part A and Part B through this module: ocx stop with and
 * without a consent snapshot, ocx uninstall, /api/stop, ocx service stop / uninstall /
 * remove, prepareServiceInstall and the updater. It owns:
 *
 * - the stop deadline (030 "Time budget"): --deadline-ms or OCX_STOP_DEADLINE_MS for
 *   ocx stop, measured from the command's start (performance.now() counts from
 *   performance.timeOrigin, the process start, so the deadline is an absolute value on the
 *   Part A clock); every other caller starts the default 60 s when its stop phase begins,
 *   because registration and the UAC prompt can come first;
 * - the admission inputs and the mapping of Part A onto ServiceStopOutcome;
 * - the Part A record a teardown receipt carries, so /api/stop can skip a second Part A;
 * - a hook seam so caller tests run hermetically (no schtasks, PowerShell or FFI).
 */
import { loadConfig } from "../config";
import { endpointsToProve, type ProbeEndpoint } from "../cli/uninstall-plan";
import { probeEndpointLiveness, type EndpointLiveness } from "../server/proxy-liveness";
import type { PendingTeardownPartA } from "../config/pending-teardown";
import { readRuntimePort } from "../config/process-state";
import type { WinswStatus } from "../lib/winsw";
import type { ServiceStopOutcome } from "./orchestration";
import { guardedStopWindowsServiceChecked, stopWindowsServiceChecked, windowsStopClock, type WindowsCheckedStopDeps, type WindowsCheckedStopOptions, type WindowsCheckedStopResult, type WindowsStopAdmission, type WindowsStopReason } from "./windows-checked-stop";
import { stopperUnderHomeWrapper, windowsCheckedStopLiveDeps, windowsStopConfirmLiveDeps, type WindowsCheckedStopLiveOptions } from "./windows-checked-stop-live";
import { windowsListenPort } from "./windows-ops";
import type { WindowsStopProcessEntry } from "./windows-process-evidence";
import { confirmWindowsStopFreed, resolveWindowsStopPort, type WindowsStopConfirmResult } from "./windows-stop-confirm";
import { windowsStopDeadlineAt } from "./windows-stop-deadline";

export { parseStopDeadlineMs, resolveStopDeadlineMs, setStopDeadlineMs, STOP_DEADLINE_ENV, windowsStopDeadlineAt } from "./windows-stop-deadline";

/** Time left on the stop deadline, measured on the Part A clock (one clock read). */
export function windowsStopRemainingMs(now: () => number = windowsStopClock.now): number {
  const at = now();
  return windowsStopDeadlineAt(at) - at;
}

export function configuredShutdownTimeoutMs(): number | undefined {
  try {
    const value = loadConfig().shutdownTimeoutMs;
    return typeof value === "number" && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

export function windowsStopAdmission(input: {
  orphanDiscovery: boolean;
  inheritedReceipts?: number;
  partB?: boolean;
}): WindowsStopAdmission {
  return {
    deadlineAt: windowsStopDeadlineAt(),
    budget: {
      orphanDiscovery: input.orphanDiscovery,
      inheritedReceipts: input.inheritedReceipts ?? 0,
      shutdownTimeoutMs: configuredShutdownTimeoutMs(),
      partB: input.partB ?? true,
    },
  };
}

export interface WindowsPartARequest {
  admission?: WindowsStopAdmission;
  /** The evidence snapshot (windowsProcessSnapshot) a guarded revalidation already read. */
  bindSnapshot?: readonly WindowsStopProcessEntry[];
  /** The updater's authorizer: throws to refuse, at entry, before each manager stop and before each terminate. */
  authorize?: () => void | Promise<void>;
  /**
   * A hard cap (the route: 6 s with a receipt, 4 s for a stray sweep). An overrun answers
   * unknown, and nothing further is changed: the manager commands and every terminate are
   * gated off once the cap has passed.
   */
  capMs?: number;
  /**
   * The stopping process may descend from this home's wrapper. Only the /api/stop route
   * (it IS the wrapped proxy) and the updater (its worker descends from the service-run
   * proxy) pass true; every interactive caller refuses such a stop with nothing changed.
   */
  allowUnderOwnWrapper?: boolean;
}

export interface WindowsPartBRequest {
  port: number;
  remainingMs: number;
  /** The final enumeration; the guarded path wraps it to share the table it read. */
  snapshot?: (timeoutMs: number) => Promise<readonly WindowsStopProcessEntry[] | null>;
}

export interface WindowsServiceStopHooks {
  partA?: (request: WindowsPartARequest) => Promise<WindowsCheckedStopResult>;
  /** Run the real Part A against these deps instead of the live ones. */
  liveDeps?: (options: WindowsCheckedStopLiveOptions) => WindowsCheckedStopDeps;
  partB?: (request: WindowsPartBRequest) => Promise<WindowsStopConfirmResult>;
  /** The evidence snapshot the guarded inspection and the bind share. */
  snapshot?: () => Promise<readonly WindowsStopProcessEntry[] | null>;
  schedulePid?: () => Promise<number | null>;
  /** The route's registration re-check against a receipt's Part A record. */
  registration?: () => Promise<{ scheduler: "present" | "absent" | "unknown"; winsw: WinswStatus }>;
}

let hooks: WindowsServiceStopHooks | null = null;

/** Test-only: replace Part A / Part B / the evidence reads with hermetic fakes. */
export function setWindowsServiceStopHooksForTests(next: WindowsServiceStopHooks | null): void {
  hooks = next;
}

export function windowsServiceStopHooks(): WindowsServiceStopHooks | null {
  return hooks;
}

function unknownResult(detail: string): WindowsCheckedStopResult {
  return {
    outcome: "unknown", reason: "evidence-unreadable", detail,
    registration: { scheduler: "unknown", winsw: "unknown" },
    bound: [], unbound: [], terminated: [], changed: false,
  };
}

export const UNDER_OWN_WRAPPER_DETAIL = "this stop runs under this home's service wrapper; run it from a separate terminal";

/** Part A with the live dependencies (or the test hook), optionally capped. */
export async function runWindowsServiceStopPartA(request: WindowsPartARequest = {}): Promise<WindowsCheckedStopResult> {
  let expired = false;
  let underOwnWrapper = false;
  const options: WindowsCheckedStopOptions = {
    ...(request.admission ? { admission: request.admission } : {}),
    ...(request.bindSnapshot ? { bindSnapshot: request.bindSnapshot } : {}),
  };
  const run = async (): Promise<WindowsCheckedStopResult> => {
    if (hooks?.partA) return hooks.partA(request);
    const live: WindowsCheckedStopLiveOptions = { gate: () => !expired };
    const base = (hooks?.liveDeps ?? windowsCheckedStopLiveDeps)(live);
    const selfPid = base.selfPid ?? process.pid;
    const guard = (table: readonly WindowsStopProcessEntry[] | null): boolean =>
      !request.allowUnderOwnWrapper && table !== null && stopperUnderHomeWrapper(table, base.canonicalPaths, selfPid);
    // The guarded path binds on a snapshot it already read: check it before anything runs.
    if (request.bindSnapshot && guard(request.bindSnapshot)) return unknownResult(UNDER_OWN_WRAPPER_DETAIL);
    // Otherwise the bind enumeration is checked as it arrives; a hit reads as an unreadable
    // table, which Part A answers before /end when a manager is registered.
    const deps = {
      ...base,
      enumerate: async (timeoutMs: number) => {
        const table = await base.enumerate(timeoutMs);
        if (!guard(table)) return table;
        underOwnWrapper = true;
        return null;
      },
    };
    const authorize = async (): Promise<void> => {
      if (expired) throw new Error("the checked stop's cap has passed");
      await request.authorize?.();
    };
    const result = await (request.authorize || request.capMs !== undefined
      ? guardedStopWindowsServiceChecked(authorize, deps, options)
      : stopWindowsServiceChecked(deps, options));
    // The refusal is the answer whatever the stray path would have concluded: with nothing
    // registered an unreadable enumeration reads as absent ("nothing to end"), which would
    // let the caller stop the child and restore shared config beneath this home's own looping
    // wrapper. Nothing has been changed at this point in either path, so it is unknown.
    if (underOwnWrapper) {
      result.outcome = "unknown";
      result.reason = "evidence-unreadable";
      result.detail = UNDER_OWN_WRAPPER_DETAIL;
      result.changed = false;
    }
    return result;
  };
  if (request.capMs === undefined) return run();
  const work = run().catch(error => {
    if (error && typeof error === "object" && "partial" in error) return (error as { partial: WindowsCheckedStopResult }).partial;
    throw error;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), request.capMs); });
  try {
    const result = await Promise.race([work, cap]);
    if (result === null) {
      expired = true;
      work.catch(() => undefined);
      return unknownResult("the checked stop did not finish within its cap");
    }
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Part A onto the existing ServiceStopOutcome (030 "Outcomes"). */
export function serviceStopOutcomeFromWindows(result: WindowsCheckedStopResult): ServiceStopOutcome {
  switch (result.outcome) {
    case "absent": return "absent";
    case "stopped": return "stopped";
    case "unknown": return "state-unknown";
    default: return "failed";
  }
}

/** The additive ocx-stop/1 serviceStopReason for a Part A result, if it has one. */
export function windowsStopReason(result: WindowsCheckedStopResult | null | undefined): WindowsStopReason | undefined {
  if (!result || result.outcome === "stopped" || result.outcome === "absent") return undefined;
  return result.reason ?? undefined;
}

/** One operator-facing line for a Part A result that was not stopped/absent. */
export function describeWindowsPartA(result: WindowsCheckedStopResult): string {
  switch (result.reason) {
    case "access-denied":
      return "The Windows service stop was denied for this account; run the stop from an elevated terminal.";
    case "unbound-wrapper":
      return "A service wrapper of this home is running but could not be tied to the service; end the wscript.exe/cmd.exe running the opencodex service script, then retry.";
    case "unverified-budget":
      return "The remaining time cannot hold a verified Windows service stop, so nothing was changed; retry from a terminal.";
    case "evidence-unreadable":
      return "The Windows service or process state could not be read (" + result.detail + "); nothing that could not be verified was stopped.";
    default:
      return "The Windows service manager or its wrapper is still running (" + result.detail + ").";
  }
}

/** What a teardown receipt records after Part A (030 "/api/stop"). */
export function windowsPartARecord(result: WindowsCheckedStopResult): PendingTeardownPartA | null {
  if (result.outcome !== "stopped" && result.outcome !== "absent") return null;
  return {
    partA: result.outcome,
    manager: {
      scheduler: result.registration.scheduler === "present",
      winsw: result.registration.winsw !== "nonexistent" && result.registration.winsw !== "unknown",
    },
    wrappers: result.bound.map(wrapper => ({ pid: wrapper.pid, startTime: wrapper.startTime })),
  };
}

/**
 * Every endpoint this home could be serving on, exactly the set `ocx uninstall` proves.
 *
 * The receipt endpoint is ONE candidate; a stale runtime record naming a closed port must
 * not stand in for the configured port where a live listener can sit (#3008, #7771).
 */
export function windowsRemovalEndpoints(): ProbeEndpoint[] {
  let config: { port?: number; hostname?: string } = {};
  try { config = loadConfig(); } catch { /* defaults below */ }
  return endpointsToProve(readRuntimePort(), config);
}

/**
 * Definitive absence on EVERY candidate. "unknown" is not absence: a listener that
 * accepts connections but withholds /healthz, or one that times out, is exactly the state
 * where deleting a registration or installing over it is most harmful.
 */
export async function endpointsAllDead(
  endpoints: readonly ProbeEndpoint[],
  probe: (endpoint: ProbeEndpoint) => Promise<EndpointLiveness> = probeEndpointLiveness,
): Promise<{ dead: boolean; live: number[]; unknown: number[] }> {
  const results = await Promise.all(endpoints.map(async endpoint => (
    await probe(endpoint).catch((): EndpointLiveness => "unknown")
  )));
  const live: number[] = [];
  const unknown: number[] = [];
  endpoints.forEach((endpoint, index) => {
    const answer = results[index];
    if (answer === "live") live.push(endpoint.port);
    else if (answer !== "dead") unknown.push(endpoint.port);
  });
  // No candidate is not proof of anything.
  return { dead: endpoints.length > 0 && live.length === 0 && unknown.length === 0, live, unknown };
}

/**
 * The endpoint a teardown receipt should name: the runtime record when it has one, the
 * configured address otherwise. `exact` is the only source a stop may defer against.
 */
export function windowsReceiptEndpoint(): { endpoint: { hostname: string; port: number }; source: "exact" | "guessed" } {
  const runtime = readRuntimePort();
  if (runtime?.port) return { endpoint: { hostname: runtime.hostname ?? "127.0.0.1", port: runtime.port }, source: "exact" };
  try {
    const config = loadConfig();
    return { endpoint: { hostname: config.hostname ?? "127.0.0.1", port: typeof config.port === "number" && config.port > 0 ? config.port : 10100 }, source: "guessed" };
  } catch {
    return { endpoint: { hostname: "127.0.0.1", port: 10100 }, source: "guessed" };
  }
}

/** The port Part B watches: runtime record, then the wrapper's baked port, then the config. */
export function windowsServiceStopPort(): number {
  return resolveWindowsStopPort({
    runtimePort: () => readRuntimePort()?.port ?? null,
    wrapperPort: () => windowsListenPort(),
    configuredPort: () => {
      try {
        const port = loadConfig().port;
        return typeof port === "number" && port > 0 ? port : 10100;
      } catch {
        return 10100;
      }
    },
  }).port;
}

/** Part B with the live dependencies (or the test hook). */
export async function confirmWindowsServiceStop(request: WindowsPartBRequest): Promise<WindowsStopConfirmResult> {
  if (hooks?.partB) return hooks.partB(request);
  return confirmWindowsStopFreed(windowsStopConfirmLiveDeps(request.port, request.remainingMs,
    request.snapshot ? { snapshot: request.snapshot } : {}));
}

/** One operator-facing line for a Part B result other than freed. */
export function describeWindowsPartB(result: WindowsStopConfirmResult): string {
  if (result.outcome === "port-held-by-foreign") {
    const owner = result.listener?.ownerPid ? " (PID " + result.listener.ownerPid + ")" : "";
    return "Another program" + owner + " holds port " + result.port + " after the stop.";
  }
  if (result.outcome === "survived") {
    return result.lateWrappers.length > 0
      ? "A service wrapper of this home started again after the stop; it can relaunch the proxy."
      : "The proxy answers on port " + result.port + " again after the stop; it is being respawned.";
  }
  return "Port " + result.port + " could not be confirmed free after the stop (" + result.detail + ").";
}
