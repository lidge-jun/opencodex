/**
 * ProviderSettings — adapter/baseUrl/defaultModel/authMode/note editing form
 * for the workspace Settings tab (WP091). Uses PATCH /api/providers via an
 * onUpdateProvider prop. May fetch `/api/provider-presets` once per provider
 * to discover `baseUrlChoices` (e.g. Qwen Cloud endpoint picker).
 *
 * Parent should remount on provider change (`key={item.name}`) so choice-loading
 * state resets cleanly without sync setState-in-effect.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { baseUrlForChoice, matchChoiceId, resolvedBaseUrlForChoice } from "../../base-url-choice";
import { readJsonIfOk } from "../../fetch-json";
import { createBoundedFetch } from "../../bounded-fetch";
import { startVisibilityPoll } from "../../visibility-poll";
import { useT } from "../../i18n/shared";
import { IconLock } from "../../icons";
import { isCatalogProviderId } from "../../provider-icons";
import { openAiAccountProviderState } from "../../provider-payload";
import { providerSupportsLiveModelDiscovery } from "../../provider-workspace/catalog";
import type { CatalogPreset } from "../provider-catalog/provider-presets";
import { authModeLabel } from "./ProviderRail";
import type { WorkspaceItem, ProviderUpdatePatch, ProviderUpdateResult } from "./types";

const ADAPTERS = ["openai-responses", "openai-chat", "anthropic", "google", "azure-openai", "cursor"] as const;
const EMPTY_MODELS: string[] = [];

type ChoicesStatus = "idle" | "loading" | "ready" | "error";
type PacingRule = { requestsPerMinute?: number; minIntervalMs?: number };
type PacingStatus = { enabled: boolean; queued: number; nextSlotInMs: number; lastStartedAt?: number; lastModelId?: string };
type CursorHttpVersion = "http2" | "http1.1";

function effectiveCursorHttpVersion(value: WorkspaceItem["upstreamHttpVersion"]): CursorHttpVersion {
  return value === "http1.1" || value === "h1" ? "http1.1" : "http2";
}

function numberDraft(value: number | undefined): string { return value === undefined ? "" : String(value); }
function positiveRpm(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 / 60 ? parsed : undefined;
}
function positiveInteger(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
function pacingSignature(value: WorkspaceItem["requestPacing"] | undefined): string {
  const models = Object.entries(value?.models ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([model, rule]) => [model, rule.requestsPerMinute ?? null, rule.minIntervalMs ?? null]);
  return JSON.stringify([
    value?.enabled === true,
    value?.requestsPerMinute ?? null,
    value?.minIntervalMs ?? null,
    models,
  ]);
}

export default function ProviderSettings({
  item, availableModels = EMPTY_MODELS, apiBase, onUpdateProvider, onDirtyChange, onRegisterSave,
}: {
  item: WorkspaceItem;
  availableModels?: string[];
  /** When set, load endpoint choices for catalog providers that expose baseUrlChoices. */
  apiBase?: string;
  onUpdateProvider?: (name: string, patch: ProviderUpdatePatch) => Promise<ProviderUpdateResult>;
  onDirtyChange?: (dirty: boolean) => void;
  /** Lets parent dialogs trigger the same save path as the sticky bar. */
  onRegisterSave?: (save: (() => Promise<boolean>) | null) => void;
}) {
  const t = useT();
  const initialAuth = String(item.authMode ?? (item.keyOptional ? "local" : "key"));
  const liveModelDiscoverySupported = providerSupportsLiveModelDiscovery(item.name, item);
  const savedLiveModels = liveModelDiscoverySupported ? item.liveModels !== false : false;
  const savedCursorHttpVersion = effectiveCursorHttpVersion(item.upstreamHttpVersion);
  const [adapter, setAdapter] = useState(item.adapter);
  const [baseUrl, setBaseUrl] = useState(item.baseUrl);
  const [defaultModel, setDefaultModel] = useState(item.defaultModel ?? "");
  const [authMode, setAuthMode] = useState(initialAuth);
  const [apiKeyTransport, setApiKeyTransport] = useState(item.apiKeyTransport ?? "x-api-key");
  const [note, setNote] = useState(item.note ?? "");
  const [allowPrivateNetwork, setAllowPrivateNetwork] = useState(item.allowPrivateNetwork ?? false);
  const [liveModels, setLiveModels] = useState(savedLiveModels);
  const [cursorHttpVersion, setCursorHttpVersion] = useState<CursorHttpVersion>(savedCursorHttpVersion);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [accountMode, setAccountMode] = useState<"pool" | "direct">(item.codexAccountMode ?? "pool");
  const [modeSaving, setModeSaving] = useState(false);
  const [modeMsg, setModeMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [baseUrlChoices, setBaseUrlChoices] = useState<CatalogPreset["baseUrlChoices"]>();
  const [choicesStatus, setChoicesStatus] = useState<ChoicesStatus>(apiBase ? "loading" : "idle");
  const [endpointChoice, setEndpointChoice] = useState(() => "custom");
  const [pacingEnabled, setPacingEnabled] = useState(item.requestPacing?.enabled === true);
  const [pacingRpm, setPacingRpm] = useState(() => numberDraft(item.requestPacing?.requestsPerMinute));
  const [pacingDelay, setPacingDelay] = useState(() => numberDraft(item.requestPacing?.minIntervalMs));
  const [pacingModels, setPacingModels] = useState<Record<string, PacingRule>>(() => ({ ...(item.requestPacing?.models ?? {}) }));
  const [pacingModelId, setPacingModelId] = useState("");
  const [pacingModelRpm, setPacingModelRpm] = useState("");
  const [pacingModelDelay, setPacingModelDelay] = useState("");
  const [pacingStatus, setPacingStatus] = useState<PacingStatus | null>(null);

  /* eslint-disable react-hooks/set-state-in-effect -- intentional form reset when saved provider fields change */
  useEffect(() => {
    setAdapter(item.adapter);
    setBaseUrl(item.baseUrl);
    setDefaultModel(item.defaultModel ?? "");
    setAuthMode(String(item.authMode ?? (item.keyOptional ? "local" : "key")));
    setApiKeyTransport(item.apiKeyTransport ?? "x-api-key");
    setNote(item.note ?? "");
    setAllowPrivateNetwork(item.allowPrivateNetwork ?? false);
    setLiveModels(savedLiveModels);
    setCursorHttpVersion(savedCursorHttpVersion);
    setPacingEnabled(item.requestPacing?.enabled === true);
    setPacingRpm(numberDraft(item.requestPacing?.requestsPerMinute));
    setPacingDelay(numberDraft(item.requestPacing?.minIntervalMs));
    setPacingModels({ ...(item.requestPacing?.models ?? {}) });
    setMsg(null);
    setModeMsg(null);
    queueMicrotask(() => setEndpointChoice(matchChoiceId(baseUrlChoices, item.baseUrl)));
  }, [item.adapter, item.baseUrl, item.defaultModel, item.authMode, item.apiKeyTransport, item.keyOptional, item.note, item.allowPrivateNetwork, savedLiveModels, savedCursorHttpVersion, item.requestPacing, baseUrlChoices]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Account mode syncs on its own: a mode PATCH refresh must not reset an in-progress
  // draft, so it is deliberately kept out of the form-reset effect above.
  /* eslint-disable react-hooks/set-state-in-effect -- intentional split from the form reset */
  useEffect(() => {
    setAccountMode(item.codexAccountMode ?? "pool");
  }, [item.codexAccountMode]);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    if (!apiBase) return;
    let cancelled = false;
    const providerId = item.name;
    const savedBaseUrl = item.baseUrl;
    fetch(`${apiBase}/api/provider-presets`)
      .then(r => readJsonIfOk<{ providers?: CatalogPreset[] }>(r))
      .then((d) => {
        if (cancelled) return;
        if (!d) {
          setBaseUrlChoices(undefined);
          setChoicesStatus("error");
          return;
        }
        const preset = (d.providers ?? []).find(p => p.id === providerId);
        const choices = preset?.baseUrlChoices;
        setBaseUrlChoices(choices);
        setChoicesStatus("ready");
        setEndpointChoice(matchChoiceId(choices, savedBaseUrl));
      })
      .catch(() => {
        if (cancelled) return;
        setBaseUrlChoices(undefined);
        setChoicesStatus("error");
      });
    return () => { cancelled = true; };
    // Remount via key={item.name}; capture savedBaseUrl once per mount/fetch.
    // oxlint-disable-next-line react/react-compiler -- existing exhaustive-deps exception is intentional
    // eslint-disable-next-line react-hooks/exhaustive-deps -- item.baseUrl sync is handled by the form-reset effect
  }, [apiBase, item.name]);

  useEffect(() => {
    if (!apiBase) return;
    let active = true;
    let inFlight = false;
    const load = () => {
      // Guarded + bounded: a hung pacing read must never stack or pin the panel.
      if (inFlight) return;
      inFlight = true;
      const bounded = createBoundedFetch(10_000);
      fetch(`${apiBase}/api/provider-request-pacing?name=${encodeURIComponent(item.name)}`, { signal: bounded.signal })
        .then(r => readJsonIfOk<PacingStatus>(r))
        .then(status => { if (active && status) setPacingStatus(status); })
        .catch(() => undefined)
        .finally(() => { bounded.clear(); inFlight = false; });
    };
    load();
    const stop = startVisibilityPoll(load, 2_000);
    return () => { active = false; stop(); };
  }, [apiBase, item.name]);

  const pacingDraft = useMemo(() => ({
    enabled: pacingEnabled,
    ...(positiveRpm(pacingRpm) !== undefined ? { requestsPerMinute: positiveRpm(pacingRpm) } : {}),
    ...(positiveInteger(pacingDelay) !== undefined ? { minIntervalMs: positiveInteger(pacingDelay) } : {}),
    ...(Object.keys(pacingModels).length > 0 ? { models: pacingModels } : {}),
  }), [pacingDelay, pacingEnabled, pacingModels, pacingRpm]);

  const dirty = adapter.trim() !== item.adapter
    || baseUrl.trim() !== item.baseUrl
    || defaultModel.trim() !== (item.defaultModel ?? "")
    || authMode !== String(item.authMode ?? (item.keyOptional ? "local" : "key"))
    || (adapter.trim() === "anthropic" && authMode === "key" && apiKeyTransport !== (item.apiKeyTransport ?? "x-api-key"))
    || note.trim() !== (item.note ?? "")
    || allowPrivateNetwork !== (item.allowPrivateNetwork ?? false)
    || liveModels !== savedLiveModels
    || (adapter.trim() === "cursor" && cursorHttpVersion !== savedCursorHttpVersion);
  const pacingDirty = pacingSignature(pacingDraft) !== pacingSignature(item.requestPacing);
  const formDirty = dirty || pacingDirty;

  useEffect(() => { onDirtyChange?.(formDirty); return () => onDirtyChange?.(false); }, [formDirty, onDirtyChange]);

  const modelOptions = useMemo(() => {
    const set = new Set(availableModels);
    if (defaultModel.trim()) set.add(defaultModel.trim());
    if (item.defaultModel) set.add(item.defaultModel);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [availableModels, defaultModel, item.defaultModel]);

  const adapterOptions = useMemo(() => {
    const list = [...ADAPTERS] as string[];
    if (adapter && !list.includes(adapter)) list.unshift(adapter);
    return list;
  }, [adapter]);

  const isPreset = isCatalogProviderId(item.name);
  const hasEndpointPicker = choicesStatus === "ready" && !!(baseUrlChoices && baseUrlChoices.length > 0);
  const supportsApiKeyTransport = adapter.trim() === "anthropic" && authMode === "key";
  const openAiState = item.name === "openai" ? openAiAccountProviderState(item) : "invalid";
  const isCanonicalOpenAi = openAiState === "ready" || openAiState === "disabled";
  // Lock plain baseUrl for presets while loading or when there is no picker.
  // On fetch error, keep it editable so allowBaseUrlOverride providers are not trapped.
  const plainBaseUrlLocked = isPreset && choicesStatus !== "error";

  const save = async (): Promise<boolean> => {
    if (!onUpdateProvider) { setMsg({ ok: false, text: t("pws.updatesUnavailable") }); return false; }
    if (modeSaving) return false;
    const nextBaseUrl = hasEndpointPicker
      ? resolvedBaseUrlForChoice(baseUrlChoices, endpointChoice, baseUrl)
      : baseUrl.trim();
    if (!adapter.trim() || !nextBaseUrl) { setMsg({ ok: false, text: t("pws.adapterBaseRequired") }); return false; }
    setSaving(true);
    setMsg(null);
    try {
      if (pacingEnabled && !pacingDraft.requestsPerMinute && !pacingDraft.minIntervalMs && !pacingDraft.models) {
        setMsg({ ok: false, text: t("pws.pacingRuleRequired") }); return false;
      }
      const pacingOnly = pacingDirty && !dirty;
      const patch: ProviderUpdatePatch = pacingOnly
        ? { requestPacing: pacingDraft }
        : {
            adapter: adapter.trim(),
            baseUrl: nextBaseUrl,
            defaultModel: defaultModel.trim(),
            authMode,
            note: note.trim(),
            allowPrivateNetwork,
            ...(pacingDirty ? { requestPacing: pacingDraft } : {}),
          };
      if (!pacingOnly) {
        // Keep omitted legacy values omitted unless the user actually changes this toggle.
        // Otherwise an unrelated settings save manufactures `liveModels: true` provenance.
        if (liveModelDiscoverySupported && liveModels !== (item.liveModels !== false)) patch.liveModels = liveModels;
        if (adapter.trim() === "cursor" && cursorHttpVersion !== savedCursorHttpVersion) {
          patch.upstreamHttpVersion = cursorHttpVersion === "http1.1" ? "http1.1" : null;
        }
        if (supportsApiKeyTransport) patch.apiKeyTransport = apiKeyTransport;
        else if (item.apiKeyTransport !== undefined) patch.apiKeyTransport = "";
      }
      const res = await onUpdateProvider(item.name, patch);
      setMsg(res.ok ? { ok: true, text: t("pws.settingsSaved") } : { ok: false, text: res.error || t("prov.saveFailed") });
      return res.ok;
    } finally {
      setSaving(false);
    }
  };

  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  });
  useEffect(() => {
    if (!onRegisterSave) return;
    onRegisterSave(() => saveRef.current());
    return () => onRegisterSave(null);
  }, [onRegisterSave]);

  const applyAccountMode = async (next: "pool" | "direct") => {
    if (modeSaving || saving || next === accountMode) return;
    if (!onUpdateProvider) { setModeMsg({ ok: false, text: t("pws.updatesUnavailable") }); return; }
    setModeSaving(true);
    setModeMsg(null);
    try {
      const res = await onUpdateProvider("openai", { codexAccountMode: next });
      if (res.ok) {
        setAccountMode(next);
        setModeMsg({ ok: true, text: t("pws.accountModeSaved") });
      } else {
        setModeMsg({ ok: false, text: res.error || t("pws.accountModeFailed") });
      }
    } catch {
      setModeMsg({ ok: false, text: t("pws.accountModeFailed") });
    } finally {
      setModeSaving(false);
    }
  };

  const discard = () => {
    setAdapter(item.adapter); setBaseUrl(item.baseUrl);
    setDefaultModel(item.defaultModel ?? ""); setAuthMode(initialAuth);
    setApiKeyTransport(item.apiKeyTransport ?? "x-api-key");
    setNote(item.note ?? ""); setAllowPrivateNetwork(item.allowPrivateNetwork ?? false); setLiveModels(savedLiveModels);
    setCursorHttpVersion(savedCursorHttpVersion); setMsg(null);
    setPacingEnabled(item.requestPacing?.enabled === true); setPacingRpm(numberDraft(item.requestPacing?.requestsPerMinute));
    setPacingDelay(numberDraft(item.requestPacing?.minIntervalMs)); setPacingModels({ ...(item.requestPacing?.models ?? {}) });
    setEndpointChoice(matchChoiceId(baseUrlChoices, item.baseUrl));
  };

  const endpointLabel = (id: string, fallback: string) => {
    switch (id) {
      case "token-plan": return t("modal.endpoint.tokenPlan");
      case "payg": return t("modal.endpoint.payAsYouGo");
      case "custom": return t("modal.endpoint.custom");
      default: return fallback;
    }
  };

  const addPacingModel = () => {
    const modelId = pacingModelId.trim();
    const rpm = positiveRpm(pacingModelRpm);
    const delay = positiveInteger(pacingModelDelay);
    if (!modelId || (rpm === undefined && delay === undefined)) return;
    setPacingModels(current => ({ ...current, [modelId]: { ...(rpm !== undefined ? { requestsPerMinute: rpm } : {}), ...(delay !== undefined ? { minIntervalMs: delay } : {}) } }));
    setPacingModelId(""); setPacingModelRpm(""); setPacingModelDelay("");
  };

  return (
    <div className="pwi-settings-form">
      <label className="pwi-settings-field">
        <span className="pwi-settings-label"><IconLock style={{ width: 12, height: 12 }} /> {t("pws.providerId")}</span>
        <input className="input" value={item.name} readOnly disabled />
      </label>
      <label className="pwi-settings-field">
        <span className="pwi-settings-label">{t("modal.adapter")}</span>
        {isPreset ? <input className="input" value={adapter} readOnly disabled /> : (
          <select className="input" value={adapter} onChange={e => setAdapter(e.target.value)}>
            {adapterOptions.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
        )}
      </label>
      {hasEndpointPicker ? (
        <>
          <label className="pwi-settings-field">
            <span className="pwi-settings-label">{t("modal.endpoint")}</span>
            <select
              className="input"
              value={endpointChoice}
              onChange={e => {
                const id = e.target.value;
                setEndpointChoice(id);
                setBaseUrl(baseUrlForChoice(baseUrlChoices, id, baseUrl));
              }}
            >
              {baseUrlChoices!.map(c => (
                <option key={c.id} value={c.id}>{endpointLabel(c.id, c.label)}</option>
              ))}
            </select>
          </label>
          {endpointChoice === "custom" && (
            <label className="pwi-settings-field">
              <span className="pwi-settings-label">{t("modal.baseUrl")}</span>
              <input className="input" value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder={t("modal.baseUrlPlaceholder")} />
            </label>
          )}
        </>
      ) : (
        <label className="pwi-settings-field">
          <span className="pwi-settings-label">{t("modal.baseUrl")}</span>
          <input className="input" value={baseUrl} onChange={e => setBaseUrl(e.target.value)} readOnly={plainBaseUrlLocked} disabled={plainBaseUrlLocked} />
        </label>
      )}
      {adapter.trim() === "cursor" && (
        <label className="pwi-settings-field">
          <span className="pwi-settings-label">{t("pws.cursorTransport")}</span>
          <select
            className="input"
            value={cursorHttpVersion}
            onChange={e => setCursorHttpVersion(e.target.value as CursorHttpVersion)}
          >
            <option value="http2">{t("pws.cursorTransportHttp2")}</option>
            <option value="http1.1">{t("pws.cursorTransportHttp1")}</option>
          </select>
          <span className="pwi-settings-hint">{t("pws.cursorTransportDesc")}</span>
        </label>
      )}
      <label className="pwi-settings-field">
        <span className="pwi-settings-label">{t("pws.cell.defaultModel")}</span>
        {modelOptions.length > 0 ? (
          <select className="input" value={defaultModel} onChange={e => setDefaultModel(e.target.value)}>
            <option value="">{t("pws.defaultModelNone")}</option>
            {modelOptions.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        ) : (
          <input className="input" value={defaultModel} onChange={e => setDefaultModel(e.target.value)} placeholder={t("pws.optionalPlaceholder")} />
        )}
      </label>
      <label className="pwi-settings-field">
        <span className="pwi-settings-label">{t("pws.authMode")}</span>
        {isPreset ? <input className="input" value={authModeLabel(item, t)} readOnly disabled /> : (
          <select className="input" value={authMode} onChange={e => setAuthMode(e.target.value)}>
            <option value="key">{t("modal.badge.apiKey")}</option>
            <option value="forward">{t("pws.auth.chatgptPassthrough")}</option>
            <option value="oauth">{t("modal.badge.oauth")}</option>
            <option value="local">{t("modal.badge.local")}</option>
          </select>
        )}
      </label>
      {isCanonicalOpenAi && (
        <label className="pwi-settings-field">
          <span className="pwi-settings-label">{t("codexAuth.accountModeTitle")}</span>
          <select
            className="input"
            value={accountMode}
            disabled={modeSaving || saving}
            onChange={e => {
              const next = e.target.value as "pool" | "direct";
              if (next === accountMode) return;
              // Flipping modes rebinds running threads and changes quota accounting,
              // so the PATCH only fires after an explicit confirmation.
              if (!window.confirm(t("pws.accountModeConfirm"))) {
                // Keep the visible choice aligned with the applied mode.
                e.target.value = accountMode;
                return;
              }
              void applyAccountMode(next);
            }}
          >
            <option value="pool">{t("codexAuth.accountModePool")}</option>
            <option value="direct">{t("codexAuth.accountModeDirect")}</option>
          </select>
          <span className="pwi-settings-hint">
            {accountMode === "direct" ? t("codexAuth.accountModeDirectDesc") : t("codexAuth.accountModePoolDesc")}
          </span>
          {modeSaving && <span className="muted text-label">{t("pws.accountSwitching")}</span>}
          {modeMsg && (
            <span
              role={modeMsg.ok ? "status" : "alert"}
              className={modeMsg.ok ? "pwi-settings-mode-msg pwi-settings-mode-msg--ok" : "pwi-settings-mode-msg pwi-settings-mode-msg--err"}
            >
              {modeMsg.text}
            </span>
          )}
        </label>
      )}
      {supportsApiKeyTransport && (
        <label className="pwi-settings-field">
          <span className="pwi-settings-label">{t("modal.apiKeyTransport")}</span>
          <select className="input" value={apiKeyTransport} onChange={e => setApiKeyTransport(e.target.value as "x-api-key" | "bearer")}>
            <option value="x-api-key">{t("modal.apiKeyTransportNative")}</option>
            <option value="bearer">{t("modal.apiKeyTransportBearer")}</option>
          </select>
        </label>
      )}
      <label className="pwi-settings-field">
        <span className="pwi-settings-label">{t("pws.note")}</span>
        <textarea className="input pwi-settings-textarea" value={note} onChange={e => setNote(e.target.value)} rows={2} />
      </label>
      <label className="pwi-settings-field" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <input type="checkbox" checked={allowPrivateNetwork} onChange={e => setAllowPrivateNetwork(e.target.checked)} />
        <span className="pwi-settings-label">{t("pws.allowPrivateNetwork")}</span>
      </label>
      <label className="pwi-settings-field" style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
        <input
          type="checkbox"
          checked={liveModels}
          disabled={!liveModelDiscoverySupported}
          onChange={e => setLiveModels(e.target.checked)}
        />
        <span>
          <span className="pwi-settings-label">{t("pws.liveModels")}</span>
          <span className="muted text-label" style={{ display: "block", marginTop: 2 }}>{t("pws.liveModelsDesc")}</span>
        </span>
      </label>
      <section className="pwi-pacing-card" aria-labelledby="pwi-pacing-title">
        <div className="pwi-pacing-head">
          <div><h3 id="pwi-pacing-title">{t("pws.pacingTitle")}</h3><p>{t("pws.pacingDesc")}</p></div>
          <label className="pwi-pacing-toggle"><input type="checkbox" checked={pacingEnabled} onChange={e => setPacingEnabled(e.target.checked)} /> {t("pws.pacingEnabled")}</label>
        </div>
        <div className="pwi-pacing-grid">
          <label className="pwi-settings-field"><span className="pwi-settings-label">{t("pws.pacingRpm")}</span><input className="input" type="number" min="0.016667" step="any" value={pacingRpm} onChange={e => setPacingRpm(e.target.value)} placeholder="38" /></label>
          <label className="pwi-settings-field"><span className="pwi-settings-label">{t("pws.pacingDelay")}</span><input className="input" type="number" min="1" step="1" value={pacingDelay} onChange={e => setPacingDelay(e.target.value)} placeholder="1600" /></label>
        </div>
        <p className="pwi-settings-hint">{t("pws.pacingSlowerWins")}</p>
        <div className="pwi-pacing-status" aria-live="polite">
          <span><strong>{pacingStatus?.queued ?? 0}</strong> {t("pws.pacingQueued")}</span>
          <span><strong>{pacingStatus?.nextSlotInMs ?? 0} ms</strong> {t("pws.pacingNextSlot")}</span>
          <span><strong>{pacingStatus?.lastModelId ?? t("pws.pacingNone")}</strong> {t("pws.pacingLastModel")}</span>
        </div>
        <h4>{t("pws.pacingModelOverrides")}</h4>
        <div className="pwi-pacing-grid pwi-pacing-grid--model">
          <label className="pwi-settings-field"><span className="pwi-settings-label">{t("pws.pacingModel")}</span><input className="input" list={`pacing-models-${item.name}`} value={pacingModelId} onChange={e => setPacingModelId(e.target.value)} /><datalist id={`pacing-models-${item.name}`}>{availableModels.map(model => <option key={model} value={model} />)}</datalist></label>
          <label className="pwi-settings-field"><span className="pwi-settings-label">{t("pws.pacingRpm")}</span><input className="input" type="number" min="0.016667" step="any" value={pacingModelRpm} onChange={e => setPacingModelRpm(e.target.value)} /></label>
          <label className="pwi-settings-field"><span className="pwi-settings-label">{t("pws.pacingDelay")}</span><input className="input" type="number" min="1" step="1" value={pacingModelDelay} onChange={e => setPacingModelDelay(e.target.value)} /></label>
          <button type="button" className="btn btn-ghost btn-sm" onClick={addPacingModel}>{t("pws.pacingAdd")}</button>
        </div>
        {Object.entries(pacingModels).length > 0 && <div className="pwi-pacing-overrides">{Object.entries(pacingModels).map(([model, rule]) => <div key={model} className="pwi-pacing-row"><code>{model}</code><span>{rule.requestsPerMinute !== undefined ? `${rule.requestsPerMinute} ${t("pws.pacingRpmUnit")}` : ""}{rule.requestsPerMinute !== undefined && rule.minIntervalMs !== undefined ? " · " : ""}{rule.minIntervalMs !== undefined ? `${rule.minIntervalMs} ms` : ""}</span><button type="button" className="btn btn-ghost btn-sm" onClick={() => setPacingModels(current => Object.fromEntries(Object.entries(current).filter(([id]) => id !== model)))} aria-label={t("pws.pacingRemoveModel", { model })}>{t("pws.pacingRemove")}</button></div>)}</div>}
      </section>
      {formDirty && (
        <div className="pwi-settings-sticky-bar">
          <span className="muted">{t("pws.settingsUnsavedBar")}</span>
          <div className="pwi-settings-sticky-bar-actions">
            <button type="button" className="btn btn-ghost btn-sm" onClick={discard} disabled={saving}>{t("pws.discardSettings")}</button>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => void save()} disabled={saving || modeSaving}>{saving ? t("pws.saving") : t("pws.saveSettings")}</button>
          </div>
        </div>
      )}
      {msg && (
        <div role={msg.ok ? "status" : "alert"} className={msg.ok ? "pwi-settings-msg pwi-settings-msg--ok" : "pwi-settings-msg pwi-settings-msg--err"}>
          {msg.text}
        </div>
      )}
    </div>
  );
}
