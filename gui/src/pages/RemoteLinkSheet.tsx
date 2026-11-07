import type { ReactElement, RefObject } from "react";
import {
  formatBinaryMegabytes,
  type LinkCandidateView,
  type LinkConfirmHostView,
  type LinkProbeView,
} from "../remote-link-api";
import { IconLink, IconX } from "../icons";
import { type TKey, useT } from "../i18n/shared";
import { Notice } from "../ui";

export interface LinkActionErrorView {
  readonly key: TKey;
  readonly hint: string | null;
}

export function LinkErrorNotice({ error }: { error: LinkActionErrorView }): ReactElement {
  const t = useT();
  return (
    <Notice tone="err">
      <span className="remote-link-error">{t(error.key)}</span>
      {error.hint && <span className="remote-link-hint">{t("remoteLink.reason.generic")} <code>{error.hint}</code></span>}
    </Notice>
  );
}

export interface RemoteLinkSheetProps {
  sheetRef: RefObject<HTMLDialogElement | null>;
  role: "home" | "child";
  standaloneRuntime: boolean;
  childSelectable: boolean;
  discovery: "idle" | "loading" | "ready" | "failed";
  candidates: LinkCandidateView[];
  alias: string;
  onAliasChange: (value: string) => void;
  probe: LinkProbeView | null;
  checkedFingerprint: boolean;
  onCheckedFingerprintChange: (checked: boolean) => void;
  confirmation: LinkConfirmHostView | null;
  busy: "candidates" | "probe" | "confirm" | "apply" | "join" | "remove" | "reconnect" | null;
  sheetOpen: boolean;
  actionError: LinkActionErrorView | null;
  failedAction: { phase: "probe" | "apply" | "join"; alias: string } | null;
  onClose: () => void;
  onRescan: () => void;
  onProbe: () => void;
  onConfirmHost: () => void;
  onApplyLink: () => void;
  onJoinLink: () => void;
  onRetryFailedAction: () => void;
}

export function RemoteLinkSheet({
  sheetRef,
  role,
  standaloneRuntime,
  childSelectable,
  discovery,
  candidates,
  alias,
  onAliasChange,
  probe,
  checkedFingerprint,
  onCheckedFingerprintChange,
  confirmation,
  busy,
  sheetOpen,
  actionError,
  failedAction,
  onClose,
  onRescan,
  onProbe,
  onConfirmHost,
  onApplyLink,
  onJoinLink,
  onRetryFailedAction,
}: RemoteLinkSheetProps): ReactElement {
  const t = useT();
  const isChildFlow = role === "child" && standaloneRuntime;

  return (
    <dialog ref={sheetRef} className="remote-link-sheet" aria-labelledby="remote-link-sheet-title" onCancel={event => { event.preventDefault(); onClose(); }}>
      <div className="remote-link-sheet-head">
        <h3 id="remote-link-sheet-title">{isChildFlow ? t("remoteLink.findHome.title") : t("link.sheetTitle")}</h3>
        <button type="button" className="btn btn-ghost btn-icon" onClick={onClose} aria-label={t("link.close")}><IconX /></button>
      </div>
      <div className="remote-link-sheet-body">
        {role === "home" && <div className="remote-link-info"><p>{t("link.setup.relationship")}</p><p>{t("link.setup.requirements")}</p></div>}
        <div>
          <h4>{isChildFlow ? t("remoteLink.findHome.body") : t("link.candidates")}</h4>
          {discovery === "loading" && <p className="remote-link-info" role="status">{t("link.loading")}</p>}
          {discovery === "failed" && <><p className="remote-link-info">{t("link.discoveryFailed")}</p>{sheetOpen && actionError && <LinkErrorNotice error={actionError} />}</>}
          {discovery === "ready" && (candidates.length > 0 ? (
            <div className="remote-link-candidates">
              {candidates.map(candidate => (
                <button type="button" className="remote-link-candidate" key={`${candidate.source}:${candidate.alias}`} onClick={() => onAliasChange(candidate.alias)}>
                  <span>{candidate.alias}</span><small>{candidate.source}</small>
                </button>
              ))}
            </div>
          ) : (
            <div className="remote-link-info">
              <p>{t("link.noCandidates")}</p>
              <p>{t(role === "home" ? "link.setup.emptyHome" : "link.setup.emptyLocal")}</p>
              <pre><code>{"Host devbox\n  HostName devbox.example.com\n  User you\n  IdentityFile ~/.ssh/id_ed25519"}</code></pre>
            </div>
          ))}
          <a href="https://opencodex.me/guides/remote-link/" target="_blank" rel="noopener noreferrer">{t("link.setup.guide")}</a>
          <button type="button" className="btn btn-ghost" onClick={onRescan} disabled={busy !== null}>{t(discovery === "failed" ? "link.retry" : "link.rescan")}</button>
        </div>
        <div className="remote-link-form">
          <label className="field-label" htmlFor="remote-link-alias">{t("link.alias")}</label>
          <input id="remote-link-alias" aria-describedby="remote-link-alias-help" className="input" spellCheck={false} value={alias} onChange={event => onAliasChange(event.target.value)} placeholder={t("link.aliasPlaceholder")} autoComplete="off" />
          <p id="remote-link-alias-help" className="remote-link-info">{t("link.aliasRequired")}</p>
          <button type="button" className="btn btn-ghost" onClick={onProbe} disabled={!alias.trim() || busy !== null}><IconLink />{busy === "probe" ? t("link.probing") : t("link.probe")}</button>
        </div>
        {probe && (
          <div className="remote-link-panel">
            <div>
              <span className="remote-link-info">{t("link.hostFingerprint")}</span>
              <p className="remote-link-fingerprint"><code>{probe.fingerprint}</code></p>
              <span className="remote-link-info">{probe.keyType}</span>
            </div>
            <label><input type="checkbox" checked={checkedFingerprint} onChange={event => onCheckedFingerprintChange(event.target.checked)} /> {t("link.confirmFingerprint")}</label>
            <button type="button" className="btn btn-primary" onClick={onConfirmHost} disabled={!checkedFingerprint || busy !== null}>{busy === "confirm" ? t("link.confirming") : t("link.confirm")}</button>
          </div>
        )}
        {confirmation && (
          isChildFlow ? (
            <div className="remote-link-panel">
              <p className="remote-link-info">{t("link.ocxVersion", { version: confirmation.ocxVersion ?? "" })}</p>
              <Notice tone="warn">{t("remoteLink.findHome.notice")}</Notice>
              <button type="button" className="btn btn-primary" onClick={onJoinLink} disabled={busy !== null || !childSelectable}>
                {busy === "join" ? t("remoteLink.joining") : t("remoteLink.findHome.connect")}
              </button>
            </div>
          ) : confirmation.runtimeKind === "missing" ? (
            confirmation.plantable ? (
              <div className="remote-link-plant-card">
                <h4>{t("link.plant.title")}</h4>
                <div className="remote-link-plant-meta">
                  <code>{confirmation.targetTriple ?? t("link.plant.unknownArch")}</code>
                  <code>{formatBinaryMegabytes(confirmation.binarySizeBytes)}</code>
                  <code>{"~/.cache/opencodex/bin/ocx-child"}</code>
                </div>
                <p>{t("link.plant.body")}</p>
                <button type="button" className="btn btn-primary" onClick={onApplyLink} disabled={busy !== null}>
                  {busy === "apply" ? t("link.plant.applying") : t("link.plant.apply")}
                </button>
              </div>
            ) : (
              <Notice tone="warn">{t("link.plant.unavailable", { arch: confirmation.targetTriple ?? t("link.plant.unknownArch") })}</Notice>
            )
          ) : (
            <div className="remote-link-panel">
              <p className="remote-link-info">
                {confirmation.runtimeKind === "ephemeral"
                  ? t("link.ephemeralReady", { version: confirmation.ocxVersion ?? "" })
                  : t("link.ocxVersion", { version: confirmation.ocxVersion ?? "" })}
              </p>
              <button type="button" className="btn btn-primary" onClick={onApplyLink} disabled={busy !== null}>
                {busy === "apply" ? t("link.applying") : t("link.apply")}
              </button>
            </div>
          )
        )}
        {sheetOpen && discovery !== "failed" && actionError && <LinkErrorNotice error={actionError} />}
        {failedAction && actionError?.key !== "remoteLink.error.join_restart_failed" && (
          <div>
            {failedAction.phase === "probe" && <><p className="remote-link-info">{t("link.probeHelp")}</p><pre><code>{"ssh -o BatchMode=yes <alias> true"}</code></pre></>}
            <button type="button" className="btn btn-ghost" onClick={onRetryFailedAction} disabled={busy !== null}>{t("link.retry")}</button>
          </div>
        )}
        <div className="remote-link-sheet-actions"><button type="button" className="btn btn-ghost" onClick={onClose}>{t("link.cancel")}</button></div>
      </div>
    </dialog>
  );
}

