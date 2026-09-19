import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../../i18n/shared";
import { Notice } from "../../ui";
import { describeRefusal } from "./refusal-copy";
import IntegrationPlanDetails from "./IntegrationPlanDetails";
import {
  bindingFor,
  IntegrationApiError,
  isIntegrationPreviewUnavailable,
  previewIntegrationRestore,
  restoreIntegration,
  type IntegrationJournalRow,
  type IntegrationMutationPlan,
} from "./integration-api";

interface BoundRestorePlan {
  plan: IntegrationMutationPlan;
  confirmDrift: boolean;
}

/**
 * Restore confirmation, including the drift second step.
 *
 * The server refuses a restore whose file changed after the snapshot unless
 * `confirmDrift` is set. That refusal is not an error to swallow — it is the
 * only moment the user is told their newer edits are about to be replaced, so
 * it escalates the dialog in place rather than closing it.
 *
 * The modal lifecycle is ConsequenceDialog's, not `<dialog open>`. An open
 * non-modal dialog leaves the page behind it focusable and in the accessibility
 * tree, so Tab walked straight out of a confirmation that is about to overwrite
 * a file, and the inline full-screen style block existed only to fake the
 * backdrop the modal state provides for free.
 */
export default function RestoreDialog({
  apiBase,
  row,
  onClose,
  onRestored,
  profileId,
  onReconcile,
}: {
  apiBase: string;
  row: IntegrationJournalRow;
  onClose: () => void;
  onRestored: () => void;
  profileId?: number;
  onReconcile?: () => void;
}) {
  const t = useT();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const restoreFallbackRef = useRef<HTMLElement | null>(null);
  const restoredRef = useRef(false);
  const onCloseRef = useRef(onClose);
  const onRestoredRef = useRef(onRestored);
  const onReconcileRef = useRef(onReconcile);
  const tRef = useRef(t);
  const previewAbortRef = useRef<AbortController | null>(null);
  const previewGenerationRef = useRef(0);
  const [boundPlan, setBoundPlan] = useState<BoundRestorePlan | null>(null);
  const [previewPending, setPreviewPending] = useState(true);
  const [stale, setStale] = useState(false);
  const [pending, setPending] = useState(false);
  const [previewFailure, setPreviewFailure] = useState<string | null>(null);
  const [mutationFailure, setMutationFailure] = useState<string | null>(null);
  const scopedProfileId = row.clientId === "aside" ? profileId ?? row.profileId : undefined;
  const plan = boundPlan?.plan ?? null;
  const drift = plan?.foreignEdit === "drift";

  useEffect(() => {
    onCloseRef.current = onClose;
    onRestoredRef.current = onRestored;
    onReconcileRef.current = onReconcile;
    tRef.current = t;
  }, [onClose, onReconcile, onRestored, t]);

  const dismiss = useCallback(() => {
    if (pending) return;
    previewGenerationRef.current += 1;
    previewAbortRef.current?.abort();
    previewAbortRef.current = null;
    onCloseRef.current();
  }, [pending]);

  useEffect(() => {
    const dialog = dialogRef.current;
    // Duck-typed on purpose: `instanceof HTMLElement` reads a constructor that
    // is not a global in the happy-dom test window, and the overview's own
    // focus-restore uses the same tagName check.
    const active = document.activeElement;
    restoreFocusRef.current = active?.tagName === "BUTTON" ? active as HTMLElement : null;
    // The trigger may not survive the asynchronous history refresh. A row whose
    // snapshot is consumed re-renders as an `expired` badge with no button
    // (RollbackHistory.tsx:44-46), so remember the enclosing region too: it
    // remains a focus target after the trigger disappears (#3059).
    restoreFallbackRef.current =
      (active?.closest?.("section, [role='region'], main") as HTMLElement | null) ?? null;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
      const fallback = restoreFallbackRef.current;
      // A successful restore starts the history refresh before it closes the
      // dialog. The trigger is therefore still connected during this cleanup,
      // but can disappear when the asynchronous refresh consumes its snapshot.
      // Put successful restores on the stable region now; cancellation keeps
      // the usual trigger restoration below.
      if (restoredRef.current && fallback?.isConnected) {
        // A region is not focusable by default; -1 makes it programmatically
        // focusable without adding it to the Tab order.
        if (!fallback.hasAttribute("tabindex")) fallback.setAttribute("tabindex", "-1");
        fallback.focus?.();
        return;
      }
      // Prefer the trigger when the user cancelled; fall back to its region
      // only if it was already removed. `isConnected` is the check that
      // matters: a detached node accepts .focus() silently and focus stays on
      // <body>, which is the reported symptom.
      const trigger = restoreFocusRef.current;
      if (trigger?.isConnected) {
        trigger.focus?.();
        return;
      }
      if (!fallback?.isConnected) return;
      if (!fallback.hasAttribute("tabindex")) fallback.setAttribute("tabindex", "-1");
      fallback.focus?.();
    };
  }, []);

  const loadPreview = useCallback(async () => {
    const controller = new AbortController();
    const generation = previewGenerationRef.current + 1;
    previewGenerationRef.current = generation;
    previewAbortRef.current?.abort();
    previewAbortRef.current = controller;
    setPreviewPending(true);
    setPreviewFailure(null);
    setMutationFailure(null);
    setBoundPlan(null);
    setStale(false);
    try {
      let confirmDrift = false;
      let next = await previewIntegrationRestore(apiBase, row.opId, confirmDrift, controller.signal, scopedProfileId);
      if (next.refusalReason === "drift_requires_confirm") {
        confirmDrift = true;
        next = await previewIntegrationRestore(apiBase, row.opId, confirmDrift, controller.signal, scopedProfileId);
      }
      if (controller.signal.aborted || generation !== previewGenerationRef.current) return;
      setBoundPlan({ plan: next, confirmDrift });
    } catch (error) {
      if (controller.signal.aborted || generation !== previewGenerationRef.current) return;
      if (isIntegrationPreviewUnavailable(error)) {
        onReconcileRef.current?.();
        onCloseRef.current();
        return;
      }
      setPreviewFailure(tRef.current("integrations.preview.failed"));
    } finally {
      if (!controller.signal.aborted && generation === previewGenerationRef.current) {
        previewAbortRef.current = null;
        setPreviewPending(false);
      }
    }
  }, [apiBase, row.opId, scopedProfileId]);

  useEffect(() => {
    const timeout = window.setTimeout(() => { void loadPreview(); }, 0);
    return () => {
      window.clearTimeout(timeout);
      previewGenerationRef.current += 1;
      previewAbortRef.current?.abort();
      previewAbortRef.current = null;
    };
  }, [loadPreview]);

  const handleCancel = useCallback((event: React.SyntheticEvent) => {
    event.preventDefault();
    dismiss();
  }, [dismiss]);

  const submit = async () => {
    if (pending || previewPending || !boundPlan || !boundPlan.plan.canApply) return;
    const attemptedConfirmDrift = boundPlan.confirmDrift;
    setPending(true);
    setMutationFailure(null);
    try {
      await restoreIntegration(apiBase, {
        opId: row.opId,
        confirmDrift: attemptedConfirmDrift,
        profileId: scopedProfileId,
        binding: bindingFor(boundPlan.plan),
      });
      restoredRef.current = true;
      onRestoredRef.current();
      onCloseRef.current();
    } catch (error) {
      // Aside may have saved target intent before the writer refused. Reconcile
      // without closing the dialog or announcing a successful restore.
      if (row.clientId === "aside") onReconcileRef.current?.();
      if (error instanceof IntegrationApiError && error.stalePlan) {
        let fresh = error.stalePlan;
        let freshConfirmDrift = attemptedConfirmDrift;
        setPending(false);
        try {
          if (fresh.refusalReason === "drift_requires_confirm") {
            const controller = new AbortController();
            const generation = previewGenerationRef.current + 1;
            previewGenerationRef.current = generation;
            previewAbortRef.current?.abort();
            previewAbortRef.current = controller;
            setPreviewPending(true);
            freshConfirmDrift = true;
            try {
              fresh = await previewIntegrationRestore(apiBase, row.opId, freshConfirmDrift, controller.signal, scopedProfileId);
            } finally {
              if (!controller.signal.aborted && generation === previewGenerationRef.current) {
                previewAbortRef.current = null;
                setPreviewPending(false);
              }
            }
            if (controller.signal.aborted || generation !== previewGenerationRef.current) return;
          }
        } catch (previewError) {
          if (previewError instanceof Error && previewError.name === "AbortError") return;
          if (isIntegrationPreviewUnavailable(previewError)) {
            onReconcileRef.current?.();
            onCloseRef.current();
            return;
          }
          setPreviewFailure(tRef.current("integrations.preview.failed"));
          return;
        }
        setBoundPlan({ plan: fresh, confirmDrift: freshConfirmDrift });
        setStale(true);
        return;
      }
      // Shared formatter so a residual write — compensation itself failed, the
      // file may be intermediate — is disclosed here too, not only its path.
      setMutationFailure(describeRefusal(t, error));
      setPending(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="modal-overlay"
      aria-labelledby="integration-restore-title"
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
      <div className="modal-card integration-restore-dialog" role="document">
        <div className="modal-head">
          <h3 id="integration-restore-title">
            {drift ? t("integrations.restore.driftTitle") : t("integrations.restore.title")}
          </h3>
        </div>
        <div className="modal-desc">
          {drift ? t("integrations.restore.driftBody") : t("integrations.restore.body")}
        </div>
        <div role="status" aria-live="polite" aria-atomic="true">
          {previewPending && <p>{t("integrations.preview.loading")}</p>}
          {pending && <p>{t("integrations.mutation.pending")}</p>}
          {stale && <Notice tone="err">{t("integrations.preview.stale")}</Notice>}
        </div>
        <IntegrationPlanDetails plan={plan} />
        {previewFailure && <Notice tone="err">{previewFailure}</Notice>}
        {mutationFailure && <Notice tone="err">{mutationFailure}</Notice>}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={dismiss} disabled={pending}>
            {t("common.cancel")}
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={pending || previewPending || !plan?.canApply || Boolean(previewFailure)}>
            {pending
              ? t("integrations.restore.pending")
              : drift
                ? t("integrations.restore.confirmDrift")
                : t("integrations.restore.confirm")}
          </button>
        </div>
      </div>
    </dialog>
  );
}
