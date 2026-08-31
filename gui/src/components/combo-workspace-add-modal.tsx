import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type ComboItem,
  type ProviderQuotaStates,
  comboQuotaState,
  comboPublicModelId,
  emptyDraft,
  intersectComboEfforts,
  validateComboDraft,
} from "../combo-workspace-data";
import { IconX } from "../icons";
import { useT } from "../i18n/shared";
import { Notice } from "../ui";
import type { ModelOption, ProviderOption } from "./combo-workspace-types";
import { ComboCapabilities, EffortSelect, StrategySeg, TargetEditor } from "./combo-workspace-controls";
import { COMBO_STRATEGY_HINT_KEYS, COMBO_TARGETS_HINT_KEYS } from "../combo-workspace-data";
import { clampedNumberInput } from "./combo-workspace-utils";

export function AddComboModal({
  existingIds,
  existingAliases,
  providerMap,
  providerQuotaStates,
  providers,
  models,
  onClose,
  onSubmit,
}: {
  existingIds: string[];
  existingAliases: string[];
  providerMap: Readonly<Record<string, { disabled?: boolean }>>;
  providerQuotaStates: ProviderQuotaStates;
  providers: ProviderOption[];
  models: ModelOption[];
  onClose: () => void;
  onSubmit: (item: ComboItem) => Promise<{ ok: boolean; error?: string }>;
}) {
  const t = useT();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState<ComboItem>(() => emptyDraft());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const effortMap = useMemo(() => {
    const map = new Map<string, string[] | undefined>();
    for (const model of models) {
      map.set(`${model.provider}/${model.id}`, model.reasoningEfforts);
    }
    return map;
  }, [models]);
  const allowedEfforts = useMemo(
    () => intersectComboEfforts(draft.targets, effortMap),
    [draft.targets, effortMap],
  );
  const allTargetsExhausted = comboQuotaState(draft.targets, providerQuotaStates, providerMap) === "exhausted";

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const requestClose = useCallback(() => {
    if (!busy) onClose();
  }, [busy, onClose]);

  const handleCancel = useCallback((e: React.SyntheticEvent) => {
    e.preventDefault();
    requestClose();
  }, [requestClose]);

  const submit = async () => {
    const code = validateComboDraft(draft, {
      existingIds,
      existingAliases,
      isCreate: true,
      providers: providerMap,
    });
    if (code) {
      setError(t(`cws.err.${code}`));
      return;
    }
    setBusy(true);
    setError("");
    const id = draft.id.trim();
    const alias = draft.alias?.trim() || null;
    try {
      const res = await onSubmit({ ...draft, id, alias, model: comboPublicModelId(id, alias) });
      if (!res.ok) {
        setError(res.error || t("cws.saveFailed"));
        return;
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="modal-overlay"
      aria-labelledby="cwi-add-title"
      onCancel={handleCancel}
    >
      <button type="button" className="modal-backdrop-dismiss" aria-label={t("common.close")} tabIndex={-1} onClick={requestClose} />
      <div className="modal-card" style={{ width: "min(560px, 94vw)" }} onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
          <h3 id="cwi-add-title" style={{ margin: 0 }}>{t("cws.addTitle")}</h3>
          <button type="button" className="btn btn-ghost btn-sm" onClick={requestClose} disabled={busy} aria-label={t("common.close")}>
            <IconX width={16} height={16} />
          </button>
        </div>
        <p className="muted" style={{ marginTop: 0, maxWidth: "62ch", overflowWrap: "anywhere" }}>{t("cws.addSubtitle")}</p>
        {error && <Notice tone="err">{error}</Notice>}
        {allTargetsExhausted && (
          <div className="cwi-quota-banner" role="status" aria-live="polite">
            {t("cws.quota.allExhausted")}
          </div>
        )}
        <div className="cwi-modal-form">
          <div className="cwi-field">
            <label htmlFor="cwi-new-id">{t("cws.field.id")}</label>
            <input
              id="cwi-new-id"
              className="input mono"
              value={draft.id}
              disabled={busy}
              onChange={(e) => setDraft((d) => ({
                ...d,
                id: e.target.value,
                model: comboPublicModelId(e.target.value, d.alias),
              }))}
            />
            <p className="muted" style={{ fontSize: 12, margin: "8px 0 0" }}>
              {t("cws.field.idInternalHint")}
            </p>
          </div>
          <div className="cwi-field">
            <label htmlFor="cwi-new-alias">{t("cws.field.alias")}</label>
            <input
              id="cwi-new-alias"
              className="input mono"
              value={draft.alias ?? ""}
              placeholder={t("cws.field.aliasPlaceholder")}
              disabled={busy}
              onChange={(e) => setDraft((d) => ({
                ...d,
                alias: e.target.value.trim() ? e.target.value : null,
                model: comboPublicModelId(d.id, e.target.value),
              }))}
            />
            <p className="muted" style={{ fontSize: 12, margin: "8px 0 0" }}>
              {t("cws.field.aliasHint")}
            </p>
            <p className="muted" style={{ fontSize: 12, margin: "8px 0 0" }}>
              {t("cws.field.idHint", {
                model: draft.id.trim() ? comboPublicModelId(draft.id, draft.alias) : "…",
              })}
            </p>
          </div>
          <div className="cwi-field">
            <span className="field-label">{t("cws.strategy")}</span>
            <StrategySeg
              value={draft.strategy}
              disabled={busy}
              onChange={(strategy) => setDraft((d) => ({ ...d, strategy }))}
            />
            <p className="muted" style={{ fontSize: 12, margin: "8px 0 0" }}>
              {t(COMBO_STRATEGY_HINT_KEYS[draft.strategy])}
            </p>
          </div>
          <div className="cwi-field">
            <label htmlFor="cwi-new-effort">{t("cws.field.defaultEffort")}</label>
            <EffortSelect
              id="cwi-new-effort"
              value={draft.defaultEffort}
              disabled={busy}
              allowedEfforts={allowedEfforts}
              onChange={(defaultEffort) => setDraft((d) => ({ ...d, defaultEffort }))}
            />
            <p className="muted" style={{ fontSize: 12, margin: "8px 0 0" }}>
              {t("cws.field.defaultEffortHint")}
            </p>
          </div>
          {draft.strategy === "round-robin" && (
            <div className="cwi-field">
              <label htmlFor="cwi-new-sticky">{t("cws.field.stickyLimit")}</label>
              <input
                id="cwi-new-sticky"
                className="input mono"
                type="number"
                min={1}
                max={100}
                value={draft.stickyLimit}
                disabled={busy}
                onChange={(e) => {
                  const stickyLimit = clampedNumberInput(e.target.value, 1, 100);
                  if (stickyLimit === undefined) return;
                  setDraft((d) => ({ ...d, stickyLimit }));
                }}
              />
              <p className="muted" style={{ fontSize: 12, margin: "8px 0 0" }}>
                {t("cws.field.stickyLimitHint")}
              </p>
            </div>
          )}
          <div className="cwi-field">
            <span className="field-label">{t("cws.targets")}</span>
            <TargetEditor
              targets={draft.targets}
              strategy={draft.strategy}
              providers={providers}
              models={models}
              providerQuotaStates={providerQuotaStates}
              onChange={(targets) => setDraft((d) => ({ ...d, targets }))}
            />
            <p className="muted" style={{ fontSize: 12, margin: "8px 0 0" }}>
              {t(COMBO_TARGETS_HINT_KEYS[draft.strategy])}
            </p>
          </div>
          <ComboCapabilities
            targets={draft.targets}
            models={models}
            imageInput={draft.imageInput ?? "auto"}
            disabled={busy}
            onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))}
          />
        </div>
        <div className="cwi-modal-actions">
          <button type="button" className="btn btn-ghost" onClick={requestClose} disabled={busy}>{t("common.cancel")}</button>
          <button type="button" className="btn btn-primary" onClick={() => { void submit(); }} disabled={busy || allTargetsExhausted}>
            {busy ? t("common.saving") : t("cws.create")}
          </button>
        </div>
      </div>
    </dialog>
  );
}
