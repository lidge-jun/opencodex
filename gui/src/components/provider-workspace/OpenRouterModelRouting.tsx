import { useMemo, useRef, useState } from "react";
import { IconArrowDown, IconArrowUp, IconX } from "../../icons";
import { useT } from "../../i18n/shared";
import type { WorkspaceItem } from "../../provider-workspace/catalog";
import type { ProviderUpdatePatch } from "./types";

type Endpoint = { tag: string; providerName: string; supportsImplicitCaching?: boolean };
type Discovery = { endpoints?: Endpoint[]; code?: string; error?: string };
type Mode = "inherit" | "order" | "only";

export default function OpenRouterModelRouting({
  item, apiBase, availableModels, onUpdateProvider,
}: {
  item: WorkspaceItem;
  apiBase: string;
  availableModels: string[];
  onUpdateProvider?: (name: string, patch: ProviderUpdatePatch) => Promise<{ ok: boolean; error?: string }>;
}) {
  const t = useT();
  const configuredModels = Object.keys(item.modelOpenRouterRouting ?? {});
  const [model, setModel] = useState(configuredModels[0] ?? item.defaultModel ?? "");
  const saved = model ? item.modelOpenRouterRouting?.[model] : undefined;
  const savedMode: Mode = saved?.only ? "only" : saved?.order ? "order" : "inherit";
  const savedTags = saved?.only ?? saved?.order ?? [];
  const [mode, setMode] = useState<Mode>(savedMode);
  const [selected, setSelected] = useState<string[]>(savedTags);
  const [allowFallbacks, setAllowFallbacks] = useState(saved?.allowFallbacks ?? true);
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [discoveryComplete, setDiscoveryComplete] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const discoveryGeneration = useRef(0);
  const activeModelRef = useRef(model);
  const modelOptions = useMemo(() => [...new Set([
    ...configuredModels,
    ...(item.defaultModel ? [item.defaultModel] : []),
    ...availableModels.slice(0, 500),
  ])], [availableModels, configuredModels, item.defaultModel]);

  const selectModel = (nextModel: string) => {
    activeModelRef.current = nextModel;
    discoveryGeneration.current += 1;
    setModel(nextModel);
    const route = item.modelOpenRouterRouting?.[nextModel];
    setMode(route?.only ? "only" : route?.order ? "order" : "inherit");
    setSelected(route?.only ?? route?.order ?? []);
    setAllowFallbacks(route?.allowFallbacks ?? true);
    setEndpoints([]);
    setDiscoveryComplete(false);
    setLoading(false);
    setMessage(null);
  };

  const load = async (refresh = false) => {
    const requestedModel = model.trim();
    if (!requestedModel || loading) return;
    const generation = ++discoveryGeneration.current;
    setLoading(true);
    setDiscoveryComplete(false);
    setMessage(null);
    try {
      const response = await fetch(`${apiBase}/api/openrouter/model-providers?provider=${encodeURIComponent(item.name)}&model=${encodeURIComponent(requestedModel)}${refresh ? "&refresh=1" : ""}`);
      if (generation !== discoveryGeneration.current) return;
      if (!response.ok) {
        const data = await response.json().catch(() => ({})) as Discovery;
        const text = data.code === "openrouter_authorization_failed"
          ? t("pws.openrouter.authorizationFailed")
          : data.code === "openrouter_key_required"
            ? t("pws.openrouter.keyRequired")
            : t("pws.openrouter.loadFailed");
        throw new Error(text);
      }
      const data = await response.json().catch(() => ({})) as Discovery;
      if (generation !== discoveryGeneration.current) return;
      setEndpoints(Array.isArray(data.endpoints) ? data.endpoints : []);
      setDiscoveryComplete(true);
      setMessage({ ok: true, text: t("pws.openrouter.loaded", { count: data.endpoints?.length ?? 0 }) });
    } catch (error) {
      if (generation !== discoveryGeneration.current) return;
      setEndpoints([]);
      setDiscoveryComplete(false);
      setMessage({ ok: false, text: error instanceof Error ? error.message : t("pws.openrouter.loadFailed") });
    } finally {
      if (generation === discoveryGeneration.current) setLoading(false);
    }
  };

  const toggle = (tag: string) => setSelected(current => current.includes(tag)
    ? current.filter(value => value !== tag)
    : [...current, tag]);
  const remove = (tag: string) => setSelected(current => current.filter(value => value !== tag));
  const move = (index: number, direction: -1 | 1) => setSelected(current => {
    const target = index + direction;
    if (target < 0 || target >= current.length) return current;
    const next = [...current];
    [next[index], next[target]] = [next[target]!, next[index]!];
    return next;
  });

  const save = async () => {
    const requestedModel = model.trim();
    if (!onUpdateProvider || !requestedModel || saving || (mode !== "inherit" && selected.length === 0)) return;
    setSaving(true);
    setMessage(null);
    const routing = mode === "inherit" ? null : {
      [mode]: selected,
      allowFallbacks,
    };
    try {
      const result = await onUpdateProvider(item.name, {
        modelOpenRouterRouting: { [requestedModel]: routing },
      });
      if (activeModelRef.current.trim() === requestedModel) {
        setMessage({ ok: result.ok, text: result.ok ? t("pws.openrouter.saved") : result.error ?? t("sub.saveFailed") });
      }
    } catch {
      if (activeModelRef.current.trim() === requestedModel) setMessage({ ok: false, text: t("sub.saveFailed") });
    } finally {
      setSaving(false);
    }
  };

  const knownTags = new Set(endpoints.map(endpoint => endpoint.tag));
  const selectedTags = useMemo(() => new Set(selected), [selected]);
  return (
    <section className="pwi-openrouter-routing" aria-labelledby={`openrouter-routing-${item.name}`}>
      <div className="pwi-openrouter-head">
        <div>
          <h3 id={`openrouter-routing-${item.name}`}>{t("pws.openrouter.title")}</h3>
          <p>{t("pws.openrouter.hint")}</p>
        </div>
      </div>
      <div className="pwi-openrouter-model-row">
        <label className="pwi-settings-field">
          <span className="pwi-settings-label">{t("pws.pacingModel")}</span>
          <input className="input" list={`openrouter-models-${item.name}`} value={model} onChange={event => selectModel(event.target.value)} />
          <datalist id={`openrouter-models-${item.name}`}>{modelOptions.map(value => <option key={value} value={value} />)}</datalist>
        </label>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => { void load(false); }} disabled={!model.trim() || loading}>
          {loading ? t("models.loading") : t("pws.openrouter.load")}
        </button>
      </div>
      <div className="pwi-openrouter-controls">
        <label className="pwi-settings-field">
          <span className="pwi-settings-label">{t("pws.openrouter.mode")}</span>
          <select className="input" value={mode} onChange={event => setMode(event.target.value as Mode)} disabled={saving}>
            <option value="inherit">{t("pws.openrouter.inherit")}</option>
            <option value="order">{t("pws.openrouter.order")}</option>
            <option value="only">{t("pws.openrouter.only")}</option>
          </select>
        </label>
        {mode !== "inherit" && (
          <label className="pwi-openrouter-fallbacks">
            <input type="checkbox" checked={allowFallbacks} onChange={event => setAllowFallbacks(event.target.checked)} disabled={saving} />
            <span>{t("pws.openrouter.allowFallbacks")}</span>
          </label>
        )}
      </div>
      {mode !== "inherit" && selected.length > 0 && (
        <ol className="pwi-openrouter-selected">
          {selected.map((tag, index) => (
            <li key={tag} className={discoveryComplete && !knownTags.has(tag) ? "pwi-openrouter-missing" : ""}>
              <code>{tag}</code>
              {discoveryComplete && !knownTags.has(tag) && <span>{t("pws.openrouter.notReturned")}</span>}
              <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={() => move(index, -1)} disabled={saving || index === 0} aria-label={t("sub.moveUp", { m: tag })}><IconArrowUp /></button>
              <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={() => move(index, 1)} disabled={saving || index === selected.length - 1} aria-label={t("sub.moveDown", { m: tag })}><IconArrowDown /></button>
              <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={() => remove(tag)} disabled={saving} aria-label={t("sub.removeAria", { m: tag })}><IconX /></button>
            </li>
          ))}
        </ol>
      )}
      {endpoints.length > 0 && mode !== "inherit" && (
        <div className="pwi-openrouter-endpoints">
          {endpoints.map(endpoint => (
            <label key={endpoint.tag} className="pwi-openrouter-endpoint">
              <input type="checkbox" checked={selectedTags.has(endpoint.tag)} onChange={() => toggle(endpoint.tag)} disabled={saving} />
              <span><strong>{endpoint.providerName}</strong><code>{endpoint.tag}</code></span>
              {endpoint.supportsImplicitCaching && <span className="badge badge-muted">{t("pws.openrouter.cache")}</span>}
            </label>
          ))}
        </div>
      )}
      <div className="pwi-openrouter-actions">
        <button type="button" className="btn btn-primary btn-sm" onClick={() => { void save(); }} disabled={!onUpdateProvider || !model.trim() || saving || (mode !== "inherit" && selected.length === 0)}>
          {saving ? t("pws.saving") : t("common.save")}
        </button>
        {discoveryComplete && <button type="button" className="btn btn-ghost btn-sm" onClick={() => { void load(true); }} disabled={loading}>{t("lab.refresh")}</button>}
      </div>
      {message && <p role={message.ok ? "status" : "alert"} className={message.ok ? "pwi-settings-mode-msg pwi-settings-mode-msg--ok" : "pwi-settings-mode-msg pwi-settings-mode-msg--err"}>{message.text}</p>}
    </section>
  );
}
