import { useCallback, useEffect, useRef, useState } from "react";
import { useT, type TKey } from "../i18n/shared";
import { IconAlert } from "../icons";
import { Select } from "../ui";
import { createBoundedFetch } from "../bounded-fetch";
import { requireJson, type ModelInfo } from "../pages/dashboard-shared";
import { comboModelId, parseComboList } from "../combo-workspace-data";
import { formatNamespacedModelId } from "../provider-icons";

type Setting = { model: string; reasoningEffort?: string; triggers?: string[]; sourceModels?: string[] } | null;
const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
const TRIGGERS = ["manual", "auto"];
/**
 * One picker over the two trigger sets the config allows. "manual" is sent as an omitted
 * `triggers`, so the default save keeps the exact payload the manual-only override used.
 */
const TRIGGER_CHOICES = ["manual", "manual+auto", "auto"] as const;
const TRIGGER_LABELS: Record<string, TKey> = {
  "manual": "compactionRouting.triggersManual",
  "manual+auto": "compactionRouting.triggersBoth",
  "auto": "compactionRouting.triggersAuto",
};
/**
 * "all" is sent as an omitted `sourceModels`, so the default save keeps the exact payload the
 * unscoped override used. `selected` requires at least one checked selector: the config schema
 * rejects an empty list and would silently drop the whole override.
 */
const SCOPE_CHOICES = ["all", "selected"] as const;
const SCOPE_LABELS: Record<string, TKey> = {
  "all": "compactionRouting.sourcesAll",
  "selected": "compactionRouting.sourcesSelected",
};

function triggersToChoice(value: string[] | undefined): string {
  if (!value) return "manual";
  const auto = value.includes("auto");
  return value.includes("manual") ? (auto ? "manual+auto" : "manual") : (auto ? "auto" : "manual");
}

function choiceToTriggers(choice: string): string[] | undefined {
  if (choice === "auto") return ["auto"];
  if (choice === "manual+auto") return ["manual", "auto"];
  return undefined;
}

/**
 * Target providers keyed by the selector a client actually requests.
 *
 * Keyed by the combo's public model id rather than its raw id, because a combo reached through
 * an alias carries no `combo/` prefix: the panel used to test for that prefix, fail to
 * recognize an aliased combo, and describe it as an ordinary provider while naming none of its
 * targets (#5216). `parseComboList` is the same reader the combo workspace uses, so the
 * selector rule lives in one place instead of being spelled out again here.
 */
function readComboProviders(payload: unknown): Map<string, string[]> {
  // A Map, not an object: the key is a combo's public model id, which is caller-configured and
  // free-form. Writing that into an object literal is a prototype-pollution sink, and reading it
  // back would return an inherited member for an alias of `constructor` or `toString`.
  const result = new Map<string, string[]>();
  for (const combo of parseComboList(payload)) {
    result.set(combo.model, [...new Set(combo.targets.flatMap(target => target.provider ? [target.provider] : []))]);
  }
  return result;
}

function readSetting(payload: { compactionRouting?: unknown }): Setting {
  const value = payload.compactionRouting;
  if (value == null) return null;
  if (!value || typeof value !== "object" || !("model" in value) || typeof value.model !== "string" || !value.model.trim()) {
    throw new Error("invalid settings");
  }
  const effort = "reasoningEffort" in value ? value.reasoningEffort : undefined;
  if (effort !== undefined && (typeof effort !== "string" || !EFFORTS.includes(effort))) throw new Error("invalid effort");
  const triggers = "triggers" in value ? value.triggers : undefined;
  const sourceModels = "sourceModels" in value ? value.sourceModels : undefined;
  if (sourceModels !== undefined && (!Array.isArray(sourceModels) || !sourceModels.length
    || !sourceModels.every(entry => typeof entry === "string" && entry.trim()))) throw new Error("invalid sourceModels");
  if (triggers !== undefined && (!Array.isArray(triggers) || triggers.length === 0
    || !triggers.every(entry => typeof entry === "string" && TRIGGERS.includes(entry))
    || new Set(triggers).size !== triggers.length)) throw new Error("invalid triggers");
  return {
    model: value.model,
    ...(effort ? { reasoningEffort: effort as string } : {}),
    ...(triggers ? { triggers: triggers as string[] } : {}),
    ...(sourceModels ? { sourceModels: sourceModels as string[] } : {}),
  };
}

/** A provider name says who is configured; the endpoint host says where bytes actually go. */
function hostOf(baseUrl: string): string {
  if (!baseUrl) return "";
  try {
    return new URL(baseUrl).hostname || baseUrl;
  } catch {
    return baseUrl;
  }
}

function endpointLabel(name: string, hosts: ReadonlyMap<string, string>): string {
  const host = hosts.get(name);
  return host ? `${name} (${host})` : name;
}

export default function CompactionRoutingPanel(props: { apiBase: string; models: ModelInfo[]; providers?: Array<{ name: string; baseUrl: string }> }) {
  return <CompactionRoutingControls key={props.apiBase} {...props} />;
}

function CompactionRoutingControls({ apiBase, models, providers: providerList = [] }: { apiBase: string; models: ModelInfo[]; providers?: Array<{ name: string; baseUrl: string }> }) {
  const t = useT();
  const [saved, setSaved] = useState<Setting | undefined>(undefined);
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [triggers, setTriggers] = useState("manual");
  const [scope, setScope] = useState("all");
  const [sources, setSources] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [feedback, setFeedback] = useState<"saved" | "failed" | null>(null);
  const [comboProviders, setComboProviders] = useState<Map<string, string[]>>(() => new Map());
  const active = useRef(false);
  const pending = useRef<ReturnType<typeof createBoundedFetch> | null>(null);

  const accept = useCallback((value: Setting) => {
    setSaved(value);
    setModel(value?.model ?? "");
    setEffort(value?.reasoningEffort ?? "");
    setTriggers(triggersToChoice(value?.triggers));
    setScope(value?.sourceModels ? "selected" : "all");
    setSources(value?.sourceModels ?? []);
  }, []);

  const toggleSource = (selector: string) => {
    setSources(current => current.includes(selector)
      ? current.filter(entry => entry !== selector)
      : [...current, selector]);
    setFeedback(null);
  };

  const load = useCallback(async () => {
    if (pending.current) return;
    const request = createBoundedFetch(15_000);
    pending.current = request;
    setLoadError(false);
    try {
      const response = await fetch(`${apiBase}/api/settings`, { signal: request.signal });
      const value = readSetting(await requireJson(response));
      if (active.current && pending.current === request) accept(value);
      const combos = await fetch(`${apiBase}/api/combos`, { signal: request.signal })
        .then(requireJson).then(readComboProviders).catch(() => new Map<string, string[]>());
      if (active.current && pending.current === request) setComboProviders(combos);
    } catch {
      if (active.current && pending.current === request) setLoadError(true);
    } finally {
      request.clear();
      if (pending.current === request) pending.current = null;
    }
  }, [apiBase, accept]);

  useEffect(() => {
    active.current = true;
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => {
      window.clearTimeout(timer);
      active.current = false;
      pending.current?.controller.abort();
      pending.current?.clear();
      pending.current = null;
    };
  }, [load]);

  const save = async () => {
    if (pending.current || saved === undefined) return;
    const request = createBoundedFetch(15_000);
    pending.current = request;
    setBusy(true);
    setFeedback(null);
    try {
      const response = await fetch(`${apiBase}/api/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          compactionRouting: model
            ? {
              model,
              ...(effort ? { reasoningEffort: effort } : {}),
              ...(choiceToTriggers(triggers) ? { triggers: choiceToTriggers(triggers) } : {}),
              ...(scope === "selected" && sources.length > 0 ? { sourceModels: sources } : {}),
            }
            : null,
        }),
        signal: request.signal,
      });
      const value = readSetting(await requireJson(response));
      if (active.current && pending.current === request) {
        accept(value);
        setFeedback("saved");
      }
    } catch {
      if (active.current && pending.current === request) setFeedback("failed");
    } finally {
      request.clear();
      if (active.current && pending.current === request) setBusy(false);
      if (pending.current === request) pending.current = null;
    }
  };

  const options = [{ value: "", label: t("compactionRouting.currentModel") },
    ...[...new Set([...models.map(item => item.namespaced), ...(model ? [model] : [])])]
      .map(value => ({ value, label: formatNamespacedModelId(value, t) }))];
  const providerWildcards = [...new Set(models.map(item => item.provider).filter(Boolean))].map(provider => `${provider}/*`);
  const knownSelectors = new Set([...providerWildcards, ...models.map(item => item.namespaced)]);
  // Saved selectors the catalog no longer lists stay visible, so saving never drops them by
  // omission and the operator removes them deliberately.
  const savedOnlySelectors = (saved?.sourceModels ?? []).filter(selector => !knownSelectors.has(selector));
  const disabled = busy || saved === undefined || loadError;
  const savedScope = saved?.sourceModels ? "selected" : "all";
  const dirty = model !== (saved?.model ?? "")
    || effort !== (saved?.reasoningEffort ?? "")
    || triggers !== triggersToChoice(saved?.triggers)
    || scope !== savedScope
    || (scope === "selected"
      && (sources.length !== (saved?.sourceModels?.length ?? 0)
        || sources.some(selector => !saved?.sourceModels?.includes(selector))));
  const scopeEmpty = scope === "selected" && sources.length === 0;
  const sourceRow = (selector: string) => (
    <label key={selector}>
      <input type="checkbox" checked={sources.includes(selector)} disabled={disabled}
        onChange={() => { toggleSource(selector); }} />
      <span>{selector}</span>
    </label>
  );
  // Ask what the selection resolves to instead of reading its name. An aliased combo answers
  // here exactly like a prefixed one (#5216).
  const comboTargets = comboProviders.get(model);
  // The canonical prefix stays a combo signal of its own. It is the only one left when
  // /api/combos has not answered yet or failed, and losing it there would describe a combo as
  // an ordinary provider named "combo" — worse than the alias gap this fixes.
  const isCombo = comboTargets !== undefined || model.startsWith(comboModelId(""));
  const namespace = model.slice(0, Math.max(model.indexOf("/"), 0));
  const endpointHosts = new Map(providerList.map(entry => [entry.name, hostOf(entry.baseUrl)] as const).filter(([, host]) => host));
  const provider = isCombo ? "" : endpointLabel(namespace || model, endpointHosts);
  const providers = comboTargets?.map(name => endpointLabel(name, endpointHosts)).join(", ") || t("compactionRouting.comboProvidersUnknown");
  const routesAutomatic = triggers !== "manual";
  const scopedSources = sources.join(", ");
  // A scoped override only covers the checked sources, so the disclosure names them instead of
  // claiming every request; an empty selection covers nothing and shows no destination claim.
  const warningText = !model || scopeEmpty ? null
    : isCombo
      ? (scope === "selected"
        ? t("compactionRouting.comboWarningScoped", { combo: model, providers, sources: scopedSources })
        : t("compactionRouting.comboWarning", { combo: model, providers }))
      : (scope === "selected"
        ? t("compactionRouting.providerWarningScoped", { provider, sources: scopedSources })
        : t("compactionRouting.providerWarning", { provider }));

  return (
    <section className="panel" aria-labelledby="compaction-routing-title" aria-busy={busy || (saved === undefined && !loadError)}>
      <div className="spread" style={{ alignItems: "flex-start", flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 20rem", minWidth: 0 }}>
          <div className="font-semibold" id="compaction-routing-title">{t("compactionRouting.title")}</div>
          <div className="muted setting-hint">{t("compactionRouting.description")}</div>
          <div className="muted setting-hint">{t("compactionRouting.dataNotice")}</div>
          <div className="muted setting-hint">{t("compactionRouting.effortHint")}</div>
          <div className="muted setting-hint">{t("compactionRouting.sourcesHint")}</div>
        </div>
        <div className="dash-delegation-controls compaction-routing-controls" style={{ flex: "0 1 auto" }}>
          <div className="compaction-field">
            <label className="field-label" htmlFor="compaction-routing-model">{t("compactionRouting.model")}</label>
            <Select id="compaction-routing-model" value={model} options={options} disabled={disabled}
              label={t("compactionRouting.model")}
              onChange={value => { setModel(value); if (!value) { setEffort(""); setTriggers("manual"); setScope("all"); setSources([]); } setFeedback(null); }} />
          </div>
          <div className="compaction-field">
            <label className="field-label" htmlFor="compaction-routing-triggers">{t("compactionRouting.triggers")}</label>
            <Select id="compaction-routing-triggers" value={triggers} disabled={disabled || !model} align="right"
              label={t("compactionRouting.triggers")}
              options={TRIGGER_CHOICES.map(value => ({ value, label: t(TRIGGER_LABELS[value]!) }))}
              onChange={value => { setTriggers(value); setFeedback(null); }} />
          </div>
          <div className="compaction-field">
            <label className="field-label" htmlFor="compaction-routing-sources">{t("compactionRouting.sources")}</label>
            <Select id="compaction-routing-sources" value={scope} disabled={disabled || !model} align="right"
              label={t("compactionRouting.sources")}
              options={SCOPE_CHOICES.map(value => ({ value, label: t(SCOPE_LABELS[value]!) }))}
              onChange={value => { setScope(value); setFeedback(null); }} />
          </div>
          <div className="compaction-field">
            <label className="field-label" htmlFor="compaction-routing-effort">{t("compactionRouting.effort")}</label>
            <Select id="compaction-routing-effort" value={effort} disabled={disabled || !model} align="right"
              label={t("compactionRouting.effort")}
              options={[{ value: "", label: t("compactionRouting.currentEffort") }, ...EFFORTS.map(value => ({ value, label: t(`models.reasoningEffort.${value}` as TKey) }))]}
              onChange={value => { setEffort(value); setFeedback(null); }} />
          </div>
          <button type="button" className="btn btn-primary btn-sm" disabled={disabled || !dirty || scopeEmpty} onClick={() => { void save(); }}>
            {busy ? t("common.saving") : t("common.save")}
          </button>
        </div>
      </div>
      {model && scope === "selected" && <div className="compaction-sources-block">
        <div className="field-label compaction-sources-title">{t("compactionRouting.sourcesGridTitle")}</div>
        <div className="source-scope-groups">
          {providerWildcards.length > 0 && <fieldset className="source-scope-group">
            <legend className="field-label">{t("compactionRouting.sourcesProviders")}</legend>
            {providerWildcards.map(sourceRow)}
          </fieldset>}
          {models.length > 0 && <fieldset className="source-scope-group">
            <legend className="field-label">{t("compactionRouting.sourcesModels")}</legend>
            {models.map(item => item.namespaced).map(sourceRow)}
          </fieldset>}
          {savedOnlySelectors.length > 0 && <fieldset className="source-scope-group">
            <legend className="field-label">{t("compactionRouting.sourcesSaved")}</legend>
            {savedOnlySelectors.map(sourceRow)}
          </fieldset>}
          {scopeEmpty && <div className="muted setting-hint">{t("compactionRouting.sourcesNone")}</div>}
        </div>
      </div>}
      {warningText && <div className="notice-warn" role="note" style={{ marginTop: 12 }}><IconAlert width={14} /> {warningText}</div>}
      {model && routesAutomatic && <div className="notice-warn" role="note" style={{ marginTop: 12 }}><IconAlert width={14} /> {t("compactionRouting.autoNotice")}</div>}
      {loadError && <div className="notice notice-err" role="alert" style={{ marginTop: 12, marginBottom: 0 }}>{t("compactionRouting.loadFailed")} <button type="button" className="btn btn-ghost btn-sm" onClick={() => { void load(); }}>{t("common.retry")}</button></div>}
      {feedback === "failed" && <div className="notice notice-err" role="alert" style={{ marginTop: 12, marginBottom: 0 }}>{t("compactionRouting.saveFailed")}</div>}
      {feedback === "saved" && <div className="muted setting-hint" role="status">{t("compactionRouting.saved")}</div>}
    </section>
  );
}
