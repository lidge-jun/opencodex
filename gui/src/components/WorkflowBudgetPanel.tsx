import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../i18n/shared";
import { createBoundedFetch } from "../bounded-fetch";
import { clampNumberDraft } from "../clamp-draft";
import { requireJson } from "../pages/dashboard-shared";
import { Button } from "./ui-v2/button";
import { Frame, FrameBody, FrameFoot, HelpTip } from "./v2-subagents/frame";
import { useHelpDisclosure } from "./v2-subagents/use-help-disclosure";
import { StepperInput } from "./v2-subagents/StepperInput";

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

export default function WorkflowBudgetPanel({ apiBase, id }: { apiBase: string; id?: string }) {
  return <WorkflowBudgetControls key={apiBase} apiBase={apiBase} id={id} />;
}

function WorkflowBudgetControls({ apiBase, id }: { apiBase: string; id?: string | undefined }) {
  const t = useT();
  const help = useHelpDisclosure(t("workflowBudget.title"));
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

  // A settings form with a sticky save bar (React Bits settings-form-1): the long window
  // explanation sits behind the "?", each field keeps one caption line, and the foot says
  // whether there is anything to save.
  return <Frame
    id={id}
    title={t("workflowBudget.title")}
    lede={t("subagentsV2.budgetLede")}
    meta={help.button}
    busy={busy || (saved === undefined && !loadError)}
    below={help.panel(<p>{t("workflowBudget.description", { minutes: saved?.windowMinutes ?? 10 })}</p>)}
  >
    {loadError && (
      <div className="mx-4 mb-3 flex flex-wrap items-center gap-2 rounded-[8px] bg-danger-soft px-3 py-2 text-[13px] text-danger" role="alert">
        <span className="flex-1">{t("workflowBudget.loadFailed")}</span>
        <Button size="sm" variant="outline" onClick={() => { void load(); }}>{t("common.retry")}</Button>
      </div>
    )}
    <FrameBody>
      {KEYS.map(key => {
        const [labelKey, hintKey] = LABEL_KEYS[key];
        const label = t(labelKey);
        const range = saved?.bounds[key] ?? { min: 0, max: 0 };
        const invalid = saved !== undefined && parsed?.[key] === undefined;
        const hintId = "workflow-budget-" + key + "-hint";
        return <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3" key={key}>
          <div className="flex min-w-[min(100%,12rem)] flex-1 flex-col gap-0.5">
            <span className="flex items-center gap-1.5 text-[14px] leading-5 font-medium text-fg">
              {label}
              <HelpTip label={label}>{t(hintKey)}</HelpTip>
            </span>
            <span className="text-[12px] leading-4 text-fg-subtle tabular-nums" id={hintId}>
              {saved && t("workflowBudget.range", { default: saved.defaults[key], min: range.min, max: range.max })}
            </span>
            {invalid && <span className="text-[12px] leading-4 text-danger" role="alert">{t("workflowBudget.invalid", { min: range.min, max: range.max })}</span>}
          </div>
          <StepperInput
            min={range.min} max={range.max} step={1} inputMode="numeric"
            value={drafts[key]} readOnly={disabled} aria-disabled={disabled}
            aria-label={label} aria-describedby={hintId} aria-invalid={invalid}
            onChange={event => edit(key, event.target.value)}
            onKeyDown={event => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing && !disabled && changed && valid) {
                event.preventDefault(); void save();
              }
            }}
            stepDisabled={disabled}
            incrementLabel={t("workflowBudget.increase", { label })}
            decrementLabel={t("workflowBudget.decrease", { label })}
            onIncrement={() => edit(key, clampNumberDraft(drafts[key], 1, range.min, range.max))}
            onDecrement={() => edit(key, clampNumberDraft(drafts[key], -1, range.min, range.max))}
          />
        </div>;
      })}
    </FrameBody>
    <FrameFoot className="sticky bottom-0 z-[1] rounded-b-[12px] bg-surface">
      <span className="mr-auto min-w-0" aria-live="polite">
        {feedback === "failed" ? <span className="text-danger" role="alert">{t("workflowBudget.saveFailed")}</span>
          : feedback === "saved" ? <span className="text-success" role="status">{t("workflowBudget.saved")}</span>
          : <span className={changed ? "text-fg" : undefined}>{t(changed ? "subagentsV2.unsaved" : "subagentsV2.noChanges")}</span>}
      </span>
      <Button size="sm" variant="ghost" disabled={disabled || (!changed && atDefaults)} onClick={() => { void save(true); }}>{t("workflowBudget.reset")}</Button>
      <Button size="sm" variant="primary" disabled={disabled || !changed || !valid} onClick={() => { void save(); }}>{t("common.save")}</Button>
    </FrameFoot>
  </Frame>;
}
