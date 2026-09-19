import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useT, type TKey } from "../../i18n/shared";
import { Notice } from "../../ui";
import IntegrationPlanDetails, { type LabeledIntegrationPlan } from "./IntegrationPlanDetails";
import { IntegrationApiError, type IntegrationMutationPlan } from "./integration-api";

export interface ConsequenceCopy {
  titleKey: TKey;
  changesKey: TKey;
  breakageKey: TKey;
  undoKey: TKey;
  sideEffectKey?: TKey;
  confirmKey: TKey;
  vars?: Record<string, string>;
}

function CopySlot({ copyKey, vars }: { copyKey: TKey; vars?: Record<string, string> }) {
  const t = useT();
  const text = t(copyKey, vars);
  const path = vars?.path;
  if (!path || !text.includes(path)) return <p>{text}</p>;
  const [before, ...after] = text.split(path);
  return <p>{before}<code>{path}</code>{after.join(path)}</p>;
}

export default function ConsequenceDialog({
  copy,
  plan = null,
  plans,
  planLoading = false,
  planFailure = null,
  onConfirm,
  onClose,
}: {
  copy: ConsequenceCopy;
  plan?: IntegrationMutationPlan | null;
  plans?: readonly LabeledIntegrationPlan[];
  planLoading?: boolean;
  planFailure?: string | null;
  onConfirm: (plan?: IntegrationMutationPlan) => Promise<void> | void;
  onClose: () => void;
}) {
  const t = useT();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [activePlan, setActivePlan] = useState(plan);
  const [stale, setStale] = useState(false);
  const titleId = "integration-consequence-dialog-title";
  const planRequired = plan !== null || planLoading || planFailure !== null || plans !== undefined;

  useEffect(() => {
    setActivePlan(plan);
    setStale(false);
  }, [plan]);

  useEffect(() => {
    const dialog = dialogRef.current;
    const active = document.activeElement;
    triggerRef.current = active?.tagName === "BUTTON" ? active as HTMLElement : null;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
      if (triggerRef.current?.isConnected) triggerRef.current.focus?.();
    };
  }, []);

  const handleCancel = useCallback((event: React.SyntheticEvent) => {
    event.preventDefault();
    if (!pending && !planLoading) onClose();
  }, [onClose, pending, planLoading]);

  const confirm = useCallback(async () => {
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      await onConfirm(activePlan ?? undefined);
    } catch (error) {
      if (error instanceof IntegrationApiError && error.stalePlan) {
        setActivePlan(error.stalePlan);
        setStale(true);
        setPending(false);
        return;
      }
      setFailure(error instanceof Error ? error.message : t("integrations.error.generic"));
      setPending(false);
    }
  }, [activePlan, onConfirm, pending, t]);

  const slots: ReactNode[] = [
    <CopySlot key="changes" copyKey={copy.changesKey} vars={copy.vars} />,
    <CopySlot key="breakage" copyKey={copy.breakageKey} vars={copy.vars} />,
    <CopySlot key="undo" copyKey={copy.undoKey} vars={copy.vars} />,
  ];
  if (copy.sideEffectKey) {
    slots.push(<CopySlot key="side-effect" copyKey={copy.sideEffectKey} vars={copy.vars} />);
  }

  return (
    <dialog
      ref={dialogRef}
      className="modal-overlay"
      aria-labelledby={titleId}
      onCancel={handleCancel}
    >
      <button
        type="button"
        className="modal-backdrop-dismiss"
        aria-label={t("common.close")}
        tabIndex={-1}
        onClick={() => { if (!pending && !planLoading) onClose(); }}
      />
      <div className="modal-card integration-consequence-dialog" role="document">
        <div className="modal-head">
          <h3 id={titleId}>{t(copy.titleKey, copy.vars)}</h3>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} disabled={pending || planLoading}>
            {t("common.close")}
          </button>
        </div>
        <div className="integration-consequence-body">{slots}</div>
        <div role="status" aria-live="polite" aria-atomic="true">
          {planLoading && <p>{t("integrations.preview.loading")}</p>}
          {stale && <Notice tone="err">{t("integrations.preview.stale")}</Notice>}
          {planFailure && <Notice tone="err">{planFailure}</Notice>}
        </div>
        <IntegrationPlanDetails plan={activePlan} plans={plans} />
        {failure && <Notice tone="err">{failure}</Notice>}
        <div className="modal-actions">
          <button type="button" className="btn btn-primary" onClick={() => void confirm()} disabled={pending || planLoading || Boolean(planFailure) || (planRequired && !activePlan && (!plans || plans.length === 0)) || activePlan?.canApply === false}>
            {t(copy.confirmKey)}
          </button>
        </div>
      </div>
    </dialog>
  );
}
