import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useT } from "../i18n/shared";
import {
  TELEMETRY_POLICY_URL,
  TELEMETRY_STATUS_CHANGED_EVENT,
  fetchTelemetryStatus,
  formatTelemetryPreviewJson,
  hasOtherOpenModalDialog,
  isTelemetryConsentSessionRefused,
  putTelemetryDecision,
  shouldShowTelemetryConsentPrompt,
  subscribeModalDialogChanges,
  TelemetrySaveError,
  type TelemetryStatusSnapshot,
} from "../telemetry-api";
import { Notice } from "../ui";

const CONSENT_DIALOG_SELECTOR = "dialog.telemetry-consent-overlay";

/**
 * First-run and post-update telemetry disclosure dialog.
 *
 * Opens only after DesktopStarOnboarding has settled, and only when the proxy reports an
 * undecided install with no environment override. Opening or dismissing the dialog
 * (Escape or backdrop) records nothing so the prompt returns on the next app start while
 * undecided; only Continue records the checkbox decision and notice via PUT /api/telemetry.
 */
export function TelemetryConsentCard({
  apiBase,
  enabled,
}: {
  apiBase: string;
  enabled: boolean;
}) {
  const [status, setStatus] = useState<TelemetryStatusSnapshot | null>(null);
  const [closed, setClosed] = useState(false);
  const [, setModalRevision] = useState(0);
  const externalUpdateRef = useRef(false);

  useEffect(() => {
    const onStatusChanged = (event: Event) => {
      const detail = (event as CustomEvent<TelemetryStatusSnapshot | undefined>).detail;
      if (!detail) return;
      externalUpdateRef.current = true;
      setStatus(detail);
      if (!shouldShowTelemetryConsentPrompt(detail)) {
        setClosed(true);
      }
    };
    window.addEventListener(TELEMETRY_STATUS_CHANGED_EVENT, onStatusChanged);
    return () => {
      window.removeEventListener(TELEMETRY_STATUS_CHANGED_EVENT, onStatusChanged);
    };
  }, []);

  useEffect(() => {
    if (!enabled || closed) return;
    const controller = new AbortController();
    void fetchTelemetryStatus(apiBase, controller.signal)
      .then(snapshot => {
        if (controller.signal.aborted || externalUpdateRef.current) return;
        if (!shouldShowTelemetryConsentPrompt(snapshot)) {
          setClosed(true);
          return;
        }
        setStatus(snapshot);
      })
      .catch(() => {
        // If status cannot be loaded, keep the dialog closed rather than blocking the dashboard.
      });
    return () => controller.abort();
  }, [apiBase, closed, enabled]);

  const wantsOpen = Boolean(
    enabled && !closed && status && shouldShowTelemetryConsentPrompt(status),
  );
  const blockedByOtherModal = wantsOpen && hasOtherOpenModalDialog(CONSENT_DIALOG_SELECTOR);

  useEffect(() => {
    if (!wantsOpen) return;
    let lastBlocked = hasOtherOpenModalDialog(CONSENT_DIALOG_SELECTOR);
    const check = () => {
      const nextBlocked = hasOtherOpenModalDialog(CONSENT_DIALOG_SELECTOR);
      if (nextBlocked !== lastBlocked) {
        lastBlocked = nextBlocked;
        setModalRevision(rev => rev + 1);
      }
    };
    check();
    return subscribeModalDialogChanges(check);
  }, [wantsOpen]);

  const handleClose = useCallback(() => {
    setClosed(true);
  }, []);

  if (!wantsOpen || blockedByOtherModal || !status) return null;
  return <TelemetryConsentDialog apiBase={apiBase} status={status} onClose={handleClose} />;
}

function TelemetryConsentDialog({
  apiBase,
  status,
  onClose,
}: {
  apiBase: string;
  status: TelemetryStatusSnapshot;
  onClose: () => void;
}) {
  const t = useT();
  const titleId = useId();
  const bodyId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [checked, setChecked] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [saveError, setSaveError] = useState<"failed" | "session" | null>(null);
  const busyRef = useRef(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) {
      if (typeof dialog.showModal === "function") {
        dialog.showModal();
      } else {
        dialog.setAttribute("open", "");
      }
    }
    // showModal() focuses the dialog's first focusable element, so move focus to the heading after
    // it: the dialog can open while someone is typing, and a stray Enter must not accept.
    headingRef.current?.focus();
    return () => {
      if (dialog?.open) dialog.close?.();
    };
  }, []);

  const handleContinue = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setSubmitting(true);
    setSaveError(null);
    try {
      await putTelemetryDecision(apiBase, checked ? "accepted" : "declined", status);
      onClose();
    } catch (error) {
      if (!(error instanceof TelemetrySaveError)) {
        // The request dropped or timed out, and the server may still have saved the choice.
        const saved = await fetchTelemetryStatus(apiBase)
          .then(snapshot => snapshot.decision !== null)
          .catch(() => false);
        if (saved) {
          onClose();
          return;
        }
      }
      busyRef.current = false;
      setSubmitting(false);
      setSaveError(isTelemetryConsentSessionRefused(error) ? "session" : "failed");
    }
  }, [apiBase, checked, onClose, status]);

  const handleDismiss = useCallback(() => {
    if (busyRef.current) return;
    onClose();
  }, [onClose]);

  const handleCancel = useCallback(
    (event: React.SyntheticEvent) => {
      event.preventDefault();
      handleDismiss();
    },
    [handleDismiss],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDialogElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        handleDismiss();
      }
    },
    [handleDismiss],
  );

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      className="modal-overlay telemetry-consent-overlay"
      onCancel={handleCancel}
      onKeyDown={handleKeyDown}
    >
      <button
        type="button"
        className="modal-backdrop-dismiss"
        aria-label={t("common.close")}
        tabIndex={-1}
        onClick={handleDismiss}
      />
      <div className="modal-card telemetry-consent-card flex flex-col gap-3" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <h3 ref={headingRef} id={titleId} className="m-0" tabIndex={-1}>
            {t("proxyV2.telemetryConsentTitle")}
          </h3>
        </div>
        <p id={bodyId} className="modal-desc m-0">
          {t("proxyV2.telemetryConsentBody")}
        </p>
        <div className="flex flex-col gap-2 rounded-control bg-raised p-3 text-[13px] leading-[19px]">
          <div>
            <strong className="text-fg">{t("proxyV2.telemetrySentTitle")}: </strong>
            <span className="text-fg-muted">{t("proxyV2.telemetrySentItems")}</span>
          </div>
          <div>
            <strong className="text-fg">{t("proxyV2.telemetryNeverTitle")}: </strong>
            <span className="text-fg-muted">{t("proxyV2.telemetryNeverItems")}</span>
          </div>
          <a
            className="telemetry-policy-link w-fit font-medium text-highlight hover:underline"
            href={TELEMETRY_POLICY_URL}
            target="_blank"
            rel="noreferrer"
          >
            {t("proxyV2.telemetryPolicyLink")}
          </a>
        </div>
        <label className="flex cursor-pointer items-start gap-3 rounded-control bg-raised p-3 ring-1 ring-line">
          <input
            type="checkbox"
            className="telemetry-consent-checkbox mt-0.5 size-4 shrink-0 cursor-pointer"
            checked={checked}
            disabled={submitting}
            onChange={e => setChecked(e.target.checked)}
          />
          <span className="text-[13px] leading-[19px] text-fg">{t("proxyV2.telemetryConsentCheckbox")}</span>
        </label>
        <details className="telemetry-preview-details pv2-more">
          <summary>{t("proxyV2.telemetryWhatIsSent")}</summary>
          <div className="mt-2 flex flex-col gap-2">
            <p className="m-0 text-[12px] text-fg-muted">{t("proxyV2.telemetryPreviewHint")}</p>
            {status.previewEligible === false && (
              <p className="telemetry-preview-ineligible m-0 text-[12px] text-fg-muted">
                {t("proxyV2.telemetryPreviewIneligible")}
              </p>
            )}
            <pre className="log-detail-json telemetry-preview-json">{formatTelemetryPreviewJson(status)}</pre>
          </div>
        </details>
        {saveError && (
          <Notice tone="err">
            {t(saveError === "session" ? "proxyV2.telemetrySaveNeedsHumanSession" : "proxyV2.telemetrySaveFailed")}
          </Notice>
        )}
        <div className="modal-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={submitting}
            onClick={() => {
              void handleContinue();
            }}
          >
            {t("proxyV2.telemetryConsentContinue")}
          </button>
        </div>
      </div>
    </dialog>
  );
}

export default TelemetryConsentCard;
