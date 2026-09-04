import { useCallback, useEffect, useRef, useState } from "react";
import {
  modelOptionsForProvider,
  newDraftCandidate,
  newRoutingProfileDraft,
  routingProfileDraftFromDto,
  routingProfilePutBody,
  routingProfileResponseError,
  routingProfileResponseSucceeded,
  type ModelOption,
  type OptionalBoolean,
  type RoutingProfileDraft,
  type RoutingProfileDto,
  type UnknownCostCapMode,
  type UnknownEvidenceMode,
  type CompatibilitySuiteDraft,
  normalizeCompatibilityDto,
} from "../routing-profile-editor-data";
import { readJsonIfOk } from "../fetch-json";
import { Notice } from "../ui";
import { useI18n, useT } from "../i18n/shared";
import { ROUTING_COMPATIBILITY_FIELD_LABELS } from "../i18n/routing-compatibility-labels";

type DryRunCandidate = {
  provider: string;
  model: string;
  eligible: boolean;
  exclusions: Array<{ code: string; detail?: string }>;
  score?: { total: number; components: Record<string, number | undefined> };
  cost?: { capOutcome?: string; estimatedUsd?: number; incomplete?: boolean; limitUsd?: number };
};

type Analytics = {
  totalRequests: number;
  successRate: number | null;
  fallbackRate: number | null;
  confidence: string | null;
  historyTruncated: boolean;
  cooldownTriggeringFailures: number;
  durationMs: { p50?: number; p95?: number; p99?: number; sampleCount: number };
  firstOutputMs: { p50?: number; p95?: number; p99?: number; sampleCount: number; coverage: number | null };
  breakdown: Array<{ provider: string; model: string; requests: number; successRate: number | null; p50DurationMs?: number }>;
};

type DryRunResult = {
  candidates: DryRunCandidate[];
  selectedIndex: number | null;
  trace?: { profile?: { revision?: string } };
};

type ProviderDto = {
  disabled?: boolean;
  defaultModel?: string;
};

type ConfigDto = {
  providers?: Record<string, ProviderDto>;
};

const BOOLEAN_REQUIREMENTS = [
  "tools",
  "imageInput",
  "structuredOutput",
  "localOnly",
  "remoteAllowed",
  "encryptedCodexTasks",
] as const;
const STRING_REQUIREMENTS = ["reasoningEffort", "serviceTier"] as const;
const NUMERIC_REQUIREMENT_SPEC = {
  minContextWindow: { min: 1, max: undefined, step: 1 },
  minQuotaHeadroom: { min: 0, max: 1, step: "any" },
} as const;
const NUMERIC_REQUIREMENTS = Object.keys(NUMERIC_REQUIREMENT_SPEC) as Array<keyof typeof NUMERIC_REQUIREMENT_SPEC>;
const OPTIMIZE_KEYS = ["latency", "health", "cost", "quota"] as const;
const UNKNOWN_EVIDENCE_KEYS = ["capability", "health", "quota", "cost"] as const;
const UNKNOWN_EVIDENCE_OPTIONS: UnknownEvidenceMode[] = ["allow", "penalize", "exclude"];
const UNKNOWN_COST_CAP_OPTIONS: UnknownCostCapMode[] = ["allow", "exclude"];

type LabCatalogScenario = CompatibilitySuiteDraft;
type LabCatalogSuiteOption = CompatibilitySuiteDraft & { key: string };

function catalogSuiteKey(suite: CompatibilitySuiteDraft): string {
  return `${suite.evidenceLayer}:${suite.suiteId}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function uniqueCatalogSuites(scenarios: unknown[]): LabCatalogSuiteOption[] {
  const seen = new Set<string>();
  const suites: LabCatalogSuiteOption[] = [];
  for (const scenario of scenarios) {
    if (!isPlainObject(scenario)) continue;
    const suiteId = typeof scenario.suiteId === "string" ? scenario.suiteId.trim() : "";
    const evidenceLayer = scenario.evidenceLayer;
    if (!suiteId || (evidenceLayer !== "protocol_conformance" && evidenceLayer !== "live_route_compatibility")) {
      continue;
    }
    const suite: LabCatalogScenario = { suiteId, evidenceLayer };
    const key = catalogSuiteKey(suite);
    if (seen.has(key)) continue;
    seen.add(key);
    suites.push({ ...suite, key });
  }
  return suites.sort((a, b) => {
    const layerCmp = a.evidenceLayer.localeCompare(b.evidenceLayer);
    if (layerCmp !== 0) return layerCmp;
    return a.suiteId.localeCompare(b.suiteId);
  });
}

function suiteSelected(
  requiredSuites: CompatibilitySuiteDraft[],
  suite: CompatibilitySuiteDraft,
): boolean {
  return requiredSuites.some(row =>
    row.suiteId === suite.suiteId && row.evidenceLayer === suite.evidenceLayer);
}

function fmtMs(value: number | undefined, unavailable: string): string {
  return value === undefined ? unavailable : `${Math.round(value)}ms`;
}

function fmtRate(value: number | null | undefined, unavailable: string): string {
  return value === null || value === undefined ? unavailable : `${Math.round(value * 100)}%`;
}

function fmtCapOutcome(
  value: string | undefined,
  t: ReturnType<typeof useT>,
  unavailable: string,
): string {
  switch (value) {
    case "satisfied":
      return t("routing.capOutcome.satisfied");
    case "exceeded":
      return t("routing.capOutcome.exceeded");
    case "unknown-allowed":
      return t("routing.capOutcome.unknown-allowed");
    case "unknown-excluded":
      return t("routing.capOutcome.unknown-excluded");
    default:
      return unavailable;
  }
}

function fmtExclusion(code: string, t: ReturnType<typeof useT>): string {
  switch (code) {
    case "capability-unsatisfied":
      return t("routing.exclusion.capability-unsatisfied");
    case "unknown-capability":
      return t("routing.exclusion.unknown-capability");
    case "cost-limit":
      return t("routing.exclusion.cost-limit");
    case "cost-limit-unknown":
      return t("routing.exclusion.cost-limit-unknown");
    case "cooldown":
      return t("routing.exclusion.cooldown");
    case "unknown-health":
      return t("routing.exclusion.unknown-health");
    case "unknown-quota":
      return t("routing.exclusion.unknown-quota");
    case "unknown-price":
      return t("routing.exclusion.unknown-price");
    default:
      return t("routing.exclusion.other", { code });
  }
}


function parseProfiles(raw: unknown): RoutingProfileDto[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const profiles = (raw as { profiles?: unknown }).profiles;
  if (!Array.isArray(profiles)) return [];
  return profiles.filter((profile): profile is RoutingProfileDto => {
    if (!isPlainObject(profile)) return false;
    // Validate the complete DTO shape: routingProfileDraftFromDto dereferences
    // these nested objects, so a management response that omits any of them
    // must be rejected here rather than crash the load path.
    return typeof profile.id === "string"
      && typeof profile.model === "string"
      && typeof profile.revision === "string"
      && Array.isArray(profile.candidates)
      && isPlainObject(profile.require)
      && isPlainObject(profile.optimize)
      && isPlainObject(profile.limits)
      && isPlainObject(profile.unknownEvidence);
  }).map(profile => {
    const compatibility = normalizeCompatibilityDto(
      "compatibility" in profile ? profile.compatibility : undefined,
    );
    const rest = { ...profile };
    delete rest.compatibility;
    return {
      ...rest,
      alias: profile.alias ?? null,
      ...(compatibility ? { compatibility } : {}),
    };
  });
}

function parseModels(raw: unknown): ModelOption[] {
  const rows = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { models?: unknown }).models)
      ? (raw as { models: unknown[] }).models
      : [];
  const seen = new Set<string>();
  const models: ModelOption[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const provider = typeof (row as { provider?: unknown }).provider === "string"
      ? (row as { provider: string }).provider.trim()
      : "";
    const id = typeof (row as { id?: unknown }).id === "string"
      ? (row as { id: string }).id.trim()
      : "";
    if (!provider || !id || provider === "combo" || provider === "policy") continue;
    if ((row as { disabled?: unknown }).disabled === true) continue;
    const key = JSON.stringify([provider, id]);
    if (seen.has(key)) continue;
    seen.add(key);
    models.push({ provider, id });
  }
  return models;
}

function selectedAfterLoad(
  profiles: RoutingProfileDto[],
  currentId: string | null,
  preferredId?: string,
): RoutingProfileDto | null {
  const requestedId = preferredId ?? currentId;
  if (requestedId) {
    const match = profiles.find(profile => profile.id === requestedId);
    if (match) return match;
  }
  return profiles[0] ?? null;
}

export default function RoutingProfiles({
  apiBase,
  active = true,
  onCountChange,
}: {
  apiBase: string;
  /**
   * False while this panel is mounted but hidden behind another Models tab. Defaults
   * true so a direct render (tests) behaves like a visible panel.
   */
  active?: boolean;
  /** Reports the profile count up to the tab strip. */
  onCountChange?: (count: number) => void;
}) {
  const { locale, t } = useI18n();
  const compatibilityFieldLabels = ROUTING_COMPATIBILITY_FIELD_LABELS[locale];
  const unavailable = t("routing.unavailable");
  const [profiles, setProfiles] = useState<RoutingProfileDto[]>([]);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [providerNames, setProviderNames] = useState<string[]>([]);
  const [providerDefaults, setProviderDefaults] = useState<Record<string, string>>({});
  const [models, setModels] = useState<ModelOption[]>([]);
  const [loadError, setLoadError] = useState("");
  const [selected, setSelected] = useState<RoutingProfileDto | null>(null);
  const [draft, setDraft] = useState<RoutingProfileDraft | null>(null);
  const [status, setStatus] = useState<{ message: string; ok: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const [context, setContext] = useState("");
  const [tools, setTools] = useState(false);
  const [image, setImage] = useState(false);
  const [structured, setStructured] = useState(false);
  const [dryRunResult, setDryRunResult] = useState<DryRunResult | null>(null);
  const [dryRunError, setDryRunError] = useState("");
  const [running, setRunning] = useState(false);
  const [catalogSuites, setCatalogSuites] = useState<LabCatalogSuiteOption[]>([]);
  const [catalogError, setCatalogError] = useState(false);
  const selectedRef = useRef<RoutingProfileDto | null>(null);
  const loadGenerationRef = useRef(0);
  /** Owned by `load` so every entry point — mount, Retry, save, delete — is cancellable. */
  const loadAbortRef = useRef<AbortController | null>(null);
  /*
   * Cancelling in-flight work is not enough on its own. A save or delete can resolve
   * AFTER the panel is hidden or unmounted and then call `load()`, which would open a
   * fresh controller and four requests that the deactivation effect has already run
   * past — and whose generation is current, so its writes would land in a panel nobody
   * is looking at. `load` checks this before it starts anything.
   */
  const loadEnabledRef = useRef(true);

  /*
   * Stop loading and cancel whatever is running.
   *
   * A stable callback rather than inline cleanup: reading the refs at cleanup time is
   * the point — whatever load is in flight NOW is what must be cancelled, and the
   * generation has to move past the value that load captured. Inline, that reads as a
   * stale-ref mistake to both the linter and the next reader. Naming it says the
   * latest-value read is deliberate, and it works for deactivation and unmount alike.
   */
  const cancelActiveLoad = useCallback(() => {
    loadEnabledRef.current = false;
    loadAbortRef.current?.abort();
    loadGenerationRef.current++;
  }, []);
  const dryRunGenerationRef = useRef(0);

  const notify = useCallback((message: string, ok: boolean) => {
    setStatus({ message, ok });
  }, []);

  useEffect(() => {
    if (!status?.ok) return;
    const timer = window.setTimeout(() => setStatus(null), 5000);
    return () => window.clearTimeout(timer);
  }, [status]);

  const clearDryRun = useCallback(() => {
    dryRunGenerationRef.current += 1;
    setDryRunResult(null);
    setDryRunError("");
    setRunning(false);
  }, []);

  const selectProfile = useCallback((profile: RoutingProfileDto | null) => {
    selectedRef.current = profile;
    setSelected(profile);
    setDraft(profile ? routingProfileDraftFromDto(profile) : null);
    setStatus(null);
    clearDryRun();
  }, [clearDryRun]);

  const load = useCallback(async (preferredId?: string) => {
    if (!loadEnabledRef.current) return;
    /*
     * `load` owns the controller, not the effect that happens to call it.
     *
     * There are four entry points — the mount effect, Retry, post-save, and
     * post-delete — so an effect-local controller would cancel only the first and let
     * a Retry or a mutation reload keep running after the tab hides. Generation
     * invalidation stops the state write but not the network work.
     */
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    const { signal } = controller;
    const generation = ++loadGenerationRef.current;
    setLoadError("");
    try {
      const [profilesRes, analyticsRes, configRes, modelsRes, catalogRes] = await Promise.all([
        fetch(`${apiBase}/api/routing-profiles`, { signal }),
        fetch(`${apiBase}/api/routing-analytics`, { signal }),
        fetch(`${apiBase}/api/config`, { signal }),
        fetch(`${apiBase}/api/models`, { signal }),
        fetch(`${apiBase}/api/lab/catalog`, { signal }),
      ]);
      if (!profilesRes.ok) throw new Error(`load-${profilesRes.status}`);
      const [profilesJson, analyticsJson, configJson, modelsJson, catalogJson] = await Promise.all([
        profilesRes.json() as Promise<unknown>,
        analyticsRes.ok ? analyticsRes.json() as Promise<Analytics> : Promise.resolve(null),
        configRes.ok ? configRes.json() as Promise<ConfigDto> : Promise.resolve({} as ConfigDto),
        modelsRes.ok ? modelsRes.json() as Promise<unknown> : Promise.resolve([]),
        catalogRes.ok
          ? (catalogRes.json() as Promise<{ scenarios?: unknown[] }>).catch(() => null)
          : Promise.resolve(null),
      ]);
      if (generation !== loadGenerationRef.current) return;

      const nextProfiles = parseProfiles(profilesJson);
      const current = selectedRef.current;
      const refreshed = selectedAfterLoad(nextProfiles, current?.id ?? null, preferredId);
      const configuredProviders = configJson.providers ?? {};
      const nextProviderNames = Object.entries(configuredProviders)
        .filter(([, provider]) => provider.disabled !== true)
        .map(([name]) => name)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const nextDefaults = Object.fromEntries(
        Object.entries(configuredProviders)
          .filter(([, provider]) => provider.disabled !== true && typeof provider.defaultModel === "string")
          .map(([name, provider]) => [name, provider.defaultModel!.trim()]),
      );

      selectedRef.current = refreshed;
      setProfiles(nextProfiles);
      setSelected(refreshed);
      setDraft(refreshed ? routingProfileDraftFromDto(refreshed) : null);
      setAnalytics(analyticsJson);
      setProviderNames(nextProviderNames);
      setProviderDefaults(nextDefaults);
      setModels(parseModels(modelsJson));
      if (catalogJson && Array.isArray(catalogJson.scenarios)) {
        setCatalogSuites(uniqueCatalogSuites(catalogJson.scenarios));
        setCatalogError(false);
      } else {
        setCatalogSuites([]);
        setCatalogError(true);
      }
      if (!current || !refreshed || current.id !== refreshed.id || current.revision !== refreshed.revision) {
        clearDryRun();
      }
    } catch (error) {
      if (generation !== loadGenerationRef.current) return;
      // An aborted supersede or deactivate is not a failure worth showing.
      if (signal.aborted) return;
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      // Clear only if this request still owns the ref; a newer load may have replaced it.
      if (loadAbortRef.current === controller) loadAbortRef.current = null;
    }
  }, [apiBase, clearDryRun]);

  useEffect(() => {
    if (!active) {
      // Hidden: stop new loads, cancel work in flight, and invalidate its generation so
      // a late resolve cannot write into a panel nobody is looking at.
      cancelActiveLoad();
      return;
    }
    loadEnabledRef.current = true;
    const timer = window.setTimeout(() => void load(), 0);
    // Unmounting counts too — leaving Models entirely must not strand a request.
    return () => {
      window.clearTimeout(timer);
      cancelActiveLoad();
    };
  }, [active, cancelActiveLoad, load]);

  /*
   * Report the count up to the tab strip from an effect keyed on the list length, not
   * during render.
   */
  useEffect(() => {
    onCountChange?.(profiles.length);
  }, [onCountChange, profiles.length]);

  const firstProvider = providerNames[0] ?? "";
  const firstModel = providerDefaults[firstProvider]
    ?? modelOptionsForProvider(models, firstProvider)[0]?.id
    ?? "";

  const startCreate = () => {
    selectedRef.current = null;
    setSelected(null);
    setDraft(newRoutingProfileDraft(firstProvider, firstModel));
    setStatus(null);
    clearDryRun();
  };

  const cancelEdit = () => {
    if (selected) {
      setDraft(routingProfileDraftFromDto(selected));
      setStatus(null);
      return;
    }
    selectProfile(profiles[0] ?? null);
  };

  const saveProfile = async () => {
    if (!draft || saving) return;
    setSaving(true);
    setStatus(null);
    try {
      const body = routingProfilePutBody(draft, selected ? "update" : "create", selected?.revision);
      const response = await fetch(`${apiBase}/api/routing-profiles`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await readJsonIfOk<unknown>(response);
      if (!response.ok) {
        const errorBody = await response.json().catch(() => null) as unknown;
        notify(routingProfileResponseError(errorBody) ?? t("routing.loadFailed"), false);
        return;
      }
      if (!routingProfileResponseSucceeded(data)) {
        notify(routingProfileResponseError(data) ?? t("routing.loadFailed"), false);
        return;
      }
      await load(body.id);
      notify(t("common.ok"), true);
    } catch (error) {
      notify(error instanceof Error ? error.message : t("routing.loadFailed"), false);
    } finally {
      setSaving(false);
    }
  };

  const removeProfile = async () => {
    if (!selected || saving) return;
    if (!window.confirm(t("routing.removeConfirm", { id: selected.id }))) return;
    setSaving(true);
    setStatus(null);
    try {
      const response = await fetch(
        `${apiBase}/api/routing-profiles?id=${encodeURIComponent(selected.id)}`,
        { method: "DELETE" },
      );
      const data = await readJsonIfOk<unknown>(response);
      if (!response.ok) {
        const errorBody = await response.json().catch(() => null) as unknown;
        notify(routingProfileResponseError(errorBody) ?? t("routing.loadFailed"), false);
        return;
      }
      if (!routingProfileResponseSucceeded(data)) {
        notify(routingProfileResponseError(data) ?? t("routing.loadFailed"), false);
        return;
      }
      selectedRef.current = null;
      await load();
      notify(t("common.ok"), true);
    } catch (error) {
      notify(error instanceof Error ? error.message : t("routing.loadFailed"), false);
    } finally {
      setSaving(false);
    }
  };

  const updateCandidate = (
    index: number,
    field: "provider" | "model",
    value: string,
  ) => {
    setDraft(current => {
      if (!current) return current;
      const candidates = current.candidates.map((candidate, candidateIndex) => {
        if (candidateIndex !== index) return candidate;
        if (field === "provider") {
          return {
            ...candidate,
            provider: value,
            model: providerDefaults[value]
              ?? modelOptionsForProvider(models, value)[0]?.id
              ?? "",
          };
        }
        return { ...candidate, model: value };
      });
      return { ...current, candidates };
    });
  };

  const addCandidate = () => {
    setDraft(current => current ? {
      ...current,
      candidates: [
        ...current.candidates,
        newDraftCandidate(firstProvider, firstModel),
      ],
    } : current);
  };

  const removeCandidate = (index: number) => {
    setDraft(current => current ? {
      ...current,
      candidates: current.candidates.filter((_, candidateIndex) => candidateIndex !== index),
    } : current);
  };

  const runDryRun = async () => {
    if (!selected) return;
    const generation = ++dryRunGenerationRef.current;
    setRunning(true);
    setDryRunResult(null);
    setDryRunError("");
    try {
      const evidence: Record<string, number | boolean> = {};
      const contextTokens = context.trim() ? Number(context.trim()) : NaN;
      if (Number.isFinite(contextTokens) && contextTokens > 0) {
        evidence.contextWindow = contextTokens;
      }
      if (tools) evidence.toolsRequired = true;
      if (image) evidence.imageInputRequired = true;
      if (structured) evidence.structuredOutputRequired = true;
      const response = await fetch(`${apiBase}/api/routing-profiles/dry-run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          profile: selected.id,
          evidence,
        }),
      });
      if (generation !== dryRunGenerationRef.current) return;
      if (!response.ok) {
        const body = await response.json().catch(() => null) as unknown;
        if (generation !== dryRunGenerationRef.current) return;
        setDryRunError(routingProfileResponseError(body) ?? t("routing.dryRunError", { status: response.status }));
        return;
      }
      const result = await response.json() as DryRunResult;
      if (generation !== dryRunGenerationRef.current) return;
      setDryRunResult(result);
    } catch (error) {
      if (generation !== dryRunGenerationRef.current) return;
      setDryRunError(error instanceof Error ? error.message : String(error));
    } finally {
      if (generation === dryRunGenerationRef.current) {
        setRunning(false);
      }
    }
  };

  const selectedModelOptions = draft?.candidates.map(
    candidate => modelOptionsForProvider(models, candidate.provider),
  ) ?? [];

  return (
    <div className="page" data-page="routing">
      {/*
        Embedded as a Models tab, so the page title and subtitle belong to the shell.
        Rendering them here too put "Routing Intelligence (beta)" and its description on
        screen twice — visible the moment the panel was opened in a browser, invisible to
        every static gate. The actions stay; a heading cannot carry buttons, so they sit
        in a plain toolbar row.
      */}
      <div className="row" style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginBottom: 12 }}>
        <button type="button" className="btn btn-primary btn-sm" onClick={startCreate}>
          <span aria-hidden="true">+</span> {t("routing.createProfile")}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void load()}>{t("common.retry")}</button>
      </div>

      {loadError ? <Notice tone="err">{t("routing.loadFailed")}: {loadError}</Notice> : null}
      {status ? <Notice tone={status.ok ? "ok" : "err"}>{status.message}</Notice> : null}

      {profiles.length > 0 ? (
        <div className="panel" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {profiles.map(profile => (
            <button
              key={profile.id}
              type="button"
              className="model-card"
              style={{ textAlign: "left", cursor: "pointer" }}
              onClick={() => selectProfile(profile)}
              aria-pressed={selected?.id === profile.id}
            >
              <div className="card-badges">
                <strong>{profile.id}</strong>
                <span className="badge badge-muted">{profile.model}</span>
                <span className="badge badge-muted">{t("routing.revision")}: {profile.revision}</span>
              </div>
            </button>
          ))}
        </div>
      ) : null}

      {draft ? (
        <form
          className="panel"
          style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 16 }}
          onSubmit={event => {
            event.preventDefault();
            void saveProfile();
          }}
        >
          <div className="page-head">
            <h3>{t("routing.detail")}: {selected?.model ?? <code>policy/…</code>}</h3>
            {selected ? <span className="badge badge-muted">{t("routing.revision")}: {selected.revision}</span> : null}
          </div>

          <div className="model-grid">
            <label className="field-label">
              <code>id</code>
              <input
                className="input"
                required
                disabled={selected !== null}
                value={draft.id}
                onChange={event => setDraft(current => current ? { ...current, id: event.target.value } : current)}
              />
            </label>
            <label className="field-label">
              <code>alias</code>
              <input
                className="input"
                value={draft.alias}
                onChange={event => setDraft(current => current ? { ...current, alias: event.target.value } : current)}
              />
            </label>
          </div>

          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="field-label">{t("routing.candidates")}</legend>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {draft.candidates.map((candidate, index) => {
                const candidateProviders = [...new Set([candidate.provider, ...providerNames])].filter(Boolean);
                const listId = `routing-model-options-${index}`;
                return (
                  <div key={candidate.key} className="model-card">
                    <div className="model-grid">
                      <label className="field-label">
                        <code>provider</code>
                        <select
                          className="input"
                          required
                          value={candidate.provider}
                          onChange={event => updateCandidate(index, "provider", event.target.value)}
                        >
                          <option value="" disabled>{t("routing.none")}</option>
                          {candidateProviders.map(provider => <option key={provider} value={provider}>{provider}</option>)}
                        </select>
                      </label>
                      <label className="field-label">
                        <code>model</code>
                        <input
                          className="input"
                          required
                          list={listId}
                          value={candidate.model}
                          onChange={event => updateCandidate(index, "model", event.target.value)}
                        />
                        <datalist id={listId}>
                          {selectedModelOptions[index]?.map(model => <option key={model.id} value={model.id} />)}
                        </datalist>
                      </label>
                    </div>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      disabled={draft.candidates.length === 1}
                      onClick={() => removeCandidate(index)}
                      aria-label={t("routing.removeCandidate", { provider: candidate.provider, model: candidate.model })}
                    >
                      {t("common.remove")}
                    </button>
                  </div>
                );
              })}
              <button type="button" className="btn btn-ghost btn-sm" onClick={addCandidate}>
                <span aria-hidden="true">+</span> {t("routing.candidate")}
              </button>
            </div>
          </fieldset>

          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="field-label">{t("routing.require")}</legend>
            <div className="model-grid">
              {NUMERIC_REQUIREMENTS.map(key => (
                <label key={key} className="field-label">
                  <code>{key}</code>
                  <input
                    className="input"
                    type="number"
                    min={NUMERIC_REQUIREMENT_SPEC[key].min}
                    max={NUMERIC_REQUIREMENT_SPEC[key].max}
                    step={NUMERIC_REQUIREMENT_SPEC[key].step}
                    value={draft.require[key]}
                    onChange={event => setDraft(current => current ? {
                      ...current,
                      require: { ...current.require, [key]: event.target.value },
                    } : current)}
                  />
                </label>
              ))}
              {STRING_REQUIREMENTS.map(key => (
                <label key={key} className="field-label">
                  <code>{key}</code>
                  <input
                    className="input"
                    value={draft.require[key]}
                    onChange={event => setDraft(current => current ? {
                      ...current,
                      require: { ...current.require, [key]: event.target.value },
                    } : current)}
                  />
                </label>
              ))}
              {BOOLEAN_REQUIREMENTS.map(key => (
                <label key={key} className="field-label">
                  <code>{key}</code>
                  <select
                    className="input"
                    value={draft.require[key]}
                    onChange={event => setDraft(current => current ? {
                      ...current,
                      require: {
                        ...current.require,
                        [key]: event.target.value as OptionalBoolean,
                      },
                    } : current)}
                  >
                    <option value="">{t("routing.none")}</option>
                    <option value="true">{t("routing.yes")}</option>
                    <option value="false">{t("routing.no")}</option>
                  </select>
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="field-label">{t("routing.optimize")}</legend>
            <div className="model-grid">
              {OPTIMIZE_KEYS.map(key => (
                <label key={key} className="field-label">
                  <code>{key}</code>
                  <input
                    className="input"
                    type="number"
                    min={0}
                    step="any"
                    required
                    value={draft.optimize[key]}
                    onChange={event => setDraft(current => current ? {
                      ...current,
                      optimize: { ...current.optimize, [key]: event.target.value },
                    } : current)}
                  />
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="field-label">{t("routing.limits")}</legend>
            <label className="field-label">
              <code>maxEstimatedCostUsd</code>
              <input
                className="input"
                type="number"
                min={0}
                step="any"
                value={draft.limits.maxEstimatedCostUsd}
                onChange={event => setDraft(current => current ? {
                  ...current,
                  limits: { ...current.limits, maxEstimatedCostUsd: event.target.value },
                } : current)}
              />
            </label>
            <label className="field-label">
              <code>onUnknownCost</code>
              <select
                className="input"
                value={draft.limits.onUnknownCost}
                onChange={event => setDraft(current => current ? {
                  ...current,
                  limits: {
                    ...current.limits,
                    onUnknownCost: event.target.value as UnknownCostCapMode,
                  },
                } : current)}
              >
                {UNKNOWN_COST_CAP_OPTIONS.map(mode => (
                  <option key={mode} value={mode}>{t(`routing.unknownEvidence.${mode}` as const)}</option>
                ))}
              </select>
            </label>
          </fieldset>

          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="field-label">{t("routing.unknownEvidence")}</legend>
            <div className="model-grid">
              {UNKNOWN_EVIDENCE_KEYS.map(key => (
                <label key={key} className="field-label">
                  <code>{key}</code>
                  <select
                    className="input"
                    value={draft.unknownEvidence[key]}
                    onChange={event => setDraft(current => current ? {
                      ...current,
                      unknownEvidence: {
                        ...current.unknownEvidence,
                        [key]: event.target.value as UnknownEvidenceMode,
                      },
                    } : current)}
                  >
                    {UNKNOWN_EVIDENCE_OPTIONS.map(mode => (
                      <option key={mode} value={mode}>{t(`routing.unknownEvidence.${mode}` as const)}</option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="field-label">{t("routing.compatibility.title")}</legend>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={draft.compatibility.enabled}
                onChange={event => setDraft(current => current ? {
                  ...current,
                  compatibility: { ...current.compatibility, enabled: event.target.checked },
                } : current)}
              />
              {t("routing.compatibility.enabled")}
            </label>
            {draft.compatibility.enabled ? (
              <div className="model-grid" style={{ marginTop: 10 }}>
                <div className="field-label" style={{ gridColumn: "1 / -1" }}>
                  {t("routing.compatibility.requiredSuites")}
                  {catalogError ? (
                    <div style={{ marginTop: 6 }}>
                      <Notice tone="warn">{t("routing.compatibility.catalogUnavailable")}</Notice>
                    </div>
                  ) : null}
                  {catalogSuites.length > 0 ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6 }}>
                      {catalogSuites.map(suite => (
                        <label key={suite.key} className="checkbox">
                          <input
                            type="checkbox"
                            checked={suiteSelected(draft.compatibility.requiredSuites, suite)}
                            onChange={event => setDraft(current => {
                              if (!current) return current;
                              const selected = event.target.checked;
                              const requiredSuites = selected
                                ? [...current.compatibility.requiredSuites, { suiteId: suite.suiteId, evidenceLayer: suite.evidenceLayer }]
                                : current.compatibility.requiredSuites.filter(row =>
                                  !(row.suiteId === suite.suiteId && row.evidenceLayer === suite.evidenceLayer));
                              return {
                                ...current,
                                compatibility: { ...current.compatibility, requiredSuites },
                              };
                            })}
                          />
                          <span>
                            {suite.suiteId}
                            {" "}
                            <span className="muted">
                              ({t(`routing.compatibility.layer.${suite.evidenceLayer}` as const)})
                            </span>
                          </span>
                        </label>
                      ))}
                    </div>
                  ) : null}
                </div>
                <label className="field-label">
                  {t("routing.compatibility.minStatus")}
                  <select
                    className="input"
                    value={draft.compatibility.minStatus}
                    onChange={event => setDraft(current => current ? {
                      ...current,
                      compatibility: {
                        ...current.compatibility,
                        minStatus: event.target.value as RoutingProfileDraft["compatibility"]["minStatus"],
                      },
                    } : current)}
                  >
                    <option value="">{t("routing.none")}</option>
                    <option value="PROBED">{t("lab.verdict.PROBED")}</option>
                    <option value="VERIFIED">{t("lab.verdict.VERIFIED")}</option>
                  </select>
                </label>
                <label className="field-label">
                  {compatibilityFieldLabels.maxEvidenceAgeMs}
                  <input
                    className="input"
                    type="number"
                    min={0}
                    value={draft.compatibility.maxEvidenceAgeMs}
                    onChange={event => setDraft(current => current ? {
                      ...current,
                      compatibility: { ...current.compatibility, maxEvidenceAgeMs: event.target.value },
                    } : current)}
                  />
                </label>
                <label className="field-label">
                  {compatibilityFieldLabels.unknownEvidence}
                  <select
                    className="input"
                    value={draft.compatibility.unknownEvidence}
                    onChange={event => setDraft(current => current ? {
                      ...current,
                      compatibility: {
                        ...current.compatibility,
                        unknownEvidence: event.target.value as UnknownEvidenceMode,
                      },
                    } : current)}
                  >
                    {UNKNOWN_EVIDENCE_OPTIONS.map(mode => (
                      <option key={mode} value={mode}>{t(`routing.unknownEvidence.${mode}` as const)}</option>
                    ))}
                  </select>
                </label>
                <label className="field-label">
                  {compatibilityFieldLabels.degradedEvidence}
                  <select
                    className="input"
                    value={draft.compatibility.degradedEvidence}
                    onChange={event => setDraft(current => current ? {
                      ...current,
                      compatibility: {
                        ...current.compatibility,
                        degradedEvidence: event.target.value as UnknownEvidenceMode,
                      },
                    } : current)}
                  >
                    {UNKNOWN_EVIDENCE_OPTIONS.map(mode => (
                      <option key={mode} value={mode}>{t(`routing.unknownEvidence.${mode}` as const)}</option>
                    ))}
                  </select>
                </label>
              </div>
            ) : null}
          </fieldset>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? t("common.saving") : t("common.save")}
            </button>
            <button type="button" className="btn btn-ghost" disabled={saving} onClick={cancelEdit}>
              {t("common.cancel")}
            </button>
            {selected ? (
              <button type="button" className="btn btn-ghost" disabled={saving} onClick={() => void removeProfile()}>
                {t("common.remove")}
              </button>
            ) : null}
          </div>
        </form>
      ) : null}

      {/* A dry-run form is dead weight until an existing profile is selected to evaluate. */}
      {selected && (
      <div className="panel" style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 10 }}>
        <h3>{t("routing.dryRun")}</h3>
        <label className="field-label" htmlFor="routing-context">
          {t("routing.dryRunContext")}
          <input
            id="routing-context"
            className="input"
            type="number"
            min={1}
            value={context}
            onChange={event => {
              setContext(event.target.value);
              clearDryRun();
            }}
          />
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={tools}
            onChange={event => {
              setTools(event.target.checked);
              clearDryRun();
            }}
          />
          {t("routing.dryRunTools")}
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={image}
            onChange={event => {
              setImage(event.target.checked);
              clearDryRun();
            }}
          />
          {t("routing.dryRunImage")}
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={structured}
            onChange={event => {
              setStructured(event.target.checked);
              clearDryRun();
            }}
          />
          {t("routing.dryRunStructured")}
        </label>
        <button type="button" className="btn btn-primary" disabled={!selected || running} onClick={() => void runDryRun()}>
          {t("routing.dryRunRun")}
        </button>
        {dryRunError ? <Notice tone="err">{dryRunError}</Notice> : null}
        {dryRunResult ? (
          <table className="tbl">
            <thead>
              <tr>
                <th>{t("routing.candidate")}</th>
                <th>{t("routing.eligible")}</th>
                <th>{t("routing.exclusions")}</th>
                <th>{t("routing.costCap")}</th>
                <th>{t("routing.score")}</th>
              </tr>
            </thead>
            <tbody>
              {dryRunResult.candidates.map((candidate, index) => (
                <tr key={`${candidate.provider}/${candidate.model}`}>
                  <td>
                    {candidate.provider}/{candidate.model}
                    {index === dryRunResult.selectedIndex ? ` ✓ (${t("routing.selected")})` : ""}
                  </td>
                  <td>{candidate.eligible ? t("routing.yes") : t("routing.no")}</td>
                  <td>{candidate.exclusions.map(exclusion => fmtExclusion(exclusion.code, t)).join(", ") || t("routing.none")}</td>
                  <td>{fmtCapOutcome(candidate.cost?.capOutcome, t, unavailable)}</td>
                  <td>{candidate.score ? candidate.score.total.toFixed(3) : unavailable}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>

      )}
      {profiles.length > 0 && (
      <div className="panel" style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 10 }}>
        <h3>{t("routing.analytics")}</h3>
        {analytics ? (
          <>
            <div className="card-badges">
              <span className="badge badge-muted">{t("routing.analyticsTotal")}: {analytics.totalRequests}</span>
              <span className="badge badge-muted">{t("routing.analyticsSuccessRate")}: {fmtRate(analytics.successRate, unavailable)}</span>
              <span className="badge badge-muted">{t("routing.analyticsFallbackRate")}: {fmtRate(analytics.fallbackRate, unavailable)}</span>
              <span className="badge badge-muted">{t("routing.analyticsP50")}: {fmtMs(analytics.durationMs.p50, unavailable)}</span>
              <span className="badge badge-muted">{t("routing.analyticsP95")}: {fmtMs(analytics.durationMs.p95, unavailable)}</span>
              <span className="badge badge-muted">{t("routing.analyticsP99")}: {fmtMs(analytics.durationMs.p99, unavailable)}</span>
              <span className="badge badge-muted">{t("routing.analyticsCooldown")}: {analytics.cooldownTriggeringFailures}</span>
              <span className="badge badge-muted">{t("routing.analyticsConfidence")}: {analytics.confidence ?? unavailable}</span>
              {analytics.historyTruncated ? <span className="badge badge-muted">{t("routing.analyticsTruncated")}</span> : null}
            </div>
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t("routing.candidate")}</th>
                  <th>{t("routing.analyticsRequests")}</th>
                  <th>{t("routing.analyticsSuccessRate")}</th>
                  <th>{t("routing.analyticsP50")}</th>
                </tr>
              </thead>
              <tbody>
                {analytics.breakdown.map(row => (
                  <tr key={`${row.provider}/${row.model}`}>
                    <td>{row.provider}/{row.model}</td>
                    <td>{row.requests}</td>
                    <td>{fmtRate(row.successRate, unavailable)}</td>
                    <td>{fmtMs(row.p50DurationMs, unavailable)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : (
          <p className="muted">{t("routing.analyticsEmpty")}</p>
        )}
      </div>
      )}
    </div>
  );
}
