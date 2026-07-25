import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { formatUptime } from "../formatUptime";
import MemoryObservabilityCard from "../components/MemoryObservabilityCard";
import { IconAlert, IconChevron, IconExternal, IconInfo, IconRefresh, IconSearch, IconX } from "../icons";
import { Trans } from "../i18n/provider";
import { useI18n, type TKey } from "../i18n/shared";
import { settingsPollMayCommit, beginPollEpochs, mapStartupHealthProbe, seedStartupHealthFromSettings, PROJECT_CONFIG_DIAGNOSTICS_POLL_MS, type StartupHealthStatus } from "../startup-health-ui";
import { formatTokens } from "../format-tokens";
import { EmptyState, Select } from "../ui";
import { navigateHash } from "../hash-routing";

/** Dashboard section tabs, mirroring the Logs hash-tab contract. */
type DashboardSection = "overview" | "providers" | "models";

function readDashboardSectionFromHash(): DashboardSection {
  const raw = window.location.hash.replace(/^#\/?/, "");
  if (raw === "dashboard/providers") return "providers";
  if (raw === "dashboard/models") return "models";
  return "overview";
}

/** Overview is the bare `#dashboard`; the other sections carry a suffix. */
function dashboardHashForSection(section: DashboardSection): string {
  return section === "overview" ? "dashboard" : `dashboard/${section}`;
}

interface HealthData { status: string; version: string; uptime: number }
// StartupHealthStatus imported from startup-health-ui.
interface ProviderInfo { name: string; adapter: string; baseUrl: string; defaultModel?: string; hasApiKey: boolean }
interface ModelInfo { id: string; provider: string; owned_by?: string }
interface SettingsData {
  codexAutoStart: boolean;
  port: number;
  hostname: string;
  startupHealth?: {
    status: "native" | "protected" | "at-risk";
    routingKind: "native" | "opencodex-local" | "custom-local" | "custom-remote" | "unknown";
    autostartEnabled: boolean;
    shimCoverage: "full" | "cli-only" | "none";
    diagnosticStale: boolean;
  };
}
type SidecarBackend = "openai" | "anthropic";
interface SidecarSetting { backend?: SidecarBackend; model: string }
interface SidecarData { webSearch: SidecarSetting; vision: SidecarSetting }
interface SidecarPatch {
  webSearch?: { backend?: SidecarBackend | null; model?: string };
  vision?: { backend?: SidecarBackend | null; model?: string };
}
interface ShadowCallData { enabled: boolean; model: string }
interface UsageSummary30d { summary: { requests: number; totalTokens: number; coverageRatio: number } }
type UpdateChannel = "latest" | "preview";
type Installer = "npm" | "bun" | "source";
type UpdateJobStatus = "running" | "restarting" | "succeeded" | "failed";
interface SyncResult {
  ok: boolean;
  added: number;
  catalogPath: string | null;
  catalogExists: boolean;
  cacheSynced: boolean;
  message: string;
  warning?: string;
  staleAppServerHint?: string;
  projectConfigWarnings?: ProjectCodexConfigWarning[];
}
interface ProjectCodexConfigWarning {
  path: string;
  code: string;
  detail: string;
  message: string;
}
interface ProjectCodexConfigGroup {
  path: string;
  issues: string[];
  bypass: string;
}
interface UpdateCheckData {
  currentVersion: string;
  latestVersion: string | null;
  channel: UpdateChannel;
  installer: Installer;
  updateAvailable: boolean;
  canUpdate: boolean;
  command: string;
  releaseNotesUrl: string;
  reason?: string;
}
interface UpdateJob {
  id: string;
  status: UpdateJobStatus;
  currentVersion: string;
  latestVersion: string | null;
  channel: UpdateChannel;
  installer: Installer;
  restart: boolean;
  command: string;
  log: string[];
  error?: string;
  restarted?: boolean;
}


const EFFORT_CAP_LEVELS = ["low", "medium", "high", "xhigh"];
const UPDATE_CHECK_MAX_AUTO_RETRIES = 2;
const UPDATE_CHECK_RETRY_BASE_MS = 800;

function defaultUpdateChannel(version: string | undefined): UpdateChannel {
  return version?.includes("-preview.") ? "preview" : "latest";
}

function updateReasonLabel(reason: string | undefined, t: (key: TKey) => string): string {
  switch (reason) {
    case "source_checkout": return t("dash.updateReason.source_checkout");
    case "latest_unavailable": return t("dash.updateReason.latest_unavailable");
    case "already_latest": return t("dash.updateReason.already_latest");
    default: return t("dash.updateReason.unknown");
  }
}

function updateJobLabel(status: UpdateJobStatus, t: (key: TKey) => string): string {
  switch (status) {
    case "running": return t("dash.updateStatus.running");
    case "restarting": return t("dash.updateStatus.restarting");
    case "succeeded": return t("dash.updateStatus.succeeded");
    case "failed": return t("dash.updateStatus.failed");
  }
}

function mergeSidecarSetting(
  current: SidecarSetting,
  update?: { backend?: SidecarBackend | null; model?: string },
): SidecarSetting {
  const merged = { ...current };
  if (update?.model !== undefined) merged.model = update.model;
  if (update?.backend === null) delete merged.backend;
  else if (update?.backend !== undefined) merged.backend = update.backend;
  return merged;
}

function sidecarModelOptions(models: ModelInfo[]) {
  return models
    .filter(model => model.provider === "openai" || model.provider === "anthropic")
    .map(model => ({ value: model.id, label: `${model.provider}/${model.id}` }));
}

function sidecarBackendForModel(models: ModelInfo[], modelId: string): SidecarBackend {
  return models.find(model => model.id === modelId)?.provider === "anthropic" ? "anthropic" : "openai";
}

/**
 * Last input modality, tracked window-wide. Quiet focus restore is only correct for
 * POINTER-originated closes; a keyboard close (Escape / Enter / Space) must keep the
 * visible :focus-visible ring or keyboard users lose their location on close.
 */
let lastInputWasKeyboard = false;
if (typeof window !== "undefined") {
  window.addEventListener("keydown", () => { lastInputWasKeyboard = true; }, { capture: true, passive: true });
  window.addEventListener("pointerdown", () => { lastInputWasKeyboard = false; }, { capture: true, passive: true });
}

/**
 * Restore focus to the opener. Pointer closes suppress :focus-visible (avoids the
 * sticky double ring after a mouse close); keyboard closes restore plain focus so the
 * ring paints. `focusVisible` support is Chrome 145+/FF 104+/Safari 18.4+ — engines
 * that ignore the option keep the pre-repair behavior, which the origin tracking
 * already makes correct for keyboard users everywhere.
 */
function focusTriggerQuietly(trigger: HTMLButtonElement | null) {
  if (!trigger) return;
  if (lastInputWasKeyboard) {
    trigger.focus({ preventScroll: true });
    return;
  }
  try {
    trigger.focus({ preventScroll: true, focusVisible: false });
  } catch {
    trigger.focus({ preventScroll: true });
  }
}

function useModalDialog(open: boolean, triggerRef: RefObject<HTMLButtonElement | null>) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open) {
      if (!dialog.open) dialog.showModal();
      return;
    }

    if (dialog.open) dialog.close();
    focusTriggerQuietly(triggerRef.current);
  }, [open, triggerRef]);

  useEffect(() => () => {
    const dialog = dialogRef.current;
    if (dialog?.open) dialog.close();
    focusTriggerQuietly(triggerRef.current);
  }, [triggerRef]);

  return dialogRef;
}

export default function Dashboard({ apiBase }: { apiBase: string }) {
  const { locale, t } = useI18n();
  // The hash is the source of truth for the active section (#dashboard,
  // #dashboard/providers, #dashboard/models), so refresh/bookmark/back-forward keep
  // the choice. Mirrors the Logs tab contract.
  const [selectedSection, setSelectedSection] = useState<DashboardSection>(readDashboardSectionFromHash);

  useEffect(() => {
    const onHash = () => setSelectedSection(readDashboardSectionFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const [modelQuery, setModelQuery] = useState("");
  const [expandedProviders, setExpandedProviders] = useState<Set<string>>(new Set());
  const [health, setHealth] = useState<HealthData | null>(null);
  const [startupHealth, setStartupHealth] = useState<StartupHealthStatus | null>(null);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [sidecar, setSidecar] = useState<SidecarData | null>(null);
  const [shadowCall, setShadowCall] = useState<ShadowCallData | null>(null);
  const [usage30d, setUsage30d] = useState<UsageSummary30d | null>(null);
  const [sidecarSaving, setSidecarSaving] = useState(false);
  const [shadowCallSaving, setShadowCallSaving] = useState(false);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [maMode, setMaMode] = useState<"v1" | "default" | "v2">("default");
  const [maModeResolved, setMaModeResolved] = useState(false);
  const [maBusy, setMaBusy] = useState(false);
  const [maHelpOpen, setMaHelpOpen] = useState(false);
  const [effortCapHelpOpen, setEffortCapHelpOpen] = useState(false);
  const [shadowCallHelpOpen, setShadowCallHelpOpen] = useState(false);
  const [injectionModel, setInjectionModel] = useState<string>("");
  const [injectionEffort, setInjectionEffort] = useState<string>("");
  const [injectionEfforts, setInjectionEfforts] = useState<string[]>([]);
  const [injectionAvailable, setInjectionAvailable] = useState<Array<{ provider: string; model: string; namespaced: string }>>([]);
  const [injectionSaving, setInjectionSaving] = useState(false);
  const [multiAgentGuidanceEnabled, setMultiAgentGuidanceEnabled] = useState(true);
  const [effortCap, setEffortCap] = useState<string>("");
  const [subagentEffortCap, setSubagentEffortCap] = useState<string>("");
  const [effortCapSaving, setEffortCapSaving] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [projectConfigWarnings, setProjectConfigWarnings] = useState<ProjectCodexConfigGroup[]>([]);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [updateChannel, setUpdateChannel] = useState<UpdateChannel>("latest");
  const [updateRestart, setUpdateRestart] = useState(true);
  const [updateLoading, setUpdateLoading] = useState(false);
  const updateRetryRef = useRef(0);
  const updateRetryTimerRef = useRef<number | null>(null);
  const updateRequestEpochRef = useRef(0);
  const settingsRequestEpochRef = useRef(0);
  const settingsMutationEpochRef = useRef(0);
  const settingsMutationInFlightRef = useRef(false);
  const shadowCallRequestEpochRef = useRef(0);
  const shadowCallMutationEpochRef = useRef(0);
  const shadowCallMutationInFlightRef = useRef(false);
  const [updateCheck, setUpdateCheck] = useState<UpdateCheckData | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [updateJob, setUpdateJob] = useState<UpdateJob | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [error, setError] = useState(false);
  const effortCapHelpTriggerRef = useRef<HTMLButtonElement>(null);
  const updateTriggerRef = useRef<HTMLButtonElement>(null);
  const maHelpTriggerRef = useRef<HTMLButtonElement>(null);
  const shadowCallHelpTriggerRef = useRef<HTMLButtonElement>(null);
  const effortCapHelpDialogRef = useModalDialog(effortCapHelpOpen, effortCapHelpTriggerRef);
  const updateDialogRef = useModalDialog(updateOpen, updateTriggerRef);
  const maHelpDialogRef = useModalDialog(maHelpOpen, maHelpTriggerRef);
  const shadowCallHelpDialogRef = useModalDialog(shadowCallHelpOpen, shadowCallHelpTriggerRef);

  useEffect(() => () => {
    updateRequestEpochRef.current += 1;
    if (updateRetryTimerRef.current !== null) {
      window.clearTimeout(updateRetryTimerRef.current);
      updateRetryTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const readStartupHealth = async () => {
      try {
        const response = await fetch(`${apiBase}/api/startup-health`);
        if (!response.ok) throw new Error("startup health unavailable");
        const data = await response.json() as { status?: unknown; diagnosticStale?: unknown };
        const mapped = mapStartupHealthProbe(data);
        if (!mapped) throw new Error("invalid startup health response");
        if (!cancelled) setStartupHealth(mapped);
      } catch {
        if (!cancelled) setStartupHealth("error");
      }
    };
    void readStartupHealth();
    const interval = window.setInterval(() => { void readStartupHealth(); }, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [apiBase]);

  useEffect(() => {
    const fetchData = async () => {
      // Snapshot epochs before issuing fetches so an in-flight poll cannot commit
      // after a later mutation or overlapping poll identity change.
      const epochs = beginPollEpochs({
        settingsRequest: settingsRequestEpochRef,
        settingsMutation: settingsMutationEpochRef,
        shadowRequest: shadowCallRequestEpochRef,
        shadowMutation: shadowCallMutationEpochRef,
      });
      const settingsRequestEpoch = epochs.settings.request;
      const settingsMutationEpoch = epochs.settings.mutation;
      const shadowRequestEpoch = epochs.shadow.request;
      const shadowMutationEpoch = epochs.shadow.mutation;
      try {
        const [hRes, pRes, sRes, scRes, shRes, uRes] = await Promise.all([
          fetch(`${apiBase}/healthz`),
          fetch(`${apiBase}/api/providers`),
          fetch(`${apiBase}/api/settings`),
          fetch(`${apiBase}/api/sidecar-settings`),
          fetch(`${apiBase}/api/shadow-call-settings`),
          fetch(`${apiBase}/api/usage?range=30d`),
        ]);
        setHealth(await hRes.json());
        setProviders(await pRes.json());
        const nextSettings = await sRes.json() as SettingsData;
        if (settingsPollMayCommit(
          { request: settingsRequestEpoch, mutation: settingsMutationEpoch },
          {
            request: settingsRequestEpochRef.current,
            mutation: settingsMutationEpochRef.current,
            mutationInFlight: settingsMutationInFlightRef.current,
          },
        )) {
          setSettings(nextSettings);
          const seeded = nextSettings.startupHealth;
          setStartupHealth(previous => seedStartupHealthFromSettings(previous, seeded));
        }
        setSidecar(await scRes.json());
        // Old servers fall through to the SPA HTML for this route; don't let a parse
        // failure here take down the whole dashboard.
        try {
          if (shRes.ok) {
            const nextShadow = await shRes.json() as ShadowCallData;
            // Ignore polls that raced a user toggle — otherwise the switch flips back
            // to the pre-write value for a few seconds until the next poll.
            if (settingsPollMayCommit(
              { request: shadowRequestEpoch, mutation: shadowMutationEpoch },
              {
                request: shadowCallRequestEpochRef.current,
                mutation: shadowCallMutationEpochRef.current,
                mutationInFlight: shadowCallMutationInFlightRef.current,
              },
            )) {
              setShadowCall(nextShadow);
            }
          }
        } catch {
          // Same epoch gate as success: a parse failure must not null optimistic UI
          // while a save is in flight or a newer poll owns the request identity.
          if (settingsPollMayCommit(
            { request: shadowRequestEpoch, mutation: shadowMutationEpoch },
            {
              request: shadowCallRequestEpochRef.current,
              mutation: shadowCallMutationEpochRef.current,
              mutationInFlight: shadowCallMutationInFlightRef.current,
            },
          )) {
            setShadowCall(null);
          }
        }
        try { setUsage30d(uRes.ok ? await uRes.json() : null); } catch { setUsage30d(null); }
        setError(false);
        // Best-effort v2 mode fetch (independent of core health)
        try {
          const v2Res = await fetch(`${apiBase}/api/v2`);
          if (v2Res.ok) {
            const v2Data = await v2Res.json();
            if (v2Data.multiAgentMode === "v1" || v2Data.multiAgentMode === "v2") setMaMode(v2Data.multiAgentMode);
            else setMaMode("default");
          }
        } catch { /* old server */ }
        finally { setMaModeResolved(true); }
        try {
          const imRes = await fetch(`${apiBase}/api/injection-model`);
          if (imRes.ok) {
            const imData = await imRes.json() as { multiAgentGuidanceEnabled?: boolean; model?: string | null; effort?: string | null; efforts?: string[]; available?: Array<{ provider: string; model: string; namespaced: string }> };
            setMultiAgentGuidanceEnabled(imData.multiAgentGuidanceEnabled !== false);
            setInjectionModel(imData.model ?? "");
            setInjectionEffort(imData.effort ?? "");
            setInjectionEfforts(imData.efforts ?? []);
            setInjectionAvailable(imData.available ?? []);
          }
        } catch { /* old server */ }
        try {
          const ecRes = await fetch(`${apiBase}/api/effort-caps`);
          if (ecRes.ok) {
            const ecData = await ecRes.json() as { effortCap?: string | null; subagentEffortCap?: string | null; efforts?: string[] };
            setEffortCap(ecData.effortCap ?? "");
            setSubagentEffortCap(ecData.subagentEffortCap ?? "");
          }
        } catch { /* old server */ }
      } catch {
        setError(true);
        setMaModeResolved(true);
      }
    };
    fetchData();
    const interval = setInterval(fetchData, 5000);
    return () => {
      clearInterval(interval);
      settingsRequestEpochRef.current += 1;
      shadowCallRequestEpochRef.current += 1;
    };
  }, [apiBase]);

  useEffect(() => {
    const fetchDiagnostics = async () => {
      try {
        const pcRes = await fetch(`${apiBase}/api/diagnostics/project-config`);
        const pcData = pcRes.ok ? await pcRes.json() as { grouped?: ProjectCodexConfigGroup[] } : null;
        setProjectConfigWarnings(pcData?.grouped ?? []);
      } catch {
        setProjectConfigWarnings([]);
      }
    };
    void fetchDiagnostics();
    const interval = setInterval(() => void fetchDiagnostics(), PROJECT_CONFIG_DIAGNOSTICS_POLL_MS);
    return () => clearInterval(interval);
  }, [apiBase]);

  const fetchModels = useCallback(async () => {
    setModelsLoading(true);
    try {
      const response = await fetch(`${apiBase}/api/models`);
      setModels(await response.json());
    } catch {
      // Keep the previous models list on transient failures.
    } finally {
      setModelsLoading(false);
    }
  }, [apiBase]);

  useEffect(() => {
    if (error) return;
    const timeout = window.setTimeout(() => {
      void fetchModels();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [error, fetchModels]);

  useEffect(() => {
    if (!updateJob?.id || !updateJob.restart) return;
    let cancelled = false;
    const targetVersion = updateJob.latestVersion;
    const poll = async () => {
      try {
        const res = await fetch(`${apiBase}/api/update/status?jobId=${encodeURIComponent(updateJob.id)}`);
        if (res.ok) {
          const data = await res.json() as { job?: UpdateJob };
          if (!cancelled && data.job) {
            setUpdateJob(data.job);
            if (data.job.status === "failed") {
              setReconnecting(false);
              return;
            }
          }
        }
      } catch {
        if (!cancelled) setReconnecting(true);
      }

      if (!targetVersion) return;
      try {
        const healthRes = await fetch(`${apiBase}/healthz`, { cache: "no-store" });
        if (!healthRes.ok) throw new Error("health failed");
        const data = await healthRes.json() as HealthData;
        if (!cancelled && data.version === targetVersion) {
          setReconnecting(false);
          window.location.reload();
        }
      } catch {
        if (!cancelled) setReconnecting(true);
      }
    };
    poll();
    const interval = setInterval(poll, 1500);
    return () => { cancelled = true; clearInterval(interval); };
  }, [apiBase, updateJob?.id, updateJob?.latestVersion, updateJob?.restart]);

  // Group models by provider so the list reads as provider → its models, not one flat wall of cards.
  const grouped = useMemo(() => {
    const g: Record<string, ModelInfo[]> = {};
    for (const m of models) (g[m.provider] ??= []).push(m);
    return Object.entries(g).sort(([a], [b]) => a.localeCompare(b));
  }, [models]);
  const filteredGroups = useMemo(() => {
    const q = modelQuery.trim().toLowerCase();
    if (!q) return grouped;
    const out: Array<[string, ModelInfo[]]> = [];
    for (const [provider, rows] of grouped) {
      const hits = rows.filter(m => m.id.toLowerCase().includes(q) || provider.toLowerCase().includes(q));
      if (hits.length > 0) out.push([provider, hits]);
    }
    return out;
  }, [grouped, modelQuery]);
  const sidecarModels = useMemo(() => sidecarModelOptions(models), [models]);

  if (error) {
    return (
      <EmptyState style={{ marginTop: 40 }} icon={<IconAlert />}
        title={<span style={{ color: "var(--red)" }}>{t("dash.cannotConnect")}</span>}>
        <Trans k="dash.runStart" cmd="ocx start" />
      </EmptyState>
    );
  }

  const online = health?.status === "ok";

  const saveSidecar = async (patch: SidecarPatch) => {
    if (!sidecar || sidecarSaving) return;
    const next = {
      webSearch: mergeSidecarSetting(sidecar.webSearch, patch.webSearch),
      vision: mergeSidecarSetting(sidecar.vision, patch.vision),
    };
    setSidecarSaving(true);
    setSidecar(next);
    try {
      const res = await fetch(`${apiBase}/api/sidecar-settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error("save failed");
      const data = await res.json();
      setSidecar({ webSearch: data.webSearch, vision: data.vision });
    } catch {
      setSidecar(sidecar);
    } finally {
      setSidecarSaving(false);
    }
  };

  async function saveShadowCall(patch: Partial<ShadowCallData>) {
    if (!shadowCall || shadowCallSaving) return;
    const previous = shadowCall;
    const updated = { ...shadowCall, ...patch };
    setShadowCallSaving(true);
    shadowCallMutationInFlightRef.current = true;
    setShadowCall(updated);
    try {
      const res = await fetch(`${apiBase}/api/shadow-call-settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error("shadow-call save failed");
      // Bump only after a successful write so a poll that started mid-request
      // (still carrying the pre-mutation epoch) cannot overwrite optimistic UI.
      shadowCallMutationEpochRef.current += 1;
    } catch {
      setShadowCall(previous);
    } finally {
      shadowCallMutationInFlightRef.current = false;
      setShadowCallSaving(false);
    }
  }

  const switchMaMode = async (mode: "v1" | "default" | "v2") => {
    if (maBusy || maMode === mode) return;
    setMaBusy(true);
    try {
      const r = await fetch(`${apiBase}/api/v2`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ multiAgentMode: mode }),
      });
      if (r.ok) setMaMode(mode);
    } catch { /* ignore */ }
    finally { setMaBusy(false); }
  };

  const toggleCodexAutoStart = async () => {
    if (!settings || settingsSaving) return;
    const next = !settings.codexAutoStart;
    setSettingsSaving(true);
    settingsMutationInFlightRef.current = true;
    setSettings({ ...settings, codexAutoStart: next });
    try {
      const res = await fetch(`${apiBase}/api/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ codexAutoStart: next }),
      });
      if (!res.ok) throw new Error("save failed");
      const data = await res.json() as { codexAutoStart: boolean; startupHealth?: SettingsData["startupHealth"] };
      settingsMutationEpochRef.current += 1;
      setSettings(prev => prev ? { ...prev, codexAutoStart: data.codexAutoStart, startupHealth: data.startupHealth ?? prev.startupHealth } : prev);
    } catch {
      setSettings(prev => prev ? { ...prev, codexAutoStart: !next } : prev);
      setError(true);
    } finally {
      settingsMutationInFlightRef.current = false;
      setSettingsSaving(false);
    }
  };

  const runSync = async () => {
    if (syncing) return;
    setSyncing(true);
    setSyncResult(null);
    setSyncError(null);
    try {
      const res = await fetch(`${apiBase}/api/sync`, { method: "POST" });
      const data = await res.json() as SyncResult | { error?: string };
      if (!res.ok) throw new Error("error" in data && data.error ? data.error : "sync failed");
      setSyncResult(data as SyncResult);
      const grouped = (data as SyncResult & { projectConfigGrouped?: ProjectCodexConfigGroup[] }).projectConfigGrouped;
      if (grouped) setProjectConfigWarnings(grouped);
    } catch (err) {
      setSyncError(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncing(false);
    }
  };

  const fetchUpdateCheck = async (channel: UpdateChannel, resetRetry = false) => {
    if (resetRetry) updateRetryRef.current = 0;
    if (updateRetryTimerRef.current !== null) {
      window.clearTimeout(updateRetryTimerRef.current);
      updateRetryTimerRef.current = null;
    }
    const requestEpoch = ++updateRequestEpochRef.current;
    setUpdateLoading(true);
    setUpdateError(null);
    setUpdateCheck(null);
    try {
      const res = await fetch(`${apiBase}/api/update/check?tag=${channel}`);
      const data = await res.json() as UpdateCheckData | { error?: string };
      if (!res.ok) throw new Error("error" in data && data.error ? data.error : "update check failed");
      if (requestEpoch !== updateRequestEpochRef.current) return;

      const check = data as UpdateCheckData;
      setUpdateCheck(check);
      if (
        check.reason === "latest_unavailable"
        && updateRetryRef.current < UPDATE_CHECK_MAX_AUTO_RETRIES
      ) {
        const retry = ++updateRetryRef.current;
        updateRetryTimerRef.current = window.setTimeout(() => {
          if (requestEpoch !== updateRequestEpochRef.current) return;
          updateRetryTimerRef.current = null;
          void fetchUpdateCheck(channel);
        }, UPDATE_CHECK_RETRY_BASE_MS * retry);
        return;
      }

      if (check.reason !== "latest_unavailable") updateRetryRef.current = 0;
      setUpdateLoading(false);
    } catch (err) {
      if (requestEpoch !== updateRequestEpochRef.current) return;
      setUpdateError(err instanceof Error ? err.message : String(err));
      setUpdateLoading(false);
    }
  };

  const closeUpdateDialog = () => {
    updateRequestEpochRef.current += 1;
    if (updateRetryTimerRef.current !== null) {
      window.clearTimeout(updateRetryTimerRef.current);
      updateRetryTimerRef.current = null;
    }
    setUpdateLoading(false);
    setUpdateOpen(false);
  };

  const openUpdateDialog = () => {
    const channel = defaultUpdateChannel(health?.version);
    setUpdateChannel(channel);
    setUpdateRestart(true);
    setUpdateOpen(true);
    void fetchUpdateCheck(channel, true);
  };

  const changeUpdateChannel = (channel: UpdateChannel) => {
    setUpdateChannel(channel);
    void fetchUpdateCheck(channel, true);
  };

  const runUpdate = async () => {
    if (!updateCheck?.canUpdate) return;
    setUpdateError(null);
    try {
      const res = await fetch(`${apiBase}/api/update/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tag: updateChannel, restart: updateRestart }),
      });
      const data = await res.json() as { job?: UpdateJob; error?: string };
      if (!res.ok || !data.job) throw new Error(data.error ?? "update failed to start");
      setUpdateJob(data.job);
      setReconnecting(false);
      closeUpdateDialog();
    } catch (err) {
      setUpdateError(err instanceof Error ? err.message : String(err));
    }
  };

  const overviewSection = (
    <div className="dash-overview-stack">
<div className="dash-overview-head">
<div className="stat-row">
  <div className="stat">
    <div className="label" style={{ display: "flex", alignItems: "center", gap: 6 }}>
      {t("dash.multiAgent")}
      <button
        ref={maHelpTriggerRef}
        type="button"
        className="btn btn-ghost btn-sm"
        style={{ width: 24, height: 24, minWidth: 24, flex: "0 0 24px", padding: 0, borderRadius: "var(--radius-pill)", color: "var(--muted)" }}
        onClick={() => setMaHelpOpen(true)}
        aria-label={t("dash.multiAgent")}
        aria-haspopup="dialog"
        aria-controls="multi-agent-help-dialog"
        aria-expanded={maHelpOpen}
      >
        <IconInfo width={14} height={14} aria-hidden="true" />
      </button>
    </div>
    <div className="value" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div role="radiogroup" aria-label={t("dash.multiAgent")} style={{ display: "inline-flex", borderRadius: "var(--radius-pill)", background: "var(--surface-soft, var(--raised))", padding: 3, gap: 2 }}>
        {(["v1", "default", "v2"] as const).map(mode => (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={maMode === mode}
            className={`btn btn-sm text-caption${maMode === mode ? " btn-primary" : " btn-ghost"}`}
            style={{ borderRadius: "var(--radius-pill)", minWidth: 36, padding: "5px 10px", border: "none", background: maMode === mode ? undefined : "transparent", color: maMode === mode ? undefined : "var(--muted)" }}
            disabled={maBusy}
            onClick={() => void switchMaMode(mode)}
          >{t(`models.v2Mode_${mode}` as TKey)}</button>
        ))}
      </div>
    </div>
  </div>
  <div className="stat">
    <div className="label">{t("dash.status")}</div>
    <div className="value" style={{ display: "flex", alignItems: "center", gap: 9, color: online ? "var(--green)" : "var(--red)" }}>
      <span className={`dot ${online ? "dot-green" : "dot-red"}`} />{online ? t("dash.online") : t("dash.offline")}
    </div>
  </div>
  <div className="stat"><div className="label">{t("dash.version")}</div><div className="value mono">{health?.version ?? "—"}</div></div>
  <div className="stat"><div className="label">{t("dash.uptime")}</div><div className="value mono">{health ? formatUptime(health.uptime, locale) : "—"}</div></div>
  <div className="stat"><div className="label">{t("dash.providers")}</div><div className="value">{providers.length}</div></div>
  <div className="stat">
    <div className="label">{t("dash.tokens30d")}</div>
    <div className="value mono">{usage30d && usage30d.summary.requests > 0 ? formatTokens(usage30d.summary.totalTokens, locale) : "—"}</div>
    <div className="muted text-label dash-stat-coverage">
      {usage30d && usage30d.summary.requests > 0
        ? t("dash.coverage").replace("{pct}", `${Math.round(usage30d.summary.coverageRatio * 100)}%`)
        : "\u00a0"}
    </div>
  </div>
</div>

      <div className="startup-health-slot" aria-live="polite">
        {startupHealth ? (
          <a className="startup-health-bar" href="#startup">
            <span className={`dot ${startupHealth === "error" ? "dot-red" : startupHealth === "at-risk" ? "dot-amber" : "dot-green"}`} aria-hidden="true" />
            <span className="startup-health-bar__summary">
              {t(startupHealth === "error"
                ? "startup.error"
                : startupHealth === "at-risk"
                  ? "startup.summary.atRisk"
                  : startupHealth === "protected"
                    ? "startup.summary.protected"
                    : "startup.summary.native")}
            </span>
          </a>
        ) : (
          <div className="startup-health-bar startup-health-bar--pending" aria-hidden="true">
            <span className="dot dot-amber" />
            <span className="startup-health-bar__summary">&nbsp;</span>
          </div>
        )}
      </div>
</div>

{projectConfigWarnings.length > 0 && (
  <div className="notice notice-err maintenance-notice" role="alert">
    <IconAlert />
    <div>
      <div className="font-semibold">{t("dash.projectConfigTitle")}</div>
      <div className="muted text-control" style={{ marginTop: 4 }}>{t("dash.projectConfigHint")}</div>
      <ul className="text-control" style={{ margin: "10px 0 0", paddingLeft: 18 }}>
        {projectConfigWarnings.map(g => (
          <li key={g.path} style={{ marginBottom: 8 }}>
            <code>{g.path}</code> — {g.issues.join(", ")}
            <div className="muted" style={{ marginTop: 2 }}>{g.bypass}</div>
          </li>
        ))}
      </ul>
    </div>
  </div>
)}

{maModeResolved && maMode !== "v1" && (
  <div className="panel">
    <div className="injection-head">
      <span className="injection-label" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        {t("dash.effortCapLabel")}
        <button
          ref={effortCapHelpTriggerRef}
          type="button"
          className="btn btn-ghost btn-sm"
          style={{ width: 22, height: 22, minWidth: 22, padding: 0, borderRadius: "var(--radius-pill)", color: "var(--muted)" }}
          onClick={() => setEffortCapHelpOpen(open => !open)}
          aria-label={t("dash.effortCapLabel")}
          aria-expanded={effortCapHelpOpen}
          aria-haspopup="dialog"
          aria-controls="effort-cap-help-dialog"
        >
          <IconInfo width={13} height={13} aria-hidden="true" />
        </button>
      </span>
    <Select
      value={effortCap}
      options={[
        { value: "", label: t("dash.effortCapNone") },
        ...EFFORT_CAP_LEVELS.map(e => ({ value: e, label: e })),
      ]}
      onChange={async (v) => {
        if (effortCapSaving) return;
        setEffortCapSaving(true);
        try {
          const res = await fetch(`${apiBase}/api/effort-caps`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ effortCap: v || null }),
          });
          if (res.ok) {
            const data = await res.json() as { ok: boolean; effortCap?: string | null; subagentEffortCap?: string | null };
            setEffortCap(data.effortCap ?? "");
            setSubagentEffortCap(data.subagentEffortCap ?? "");
          }
        } catch { /* ignore */ }
        finally { setEffortCapSaving(false); }
      }}
      disabled={effortCapSaving}
      label={t("dash.effortCapLabel")}
    />
    <Select
      value={subagentEffortCap}
      options={[
        { value: "", label: t("dash.effortCapNone") },
        ...EFFORT_CAP_LEVELS.map(e => ({ value: e, label: e })),
      ]}
      onChange={async (v) => {
        if (effortCapSaving) return;
        setEffortCapSaving(true);
        try {
          const res = await fetch(`${apiBase}/api/effort-caps`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ subagentEffortCap: v || null }),
          });
          if (res.ok) {
            const data = await res.json() as { ok: boolean; effortCap?: string | null; subagentEffortCap?: string | null };
            setEffortCap(data.effortCap ?? "");
            setSubagentEffortCap(data.subagentEffortCap ?? "");
          }
        } catch { /* ignore */ }
        finally { setEffortCapSaving(false); }
      }}
      disabled={effortCapSaving}
      label={t("dash.subagentEffortCapLabel")}
    />
    </div>
  </div>
)}

<div className="panel">
  <div className="injection-head">
    <span className="injection-label">{t("dash.injectionLabel")}</span>
    <Select
      value={injectionModel}
      options={[
        { value: "", label: t("dash.injectionNone") },
        ...injectionAvailable.map(m => ({ value: m.namespaced, label: `${m.provider} / ${m.model}` })),
      ]}
      onChange={async (v) => {
        if (injectionSaving) return;
        setInjectionSaving(true);
        try {
          const res = await fetch(`${apiBase}/api/injection-model`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: v || null, effort: injectionEffort || null }),
          });
          if (res.ok) {
            const data = await res.json() as { model?: string | null; effort?: string | null };
            setInjectionModel(data.model ?? "");
            setInjectionEffort(data.effort ?? "");
          }
        } catch { /* ignore */ }
        finally { setInjectionSaving(false); }
      }}
      disabled={injectionSaving || !multiAgentGuidanceEnabled}
      label={t("dash.injectionLabel")}
    />
    {injectionModel && injectionEfforts.length > 0 && (
      <Select
        value={injectionEffort}
        options={[
          { value: "", label: t("dash.injectionEffortNone") },
          ...injectionEfforts.map(e => ({ value: e, label: e })),
        ]}
        onChange={async (v) => {
          if (injectionSaving) return;
          setInjectionSaving(true);
          try {
            const res = await fetch(`${apiBase}/api/injection-model`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ model: injectionModel || null, effort: v || null }),
            });
            if (res.ok) {
              const data = await res.json() as { model?: string | null; effort?: string | null };
              setInjectionModel(data.model ?? "");
              setInjectionEffort(data.effort ?? "");
            }
          } catch { /* ignore */ }
          finally { setInjectionSaving(false); }
        }}
        disabled={injectionSaving || !multiAgentGuidanceEnabled}
        label={t("dash.injectionEffortLabel")}
      />
    )}
    {injectionModel && multiAgentGuidanceEnabled && <span className="badge badge-green text-micro">{t("dash.injectionActive")}</span>}
  </div>
  <div className="muted text-control" style={{ marginTop: 6 }}>{t("dash.injectionHint")}</div>
  <div className="spread dash-subagent-guidance-row">
    <div className="setting-copy" style={{ flex: 1 }}>
      <div className="font-semibold">{t("dash.multiAgentGuidance")}</div>
      <div className="muted setting-hint">{t("dash.multiAgentGuidanceHint")}</div>
    </div>
    <button
      type="button"
      className={`switch ${multiAgentGuidanceEnabled ? "on" : ""}`}
      onClick={async () => {
        if (injectionSaving) return;
        setInjectionSaving(true);
        try {
          const res = await fetch(`${apiBase}/api/injection-model`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ multiAgentGuidanceEnabled: !multiAgentGuidanceEnabled }),
          });
          if (res.ok) {
            const data = await res.json() as { multiAgentGuidanceEnabled?: boolean };
            setMultiAgentGuidanceEnabled(data.multiAgentGuidanceEnabled !== false);
          }
        } catch { /* ignore */ }
        finally { setInjectionSaving(false); }
      }}
      disabled={injectionSaving}
      aria-label={t("dash.multiAgentGuidance")}
      aria-pressed={multiAgentGuidanceEnabled}
    >
      <span className="knob" />
    </button>
  </div>
</div>

<div className="panel maintenance-panel">
  <div className="spread maintenance-head">
    <div>
      <div className="font-semibold">{t("dash.maintenance")}</div>
      <div className="muted text-control" style={{ marginTop: 3 }}>{t("dash.maintenanceHint")}</div>
    </div>
    <div className="maintenance-actions">
      <button type="button" className="btn btn-ghost" onClick={runSync} disabled={syncing}>
        <IconRefresh /> {syncing ? t("dash.syncing") : t("dash.syncModels")}
      </button>
      <button
        ref={updateTriggerRef}
        type="button"
        className="btn btn-primary"
        onClick={openUpdateDialog}
        disabled={updateLoading}
        aria-haspopup="dialog"
        aria-controls="dashboard-update-dialog"
        aria-expanded={updateOpen}
      >
        <IconExternal /> {t("dash.checkUpdate")}
      </button>
    </div>
  </div>
  {syncResult && (
    <div className="notice notice-ok maintenance-notice" role="status">
      <IconRefresh />
      <span>
        {t("dash.syncOk", { count: syncResult.added })}
        {syncResult.warning ? ` ${syncResult.warning}` : ""}
        {syncResult.staleAppServerHint ? ` ${t("dash.syncStaleHint")}` : ""}
      </span>
    </div>
  )}
  {syncError && (
    <div className="notice notice-err maintenance-notice" role="status">
      <IconAlert /><span>{t("dash.syncFailed", { error: syncError })}</span>
    </div>
  )}
  {updateJob && (
    <div className={`notice ${updateJob.status === "failed" ? "notice-err" : "notice-ok"} maintenance-notice`} role="status">
      {updateJob.status === "failed" ? <IconAlert /> : <IconRefresh />}
      <span>
        {updateJobLabel(updateJob.status, t)}
        {updateJob.latestVersion ? ` ${updateJob.currentVersion} -> ${updateJob.latestVersion}.` : ""}
        {reconnecting ? ` ${t("dash.updateReconnecting")}` : ""}
        {updateJob.error ? ` ${updateJob.error}` : ""}
      </span>
    </div>
  )}
</div>

<div className="panel">
  <div className="spread">
    <div style={{ flex: 1, minWidth: 0 }}>
      <div className="font-semibold">{t("dash.codexAutoStart")}</div>
      <div className="muted setting-hint">{t("dash.codexAutoStartHint")}</div>
    </div>
    <button
      type="button"
      className={`switch ${settings?.codexAutoStart ?? true ? "on" : ""}`}
      onClick={toggleCodexAutoStart}
      disabled={!settings || settingsSaving}
      aria-label={t("dash.codexAutoStart")}
      aria-pressed={settings?.codexAutoStart ?? true}
    >
      <span className="knob" />
    </button>
  </div>
</div>

<div className="dash-sidecar-grid">
<div className="panel dash-sidecar-card">
  <div className="dash-sidecar-card__row">
    <div className="font-semibold">{t("dash.webSearchSidecar")}</div>
    <Select
      value={sidecar?.webSearch.model ?? "gpt-5.6-luna"}
      options={sidecarModels}
      onChange={model => { void saveSidecar({ webSearch: { model, backend: sidecarBackendForModel(models, model) } }); }}
      disabled={!sidecar || sidecarSaving}
      label={t("dash.sidecarModel")}
    />
  </div>
  <div className="muted setting-hint">{t("dash.webSearchSidecarHint")}</div>
</div>

<div className="panel dash-sidecar-card">
  <div className="dash-sidecar-card__row">
    <div className="font-semibold">{t("dash.visionSidecar")}</div>
    <Select
      value={sidecar?.vision.model ?? "gpt-5.6-luna"}
      options={sidecarModels}
      onChange={model => { void saveSidecar({ vision: { model, backend: sidecarBackendForModel(models, model) } }); }}
      disabled={!sidecar || sidecarSaving}
      label={t("dash.sidecarModel")}
    />
  </div>
  <div className="muted setting-hint">{t("dash.visionSidecarHint")}</div>
</div>
</div>

<div className="panel">
  <div className="spread" style={{ alignItems: "center" }}>
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span className="font-semibold">{t("dash.shadowCallIntercept")}</span>
      <button
        ref={shadowCallHelpTriggerRef}
        type="button"
        className="btn btn-ghost btn-sm"
        style={{ width: 22, height: 22, minWidth: 22, padding: 0, borderRadius: "var(--radius-pill)", color: "var(--muted)" }}
        onClick={() => setShadowCallHelpOpen(open => !open)}
        aria-label={t("dash.shadowCallIntercept")}
        aria-expanded={shadowCallHelpOpen}
        aria-haspopup="dialog"
        aria-controls="shadow-call-help-dialog"
      >
        <IconInfo width={13} height={13} aria-hidden="true" />
      </button>
      <code className="muted text-caption">⚠ 5.4-mini</code>
    </div>
    <div className="setting-controls" style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <button
        type="button"
        className={`switch ${shadowCall?.enabled ? "on" : ""}`}
        onClick={() => saveShadowCall({ enabled: !shadowCall?.enabled })}
        disabled={!shadowCall || shadowCallSaving}
        aria-label={t("dash.shadowCallIntercept")}
        aria-pressed={shadowCall?.enabled ?? false}
      >
        <span className="knob" />
      </button>
      <Select
        value={shadowCall?.model ?? ""}
        options={[{ value: "", label: "—" }, ...models.map(m => ({ value: m.id, label: `${m.provider}/${m.id}` }))]}
        onChange={v => { void saveShadowCall({ model: v }); }}
        disabled={!shadowCall || shadowCallSaving || !shadowCall?.enabled}
        label={t("dash.shadowCallModel")}
        align="right"
      />
    </div>
  </div>
</div>

      <MemoryObservabilityCard apiBase={apiBase} />

    </div>
  );

  const providersSection = (
    <>
<div className="h-section">{t("dash.activeProviders")} <span className="count">{providers.length}</span></div>
{providers.length === 0 ? (
  <EmptyState title={<Trans k="dash.noProviders" cmd="ocx init" />} />
) : (
  <div className="tbl-wrap">
    <table className="tbl">
      <thead><tr><th>{t("dash.col.name")}</th><th>{t("dash.col.adapter")}</th><th>{t("dash.col.baseUrl")}</th><th>{t("dash.col.model")}</th></tr></thead>
      <tbody>
        {providers.map(p => (
          <tr key={p.name}>
            <td className="font-semibold">{p.name}</td>
            <td><span className="chip">{p.adapter}</span></td>
            <td className="muted mono text-label">{p.baseUrl}</td>
            <td className="muted">{p.defaultModel ?? "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
)}

    </>
  );

  const modelsSection = (
    <>
<div className="h-section">
  {t("dash.availableModels")} <span className="count">{models.length}</span>
  {modelsLoading && <span className="spin" style={{ marginLeft: 4 }} />}
</div>
{models.length === 0 && !modelsLoading ? (
  <EmptyState title={t("dash.noModels")} />
) : (
  <>
  <div className="pws-search-wrap">
    <IconSearch className="pws-search-icon" width={14} height={14} aria-hidden="true" />
    <input
      type="search"
      className="input pws-search-input"
      placeholder={t("models.search")}
      value={modelQuery}
      onChange={e => setModelQuery(e.target.value)}
      aria-label={t("models.search")}
    />
  </div>
  {filteredGroups.length === 0 ? (
    <p className="muted text-control" style={{ margin: "4px 0" }}>{t("dash.modelsNoResults")}</p>
  ) : (
    <div className="dash-model-acc">
      {filteredGroups.map(([provider, rows]) => {
        const q = modelQuery.trim().toLowerCase();
        const open = q !== "" || expandedProviders.has(provider);
        return (
          <div key={provider} className="dash-model-group">
            <button
              type="button"
              className="dash-model-head"
              onClick={() => setExpandedProviders(prev => { const next = new Set(prev); if (next.has(provider)) next.delete(provider); else next.add(provider); return next; })}
              aria-expanded={open}
            >
              <IconChevron width={12} height={12} style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform .12s", color: "var(--muted)" }} aria-hidden="true" />
              <span className="font-semibold">{provider}</span>
              <span className="count">{rows.length}</span>
            </button>
            {open && (
              <div className="dash-model-chips">
                {rows.map(m => (
                  <code key={`${m.provider}/${m.id}`} className="dash-model-chip">{m.id}</code>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  )}
  </>
)}

    </>
  );

  const updateDialog = (
    <>
<dialog
  ref={updateDialogRef}
  id="dashboard-update-dialog"
  className="modal-overlay"
  style={{ display: updateOpen ? "flex" : "none", border: "none", margin: 0, maxWidth: "none", maxHeight: "none", width: "100%", height: "100%" }}
  aria-labelledby="update-title"
  onCancel={event => { event.preventDefault(); closeUpdateDialog(); }}
>
    <div className="modal-card">
      <div className="modal-head">
        <h3 id="update-title">{t("dash.updateTitle")}</h3>
        <button type="button" className="btn btn-ghost btn-icon" onClick={closeUpdateDialog} aria-label={t("common.cancel")}>
          <IconX />
        </button>
      </div>
      <div className="modal-desc">{t("dash.updateDesc")}</div>
      <div className="update-row">
        <label className="field-label" htmlFor="update-channel">{t("dash.updateChannel")}</label>
        <Select
          value={updateChannel}
          options={[{ value: "latest", label: "latest" }, { value: "preview", label: "preview" }]}
          onChange={v => changeUpdateChannel(v as UpdateChannel)}
          disabled={updateLoading}
          label={t("dash.updateChannel")}
          // Native <dialog showModal()> top-layer paints above body portals.
          portal={false}
        />
      </div>
      {updateLoading && <EmptyState className="update-empty" icon={<span className="spin" />} title={t("dash.updateChecking")} />}
      {updateError && (
        <div className="notice notice-err" role="status"><IconAlert /><span>{updateError}</span></div>
      )}
      {updateCheck && !updateLoading && (
        <div className="update-box">
          <div className="spread">
            <div>
              <div className="muted text-label">{t("dash.updateInstalled")}</div>
              <div className="mono">{updateCheck.currentVersion}</div>
            </div>
            <div>
              <div className="muted text-label">{t("dash.updateLatest")}</div>
              <div className="mono">{updateCheck.latestVersion ?? "—"}</div>
            </div>
            <span className={`badge ${updateCheck.updateAvailable ? "badge-green" : "badge-muted"}`}>
              {updateCheck.updateAvailable ? t("dash.updateAvailable") : t("dash.updateCurrent")}
            </span>
          </div>
          <div className="muted update-command">{t("dash.updateCommand")} <code className="chip">{updateCheck.command}</code></div>
          {updateCheck.reason === "source_checkout" && (
            <div className="notice-warn" role="status"><IconAlert /> {t("dash.updateSource")}</div>
          )}
          {updateCheck.reason === "latest_unavailable" && (
            <div className="notice-warn" role="status">
              <IconAlert /> {t("dash.updateUnavailable")}
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={updateLoading}
                onClick={() => { void fetchUpdateCheck(updateChannel, true); }}
                style={{ marginLeft: 12 }}
              >
                <IconRefresh /> {t("dash.updateRetry")}
              </button>
            </div>
          )}
          {!updateCheck.canUpdate && updateCheck.reason !== "latest_unavailable" && updateCheck.reason !== "source_checkout" && (
            <div className="update-recheck">
              <span className="muted update-recheck-reason">
                {t("dash.updateCannotAuto", { reason: updateReasonLabel(updateCheck.reason, t) })}
              </span>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={updateLoading}
                onClick={() => { void fetchUpdateCheck(updateChannel, true); }}
              >
                <IconRefresh /> {updateLoading ? t("dash.updateChecking") : t("dash.updateRecheck")}
              </button>
            </div>
          )}
          {updateCheck.canUpdate && (
            <div className="spread update-restart">
              <div>
                <div className="font-semibold">{t("dash.updateRestart")}</div>
                <div className="muted text-label">{t("dash.updateRestartHint")}</div>
              </div>
              <button
                type="button"
                className={`switch ${updateRestart ? "on" : ""}`}
                onClick={() => setUpdateRestart(v => !v)}
                aria-label={t("dash.updateRestart")}
                aria-pressed={updateRestart}
              >
                <span className="knob" />
              </button>
            </div>
          )}
        </div>
      )}
      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" onClick={closeUpdateDialog}>{t("common.cancel")}</button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={runUpdate}
          disabled={!updateCheck?.canUpdate || updateLoading}
        >
          {t("dash.runUpdate")}
        </button>
      </div>
    </div>
</dialog>

<dialog
  ref={maHelpDialogRef}
  id="multi-agent-help-dialog"
  className="modal-overlay"
  style={{ display: maHelpOpen ? "flex" : "none", border: "none", margin: 0, maxWidth: "none", maxHeight: "none", width: "100%", height: "100%" }}
  aria-labelledby="multi-agent-help-title"
  onCancel={event => { event.preventDefault(); setMaHelpOpen(false); }}
  onClick={event => { if (event.target === event.currentTarget) setMaHelpOpen(false); }}
>
    <div className="modal-card" onClick={e => e.stopPropagation()}>
      <div className="modal-head">
        <h3 id="multi-agent-help-title">{t("dash.multiAgent")}</h3>
        <button type="button" className="btn btn-ghost btn-icon" onClick={() => setMaHelpOpen(false)} aria-label={t("common.close")}><IconX /></button>
      </div>
      <div className="modal-desc leading-relaxed" style={{ whiteSpace: "pre-line" }}>
        {t("models.v2Help")}
      </div>
      <div style={{ marginTop: 12 }}>
        <a className="text-control" href="https://opencodex.me/guides/sub-agent-surface/" target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>
          {t("models.v2DocsLink")}
        </a>
      </div>
      <div className="modal-actions">
        <button type="button" className="btn btn-primary" onClick={() => setMaHelpOpen(false)}>{t("common.ok")}</button>
      </div>
    </div>
</dialog>

<dialog
  ref={effortCapHelpDialogRef}
  id="effort-cap-help-dialog"
  className="modal-overlay"
  style={{ display: effortCapHelpOpen ? "flex" : "none", border: "none", margin: 0, maxWidth: "none", maxHeight: "none", width: "100%", height: "100%" }}
  aria-labelledby="effort-cap-help-title"
  onCancel={event => { event.preventDefault(); setEffortCapHelpOpen(false); }}
  onClick={event => { if (event.target === event.currentTarget) setEffortCapHelpOpen(false); }}
>
    <div className="modal-card" onClick={e => e.stopPropagation()}>
      <div className="modal-head">
        <h3 id="effort-cap-help-title">{t("dash.effortCapLabel")}</h3>
        <button type="button" className="btn btn-ghost btn-icon" onClick={() => setEffortCapHelpOpen(false)} aria-label={t("common.close")}><IconX /></button>
      </div>
      <div className="modal-desc leading-relaxed" style={{ whiteSpace: "pre-line" }}>
        {t("dash.effortCapHelp")}
      </div>
      <div className="modal-actions">
        <button type="button" className="btn btn-primary" onClick={() => setEffortCapHelpOpen(false)}>{t("common.ok")}</button>
      </div>
    </div>
</dialog>

<dialog
  ref={shadowCallHelpDialogRef}
  id="shadow-call-help-dialog"
  className="modal-overlay"
  style={{ display: shadowCallHelpOpen ? "flex" : "none", border: "none", margin: 0, maxWidth: "none", maxHeight: "none", width: "100%", height: "100%" }}
  aria-labelledby="shadow-call-help-title"
  onCancel={event => { event.preventDefault(); setShadowCallHelpOpen(false); }}
  onClick={event => { if (event.target === event.currentTarget) setShadowCallHelpOpen(false); }}
>
    <div className="modal-card" onClick={e => e.stopPropagation()}>
      <div className="modal-head">
        <h3 id="shadow-call-help-title">{t("dash.shadowCallIntercept")}</h3>
        <button type="button" className="btn btn-ghost btn-icon" onClick={() => setShadowCallHelpOpen(false)} aria-label={t("common.close")}><IconX /></button>
      </div>
      <div className="modal-desc leading-relaxed" style={{ whiteSpace: "pre-line" }}>
        {t("dash.shadowCallTooltip")}
      </div>
      <div className="modal-actions">
        <button type="button" className="btn btn-primary" onClick={() => setShadowCallHelpOpen(false)}>{t("common.ok")}</button>
      </div>
    </div>
</dialog>
    </>
  );

  const sections: { id: DashboardSection; label: string; body: ReactNode }[] = [
    { id: "overview", label: t("dash.workspace.overview"), body: overviewSection },
    { id: "providers", label: t("dash.activeProviders"), body: providersSection },
    { id: "models", label: t("dash.availableModels"), body: modelsSection },
  ];
  const selected = sections.find(s => s.id === selectedSection) ?? sections[0];
  const selectTab = (next: DashboardSection) => {
    // Deliberate navigation: push a history entry so Back/Forward restore the tab.
    navigateHash(dashboardHashForSection(next));
  };
  const onTabKeyDown = (e: React.KeyboardEvent) => {
    const index = sections.findIndex(s => s.id === selectedSection);
    let next = -1;
    if (e.key === "ArrowRight") next = (index + 1) % sections.length;
    else if (e.key === "ArrowLeft") next = (index - 1 + sections.length) % sections.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = sections.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const target = sections[next]!;
    selectTab(target.id);
    document.getElementById(`dashboard-tab-${target.id}`)?.focus();
  };
  return (
    <div className="dashboard-workspace-shell">
      <div className="page-head">
        <h2>{t("nav.dashboard")}</h2>
      </div>
      <p className="page-sub">{t("dash.subtitle")}</p>
      <div className="page-tabs" role="tablist" aria-label={t("dash.workspace.sections")}>
        {sections.map(s => (
          <button
            key={s.id}
            type="button"
            role="tab"
            id={`dashboard-tab-${s.id}`}
            aria-selected={selectedSection === s.id}
            aria-controls={`dashboard-panel-${s.id}`}
            tabIndex={selectedSection === s.id ? 0 : -1}
            className={`page-tab${selectedSection === s.id ? " page-tab--active" : ""}`}
            onClick={() => selectTab(s.id)}
            onKeyDown={onTabKeyDown}
          >
            {s.label}
          </button>
        ))}
      </div>
      <section
        className="dashboard-workspace-main"
        role="tabpanel"
        id={`dashboard-panel-${selected.id}`}
        aria-labelledby={`dashboard-tab-${selected.id}`}
        tabIndex={0}
      >
        {selected.body}
      </section>
      {updateDialog}
    </div>
  );

}
