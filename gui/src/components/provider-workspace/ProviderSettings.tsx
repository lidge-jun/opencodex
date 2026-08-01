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
import { useT } from "../../i18n/shared";
import { IconLock, IconPlus, IconTrash } from "../../icons";
import { isCatalogProviderId } from "../../provider-icons";
import type { CatalogPreset } from "../provider-catalog/provider-presets";
import { authModeLabel } from "./ProviderRail";
import type { ProviderFallbackTarget, WorkspaceItem, ProviderUpdatePatch } from "./types";

const ADAPTERS = ["openai-responses", "openai-chat", "anthropic", "google", "azure-openai", "cursor"] as const;
const EMPTY_MODELS: string[] = [];
const EMPTY_PEERS: ProviderPeerOption[] = [];

export type ProviderPeerOption = {
  name: string;
  disabled?: boolean;
  models?: string[];
  defaultModel?: string;
};

type ChoicesStatus = "idle" | "loading" | "ready" | "error";

/** A fallback row plus a stable identity, so React keys survive reorder/removal. */
type FallbackRow = ProviderFallbackTarget & { id: string };

let fallbackRowSeq = 0;
function withRowIds(rows: ProviderFallbackTarget[]): FallbackRow[] {
  return rows.map(row => ({ ...row, id: `fb-${++fallbackRowSeq}` }));
}

function normalizeFallback(raw: ProviderFallbackTarget[] | undefined): ProviderFallbackTarget[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(row => ({
      provider: typeof row.provider === "string" ? row.provider.trim() : "",
      model: typeof row.model === "string" ? row.model.trim() : "",
    }))
    .filter(row => row.provider && row.model);
}

function fallbackFingerprint(rows: ProviderFallbackTarget[] | undefined): string {
  return JSON.stringify(normalizeFallback(rows));
}

function modelsForPeer(peer: ProviderPeerOption | undefined, currentModel: string): string[] {
  const set = new Set<string>();
  for (const id of peer?.models ?? []) {
    if (id.trim()) set.add(id.trim());
  }
  if (peer?.defaultModel?.trim()) set.add(peer.defaultModel.trim());
  if (currentModel.trim()) set.add(currentModel.trim());
  return [...set].sort((a, b) => a.localeCompare(b));
}

export default function ProviderSettings({
  item, availableModels = EMPTY_MODELS, peerProviders = EMPTY_PEERS, apiBase, onUpdateProvider, onDirtyChange, onRegisterSave,
}: {
  item: WorkspaceItem;
  availableModels?: string[];
  /** Other configured providers (and their known models) for the fallback picker. */
  peerProviders?: ProviderPeerOption[];
  /** When set, load endpoint choices for catalog providers that expose baseUrlChoices. */
  apiBase?: string;
  onUpdateProvider?: (name: string, patch: ProviderUpdatePatch) => Promise<{ ok: boolean; error?: string }>;
  onDirtyChange?: (dirty: boolean) => void;
  /** Lets parent dialogs trigger the same save path as the sticky bar. */
  onRegisterSave?: (save: (() => Promise<boolean>) | null) => void;
}) {
  const t = useT();
  const initialAuth = String(item.authMode ?? (item.keyOptional ? "local" : "key"));
  const [adapter, setAdapter] = useState(item.adapter);
  const [baseUrl, setBaseUrl] = useState(item.baseUrl);
  const [defaultModel, setDefaultModel] = useState(item.defaultModel ?? "");
  const [authMode, setAuthMode] = useState(initialAuth);
  const [apiKeyTransport, setApiKeyTransport] = useState(item.apiKeyTransport ?? "x-api-key");
  const [note, setNote] = useState(item.note ?? "");
  const [allowPrivateNetwork, setAllowPrivateNetwork] = useState(item.allowPrivateNetwork ?? false);
  const [liveModels, setLiveModels] = useState(item.liveModels !== false);
  const [fallback, setFallback] = useState<FallbackRow[]>(() => withRowIds(normalizeFallback(item.fallback)));
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [baseUrlChoices, setBaseUrlChoices] = useState<CatalogPreset["baseUrlChoices"]>();
  const [choicesStatus, setChoicesStatus] = useState<ChoicesStatus>(apiBase ? "loading" : "idle");
  const [endpointChoice, setEndpointChoice] = useState(() => "custom");

  /* eslint-disable react-hooks/set-state-in-effect -- intentional form reset when saved provider fields change */
  useEffect(() => {
    setAdapter(item.adapter);
    setBaseUrl(item.baseUrl);
    setDefaultModel(item.defaultModel ?? "");
    setAuthMode(String(item.authMode ?? (item.keyOptional ? "local" : "key")));
    setApiKeyTransport(item.apiKeyTransport ?? "x-api-key");
    setNote(item.note ?? "");
    setAllowPrivateNetwork(item.allowPrivateNetwork ?? false);
    setLiveModels(item.liveModels !== false);
    setFallback(withRowIds(normalizeFallback(item.fallback)));
    setMsg(null);
    queueMicrotask(() => setEndpointChoice(matchChoiceId(baseUrlChoices, item.baseUrl)));
  }, [item.adapter, item.baseUrl, item.defaultModel, item.authMode, item.apiKeyTransport, item.keyOptional, item.note, item.allowPrivateNetwork, item.liveModels, item.fallback, baseUrlChoices]);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- item.baseUrl sync is handled by the form-reset effect
  }, [apiBase, item.name]);

  const dirty = adapter.trim() !== item.adapter
    || baseUrl.trim() !== item.baseUrl
    || defaultModel.trim() !== (item.defaultModel ?? "")
    || authMode !== String(item.authMode ?? (item.keyOptional ? "local" : "key"))
    || (adapter.trim() === "anthropic" && authMode === "key" && apiKeyTransport !== (item.apiKeyTransport ?? "x-api-key"))
    || note.trim() !== (item.note ?? "")
    || allowPrivateNetwork !== (item.allowPrivateNetwork ?? false)
    || liveModels !== (item.liveModels !== false)
    || fallbackFingerprint(fallback) !== fallbackFingerprint(item.fallback);

  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);

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

  const fallbackPeers = useMemo(
    () => peerProviders.filter(p => p.name !== item.name),
    [peerProviders, item.name],
  );

  const isPreset = isCatalogProviderId(item.name);
  const hasEndpointPicker = choicesStatus === "ready" && !!(baseUrlChoices && baseUrlChoices.length > 0);
  const supportsApiKeyTransport = adapter.trim() === "anthropic" && authMode === "key";
  // Lock plain baseUrl for presets while loading or when there is no picker.
  // On fetch error, keep it editable so allowBaseUrlOverride providers are not trapped.
  const plainBaseUrlLocked = isPreset && choicesStatus !== "error";

  const save = async (): Promise<boolean> => {
    if (!onUpdateProvider) { setMsg({ ok: false, text: t("pws.updatesUnavailable") }); return false; }
    const nextBaseUrl = hasEndpointPicker
      ? resolvedBaseUrlForChoice(baseUrlChoices, endpointChoice, baseUrl)
      : baseUrl.trim();
    if (!adapter.trim() || !nextBaseUrl) { setMsg({ ok: false, text: t("pws.adapterBaseRequired") }); return false; }
    const nextFallback = normalizeFallback(fallback);
    if (fallback.some(row => (row.provider.trim() && !row.model.trim()) || (!row.provider.trim() && row.model.trim()))) {
      setMsg({ ok: false, text: t("pws.fallbackIncomplete") });
      return false;
    }
    setSaving(true);
    setMsg(null);
    try {
      const patch: ProviderUpdatePatch = {
        adapter: adapter.trim(),
        baseUrl: nextBaseUrl,
        defaultModel: defaultModel.trim(),
        authMode,
        note: note.trim(),
        allowPrivateNetwork,
        liveModels,
        fallback: nextFallback,
      };
      if (supportsApiKeyTransport) patch.apiKeyTransport = apiKeyTransport;
      else if (item.apiKeyTransport !== undefined) patch.apiKeyTransport = "";
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

  const discard = () => {
    setAdapter(item.adapter); setBaseUrl(item.baseUrl);
    setDefaultModel(item.defaultModel ?? ""); setAuthMode(initialAuth);
    setApiKeyTransport(item.apiKeyTransport ?? "x-api-key");
    setNote(item.note ?? ""); setAllowPrivateNetwork(item.allowPrivateNetwork ?? false); setLiveModels(item.liveModels !== false);
    setFallback(withRowIds(normalizeFallback(item.fallback)));
    setMsg(null);
    setEndpointChoice(matchChoiceId(baseUrlChoices, item.baseUrl));
  };

  const endpointLabel = (id: string, fallbackLabel: string) => {
    switch (id) {
      case "token-plan": return t("modal.endpoint.tokenPlan");
      case "payg": return t("modal.endpoint.payAsYouGo");
      case "custom": return t("modal.endpoint.custom");
      default: return fallbackLabel;
    }
  };

  const updateFallbackRow = (id: string, patch: Partial<ProviderFallbackTarget>) => {
    setFallback(rows => rows.map(row => row.id === id ? { ...row, ...patch } : row));
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
        <input type="checkbox" checked={liveModels} onChange={e => setLiveModels(e.target.checked)} />
        <span>
          <span className="pwi-settings-label">{t("pws.liveModels")}</span>
          <span className="muted text-label" style={{ display: "block", marginTop: 2 }}>{t("pws.liveModelsDesc")}</span>
        </span>
      </label>

      <div className="pwi-settings-field">
        <span className="pwi-settings-label">{t("pws.fallback")}</span>
        <span className="pwi-settings-hint">{t("pws.fallbackDesc")}</span>
        <div className="pwi-fallback-list">
          {fallback.map((row) => {
            const peer = fallbackPeers.find(p => p.name === row.provider);
            const modelIds = modelsForPeer(peer, row.model);
            return (
              <div key={row.id} className="pwi-fallback-row">
                <select
                  className="input"
                  value={row.provider}
                  aria-label={t("pws.fallback.provider")}
                  onChange={e => {
                    const provider = e.target.value;
                    const first = modelsForPeer(fallbackPeers.find(p => p.name === provider), "")[0] ?? "";
                    updateFallbackRow(row.id, { provider, model: first });
                  }}
                >
                  <option value="">{t("pws.fallback.pickProvider")}</option>
                  {fallbackPeers.map(p => (
                    <option key={p.name} value={p.name}>
                      {p.disabled ? t("pws.fallback.disabled", { name: p.name }) : p.name}
                    </option>
                  ))}
                </select>
                {modelIds.length > 0 ? (
                  <select
                    className="input"
                    value={row.model}
                    disabled={!row.provider}
                    aria-label={t("pws.fallback.model")}
                    onChange={e => updateFallbackRow(row.id, { model: e.target.value })}
                  >
                    <option value="">{t("pws.fallback.pickModel")}</option>
                    {modelIds.map(id => <option key={id} value={id}>{id}</option>)}
                  </select>
                ) : (
                  <input
                    className="input"
                    value={row.model}
                    disabled={!row.provider}
                    placeholder={t("pws.fallback.modelPlaceholder")}
                    aria-label={t("pws.fallback.model")}
                    onChange={e => updateFallbackRow(row.id, { model: e.target.value })}
                  />
                )}
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  aria-label={t("common.remove")}
                  onClick={() => setFallback(rows => rows.filter(r => r.id !== row.id))}
                >
                  <IconTrash width={14} height={14} />
                </button>
              </div>
            );
          })}
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            style={{ alignSelf: "flex-start" }}
            disabled={fallbackPeers.length === 0}
            onClick={() => setFallback(rows => [...rows, ...withRowIds([{ provider: "", model: "" }])])}
          >
            <IconPlus width={14} height={14} /> {t("pws.fallback.add")}
          </button>
        </div>
      </div>

      {dirty && (
        <div className="pwi-settings-sticky-bar">
          <span className="muted">{t("pws.settingsUnsavedBar")}</span>
          <div className="pwi-settings-sticky-bar-actions">
            <button type="button" className="btn btn-ghost btn-sm" onClick={discard} disabled={saving}>{t("pws.discardSettings")}</button>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => void save()} disabled={saving}>{saving ? t("pws.saving") : t("pws.saveSettings")}</button>
          </div>
        </div>
      )}
      {msg && <div className={msg.ok ? "pwi-settings-msg pwi-settings-msg--ok" : "pwi-settings-msg pwi-settings-msg--err"}>{msg.text}</div>}
    </div>
  );
}
