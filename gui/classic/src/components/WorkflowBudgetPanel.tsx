import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../i18n/shared";
import { createBoundedFetch } from "../bounded-fetch";
import { clampNumberDraft } from "../clamp-draft";
import { requireJson } from "../pages/dashboard-shared";
import { NumberStepper } from "./NumberStepper";

const KEYS = ["maxConcurrentChildren", "maxPhysicalSends", "maxDistinctChildren"] as const;
type Key = typeof KEYS[number];
type Values = Record<Key, number>;
type Drafts = Record<Key, string>;
interface Settings {
  values: Values;
  defaults: Values;
  bounds: Record<Key, { min: number; max: number }>;
  windowMinutes: number;
}

const LABEL_KEYS = {
  maxConcurrentChildren: ["workflowBudget.maxConcurrentChildren", "workflowBudget.maxConcurrentChildrenHint"],
  maxPhysicalSends: ["workflowBudget.maxPhysicalSends", "workflowBudget.maxPhysicalSendsHint"],
  maxDistinctChildren: ["workflowBudget.maxDistinctChildren", "workflowBudget.maxDistinctChildrenHint"],
} as const;

const isInt = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value);

function readSettings(payload: unknown): Settings {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid workflow budget settings");
  const value = payload as Record<string, unknown>;
  const defaults = value.defaults as Record<string, unknown> | undefined;
  const bounds = value.bounds as Record<string, { min?: unknown; max?: unknown } | undefined> | undefined;
  if (!defaults || !bounds || !isInt(value.windowMs)) throw new Error("Missing workflow budget settings");
  const settings = { values: {}, defaults: {}, bounds: {}, windowMinutes: Math.round(value.windowMs / 60_000) } as Settings;
  for (const key of KEYS) {
    const range = bounds[key];
    if (!isInt(value[key]) || !isInt(defaults[key]) || !range || !isInt(range.min) || !isInt(range.max)) {
      throw new Error("Missing workflow budget settings");
    }
    settings.values[key] = value[key];
    settings.defaults[key] = defaults[key];
    settings.bounds[key] = { min: range.min, max: range.max };
  }
  return settings;
}

const toDrafts = (values: Values): Drafts =>
  ({ maxConcurrentChildren: String(values.maxConcurrentChildren), maxPhysicalSends: String(values.maxPhysicalSends), maxDistinctChildren: String(values.maxDistinctChildren) });

function parseDraft(raw: string, range: { min: number; max: number }): number | undefined {
  if (!/^\d+$/.test(raw.trim())) return undefined;
  const value = Number(raw.trim());
  return value >= range.min && value <= range.max ? value : undefined;
}

export default function WorkflowBudgetPanel({ apiBase }: { apiBase: string }) {
  return <WorkflowBudgetControls key={apiBase} apiBase={apiBase} />;
}

function WorkflowBudgetControls({ apiBase }: { apiBase: string }) {
  const t = useT();
  const [saved, setSaved] = useState<Settings | undefined>();
  const [drafts, setDrafts] = useState<Drafts>({ maxConcurrentChildren: "", maxPhysicalSends: "", maxDistinctChildren: "" });
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [feedback, setFeedback] = useState<"saved" | "failed" | null>(null);
  const active = useRef(false);
  const pending = useRef<ReturnType<typeof createBoundedFetch> | null>(null);
  const accept = useCallback((value: Settings) => { setSaved(value); setDrafts(toDrafts(value.values)); }, []);
  const load = useCallback(async () => {
    if (pending.current) return;
    const request = createBoundedFetch(15_000);
    pending.current = request; setLoadError(false);
    try {
      const response = await fetch(apiBase + "/api/workflow-budget/settings", { signal: request.signal });
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
      window.clearTimeout(timer); active.current = false;
      pending.current?.controller.abort(); pending.current?.clear(); pending.current = null;
    };
  }, [load]);

  const parsed = saved
    ? Object.fromEntries(KEYS.map(key => [key, parseDraft(drafts[key], saved.bounds[key])])) as Record<Key, number | undefined>
    : undefined;
  const valid = parsed !== undefined && KEYS.every(key => parsed[key] !== undefined);
  const changed = saved !== undefined && parsed !== undefined && KEYS.some(key => parsed[key] !== saved.values[key]);
  const atDefaults = saved !== undefined && KEYS.every(key => saved.values[key] === saved.defaults[key]);

  const save = async (reset = false) => {
    if (pending.current || saved === undefined || (!reset && (!valid || parsed === undefined))) return;
    // Values equal to the defaults are written as a reset, so the install keeps following the
    // built-in ceilings instead of pinning today's numbers.
    const body = reset || KEYS.every(key => parsed?.[key] === saved.defaults[key])
      ? null
      : Object.fromEntries(KEYS.map(key => [key, parsed?.[key]]));
    const request = createBoundedFetch(15_000);
    pending.current = request; setBusy(true); setFeedback(null);
    try {
      const response = await fetch(apiBase + "/api/workflow-budget/settings", {
        method: "PUT", headers: { "Content-Type": "application/json" }, signal: request.signal,
        body: JSON.stringify(body),
      });
      const value = readSettings(await requireJson(response));
      if (active.current && pending.current === request) { accept(value); setFeedback("saved"); }
    } catch {
      if (active.current && pending.current === request) setFeedback("failed");
    } finally {
      request.clear();
      if (active.current && pending.current === request) setBusy(false);
      if (pending.current === request) pending.current = null;
    }
  };
  const disabled = busy || saved === undefined || loadError;
  const edit = (key: Key, value: string) => { setDrafts(current => ({ ...current, [key]: value })); setFeedback(null); };

  return <section className="panel" aria-labelledby="workflow-budget-title" aria-busy={busy || (saved === undefined && !loadError)}>
    <div className="font-semibold" id="workflow-budget-title">{t("workflowBudget.title")}</div>
    <p className="muted setting-hint">{t("workflowBudget.description", { minutes: saved?.windowMinutes ?? 10 })}</p>
    <div className="stack" style={{ gap: "var(--space-3)" }}>
      {KEYS.map(key => {
        const [labelKey, hintKey] = LABEL_KEYS[key];
        const label = t(labelKey);
        const range = saved?.bounds[key] ?? { min: 0, max: 0 };
        const invalid = saved !== undefined && parsed?.[key] === undefined;
        const hintId = "workflow-budget-" + key + "-hint";
        return <div className="spread" key={key} style={{ alignItems: "flex-start", gap: "var(--space-3)" }}>
          <div className="stack" style={{ gap: "var(--space-1)", minWidth: 0 }}>
            <span>{label}</span>
            <span className="muted setting-hint" id={hintId}>
              {t(hintKey)}{" "}
              {saved && t("workflowBudget.range", { default: saved.defaults[key], min: range.min, max: range.max })}
            </span>
            {invalid && <span className="setting-hint" role="alert" style={{ color: "var(--red)" }}>{t("workflowBudget.invalid", { min: range.min, max: range.max })}</span>}
          </div>
          <span className="codex-auto-switch-input-wrap">
            <input
              className="input mono codex-auto-switch-input"
              type="number" min={range.min} max={range.max} step={1} inputMode="numeric"
              value={drafts[key]} readOnly={disabled} aria-disabled={disabled}
              aria-label={label} aria-describedby={hintId} aria-invalid={invalid}
              onChange={event => edit(key, event.target.value)}
              onKeyDown={event => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing && !disabled && changed && valid) {
                  event.preventDefault(); void save();
                }
              }}
            />
            <NumberStepper
              disabled={disabled}
              incrementLabel={t("workflowBudget.increase", { label })}
              decrementLabel={t("workflowBudget.decrease", { label })}
              onIncrement={() => edit(key, clampNumberDraft(drafts[key], 1, range.min, range.max))}
              onDecrement={() => edit(key, clampNumberDraft(drafts[key], -1, range.min, range.max))}
            />
          </span>
        </div>;
      })}
      <div className="row">
        <button type="button" className="btn btn-primary" disabled={disabled || !changed || !valid} onClick={() => { void save(); }}>{t("common.save")}</button>
        <button type="button" className="btn btn-ghost" disabled={disabled || (!changed && atDefaults)} onClick={() => { void save(true); }}>{t("workflowBudget.reset")}</button>
      </div>
    </div>
    {loadError && <div className="notice notice-err" role="alert">{t("workflowBudget.loadFailed")} <button type="button" className="btn btn-ghost btn-sm" onClick={() => { void load(); }}>{t("common.retry")}</button></div>}
    {feedback === "failed" && <div className="notice notice-err" role="alert">{t("workflowBudget.saveFailed")}</div>}
    {feedback === "saved" && <div className="muted setting-hint" role="status">{t("workflowBudget.saved")}</div>}
  </section>;
}
