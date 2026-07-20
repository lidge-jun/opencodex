/**
 * ProviderSettings — adapter/baseUrl/defaultModel/authMode/note editing form
 * for the workspace Settings tab (WP091). Uses PATCH /api/providers via an
 * onUpdateProvider prop; no direct fetch.
 */
import { useEffect, useMemo, useState } from "react";
import { baseUrlForChoice, matchChoiceId } from "../../base-url-choice";
import { useT } from "../../i18n";
import { IconLock } from "../../icons";
import { isCatalogProviderId } from "../../provider-icons";
import type { CatalogPreset } from "../provider-catalog/provider-presets";
import { authModeLabel } from "./ProviderRail";
import type { WorkspaceItem, ProviderUpdatePatch } from "./types";

const ADAPTERS = ["openai-responses", "openai-chat", "anthropic", "google", "azure-openai", "cursor"] as const;

export default function ProviderSettings({
  item, availableModels = [], apiBase, onUpdateProvider, onDirtyChange,
}: {
  item: WorkspaceItem;
  availableModels?: string[];
  /** When set, load endpoint choices for catalog providers that expose baseUrlChoices. */
  apiBase?: string;
  onUpdateProvider?: (name: string, patch: ProviderUpdatePatch) => Promise<{ ok: boolean; error?: string }>;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const t = useT();
  const initialAuth = String(item.authMode ?? (item.keyOptional ? "local" : "key"));
  const [adapter, setAdapter] = useState(item.adapter);
  const [baseUrl, setBaseUrl] = useState(item.baseUrl);
  const [defaultModel, setDefaultModel] = useState(item.defaultModel ?? "");
  const [authMode, setAuthMode] = useState(initialAuth);
  const [note, setNote] = useState(item.note ?? "");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [baseUrlChoices, setBaseUrlChoices] = useState<CatalogPreset["baseUrlChoices"]>();
  const [endpointChoice, setEndpointChoice] = useState("custom");

  /* eslint-disable react-hooks/set-state-in-effect -- intentional form reset on provider switch */
  useEffect(() => {
    setAdapter(item.adapter);
    setBaseUrl(item.baseUrl);
    setDefaultModel(item.defaultModel ?? "");
    setAuthMode(String(item.authMode ?? (item.keyOptional ? "local" : "key")));
    setNote(item.note ?? "");
    setMsg(null);
  }, [item.name, item.adapter, item.baseUrl, item.defaultModel, item.authMode, item.keyOptional, item.note]);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    if (!apiBase) {
      setBaseUrlChoices(undefined);
      return;
    }
    let cancelled = false;
    fetch(`${apiBase}/api/provider-presets`)
      .then(r => r.json())
      .then((d: { providers?: CatalogPreset[] }) => {
        if (cancelled) return;
        const preset = (d.providers ?? []).find(p => p.id === item.name);
        const choices = preset?.baseUrlChoices;
        setBaseUrlChoices(choices);
        setEndpointChoice(matchChoiceId(choices, item.baseUrl));
      })
      .catch(() => {
        if (!cancelled) setBaseUrlChoices(undefined);
      });
    return () => { cancelled = true; };
  }, [apiBase, item.name, item.baseUrl]);

  const dirty = adapter.trim() !== item.adapter
    || baseUrl.trim() !== item.baseUrl
    || defaultModel.trim() !== (item.defaultModel ?? "")
    || authMode !== String(item.authMode ?? (item.keyOptional ? "local" : "key"))
    || note.trim() !== (item.note ?? "");

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

  const isPreset = isCatalogProviderId(item.name);
  const hasEndpointPicker = !!(baseUrlChoices && baseUrlChoices.length > 0);
  const baseUrlLocked = isPreset && !hasEndpointPicker;

  const save = async () => {
    if (!onUpdateProvider) { setMsg({ ok: false, text: t("pws.updatesUnavailable") }); return; }
    if (!adapter.trim() || !baseUrl.trim()) { setMsg({ ok: false, text: t("pws.adapterBaseRequired") }); return; }
    setSaving(true); setMsg(null);
    const patch: ProviderUpdatePatch = { adapter: adapter.trim(), baseUrl: baseUrl.trim(), defaultModel: defaultModel.trim(), authMode, note: note.trim() };
    const res = await onUpdateProvider(item.name, patch);
    setSaving(false);
    setMsg(res.ok ? { ok: true, text: t("pws.settingsSaved") } : { ok: false, text: res.error || t("prov.saveFailed") });
  };

  const discard = () => {
    setAdapter(item.adapter); setBaseUrl(item.baseUrl);
    setDefaultModel(item.defaultModel ?? ""); setAuthMode(initialAuth);
    setNote(item.note ?? ""); setMsg(null);
    setEndpointChoice(matchChoiceId(baseUrlChoices, item.baseUrl));
  };

  const endpointLabel = (id: string, fallback: string) => {
    if (id === "token-plan") return t("modal.endpoint.tokenPlan");
    if (id === "payg") return t("modal.endpoint.payAsYouGo");
    if (id === "custom") return t("modal.endpoint.custom");
    return fallback;
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
          <input className="input" value={baseUrl} onChange={e => setBaseUrl(e.target.value)} readOnly={baseUrlLocked} disabled={baseUrlLocked} />
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
      <label className="pwi-settings-field">
        <span className="pwi-settings-label">{t("pws.note")}</span>
        <textarea className="input pwi-settings-textarea" value={note} onChange={e => setNote(e.target.value)} rows={2} />
      </label>
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
