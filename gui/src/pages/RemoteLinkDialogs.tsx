import type { ReactElement, RefObject } from "react";
import type { LinkRowWire } from "../remote-link-api";
import { Trans } from "../i18n/provider";
import { type TKey, useT } from "../i18n/shared";

export interface RemoteLinkDisconnectDialogProps {
  confirmRef: RefObject<HTMLDialogElement | null>;
  confirming: { row: LinkRowWire; force: boolean } | null;
  purge: boolean;
  onPurgeChange: (checked: boolean) => void;
  forceError: TKey | null;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

export function RemoteLinkDisconnectDialog({
  confirmRef,
  confirming,
  purge,
  onPurgeChange,
  forceError,
  busy,
  onClose,
  onConfirm,
}: RemoteLinkDisconnectDialogProps): ReactElement {
  const t = useT();
  const isEphemeral = confirming?.row.childKind === "ephemeral";
  const forceCmd = isEphemeral ? "~/.cache/opencodex/bin/ocx-child detach" : "ocx disconnect";

  return (
    <dialog ref={confirmRef} className="remote-link-confirm-dialog" aria-labelledby="remote-link-confirm-title" onCancel={event => { event.preventDefault(); onClose(); }}>
      {confirming && (
        <>
          <h3 id="remote-link-confirm-title">
            {confirming.force ? t("remoteLink.forceRemove.title", { alias: confirming.row.alias }) : t("link.disconnect")}
          </h3>
          <p>
            {confirming.force
              ? <Trans k="remoteLink.forceRemove.body" cmd={forceCmd} vars={{ alias: confirming.row.alias }} />
              : isEphemeral
                ? t("remoteLink.disconnect.ephemeralBody", { alias: confirming.row.alias })
                : t("link.disconnectConfirm", { alias: confirming.row.alias })}
          </p>
          {!confirming.force && isEphemeral && (
            <label className="remote-link-purge-option">
              <input type="checkbox" checked={purge} onChange={event => onPurgeChange(event.target.checked)} />
              <span>{t("remoteLink.disconnect.purgeLabel")}</span>
            </label>
          )}
          {forceError && <p className="remote-link-error" role="alert">{t(forceError)}</p>}
          <div className="remote-link-sheet-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose}>{t("link.cancel")}</button>
            <button type="button" className="btn btn-danger" onClick={onConfirm} disabled={busy}>
              {confirming.force
                ? t("remoteLink.forceRemove.confirm")
                : isEphemeral && purge
                  ? t("remoteLink.disconnect.purgeConfirm")
                  : t("link.disconnect")}
            </button>
          </div>
        </>
      )}
    </dialog>
  );
}

