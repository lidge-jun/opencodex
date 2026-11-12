import type { ReactElement, RefObject } from "react";
import type { LinkRowWire } from "../remote-link-api";
import { Trans } from "../i18n/provider";
import { type TKey, useT } from "../i18n/shared";
import { Button } from "@/components/ui-v2/button";

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
    <dialog ref={confirmRef} aria-labelledby="remote-link-confirm-title" onCancel={event => { event.preventDefault(); onClose(); }}
      className="remote-link-confirm-dialog m-auto w-[min(440px,calc(100vw-24px))] rounded-[14px] border-0 bg-surface p-1 text-fg shadow-lg ring-1 ring-line backdrop:bg-black/40">
      {confirming && <>
        <div className="flex flex-col gap-2 rounded-[10px] bg-bg px-5 py-4 ring-1 ring-line">
          <h3 id="remote-link-confirm-title" className="m-0 text-[16px] leading-6 font-semibold tracking-[-0.015em]">{confirming.force ? t("remoteLink.forceRemove.title", { alias: confirming.row.alias }) : t("link.disconnect")}</h3>
          <p className="m-0 text-[14px] leading-[21px] text-fg-muted">
            {confirming.force
              ? <Trans k="remoteLink.forceRemove.body" cmd={forceCmd} vars={{ alias: confirming.row.alias }} />
              : isEphemeral
                ? t("remoteLink.disconnect.ephemeralBody", { alias: confirming.row.alias })
                : t("link.disconnectConfirm", { alias: confirming.row.alias })}
          </p>
          {!confirming.force && isEphemeral && (
            <label className="remote-link-purge-option mt-1 flex cursor-pointer items-start gap-2 rounded-[8px] bg-surface px-3 py-2.5 text-[13px] leading-5 ring-1 ring-line">
              <input type="checkbox" className="mt-0.5 shrink-0" checked={purge} onChange={event => onPurgeChange(event.target.checked)} />
              <span>{t("remoteLink.disconnect.purgeLabel")}</span>
            </label>
          )}
          {forceError && <p className="remote-link-error m-0 text-[13px] text-danger" role="alert">{t(forceError)}</p>}
        </div>
        <div className="flex justify-end gap-2 px-2 py-2">
          <Button variant="ghost" data-action="cancel" onClick={onClose}>{t("link.cancel")}</Button>
          <Button variant="danger" data-action="confirm" onClick={onConfirm} disabled={busy}>
            {confirming.force
              ? t("remoteLink.forceRemove.confirm")
              : isEphemeral && purge
                ? t("remoteLink.disconnect.purgeConfirm")
                : t("link.disconnect")}
          </Button>
        </div>
      </>}
    </dialog>
  );
}
