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

/** Snapshot + bump request epochs before issuing any poll fetches. */
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
    settings: {
      request: ++refs.settingsRequest.current,
      mutation: refs.settingsMutation.current,
    },
    shadow: {
      request: ++refs.shadowRequest.current,
      mutation: refs.shadowMutation.current,
    },
  };
}

export type StartupHealthStatus = "native" | "protected" | "at-risk" | "error";

export function mapStartupHealthProbe(data: {
  status?: unknown;
  diagnosticStale?: unknown;
}): StartupHealthStatus | null {
  const status = data.status;
  const valid = status === "native" || status === "protected" || status === "at-risk";
  if (!valid) return null;
  return data.diagnosticStale === true ? "error" : status;
}

/**
 * Settings may only seed startup health while it is still unknown.
 * After `/api/startup-health` has produced a value, it stays authoritative.
 */
export function seedStartupHealthFromSettings(
  previous: StartupHealthStatus | null,
  seeded: { status: "native" | "protected" | "at-risk"; diagnosticStale: boolean } | null | undefined,
): StartupHealthStatus | null {
  if (previous !== null) return previous;
  if (!seeded) return null;
  return seeded.diagnosticStale ? "error" : seeded.status;
}

/** Single owner cadence for project-config diagnostics (ms). */
export const PROJECT_CONFIG_DIAGNOSTICS_POLL_MS = 30_000;
