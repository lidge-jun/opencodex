import type { TKey } from "./i18n/shared";

export interface StartupRiskDetail {
  routingKind: "native" | "opencodex-local" | "custom-local" | "custom-remote" | "unknown";
  shimCoverage: "full" | "cli-only" | "none";
}

export function startupRiskDetailKey(health: StartupRiskDetail): TKey {
  if (health.routingKind === "custom-local") return "startup.riskDetailCustomLocal";
  if (health.shimCoverage === "cli-only") return "startup.riskDetailWindowsShim";
  return "startup.riskDetail";
}

export interface SettingsPollEpoch {
  request: number;
  mutation: number;
}

export function settingsPollMayCommit(
  started: SettingsPollEpoch,
  current: SettingsPollEpoch & { mutationInFlight: boolean },
): boolean {
  return !current.mutationInFlight
    && started.request === current.request
    && started.mutation === current.mutation;
}

/** Snapshot + bump one request epoch before issuing a poll fetch. */
export function beginPollEpoch(
  request: { current: number },
  mutation: { current: number },
): SettingsPollEpoch {
  return {
    request: ++request.current,
    mutation: mutation.current,
  };
}

/** Snapshot + bump request epochs before issuing paired settings/shadow poll fetches. */
export function beginPollEpochs(refs: {
  settingsRequest: { current: number };
  settingsMutation: { current: number };
  shadowRequest: { current: number };
  shadowMutation: { current: number };
}): {
  settings: SettingsPollEpoch;
  shadow: SettingsPollEpoch;
} {
  return {
    settings: beginPollEpoch(refs.settingsRequest, refs.settingsMutation),
    shadow: beginPollEpoch(refs.shadowRequest, refs.shadowMutation),
  };
}

export type StartupHealthStatus = "native" | "protected" | "at-risk" | "error";

/**
 * Probe result for the dashboard chip: the status plus whether the server answered from
 * its stale-while-revalidate fallback.
 *
 * The status alone is not enough. `/api/startup-health` answers immediately from a 30s
 * cache and kicks the real probe off in the background, so the first response after a
 * cold start (or after the TTL expires) is a conservative placeholder. A consumer that
 * only reads the status has no way to know it should look again soon, and on the
 * dashboard that meant the chip sat on the placeholder until the next 30s poll — which
 * is why clicking "refresh quota" (any action that re-mounted the chip) appeared to be
 * what fixed it.
 */
export interface StartupHealthProbe {
  status: StartupHealthStatus;
  /** True while the server is still resolving the real answer in the background. */
  stale: boolean;
}

/** How soon to re-ask after a stale answer; matches the Startup page's follow-up delay. */
export const STARTUP_HEALTH_STALE_RETRY_MS = 2_000;

/**
 * Map a startup-health API payload to the dashboard chip status.
 *
 * `diagnosticStale` means the server is still refreshing (SWR fallback / expired TTL).
 * That is NOT a hard read failure — collapsing it to "error" shows the misleading
 * "Could not read startup protection" chip whenever the 30s cache misses.
 * Keep the payload status (the cache already forces at-risk for local-proxy routing
 * when stale). Reserve "error" for fetchStartupHealth hard failures only.
 */
export function mapStartupHealthProbe(data: {
  status?: unknown;
  diagnosticStale?: unknown;
}): StartupHealthStatus | null {
  const status = data.status;
  const valid = status === "native" || status === "protected" || status === "at-risk";
  if (!valid) return null;
  return status;
}

/** True when a probe result should be re-fetched shortly instead of waiting for the poll. */
export function probeNeedsFastRetry(probe: StartupHealthProbe | undefined | null): boolean {
  if (!probe) return false;
  // A hard error is retried by the normal poll; only an in-progress server refresh
  // resolves on its own within seconds.
  return probe.stale && probe.status !== "error";
}

/**
 * Settings may only seed startup health while it is still unknown or a hard error.
 * After `/api/startup-health` has produced a real status, it stays authoritative.
 */
export function seedStartupHealthFromSettings(
  previous: StartupHealthStatus | null,
  seeded: { status: "native" | "protected" | "at-risk"; diagnosticStale: boolean } | null | undefined,
): StartupHealthStatus | null {
  if (!seeded) return previous;
  // A prior hard "error" (or unknown) may be replaced by a settings seed; a real
  // status from the dedicated probe must not be overwritten.
  if (previous !== null && previous !== "error") return previous;
  return seeded.status;
}

/** Single owner cadence for project-config diagnostics (ms). */
export const PROJECT_CONFIG_DIAGNOSTICS_POLL_MS = 30_000;
