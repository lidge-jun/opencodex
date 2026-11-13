import type { ReactElement, RefObject } from "react";
import type { LinkRowWire } from "../remote-link-api";
import { Trans } from "../i18n/provider";
import { type TKey, useT } from "../i18n/shared";
import { Banner } from "../components/v2-startup/primitives";
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

/** A link removed with Remove here only: its row is gone, so the notice keeps what the operator still needs on the Child. */
export interface ForceRemovedLink { id: string; alias: string; kind: "full" | "ephemeral" | "unknown" }

const PLANTED_CHILD = "~/.cache/opencodex/bin/ocx-child";

export function RemoteLinkForceRemovedNotice({ removed, onDismiss }: { removed: ForceRemovedLink; onDismiss: () => void }): ReactElement {
  const t = useT();
  const vars = { alias: removed.alias, linkId: removed.id };
  // The id passed the status parser's link-id check, so it is safe inside a copied command.
  return (
    <Banner tone="warn" className="remote-link-force-removed" action={<Button variant="ghost" size="sm" onClick={onDismiss}>{t("api.dismiss")}</Button>}>
      {removed.kind === "ephemeral"
        ? <span className="block"><Trans k="remoteLink.forceRemoved.ephemeral" cmd={`ocx link recover --link-id ${removed.id}`} vars={vars} /></span>
        : removed.kind === "unknown"
          // Every ocx-child prints its link from connect status --json; an early one ignored unknown detach flags, so a
          // link-bound --expect-link is not offered for a Child this old.
          ? <>
            <span className="block"><Trans k="remoteLink.forceRemoved.unknownCheck" cmd="ocx connect status --json" vars={vars} /></span>
            <span className="mt-1 block"><Trans k="remoteLink.forceRemoved.unknownLocate" cmd="command -v ocx-child" vars={vars} /></span>
            <span className="mt-1 block"><Trans k="remoteLink.forceRemoved.unknownLightweight" cmd={`${PLANTED_CHILD} connect status --json`} vars={vars} /></span>
            <span className="mt-1 block"><Trans k="remoteLink.forceRemoved.unknownDisconnect" cmd="ocx disconnect" vars={vars} /></span>
            <span className="mt-1 block"><Trans k="remoteLink.forceRemoved.unknownLightweight" cmd={`${PLANTED_CHILD} detach`} vars={vars} /></span>
          </>
          : <>
          <span className="block"><Trans k="remoteLink.forceRemoved.fullCheck" cmd="ocx connect status" vars={vars} /></span>
          <span className="mt-1 block"><Trans k="remoteLink.forceRemoved.fullDisconnect" cmd="ocx disconnect" vars={vars} /></span>
        </>}
    </Banner>
  );
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
  // A link saved before the Home recorded the Child type: it may run a full install or ocx-child, and a forced removal
  // leaves no tombstone for it, so the dialog names no command; the notice afterwards checks either install's link.
  const unknownKind = confirming !== null && (confirming.row.childKind ?? null) === null;
  // Never a bare disconnect: a forced removal is also the way out when the Child now belongs to another link, a hub or another
  // Home. A lightweight Child is cleaned by the link-bound recover (run here), which checks that it still belongs to this link.
  const forceCmd = isEphemeral ? `ocx link recover --link-id ${confirming?.row.id ?? ""}` : "ocx disconnect";

  return (
    <dialog ref={confirmRef} aria-labelledby="remote-link-confirm-title" onCancel={event => { event.preventDefault(); onClose(); }}
      className="remote-link-confirm-dialog m-auto w-[min(440px,calc(100vw-24px))] rounded-[14px] border-0 bg-surface p-1 text-fg shadow-lg ring-1 ring-line backdrop:bg-black/40">
      {confirming && <>
        <div className="flex flex-col gap-2 rounded-[10px] bg-bg px-5 py-4 ring-1 ring-line">
          <h3 id="remote-link-confirm-title" className="m-0 text-[16px] leading-6 font-semibold tracking-[-0.015em]">{confirming.force ? t("remoteLink.forceRemove.title", { alias: confirming.row.alias }) : t("link.disconnect")}</h3>
          <p className="m-0 text-[14px] leading-[21px] text-fg-muted">
            {confirming.force
              ? unknownKind
                ? t("remoteLink.forceRemove.unknownBody", { alias: confirming.row.alias })
                : <Trans k={isEphemeral ? "remoteLink.forceRemove.ephemeralBody" : "remoteLink.forceRemove.body"} cmd={forceCmd} vars={{ alias: confirming.row.alias }} />
              : isEphemeral
                ? t("remoteLink.disconnect.ephemeralBody", { alias: confirming.row.alias })
                : t("link.disconnectConfirm", { alias: confirming.row.alias })}
          </p>
          {/* A full Child's or an unknown-type Child's forced removal leaves no tombstone, and the notice afterwards is page state. */}
          {confirming.force && !isEphemeral && <p className="remote-link-note-id m-0 text-[13px] leading-5 text-fg-muted">{t("remoteLink.forceRemove.noteId", { linkId: confirming.row.id })}</p>}
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
