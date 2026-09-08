import { Fragment, useCallback, useEffect, useId, useRef, useState } from "react";
import { createBoundedFetch, type BoundedFetch } from "../bounded-fetch";
import { readJsonOrThrow } from "../fetch-json";
import { useT, type TKey } from "../i18n/shared";
import type { ModelRow } from "../pages/models-shared";

interface Cost4 {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const RATE_FIELDS = ["input", "output", "cacheRead", "cacheWrite"] as const;
const RATE_LABELS: Record<keyof Cost4, TKey> = {
  input: "pricing.override.input",
  output: "pricing.override.output",
  cacheRead: "pricing.override.cacheRead",
  cacheWrite: "pricing.override.cacheWrite",
};
const MAX_RATE = 1_000_000;
const REQUEST_TIMEOUT_MS = 60_000;
const EMPTY_DRAFT = { input: "", output: "", cacheRead: "", cacheWrite: "" };
type Phase = "loading" | "loadFailed" | "ready" | "saving" | "unknown" | "refreshing" | "refreshFailed";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCost(value: unknown): value is Cost4 {
  return isRecord(value) && RATE_FIELDS.every(field => (
    typeof value[field] === "number" && Number.isFinite(value[field])
    && value[field] >= 0 && value[field] <= MAX_RATE
  ));
}

interface ModelPriceDialogProps {
  model: ModelRow;
  apiBase: string;
  onRefresh: (signal: AbortSignal) => Promise<boolean>;
  onClose: () => void;
}

export default function ModelPriceDialog({ model, apiBase, onRefresh, onClose }: ModelPriceDialogProps) {
  const t = useT();
  const id = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const submitRef = useRef<HTMLButtonElement>(null);
  const requestRef = useRef<BoundedFetch | null>(null);
  const mutationPendingRef = useRef(false);
  const [phase, setPhase] = useState<Phase>("loading");
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [hasOverride, setHasOverride] = useState(false);
  const [errorKey, setErrorKey] = useState<TKey | null>(null);
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
      const cost = Object.hasOwn(result.modelCosts, model.id) ? result.modelCosts[model.id] : undefined;
      if (cost !== undefined && !isCost(cost)) throw new Error("invalid model cost");
      if (requestRef.current !== bounded) return;
      setDraft(cost === undefined ? EMPTY_DRAFT : {
        input: String(cost.input), output: String(cost.output),
        cacheRead: String(cost.cacheRead), cacheWrite: String(cost.cacheWrite),
      });
      setHasOverride(cost !== undefined);
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
  }, [endpoint, model.id, model.provider]);

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
  const save = async (cost: Cost4 | null | undefined) => {
    if (requestRef.current || (cost === undefined ? phase !== "refreshFailed" : phase !== "ready")) return;
    const bounded = createBoundedFetch(REQUEST_TIMEOUT_MS);
    requestRef.current = bounded;
    setPhase(cost === undefined ? "refreshing" : "saving");
    mutationPendingRef.current = true;
    setErrorKey(null);
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
          || result.modelId !== model.id || (cost === null ? receiptCost !== null
            : !isCost(receiptCost) || !RATE_FIELDS.every(field => receiptCost[field] === cost[field]))) {
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
      <form className="modal-card model-display-name-dialog" role="document" noValidate
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
          const cost = {
            input: Number(draft.input), output: Number(draft.output),
            cacheRead: Number(draft.cacheRead), cacheWrite: Number(draft.cacheWrite),
          };
          const badInput = [...event.currentTarget.querySelectorAll("input")].some(input => input.validity.badInput);
          if (badInput || !draft.input.trim() || !draft.output.trim() || !isCost(cost)) {
            setErrorKey("pricing.override.invalid");
            inputRef.current?.focus();
            return;
          }
          void save(cost);
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
        <p id={`${id}-help`} className="muted small">{t("pricing.override.help")}</p>
        {phase === "loading" && <p role="status" className="muted small">{t("pricing.override.loading")}</p>}
        {RATE_FIELDS.map(field => (
          <Fragment key={field}>
            <label className="field-label" htmlFor={`${id}-${field}`}>{t(RATE_LABELS[field])}</label>
            <input ref={field === "input" ? inputRef : undefined} id={`${id}-${field}`}
              className="input" type="number" min={0} max={MAX_RATE} step="any" inputMode="decimal"
              value={draft[field]} disabled={locked}
              required={field === "input" || field === "output"}
              aria-describedby={`${id}-help${errorKey ? ` ${id}-error` : ""}`}
              aria-invalid={errorKey === "pricing.override.invalid" ? true : undefined}
              onChange={event => {
                if (locked || requestRef.current) return;
                const value = event.target.value;
                setDraft(current => ({
                  ...current,
                  cacheRead: current.cacheRead || "0", cacheWrite: current.cacheWrite || "0",
                  [field]: value,
                }));
                setErrorKey(null);
              }} />
          </Fragment>
        ))}
        {recovered && <p role="status" className="muted small">{t("pricing.override.recovered")}</p>}
        {errorKey && <p id={`${id}-error`} className="model-display-name-error" role="alert">{t(errorKey)}</p>}
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
