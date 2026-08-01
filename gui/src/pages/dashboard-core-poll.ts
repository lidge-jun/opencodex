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
  /** Absent when the optional endpoint failed — callers must keep prior UI state. */
  injection: InjectionPoll | undefined;
  effortCaps: EffortCapPoll | undefined;
};

/** Sidecar + shadow only — must not wait on /api/settings (startup-health). */
export type DashboardSidecarPoll = {
  sidecar: SidecarData;
  /**
   * `null` = authoritative endpoint failure (clear UI).
   * `undefined` = lost poll authority (epoch gate) — do not commit.
   */
  shadowCall: ShadowCallData | null | undefined;
};

export type DashboardSettingsPoll = {
  /** Absent when the poll lost authority — callers must keep prior settings/cache. */
  settings: SettingsData | undefined;
  startupHealthSeed: SettingsData["startupHealth"] | null | undefined;
};

export type DashboardMaModePoll = {
  maMode: "v1" | "default" | "v2";
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

/** Web-search / vision sidecar + shadow-call — config reads, typically sub-10ms. */
export async function fetchDashboardSidecars(
  apiBase: string,
  signal: AbortSignal,
  epochs: DashboardEpochRefs,
): Promise<DashboardSidecarPoll> {
  // Only bump shadow epochs — settings has its own poll and must not be invalidated here.
  const { request: shadowRequestEpoch, mutation: shadowMutationEpoch } = beginPollEpoch(
    epochs.shadowCallRequestEpochRef,
    epochs.shadowCallMutationEpochRef,
  );

  const [scRes, shRes] = await Promise.all([
    fetch(`${apiBase}/api/sidecar-settings`, { signal }),
    fetch(`${apiBase}/api/shadow-call-settings`, { signal }),
  ]);

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
    } else if (settingsPollMayCommit(
      { request: shadowRequestEpoch, mutation: shadowMutationEpoch },
      {
        request: epochs.shadowCallRequestEpochRef.current,
        mutation: epochs.shadowCallMutationEpochRef.current,
        mutationInFlight: epochs.shadowCallMutationInFlightRef.current,
      },
    )) {
      shadowCall = null;
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

  return { sidecar, shadowCall };
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

/** Multi-agent mode toggle only — must not wait on injection-model / effort-caps. */
export async function fetchDashboardMaMode(
  apiBase: string,
  signal: AbortSignal,
): Promise<DashboardMaModePoll> {
  try {
    const v2Res = await fetch(`${apiBase}/api/v2`, { signal });
    if (!v2Res.ok) return { maMode: "default" };
    const v2Data = await v2Res.json() as { multiAgentMode?: unknown };
    if (v2Data.multiAgentMode === "v1" || v2Data.multiAgentMode === "v2") {
      return { maMode: v2Data.multiAgentMode };
    }
    return { maMode: "default" };
  } catch (error) {
    if (isAbortError(error, signal)) throw error;
    return { maMode: "default" };
  }
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
  const [imRes, ecRes] = await Promise.all([
    fetch(`${apiBase}/api/injection-model`, { signal }).catch(() => null),
    fetch(`${apiBase}/api/effort-caps`, { signal }).catch(() => null),
  ]);

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

  return { injection, effortCaps };
}
