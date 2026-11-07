import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useT } from "../i18n/shared";
import {
  fetchTelemetryStatus,
  formatTelemetryPreviewJson,
  postTelemetryNotice,
  putTelemetryDecision,
  shouldShowTelemetryConsentPrompt,
  type TelemetryStatusSnapshot,
} from "../telemetry-api";
import { Notice } from "../ui";

/**
 * First-run and post-update telemetry disclosure dialog.
 *
 * Opens only after DesktopStarOnboarding has settled, and only when the proxy reports an
 * undecided install with no environment override. Opening the dialog records nothing;
 * Continue records the checkbox decision via PUT /api/telemetry, and dismissing via Escape
 * or backdrop records only that the notice was seen via POST /api/telemetry/notice.
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

  useEffect(() => {
    if (!enabled || closed) return;
    const controller = new AbortController();
    void fetchTelemetryStatus(apiBase, controller.signal)
      .then(snapshot => {
        if (controller.signal.aborted) return;
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

  const handleClose = useCallback(() => {
    setClosed(true);
  }, []);

  if (!enabled || closed || !status) return null;
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
  const [checked, setChecked] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const busyRef = useRef(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) {
      dialog.showModal?.();
    }
  }, []);

  const handleContinue = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setSubmitting(true);
    setSaveError(false);
    try {
      await putTelemetryDecision(apiBase, checked ? "accepted" : "declined", status);
      onClose();
    } catch {
      busyRef.current = false;
      setSubmitting(false);
      setSaveError(true);
    }
  }, [apiBase, checked, onClose, status]);

  const handleDismiss = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setSubmitting(true);
    setSaveError(false);
    try {
      await postTelemetryNotice(apiBase, status);
    } catch {
      // Dismissal never traps the user inside the modal even if the notice write fails.
    }
    onClose();
  }, [apiBase, onClose, status]);

  const handleCancel = useCallback(
    (event: React.SyntheticEvent) => {
      event.preventDefault();
      void handleDismiss();
    },
    [handleDismiss],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDialogElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        void handleDismiss();
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
        onClick={() => {
          void handleDismiss();
        }}
      />
      <div className="modal-card telemetry-consent-card flex flex-col gap-3" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <h3 id={titleId} className="m-0">
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
            <pre className="log-detail-json telemetry-preview-json">{formatTelemetryPreviewJson(status)}</pre>
          </div>
        </details>
        {saveError && <Notice tone="err">{t("proxyV2.telemetrySaveFailed")}</Notice>}
        <div className="modal-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={submitting}
            onClick={() => {
              void handleContinue();
            }}
            autoFocus
          >
            {t("proxyV2.telemetryConsentContinue")}
          </button>
        </div>
      </div>
    </dialog>
  );
}

export default TelemetryConsentCard;
