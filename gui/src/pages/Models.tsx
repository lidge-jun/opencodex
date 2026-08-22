import { CodexStaleBanner } from "../components/codex-stale-banner";
import { fetchCodexAppServerState } from "../codex-app-server-state";
import type { AppServerStateOutcome } from "../codex-app-server-state";
import { useCodexRestart } from "../use-codex-restart";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Switch, Notice, EmptyState, Select, Tooltip } from "../ui";
import { IconChevron, IconBoxes, IconInfo, IconCheck, IconAlert, IconRefresh } from "../icons";
import { useT } from "../i18n/shared";
import type { TFn, TKey } from "../i18n/shared";
import { modelLabel } from "../model-display";
import { formatNamespacedModelId, formatProviderDisplayName, providerDisplaySlug } from "../provider-icons";
import { readJsonIfOk, readJsonOrThrow } from "../fetch-json";
import { readSessionListCache, writeSessionListCache } from "../session-list-cache";
import { setClientResourceData } from "../client-resource";
import { createBoundedFetch } from "../bounded-fetch";
import { startVisibilityPoll } from "../visibility-poll";
import { useDataSurface } from "../data-surface";
import { DataSurfaceSkeleton } from "../components/data-surface";
import ErrorBoundary from "../components/ErrorBoundary";
import Combos from "./Combos";
import RoutingProfiles from "./RoutingProfiles";
import CompatibilityMatrix from "./CompatibilityMatrix";
import { ModelsTabStrip } from "./models-tab-strip";
import {
  modelsPanelDomId,
  modelsTabDomId,
  readModelsTab,
  selectModelsTab,
  type ModelsTab,
} from "./models-tab";
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
  NATIVE_CAP_OPTIONS,
  NATIVE_CAP_OPTION_SET,
  NATIVE_GPT56_DEFAULT_WINDOW,
  NATIVE_GPT56_OPT_IN_WINDOW,
  PAGE,
  readCollapsedProviders,
  THREAD_OPTION_SET,
  THREAD_OPTIONS,
  writeCollapsedProviders,
  discoveryFailureLabel,
  REASONING_EFFORT_LEVELS,
  type ModelRow,
  type ProviderContextCapsResponse,
  type ShadowCallData,
  type V2Status,
} from "./models-shared";
import { EmptyProviderHint } from "./models-provider-hints";
import { shadowCallModelOptions } from "./dashboard-shared";
import { shadowSourceModelBadge, shadowSourceModelLabel } from "./shadow-call-source";

type CachedModelsPage = {
  models: ModelRow[];
  providers: ConfiguredProviderSummary[];
  selectedModels: ProviderModelMap;
  disabled: string[];
  contextCaps: Record<string, number>;
  contextCapValue: number;
};

/** One subtitle per tab: only one panel is visible, so only one description applies. */
const SUBTITLE_TKEY: Record<ModelsTab, TKey> = {
  catalog: "models.subtitle",
  combos: "models.subtitle.combos",
  routing: "models.subtitle.routing",
  compatibility: "models.subtitle.compatibility",
};

/**
 * Parse a context-window field: a number, `null` for "unset", or `undefined` when the text is
 * not usable. Separators are cosmetic, so "64,000" and "64_000" and "64000" are one value.
 *
 * Safe-integer rather than integer: `Number.isInteger(1e100)` is true, the server rejects it,
 * and accepting it here would turn a typo into a round-trip error instead of inline feedback.
 *
 * Module scope because it closes over nothing — rebuilding it every render is wasted work.
 */
function parseContextWindowDraft(raw: string): number | null | undefined {
  const normalized = raw.replace(/[_,\s]/g, "");
  if (!normalized) return null;
  const value = Number(normalized);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export default function Models({ apiBase, restartEpoch = 0 }: { apiBase: string; restartEpoch?: number }) {
  // Codex app-server staleness (devlog/_fin/260815_gui_codex_restart). Named
  // appServerState, not catalogState: this file already binds that name to the
  // model-catalog resource state, which is an unrelated concept. (Spelling the
  // catalog route here would register a phantom endpoint with the CLI parity
  // sweep, which reads GUI sources for api paths.)
  const [appServerState, setAppServerState] = useState<AppServerStateOutcome["state"]>(null);
  // A restart request outlives a navigation away from this page, so its completion
  // callback must not set state after unmount.
  const appServerMounted = useRef(true);
  useEffect(() => {
    appServerMounted.current = true;
    return () => { appServerMounted.current = false; };
  }, []);

  const reloadAppServerState = useCallback((signal?: AbortSignal) => {
    void fetchCodexAppServerState(apiBase, { signal }).then(outcome => {
      if (signal?.aborted || !appServerMounted.current) return;
      setAppServerState(outcome.state);
    });
  }, [apiBase]);

  // onSettled, not a per-button callback: the sidebar control knows nothing about
  // this page, and a restart succeeding there must still clear the banner here.
  const { restarting: codexRestarting, restart: handleCodexRestart } = useCodexRestart(apiBase, {
    onSettled: () => reloadAppServerState(),
  });

  useEffect(() => {
    // Once on mount, on apiBase change, and when a restart settles anywhere in the
    // app (restartEpoch) — never a timer.
    const controller = new AbortController();
    reloadAppServerState(controller.signal);
    return () => controller.abort();
  }, [reloadAppServerState, restartEpoch]);



  /*
   * Tab state. The hash is the source of truth, so refresh, bookmark, and
   * Back/Forward keep the choice — same contract as `#logs` / `#logs/debug`.
   *
   * Panels mount lazily and then STAY mounted, hidden, so a half-typed combo draft
   * survives a tab hop. The mounted set accumulates in the handler rather than an
   * effect: an effect would cost a second render pass on every switch for a value both
   * callers already know.
   */
  const [tab, setTab] = useState<ModelsTab>(readModelsTab);
  const [mounted, setMounted] = useState<ReadonlySet<ModelsTab>>(() => new Set([readModelsTab()]));

  const activateTab = useCallback((next: ModelsTab) => {
    setTab(next);
    setMounted(current => (current.has(next) ? current : new Set([...current, next])));
  }, []);

  useEffect(() => {
    const syncFromHash = () => activateTab(readModelsTab());
    window.addEventListener("hashchange", syncFromHash);
    window.addEventListener("popstate", syncFromHash);
    return () => {
      window.removeEventListener("hashchange", syncFromHash);
      window.removeEventListener("popstate", syncFromHash);
    };
  }, [activateTab]);

  const selectTab = useCallback((next: ModelsTab) => {
    // Deliberate navigation: push a history entry so Back/Forward restore the tab.
    selectModelsTab(next);
    activateTab(next);
  }, [activateTab]);

  const catalogActive = tab === "catalog";

  /** Counts reported up by the panels that own the underlying lists. */
  const [comboCount, setComboCount] = useState<number | null>(null);
  const [routingCount, setRoutingCount] = useState<number | null>(null);
  const [compatibilityCount, setCompatibilityCount] = useState<number | null>(null);

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
  const [providerCapCustomOpen, setProviderCapCustomOpen] = useState<Record<string, boolean>>({});
  const [providerCapCustomDraft, setProviderCapCustomDraft] = useState<Record<string, string>>({});
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
  const [customFormReasoning, setCustomFormReasoning] = useState(false);
  const [customFormReasoningEfforts, setCustomFormReasoningEfforts] = useState<string[]>([]);
  // Whether the ladder has been seeded at least once. `[]` is a MEANINGFUL explicit
  // no-reasoning override, so initialization is tracked separately from the array contents:
  // once seeded (an edit's stored ladder — including an explicit empty one — or a new form's
  // first enable), re-enabling the override preserves the current array even when empty.
  const customFormReasoningInitializedRef = useRef(false);
  const [customSaving, setCustomSaving] = useState(false);
  const [customError, setCustomError] = useState("");
  const [contextModalProvider, setContextModalProvider] = useState<string | null>(null);
  const [contextModalModels, setContextModalModels] = useState<string[]>([]);
  const [contextModelId, setContextModelId] = useState("");
  const [contextDefaultDraft, setContextDefaultDraft] = useState("");
  const [contextModelDrafts, setContextModelDrafts] = useState<Record<string, string>>({});
  // What the modal showed when it opened. Every payload decision compares against THIS, not
  // against the live `groups`, because the 10s poll can refresh a value mid-modal: diffing
  // against current state would mark an untouched field dirty and revert someone else's change.
  const [contextSnapshot, setContextSnapshot] = useState<{
    contextWindow: number | null;
    modelContextWindows: Record<string, number | null>;
  }>({ contextWindow: null, modelContextWindows: {} });
  // Which fields the USER typed into. Touch alone is not enough to send — a value typed and
  // then restored is not a change — but it is what makes an untouched field ineligible.
  const [contextTouchedModels, setContextTouchedModels] = useState<Set<string>>(new Set());
  const [contextDefaultTouched, setContextDefaultTouched] = useState(false);
  const [contextSaving, setContextSaving] = useState(false);
  const [contextError, setContextError] = useState("");
  const [hoveredModel, setHoveredModel] = useState<{ namespaced: string; rect: DOMRect } | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [shadowCall, setShadowCall] = useState<ShadowCallData | null>(null);
  const [shadowCallSaving, setShadowCallSaving] = useState(false);

  // App owns the in-session view mode; fallback to persisted mode for isolated renders/tests.
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);

  useEffect(() => () => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
  }, []);

  const shadowModelOptions = useMemo(
    () => activeModelOptions(models, disabled, selectedModels ?? {}, t),
    [models, disabled, selectedModels, t],
  );
  const shadowCallOptions = useMemo(() => {
    const activeNamespaced = new Set(shadowModelOptions.map(option => option.value));
    return shadowCallModelOptions(models.filter(model => activeNamespaced.has(model.namespaced)), shadowCall?.model);
  }, [models, shadowCall?.model, shadowModelOptions]);

  const loadShadowCall = useCallback(async () => {
    const bounded = createBoundedFetch(15_000);
    try {
      const r = await fetch(`${apiBase}/api/shadow-call-settings`, { signal: bounded.signal });
      const data = await readJsonIfOk<ShadowCallData>(r);
      if (data) setShadowCall(data);
    } catch { /* old server / network: keep the section disabled */ }
    finally { bounded.clear(); }
  }, [apiBase]);

  const loadV2 = useCallback(async () => {
    // Never let a toggle in flight be clobbered by the poll (same single-flight rule as models).
    if (v2BusyRef.current) return;
    const bounded = createBoundedFetch(15_000);
    try {
      const r = await fetch(`${apiBase}/api/v2`, { signal: bounded.signal });
      if (!(r.headers.get("content-type") ?? "").includes("application/json")) { setV2(null); return; }
      const data = await readJsonIfOk<V2Status>(r);
      if (!data || typeof data.enabled !== "boolean") { setV2(null); return; }
      setV2({
        enabled: data.enabled,
        agentsMaxThreadsConflict: data.agentsMaxThreadsConflict === true,
        maxConcurrentThreadsPerSession: typeof data.maxConcurrentThreadsPerSession === "number" ? data.maxConcurrentThreadsPerSession : null,
        multiAgentMode: data.multiAgentMode === "v1" || data.multiAgentMode === "v2" ? data.multiAgentMode : "default",
        keepNativeChatGptOnV1: data.keepNativeChatGptOnV1 === true,
      });
    } catch {
      setV2(null); // old server / network: hide the section instead of guessing
    } finally {
      bounded.clear();
      setV2Loading(false);
    }
  }, [apiBase]);

  const fetchCatalog = useCallback(async (signal: AbortSignal): Promise<CachedModelsPage> => {
    const [modelsRes, capsRes, providersRes, selectionData] = await Promise.all([
      // Every request carries the resource signal, so leaving the catalog tab cancels
      // the work rather than only discarding its result.
      fetch(`${apiBase}/api/models`, { signal }),
      fetch(`${apiBase}/api/provider-context-caps`, { signal }),
      fetch(`${apiBase}/api/providers`, { signal }),
      fetchSelectedModels(apiBase, fetch, signal),
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
    // Gated on the catalog tab: a 10-second poll that keeps running while the user
    // reads Combos or Routing is exactly the hidden work this workspace avoids.
    // Live model discovery is slow; the catalog gets a raised deadline so a slow
    // response is never misread as a hung one.
    { isEmpty: () => false, pollMs: 10_000, initialData: cached ?? undefined, enabled: catalogActive, deadlineMs: 60_000 },
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
    // Both belong to the catalog tab; a hidden panel polling /api/v2 every ten seconds
    // is the same leak as the catalog poll above.
    if (!catalogActive) return;
    const timeout = window.setTimeout(() => {
      void loadShadowCall();
      void loadV2();
    }, 0);
    // Hidden tab: no timer, no /api/v2 traffic; the make-up tick refreshes on return.
    const stop = startVisibilityPoll(() => {
      if (!v2BusyRef.current) void loadV2();
    }, 10_000);
    return () => {
      window.clearTimeout(timeout);
      stop();
    };
  }, [catalogActive, loadShadowCall, loadV2]);

  const groups = useMemo(
    () => buildProviderModelGroups(models, providers),
    [models, providers],
  );

  /*
   * The catalog count is only honest once a seed or a real response has landed. With
   * the catalog gated, a cold load straight to `#models/combos` never fetches it, and
   * rendering "0/0" would present unknown as fact.
   */
  const catalogCountReady = models.length > 0 || catalogState.data !== undefined;

  const openContextSettings = (group: ProviderModelGroup<ModelRow>) => {
    const modelIds = [...new Set([
      ...group.rows.map(model => model.id),
      ...group.configuredModels,
      // A model that vanished from live discovery can still hold an override. Without this it
      // would sit in the drafts map, invisible in the picker, with no way to inspect or clear it.
      ...Object.keys(group.modelContextWindows ?? {}),
    ])].sort();
    const modelId = modelIds[0] ?? "";
    setContextModalProvider(group.provider);
    setContextModalModels(modelIds);
    setContextModelId(modelId);
    const defaultDraft = group.contextWindow ? String(group.contextWindow) : "";
    const modelDrafts = Object.fromEntries(
      Object.entries(group.modelContextWindows ?? {})
        .map(([model, window]) => [model, String(window)]),
    );
    setContextDefaultDraft(defaultDraft);
    setContextModelDrafts(modelDrafts);
    // Canonical numbers, not the raw strings. "64,000" and "64_000" and "64000" are the same
    // value, and comparing text would treat a reformat as an edit — then Apply would send a
    // stale number over whatever changed while the modal was open.
    setContextSnapshot({
      contextWindow: group.contextWindow ?? null,
      modelContextWindows: Object.fromEntries(
        Object.entries(group.modelContextWindows ?? {}).map(([model, window]) => [model, window]),
      ),
    });
    setContextTouchedModels(new Set());
    setContextDefaultTouched(false);
    setContextError("");
  };

  const selectContextModel = (modelId: string) => {
    setContextModelId(modelId);
  };

  const saveContextSettings = async () => {
    if (!contextModalProvider) return;
    const providerWindow = parseContextWindowDraft(contextDefaultDraft);
    const group = groups.find(candidate => candidate.provider === contextModalProvider);
    if (!group) {
      setContextError(t("models.contextSaveFailed"));
      return;
    }

    // A field is sent only when the user touched it AND its value actually differs from what
    // the modal opened with. Both halves matter, and each one alone is wrong.
    //
    // Sending only the selected model — what this did before — silently dropped any model
    // edited before switching the picker. No error, no warning, the value just did not save.
    //
    // Sending everything that differs from the LIVE state is wrong the other way: the 10s poll
    // can refresh a field mid-modal, and a stale draft would then look dirty and revert a
    // change the user never made. Comparing against the opening snapshot instead means a value
    // typed and then restored sends nothing at all.
    // Only validate the default when the user touched it. A malformed value inherited from a
    // hand-edited config would otherwise block a save that never intended to touch it.
    if (contextDefaultTouched && providerWindow === undefined) {
      setContextError(t("models.contextInvalid"));
      return;
    }
    const modelWindows: Record<string, number | null> = {};
    for (const modelId of contextTouchedModels) {
      const draft = contextModelDrafts[modelId] ?? "";
      const parsed = parseContextWindowDraft(draft);
      if (parsed === undefined) {
        setContextError(t("models.contextInvalid"));
        return;
      }
      // Compare VALUES, not text. Retyping 64000 as "64,000" is not a change.
      if (parsed === (contextSnapshot.modelContextWindows[modelId] ?? null)) continue;
      modelWindows[modelId] = parsed;
    }
    const defaultChanged = contextDefaultTouched
      && providerWindow !== contextSnapshot.contextWindow;

    // Nothing survived the comparison: every edit was reverted before Apply. Writing an
    // unchanged payload would still stamp over concurrent edits.
    if (!defaultChanged && Object.keys(modelWindows).length === 0) {
      setContextModalProvider(null);
      // Not "updated" — nothing was. Saying otherwise would be a small lie the user could
      // act on, e.g. believing a value they typed and reverted had been written.
      publishFeedback(true, t("models.contextUnchanged"));
      return;
    }

    setContextSaving(true);
    setContextError("");
    try {
      const body: Record<string, unknown> = {};
      if (defaultChanged) body.contextWindow = providerWindow;
      if (Object.keys(modelWindows).length > 0) body.modelContextWindows = modelWindows;
      const response = await fetch(
        `${apiBase}/api/providers?name=${encodeURIComponent(contextModalProvider)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      await readJsonOrThrow(response, t("models.contextSaveFailed"));
    } catch (error) {
      setContextError(error instanceof Error ? error.message : t("models.contextSaveFailed"));
      return;
    } finally {
      setContextSaving(false);
    }

    // Past the write boundary: the values ARE saved. A refresh that fails afterwards is a
    // display problem, and reporting it through `contextError` would set an error on a modal
    // that is already closed — invisible to the user, and it contradicts the success they just
    // saw. Let the ordinary load error surface handle it.
    setContextModalProvider(null);
    publishFeedback(true, t("models.contextSaved"));
    await load(true);
  };

  // One-shot default collapse. It stays an effect on `groups` so CACHED groups collapse
  // immediately on first paint, even when revalidation is slow or fails; moving it into
  // the load() success path would render cached providers expanded and leave them
  // expanded whenever the refresh errors.
  useEffect(() => {
    if (!needsDefaultCollapseRef.current) return;
    if (groups.length === 0) return;
    needsDefaultCollapseRef.current = false;
    const all = new Set(groups.map(group => group.provider));
    // eslint-disable-next-line react-hooks/set-state-in-effect, react/react-compiler
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

  /*
   * Quiet per-tab counts. A count is omitted, never zeroed, while it is unknown: the
   * panels report theirs up once mounted, and a tab that has never been opened has
   * nothing truthful to say.
   */
  const tabMeta = useMemo(() => ({
    catalog: catalogCountReady
      ? t("models.active", { active: effectiveVisibleCount, total: models.length })
      : undefined,
    combos: comboCount === null ? undefined : String(comboCount),
    routing: routingCount === null ? undefined : String(routingCount),
    compatibility: compatibilityCount === null ? undefined : String(compatibilityCount),
  }), [catalogCountReady, comboCount, compatibilityCount, effectiveVisibleCount, models.length, routingCount, t]);

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

  const toggleProviderCap = async (provider: string, nativeGroup = false) => {
    setBusy(true);
    busyRef.current = true;
    setStatus("");
    // Send the desired next state, not the current one: clicking the switch turns a
    // currently-unset cap on (enabled: true) and a currently-set cap off (enabled: false).
    const enabled = contextCaps[provider] === undefined;
    try {
      const r = await fetch(`${apiBase}/api/provider-context-caps`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(enabled && nativeGroup
          ? { provider, enabled, value: NATIVE_GPT56_OPT_IN_WINDOW }
          : { provider, enabled }),
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

  const allCapped = useMemo(
    () => {
      // Cap aggregate counts routed providers only; the single native group has no cap
      // switch. Zero-row routed providers are included: they can still hold a per-provider
      // cap (e.g. a custom model added later), and excluding them would let "set all"
      // silently overwrite that cap when the global value changes. Saved caps of providers
      // that are no longer in `groups` (e.g. disabled after receiving a custom cap) are
      // also counted: the management API rewrites every key in providerContextCaps when
      // setAll is true, so any saved cap that differs from the current value must keep the
      // aggregate off.
      const routed = groups.filter(group => !group.native);
      return routed.length > 0
        && routed.every(group => contextCaps[group.provider] === contextCapValue)
        && Object.keys(contextCaps).every(key => contextCaps[key] === contextCapValue);
    },
    [groups, contextCaps, contextCapValue],
  );

  const setGlobalCap = (value: number) => {
    if (!Number.isSafeInteger(value) || value <= 0) return;
    // Only when "apply to every routed provider" is checked does the new value re-point every
    // provider; otherwise it just becomes the default for future toggles and providers keep
    // their own values.
    void putCap(allCapped ? { value, setAll: true } : { value });
  };

  const onSelectProviderCap = (provider: string, raw: string) => {
    if (raw === CUSTOM_OPTION) {
      setProviderCapCustomOpen(prev => ({ ...prev, [provider]: true }));
      setProviderCapCustomDraft(prev => ({ ...prev, [provider]: String(contextCaps[provider] ?? contextCapValue) }));
      return;
    }
    setProviderCapCustomOpen(prev => ({ ...prev, [provider]: false }));
    const value = Number(raw);
    if (Number.isSafeInteger(value) && value > 0 && value !== contextCaps[provider]) {
      void putCap({ provider, enabled: true, value });
    }
  };

  const applyProviderCustomCap = (provider: string) => {
    const value = Number((providerCapCustomDraft[provider] ?? "").replace(/[_,\s]/g, ""));
    // Fractional values are rejected (the server floors, so 0.5 would silently become 0).
    // The editor stays open when validation fails.
    if (!Number.isSafeInteger(value) || value <= 0) { publishFeedback(false, t("models.capSaveFailed")); return; }
    setProviderCapCustomOpen(prev => ({ ...prev, [provider]: false }));
    void putCap({ provider, enabled: true, value });
  };

  const onSelectCap = (raw: string) => {
    if (raw === CUSTOM_OPTION) { setShowCustom(true); setCustomCap(String(contextCapValue)); return; }
    setShowCustom(false);
    const value = Number(raw);
    if (Number.isSafeInteger(value) && value > 0 && value !== contextCapValue) setGlobalCap(value);
  };

  const applyCustomCap = () => {
    const value = Number(customCap.replace(/[_,\s]/g, ""));
    if (!Number.isSafeInteger(value) || value <= 0) { publishFeedback(false, t("models.capSaveFailed")); return; }
    setShowCustom(false);
    setGlobalCap(value);
  };

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

  /**
   * Both v2 surface writes adopt the response directly instead of calling
   * `loadV2()`. `loadV2` returns early while `v2BusyRef` is still held by the
   * in-flight write, so the refetch was a no-op and the control kept its old
   * value until the next 10s poll. That is visible here: "Keep ChatGPT on v1"
   * only renders while the mode is v2, so a stale mode also delayed the row.
   */
  const putV2Setting = async (body: Record<string, unknown>) => {
    if (!v2 || v2BusyRef.current) return;
    setV2Busy(true);
    v2BusyRef.current = true;
    setV2Note("");
    setStatus("");
    try {
      const r = await fetch(`${apiBase}/api/v2`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
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
          keepNativeChatGptOnV1: data.keepNativeChatGptOnV1 === true,
        });
        setOk(true);
        setStatus(t("models.v2Applied"));
        setV2Note((data.warnings ?? []).join(" "));
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

  const setMultiAgentMode = async (mode: "v1" | "default" | "v2") => {
    if (!v2 || v2.multiAgentMode === mode) return;
    await putV2Setting({ multiAgentMode: mode });
  };

  const setKeepNativeChatGptOnV1 = async (next: boolean) => {
    if (!v2 || v2.keepNativeChatGptOnV1 === next) return;
    await putV2Setting({ keepNativeChatGptOnV1: next });
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
          keepNativeChatGptOnV1: data.keepNativeChatGptOnV1 === true,
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
    reasoningEfforts?: string[],
  ) => {
    setCustomSaving(true);
    setCustomError("");
    try {
      const r = await fetch(`${apiBase}/api/custom-models`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, modelId, displayName, contextWindow, inputModalities, reasoningEfforts }),
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

  /*
   * Catalog loading and cold failure belong to the CATALOG PANEL, not the page.
   *
   * These used to be component-level early returns, which is correct for a page that is
   * only a catalog and wrong for a page that owns three tabs: a slow or failed catalog
   * would unmount the whole workspace, tab strip included, taking every sibling panel
   * and any unsaved combo draft with it — and on a cold failure the user could not even
   * reach Combos or Routing. Rendered below inside the catalog panel instead.
   */
  const catalogColdFailure = catalogState.kind === "failed-cold"
    ? (catalogState.error instanceof Error ? catalogState.error.message : t("models.loadFail"))
    : null;
  const catalogCold = catalogState.showSkeleton && !catalog;

  const selectedModelMap = selectedModels ?? {};

  const renderGroup = (group: ProviderModelGroup<ModelRow>) => {
    const { provider, rows, nativeProviderGroup, liveModels, discovery } = group;
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
    const capOn = contextCaps[provider] !== undefined;
    const providerCap = contextCaps[provider] ?? contextCapValue;
    // With the cap off, `providerCap` is only the value a future toggle would apply — for the
    // native group that is the 350k default, which says nothing true about what Codex sees.
    // The honest number there is the largest window the rows actually advertise.
    const widestRowWindow = rows.reduce<number | undefined>((widest, row) => {
      const window = typeof row.contextWindow === "number" && row.contextWindow > 0 ? row.contextWindow : undefined;
      if (window === undefined) return widest;
      return widest === undefined || window > widest ? window : widest;
    }, undefined);
    const capDisplayValue = capOn
      ? providerCap
      : (nativeProviderGroup ? NATIVE_GPT56_DEFAULT_WINDOW : (widestRowWindow ?? providerCap));
    // The native group offers only the three windows GPT-5.6 actually has contracts for
    // (272k live, 372k legacy, 1.05M measured); routed providers keep the generic ladder.
    // The set has to follow the list, or a saved value outside it loses its option.
    const capOptions = group.nativeProviderGroup ? NATIVE_CAP_OPTIONS : CAP_OPTIONS;
    const capOptionSet = group.nativeProviderGroup ? NATIVE_CAP_OPTION_SET : CAP_OPTION_SET;
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
          <span className="text-body font-semibold">{providerDisplaySlug(provider)}</span>
          {nativeProviderGroup && <span className="models-chip muted mono text-caption">{t("models.nativeGroupLabel")}</span>}
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
             {/* Available on every card, including the native one: the canonical `openai` seed
                 check now admits contextWindow/modelContextWindows as user-owned overlays, and
                 the native accessors only ever narrow the measured window with them. The cap
                 next to it is the coarser sibling — one value for the whole provider. */}
             <button
               type="button"
               className="btn btn-ghost btn-sm text-caption"
               onClick={() => openContextSettings(group)}
               aria-haspopup="dialog"
             >{t("models.contextSettings")}</button>
             {
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
                   setCustomFormReasoning(false);
                   setCustomFormReasoningEfforts([]);
                   customFormReasoningInitializedRef.current = false;
                   setCustomError("");
                   setCustomModalOpen(true);
                 }}
                aria-label={t("models.customAdd")}
                aria-haspopup="dialog"
              >+</button>
             }
             <button type="button" className="btn btn-ghost btn-sm text-caption" disabled={busy || allOn} onClick={() => bulkToggle(true)}>{t("models.allOn")}</button>
             <button type="button" className="btn btn-ghost btn-sm text-caption" disabled={busy || allOff} onClick={() => bulkToggle(false)}>{t("models.allOff")}</button>
             <>
               <Switch on={capOn} onClick={() => toggleProviderCap(provider, nativeProviderGroup)} disabled={busy} label={t("models.capValue", { value: fmtK(capDisplayValue) })} />
               {/* The native group keeps the value visible with the cap off: its rows always
                   advertise SOME window, so hiding the number leaves the card saying nothing
                   about the context Codex will actually see. Routed providers keep the old
                   behaviour, where an off cap genuinely means "no opinion". */}
               {(capOn || nativeProviderGroup) && (
                 <>
                   <Select
                     // A saved cap outside CAP_OPTIONS is still a real selectable option
                     // (inserted below), so select it instead of falling back to "Custom";
                     // otherwise the trigger hides the persisted 128k value behind the
                     // custom-editor label.
                    value={providerCapCustomOpen[provider] ? CUSTOM_OPTION : String(capDisplayValue)}
                    options={[
                      ...(!capOptionSet.has(capDisplayValue) && !providerCapCustomOpen[provider]
                        ? [{ value: String(capDisplayValue), label: fmtK(capDisplayValue) }] : []),
                      ...capOptions.map(v => ({ value: String(v), label: fmtK(v) })),
                      { value: CUSTOM_OPTION, label: t("models.custom") },
                    ]}
                     onChange={v => onSelectProviderCap(provider, v)}
                     disabled={busy || !capOn}
                     label={t("models.capValue", { value: fmtK(capDisplayValue) })}
                   />
                   {providerCapCustomOpen[provider] && (
                     <>
                       <input
                         className="input"
                         style={{ width: 120 }}
                         inputMode="numeric"
                         placeholder={t("models.customPlaceholder")}
                         value={providerCapCustomDraft[provider] ?? ""}
                         onChange={e => setProviderCapCustomDraft(prev => ({ ...prev, [provider]: e.target.value }))}
                         onKeyDown={e => { if (e.key === "Enter") applyProviderCustomCap(provider); }}
                         disabled={busy}
                         aria-label={t("models.customPlaceholder")}
                       />
                       <button type="button" onClick={() => applyProviderCustomCap(provider)} disabled={busy} className="btn btn-ghost btn-sm">{t("models.customApply")}</button>
                     </>
                   )}
                 </>
               )}
             </>
           </div>
        </div>
        {!isCollapsed && (
          <div className="models-provider-body">
            {nativeProviderGroup && <p className="muted text-label models-provider-hint">{t("models.nativeHint")}</p>}
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
                      <code className="mono text-control" style={{ color: off ? "var(--faint)" : "var(--text)", textDecoration: off ? "line-through" : "none" }}>{m.native ? modelLabel(m.id) : formatNamespacedModelId(m.namespaced, t)}</code>
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
                           <span className="model-tip-val">{formatProviderDisplayName(m.provider, t)}</span>
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
                                 // Only a STORED ladder counts as "configured": an inherited one
                                 // would show a phantom override that saves "inherit" over the
                                 // provider row's current metadata.
                                 setCustomFormReasoning(Array.isArray(m.reasoningEfforts));
                                 setCustomFormReasoningEfforts(m.reasoningEfforts ?? []);
                                 // A stored ladder — even an explicit empty one — is a real
                                 // configuration: re-enabling must preserve it, not reseed.
                                 customFormReasoningInitializedRef.current = Array.isArray(m.reasoningEfforts);
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
            <Select value={shadowCall?.model ?? ""} options={shadowCallOptions} onChange={v => { setShadowCall(c => c ? { ...c, model: v } : c); void saveShadowCall({ model: v }); }} disabled={!shadowCall || shadowCallSaving || !shadowCall.enabled} label={t("models.shadowCallIntercept")} />
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
        {v2 && v2.multiAgentMode === "v2" && (
          <div className="models-v2-keep-native-row">
            <div className="models-v2-keep-native">
              <span className="models-v2-keep-native-label text-caption">{t("models.keepNativeOnV1")}</span>
              <Switch
                on={v2.keepNativeChatGptOnV1 === true}
                onClick={() => void setKeepNativeChatGptOnV1(!v2.keepNativeChatGptOnV1)}
                disabled={v2Busy}
                label={t("models.keepNativeOnV1")}
              />
              <Tooltip content={t("models.keepNativeOnV1Hint")} side="top" maxWidth={360}>
                <span className="models-v2-keep-native-info" aria-label={t("models.keepNativeOnV1Hint")}>
                  <IconInfo width={13} height={13} aria-hidden="true" />
                </span>
              </Tooltip>
            </div>
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
          value={showCustom ? CUSTOM_OPTION : String(contextCapValue)}
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

      {contextModalProvider && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={t("models.contextSettings")}
          onClick={() => { if (!contextSaving) setContextModalProvider(null); }}
          onKeyDown={(event) => {
            if (event.key === "Escape" && !contextSaving) setContextModalProvider(null);
          }}
        >
          <div className="modal-card" onClick={event => event.stopPropagation()}>
            <div className="modal-head">
              <h3>{t("models.contextSettingsTitle", {
                provider: formatProviderDisplayName(contextModalProvider, t),
              })}</h3>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setContextModalProvider(null)}
                disabled={contextSaving}
                aria-label={t("common.close")}
              >&times;</button>
            </div>

            {contextError && <Notice tone="err">{contextError}</Notice>}
            <p className="modal-desc leading-relaxed">{t("models.contextHint")}</p>

            <div className="models-context-fields">
              <label className="text-label models-field">
                {t("models.contextDefault")}
                <input
                  className="input"
                  inputMode="numeric"
                  value={contextDefaultDraft}
                  onChange={event => {
                    setContextDefaultDraft(event.target.value);
                    setContextDefaultTouched(true);
                  }}
                  disabled={contextSaving}
                  placeholder={t("models.contextAutomatic")}
                  autoFocus
                />
              </label>

              {contextModalModels.length > 0 && (
                <>
                  <div className="text-label models-field">
                    {t("models.contextModel")}
                    <Select
                      value={contextModelId}
                      options={contextModalModels.map(model => ({ value: model, label: model }))}
                      onChange={selectContextModel}
                      disabled={contextSaving}
                      label={t("models.contextModel")}
                    />
                  </div>
                  <label className="text-label models-field">
                    {t("models.contextModelOverride")}
                    <input
                      className="input"
                      inputMode="numeric"
                      value={contextModelDrafts[contextModelId] ?? ""}
                      onChange={event => {
                        setContextModelDrafts(current => ({
                          ...current,
                          [contextModelId]: event.target.value,
                        }));
                        setContextTouchedModels(current => new Set(current).add(contextModelId));
                      }}
                      disabled={contextSaving}
                      placeholder={t("models.contextAutomatic")}
                    />
                  </label>
                </>
              )}
            </div>

            <div className="modal-actions">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setContextModalProvider(null)}
                disabled={contextSaving}
              >{t("common.cancel")}</button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void saveContextSettings()}
                disabled={contextSaving}
              >
                {contextSaving ? t("models.customSaving") : t("models.customApply")}
              </button>
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
                  ? t("models.customAddTitle", { provider: formatProviderDisplayName(customModalProvider, t) })
                  : t("models.customEditTitle", { provider: formatProviderDisplayName(customModalProvider, t) })}
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

              <div className="text-label models-field">
                {t("models.customFieldReasoning")}
                <div className="row models-field-row">
                  <label className="row models-modality-option">
                    <input
                      type="checkbox"
                      checked={customFormReasoning}
                      onChange={e => {
                        setCustomFormReasoning(e.target.checked);
                        if (e.target.checked && !customFormReasoningInitializedRef.current) {
                          customFormReasoningInitializedRef.current = true;
                          // First enable: seed from the model's advertised ladder when the
                          // row is known (a provider may support only a subset of levels —
                          // preselecting the full shared list would persist levels the model
                          // does not accept). Unknown model ids fall back to the full set:
                          // the common intent of enabling the override is "allow every known
                          // step", and the wire clamp still bounds what is actually sent.
                          const row = models.find(m => m.provider === customModalProvider && m.id === customFormModelId);
                          const advertised = Array.isArray(row?.reasoningEfforts)
                            ? row.reasoningEfforts
                            : undefined;
                          setCustomFormReasoningEfforts(advertised ?? [...REASONING_EFFORT_LEVELS]);
                        }
                      }}
                      disabled={customSaving}
                    />
                    <span className="text-control">{t("models.customFieldReasoningOverride")}</span>
                  </label>
                </div>
                {customFormReasoning && (
                  <div className="row models-field-row" style={{ flexWrap: "wrap" }}>
                    {REASONING_EFFORT_LEVELS.map(effort => (
                      <label key={effort} className="row models-modality-option">
                        <input
                          type="checkbox"
                          checked={customFormReasoningEfforts.includes(effort)}
                          onChange={e => {
                            setCustomFormReasoningEfforts(prev => (
                              e.target.checked ? [...prev, effort] : prev.filter(level => level !== effort)
                            ));
                          }}
                          disabled={customSaving}
                        />
                        <span className="text-control">{t(`models.reasoningEffort.${effort}` as TKey)}</span>
                      </label>
                    ))}
                  </div>
                )}
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
                    const reasoningEfforts = customFormReasoning ? customFormReasoningEfforts : undefined;
                    void addCustomModel(
                      customModalProvider,
                      modelId,
                      displayName || undefined,
                      contextWindow,
                      customFormModalities.length > 0 ? customFormModalities : undefined,
                      reasoningEfforts,
                    );
                  } else {
                    // `null` clears a stored override back to "inherit from the provider row";
                    // an explicit empty ladder stays stored as "no reasoning".
                    void updateCustomModel(customModalId, {
                      modelId,
                      displayName,
                      contextWindow: contextWindow ?? null,
                      inputModalities: customFormModalities,
                      reasoningEfforts: customFormReasoning ? customFormReasoningEfforts : null,
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

  /*
   * The catalog tab body: everything this page rendered before it grew tabs. It keeps
   * `.models-workspace-shell`, so the wider-column rule and every workspace style below
   * it apply unchanged.
   */
  const catalogPanel = (
    <div className="models-workspace-shell">
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
                  <span className="models-workspace-rail-name">{formatProviderDisplayName(provider, t)}</span>
                  <span className="models-workspace-rail-meta">{t("models.active", { active: activeCount, total: rows.length })}</span>
                </button>
              );
            })}
          </div>
        </aside>
        <section className="models-workspace-main" aria-label={t("models.workspace.mainAria")}>
          {controlsBlock}
          {collapseControls}
          <div className="models-provider-list">
            {
              // eslint-disable-next-line react-hooks/refs, react/react-compiler -- The hover ref is only read by row event handlers nested in this renderer.
              visibleGroups.map(group => renderGroup(group))
            }
          </div>
          {groups.length === 0 && emptyStateBlock}
        </section>
      </div>
      {modalsBlock}
    </div>
  );

  return (
    <>
      <div className="page-head">
        <h2>{t("nav.models")}</h2>
        <div className="page-head-actions">
          <button type="button" className="sidebar-orb"
            onClick={() => { void handleCodexRestart(); }} disabled={codexRestarting}
            aria-label={codexRestarting ? t("dash.codexRestarting") : t("dash.codexRestart")}
            title={codexRestarting ? t("dash.codexRestarting") : t("dash.codexRestart")}>
            <IconRefresh />
          </button>
        </div>
      </div>
      <CodexStaleBanner
        state={appServerState}
        controller={{ restarting: codexRestarting, restart: handleCodexRestart }}
      />
      <ModelsTabStrip tab={tab} onSelect={selectTab} meta={tabMeta} />
      {/*
        One subtitle for the active tab, rendered between the strip and the panels.
        Only one panel is visible, so a subtitle per panel would be three copies of a
        thing the user can only ever see one of — and the catalog's five-line copy was
        pushing the full-height Combos workspace off the viewport.
      */}
      <p className="page-sub">{t(SUBTITLE_TKEY[tab])}</p>

      {/*
        Panels mount lazily and then stay mounted, hidden — a half-typed combo draft
        survives a tab hop. `hidden` matches the APG examples and the existing Logs tab.
        Each panel owns an error boundary so one failing tab cannot take the others with
        it; App's page-level boundary is keyed by page and would otherwise stay tripped
        across a tab switch.
      */}
      <div
        className="models-tab-panel"
        role="tabpanel"
        id={modelsPanelDomId("catalog")}
        aria-labelledby={modelsTabDomId("catalog")}
        hidden={tab !== "catalog"}
      >
        <ErrorBoundary
          pageName={t("models.tab.catalog")}
          title={t("errorBoundary.title")}
          message={t("errorBoundary.message")}
          detailsLabel={t("errorBoundary.details")}
          reloadLabel={t("errorBoundary.reload")}
        >
          {catalogCold
            ? <DataSurfaceSkeleton label={t("models.loading")} rows={5} />
            : catalogColdFailure !== null
              ? (
                <>
                  <Notice tone="err">{catalogColdFailure}</Notice>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => catalogResource.refresh()}>{t("common.retry")}</button>
                </>
              )
              : catalogPanel}
        </ErrorBoundary>
      </div>

      {/*
        The panel SHELL is always present; only its contents mount lazily. A conditional
        wrapper left the tab's `aria-controls` pointing at an element that did not exist
        until the tab had been visited once.
      */}
      <div
        className="models-tab-panel models-tab-panel--fill"
        role="tabpanel"
        id={modelsPanelDomId("combos")}
        aria-labelledby={modelsTabDomId("combos")}
        hidden={tab !== "combos"}
      >
        {mounted.has("combos") && (
          <ErrorBoundary
            pageName={t("models.tab.combos")}
            title={t("errorBoundary.title")}
            message={t("errorBoundary.message")}
            detailsLabel={t("errorBoundary.details")}
            reloadLabel={t("errorBoundary.reload")}
          >
            <Combos apiBase={apiBase} active={tab === "combos"} onCountChange={setComboCount} />
          </ErrorBoundary>
        )}
      </div>

      <div
        className="models-tab-panel"
        role="tabpanel"
        id={modelsPanelDomId("routing")}
        aria-labelledby={modelsTabDomId("routing")}
        hidden={tab !== "routing"}
      >
        {mounted.has("routing") && (
          <ErrorBoundary
            pageName={t("models.tab.routing")}
            title={t("errorBoundary.title")}
            message={t("errorBoundary.message")}
            detailsLabel={t("errorBoundary.details")}
            reloadLabel={t("errorBoundary.reload")}
          >
            <RoutingProfiles apiBase={apiBase} active={tab === "routing"} onCountChange={setRoutingCount} />
          </ErrorBoundary>
        )}
      </div>

      <div
        className="models-tab-panel"
        role="tabpanel"
        id={modelsPanelDomId("compatibility")}
        aria-labelledby={modelsTabDomId("compatibility")}
        hidden={tab !== "compatibility"}
      >
        {mounted.has("compatibility") && (
          <ErrorBoundary
            pageName={t("models.tab.compatibility")}
            title={t("errorBoundary.title")}
            message={t("errorBoundary.message")}
            detailsLabel={t("errorBoundary.details")}
            reloadLabel={t("errorBoundary.reload")}
          >
            <CompatibilityMatrix apiBase={apiBase} active={tab === "compatibility"} onCountChange={setCompatibilityCount} />
          </ErrorBoundary>
        )}
      </div>
    </>
  );

}
