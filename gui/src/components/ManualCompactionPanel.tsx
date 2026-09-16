import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../i18n/shared";
import { Select } from "../ui";
import { createBoundedFetch } from "../bounded-fetch";
import { requireJson, type ModelInfo } from "../pages/dashboard-shared";
import { formatNamespacedModelId } from "../provider-icons";

type Setting = { model: string; reasoningEffort?: string } | null;
const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

function readSetting(payload: { manualCompaction?: unknown }): Setting {
  const value = payload.manualCompaction;
  if (value === null) return null;
  if (!value || typeof value !== "object" || !("model" in value) || typeof value.model !== "string" || !value.model.trim()) {
    throw new Error("invalid settings");
  }
  const effort = "reasoningEffort" in value ? value.reasoningEffort : undefined;
  if (effort !== undefined && (typeof effort !== "string" || !EFFORTS.includes(effort))) throw new Error("invalid effort");
  return { model: value.model, ...(effort ? { reasoningEffort: effort as string } : {}) };
}

export default function ManualCompactionPanel(props: { apiBase: string; models: ModelInfo[] }) {
  return <ManualCompactionControls key={props.apiBase} {...props} />;
}

function ManualCompactionControls({ apiBase, models }: { apiBase: string; models: ModelInfo[] }) {
  const t = useT();
  const [saved, setSaved] = useState<Setting | undefined>(undefined);
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [feedback, setFeedback] = useState<"saved" | "failed" | null>(null);
  const active = useRef(false);
  const pending = useRef<ReturnType<typeof createBoundedFetch> | null>(null);

  const accept = useCallback((value: Setting) => {
    setSaved(value);
    setModel(value?.model ?? "");
    setEffort(value?.reasoningEffort ?? "");
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
        body: JSON.stringify({ manualCompaction: model ? { model, ...(effort ? { reasoningEffort: effort } : {}) } : null }),
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

  const options = [{ value: "", label: t("manualCompact.currentModel") },
    ...[...new Set([...models.map(item => item.namespaced), ...(model ? [model] : [])])]
      .map(value => ({ value, label: formatNamespacedModelId(value, t) }))];
  const disabled = busy || saved === undefined || loadError;
  const dirty = model !== (saved?.model ?? "") || effort !== (saved?.reasoningEffort ?? "");

  return (
    <section className="panel" aria-labelledby="manual-compaction-title" aria-busy={busy || (saved === undefined && !loadError)}>
      <strong id="manual-compaction-title">{t("manualCompact.title")}</strong>
      <p className="card-sub">{t("manualCompact.description")}</p>
      <div className="row" style={{ flexWrap: "wrap", alignItems: "end", gap: 12 }}>
        <div style={{ flex: "1 1 240px", minWidth: 0 }}>
          <label htmlFor="manual-compaction-model" className="card-sub">{t("manualCompact.model")}</label>
          <Select id="manual-compaction-model" value={model} options={options} disabled={disabled}
            style={{ width: "100%" }} label={t("manualCompact.model")}
            onChange={value => { setModel(value); if (!value) setEffort(""); setFeedback(null); }} />
        </div>
        <div style={{ flex: "1 1 200px", minWidth: 0 }}>
          <label htmlFor="manual-compaction-effort" className="card-sub">{t("manualCompact.effort")}</label>
          <Select id="manual-compaction-effort" value={effort} disabled={disabled || !model}
            style={{ width: "100%" }} label={t("manualCompact.effort")}
            options={[{ value: "", label: t("manualCompact.currentEffort") }, ...EFFORTS.map(value => ({ value, label: value }))]}
            onChange={value => { setEffort(value); setFeedback(null); }} />
        </div>
        <button type="button" className="btn btn-primary" disabled={disabled || !dirty} onClick={() => { void save(); }}>
          {busy ? t("common.saving") : t("common.save")}
        </button>
      </div>
      <p className="card-sub">{t("manualCompact.effortHint")}</p>
      {loadError && <div role="alert">{t("manualCompact.loadFailed")} <button type="button" className="btn btn-ghost btn-sm" onClick={() => { void load(); }}>{t("common.retry")}</button></div>}
      {feedback && <div role={feedback === "failed" ? "alert" : "status"}>{t(feedback === "saved" ? "manualCompact.saved" : "manualCompact.saveFailed")}</div>}
    </section>
  );
}
