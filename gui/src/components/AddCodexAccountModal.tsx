import { useCallback, useEffect, useReducer, useRef } from "react";
import { useT } from "../i18n/shared";
import {
  addCodexAccountUiReducer,
  initialAddCodexAccountUiState,
} from "./add-codex-account-reducer";
import { AddCodexAccountPickStep } from "./add-codex-account-pick-step";
import { AddCodexAccountWaitingStep } from "./add-codex-account-waiting-step";
import { useAddCodexAccountOAuth } from "./use-add-codex-account-oauth";
import type { CodexAccountMutationCompletion } from "../codex-account-mutation";

export default function AddCodexAccountModal({
  apiBase, onClose, onAdded, reauthAccountId,
}: {
  apiBase: string;
  onClose: () => void;
  onAdded: (completion: CodexAccountMutationCompletion) => void;
  reauthAccountId?: string;
}) {
  const t = useT();
  const [ui, dispatch] = useReducer(addCodexAccountUiReducer, reauthAccountId, initialAddCodexAccountUiState);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  const oauth = useAddCodexAccountOAuth({ apiBase, reauthAccountId, ui, dispatch, t });
  const { manualCodeBusy, manualCodeWaiting, bindCallbacks, closeModal, startOAuth, submitManualCode } = oauth;

  useEffect(() => {
    bindCallbacks(onAdded, onClose);
  }, [bindCallbacks, onAdded, onClose]);

  useEffect(() => {
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    const focusable = dialog?.querySelector<HTMLElement>(
      "input:not([disabled]), button:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
    );
    if (focusable) focusable.focus();
    return () => {
      previousFocusRef.current?.focus();
    };
  }, []);

  const handleCancel = useCallback((e: React.SyntheticEvent) => {
    e.preventDefault();
    closeModal();
  }, [closeModal]);

  const dialogLabel = reauthAccountId ? t("codexAuth.reauthenticate") : t("codexAuth.addTitle");

  return (
    <dialog
      ref={dialogRef}
      aria-label={dialogLabel}
      className="modal-overlay"
      onCancel={handleCancel}
    >
      <div className="modal-card" style={{ maxWidth: 440 }}>
        {ui.step === "pick" && (
          <AddCodexAccountPickStep
            id={ui.id}
            error={ui.error}
            onIdChange={value => dispatch({ type: "set-id", id: value })}
            onStartOAuth={() => { void startOAuth(ui.id); }}
            onClose={closeModal}
          />
        )}
        {ui.step === "oauth-waiting" && (
          <AddCodexAccountWaitingStep
            reauthAccountId={reauthAccountId}
            authUrl={ui.authUrl}
            manualCode={ui.manualCode}
            manualCodeBusy={manualCodeBusy}
            manualCodeWaiting={manualCodeWaiting}
            statusNotice={ui.statusNotice}
            statusTone={ui.statusTone}
            flowId={ui.flowId}
            error={ui.error}
            onManualCodeChange={value => dispatch({ type: "set-manual-code", manualCode: value })}
            onSubmitManualCode={() => { void submitManualCode(); }}
            onClose={closeModal}
          />
        )}
      </div>
    </dialog>
  );
}
