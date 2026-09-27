import { useId, type RefObject } from "react";
import { useT } from "../i18n/shared";
import { useModalDialog } from "../pages/dashboard-shared";
import { kiroVerificationLink } from "../kiro-device-login-helpers";
import { useCopyFeedback } from "./use-copy-feedback";
import { useKiroDeviceLogin } from "./use-kiro-device-login";
import KiroLoginChooser from "./KiroLoginChooser";
import type { KiroFinalOutcome } from "../kiro-device-login-finalizer";
import "../styles/kiro-device-login.css";

export default function KiroDeviceLoginDialog({ apiBase, triggerRef, addAccount, busy, onCli, onClose, onSettled,
  pollDelay }: {
  apiBase: string;
  triggerRef: RefObject<HTMLButtonElement | null>;
  addAccount: boolean;
  busy: boolean;
  onCli: (addAccount: boolean) => void;
  onClose: () => void;
  onSettled?: (provider: string, outcome: KiroFinalOutcome) => void;
  pollDelay?: (ms: number) => Promise<void>;
}) {
  const t = useT();
  const titleId = useId();
  const dialogRef = useModalDialog(true, triggerRef);
  const login = useKiroDeviceLogin(apiBase, onSettled, pollDelay);
  const copy = useCopyFeedback<string>();
  const { state } = login;
  const view = state.view;
  const destination = view?.verificationUriComplete ?? view?.verificationUri;
  const safeLink = kiroVerificationLink(destination);
  const cancel = () => { void login.close(); onClose(); };
  return (
    <dialog ref={dialogRef} className="kiro-device-dialog" aria-modal="true" aria-labelledby={titleId}
      onCancel={event => { event.preventDefault(); cancel(); }}>
      <h2 id={titleId}>{t("kiroLogin.title")}</h2>
      {state.phase === "idle" && (
        <>
          <p className="muted">{t(addAccount ? "kiroLogin.addDescription" : "kiroLogin.loginDescription")}</p>
          <KiroLoginChooser disabled={busy} onCli={() => { onClose(); onCli(addAccount); }} onMethod={method => { void login.start(method); }} />
        </>
      )}
      {state.phase === "starting" && <p role="status" aria-live="polite">{t("kiroLogin.starting")}</p>}
      {view && (state.phase === "pending" || state.phase === "done" || state.phase === "failed" || state.phase === "expired" || state.phase === "ended") && (
        <>
          {view.userCode && (
            <div className="kiro-device-code">
              <span className="kiro-device-code-value">{view.userCode}</span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => copy.copy(view.userCode!, view.flowId)}>
                {copy.outcomeFor(view.flowId) === "copied" ? t("kiroLogin.copied") : copy.outcomeFor(view.flowId) === "unavailable" ? t("kiroLogin.copyUnavailable") : t("kiroLogin.copyCode")}
              </button>
            </div>
          )}
          {destination && (safeLink
            ? <a href={safeLink} target="_blank" rel="noopener noreferrer">{t("kiroLogin.openVerification")}</a>
            : <><p className="kiro-device-destination">{destination}</p><p className="notice-warn">{t("kiroLogin.unexpectedHost")}</p></>)}
          {view.warning === "duplicate_profile_arn" && <p className="notice-warn">{t("kiroLogin.duplicate")}</p>}
          {view.warning === "manual_review_required" && <p className="notice-warn">{t("kiroLogin.manualReview")}</p>}
        </>
      )}
      <p role="status" aria-live="polite">
        {state.phase === "pending" && t("kiroLogin.pending")}
        {state.phase === "done" && t("kiroLogin.done")}
        {state.phase === "expired" && t("kiroLogin.expired")}
        {state.phase === "ended" && t("kiroLogin.ended")}
        {state.phase === "failed" && t(state.error === "start" ? "kiroLogin.startFailed" : "kiroLogin.failed")}
      </p>
      <div className="kiro-device-actions">
        {(state.phase === "failed" || state.phase === "expired" || state.phase === "ended") && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={login.reset}>{t("kiroLogin.tryAgain")}</button>
        )}
        <button type="button" className="btn btn-ghost btn-sm" onClick={cancel}>{t("common.cancel")}</button>
      </div>
    </dialog>
  );
}
