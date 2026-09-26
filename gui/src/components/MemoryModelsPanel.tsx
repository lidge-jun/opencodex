import { useCallback, useEffect, useRef, useState } from "react";
import { useT, type TKey } from "../i18n/shared";
import { IconAlert } from "../icons";
import { Select, Tooltip } from "../ui";
import { createBoundedFetch } from "../bounded-fetch";
import { requireJson, type ModelInfo } from "../pages/dashboard-shared";
import { formatNamespacedModelId } from "../provider-icons";

type Phase = "extract" | "consolidation";
interface PhaseSetting { model?: string; reasoningEffort?: string }
type Settings = { extract?: PhaseSetting; consolidation?: PhaseSetting };

const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

/**
 * Read the persisted phases. A phase without a model is "Off", so it is dropped rather than kept
 * as an empty row: that is also the shape the PUT sends back for it.
 */
function readSettings(payload: { memoryModels?: unknown }): Settings {
  const value = payload.memoryModels;
  if (value == null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid settings");
  const out: Settings = {};
  for (const phase of ["extract", "consolidation"] as const) {
    const raw = (value as Record<string, unknown>)[phase];
    if (raw === undefined) continue;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid phase");
    const model = "model" in raw && typeof raw.model === "string" ? raw.model.trim() : "";
    if (!model) throw new Error("invalid model");
    const effort = "reasoningEffort" in raw ? raw.reasoningEffort : undefined;
    if (effort !== undefined && (typeof effort !== "string" || !EFFORTS.includes(effort))) throw new Error("invalid effort");
    out[phase] = { model, ...(effort ? { reasoningEffort: effort } : {}) };
  }
  return out;
}

export default function MemoryModelsPanel(props: { apiBase: string; models: ModelInfo[] }) {
  return <MemoryModelsControls key={props.apiBase} {...props} />;
}

function MemoryModelsControls({ apiBase, models }: { apiBase: string; models: ModelInfo[] }) {
  const t = useT();
  const [saved, setSaved] = useState<Settings | undefined>(undefined);
  const [extractModel, setExtractModel] = useState("");
  const [extractEffort, setExtractEffort] = useState("");
  const [consolidationModel, setConsolidationModel] = useState("");
  const [consolidationEffort, setConsolidationEffort] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [feedback, setFeedback] = useState<"saved" | "failed" | null>(null);
  const active = useRef(false);
  const pending = useRef<ReturnType<typeof createBoundedFetch> | null>(null);

  const accept = useCallback((value: Settings) => {
    setSaved(value);
    setExtractModel(value.extract?.model ?? "");
    setExtractEffort(value.extract?.reasoningEffort ?? "");
    setConsolidationModel(value.consolidation?.model ?? "");
    setConsolidationEffort(value.consolidation?.reasoningEffort ?? "");
  }, []);

  const load = useCallback(async () => {
    if (pending.current) return;
    const request = createBoundedFetch(15_000);
    pending.current = request;
    setLoadError(false);
    try {
      const response = await fetch(`${apiBase}/api/settings`, { signal: request.signal });
      const value = readSettings(await requireJson(response));
      if (active.current && pending.current === request) accept(value);
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

  const phasePayload = (model: string, effort: string) => (model
    ? { model, ...(effort ? { reasoningEffort: effort } : {}) }
    : undefined);

  const save = async () => {
    if (pending.current || saved === undefined) return;
    const request = createBoundedFetch(15_000);
    pending.current = request;
    setBusy(true);
    setFeedback(null);
    const extract = phasePayload(extractModel, extractEffort);
    const consolidation = phasePayload(consolidationModel, consolidationEffort);
    try {
      const response = await fetch(`${apiBase}/api/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // Null clears the whole block; a phase left at "Off" is simply absent.
          memoryModels: extract || consolidation
            ? { ...(extract ? { extract } : {}), ...(consolidation ? { consolidation } : {}) }
            : null,
        }),
        signal: request.signal,
      });
      const value = readSettings(await requireJson(response));
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

  const options = [{ value: "", label: t("memoryModels.off") },
    ...[...new Set([...models.map(item => item.namespaced),
      ...[extractModel, consolidationModel].filter(Boolean)])]
      .map(value => ({ value, label: formatNamespacedModelId(value, t) }))];
  const effortOptions = [{ value: "", label: t("memoryModels.defaultEffort") },
    ...EFFORTS.map(value => ({ value, label: t(`models.reasoningEffort.${value}` as TKey) }))];
  const disabled = busy || saved === undefined || loadError;
  const dirty = extractModel !== (saved?.extract?.model ?? "")
    || extractEffort !== (saved?.extract?.reasoningEffort ?? "")
    || consolidationModel !== (saved?.consolidation?.model ?? "")
    || consolidationEffort !== (saved?.consolidation?.reasoningEffort ?? "");
  const info = t("memoryModels.info");

  const row = (phase: Phase, model: string, effort: string, setModel: (value: string) => void, setEffort: (value: string) => void) => (
    <div className="spread" style={{ alignItems: "flex-start", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
      <div style={{ flex: "1 1 18rem", minWidth: 0 }}>
        <div className="font-semibold">{t(`memoryModels.${phase}` as TKey)}</div>
        <div className="muted setting-hint">{t(`memoryModels.${phase}Hint` as TKey)}</div>
      </div>
      <div className="dash-delegation-controls" style={{ flex: "0 1 auto" }}>
        <Select id={`memory-models-${phase}`} value={model} options={options} disabled={disabled}
          label={t("memoryModels.model")}
          onChange={value => { setModel(value); if (!value) setEffort(""); setFeedback(null); }} />
        <Select id={`memory-models-${phase}-effort`} value={effort} options={effortOptions}
          disabled={disabled || !model} align="right" label={t("memoryModels.effort")}
          onChange={value => { setEffort(value); setFeedback(null); }} />
      </div>
    </div>
  );

  return (
    <section className="panel" aria-labelledby="memory-models-title" aria-busy={busy || (saved === undefined && !loadError)}>
      <div className="font-semibold" id="memory-models-title">
        {t("memoryModels.title")}{" "}
        <Tooltip content={info} side="top" maxWidth={360}>
          <span style={{ cursor: "help" }} aria-label={t("memoryModels.infoLabel")} role="img">ⓘ</span>
        </Tooltip>
      </div>
      <div className="muted setting-hint">{t("memoryModels.description")}</div>
      {row("extract", extractModel, extractEffort, setExtractModel, setExtractEffort)}
      {row("consolidation", consolidationModel, consolidationEffort, setConsolidationModel, setConsolidationEffort)}
      <div className="spread" style={{ alignItems: "center", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
        <div className="muted setting-hint" style={{ flex: "1 1 18rem", minWidth: 0 }}>{t("memoryModels.dataNotice")}</div>
        <button type="button" className="btn btn-primary btn-sm" disabled={disabled || !dirty} onClick={() => { void save(); }}>
          {busy ? t("common.saving") : t("common.save")}
        </button>
      </div>
      {(extractModel || consolidationModel) && <div className="notice-warn" role="note" style={{ marginTop: 12 }}>
        <IconAlert width={14} /> {t("memoryModels.accountNotice")}
      </div>}
      {loadError && <div className="notice notice-err" role="alert" style={{ marginTop: 12, marginBottom: 0 }}>{t("memoryModels.loadFailed")} <button type="button" className="btn btn-ghost btn-sm" onClick={() => { void load(); }}>{t("common.retry")}</button></div>}
      {feedback === "failed" && <div className="notice notice-err" role="alert" style={{ marginTop: 12, marginBottom: 0 }}>{t("memoryModels.saveFailed")}</div>}
      {feedback === "saved" && <div className="muted setting-hint" role="status">{t("memoryModels.saved")}</div>}
    </section>
  );
}

