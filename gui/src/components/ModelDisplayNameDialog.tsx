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
  onSave,
  onReset,
  onClose,
}: ModelDisplayNameDialogProps) {
  const t = useT();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const helpId = useId();
  const errorId = useId();
  const [draft, setDraft] = useState(model.displayNameOverride ?? "");
  const [validationKey, setValidationKey] = useState<TKey | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    inputRef.current?.focus();
    return () => { if (dialog?.open) dialog.close(); };
  }, []);

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
          <strong>{model.displayName ?? model.namespaced}</strong>
          <span className="models-chip muted text-caption">{t(sourceKey)}</span>
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
          aria-invalid={visibleError ? true : undefined}
          disabled={saving}
          onChange={event => {
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
            disabled={saving || !model.displayNameOverride}
            onClick={onReset}
          >
            {t("models.displayNameReset")}
          </button>
          <button type="button" className="btn btn-sm" disabled={saving} onClick={requestClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn btn-primary btn-sm" disabled={saving}>
            {saving ? t("common.saving") : t("common.save")}
          </button>
        </div>
      </form>
    </dialog>
  );
}
