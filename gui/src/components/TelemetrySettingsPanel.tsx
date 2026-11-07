import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useT } from "../i18n/shared";
import { IconX } from "../icons";
import {
  TELEMETRY_STATUS_CHANGED_EVENT,
  fetchTelemetryStatus,
  formatTelemetryPreviewJson,
  hasOtherOpenModalDialog,
  putTelemetryDecision,
  subscribeModalDialogChanges,
  type TelemetryDecision,
  type TelemetryStatusSnapshot,
} from "../telemetry-api";
import { Notice, Switch } from "../ui";
import { startVisibilityPoll } from "../visibility-poll";
import { SettingsRow } from "./v2-proxy/settings-layout";

const PREVIEW_DIALOG_SELECTOR = "dialog.telemetry-preview-overlay";

/**
 * Proxy details row and preview dialog for anonymous daily usage telemetry.
 */
export function TelemetrySettingsPanel({
  apiBase,
  readOnly = false,
}: {
  apiBase: string;
  readOnly?: boolean;
}) {
  const t = useT();
  const [status, setStatus] = useState<TelemetryStatusSnapshot | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [, setModalRevision] = useState(0);
  const savingRef = useRef(false);
  const seqRef = useRef(0);
  const previewTriggerRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLButtonElement | null>(null);
  const previewDialogRef = useRef<HTMLDialogElement>(null);
  const previewCloseBtnRef = useRef<HTMLButtonElement>(null);
  const previewTitleId = useId();
  const previewDescId = useId();

  const load = useCallback(async () => {
    if (savingRef.current) return;
    const seq = ++seqRef.current;
    try {
      const next = await fetchTelemetryStatus(apiBase);
      if (!savingRef.current && seq === seqRef.current) {
        setStatus(next);
        setLoadFailed(false);
      }
    } catch {
      if (!savingRef.current && seq === seqRef.current) {
        setLoadFailed(true);
      }
    }
  }, [apiBase]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void load();
    }, 0);
    const stop = startVisibilityPoll(() => {
      void load();
    }, 30_000);
    const onExternalChange = (event: Event) => {
      const detail = (event as CustomEvent<TelemetryStatusSnapshot | undefined>).detail;
      if (detail && !savingRef.current) {
        seqRef.current += 1;
        setStatus(detail);
        setLoadFailed(false);
      }
    };
    window.addEventListener(TELEMETRY_STATUS_CHANGED_EVENT, onExternalChange);
    return () => {
      window.clearTimeout(timeout);
      stop();
      window.removeEventListener(TELEMETRY_STATUS_CHANGED_EVENT, onExternalChange);
    };
  }, [load]);

  useEffect(() => {
    if (!previewOpen) return;
    let lastBlocked = hasOtherOpenModalDialog(PREVIEW_DIALOG_SELECTOR);
    const check = () => {
      const nextBlocked = hasOtherOpenModalDialog(PREVIEW_DIALOG_SELECTOR);
      if (nextBlocked !== lastBlocked) {
        lastBlocked = nextBlocked;
        setModalRevision(rev => rev + 1);
      }
    };
    check();
    return subscribeModalDialogChanges(check);
  }, [previewOpen]);

  const blockedByOtherModal = previewOpen && hasOtherOpenModalDialog(PREVIEW_DIALOG_SELECTOR);
  const showPreviewDialog = Boolean(previewOpen && status && !blockedByOtherModal);

  useEffect(() => {
    if (!showPreviewDialog) return;
    const dialog = previewDialogRef.current;
    if (dialog && !dialog.open) {
      if (typeof dialog.showModal === "function") {
        dialog.showModal();
      } else {
        dialog.setAttribute("open", "");
      }
    }
    previewCloseBtnRef.current?.focus();
    return () => {
      if (dialog?.open) dialog.close?.();
    };
  }, [showPreviewDialog]);

  useEffect(() => {
    if (previewOpen) return;
    const trigger = restoreFocusRef.current;
    if (!trigger) return;
    restoreFocusRef.current = null;
    if (trigger.isConnected) trigger.focus();
  }, [previewOpen]);

  const closePreview = useCallback(() => {
    if (previewDialogRef.current?.open) {
      previewDialogRef.current.close?.();
    }
    setPreviewOpen(false);
  }, []);

  const effective = status?.effective ?? false;
  const envOverride = status?.envOverride ?? null;
  const switchDisabled = !status || saving || readOnly || envOverride !== null;

  const handleToggle = useCallback(async () => {
    if (savingRef.current || !status || readOnly || status.envOverride !== null) return;
    const nextDecision: TelemetryDecision = status.effective ? "declined" : "accepted";
    savingRef.current = true;
    seqRef.current += 1;
    setSaving(true);
    setSaveFailed(false);
    try {
      const updated = await putTelemetryDecision(apiBase, nextDecision, status);
      seqRef.current += 1;
      setStatus(updated);
      setLoadFailed(false);
    } catch {
      setSaveFailed(true);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [apiBase, readOnly, status]);

  const envVarDisplay =
    envOverride === "DO_NOT_TRACK"
      ? "DO_NOT_TRACK=1"
      : envOverride === "OCX_TELEMETRY"
        ? "OCX_TELEMETRY=0"
        : null;

  return (
    <>
      <SettingsRow
        className="telemetry-settings-row"
        label={t("proxyV2.telemetryToggleLabel")}
        hint={t(readOnly ? "proxyV2.telemetryReadOnlyHint" : "proxyV2.telemetryToggleHint")}
        details={t("proxyV2.telemetryDetails")}
        busy={!status && !loadFailed}
        control={
          <div className="flex items-center gap-2">
            {loadFailed && !status && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={saving}
                onClick={() => {
                  void load();
                }}
              >
                {t("common.retry")}
              </button>
            )}
            <button
              ref={previewTriggerRef}
              type="button"
              className="btn btn-ghost btn-sm telemetry-preview-trigger"
              disabled={!status}
              aria-haspopup="dialog"
              aria-expanded={showPreviewDialog}
              onClick={() => {
                restoreFocusRef.current = previewTriggerRef.current;
                setPreviewOpen(true);
              }}
            >
              {t("proxyV2.telemetryWhatIsSent")}
            </button>
            <Switch
              on={effective}
              label={t("proxyV2.telemetryToggleLabel")}
              disabled={switchDisabled}
              onClick={() => {
                void handleToggle();
              }}
            />
          </div>
        }
      >
        {envVarDisplay && (
          <Notice tone="warn">{t("proxyV2.telemetryEnvOverride", { envVar: envVarDisplay })}</Notice>
        )}
        {loadFailed && !status && <Notice tone="err">{t("proxyV2.telemetryLoadFailed")}</Notice>}
        {saveFailed && <Notice tone="err">{t("proxyV2.telemetrySaveFailed")}</Notice>}
      </SettingsRow>

      {showPreviewDialog && status && (
        <dialog
          ref={previewDialogRef}
          aria-labelledby={previewTitleId}
          aria-describedby={previewDescId}
          className="modal-overlay telemetry-preview-overlay"
          onCancel={event => {
            event.preventDefault();
            closePreview();
          }}
          onKeyDown={event => {
            if (event.key === "Escape") {
              event.preventDefault();
              closePreview();
            }
          }}
        >
          <button
            type="button"
            className="modal-backdrop-dismiss"
            aria-label={t("common.close")}
            tabIndex={-1}
            onClick={closePreview}
          />
          <div className="modal-card telemetry-preview-dialog flex flex-col gap-3" onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              <h3 id={previewTitleId} className="m-0">
                {t("proxyV2.telemetryWhatIsSent")}
              </h3>
              <button
                type="button"
                className="btn btn-ghost btn-icon"
                onClick={closePreview}
                aria-label={t("common.close")}
              >
                <IconX />
              </button>
            </div>
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
            <p id={previewDescId} className="modal-desc m-0">
              {t("proxyV2.telemetryPreviewHint")}
            </p>
            {status.previewEligible === false && (
              <p className="telemetry-preview-ineligible m-0 text-[12px] text-fg-muted">
                {t("proxyV2.telemetryPreviewIneligible")}
              </p>
            )}
            <pre className="log-detail-json telemetry-preview-json">{formatTelemetryPreviewJson(status)}</pre>
            <div className="modal-actions">
              <button
                ref={previewCloseBtnRef}
                type="button"
                className="btn btn-primary"
                onClick={closePreview}
                autoFocus
              >
                {t("common.close")}
              </button>
            </div>
          </div>
        </dialog>
      )}
    </>
  );
}

export default TelemetrySettingsPanel;
