import { useCallback, useEffect, useRef, useState } from "react";
import { useT, type TKey } from "../i18n/shared";
import { IconAlert } from "../icons";
import { Select } from "../ui";
import { createBoundedFetch } from "../bounded-fetch";
import { requireJson, type ModelInfo } from "../pages/dashboard-shared";
import { formatNamespacedModelId } from "../provider-icons";

type Setting = { model: string; reasoningEffort?: string; triggers?: string[] } | null;
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

function readComboProviders(payload: unknown): Record<string, string[]> {
  const combos = (payload as { combos?: unknown })?.combos;
  if (!Array.isArray(combos)) return {};
  const result: Record<string, string[]> = {};
  for (const combo of combos) {
    if (!combo || typeof combo !== "object" || typeof (combo as { id?: unknown }).id !== "string") continue;
    const targets = (combo as { targets?: unknown }).targets;
    const providers = Array.isArray(targets)
      ? targets.map(target => (target as { provider?: unknown })?.provider).filter((value): value is string => typeof value === "string")
      : [];
    result[(combo as { id: string }).id] = [...new Set(providers)];
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
  if (triggers !== undefined && (!Array.isArray(triggers) || triggers.length === 0
    || !triggers.every(entry => typeof entry === "string" && TRIGGERS.includes(entry))
    || new Set(triggers).size !== triggers.length)) throw new Error("invalid triggers");
  return {
    model: value.model,
    ...(effort ? { reasoningEffort: effort as string } : {}),
    ...(triggers ? { triggers: triggers as string[] } : {}),
  };
}

export default function CompactionRoutingPanel(props: { apiBase: string; models: ModelInfo[] }) {
  return <CompactionRoutingControls key={props.apiBase} {...props} />;
}

function CompactionRoutingControls({ apiBase, models }: { apiBase: string; models: ModelInfo[] }) {
  const t = useT();
  const [saved, setSaved] = useState<Setting | undefined>(undefined);
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [triggers, setTriggers] = useState("manual");
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [feedback, setFeedback] = useState<"saved" | "failed" | null>(null);
  const [comboProviders, setComboProviders] = useState<Record<string, string[]>>({});
  const active = useRef(false);
  const pending = useRef<ReturnType<typeof createBoundedFetch> | null>(null);

  const accept = useCallback((value: Setting) => {
    setSaved(value);
    setModel(value?.model ?? "");
    setEffort(value?.reasoningEffort ?? "");
    setTriggers(triggersToChoice(value?.triggers));
  }, []);

  const load = useCallback(async () => {
    if (pending.current) return;
    const request = createBoundedFetch(15_000);
    pending.current = request;
    setLoadError(false);
    try {
      const response = await fetch(`${apiBase}/api/settings`, { signal: request.signal });
      const value = readSetting(await requireJson(response));
      if (active.current && pending.current === request) accept(value);
      const combos = await fetch(`${apiBase}/api/combos`, { signal: request.signal }).then(requireJson).then(readComboProviders).catch(() => ({}));
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
  const disabled = busy || saved === undefined || loadError;
  const dirty = model !== (saved?.model ?? "")
    || effort !== (saved?.reasoningEffort ?? "")
    || triggers !== triggersToChoice(saved?.triggers);
  const namespace = model.slice(0, Math.max(model.indexOf("/"), 0));
  const combo = namespace === "combo" ? model.slice(namespace.length + 1) : "";
  const provider = namespace && !combo ? namespace : model;
  const providers = comboProviders[combo]?.join(", ") || t("compactionRouting.comboProvidersUnknown");
  const routesAutomatic = triggers !== "manual";

  return (
    <section className="panel" aria-labelledby="compaction-routing-title" aria-busy={busy || (saved === undefined && !loadError)}>
      <div className="spread" style={{ alignItems: "flex-start", flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 20rem", minWidth: 0 }}>
          <div className="font-semibold" id="compaction-routing-title">{t("compactionRouting.title")}</div>
          <div className="muted setting-hint">{t("compactionRouting.description")}</div>
          <div className="muted setting-hint">{t("compactionRouting.dataNotice")}</div>
          <div className="muted setting-hint">{t("compactionRouting.effortHint")}</div>
        </div>
        <div className="dash-delegation-controls" style={{ flex: "0 1 auto" }}>
          <Select id="compaction-routing-model" value={model} options={options} disabled={disabled}
            label={t("compactionRouting.model")}
            onChange={value => { setModel(value); if (!value) { setEffort(""); setTriggers("manual"); } setFeedback(null); }} />
          <Select id="compaction-routing-triggers" value={triggers} disabled={disabled || !model} align="right"
            label={t("compactionRouting.triggers")}
            options={TRIGGER_CHOICES.map(value => ({ value, label: t(TRIGGER_LABELS[value]!) }))}
            onChange={value => { setTriggers(value); setFeedback(null); }} />
          <Select id="compaction-routing-effort" value={effort} disabled={disabled || !model} align="right"
            label={t("compactionRouting.effort")}
            options={[{ value: "", label: t("compactionRouting.currentEffort") }, ...EFFORTS.map(value => ({ value, label: t(`models.reasoningEffort.${value}` as TKey) }))]}
            onChange={value => { setEffort(value); setFeedback(null); }} />
          <button type="button" className="btn btn-primary btn-sm" disabled={disabled || !dirty} onClick={() => { void save(); }}>
            {busy ? t("common.saving") : t("common.save")}
          </button>
        </div>
      </div>
      {provider && <div className="notice-warn" role="note" style={{ marginTop: 12 }}><IconAlert width={14} /> {combo
        ? t("compactionRouting.comboWarning", { combo: model, providers })
        : t("compactionRouting.providerWarning", { provider })}</div>}
      {provider && routesAutomatic && <div className="notice-warn" role="note" style={{ marginTop: 12 }}><IconAlert width={14} /> {t("compactionRouting.autoNotice")}</div>}
      {loadError && <div className="notice notice-err" role="alert" style={{ marginTop: 12, marginBottom: 0 }}>{t("compactionRouting.loadFailed")} <button type="button" className="btn btn-ghost btn-sm" onClick={() => { void load(); }}>{t("common.retry")}</button></div>}
      {feedback === "failed" && <div className="notice notice-err" role="alert" style={{ marginTop: 12, marginBottom: 0 }}>{t("compactionRouting.saveFailed")}</div>}
      {feedback === "saved" && <div className="muted setting-hint" role="status">{t("compactionRouting.saved")}</div>}
    </section>
  );
}
