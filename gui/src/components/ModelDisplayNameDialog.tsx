import { useEffect, useId, useRef, useState } from "react";
import { useT, type TKey } from "../i18n/shared";
import {
  modelDisplayNameValidationKey,
  type ModelRow,
} from "../pages/models-shared";

interface ModelDisplayNameDialogProps {
  model: ModelRow;
  saving: boolean;
  requestError: string | null;
  currentNamePending?: boolean;
  mutationOutcomeUnknown?: boolean;
  onRetry?: () => void;
  onEdit?: () => void;
  onSave: (displayName: string) => void;
  onReset: () => void;
  onClose: () => void;
}

const SOURCE_LABEL_KEYS: Record<NonNullable<ModelRow["displayNameSource"]>, TKey> = {
  operator: "models.displayNameSourceOperator",
  provider: "models.displayNameSourceProvider",
  fallback: "models.displayNameSourceFallback",
};

export default function ModelDisplayNameDialog({
  model,
  saving,
  requestError,
  currentNamePending = false,
  mutationOutcomeUnknown = false,
  onRetry,
  onEdit,
  onSave,
  onReset,
  onClose,
}: ModelDisplayNameDialogProps) {
  const t = useT();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const submitRef = useRef<HTMLButtonElement>(null);
  const wasSavingRef = useRef(saving);
  const titleId = useId();
  const helpId = useId();
  const errorId = useId();
  const [draftSnapshot, setDraftSnapshot] = useState(model);
  const [draft, setDraft] = useState(model.displayNameOverride ?? "");
  const [validationKey, setValidationKey] = useState<TKey | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    inputRef.current?.focus();
    return () => { if (dialog?.open) dialog.close(); };
  }, []);

  useEffect(() => {
    const saveFailed = wasSavingRef.current && !saving && Boolean(requestError);
    wasSavingRef.current = saving;
    if (saveFailed) {
      if (mutationOutcomeUnknown) submitRef.current?.focus();
      else inputRef.current?.focus();
    }
  }, [requestError, saving, mutationOutcomeUnknown]);

  // Parent replaces this snapshot only after a confirmed mutation, not typing or polling.
  // Adjust before committing children, preserving the mounted dialog and its focus refs.
  if (draftSnapshot !== model) {
    setDraftSnapshot(model);
    setDraft(model.displayNameOverride ?? "");
    setValidationKey(null);
  }

  const validationError = validationKey ? t(validationKey) : null;
  const visibleError = validationError ?? requestError;
  const sourceKey = model.displayNameSource
    ? SOURCE_LABEL_KEYS[model.displayNameSource]
    : "models.displayNameSourceFallback";

  const requestClose = () => {
    if (!saving) onClose();
  };

  return (
    <dialog
      ref={dialogRef}
      className="modal-overlay"
      aria-labelledby={titleId}
      onCancel={event => {
        event.preventDefault();
        requestClose();
      }}
    >
      <button
        type="button"
        className="modal-backdrop-dismiss"
        aria-label={t("common.close")}
        tabIndex={-1}
        disabled={saving}
        onClick={requestClose}
      />
      <form
        className="modal-card model-display-name-dialog"
        role="document"
        onClick={event => event.stopPropagation()}
        onSubmit={event => {
          event.preventDefault();
          if (saving) return;
          if (onRetry) { onRetry(); return; }
          if (mutationOutcomeUnknown) return;
          const nextValidationKey = modelDisplayNameValidationKey(draft);
          setValidationKey(nextValidationKey);
          if (!nextValidationKey) onSave(draft.trim());
        }}
      >
        <div className="modal-head">
          <h3 id={titleId}>{t("models.displayNameTitle")}</h3>
          <button type="button" className="btn btn-ghost btn-sm" disabled={saving} onClick={requestClose}>
            {t("common.close")}
          </button>
        </div>

        <div className="model-display-name-identity">
          <span className="muted text-label">{t("models.displayNameModelId")}</span>
          <code className="mono text-control">{model.namespaced}</code>
        </div>

        <div className="model-display-name-current">
          <span className="muted text-label">{t("models.displayNameCurrent")}</span>
          <strong>{currentNamePending ? t("models.displayNameCurrentUnavailable") : model.displayName ?? model.namespaced}</strong>
          {!currentNamePending && <span className="models-chip muted text-caption">{t(sourceKey)}</span>}
        </div>

        <label className="field-label" htmlFor={`${titleId}-input`}>
          {t("models.displayNameField")}
        </label>
        <input
          ref={inputRef}
          id={`${titleId}-input`}
          className="input"
          value={draft}
          maxLength={129}
          placeholder={t("models.displayNamePlaceholder")}
          aria-describedby={`${helpId}${visibleError ? ` ${errorId}` : ""}`}
          aria-invalid={validationError ? true : undefined}
          disabled={saving || mutationOutcomeUnknown}
          onChange={event => {
            if (saving || mutationOutcomeUnknown) return;
            onEdit?.();
            setDraft(event.target.value);
            setValidationKey(null);
          }}
        />
        <p id={helpId} className="muted small">
          {t("models.displayNameHelp", { model: model.namespaced })}
        </p>
        {visibleError && (
          <p id={errorId} className="model-display-name-error" role="alert">
            {visibleError}
          </p>
        )}

        <div className="modal-actions">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={saving || mutationOutcomeUnknown || !model.displayNameOverride}
            onClick={() => { if (!saving && !mutationOutcomeUnknown) onReset(); }}
          >
            {t("models.displayNameReset")}
          </button>
          <button type="button" className="btn btn-sm" disabled={saving} onClick={requestClose}>
            {t("common.cancel")}
          </button>
          <button ref={submitRef} type="submit" className="btn btn-primary btn-sm" disabled={saving || (mutationOutcomeUnknown && !onRetry)}>
            {saving ? t("common.saving") : onRetry ? t("common.retry") : t("common.save")}
          </button>
        </div>
      </form>
    </dialog>
  );
}
