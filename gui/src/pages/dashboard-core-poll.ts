import { readJsonIfOk } from "../fetch-json";
import {
  beginPollEpoch,
  settingsPollMayCommit,
  mapStartupHealthProbe,
  type StartupHealthProbe,
} from "../startup-health-ui";
import {
  requireJson,
  type HealthData,
  type ModelInfo,
  type ProjectCodexConfigGroup,
  type ProviderInfo,
  type SettingsData,
  type SidecarData,
  type UsageSummary30d,
} from "./dashboard-shared";


export type InjectionSelectionResponse = {
  multiAgentGuidanceEnabled?: boolean;
  syncCodexSubagentDefaults?: boolean;
  model?: string | null;
  effort?: string | null;
};

export function normalizeInjectionSelection(data: InjectionSelectionResponse) {
  return {
    multiAgentGuidanceEnabled: data.multiAgentGuidanceEnabled !== false,
    syncCodexSubagentDefaults: data.syncCodexSubagentDefaults === true,
    injectionModel: data.model ?? "",
    injectionEffort: data.effort ?? "",
  };
}


export type DashboardOverviewPoll = {
  health: HealthData | null;
  providers: ProviderInfo[];
  error: boolean;
};


/** Sidecar only — must not wait on /api/settings (startup-health). */
export type DashboardSidecarPoll = {
  sidecar: SidecarData;
};

export type DashboardSettingsPoll = {
  /** Absent when the poll lost authority — callers must keep prior settings/cache. */
  settings: SettingsData | undefined;
  startupHealthSeed: SettingsData["startupHealth"] | null | undefined;
};


export type DashboardEpochRefs = {
  settingsRequestEpochRef: { current: number };
  settingsMutationEpochRef: { current: number };
  settingsMutationInFlightRef: { current: boolean };
};

function isAbortError(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  return error instanceof Error && error.name === "AbortError";
}

export async function fetchStartupHealth(apiBase: string, signal: AbortSignal): Promise<StartupHealthProbe> {
  try {
    const response = await fetch(`${apiBase}/api/startup-health`, { signal });
    if (!response.ok) throw new Error("startup health unavailable");
    const data = await response.json() as { status?: unknown; diagnosticStale?: unknown };
    const mapped = mapStartupHealthProbe(data);
    if (!mapped) throw new Error("invalid startup health response");
    // Carry `stale` through so the caller can re-ask in seconds instead of waiting for
    // the next 30s poll tick while the server resolves the real answer.
    return { status: mapped, stale: data.diagnosticStale === true };
  } catch (error) {
    // Aborts must propagate so client-resource can discard the generation.
    // Swallowing them as "error" briefly shows "Could not read startup protection"
    // after refresh / remount races.
    if (isAbortError(error, signal)) throw error;
    return { status: "error", stale: false };
  }
}

export async function fetchProjectConfigDiagnostics(
  apiBase: string,
  signal: AbortSignal,
): Promise<ProjectCodexConfigGroup[]> {
  try {
    const pcRes = await fetch(`${apiBase}/api/diagnostics/project-config`, { signal });
    const pcData = await readJsonIfOk<{ grouped?: ProjectCodexConfigGroup[] }>(pcRes);
    return pcData?.grouped ?? [];
  } catch {
    return [];
  }
}

export async function fetchDashboardModels(apiBase: string, signal: AbortSignal): Promise<ModelInfo[]> {
  const response = await fetch(`${apiBase}/api/models`, { signal });
  // Throw on non-OK / empty so client-resource retains the prior snapshot instead of
  // treating an HTTP error as a successful empty list.
  return requireJson<ModelInfo[]>(response);
}

export async function fetchDashboardUsage(apiBase: string, signal: AbortSignal): Promise<UsageSummary30d> {
  const response = await fetch(`${apiBase}/api/usage?range=30d`, { signal });
  // Usage can be expensive on an older server. Keeping it in its own resource means
  // it cannot delay health/provider/settings commits, and a failed refresh retains
  // the last good usage snapshot.
  return requireJson<UsageSummary30d>(response);
}

/** Web-search / vision sidecar — a config read, typically sub-10ms. */
export async function fetchDashboardSidecars(
  apiBase: string,
  signal: AbortSignal,
): Promise<DashboardSidecarPoll> {
  const scRes = await fetch(`${apiBase}/api/sidecar-settings`, { signal });
  const sidecar = await requireJson<SidecarData>(scRes);
  return { sidecar };
}

/** Codex auto-start + startup-health seed — can be slower because settings embeds startup probe. */
export async function fetchDashboardSettings(
  apiBase: string,
  signal: AbortSignal,
  epochs: DashboardEpochRefs,
): Promise<DashboardSettingsPoll> {
  const { request: settingsRequestEpoch, mutation: settingsMutationEpoch } = beginPollEpoch(
    epochs.settingsRequestEpochRef,
    epochs.settingsMutationEpochRef,
  );

  const sRes = await fetch(`${apiBase}/api/settings`, { signal });
  const nextSettings = await requireJson<SettingsData>(sRes);
  let settings: SettingsData | undefined = undefined;
  let startupHealthSeed: SettingsData["startupHealth"] | null | undefined = undefined;
  if (settingsPollMayCommit(
    { request: settingsRequestEpoch, mutation: settingsMutationEpoch },
    {
      request: epochs.settingsRequestEpochRef.current,
      mutation: epochs.settingsMutationEpochRef.current,
      mutationInFlight: epochs.settingsMutationInFlightRef.current,
    },
  )) {
    settings = nextSettings;
    startupHealthSeed = nextSettings.startupHealth;
  }

  return { settings, startupHealthSeed };
}

export async function fetchDashboardOverview(
  apiBase: string,
  signal: AbortSignal,
): Promise<DashboardOverviewPoll> {
  try {
    const [hRes, pRes] = await Promise.all([
      fetch(`${apiBase}/api/system/health`, { signal }),
      fetch(`${apiBase}/api/providers`, { signal }),
    ]);
    const health = await requireJson<HealthData>(hRes);
    const providers = await requireJson<ProviderInfo[]>(pRes);
    return { health, providers, error: false };
  } catch {
    return { health: null, providers: [], error: true };
  }
}

