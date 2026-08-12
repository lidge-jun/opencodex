import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useT, type TKey } from "../../i18n/shared";
import { Notice } from "../../ui";

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
  onConfirm,
  onClose,
}: {
  copy: ConsequenceCopy;
  onConfirm: () => Promise<void> | void;
  onClose: () => void;
}) {
  const t = useT();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const titleId = "integration-consequence-dialog-title";

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => { if (dialog?.open) dialog.close(); };
  }, []);

  const handleCancel = useCallback((event: React.SyntheticEvent) => {
    event.preventDefault();
    if (!pending) onClose();
  }, [onClose, pending]);

  const confirm = useCallback(async () => {
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      await onConfirm();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : t("integrations.error.generic"));
      setPending(false);
    }
  }, [onConfirm, pending, t]);

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
        onClick={() => { if (!pending) onClose(); }}
      />
      <div className="modal-card integration-consequence-dialog" role="document">
        <div className="modal-head">
          <h3 id={titleId}>{t(copy.titleKey, copy.vars)}</h3>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} disabled={pending}>
            {t("common.close")}
          </button>
        </div>
        <div className="integration-consequence-body">{slots}</div>
        {failure && <Notice tone="err">{failure}</Notice>}
        <div className="modal-actions">
          <button type="button" className="btn btn-primary" onClick={() => void confirm()} disabled={pending}>
            {t(copy.confirmKey)}
          </button>
        </div>
      </div>
    </dialog>
  );
}
