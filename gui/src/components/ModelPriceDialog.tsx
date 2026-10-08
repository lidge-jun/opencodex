import { useCallback, useEffect, useId, useRef, useState } from "react";
import "./model-price-dialog.css";
import { createBoundedFetch, type BoundedFetch } from "../bounded-fetch";
import { readJsonOrThrow } from "../fetch-json";
import { useT, type TKey } from "../i18n/shared";
import type { ModelRow } from "../pages/models-shared";
import { Select } from "../ui";
import {
  CUSTOM_FIELD, EMPTY_CUSTOM, EMPTY_RATES, INVALID, RATE_FIELDS, buildDraftCost, isRecord, loadDraft, parseModelCost, receiptMatches,
  type CustomDraft, type InvalidField, type ModelCost, type PricingMode, type RateDraft, type RateField,
} from "./model-price-cost";

const RATE_LABELS: Record<RateField, TKey> = {
  input: "pricing.override.input",
  output: "pricing.override.output",
  cacheRead: "pricing.override.cacheRead",
  cacheWrite: "pricing.override.cacheWrite",
};
const REQUEST_TIMEOUT_MS = 60_000;
type Phase = "loading" | "loadFailed" | "ready" | "saving" | "unknown" | "refreshing" | "refreshFailed";

interface ModelPriceDialogProps {
  model: ModelRow;
  apiBase: string;
  onRefresh: (signal: AbortSignal) => Promise<boolean>;
  onClose: () => void;
}

export default function ModelPriceDialog({ model, apiBase, onRefresh, onClose }: ModelPriceDialogProps) {
  const t = useT();
  const id = useId();
  const helpId = useId();
  const errorId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const customFieldRefs = useRef<Partial<Record<InvalidField, HTMLInputElement>>>({});
  const submitRef = useRef<HTMLButtonElement>(null);
  const requestRef = useRef<BoundedFetch | null>(null);
  const mutationPendingRef = useRef(false);
  const [phase, setPhase] = useState<Phase>("loading");
  const [draft, setDraft] = useState<RateDraft>(EMPTY_RATES);
  const [pricingMode, setPricingMode] = useState<PricingMode>("automatic");
  const [customDraft, setCustomDraft] = useState<CustomDraft>(EMPTY_CUSTOM);
  const [hasOverride, setHasOverride] = useState(false);
  const [errorKey, setErrorKey] = useState<TKey | null>(null);
  const [invalidField, setInvalidField] = useState<InvalidField | null>(null);
  const [recovered, setRecovered] = useState(false);
  const endpoint = `${apiBase}/api/providers/${encodeURIComponent(model.provider)}/model-costs`;
  const mutating = phase === "saving" || phase === "refreshing";
  const locked = phase !== "ready";

  const readOverride = useCallback((recover = false) => {
    if (requestRef.current) return;
    const bounded = createBoundedFetch(REQUEST_TIMEOUT_MS);
    requestRef.current = bounded;
    void fetch(endpoint, { signal: bounded.signal, cache: "no-store" }).then(async response => {
      const result = await readJsonOrThrow<unknown>(response);
      bounded.signal.throwIfAborted();
      if (!isRecord(result) || result.provider !== model.provider || !isRecord(result.modelCosts)) {
        throw new Error("invalid model-costs response");
      }
      const rawCost = Object.hasOwn(result.modelCosts, model.id) ? result.modelCosts[model.id] : undefined;
      const cost = rawCost === undefined ? undefined : parseModelCost(rawCost);
      if (cost === INVALID) throw new Error("invalid model cost");
      if (requestRef.current !== bounded) return;
      const loaded = loadDraft(cost);
      setDraft(loaded.rates);
      setPricingMode(loaded.mode);
      setCustomDraft(loaded.custom);
      setHasOverride(cost !== undefined);
      setErrorKey(null);
      setInvalidField(null);
      // This read recovers an editable snapshot, not ordering against an earlier
      // request still running on the server or writes from another client.
      setRecovered(recover);
      setPhase("ready");
    }).catch(() => {
      if (requestRef.current !== bounded) return;
      setPhase(recover ? "unknown" : "loadFailed");
      setErrorKey(recover ? "pricing.override.recoveryFailed" : "pricing.override.loadFailed");
    }).finally(() => {
      bounded.clear();
      if (requestRef.current === bounded) requestRef.current = null;
    });
  }, [endpoint, model.id, model.provider, setCustomDraft, setErrorKey, setInvalidField, setPricingMode]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    void readOverride();
    return () => {
      requestRef.current?.controller.abort();
      requestRef.current?.clear();
      requestRef.current = null;
      if (dialog?.open) dialog.close();
    };
  }, [readOverride]);

  useEffect(() => {
    if (phase === "ready") inputRef.current?.focus();
    else if (phase === "unknown" || phase === "loadFailed" || phase === "refreshFailed") submitRef.current?.focus();
  }, [phase]);

  // undefined retries only catalog refresh after a validated persistence receipt.
  const save = async (cost: ModelCost | null | undefined) => {
    if (requestRef.current || (cost === undefined ? phase !== "refreshFailed" : phase !== "ready")) return;
    const bounded = createBoundedFetch(REQUEST_TIMEOUT_MS);
    requestRef.current = bounded;
    setPhase(cost === undefined ? "refreshing" : "saving");
    mutationPendingRef.current = true;
    setErrorKey(null);
    setInvalidField(null);
    let confirmed = cost === undefined;
    try {
      if (cost !== undefined) {
        const response = await fetch(endpoint, {
          method: "PUT", headers: { "content-type": "application/json" },
          body: JSON.stringify({ modelId: model.id, cost }), signal: bounded.signal,
        });
        const result = await readJsonOrThrow<unknown>(response);
        bounded.signal.throwIfAborted();
        const receiptCost = isRecord(result) ? result.cost : undefined;
        if (!isRecord(result) || result.ok !== true || result.provider !== model.provider
          || result.modelId !== model.id || !receiptMatches(receiptCost, cost)) {
          throw new Error("invalid model-costs receipt");
        }
        if (requestRef.current !== bounded) return;
        confirmed = true;
        setPhase("refreshing");
      }
      if (!await onRefresh(bounded.signal)) throw new Error("catalog refresh failed");
      bounded.signal.throwIfAborted();
      if (requestRef.current === bounded) onClose();
    } catch {
      if (requestRef.current !== bounded) return;
      setPhase(confirmed ? "refreshFailed" : "unknown");
      setErrorKey(confirmed ? "pricing.override.refreshFailed" : "pricing.override.outcomeUnknown");
    } finally {
      bounded.clear();
      if (requestRef.current === bounded) {
        requestRef.current = null;
        mutationPendingRef.current = false;
      }
    }
  };

  const requestClose = () => {
    if (!mutationPendingRef.current) onClose();
  };

  return (
    <dialog ref={dialogRef} className="modal-overlay" aria-labelledby={`${id}-title`}
      onCancel={event => { event.preventDefault(); requestClose(); }}>
      <button type="button" className="modal-backdrop-dismiss" tabIndex={-1}
        aria-label={t("pricing.override.close")} disabled={mutating} onClick={requestClose} />
      <form className="modal-card model-display-name-dialog model-price-dialog" role="document" noValidate
        aria-busy={phase === "loading" || mutating}
        onClick={event => event.stopPropagation()}
        onSubmit={event => {
          event.preventDefault();
          if (requestRef.current) return;
          if (phase === "unknown" || phase === "loadFailed") {
            setPhase("loading");
            setErrorKey(null);
            void readOverride(phase === "unknown");
            return;
          }
          if (phase === "refreshFailed") { void save(undefined); return; }
          if (locked) return;
          // A number input holding unparseable text reports value "", which would read as a blank
          // (zero) cache rate; the browser's badInput flag names the field instead.
          const badField = (Object.entries(customFieldRefs.current) as [InvalidField, HTMLInputElement][])
            .find(([, input]) => input.validity.badInput)?.[0];
          const outcome = buildDraftCost(draft, pricingMode, customDraft, badField);
          if ("field" in outcome) {
            setInvalidField(outcome.field);
            setErrorKey(outcome.field === "threshold" || outcome.field.startsWith("custom")
              ? "pricing.override.customInvalid" : "pricing.override.invalid");
            const target = customFieldRefs.current[outcome.field];
            target?.focus();
            return;
          }
          void save(outcome.cost);
        }}>
        <div className="modal-head">
          <h3 id={`${id}-title`}>{t("pricing.override.title")}</h3>
          <button type="button" className="btn btn-ghost btn-sm" disabled={mutating} onClick={requestClose}>
            {t("pricing.override.close")}
          </button>
        </div>
        <div className="model-display-name-identity">
          <span className="muted text-label">{t("pricing.override.modelId")}</span>
          <code className="mono text-control">{model.namespaced}</code>
        </div>
        <div className="model-price-body">
        <p id={helpId} className="muted small">{t("pricing.override.help")}</p>
        <p className="muted small">{t("pricing.override.promptHelp")}</p>
        {phase === "loading" && <p role="status" className="muted small">{t("pricing.override.loading")}</p>}
        <div className="model-price-rates-grid">
          {RATE_FIELDS.map(field => (
            <div className="model-price-rate-field" key={field}>
              <label className="field-label" htmlFor={`${id}-${field}`}>{t(RATE_LABELS[field])}</label>
              <input ref={node => {
                if (node) customFieldRefs.current[field] = node;
                else delete customFieldRefs.current[field];
                if (field === "input") inputRef.current = node;
              }} id={`${id}-${field}`}
                className="input" type="number" min={0} max={1_000_000} step="any" inputMode="decimal"
                value={draft[field]} disabled={locked}
                required={field === "input" || field === "output"}
                aria-describedby={`${helpId}${errorKey ? ` ${errorId}` : ""}`}
                aria-invalid={invalidField === field ? true : undefined}
                onChange={event => {
                  if (locked || requestRef.current) return;
                  const value = event.target.value;
                  setDraft(current => ({
                    ...current,
                    cacheRead: current.cacheRead || "0",
                    cacheWrite: current.cacheWrite || "0",
                    [field]: value,
                  }));
                  setErrorKey(null);
                  setInvalidField(null);
                }} />
            </div>
          ))}
        </div>
        <fieldset className="model-price-mode">
          <legend className="field-label">{t("pricing.override.promptTitle")}</legend>
          {(["automatic", "flat", "custom"] as const).map(mode => <label className="model-price-mode-option" key={mode}>
            <input type="radio" name={`${id}-mode`} value={mode} checked={pricingMode === mode} disabled={locked}
              onChange={() => { setPricingMode(mode); setErrorKey(null); setInvalidField(null); }} />
            <span><strong>{t(`pricing.override.mode${mode[0]!.toUpperCase()}${mode.slice(1)}` as TKey)}</strong>
              <small className="muted">{t(`pricing.override.mode${mode[0]!.toUpperCase()}${mode.slice(1)}Help` as TKey)}</small></span>
          </label>)}
        </fieldset>
        {pricingMode === "custom" && <section className="model-price-band" aria-labelledby={`${id}-custom-title`}>
          <h4 id={`${id}-custom-title`} className="model-price-band-title">{t("pricing.override.bandTitle")}</h4>
          <div className="model-price-custom-controls">
            <div>
              <label className="field-label" htmlFor={`${id}-threshold`}>{t("pricing.override.threshold")}</label>
              <input ref={node => { if (node) customFieldRefs.current.threshold = node; else delete customFieldRefs.current.threshold; }} id={`${id}-threshold`} className="input" type="number" min={1} step={1} inputMode="numeric"
                value={customDraft.threshold} disabled={locked} aria-describedby={`${helpId}${errorKey ? ` ${errorId}` : ""}`}
                aria-invalid={invalidField === "threshold" ? true : undefined}
                onChange={event => { setCustomDraft(current => ({ ...current, threshold: event.target.value })); setErrorKey(null); setInvalidField(null); }} />
            </div>
            <div>
              <label className="field-label" htmlFor={`${id}-comparison`}>{t("pricing.override.comparison")}</label>
              <Select id={`${id}-comparison`} label={t("pricing.override.comparison")} value={customDraft.comparison} disabled={locked}
                describedBy={helpId} options={[{ value: "gt", label: t("pricing.override.comparisonGt") }, { value: "gte", label: t("pricing.override.comparisonGte") }]}
                onChange={value => setCustomDraft(current => ({ ...current, comparison: value as "gt" | "gte" }))} />
            </div>
          </div>
          <p id={`${id}-custom-help`} className="muted small">{t("pricing.override.bandHelp")}</p>
          <div className="model-price-rates-grid">
            {RATE_FIELDS.map(field => (
              <div className="model-price-rate-field" key={`custom-${field}`}>
                <label className="field-label" htmlFor={`${id}-custom-${field}`}>{t(RATE_LABELS[field])}</label>
                <input ref={node => { const key = CUSTOM_FIELD[field]; if (node) customFieldRefs.current[key] = node; else delete customFieldRefs.current[key]; }}
                  id={`${id}-custom-${field}`} className="input" type="number" min={0} max={1_000_000} step="any" inputMode="decimal"
                  value={customDraft[field]} disabled={locked} required={field === "input" || field === "output"}
                  aria-describedby={`${helpId}${errorKey ? ` ${errorId}` : ""}`}
                  aria-invalid={invalidField === CUSTOM_FIELD[field] ? true : undefined}
                  onChange={event => { const value = event.target.value; setCustomDraft(current => ({ ...current, [field]: value })); setErrorKey(null); setInvalidField(null); }} />
              </div>
            ))}
          </div>
        </section>}
        </div>
        {recovered && <p role="status" className="muted small">{t("pricing.override.recovered")}</p>}
        {errorKey && <p id={errorId} className="model-display-name-error" role="alert">{t(errorKey)}</p>}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost btn-sm" disabled={locked || !hasOverride}
            onClick={() => void save(null)}>{t("pricing.override.reset")}</button>
          <button type="button" className="btn btn-sm" disabled={mutating} onClick={requestClose}>
            {t("pricing.override.cancel")}
          </button>
          <button ref={submitRef} type="submit" className="btn btn-primary btn-sm" disabled={phase === "loading" || mutating}>
            {t(mutating ? "pricing.override.saving" : phase === "unknown" || phase === "loadFailed"
              ? "pricing.override.reload" : phase === "refreshFailed" ? "pricing.override.refresh" : "pricing.override.save")}
          </button>
        </div>
      </form>
    </dialog>
  );
}
