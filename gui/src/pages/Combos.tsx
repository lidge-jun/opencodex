import { useCallback, useEffect, useMemo, useState } from "react";
import ComboWorkspace from "../components/ComboWorkspace";
import { comboVisionSidecarTargets } from "../combo-capabilities";
import {
  type ComboItem,
  comboModelId,
  parseComboList,
  providerQuotaStatesFromReports,
  nextProviderQuotaStateExpiration,
  toPutBody,
  validateComboDraft,
} from "../combo-workspace-data";
import { hostDocumentHidden, onHostVisibilityChange } from "../host-visibility";
import { hideRedundantChatGptForwardProviders } from "../provider-workspace/catalog";
import { readSessionListCacheEntry, writeSessionListCacheEntry } from "../session-list-cache";
import { Notice } from "../ui";
import { useT } from "../i18n/shared";
import { useDataSurface } from "../data-surface";
import { DataSurfaceSkeleton } from "../components/data-surface";
import { navigateHash, replaceHash } from "../hash-routing";
import { jevAutoCreateDecisionProvider } from "../app-routing";
import { COMBOS_ADVANCED_HASH } from "./combos-advanced-hash";
import type { ComboAddIntent } from "../components/combo-workspace-types";
import { RouteBoard } from "../components/route-board/RouteBoard";
import { ComboSuggestions } from "../components/route-board/ComboSuggestions";
import { useSuggestionExclusions } from "../components/route-board/use-suggestion-exclusions";
import type { EditableChannel } from "../components/route-board/ChannelEditor";
import { comboDraftErrorText } from "../components/combo-workspace-utils";
import { putModelVisibility } from "../model-visibility";
import {
  accountCountFromList,
  channelKey,
  channelQuota,
  quotaWindowsByProvider,
  channelTargetsForPut,
  capabilitySource,
  parseCapabilitySources,
  parseInferredCapabilities,
  parseProbeResponse,
  type MemberInferred,
  type ProbeOutcome,
  configuredMemberModels,
  parseCapabilitySettings,
  type AccountCount,
  type ComboCapabilitySettings,
  type ComboCatalogMeta,
  type MemberSources,
  type ComboSettingsPatch,
} from "../route-board-model";
import { readCombosView, type CombosView } from "./combos-view";

type ProviderOption = {
  name: string;
  disabled?: boolean;
  hiddenFromPicker?: boolean;
  authMode?: string;
  adapter?: string;
  baseUrl?: string;
  defaultModel?: string;
  models?: string[];
};
type ModelOption = {
  provider: string;
  id: string;
  namespaced?: string;
  reasoningEfforts?: string[];
  inputModalities?: string[];
  inputModalitiesDeclared?: string[];
  visionSidecarConsumer?: boolean;
  contextWindow?: number;
  sources?: MemberSources;
  inferred?: MemberInferred;
};
type ProviderDto = {
  adapter: string;
  baseUrl: string;
  disabled?: boolean;
  defaultModel?: string;
  models?: string[];
  authMode?: string;
};
type ConfigDto = { providers?: Record<string, ProviderDto> };
type CachedCombosPage = {
  combos: ComboItem[];
  providers: ProviderOption[];
  models: ModelOption[];
  capabilityModels?: ModelOption[];
  cataloguedComboIds: string[];
  /** Route board extras; absent in a session cache written before they existed. */
  comboCatalog?: Record<string, ComboCatalogMeta>;
  lastResort?: Record<string, string[]>;
  lastResortActive?: string[];
  capability?: Record<string, ComboCapabilitySettings>;
  /** Catalog models plus configured-only members, for the route board's member table. */
  memberModels?: ModelOption[];
  /** `provider/model` rows hidden from the catalog; suggestions rank combos with a listed member first. */
  hiddenModels?: string[];
};
type ProviderQuotasDto = { reports?: unknown };

function responseError(data: unknown): string | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const error = (data as { error?: unknown }).error;
  return typeof error === "string" && error.trim() ? error : undefined;
}

function responseSucceeded(data: unknown): boolean {
  return !!data && typeof data === "object" && !Array.isArray(data)
    && (data as { success?: unknown }).success === true;
}

function seedCombos(cacheKey: string): CachedCombosPage | null {
  return readSessionListCacheEntry<CachedCombosPage>(cacheKey)?.data ?? null;
}

function seedCombosCachedAt(cacheKey: string): number | null {
  return readSessionListCacheEntry<CachedCombosPage>(cacheKey)?.cachedAt ?? null;
}

export default function Combos({
  apiBase,
  active = true,
  onCountChange,
}: {
  apiBase: string;
  /**
   * False while this panel is mounted but hidden behind another Models tab. It gates
   * the NETWORK only — the rendered tree stays put so unsaved editor drafts survive a
   * tab hop. Defaults true so the standalone page keeps its existing behaviour.
   */
  active?: boolean;
  /** Reports the combo count up to the tab strip. */
  onCountChange?: (count: number) => void;
}) {
  const t = useT();
  const cacheKey = `ocx.combos.workspace.v2:${apiBase}`;
  const cached = useMemo(() => seedCombos(cacheKey), [cacheKey]);
  const suggestionExclusions = useSuggestionExclusions(apiBase);

  /*
   * The last coherent payload, kept so a hidden panel can keep rendering.
   *
   * While `active` is false the resource is disabled and reports `data: undefined` with
   * no skeleton and no error. Falling back to empty arrays there swaps the whole
   * ComboWorkspace for a first-run empty state and takes every unsaved draft with it —
   * proven in a browser: type into a combo, switch tabs, come back, field blank.
   *
   * State rather than a ref: this repo avoids render-time ref reads under React
   * Compiler, and a ref would not re-render when the retained payload changes. Written
   * on the load success path, never during render and never from an effect.
   */
  const [retainedData, setRetainedData] = useState<CachedCombosPage | null>(cached ?? null);
  const [status, setStatus] = useState("");
  const [statusOk, setStatusOk] = useState(false);
  const [addIntent, setAddIntent] = useState<ComboAddIntent | null>(() => (
    jevAutoCreateDecisionProvider(window.location.hash) !== undefined ? "jev-auto" : null
  ));
  // A self-hosted decision row's "Create JEV Auto" pre-fills that row as the decision service.
  const [addDecisionProvider, setAddDecisionProvider] = useState<string | null>(
    () => jevAutoCreateDecisionProvider(window.location.hash) ?? null,
  );

  /*
   * Overview by default; the full workspace behind "Advanced" (and the JEV Auto deep link).
   * The workspace stays mounted once opened, so an unsaved editor draft survives a trip to the
   * overview the same way it survives a tab hop.
   */
  const [view, setView] = useState<CombosView>(() => readCombosView());
  const [workspaceMounted, setWorkspaceMounted] = useState(() => readCombosView() === "advanced");
  const [selectRequest, setSelectRequest] = useState<{ id: string; seq: number } | undefined>();
  // An overview save on this combo would replace the workspace's baseline and drop its draft.
  const [draftComboId, setDraftComboId] = useState<string | null>(null);
  useEffect(() => {
    const sync = () => {
      const next = readCombosView();
      setView(next);
      if (next === "advanced") setWorkspaceMounted(true);
    };
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  const closeAdd = useCallback(() => {
    setAddIntent(null);
    setAddDecisionProvider(null);
    if (jevAutoCreateDecisionProvider(window.location.hash) !== undefined) {
      replaceHash(COMBOS_ADVANCED_HASH);
    }
  }, []);

  const notify = (msg: string, ok: boolean) => {
    setStatus(msg);
    setStatusOk(ok);
  };

  const openAdvanced = (id?: string, reason?: "jev") => {
    if (id) setSelectRequest((current) => ({ id, seq: (current?.seq ?? 0) + 1 }));
    if (reason === "jev") notify(t("routeBoard.jevInAdvanced"), true);
    setWorkspaceMounted(true);
    setView("advanced");
    navigateHash(COMBOS_ADVANCED_HASH);
  };
  const openOverview = () => {
    setView("overview");
    navigateHash("models/combos");
  };

  // Success banners are transient; errors stay until the next notify.
  useEffect(() => {
    if (!status || !statusOk) return;
    const timer = window.setTimeout(() => {
      setStatus("");
      setStatusOk(false);
    }, 5000);
    return () => window.clearTimeout(timer);
  }, [status, statusOk]);

  const loadCombos = useCallback(async (signal?: AbortSignal): Promise<CachedCombosPage> => {
    // Keep all three requests parallel: this workspace is only coherent once every input arrives.
    const [combosRes, configRes, modelsRes] = await Promise.all([
      // Signals were missing entirely, so resource cleanup could not cancel these.
      fetch(`${apiBase}/api/combos`, { signal }),
      fetch(`${apiBase}/api/config`, { signal }),
      fetch(`${apiBase}/api/models`, { signal }),
    ]);
    if (!combosRes.ok || !configRes.ok || !modelsRes.ok) {
      throw new Error("combo workspace load failed");
    }
    const combosJson = await combosRes.json();
    const configJson = await configRes.json() as ConfigDto;
    // /api/models returns a bare array (not { models: [...] }).
    const modelsRaw = await modelsRes.json() as unknown;
    const modelRows = Array.isArray(modelsRaw)
      ? modelsRaw
      : Array.isArray((modelsRaw as { models?: unknown })?.models)
        ? (modelsRaw as { models: unknown[] }).models
        : [];

    const combos = parseComboList(combosJson);
    // parseComboList keeps only what the workspace edits; the overview also shows last-resort marks.
    const lastResort: Record<string, string[]> = {};
    const lastResortActive: string[] = [];
    const capability: Record<string, ComboCapabilitySettings> = {};
    const rawCombos = (combosJson as { combos?: unknown } | null)?.combos;
    for (const raw of Array.isArray(rawCombos) ? rawCombos : []) {
      if (!raw || typeof raw !== "object") continue;
      const { id, targets, cooldownWaitPolicy, capabilityPolicy, onUnservable } = raw as {
        id?: unknown; targets?: unknown; cooldownWaitPolicy?: unknown; capabilityPolicy?: unknown; onUnservable?: unknown;
      };
      if (typeof id !== "string" || !Array.isArray(targets)) continue;
      capability[id.trim()] = parseCapabilitySettings({ capabilityPolicy, onUnservable });
      lastResort[id.trim()] = targets.flatMap((target: { provider?: unknown; model?: unknown; lastResort?: unknown } | null) =>
        target?.lastResort === true && typeof target.provider === "string" && typeof target.model === "string"
          ? [channelKey(target.provider.trim(), target.model.trim())]
          : []);
      if (cooldownWaitPolicy === "before-last-resort") lastResortActive.push(id.trim());
    }
    const allProviders = configJson.providers ?? {};
    // Collapse canonical forward aliases only in the new-member picker. Validation keeps
    // every configured provider id, including legacy chatgpt members already in a combo.
    const visibleProviders = hideRedundantChatGptForwardProviders(allProviders);
    const providers = Object.entries(allProviders).map(([name, p]) => ({
      name,
      disabled: !!p.disabled,
      hiddenFromPicker: p.adapter === "jev-decision" || !Object.hasOwn(visibleProviders, name),
      authMode: p.authMode,
      adapter: p.adapter,
      baseUrl: p.baseUrl,
      ...(typeof p.defaultModel === "string" ? { defaultModel: p.defaultModel } : {}),
      ...(Array.isArray(p.models) ? { models: p.models.filter((model): model is string => typeof model === "string") } : {}),
    }));

    const models: ModelOption[] = [];
    /** Where each catalog member's capability values come from; only the route board reads it. */
    const sourcesByKey = new Map<string, MemberSources>();
    const inferredByKey = new Map<string, MemberInferred>();
    const capabilityModels: ModelOption[] = [];
    const catalogued = new Set<string>();
    const comboCatalog: Record<string, ComboCatalogMeta> = {};
    const hiddenModels: string[] = [];
    const parseModalities = (raw: unknown): string[] | undefined =>
      Array.isArray(raw)
        ? raw.flatMap((modality) => {
          const trimmed = typeof modality === "string" ? modality.trim() : "";
          return trimmed ? [trimmed] : [];
        })
        : undefined;
    for (const row of modelRows) {
      if (!row || typeof row !== "object") continue;
      const model = row as {
        provider?: unknown;
        id?: unknown;
        namespaced?: unknown;
        disabled?: unknown;
        displayName?: unknown;
        displayNameSource?: unknown;
        contextWindow?: unknown;
        reasoningEfforts?: unknown;
        inputModalities?: unknown;
        inputModalitiesDeclared?: unknown;
        visionSidecarConsumer?: unknown;
        contextWindowDeclared?: unknown;
        reasoningOverridden?: unknown;
        capabilitySources?: unknown;
        inferredCapabilities?: unknown;
      };
      if (typeof model.provider !== "string" || typeof model.id !== "string") continue;
      const provider = model.provider.trim();
      const id = model.id.trim();
      if (!provider || !id) continue;
      if (provider === "combo") {
        catalogued.add(id);
        comboCatalog[id] = {
          disabled: model.disabled === true,
          ...(typeof model.displayName === "string" && model.displayNameSource !== "fallback"
            ? { displayName: model.displayName }
            : {}),
          ...(typeof model.contextWindow === "number" && model.contextWindow > 0
            ? { contextWindow: model.contextWindow }
            : {}),
        };
        continue; // combos cannot nest other combos as targets
      }
      const reasoningEfforts = Array.isArray(model.reasoningEfforts)
        ? model.reasoningEfforts.filter((effort): effort is string => typeof effort === "string")
        : undefined;
      const inputModalities = parseModalities(model.inputModalities);
      const inputModalitiesDeclared = parseModalities(model.inputModalitiesDeclared);
      const option: ModelOption = {
        provider,
        id,
        namespaced: typeof model.namespaced === "string" ? model.namespaced : undefined,
        ...(reasoningEfforts ? { reasoningEfforts } : {}),
        ...(inputModalities && inputModalities.length > 0 ? { inputModalities } : {}),
        ...(inputModalitiesDeclared && inputModalitiesDeclared.length > 0 ? { inputModalitiesDeclared } : {}),
        visionSidecarConsumer: model.visionSidecarConsumer === true,
        ...(typeof model.contextWindow === "number" && model.contextWindow > 0 ? { contextWindow: model.contextWindow } : {}),
      };
      // The server labels each axis (`capabilitySources`); an older server does not, so fall back
      // to the manual flags it does send.
      sourcesByKey.set(channelKey(provider, id), parseCapabilitySources(model.capabilitySources) ?? {
        context: capabilitySource(typeof model.contextWindow === "number", typeof model.contextWindowDeclared === "number"),
        input: capabilitySource(Boolean(inputModalities?.length), Boolean(inputModalitiesDeclared?.length)),
        efforts: capabilitySource(reasoningEfforts !== undefined, model.reasoningOverridden === true),
      });
      if (model.disabled === true) hiddenModels.push(`${provider}/${id}`);
      const inferred = parseInferredCapabilities(model.inferredCapabilities);
      if (inferred) inferredByKey.set(channelKey(provider, id), inferred);
      capabilityModels.push(option);
      models.push(option); // Catalog visibility does not restrict internal Combo selection.
    }

    // Add a default placeholder only when the catalog has no row, including disabled rows.
    for (const [name, provider] of Object.entries(allProviders)) {
      const defaultModel = typeof provider.defaultModel === "string" ? provider.defaultModel.trim() : "";
      if (!defaultModel || provider.disabled) continue;
      if (!capabilityModels.some(model => model.provider === name && model.id === defaultModel)) {
        models.push({ provider: name, id: defaultModel, namespaced: `${name}/${defaultModel}` });
      }
    }

    const catalogKeys = new Set(models.map((model) => channelKey(model.provider, model.id)));
    const memberModels = [
      ...models.map((model) => {
        const key = channelKey(model.provider, model.id);
        const sources = sourcesByKey.get(key);
        const inferred = inferredByKey.get(key);
        return { ...model, ...(sources ? { sources } : {}), ...(inferred ? { inferred } : {}) };
      }),
      ...configuredMemberModels(allProviders)
        .filter((member) => !catalogKeys.has(channelKey(member.provider, member.id)))
        .map((member): ModelOption => ({
          provider: member.provider,
          id: member.id,
          namespaced: `${member.provider}/${member.id}`,
          ...(member.contextWindow ? { contextWindow: member.contextWindow } : {}),
          ...(member.inputModalities ? { inputModalities: [...member.inputModalities] } : {}),
          ...(member.reasoningEfforts ? { reasoningEfforts: [...member.reasoningEfforts] } : {}),
          ...(member.sources ? { sources: member.sources } : {}),
        })),
    ];
    const next = { combos, providers, models, capabilityModels, cataloguedComboIds: [...catalogued], comboCatalog, lastResort, lastResortActive, capability, memberModels, hiddenModels } satisfies CachedCombosPage;
    writeSessionListCacheEntry(cacheKey, next);
    // Retain the coherent payload here — one place, on the success path, never during
    // render. See the `retainedData` note below.
    setRetainedData(next);
    return next;
  }, [apiBase, cacheKey]);

  const resource = useDataSurface<CachedCombosPage>(
    cacheKey,
    [apiBase],
    loadCombos,
    /*
     * Gate the network, never the tree. A hidden panel must not fetch, but the rendered
     * workspace has to stay mounted so an unsaved editor draft survives a tab hop.
     * Disabling reports `data: undefined`, so `retainedData` below keeps the last good
     * payload and the subtree never unmounts.
     */
    {
      isEmpty: () => false,
      initialData: cached ?? undefined,
      initialDataCachedAt: seedCombosCachedAt(cacheKey),
      staleAfterMs: 60_000,
      enabled: active,
    },
  );
  const { state } = resource;

  /*
   * Vision Sidecar enabled state for the enrollment warning. Deliberately
   * separate from the workspace payload: a failure here must never block or
   * fail the combo workspace, so errors are swallowed and `undefined`
   * (unknown) renders no warning.
   */
  const [visionEnabled, setVisionEnabled] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    fetch(`${apiBase}/api/sidecar-settings`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: unknown) => {
        if (cancelled || !data || typeof data !== "object") return;
        const vision = (data as { vision?: { enabled?: unknown } }).vision;
        if (!vision || typeof vision !== "object") return;
        setVisionEnabled(vision.enabled !== false);
      })
      .catch(() => { /* unknown stays warning-free */ });
    return () => { cancelled = true; };
  }, [active, apiBase]);

  const [quotaNow, setQuotaClock] = useState(() => Date.now());
  const loadProviderQuotas = useCallback(async (signal?: AbortSignal): Promise<ProviderQuotasDto> => {
    const response = await fetch(`${apiBase}/api/provider-quotas`, { signal });
    if (!response.ok) throw new Error("combo quota load failed");
    const payload = await response.json() as unknown;
    if (!signal?.aborted) setQuotaClock(Date.now());
    return payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload as ProviderQuotasDto
      : {};
  }, [apiBase]);
  const quotaResource = useDataSurface<ProviderQuotasDto>(
    `ocx.combos.provider-quotas.v1:${apiBase}`,
    [apiBase],
    loadProviderQuotas,
    {
      isEmpty: () => false,
      pollMs: 60_000,
      pauseWhenHidden: true,
      enabled: active,
    },
  );
  const quotaReports = active && quotaResource.lastAttemptOk ? quotaResource.data?.reports : undefined;
  const providerQuotaStates = providerQuotaStatesFromReports(quotaReports, quotaNow);
  const quotaExpiry = nextProviderQuotaStateExpiration(quotaReports, quotaNow);
  useEffect(() => {
    if (!active) return;
    const recheck = () => setQuotaClock(Date.now());
    // The render may cross this boundary before effects run. Keep its deadline and wake now.
    // A new snapshot may be newer than this clock, so unknown state also gets one immediate check.
    const timer = window.setTimeout(recheck,
      quotaExpiry === undefined ? 0 : Math.max(0, quotaExpiry - Date.now()));
    const onVisible = () => { if (!hostDocumentHidden()) recheck(); };
    const unsubscribeVisibility = onHostVisibilityChange(onVisible);
    return () => {
      window.clearTimeout(timer);
      unsubscribeVisibility();
    };
  }, [active, apiBase, quotaResource.data, quotaResource.lastAttemptOk, quotaExpiry]);

  const data = state.data ?? retainedData ?? undefined;

  /*
   * Account counts for OAuth providers whose quota report carries no aggregate (Antigravity
   * pools, Anthropic). One list read per provider while the tab is active; a failure shows no count.
   */
  const oauthProviders = (data?.providers ?? []).filter((provider) => provider.authMode === "oauth" && !provider.disabled)
    .map((provider) => provider.name).sort().join(",");
  const [accountCounts, setAccountCounts] = useState<Record<string, AccountCount>>({});
  useEffect(() => {
    if (!active || !oauthProviders) return;
    let cancelled = false;
    void Promise.all(oauthProviders.split(",").map(async (provider) => {
      try {
        const res = await fetch(`${apiBase}/api/oauth/accounts?provider=${encodeURIComponent(provider)}`);
        const count = res.ok ? accountCountFromList(await res.json()) : null;
        return count ? [[provider, count] as const] : [];
      } catch {
        return [];
      }
    })).then((entries) => {
      if (!cancelled) setAccountCounts(Object.fromEntries(entries.flat()));
    });
    return () => { cancelled = true; };
  }, [active, apiBase, oauthProviders]);
  const combos = data?.combos ?? [];

  /*
   * Report the count up to the tab strip from an effect keyed on the list length, not
   * during render, so a parent re-render cannot refire it.
   */
  useEffect(() => {
    if (!data) return;
    onCountChange?.(combos.length);
  }, [combos.length, data, onCountChange]);
  const providers = data?.providers ?? [];
  const models = data?.models ?? [];
  const capabilityModels = data?.capabilityModels ?? models;
  const cataloguedComboIds = new Set(data?.cataloguedComboIds ?? []);

  /** `overview` saves report failures in their own row, so they skip the page banner. */
  const saveCombo = async (
    item: ComboItem,
    isCreate: boolean,
    renameFrom?: string,
    overview?: { channels?: readonly EditableChannel[]; capability?: ComboSettingsPatch },
  ) => {
    const channels = overview?.channels;
    try {
      const body = toPutBody(item, {
        ...(renameFrom ? { renameFrom } : {}),
        // Enabling images declares text-only members for the Vision Sidecar so the
        // operator never has to hand-edit provider config for a multimodal combo.
        ...(item.imageInput !== "disabled"
          ? { visionSidecarTargets: comboVisionSidecarTargets(item.targets, capabilityModels) }
          : {}),
      });
      // Only the channel editor sends `lastResort`; every other save omits it and the server keeps it.
      // Capability fields (T4c) go out only when the operator changed them in the channel editor.
      const wire = channels
        ? { ...body, combo: { ...body.combo, targets: channelTargetsForPut(body.combo.targets, channels), ...overview?.capability } }
        : body;
      const res = await fetch(`${apiBase}/api/combos`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(wire),
      });
      const data = res.ok
        ? await res.json() as unknown
        : await res.json().catch(() => null) as unknown;
      const serverError = responseError(data);
      if (!res.ok || serverError || !responseSucceeded(data)) {
        const err = serverError || t("cws.saveFailed");
        if (!overview) notify(err, false);
        return { ok: false as const, error: err };
      }
      resource.refresh();
      notify(
        renameFrom
          ? t("cws.renamed", { from: comboModelId(renameFrom), to: item.model })
          : isCreate ? t("cws.created", { model: item.model }) : t("cws.saved"),
        true,
      );
      return { ok: true as const };
    } catch {
      const err = t("cws.saveFailed");
      if (!overview) notify(err, false);
      return { ok: false as const, error: err };
    }
  };

  /**
   * One member model's per-provider settings (context, input, effort levels), the same write the
   * Models page's settings dialog makes. Every combo using that model sees the change.
   */
  const saveModelSettings = async (provider: string, modelId: string, patch: Record<string, unknown>) => {
    try {
      const res = await fetch(`${apiBase}/api/model-settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider, modelId, ...patch }),
      });
      const body = await res.json().catch(() => null) as unknown;
      const receipt = body && typeof body === "object" ? body as { ok?: unknown; provider?: unknown; modelId?: unknown } : {};
      if (!res.ok || receipt.ok !== true || receipt.provider !== provider || receipt.modelId !== modelId) {
        return responseError(body) || t("cws.saveFailed");
      }
      resource.refresh();
      return null;
    } catch {
      return t("cws.saveFailed");
    }
  };

  /**
   * `POST /api/providers/probe-capabilities` for one member, applying conclusive results. A metered
   * provider answers `requiresConfirmation` first; the repeat carries the operator's consent.
   */
  const probeModel = async (provider: string, modelId: string, confirmed: boolean): Promise<ProbeOutcome> => {
    try {
      const res = await fetch(`${apiBase}/api/providers/probe-capabilities`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: provider, model: modelId, apply: true, ...(confirmed ? { confirmMetered: true } : {}) }),
      });
      const outcome = parseProbeResponse(res.status, await res.json().catch(() => null));
      if (outcome.kind === "done" && Object.keys(outcome.applied).length > 0) resource.refresh();
      return outcome;
    } catch {
      return { kind: "failed" };
    }
  };

  const setComboEnabled = async (id: string, enabled: boolean) => {
    try {
      const res = await putModelVisibility(apiBase, "models", "combo", [{ id }], enabled);
      const body = await res.json().catch(() => null) as unknown;
      if (!res.ok) {
        const err = responseError(body) || t("cws.saveFailed");
        return { ok: false as const, error: err };
      }
      resource.refresh();
      return { ok: true as const };
    } catch {
      return { ok: false as const, error: t("cws.saveFailed") };
    }
  };

  const providerRows = Object.fromEntries(providers.map((provider) => [provider.name, {
    disabled: provider.disabled,
    adapter: provider.adapter,
    baseUrl: provider.baseUrl,
    defaultModel: provider.defaultModel,
    models: provider.models,
  }]));
  const validateOverviewEdit = (item: ComboItem) => validateComboDraft(item, {
    existingIds: combos.flatMap((combo) => combo.id === item.id ? [] : [combo.id]),
    existingAliases: combos.flatMap((combo) => combo.id !== item.id && combo.alias ? [combo.alias] : []),
    combos: combos.filter((combo) => combo.id !== item.id),
    isCreate: false,
    providers: providerRows,
  });

  const validateSuggested = (item: ComboItem, isCreate: boolean) => isCreate
    ? validateComboDraft(item, {
      existingIds: combos.map((combo) => combo.id),
      existingAliases: combos.flatMap((combo) => combo.alias ? [combo.alias] : []),
      combos,
      isCreate: true,
      providers: providerRows,
    })
    : validateOverviewEdit(item);
  const quotaByProvider = quotaWindowsByProvider(quotaReports);
  const providerByName = new Map(providers.map((provider) => [provider.name, provider]));
  const remainingPercent = (provider: string, model: string) => {
    const quota = channelQuota(providerByName.get(provider), quotaByProvider.get(provider), [model]);
    return quota.kind === "windows" ? Math.min(...quota.windows.map((window) => window.remainingPercent)) : undefined;
  };

  const removeCombo = async (id: string) => {
    try {
      const res = await fetch(`${apiBase}/api/combos?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      const data = res.ok
        ? await res.json() as unknown
        : await res.json().catch(() => null) as unknown;
      const serverError = responseError(data);
      if (!res.ok || serverError || !responseSucceeded(data)) {
        const err = serverError || t("cws.removeFailed");
        notify(err, false);
        return { ok: false as const, error: err };
      }
      resource.refresh();
      notify(t("cws.removed", { id }), true);
      return { ok: true as const };
    } catch {
      const err = t("cws.removeFailed");
      notify(err, false);
      return { ok: false as const, error: err };
    }
  };

  // The skeleton owns the live region until a session seed or live workspace is available.
  if (state.showSkeleton && !data) {
    return <DataSurfaceSkeleton label={t("cws.loading")} rows={5} />;
  }

  /*
   * `!data` matters. Disabling the only subscriber schedules store eviction, so a
   * reactivation whose fetch fails is classified `failed-cold` even when this component
   * still holds a coherent retained payload — and replacing the workspace there would
   * unmount the editor and destroy the very draft retention exists to protect. With
   * retained data the workspace stays up and the failure shows in the stale banner below.
   */
  if (state.kind === "failed-cold" && !data) {
    const reason = state.error instanceof Error ? state.error.message : t("cws.loadFailed");
    return (
      <>
        <Notice tone="err">{reason}</Notice>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => resource.refresh()}>{t("common.retry")}</button>
      </>
    );
  }

  return (
    <div className={`combos-workspace-shell${view === "overview" ? " combos-workspace-shell--overview" : ""}`}>
      {status && (
        <div className="combos-workspace-shell-banner">
          <Notice tone={statusOk ? "ok" : "err"}>{status}</Notice>
        </div>
      )}
      {state.showError && (
        <div className="combos-workspace-shell-banner">
          <Notice tone="err">{t("cws.loadFailed")}</Notice>
        </div>
      )}
      {/* Revalidation is silent by design: existing combos stay visible, and the
          shell announces the in-flight refresh to assistive tech only. */}
      <div className="rb-viewbar">
        {view === "overview" ? (
          <>
            <p className="rb-lede">{t("routeBoard.lede")}</p>
            <button type="button" className="btn btn-ghost btn-sm" title={t("routeBoard.advancedHint")} onClick={() => openAdvanced()}>
              {t("routeBoard.advanced")}
            </button>
          </>
        ) : (
          <button type="button" className="btn btn-ghost btn-sm" onClick={openOverview}>{t("routeBoard.backToOverview")}</button>
        )}
      </div>
      <div className="combos-workspace-shell-body" aria-busy={state.refreshing}>
        <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {state.refreshing ? t("common.loading") : ""}
        </span>
        {view === "overview" && (
          <ComboSuggestions
            combos={combos}
            models={capabilityModels}
            hiddenModels={new Set(data?.hiddenModels ?? [])}
            providers={providers}
            remainingPercent={remainingPercent}
            validate={validateSuggested}
            errorText={(code, item) => comboDraftErrorText(t, code, item, providerRows)}
            onCreate={(item) => saveCombo(item, true, undefined, {})}
            onExtend={(item) => saveCombo(item, false, undefined, {})}
            excludedProviders={suggestionExclusions.excluded}
            onExcludedChange={suggestionExclusions.save}
          />
        )}
        {view === "overview" && (
          <RouteBoard
            combos={combos}
            catalog={data?.comboCatalog ?? {}}
            lastResort={data?.lastResort ?? {}}
            lastResortActive={new Set(data?.lastResortActive ?? [])}
            providers={providers}
            models={data?.memberModels ?? models}
            quotaReports={quotaReports}
            validate={validateOverviewEdit}
            errorText={(code, item) => comboDraftErrorText(t, code, item, providerRows)}
            onSave={(item, channels, capability) => saveCombo(item, false, undefined, { channels, capability })}
            accountCounts={accountCounts}
            capability={data?.capability ?? {}}
            onSetEnabled={setComboEnabled}
            onOpenAdvanced={openAdvanced}
            lockedId={draftComboId}
            onSaveModel={saveModelSettings}
            onProbeModel={probeModel}
          />
        )}
        {workspaceMounted && (
        <div hidden={view !== "advanced"} className="rb-advanced">
        <ComboWorkspace
          apiBase={apiBase}
          combos={combos}
          providerQuotaStates={providerQuotaStates}
          providers={providers}
          models={models}
          capabilityModels={capabilityModels}
          cataloguedComboIds={cataloguedComboIds}
          visionEnabled={visionEnabled}
          loading={false}
          onRefresh={() => { resource.refresh(); quotaResource.refresh(); }}
          onSave={saveCombo}
          onRemove={removeCombo}
          onAdd={(intent = "blank") => setAddIntent(intent)}
          adding={addIntent !== null}
          addIntent={addIntent ?? undefined}
          addDecisionProvider={addDecisionProvider}
          onCloseAdd={closeAdd}
          onCreated={() => resource.refresh()}
          selectRequest={selectRequest}
          onDraftComboChange={setDraftComboId}
        />
        </div>
        )}
      </div>
    </div>
  );
}
