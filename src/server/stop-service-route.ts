/**
 * The service stop inside POST /api/stop (#7771, 030 "/api/stop").
 *
 * The route runs inside the proxy that holds the port, so it can never confirm the port
 * itself; Part B belongs to the parent ocx stop. On Windows the route splits by case:
 *
 * - a receipt whose Part A record names the manager that is still registered: the parent
 *   already ran Part A, so the route skips it (no second enumeration, /end or wait);
 * - a receipt without that record (an older CLI, or one claimed before Part A): today's
 *   behavior, the service stop, now Part A capped at 6 s; an overrun is
 *   service_state_unknown;
 * - no receipt (the caller already refused a respawnable task, so nothing is registered
 *   with the Task Scheduler): a registered WinSW service keeps today's in-process stop,
 *   because WinSW's own stop ends this very process and cannot be capped from inside it;
 *   otherwise Part A's stray sweep for a deleted task's wrapper, capped at 4 s, so the
 *   route still answers inside the parent's 10 s POST abort.
 *
 * Off Windows it is today's stopServiceIfInstalledDetailed.
 */
import { pendingTeardownPartA, type PendingTeardownPartA } from "../config/pending-teardown";
import type { ServiceStopOutcome } from "../service/orchestration";

export const ROUTE_PART_A_CAP_MS = 6_000;
export const ROUTE_STRAY_SWEEP_CAP_MS = 4_000;
const REGISTRATION_PROBE_MS = 2_000;

export interface RouteServiceStopIo {
  platform?: NodeJS.Platform;
  stop?: (request: { capMs?: number; allowUnderOwnWrapper?: boolean }) => Promise<ServiceStopOutcome>;
  assertEnvironment?: () => void;
  readRecord?: (nonce: string | null) => PendingTeardownPartA | null;
  registration?: () => Promise<{ scheduler: "present" | "absent" | "unknown"; winsw: "started" | "stopped" | "nonexistent" | "unknown" }>;
  winswRegistered?: () => boolean;
  stopWinsw?: () => void;
}

async function liveRegistration(): Promise<Awaited<ReturnType<NonNullable<RouteServiceStopIo["registration"]>>>> {
  const { windowsServiceStopHooks } = await import("../service/windows-service-stop");
  const hooked = windowsServiceStopHooks()?.registration;
  if (hooked) return hooked();
  const { windowsCheckedStopLiveDeps } = await import("../service/windows-checked-stop-live");
  const deps = windowsCheckedStopLiveDeps();
  const [scheduler, winsw] = await Promise.all([
    Promise.resolve(deps.probeScheduler(REGISTRATION_PROBE_MS)).then(probe => probe.status, () => "unknown" as const),
    Promise.resolve(deps.probeWinsw(REGISTRATION_PROBE_MS)).catch(() => "unknown" as const),
  ]);
  return { scheduler, winsw };
}

/** The record still describes this machine: the same managers are registered. */
export function partARecordMatchesRegistration(
  record: PendingTeardownPartA,
  current: Awaited<ReturnType<NonNullable<RouteServiceStopIo["registration"]>>>,
): boolean {
  if (current.scheduler === "unknown" || current.winsw === "unknown") return false;
  return record.manager.scheduler === (current.scheduler === "present")
    && record.manager.winsw === (current.winsw !== "nonexistent");
}

export async function routeServiceStop(url: URL, holdsReceipt: boolean, io: RouteServiceStopIo = {}): Promise<ServiceStopOutcome> {
  const service = await import("../service");
  const stop = io.stop ?? (request => service.stopServiceIfInstalledDetailed(request));
  if ((io.platform ?? process.platform) !== "win32") return stop({});
  // The ownership check every service stop ran before still runs first.
  (io.assertEnvironment ?? service.assertServiceEnvironmentMatchesInstall)();
  if (holdsReceipt) {
    const record = (io.readRecord ?? pendingTeardownPartA)(url.searchParams.get("teardownNonce"));
    if (record && partARecordMatchesRegistration(record, await (io.registration ?? liveRegistration)())) {
      return record.partA;
    }
    // The route runs inside the proxy its wrapper supervises: ending that wrapper is the point.
    return stop({ capMs: ROUTE_PART_A_CAP_MS, allowUnderOwnWrapper: true });
  }
  const winsw = await import("../lib/winsw");
  const winswRegistered = io.winswRegistered ?? (() => winsw.statusWinswRaw() !== "nonexistent");
  if (winswRegistered()) {
    try {
      (io.stopWinsw ?? (() => winsw.stopWinswService()))();
      return "stopped";
    } catch {
      return "failed";
    }
  }
  return stop({ capMs: ROUTE_STRAY_SWEEP_CAP_MS, allowUnderOwnWrapper: true });
}
