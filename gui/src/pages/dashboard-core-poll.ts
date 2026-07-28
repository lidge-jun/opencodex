import { readJsonIfOk } from "../fetch-json";
import {
  settingsPollMayCommit,
  beginPollEpochs,
  mapStartupHealthProbe,
  type StartupHealthStatus,
} from "../startup-health-ui";
import {
  requireJson,
  type HealthData,
  type ModelInfo,
  type ProjectCodexConfigGroup,
  type ProviderInfo,
  type SettingsData,
  type ShadowCallData,
  type SidecarData,
  type UsageSummary30d,
} from "./dashboard-shared";

export type InjectionPoll = {
  multiAgentGuidanceEnabled: boolean;
  syncCodexSubagentDefaults: boolean;
  injectionModel: string;
  injectionEffort: string;
  injectionEfforts: string[];
  injectionAvailable: Array<{ provider: string; model: string; namespaced: string }>;
};

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

export type EffortCapPoll = {
  effortCap: string;
  subagentEffortCap: string;
};

export type DashboardOverviewPoll = {
  health: HealthData | null;
  providers: ProviderInfo[];
  error: boolean;
};

/** Multi-agent extras — slower peers must not gate status/uptime/provider counts. */
export type DashboardMultiAgentPoll = {
  maMode: "v1" | "default" | "v2";
  maModeResolved: boolean;
  /** Absent when the optional endpoint failed — callers must keep prior UI state. */
  injection: InjectionPoll | undefined;
  effortCaps: EffortCapPoll | undefined;
};

export type DashboardCorePoll = DashboardOverviewPoll & DashboardMultiAgentPoll;

/** Fast path for interactive toggles/selects — must not wait on health/providers/usage. */
export type DashboardControlsPoll = {
  settings: SettingsData | null;
  /** Settings-derived seed payload; merge against latest startup-health at commit time. */
  startupHealthSeed: SettingsData["startupHealth"] | null | undefined;
  sidecar: SidecarData | null;
  shadowCall: ShadowCallData | null | undefined;
};

export type DashboardEpochRefs = {
  settingsRequestEpochRef: { current: number };
  settingsMutationEpochRef: { current: number };
  settingsMutationInFlightRef: { current: boolean };
  shadowCallRequestEpochRef: { current: number };
  shadowCallMutationEpochRef: { current: number };
  shadowCallMutationInFlightRef: { current: boolean };
};

function isAbortError(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  return error instanceof Error && error.name === "AbortError";
}

export async function fetchStartupHealth(apiBase: string, signal: AbortSignal): Promise<StartupHealthStatus> {
  try {
    const response = await fetch(`${apiBase}/api/startup-health`, { signal });
    if (!response.ok) throw new Error("startup health unavailable");
    const data = await response.json() as { status?: unknown; diagnosticStale?: unknown };
    const mapped = mapStartupHealthProbe(data);
    if (!mapped) throw new Error("invalid startup health response");
    return mapped;
  } catch (error) {
    // Aborts must propagate so client-resource can discard the generation.
    // Swallowing them as "error" briefly shows "Could not read startup protection"
    // after refresh / remount races.
    if (isAbortError(error, signal)) throw error;
    return "error";
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

/**
 * Interactive dashboard controls (auto-start, sidecar, shadow-call). Fetched on their
 * own poll so a slow healthz/providers response cannot gray out toggles/selects.
 */
export async function fetchDashboardControls(
  apiBase: string,
  signal: AbortSignal,
  epochs: DashboardEpochRefs,
): Promise<DashboardControlsPoll> {
  const epochSnapshot = beginPollEpochs({
    settingsRequest: epochs.settingsRequestEpochRef,
    settingsMutation: epochs.settingsMutationEpochRef,
    shadowRequest: epochs.shadowCallRequestEpochRef,
    shadowMutation: epochs.shadowCallMutationEpochRef,
  });
  const settingsRequestEpoch = epochSnapshot.settings.request;
  const settingsMutationEpoch = epochSnapshot.settings.mutation;
  const shadowRequestEpoch = epochSnapshot.shadow.request;
  const shadowMutationEpoch = epochSnapshot.shadow.mutation;

  const [sRes, scRes, shRes] = await Promise.all([
    fetch(`${apiBase}/api/settings`, { signal }),
    fetch(`${apiBase}/api/sidecar-settings`, { signal }),
    fetch(`${apiBase}/api/shadow-call-settings`, { signal }),
  ]);

  const nextSettings = await requireJson<SettingsData>(sRes);
  let settings: SettingsData | null = null;
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

  const sidecar = await requireJson<SidecarData>(scRes);
  let shadowCall: ShadowCallData | null | undefined = undefined;
  try {
    if (shRes.ok) {
      const nextShadow = await shRes.json() as ShadowCallData;
      if (settingsPollMayCommit(
        { request: shadowRequestEpoch, mutation: shadowMutationEpoch },
        {
          request: epochs.shadowCallRequestEpochRef.current,
          mutation: epochs.shadowCallMutationEpochRef.current,
          mutationInFlight: epochs.shadowCallMutationInFlightRef.current,
        },
      )) {
        shadowCall = nextShadow;
      }
    }
  } catch {
    if (settingsPollMayCommit(
      { request: shadowRequestEpoch, mutation: shadowMutationEpoch },
      {
        request: epochs.shadowCallRequestEpochRef.current,
        mutation: epochs.shadowCallMutationEpochRef.current,
        mutationInFlight: epochs.shadowCallMutationInFlightRef.current,
      },
    )) {
      shadowCall = null;
    }
  }

  return { settings, startupHealthSeed, sidecar, shadowCall };
}

export async function fetchDashboardOverview(
  apiBase: string,
  signal: AbortSignal,
): Promise<DashboardOverviewPoll> {
  try {
    const [hRes, pRes] = await Promise.all([
      fetch(`${apiBase}/healthz`, { signal }),
      fetch(`${apiBase}/api/providers`, { signal }),
    ]);
    const health = await requireJson<HealthData>(hRes);
    const providers = await requireJson<ProviderInfo[]>(pRes);
    return { health, providers, error: false };
  } catch {
    return { health: null, providers: [], error: true };
  }
}

export async function fetchDashboardMultiAgent(
  apiBase: string,
  signal: AbortSignal,
): Promise<DashboardMultiAgentPoll> {
  const [v2Res, imRes, ecRes] = await Promise.all([
    fetch(`${apiBase}/api/v2`, { signal }).catch(() => null),
    fetch(`${apiBase}/api/injection-model`, { signal }).catch(() => null),
    fetch(`${apiBase}/api/effort-caps`, { signal }).catch(() => null),
  ]);

  let maMode: "v1" | "default" | "v2" = "default";
  let maModeResolved = false;
  try {
    if (v2Res?.ok) {
      const v2Data = await v2Res.json();
      if (v2Data.multiAgentMode === "v1" || v2Data.multiAgentMode === "v2") maMode = v2Data.multiAgentMode;
      else maMode = "default";
    }
  } catch { /* old server */ }
  finally { maModeResolved = true; }

  let injection: InjectionPoll | undefined;
  try {
    if (imRes?.ok) {
      const imData = await imRes.json() as InjectionSelectionResponse & {
        efforts?: string[];
        available?: InjectionPoll["injectionAvailable"];
      };
      injection = {
        ...normalizeInjectionSelection(imData),
        injectionEfforts: imData.efforts ?? [],
        injectionAvailable: imData.available ?? [],
      };
    }
  } catch { /* old server / malformed — keep prior UI state */ }

  let effortCaps: EffortCapPoll | undefined;
  try {
    if (ecRes?.ok) {
      const ecData = await ecRes.json() as { effortCap?: string | null; subagentEffortCap?: string | null };
      effortCaps = {
        effortCap: ecData.effortCap ?? "",
        subagentEffortCap: ecData.subagentEffortCap ?? "",
      };
    }
  } catch { /* old server */ }

  return { maMode, maModeResolved, injection, effortCaps };
}

/** @deprecated Prefer fetchDashboardOverview + fetchDashboardMultiAgent for progressive paint. */
export async function fetchDashboardCore(
  apiBase: string,
  signal: AbortSignal,
): Promise<DashboardCorePoll> {
  const [overview, multiAgent] = await Promise.all([
    fetchDashboardOverview(apiBase, signal),
    fetchDashboardMultiAgent(apiBase, signal),
  ]);
  return { ...overview, ...multiAgent };
}
