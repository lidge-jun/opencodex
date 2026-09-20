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

function planHasRollback(plan: IntegrationMutationPlan): boolean {
  return plan.changes.some(change => change.kind === "snapshot" || change.kind === "journal");
}

export default function ConsequenceDialog({
  copy,
  plan = null,
  plans,
  hasUnboundAction = false,
  planStale = false,
  planLoading = false,
  planFailure = null,
  onConfirm,
  onClose,
}: {
  copy: ConsequenceCopy;
  plan?: IntegrationMutationPlan | null;
  plans?: readonly LabeledIntegrationPlan[];
  hasUnboundAction?: boolean;
  planStale?: boolean;
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
  const [staleOverride, setStaleOverride] = useState<{
    sourceFingerprint: string | null;
    plan: IntegrationMutationPlan;
  } | null>(null);
  const titleId = "integration-consequence-dialog-title";
  const planRequired = plan !== null || planLoading || planFailure !== null || plans !== undefined;
  const activePlan = staleOverride?.sourceFingerprint === (plan?.fingerprint ?? null)
    ? staleOverride.plan
    : plan;
  const stale = staleOverride?.sourceFingerprint === (plan?.fingerprint ?? null);
  const noActionableBulkTarget = plans !== undefined
    && !hasUnboundAction
    && !plans.some(item => item.plan.canApply);
  const showUndo = !planRequired
    || (activePlan ? planHasRollback(activePlan) : plans?.some(item => planHasRollback(item.plan)) === true);
  const dismiss = useCallback(() => {
    if (!pending) onClose();
  }, [onClose, pending]);

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
    dismiss();
  }, [dismiss]);

  const confirm = useCallback(async () => {
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      await onConfirm(activePlan ?? undefined);
    } catch (error) {
      if (error instanceof IntegrationApiError && error.stalePlan) {
        setStaleOverride({ sourceFingerprint: plan?.fingerprint ?? null, plan: error.stalePlan });
        return;
      }
      setFailure(error instanceof Error ? error.message : t("integrations.error.generic"));
    } finally {
      setPending(false);
    }
  }, [activePlan, onConfirm, pending, plan?.fingerprint, t]);

  const slots: ReactNode[] = [
    <CopySlot key="changes" copyKey={copy.changesKey} vars={copy.vars} />,
    <CopySlot key="breakage" copyKey={copy.breakageKey} vars={copy.vars} />,
  ];
  if (showUndo) slots.push(<CopySlot key="undo" copyKey={copy.undoKey} vars={copy.vars} />);
  if (copy.sideEffectKey) {
    slots.push(<CopySlot key="side-effect" copyKey={copy.sideEffectKey} vars={copy.vars} />);
  }

  return (
    <dialog
      ref={dialogRef}
      className="modal-overlay"
      aria-labelledby={titleId}
      aria-busy={pending}
      onCancel={handleCancel}
    >
      <button
        type="button"
        className="modal-backdrop-dismiss"
        aria-label={t("common.close")}
        tabIndex={-1}
        onClick={dismiss}
      />
      <div className="modal-card integration-consequence-dialog" role="document">
        <div className="modal-head">
          <h3 id={titleId}>{t(copy.titleKey, copy.vars)}</h3>
          <button type="button" className="btn btn-ghost btn-sm" onClick={dismiss} disabled={pending}>
            {t("common.close")}
          </button>
        </div>
        <div className="integration-consequence-body">{slots}</div>
        <div role="status" aria-live="polite" aria-atomic="true">
          {planLoading && <p>{t("integrations.preview.loading")}</p>}
          {pending && <p>{t("integrations.mutation.pending")}</p>}
          {(stale || planStale) && <Notice tone="err">{t("integrations.preview.stale")}</Notice>}
          {planFailure && <Notice tone="err">{planFailure}</Notice>}
        </div>
        <IntegrationPlanDetails plan={activePlan} plans={plans} />
        {failure && <Notice tone="err">{failure}</Notice>}
        <div className="modal-actions">
          <button type="button" className="btn btn-primary" onClick={() => void confirm()} disabled={pending || planLoading || Boolean(planFailure) || (planRequired && !activePlan && plans === undefined) || noActionableBulkTarget || activePlan?.canApply === false}>
            {t(copy.confirmKey)}
          </button>
        </div>
      </div>
    </dialog>
  );
}
