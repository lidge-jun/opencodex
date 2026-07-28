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

export type DashboardCorePoll = {
  health: HealthData | null;
  providers: ProviderInfo[];
  settings: SettingsData | null;
  /** Settings-derived seed payload; merge against latest startup-health at commit time. */
  startupHealthSeed: SettingsData["startupHealth"] | null | undefined;
  sidecar: SidecarData | null;
  shadowCall: ShadowCallData | null | undefined;
  maMode: "v1" | "default" | "v2";
  maModeResolved: boolean;
  /** Absent when the optional endpoint failed — callers must keep prior UI state. */
  injection: InjectionPoll | undefined;
  effortCaps: EffortCapPoll | undefined;
  error: boolean;
};

export type DashboardEpochRefs = {
  settingsRequestEpochRef: { current: number };
  settingsMutationEpochRef: { current: number };
  settingsMutationInFlightRef: { current: boolean };
  shadowCallRequestEpochRef: { current: number };
  shadowCallMutationEpochRef: { current: number };
  shadowCallMutationInFlightRef: { current: boolean };
};

export async function fetchStartupHealth(apiBase: string, signal: AbortSignal): Promise<StartupHealthStatus> {
  try {
    const response = await fetch(`${apiBase}/api/startup-health`, { signal });
    if (!response.ok) throw new Error("startup health unavailable");
    const data = await response.json() as { status?: unknown; diagnosticStale?: unknown };
    const mapped = mapStartupHealthProbe(data);
    if (!mapped) throw new Error("invalid startup health response");
    return mapped;
  } catch {
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

export async function fetchDashboardCore(
  apiBase: string,
  signal: AbortSignal,
  epochs: DashboardEpochRefs,
): Promise<DashboardCorePoll> {
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

  const empty: DashboardCorePoll = {
    health: null,
    providers: [],
    settings: null,
    startupHealthSeed: undefined,
    sidecar: null,
    shadowCall: undefined,
    maMode: "default",
    maModeResolved: true,
    injection: undefined,
    effortCaps: undefined,
    error: true,
  };

  try {
    const [hRes, pRes, sRes, scRes, shRes] = await Promise.all([
      fetch(`${apiBase}/healthz`, { signal }),
      fetch(`${apiBase}/api/providers`, { signal }),
      fetch(`${apiBase}/api/settings`, { signal }),
      fetch(`${apiBase}/api/sidecar-settings`, { signal }),
      fetch(`${apiBase}/api/shadow-call-settings`, { signal }),
    ]);

    const health = await requireJson<HealthData>(hRes);
    const providers = await requireJson<ProviderInfo[]>(pRes);
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

    let maMode: "v1" | "default" | "v2" = "default";
    let maModeResolved = false;
    try {
      const v2Res = await fetch(`${apiBase}/api/v2`, { signal });
      if (v2Res.ok) {
        const v2Data = await v2Res.json();
        if (v2Data.multiAgentMode === "v1" || v2Data.multiAgentMode === "v2") maMode = v2Data.multiAgentMode;
        else maMode = "default";
      }
    } catch { /* old server */ }
    finally { maModeResolved = true; }

    let injection: InjectionPoll | undefined;
    try {
      const imRes = await fetch(`${apiBase}/api/injection-model`, { signal });
      if (imRes.ok) {
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
      const ecRes = await fetch(`${apiBase}/api/effort-caps`, { signal });
      if (ecRes.ok) {
        const ecData = await ecRes.json() as { effortCap?: string | null; subagentEffortCap?: string | null };
        effortCaps = {
          effortCap: ecData.effortCap ?? "",
          subagentEffortCap: ecData.subagentEffortCap ?? "",
        };
      }
    } catch { /* old server */ }

    return {
      health,
      providers,
      settings,
      startupHealthSeed,
      sidecar,
      shadowCall,
      maMode,
      maModeResolved,
      injection,
      effortCaps,
      error: false,
    };
  } catch {
    return empty;
  }
}
