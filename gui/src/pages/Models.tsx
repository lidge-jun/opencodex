import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Switch, Notice, EmptyState, Select, Tooltip } from "../ui";
import { IconChevron, IconBoxes, IconInfo, IconShuffle, IconCheck, IconAlert } from "../icons";
import { useT } from "../i18n/shared";
import type { TFn, TKey } from "../i18n/shared";
import { modelLabel } from "../model-display";
import { type ComboItem, parseComboList } from "../combo-workspace-data";
import { readJsonIfOk, readJsonOrThrow } from "../fetch-json";
import { readSessionListCache, writeSessionListCache } from "../session-list-cache";
import { setClientResourceData } from "../client-resource";
import { useDataSurface } from "../data-surface";
import { DataSurfaceSkeleton } from "../components/data-surface";
import {
  buildProviderModelGroups,
  type ConfiguredProviderSummary,
  type ProviderModelGroup,
} from "../models-groups";
import {
  fetchSelectedModels,
  modelVisible,
  putModelVisibility,
  shouldApplyLoadGeneration,
  type ProviderModelMap,
  type ModelVisibilityScope,
  type ModelVisibilityTarget,
} from "../model-visibility";
import {
  activeModelOptions,
  CAP_OPTION_SET,
  CAP_OPTIONS,
  collectDisabledNamespaced,
  CUSTOM_OPTION,
  fmtK,
  PAGE,
  readCollapsedProviders,
  readCombosOpen,
  THREAD_OPTION_SET,
  THREAD_OPTIONS,
  writeCollapsedProviders,
  writeCombosOpen,
  discoveryFailureLabel,
  type ModelRow,
  type ProviderContextCapsResponse,
  type ShadowCallData,
  type V2Status,
} from "./models-shared";
import { EmptyProviderHint } from "./models-provider-hints";
import { shadowSourceModelBadge, shadowSourceModelLabel } from "./shadow-call-source";

type CachedModelsPage = {
  models: ModelRow[];
  providers: ConfiguredProviderSummary[];
  selectedModels: ProviderModelMap;
  disabled: string[];
  contextCaps: Record<string, number>;
  contextCapValue: number;
};

/** Session JSON is untrusted — only seed rows that survive parseComboList (targets always arrays). */
function readCachedCombos(value: unknown): ComboItem[] | null {
  if (!Array.isArray(value)) return null;
  return parseComboList({ combos: value });
}

export default function Models({ apiBase }: { apiBase: string }) {
  const t: TFn = useT();
  const cacheKey = `ocx.models.catalog.v1:${apiBase}`;
  const cached = useMemo(() => readSessionListCache<CachedModelsPage>(cacheKey), [cacheKey]);
  const [models, setModels] = useState<ModelRow[]>(() => cached?.models ?? []);
  const [providers, setProviders] = useState<ConfiguredProviderSummary[]>(() => cached?.providers ?? []);
  const [disabled, setDisabled] = useState<Set<string>>(() => new Set(cached?.disabled ?? []));
  const [selectedModels, setSelectedModels] = useState<ProviderModelMap | null>(() => cached?.selectedModels ?? null);
  const [search, setSearch] = useState<Record<string, string>>({});
  const [limit, setLimit] = useState<Record<string, number>>({});
  const [contextCaps, setContextCaps] = useState<Record<string, number>>(() => cached?.contextCaps ?? {});
  const [contextCapValue, setContextCapValue] = useState(() => cached?.contextCapValue ?? 350_000);
  const [customCap, setCustomCap] = useState("");
  const [showCustom, setShowCustom] = useState(false);
  const initialCollapsed = readCollapsedProviders();
  const [collapsed, setCollapsed] = useState<Set<string>>(() => initialCollapsed ?? new Set());
  const needsDefaultCollapseRef = useRef(initialCollapsed === null);
  const [status, setStatus] = useState("");
  const [ok, setOk] = useState(false);
  // Feedback generation: a repeated identical message (same success string, same validation
  // error) must still re-arm the toast timer. Clearing `status` alone is not enough — a
  // second identical value bails out of React's state diff, so the old timer would dismiss
  // the new toast early. Every publish bumps the generation.
  const [feedbackGen, setFeedbackGen] = useState(0);
  const publishFeedback = (nextOk: boolean, message: string) => {
    setOk(nextOk);
    setStatus(message);
    setFeedbackGen(g => g + 1);
  };
  // Transient action feedback as a fixed toast: appearing or auto-clearing it never shifts
  // the workspace below (the old inline Notice pushed the whole model grid down by its
  // height on every apply). The timer itself just clears the status again.
  useEffect(() => {
    if (!status) return;
    const holdMs = ok ? 6000 : 8000;
    const timer = setTimeout(() => setStatus(""), holdMs);
    return () => clearTimeout(timer);
  }, [status, ok, feedbackGen]);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const loadGenerationRef = useRef(0);
  const loadPendingRef = useRef(false);
  // multi_agent_v2 / ultra gate. null = endpoint unavailable (older proxy build) -> section hidden.
  const [v2, setV2] = useState<V2Status | null>(null);
  const [v2Loading, setV2Loading] = useState(true);
  const [v2Busy, setV2Busy] = useState(false);
  const [v2Note, setV2Note] = useState("");
  const v2BusyRef = useRef(false);
  const [threadsCustom, setThreadsCustom] = useState("");
  const [showThreadsCustom, setShowThreadsCustom] = useState(false);
  const [v2HelpOpen, setV2HelpOpen] = useState(false);
  const [customModalOpen, setCustomModalOpen] = useState(false);
  const [customModalMode, setCustomModalMode] = useState<"add" | "edit">("add");
  const [customModalProvider, setCustomModalProvider] = useState("");
  const [customModalId, setCustomModalId] = useState("");
  const [customFormModelId, setCustomFormModelId] = useState("");
  const [customFormDisplayName, setCustomFormDisplayName] = useState("");
  const [customFormContextWindow, setCustomFormContextWindow] = useState("");
  const [customFormShowCustomCtx, setCustomFormShowCustomCtx] = useState(false);
  const [customFormModalities, setCustomFormModalities] = useState<string[]>(["text"]);
  const [customSaving, setCustomSaving] = useState(false);
  const [customError, setCustomError] = useState("");
  const [hoveredModel, setHoveredModel] = useState<{ namespaced: string; rect: DOMRect } | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [shadowCall, setShadowCall] = useState<ShadowCallData | null>(null);
  const [shadowCallSaving, setShadowCallSaving] = useState(false);
  // Combo summary section. null = cold load with no seed (pending strut). Failed reads stay
  // null + combosError so an API error never masquerades as "no combos configured".
  const combosCacheKey = `ocx.models.combos.v1:${apiBase}`;
  const seededCombos = useMemo(() => {
    const own = readCachedCombos(readSessionListCache<unknown>(combosCacheKey));
    if (own !== null) return own;
    // Reuse the Combos workspace session snapshot when Models opens first in the session.
    const workspace = readSessionListCache<{ combos?: unknown }>(`ocx.combos.workspace.v1:${apiBase}`);
    return readCachedCombos(workspace?.combos);
  }, [apiBase, combosCacheKey]);
  const combosResource = useDataSurface<ComboItem[]>(
    `models-combos:${apiBase}`,
    [apiBase],
    async (signal) => {
      const r = await fetch(`${apiBase}/api/combos`, { signal });
      const j = await readJsonOrThrow<unknown>(r);
      const next = parseComboList(j);
      writeSessionListCache(combosCacheKey, next);
      return next;
    },
    { isEmpty: () => false, initialData: seededCombos ?? undefined },
  );
  const combosState = combosResource.state;
  // Keep a previously painted card on a later failure so the catalog does not yank down.
  const combos = combosState.data ?? seededCombos;
  // Announce failures even when stale/seeded rows remain (layout kept; freshness not faked).
  const combosError = combosState.showError;
  const [combosOpen, setCombosOpen] = useState(readCombosOpen);

  // App owns the in-session view mode; fallback to persisted mode for isolated renders/tests.
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const toggleCombosOpen = () => {
    const next = !combosOpen;
    writeCombosOpen(next);
    setCombosOpen(next);
  };

  useEffect(() => () => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
  }, []);

  const shadowModelOptions = useMemo(
    () => activeModelOptions(models, disabled, selectedModels ?? {}),
    [models, disabled, selectedModels],
  );

  const loadShadowCall = useCallback(async () => {
    try {
      const r = await fetch(`${apiBase}/api/shadow-call-settings`);
      const data = await readJsonIfOk<ShadowCallData>(r);
      if (data) setShadowCall(data);
    } catch { /* old server / network: keep the section disabled */ }
  }, [apiBase]);

  const loadV2 = useCallback(async () => {
    // Never let a toggle in flight be clobbered by the poll (same single-flight rule as models).
    if (v2BusyRef.current) return;
    try {
      const r = await fetch(`${apiBase}/api/v2`);
      if (!(r.headers.get("content-type") ?? "").includes("application/json")) { setV2(null); return; }
      const data = await readJsonIfOk<V2Status>(r);
      if (!data || typeof data.enabled !== "boolean") { setV2(null); return; }
      setV2({
        enabled: data.enabled,
        agentsMaxThreadsConflict: data.agentsMaxThreadsConflict === true,
        maxConcurrentThreadsPerSession: typeof data.maxConcurrentThreadsPerSession === "number" ? data.maxConcurrentThreadsPerSession : null,
        multiAgentMode: data.multiAgentMode === "v1" || data.multiAgentMode === "v2" ? data.multiAgentMode : "default",
      });
    } catch {
      setV2(null); // old server / network: hide the section instead of guessing
    } finally {
      setV2Loading(false);
    }
  }, [apiBase]);

  const fetchCatalog = useCallback(async (signal: AbortSignal): Promise<CachedModelsPage> => {
    const [modelsRes, capsRes, providersRes, selectionData] = await Promise.all([
      fetch(`${apiBase}/api/models`),
      fetch(`${apiBase}/api/provider-context-caps`),
      fetch(`${apiBase}/api/providers`),
      fetchSelectedModels(apiBase),
    ]);
    const [data, capsData, providerData] = await Promise.all([
      readJsonOrThrow<ModelRow[]>(modelsRes),
      readJsonOrThrow<ProviderContextCapsResponse>(capsRes),
      readJsonOrThrow<ConfiguredProviderSummary[]>(providersRes),
    ]);
    if (data === undefined || capsData === undefined || providerData === undefined) {
      throw new Error("models payload missing");
    }
    if (signal.aborted) throw new Error("models request aborted");
    const nextDisabled = collectDisabledNamespaced(data);
    const value = typeof capsData.value === "number" && Number.isFinite(capsData.value) && capsData.value > 0
      ? capsData.value
      : (typeof capsData.cap === "number" && Number.isFinite(capsData.cap) && capsData.cap > 0 ? capsData.cap : undefined);
    const nextCapValue = value !== undefined ? value : 350_000;
    const next = {
      models: data,
      providers: providerData,
      selectedModels: selectionData,
      disabled: [...nextDisabled],
      contextCaps: capsData.caps ?? {},
      contextCapValue: nextCapValue,
    } satisfies CachedModelsPage;
    writeSessionListCache(cacheKey, next);
    return next;
  }, [apiBase, cacheKey]);

  const applyCatalog = useCallback((next: CachedModelsPage) => {
    const nextGroups = buildProviderModelGroups(next.models, next.providers);
    setSelectedProvider(prev => (
      prev !== null && !nextGroups.some(group => group.provider === prev)
        ? null
        : prev
    ));
    setModels(next.models);
    setProviders(next.providers);
    setDisabled(new Set(next.disabled));
    setSelectedModels(next.selectedModels);
    setContextCapValue(next.contextCapValue);
    setContextCaps(next.contextCaps);
  }, []);

  const catalogResource = useDataSurface<CachedModelsPage>(
    cacheKey,
    [apiBase],
    async (signal) => {
      const next = await fetchCatalog(signal);
      // A manual mutation refresh may have invalidated this request while its JSON was decoding.
      // Do not let the aborted catalog repaint controls after the newer result is applied.
      if (signal.aborted) throw new Error("models request aborted");
      applyCatalog(next);
      return next;
    },
    { isEmpty: () => false, pollMs: 10_000, initialData: cached ?? undefined },
  );
  const catalogState = catalogResource.state;

  const load = useCallback(async (force = false): Promise<boolean> => {
    if (loadPendingRef.current && !force) return false;
    loadPendingRef.current = true;
    const generation = ++loadGenerationRef.current;
    try {
      const next = await fetchCatalog(new AbortController().signal);
      if (!shouldApplyLoadGeneration(generation, loadGenerationRef.current)) return false;
      applyCatalog(next);
      // Follow-up mutation refreshes retain their existing awaitable contract while publishing
      // the result through the same shared store used by the initial catalog subscription.
      setClientResourceData(cacheKey, next);
      return true;
    } catch {
      return false;
    } finally {
      if (shouldApplyLoadGeneration(generation, loadGenerationRef.current)) {
        loadPendingRef.current = false;
      }
    }
  }, [applyCatalog, cacheKey, fetchCatalog]);

  // Shadow/v2 controls must not wait on the models catalog (live discovery can be slow).
  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void loadShadowCall();
      void loadV2();
    }, 0);
    const timer = window.setInterval(() => {
      if (!v2BusyRef.current) void loadV2();
    }, 10000);
    return () => {
      window.clearTimeout(timeout);
      window.clearInterval(timer);
    };
  }, [loadShadowCall, loadV2]);

  const groups = useMemo(
    () => buildProviderModelGroups(models, providers),
    [models, providers],
  );

  // One-shot default collapse. It stays an effect on `groups` so CACHED groups collapse
  // immediately on first paint, even when revalidation is slow or fails; moving it into
  // the load() success path would render cached providers expanded and leave them
  // expanded whenever the refresh errors.
  useEffect(() => {
    if (!needsDefaultCollapseRef.current) return;
    if (groups.length === 0) return;
    needsDefaultCollapseRef.current = false;
    const all = new Set(groups.map(group => group.provider));
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCollapsed(all);
    writeCollapsedProviders(all);
  }, [groups]);

  const effectiveVisibleCount = useMemo(() => {
    if (!selectedModels) return 0;
    return models.filter(model => modelVisible(
      selectedModels,
      model.provider,
      model.id,
      model.native === true,
      disabled.has(model.namespaced),
    )).length;
  }, [disabled, models, selectedModels]);

  const applyVisibility = async (
    scope: ModelVisibilityScope,
    provider: string,
    targets: ModelVisibilityTarget[],
    enabled: boolean,
  ) => {
    ++loadGenerationRef.current;
    setBusy(true);
    busyRef.current = true;
    setStatus("");
    let errorKey: "models.saveFailed" | "models.networkError" | null = null;
    try {
      const response = await putModelVisibility(apiBase, scope, provider, targets, enabled);
      if (!response.ok) errorKey = "models.saveFailed";
    } catch {
      errorKey = "models.networkError";
    } finally {
      const refreshed = await load(true);
      if (errorKey) {
        setOk(false);
        setStatus(t(errorKey));
      } else if (refreshed) {
        setOk(true);
        setStatus(t("models.applied"));
      }
      setBusy(false);
      busyRef.current = false;
    }
  };

  const toggleProviderCap = async (provider: string) => {
    setBusy(true);
    busyRef.current = true;
    setStatus("");
    const enabled = contextCaps[provider] !== contextCapValue;
    try {
      const r = await fetch(`${apiBase}/api/provider-context-caps`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, enabled }),
      });
      try {
        const data = await readJsonOrThrow<ProviderContextCapsResponse>(r, t("models.capSaveFailed"));
        setContextCaps(data?.caps ?? {});
        setOk(true);
        setStatus(t("models.capApplied"));
        await load(true);
      } catch (e) {
        setOk(false);
        setStatus(e instanceof Error ? e.message : t("models.capSaveFailed"));
      }
    } catch {
      setOk(false); setStatus(t("models.networkError"));
    } finally {
      setBusy(false);
      busyRef.current = false;
    }
  };
  const toggleCollapse = (p: string) => {
    setCollapsed(prev => {
      const n = new Set(prev);
      if (n.has(p)) n.delete(p); else n.add(p);
      writeCollapsedProviders(n);
      return n;
    });
  };
  const setAllCollapsed = (collapse: boolean) => {
    setCollapsed(() => {
      const n = collapse ? new Set(groups.map(group => group.provider)) : new Set<string>();
      writeCollapsedProviders(n);
      return n;
    });
  };

  const putCap = async (body: Record<string, unknown>) => {
    setBusy(true);
    busyRef.current = true;
    setStatus("");
    try {
      const r = await fetch(`${apiBase}/api/provider-context-caps`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      try {
        const data = await readJsonOrThrow<ProviderContextCapsResponse>(r, t("models.capSaveFailed"));
        if (typeof data?.value === "number" && Number.isFinite(data.value) && data.value > 0) setContextCapValue(data.value);
        setContextCaps(data?.caps ?? {});
        setOk(true);
        setStatus(t("models.capApplied"));
        await load(true);
      } catch (e) {
        setOk(false);
        setStatus(e instanceof Error ? e.message : t("models.capSaveFailed"));
      }
    } catch {
      setOk(false); setStatus(t("models.networkError"));
    } finally {
      setBusy(false);
      busyRef.current = false;
    }
  };

  const setGlobalCap = (value: number) => {
    if (!Number.isFinite(value) || value <= 0) return;
    void putCap({ value: Math.floor(value) });
  };

  const onSelectCap = (raw: string) => {
    if (raw === CUSTOM_OPTION) { setShowCustom(true); setCustomCap(String(contextCapValue)); return; }
    setShowCustom(false);
    const value = Number(raw);
    if (Number.isFinite(value) && value > 0 && value !== contextCapValue) setGlobalCap(value);
  };

  const applyCustomCap = () => {
    const value = Number(customCap.replace(/[_,\s]/g, ""));
    if (!Number.isFinite(value) || value <= 0) { publishFeedback(false, t("models.capSaveFailed")); return; }
    setShowCustom(false);
    setGlobalCap(value);
  };

  const allCapped = useMemo(
    () => {
      // Cap aggregate counts routed providers only; the single native group has no cap switch.
      const routed = groups.filter(group => !group.native && group.rows.length > 0);
      return routed.length > 0 && routed.every(group => contextCaps[group.provider] === contextCapValue);
    },
    [groups, contextCaps, contextCapValue],
  );
  const setAll = () => { void putCap({ setAll: !allCapped }); };

  const saveShadowCall = async (patch: Partial<ShadowCallData>) => {
    if (!shadowCall || shadowCallSaving) return;
    setShadowCallSaving(true);
    setShadowCall({ ...shadowCall, ...patch });
    try {
      await fetch(`${apiBase}/api/shadow-call-settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
    } finally {
      setShadowCallSaving(false);
    }
  };

  const setMultiAgentMode = async (mode: "v1" | "default" | "v2") => {
    if (!v2 || v2BusyRef.current) return;
    if (v2.multiAgentMode === mode) return;
    setV2Busy(true);
    v2BusyRef.current = true;
    setV2Note("");
    setStatus("");
    try {
      const r = await fetch(`${apiBase}/api/v2`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ multiAgentMode: mode }),
      });
      try {
        const data = await readJsonOrThrow<V2Status & { warnings?: string[] }>(r, t("models.saveFailed"));
        void loadV2();
        setOk(true);
        setStatus(t("models.v2Applied"));
        setV2Note((data?.warnings ?? []).join(" "));
      } catch (e) {
        setOk(false);
        setStatus(e instanceof Error ? e.message : t("models.saveFailed"));
      }
    } catch {
      setOk(false); setStatus(t("models.networkError"));
    } finally {
      setV2Busy(false);
      v2BusyRef.current = false;
    }
  };

  const putV2Threads = async (value: number) => {
    // Same guards as the flag toggle: single-flight + server-side idempotence
    // (setMaxConcurrentThreads no-ops on equal value), so a re-selected current
    // value or a double click can never double-write config.toml.
    if (!v2 || v2BusyRef.current) return;
    if (!Number.isInteger(value) || value < 1) { publishFeedback(false, t("models.v2ThreadsInvalid")); return; }
    if (v2.maxConcurrentThreadsPerSession === value) return;
    setV2Busy(true);
    v2BusyRef.current = true;
    setV2Note("");
    setStatus("");
    try {
      const r = await fetch(`${apiBase}/api/v2`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxConcurrentThreadsPerSession: value }),
      });
      try {
        const data = await readJsonOrThrow<V2Status & { warnings?: string[] }>(r, t("models.saveFailed"));
        if (!data || typeof data.enabled !== "boolean") {
          setOk(false);
          setStatus(t("models.saveFailed"));
          return;
        }
        setV2({
          enabled: data.enabled,
          agentsMaxThreadsConflict: data.agentsMaxThreadsConflict === true,
          maxConcurrentThreadsPerSession: typeof data.maxConcurrentThreadsPerSession === "number" ? data.maxConcurrentThreadsPerSession : null,
          multiAgentMode: data.multiAgentMode === "v1" || data.multiAgentMode === "v2" ? data.multiAgentMode : "default",
        });
        setOk(true);
        setStatus(t("models.v2ThreadsApplied"));
        setShowThreadsCustom(false);
      } catch (e) {
        setOk(false);
        setStatus(e instanceof Error ? e.message : t("models.saveFailed"));
      }
    } catch {
      setOk(false); setStatus(t("models.networkError"));
    } finally {
      setV2Busy(false);
      v2BusyRef.current = false;
    }
  };

  const onSelectThreads = (raw: string) => {
    if (raw === CUSTOM_OPTION) { setShowThreadsCustom(true); setThreadsCustom(String(v2?.maxConcurrentThreadsPerSession ?? "")); return; }
    setShowThreadsCustom(false);
    void putV2Threads(Number(raw));
  };

  const onRowEnter = (namespaced: string, el: HTMLElement) => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => {
      setHoveredModel({ namespaced, rect: el.getBoundingClientRect() });
    }, 300);
  };

  const onRowFocus = (namespaced: string, el: HTMLElement) => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    setHoveredModel({ namespaced, rect: el.getBoundingClientRect() });
  };

  const onRowLeave = () => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => setHoveredModel(null), 120);
  };

  const keepRowTipOpen = () => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
  };

  const addCustomModel = async (
    provider: string,
    modelId: string,
    displayName?: string,
    contextWindow?: number,
    inputModalities?: string[],
  ) => {
    setCustomSaving(true);
    setCustomError("");
    try {
      const r = await fetch(`${apiBase}/api/custom-models`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, modelId, displayName, contextWindow, inputModalities }),
      });
      try {
        await readJsonOrThrow(r, t("models.customSaveFailed"));
        setCustomModalOpen(false);
        publishFeedback(true, t("models.customAdded"));
        await load(true);
      } catch (e) {
        setCustomError(e instanceof Error ? e.message : t("models.customSaveFailed"));
      }
    } catch {
      setCustomError(t("models.networkError"));
    } finally {
      setCustomSaving(false);
    }
  };

  const updateCustomModel = async (id: string, patch: Record<string, unknown>) => {
    setCustomSaving(true);
    setCustomError("");
    try {
      const r = await fetch(`${apiBase}/api/custom-models/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      try {
        await readJsonOrThrow(r, t("models.customSaveFailed"));
        setCustomModalOpen(false);
        publishFeedback(true, t("models.customUpdated"));
        await load(true);
      } catch (e) {
        setCustomError(e instanceof Error ? e.message : t("models.customSaveFailed"));
      }
    } catch {
      setCustomError(t("models.networkError"));
    } finally {
      setCustomSaving(false);
    }
  };

  const deleteCustomModel = async (id: string) => {
    try {
      const r = await fetch(`${apiBase}/api/custom-models/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (r.ok) {
        publishFeedback(true, t("models.customDeleted"));
        await load(true);
      } else {
        publishFeedback(false, t("models.customSaveFailed"));
      }
    } catch {
      publishFeedback(false, t("models.networkError"));
    }
  };

  const catalog = catalogState.data ?? cached;

  // A session seed keeps the workspace usable during the first shared-resource revalidation.
  // Without a catalog, the skeleton owns the only live region for this transition.
  if (catalogState.showSkeleton && !catalog) {
    return (
      <DataSurfaceSkeleton label={t("models.loading")} rows={5} />
    );
  }
  if (catalogState.kind === "failed-cold") {
    const reason = catalogState.error instanceof Error ? catalogState.error.message : t("models.loadFail");
    return (
      <>
        <Notice tone="err">{reason}</Notice>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => catalogResource.refresh()}>{t("common.retry")}</button>
      </>
    );
  }

  const selectedModelMap = selectedModels ?? {};

  const renderGroup = (group: ProviderModelGroup<ModelRow>) => {
    const { provider, rows, native, liveModels, discovery } = group;
    const isCollapsed = collapsed.has(provider);
    // Final visibility, not just the disable flag: a model is visible to Codex only when the
    // provider allowlist admits it AND it is not disabled. Reading `disabled` alone made the
    // switches disagree with what the picker actually offers.
    const isVisible = (model: ModelRow) => modelVisible(
      selectedModelMap,
      provider,
      model.id,
      model.native === true,
      disabled.has(model.namespaced),
    );
    const activeCount = rows.filter(isVisible).length;
    const capOn = contextCaps[provider] === contextCapValue;
    const isNative = native;
    const discoveryFailure = liveModels && discovery?.status === "failed" ? discovery : undefined;
    const q = (search[provider] ?? "").trim().toLowerCase();
    const filtered = q ? rows.filter(m => m.id.toLowerCase().includes(q)) : rows;
    // Display-only: enabled models float to the top of each provider group so they
    // stay findable in long lists. The sort is stable, so the server order is kept
    // inside each partition, and this does not affect the picker order above
    // (visibility toggles still only filter).
    const sorted = filtered.toSorted((a, b) => Number(!isVisible(a)) - Number(!isVisible(b)));
    const shown = limit[provider] ?? PAGE;
    const visible = sorted.slice(0, shown);
    const remaining = filtered.length - visible.length;
     // An empty provider has nothing to send: keep both bulk buttons inert so we never PUT an
     // empty target list (the management API rejects it with 400).
     const hasRows = rows.length > 0;
     const allOn = !hasRows || rows.every(isVisible);
     const allOff = !hasRows || rows.every(m => !isVisible(m));
     const bulkToggle = (enable: boolean) => {
       if (!hasRows) return;
       void applyVisibility(
         "provider",
         provider,
         rows.map(m => ({ id: m.id, native: m.native === true })),
         enable,
       );
     };
    return (
      <div key={provider} className="card models-provider-card">
       <div className={`row group-head models-provider-head${isCollapsed ? "" : " open"}`}>
          <button
            type="button"
            className="row models-provider-toggle"
            onClick={() => toggleCollapse(provider)}
            aria-expanded={!isCollapsed}
            style={{ flex: 1, border: 0, background: "transparent", padding: 0, color: "inherit", cursor: "pointer", textAlign: "left" }}
          >
          <IconChevron style={{ width: 14, height: 14, color: "var(--muted)", transform: isCollapsed ? "none" : "rotate(90deg)", transition: "transform .12s" }} />
          <span className="text-body font-semibold">{provider}</span>
          {isNative && <span className="models-chip muted mono text-caption">{t("models.nativeGroupLabel")}</span>}
         {discoveryFailure && (
           <span
             className="badge badge-amber"
             role="status"
             title={discoveryFailureLabel(t, discoveryFailure)}
           >
             {t("models.discoveryFailedBadge")}
           </span>
         )}
          <span className="muted mono text-label">{t("models.active", { active: activeCount, total: rows.length })}</span>
          </button>
           <div className="row models-provider-actions">
             {!isNative && (
               <button
                 type="button"
                 className="btn btn-ghost btn-sm text-caption"
                 onClick={(e) => {
                   e.stopPropagation();
                   setCustomModalMode("add");
                   setCustomModalProvider(provider);
                   setCustomModalId("");
                   setCustomFormModelId("");
                   setCustomFormDisplayName("");
                   setCustomFormContextWindow("");
                   setCustomFormShowCustomCtx(false);
                   setCustomFormModalities(["text"]);
                   setCustomError("");
                   setCustomModalOpen(true);
                 }}
                 aria-label={t("models.customAdd")}
                 aria-haspopup="dialog"
               >+</button>
             )}
             <button type="button" className="btn btn-ghost btn-sm text-caption" disabled={busy || allOn} onClick={() => bulkToggle(true)}>{t("models.allOn")}</button>
             <button type="button" className="btn btn-ghost btn-sm text-caption" disabled={busy || allOff} onClick={() => bulkToggle(false)}>{t("models.allOff")}</button>
             {!isNative && <>
               <Switch on={capOn} onClick={() => toggleProviderCap(provider)} disabled={busy} label={t("models.capValue", { value: fmtK(contextCapValue) })} />
               <span className="muted mono text-label">{t("models.capValue", { value: fmtK(contextCapValue) })}</span>
             </>}
           </div>
        </div>
        {!isCollapsed && (
          <div className="models-provider-body">
            {isNative && <p className="muted text-label models-provider-hint">{t("models.nativeHint")}</p>}
            {rows.length === 0 && (
              <EmptyProviderHint liveModels={liveModels} discovery={discovery} showFailureBadge={false} />
            )}
            {rows.length > PAGE / 2 && (
              <input
                className="input"
                placeholder={t("models.search")}
                value={search[provider] ?? ""}
                onChange={e => setSearch(prev => ({ ...prev, [provider]: e.target.value }))}
                aria-label={t("models.search")}
              />
            )}
             {visible.map(m => {
               // The row reflects the same final-visibility answer as the count and the picker.
               const off = !isVisible(m);
               return (
                 <div
                   key={m.namespaced}
                   className="model-row-wrap"
                   onMouseEnter={(e) => onRowEnter(m.namespaced, e.currentTarget)}
                   onMouseLeave={onRowLeave}
                   onFocus={(e) => onRowFocus(m.namespaced, e.currentTarget)}
                   onBlur={(e) => {
                     if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHoveredModel(null);
                   }}
                 >
                   <div className="row models-model-row">
                     <Switch on={!off} onClick={() => void applyVisibility("models", provider, [{ id: m.id, native: m.native === true }], off)} disabled={busy} label={m.native ? m.id : m.namespaced} />
                     <code className="mono text-control" style={{ color: off ? "var(--faint)" : "var(--text)", textDecoration: off ? "line-through" : "none" }}>{m.native ? modelLabel(m.id) : m.namespaced}</code>
                     {m.custom && (
                       <span className="models-chip muted mono text-caption">
                         {t("models.customBadge")}
                       </span>
                     )}
                     {m.contextCapped && <span className="models-chip muted mono text-caption">{t("models.contextCappedValue", { value: fmtK(m.contextCap ?? contextCapValue) })}</span>}
                   </div>
                   {hoveredModel?.namespaced === m.namespaced && (() => {
                     const r = hoveredModel.rect;
                     const tipTop = r.bottom + 4;
                     const flipUp = tipTop + 360 > window.innerHeight;
                     return (
                       <div
                         className={`model-tip${m.custom ? " has-actions" : ""}${flipUp ? " flip-up" : ""}`}
                         role="tooltip"
                         style={{
                           position: "fixed",
                           left: r.left + 24,
                           ...(flipUp
                             ? { bottom: window.innerHeight - r.top + 4 }
                             : { top: tipTop }),
                         }}
                         onMouseEnter={keepRowTipOpen}
                         onMouseLeave={onRowLeave}
                       >
                         <div className="model-tip-id">{m.native ? m.id : m.namespaced}</div>
                         {m.displayName && <div className="model-tip-display">{m.displayName}</div>}
                         {m.custom && (
                           <span className="models-chip models-chip--tip muted mono text-caption">
                             {t("models.customBadge")}
                           </span>
                         )}
                         <div className="model-tip-grid">
                           <span className="model-tip-key">{t("models.tipProvider")}</span>
                           <span className="model-tip-val">{m.provider}</span>
                           {(m.contextWindow || m.contextCap) && (
                             <>
                               <span className="model-tip-key">{t("models.tipContext")}</span>
                               <span className="model-tip-val">{fmtK(m.contextWindow ?? m.contextCap ?? 0)}</span>
                             </>
                           )}
                           {m.inputModalities && m.inputModalities.length > 0 && (
                             <>
                               <span className="model-tip-key">{t("models.tipModalities")}</span>
                               <span className="model-tip-val">{m.inputModalities.join(", ")}</span>
                             </>
                           )}
                           <span className="model-tip-key">{t("models.tipStatus")}</span>
                           <span className="model-tip-val">{off ? t("models.tipDisabled") : t("models.tipActive")}</span>
                         </div>
                         {m.custom && m.customId && (
                           <div className="model-tip-actions">
                             <button
                               type="button"
                               className="btn btn-ghost btn-sm text-caption"
                               onClick={() => {
                                 setCustomModalMode("edit");
                                 setCustomModalProvider(m.provider);
                                 setCustomModalId(m.customId!);
                                 setCustomFormModelId(m.id);
                                 setCustomFormDisplayName(m.displayName ?? "");
                                 setCustomFormContextWindow(m.contextWindow ? String(m.contextWindow) : "");
                                 setCustomFormShowCustomCtx(false);
                                 setCustomFormModalities(m.inputModalities ?? ["text"]);
                                 setCustomError("");
                                 setCustomModalOpen(true);
                                 setHoveredModel(null);
                               }}
                             >{t("models.customEdit")}</button>
                             <button
                               type="button"
                               className="btn btn-ghost btn-sm text-caption"
                               style={{ color: "var(--red)" }}
                               onClick={() => {
                                 if (window.confirm(t("models.customDeleteConfirm", { name: m.displayName ?? m.id }))) {
                                   void deleteCustomModel(m.customId!);
                                 }
                                 setHoveredModel(null);
                               }}
                             >{t("models.customDelete")}</button>
                           </div>
                         )}
                       </div>
                     );
                   })()}
                 </div>
               );
             })}
             {remaining > 0 && (
               <button
                 type="button"
                 onClick={() => setLimit(prev => ({ ...prev, [provider]: shown + PAGE }))}
                 className="btn btn-ghost btn-sm models-show-more"
               >{t("models.showMore", { n: remaining })}</button>
             )}
           </div>
         )}
       </div>
     );
  };

  const visibleGroups = selectedProvider
    ? groups.filter(group => group.provider === selectedProvider)
    : groups;

  const controlsBlock = (
    <>
      <div className="models-control-top-row">
        <div className="models-shadow-row row muted text-control" aria-busy={!shadowCall || undefined}>
          <span className="models-shadow-label">{t("models.shadowCallIntercept")} <Tooltip content={t("models.shadowCallInterceptHint", { models: shadowSourceModelLabel(shadowCall?.sourceModels) })} side="top" maxWidth={320}><span style={{ cursor: "help" }} aria-label={t("models.shadowCallInterceptHint", { models: shadowSourceModelLabel(shadowCall?.sourceModels) })}>ⓘ</span></Tooltip></span>
          <code className="text-caption models-shadow-warning" style={{ opacity: 0.6 }}>{t("models.shadowCallOriginal", { models: shadowSourceModelBadge(shadowCall?.sourceModels) })}</code>
          <Switch on={shadowCall?.enabled ?? false} onClick={() => void saveShadowCall({ enabled: !shadowCall?.enabled })} disabled={!shadowCall || shadowCallSaving} label={t("models.shadowCallIntercept")} />
          <div className="models-shadow-model-slot">
            <Select value={shadowCall?.model ?? ""} options={[{ value: "", label: "\u2014" }, ...shadowModelOptions]} onChange={v => { setShadowCall(c => c ? { ...c, model: v } : c); void saveShadowCall({ model: v }); }} disabled={!shadowCall || shadowCallSaving || !shadowCall.enabled} label={t("models.shadowCallIntercept")} />
          </div>
        </div>

        {(v2Loading || v2) && (
          <div className="models-v2-mode-row row">
            <span className="muted text-control">{t("models.v2Label")}</span>
            <div className="segmented models-segmented" role="radiogroup" aria-label={t("models.v2Label")}>
              {(["v1", "default", "v2"] as const).map(mode => (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={(v2?.multiAgentMode ?? "default") === mode}
                  className={`btn btn-sm${(v2?.multiAgentMode ?? "default") === mode ? " btn-primary" : " btn-ghost"}`}
                  style={{ background: (v2?.multiAgentMode ?? "default") === mode ? undefined : "transparent", color: (v2?.multiAgentMode ?? "default") === mode ? undefined : "var(--muted)" }}
                  disabled={!v2 || v2Busy}
                  onClick={() => void setMultiAgentMode(mode)}
                >
                  {t(`models.v2Mode_${mode}` as TKey)}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              style={{ width: 24, height: 24, minWidth: 24, flex: "0 0 24px", padding: 0, borderRadius: "var(--radius-pill)", color: "var(--muted)" }}
              disabled={!v2}
              onClick={() => setV2HelpOpen(true)}
              aria-label={t("models.v2Label")}
              aria-haspopup="dialog"
            >
              <IconInfo width={14} height={14} aria-hidden="true" />
            </button>
          </div>
        )}
      </div>

      {v2 && (v2.enabled || v2.agentsMaxThreadsConflict || v2Note) && (
        <div className="models-v2-detail-row row">
          {v2.enabled && (
            <>
              <span className="muted text-control">{t("models.v2ThreadsLabel")}</span>
              <Select
                value={showThreadsCustom
                  ? CUSTOM_OPTION
                  : (v2.maxConcurrentThreadsPerSession !== null && v2.maxConcurrentThreadsPerSession !== undefined
                    ? (THREAD_OPTION_SET.has(v2.maxConcurrentThreadsPerSession) ? String(v2.maxConcurrentThreadsPerSession) : CUSTOM_OPTION)
                    : "")}
                options={[
                  ...(v2.maxConcurrentThreadsPerSession === null || v2.maxConcurrentThreadsPerSession === undefined
                    ? [{ value: "", label: t("models.v2ThreadsDefault") }] : []),
                  ...(v2.maxConcurrentThreadsPerSession !== null && v2.maxConcurrentThreadsPerSession !== undefined
                    && !THREAD_OPTION_SET.has(v2.maxConcurrentThreadsPerSession) && !showThreadsCustom
                    ? [{ value: CUSTOM_OPTION, label: String(v2.maxConcurrentThreadsPerSession) }] : []),
                  ...THREAD_OPTIONS.map(v => ({ value: String(v), label: String(v) })),
                  { value: CUSTOM_OPTION, label: t("models.custom") },
                ]}
                onChange={v => onSelectThreads(v)}
                disabled={v2Busy}
                label={t("models.v2ThreadsLabel")}
              />
              {showThreadsCustom && (
                <>
                  <input
                    className="input"
                    style={{ width: 100 }}
                    inputMode="numeric"
                    value={threadsCustom}
                    onChange={e => setThreadsCustom(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") void putV2Threads(Number(threadsCustom.replace(/[_,\s]/g, ""))); }}
                    disabled={v2Busy}
                    aria-label={t("models.v2ThreadsLabel")}
                  />
                  <button type="button" className="btn btn-sm" disabled={v2Busy}
                    onClick={() => { void putV2Threads(Number(threadsCustom.replace(/[_,\s]/g, ""))); }}>
                    {t("models.v2ThreadsApply")}
                  </button>
                </>
              )}
            </>
          )}
          {v2.enabled && v2.agentsMaxThreadsConflict && (
            <span className="mono text-label" style={{ color: "var(--err, #e5484d)" }}>{t("models.v2Conflict")}</span>
          )}
          {v2Note && <span className="muted text-label">{v2Note}</span>}
        </div>
      )}

      <div className="row models-cap-row">
        <span className="muted text-control">{t("models.contextCapLabel")}</span>
        <Select
          value={showCustom ? CUSTOM_OPTION : (CAP_OPTION_SET.has(contextCapValue) ? String(contextCapValue) : CUSTOM_OPTION)}
          options={[
            ...(!CAP_OPTION_SET.has(contextCapValue) && !showCustom
              ? [{ value: String(contextCapValue), label: fmtK(contextCapValue) }] : []),
            ...CAP_OPTIONS.map(v => ({ value: String(v), label: fmtK(v) })),
            { value: CUSTOM_OPTION, label: t("models.custom") },
          ]}
          onChange={v => onSelectCap(v)}
          disabled={busy}
          label={t("models.contextCapLabel")}
        />
        {showCustom && (
          <>
            <input
              className="input"
              style={{ width: 160 }}
              inputMode="numeric"
              placeholder={t("models.customPlaceholder")}
              value={customCap}
              onChange={e => setCustomCap(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") applyCustomCap(); }}
              disabled={busy}
              aria-label={t("models.customPlaceholder")}
            />
            <button type="button" onClick={applyCustomCap} disabled={busy} className="btn btn-ghost btn-sm">{t("models.customApply")}</button>
          </>
        )}
        <Switch on={allCapped} onClick={setAll} disabled={busy} label={t("models.setAll")} />
        <span className="muted text-label leading-body">{t("models.setAllHint", { value: fmtK(contextCapValue) })}</span>
      </div>

      {(() => {
        const customCount = models.filter(m => m.custom).length;
        if (customCount === 0) return null;
        return (
          <div className="row muted text-label models-custom-summary">
            <span className="models-chip mono text-caption">
              {t("models.customSummary", { count: customCount })}
            </span>
          </div>
        );
      })()}

      <div className="row muted text-label leading-body models-order-hint">
        <IconInfo width={15} height={15} aria-hidden="true" />
        <span>{t("models.orderHint")}</span>
      </div>
    </>
  );

  const combosBlock = (
    <>
      {/* Silent height strut: reserves the empty-card slot so a late /api/combos
          cannot insert a row, without a bordered "Combos · Loading…" placeholder. */}
      {combos === null && !combosError && (
        <div className="models-combos-card models-combos-card--pending" aria-busy="true">
          <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
            {t("common.loading")}
          </span>
        </div>
      )}
      {combos === null && combosError && (
        <div className="card models-combos-card">
          <div className="row models-combos-empty-head">
            <div className="row models-field-row" style={{ minWidth: 0 }}>
              <IconShuffle width={14} height={14} aria-hidden="true" style={{ flexShrink: 0 }} />
              <strong>{t("nav.combos")}</strong>
              <span className="muted text-label" role="alert">{t("models.loadFail")}</span>
            </div>
            <button type="button" className="btn btn-sm" style={{ flexShrink: 0 }} onClick={() => combosResource.refresh()}>
              {t("common.retry")}
            </button>
          </div>
        </div>
      )}
      {combos !== null && combos.length === 0 && (
        <div className="card models-combos-card">
          <div className="row models-combos-empty-head">
            <div className="row models-field-row" style={{ minWidth: 0 }}>
              <IconShuffle width={14} height={14} aria-hidden="true" style={{ flexShrink: 0 }} />
              <strong>{t("nav.combos")}</strong>
              {combosError ? (
                <span className="muted text-label" role="alert">{t("models.loadFail")}</span>
              ) : (
                <span className="muted text-label">{t("models.combosEmpty")}</span>
              )}
            </div>
            {combosError ? (
              <button type="button" className="btn btn-sm" style={{ flexShrink: 0 }} onClick={() => combosResource.refresh()}>
                {t("common.retry")}
              </button>
            ) : (
              <a className="btn btn-sm" href="#combos" style={{ flexShrink: 0 }}>{t("models.combosSetup")}</a>
            )}
          </div>
        </div>
      )}
      {combos !== null && combos.length > 0 && (
        <div className="card models-combos-card">
          <div className={`row group-head models-field-row${combosOpen ? " open" : ""}`}>
            <button
              type="button"
              className="row models-field-row"
              aria-expanded={combosOpen}
              onClick={toggleCombosOpen}
              style={{ flex: 1, background: "none", border: "none", padding: 0, cursor: "pointer", font: "inherit", color: "inherit", textAlign: "left", minWidth: 0 }}
            >
              <IconChevron style={{ width: 14, height: 14, color: "var(--muted)", flexShrink: 0, transform: combosOpen ? "rotate(90deg)" : "none", transition: "transform .12s" }} />
              <IconShuffle width={14} height={14} aria-hidden="true" style={{ flexShrink: 0 }} />
              <strong>{t("nav.combos")}</strong>
              <span className="muted mono text-label">{t("models.combosActive", { count: combos.length })}</span>
              {combosError && (
                <span className="muted text-label" role="alert">{t("models.loadFail")}</span>
              )}
            </button>
            {combosError ? (
              <button type="button" className="btn btn-sm btn-ghost" style={{ flexShrink: 0 }} onClick={() => combosResource.refresh()}>
                {t("common.retry")}
              </button>
            ) : (
              <a className="btn btn-sm btn-ghost" href="#combos" style={{ flexShrink: 0 }}>{t("models.combosSetup")}</a>
            )}
          </div>
          {combosOpen && (
            <div>
              {combos.map(c => (
                <div key={c.id} className="row models-combo-row">
                  <span className="mono leading-ui">{c.model}</span>
                  <span className="muted text-label">{c.strategy} · {c.targets.length}</span>
                </div>
              ))}
              <a className="row muted models-combos-add" href="#combos">
                + {t("models.combosAdd")}
              </a>
            </div>
          )}
        </div>
      )}
    </>
  );

  const collapseControls = (
    <div className="row models-collapse-controls">
      <button type="button" className="btn btn-ghost btn-sm text-caption" onClick={() => setAllCollapsed(true)} disabled={busy}>
        <IconChevron width={12} height={12} aria-hidden="true" /> {t("models.collapseAll")}
      </button>
      <button type="button" className="btn btn-ghost btn-sm text-caption" onClick={() => setAllCollapsed(false)} disabled={busy}>
        <IconChevron width={12} height={12} aria-hidden="true" style={{ transform: "rotate(90deg)" }} /> {t("models.expandAll")}
      </button>
    </div>
  );

  const emptyStateBlock = (
    <>
      {groups.length === 0 && (
        <EmptyState icon={<IconBoxes />} title={t("models.noRouted")}>
          {t("models.noRoutedHint")}
        </EmptyState>
      )}
    </>
  );

  const modalsBlock = (
    <>
      {v2HelpOpen && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-label={t("models.v2Label")} onClick={() => setV2HelpOpen(false)} onKeyDown={e => { if (e.key === "Escape") setV2HelpOpen(false); }}>
          <div className="modal-card" onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              <h3>{t("models.v2Label")}</h3>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setV2HelpOpen(false)} aria-label={t("common.close")}>&times;</button>
            </div>
            <div className="modal-desc leading-relaxed" style={{ whiteSpace: "pre-line" }}>
              {t("models.v2Help")}
            </div>
            <div className="models-help-link">
              <a className="text-control" href="https://opencodex.me/guides/sub-agent-surface/" target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>
                {t("models.v2DocsLink")}
              </a>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-primary" onClick={() => setV2HelpOpen(false)}>{t("common.ok")}</button>
            </div>
          </div>
        </div>
      )}

      {customModalOpen && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={t("models.customAdd")}
          onClick={() => { if (!customSaving) setCustomModalOpen(false); }}
          onKeyDown={(e) => {
            if (e.key === "Escape" && !customSaving) setCustomModalOpen(false);
          }}
        >
          <div className="modal-card" onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              <h3>
                {customModalMode === "add"
                  ? t("models.customAddTitle", { provider: customModalProvider })
                  : t("models.customEditTitle", { provider: customModalProvider })}
              </h3>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setCustomModalOpen(false)}
                disabled={customSaving}
                aria-label={t("common.close")}
              >&times;</button>
            </div>

            {customError && <Notice tone="err">{customError}</Notice>}

            <div className="models-field-stack">
              <label className="text-label models-field">
                {t("models.customFieldModelId")}
                <input
                  className="input"
                  value={customFormModelId}
                  onChange={e => setCustomFormModelId(e.target.value)}
                  disabled={customSaving}
                  placeholder={t("models.customFieldModelIdPlaceholder")}
                  autoFocus
                />
              </label>

              <label className="text-label models-field">
                {t("models.customFieldDisplayName")}
                <input
                  className="input"
                  value={customFormDisplayName}
                  onChange={e => setCustomFormDisplayName(e.target.value)}
                  disabled={customSaving}
                  placeholder={t("models.customFieldDisplayNamePlaceholder")}
                />
              </label>

              <label className="text-label models-field">
                {t("models.customFieldContext")}
                <div className="row models-field-row">
                  <Select
                    value={customFormShowCustomCtx ? CUSTOM_OPTION : customFormContextWindow}
                    options={[
                      { value: "", label: "—" },
                      { value: "100000", label: "100k" },
                      { value: "128000", label: "128k" },
                      { value: "200000", label: "200k" },
                      { value: "256000", label: "256k" },
                      { value: "352000", label: "352k" },
                      { value: "500000", label: "500k" },
                      { value: "1000000", label: "1M" },
                      { value: CUSTOM_OPTION, label: t("models.custom") },
                    ]}
                    onChange={v => {
                      if (v === CUSTOM_OPTION) {
                        setCustomFormShowCustomCtx(true);
                        return;
                      }
                      setCustomFormShowCustomCtx(false);
                      setCustomFormContextWindow(v);
                    }}
                    disabled={customSaving}
                    label={t("models.customFieldContext")}
                  />
                  {customFormShowCustomCtx && (
                    <input
                      className="input"
                      style={{ width: 120 }}
                      inputMode="numeric"
                      value={customFormContextWindow}
                      onChange={e => setCustomFormContextWindow(e.target.value)}
                      disabled={customSaving}
                      placeholder={t("models.customPlaceholder")}
                      aria-label={t("models.customFieldContext")}
                    />
                  )}
                </div>
              </label>

              <div className="text-label models-field">
                {t("models.customFieldModalities")}
                <div className="row models-field-row">
                  {(["text", "image", "audio"] as const).map(mod => (
                    <label key={mod} className="row models-modality-option">
                      <input
                        type="checkbox"
                        checked={customFormModalities.includes(mod)}
                        onChange={e => {
                          setCustomFormModalities(prev => (
                            e.target.checked ? [...prev, mod] : prev.filter(m => m !== mod)
                          ));
                        }}
                        disabled={customSaving}
                      />
                      <span className="text-control">{mod}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>

            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setCustomModalOpen(false)} disabled={customSaving}>
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={customSaving || !customFormModelId.trim()}
                onClick={() => {
                  const modelId = customFormModelId.trim();
                  const displayName = customFormDisplayName.trim();
                  const ctxVal = customFormContextWindow ? Number(customFormContextWindow.replace(/[_,\s]/g, "")) : undefined;
                  const contextWindow = ctxVal && ctxVal > 0 ? Math.floor(ctxVal) : undefined;
                  if (customModalMode === "add") {
                    void addCustomModel(
                      customModalProvider,
                      modelId,
                      displayName || undefined,
                      contextWindow,
                      customFormModalities.length > 0 ? customFormModalities : undefined,
                    );
                  } else {
                    void updateCustomModel(customModalId, {
                      modelId,
                      displayName,
                      contextWindow: contextWindow ?? null,
                      inputModalities: customFormModalities,
                    });
                  }
                }}
              >
                {customSaving
                  ? t("models.customSaving")
                  : (customModalMode === "add" ? t("models.customAddBtn") : t("models.customEditBtn"))}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );

  return (
    <div className="models-workspace-shell">
      <div className="page-head">
        <h2>{t("nav.models")}</h2>
        <div className="row">
          <span className="muted mono text-label">{t("models.active", { active: effectiveVisibleCount, total: models.length })}</span>
        </div>
      </div>
      <p className="page-sub">{t("models.subtitle")}</p>
      {status && (
        <div className={`action-toast notice ${ok ? "notice-ok" : "notice-err"}`} role="status" aria-live="polite">
          {ok ? <IconCheck /> : <IconAlert />}
          <span>{status}</span>
        </div>
      )}
      {/* Keep the last-good catalog interactive but make a failed revalidation explicit. */}
      {catalogState.showError && <Notice tone="err">{t("models.loadFail")}</Notice>}
      <div className="models-workspace-root" aria-busy={catalogState.refreshing || undefined}>
        <aside className="models-workspace-rail" aria-label={t("nav.models")}>
          <div className="models-workspace-rail-header">
            <span className="models-workspace-rail-title">{t("models.workspace.providers")}</span>
            <span className="models-workspace-rail-count">{groups.length}</span>
          </div>
          <div className="models-workspace-rail-list">
            <button
              type="button"
              className={`models-workspace-rail-row${selectedProvider === null ? " models-workspace-rail-row--selected" : ""}`}
              onClick={() => setSelectedProvider(null)}
              aria-current={selectedProvider === null ? "true" : undefined}
            >
              <span className="models-workspace-rail-name">{t("models.workspace.allProviders")}</span>
              <span className="models-workspace-rail-meta">{t("models.active", { active: effectiveVisibleCount, total: models.length })}</span>
            </button>
            {groups.map(group => {
              const { provider, rows } = group;
              // Same final-visibility rule as the provider card, so the rail never disagrees with it.
              const activeCount = rows.filter(m => modelVisible(
                selectedModelMap,
                provider,
                m.id,
                m.native === true,
                disabled.has(m.namespaced),
              )).length;
              return (
                <button
                  key={provider}
                  type="button"
                  className={`models-workspace-rail-row${selectedProvider === provider ? " models-workspace-rail-row--selected" : ""}`}
                  onClick={() => setSelectedProvider(provider)}
                  aria-current={selectedProvider === provider ? "true" : undefined}
                >
                  <span className="models-workspace-rail-name">{provider}</span>
                  <span className="models-workspace-rail-meta">{t("models.active", { active: activeCount, total: rows.length })}</span>
                </button>
              );
            })}
          </div>
        </aside>
        <section className="models-workspace-main" aria-label={t("models.workspace.mainAria")}>
          {controlsBlock}
          {combosBlock}
          {collapseControls}
          <div className="models-provider-list">
            {
              // eslint-disable-next-line react-hooks/refs -- The hover ref is only read by row event handlers nested in this renderer.
              visibleGroups.map(group => renderGroup(group))
            }
          </div>
          {groups.length === 0 && emptyStateBlock}
        </section>
      </div>
      {modalsBlock}
    </div>
  );

}
