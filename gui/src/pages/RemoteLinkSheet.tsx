import type { ReactElement, RefObject } from "react";
import {
  formatBinaryMegabytes,
  type LinkCandidateView,
  type LinkConfirmHostView,
  type LinkProbeView,
} from "../remote-link-api";
import { IconLink, IconRefresh, IconX } from "../icons";
import { Trans } from "../i18n/provider";
import { type TKey, useT } from "../i18n/shared";
import { Button } from "@/components/ui-v2/button";
import { cn } from "@/lib/utils";
import { Banner, IconButton } from "../components/v2-startup/primitives";
import { SheetSteps } from "../components/v2-startup/remote-link-parts";

export interface LinkActionErrorView {
  readonly key: TKey;
  readonly hint: string | null;
  /** The Child-side recovery step. */
  readonly childStep?: LinkChildStep | null;
}

/** One line of Child guidance; cmd, when set, is a command chip in the {cmd} slot. more: further lines, one chip each. */
export interface LinkChildStep {
  readonly key: TKey;
  readonly cmd?: string;
  readonly more?: readonly { readonly key: TKey; readonly cmd: string }[];
}

export function LinkErrorNotice({ error }: { error: LinkActionErrorView }): ReactElement {
  const t = useT();
  return <Banner tone="err"><span className="remote-link-error">{t(error.key)}</span>{error.childStep && <span className="remote-link-child-step mt-1 block">{error.childStep.cmd === undefined ? t(error.childStep.key) : <Trans k={error.childStep.key} cmd={error.childStep.cmd} />}{error.childStep.more?.map(line => <span key={line.key} className="mt-1 block"><Trans k={line.key} cmd={line.cmd} /></span>)}</span>}{error.hint && <span className="remote-link-hint mt-1 block text-[12px] text-fg-muted [overflow-wrap:anywhere]">{t("remoteLink.reason.generic")} <code className="font-mono">{error.hint}</code></span>}</Banner>;
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

/** The file name Home looks for in OPENCODEX_CHILD_BIN_DIR and its cache (child-binary-source.ts). */
function childArtifactName(targetTriple: string): string {
  return targetTriple.startsWith("windows-") ? "ocx-child-" + targetTriple + ".exe" : "ocx-child-" + targetTriple;
}

const CARD = "flex flex-col gap-3 rounded-[10px] bg-surface p-4 ring-1 ring-line";

function ConfirmationCard({ confirmation, isChildFlow, childSelectable, busy, onApplyLink, onJoinLink }: {
  confirmation: LinkConfirmHostView;
  isChildFlow: boolean;
  childSelectable: boolean;
  busy: RemoteLinkSheetProps["busy"];
  onApplyLink: () => void;
  onJoinLink: () => void;
}): ReactElement {
  const t = useT();
  if (isChildFlow) {
    return (
      <div className={CARD}>
        <p className="m-0 text-[13px] text-fg-muted">{t("link.ocxVersion", { version: confirmation.ocxVersion ?? "" })}</p>
        <Banner tone="warn">{t("remoteLink.findHome.notice")}</Banner>
        <Button variant="primary" className="self-start" onClick={onJoinLink} disabled={busy !== null || !childSelectable}>
          {busy === "join" ? t("remoteLink.joining") : t("remoteLink.findHome.connect")}
        </Button>
      </div>
    );
  }
  if (confirmation.runtimeKind === "missing") {
    if (!confirmation.plantable) {
      return (
        <Banner tone="warn">
          {t("link.plant.unavailable", { arch: confirmation.targetTriple ?? t("link.plant.unknownArch") })}
          {confirmation.plantUnavailableReason === "artifact_not_found" && confirmation.targetTriple && (
            <span className="mt-1 block">{t("link.plant.artifactHelp", { file: childArtifactName(confirmation.targetTriple) })}</span>
          )}
        </Banner>
      );
    }
    return (
      <div className={cn(CARD, "remote-link-plant-card")}>
        <h4 className="m-0 text-[14px] leading-5 font-semibold">{t("link.plant.title")}</h4>
        <div className="flex flex-wrap items-center gap-2 font-mono text-[12px] text-fg">
          <code>{confirmation.targetTriple ?? t("link.plant.unknownArch")}</code>
          <code>{formatBinaryMegabytes(confirmation.binarySizeBytes)}</code>
          <code>{"~/.cache/opencodex/bin/ocx-child"}</code>
        </div>
        <p className="m-0 text-[13px] leading-5 text-fg-muted">{t("link.plant.body")}</p>
        <Button variant="primary" className="self-start" onClick={onApplyLink} disabled={busy !== null}>
          {busy === "apply" ? t("link.plant.applying") : t("link.plant.apply")}
        </Button>
      </div>
    );
  }
  return (
    <div className={CARD}>
      <p className="m-0 text-[13px] text-fg-muted">
        {confirmation.runtimeKind === "ephemeral"
          ? t("link.ephemeralReady", { version: confirmation.ocxVersion ?? "" })
          : t("link.ocxVersion", { version: confirmation.ocxVersion ?? "" })}
      </p>
      <Button variant="primary" className="self-start" onClick={onApplyLink} disabled={busy !== null}>
        {busy === "apply" ? t("link.applying") : t("link.apply")}
      </Button>
    </div>
  );
}

export function RemoteLinkSheet({
  sheetRef, role, standaloneRuntime, childSelectable, discovery, candidates, alias, onAliasChange, probe, checkedFingerprint,
  onCheckedFingerprintChange, confirmation, busy, sheetOpen, actionError, failedAction, onClose, onRescan, onProbe, onConfirmHost,
  onApplyLink, onJoinLink, onRetryFailedAction,
}: RemoteLinkSheetProps): ReactElement {
  const t = useT();
  const isChildFlow = role === "child" && standaloneRuntime;

  return (
    <dialog ref={sheetRef} aria-labelledby="remote-link-sheet-title" onCancel={event => { event.preventDefault(); onClose(); }}
      className="remote-link-sheet m-auto max-h-[min(800px,calc(100dvh-24px))] w-[min(620px,calc(100vw-24px))] flex-col overflow-hidden rounded-[14px] border-0 bg-surface p-1 text-fg shadow-lg ring-1 ring-line backdrop:bg-black/40 open:flex">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[10px] bg-bg ring-1 ring-line">
        <header className="flex flex-col gap-3 border-b border-line px-5 pt-4 pb-3.5">
          <div className="flex items-start justify-between gap-3">
            <h3 id="remote-link-sheet-title" className="m-0 text-[16px] leading-6 font-semibold tracking-[-0.015em]">{isChildFlow ? t("remoteLink.findHome.title") : t("link.sheetTitle")}</h3>
            <IconButton label={t("link.close")} onClick={onClose}><IconX /></IconButton>
          </div>
          <SheetSteps step={confirmation ? 2 : probe ? 1 : 0} />
        </header>
        <div className="flex min-h-0 flex-col gap-5 overflow-y-auto px-5 py-4">
          {role === "home" && <div className="flex flex-col gap-1 text-[13px] leading-5 text-fg-muted"><p className="m-0">{t("link.setup.relationship")}</p><p className="m-0">{t("link.setup.requirements")}</p></div>}
          <div className="flex flex-col gap-2">
            <h4 className="m-0 text-[13px] leading-5 font-semibold">{isChildFlow ? t("remoteLink.findHome.body") : t("link.candidates")}</h4>
            {discovery === "loading" && <p className="m-0 text-[13px] text-fg-muted" role="status">{t("link.loading")}</p>}
            {discovery === "failed" && <><p className="m-0 text-[13px] text-fg-muted">{t("link.discoveryFailed")}</p>{sheetOpen && actionError && <LinkErrorNotice error={actionError} />}</>}
            {discovery === "ready" && (candidates.length > 0 ? (
              <div className="flex flex-col gap-1.5">
                {candidates.map(candidate => (
                  <button type="button" key={`${candidate.source}:${candidate.alias}`} onClick={() => onAliasChange(candidate.alias)} aria-pressed={alias === candidate.alias}
                    className={cn(
                      "remote-link-candidate ui-v2 flex min-h-[var(--ocx-control-h)] cursor-pointer items-center justify-between gap-3 rounded-[10px] bg-surface px-3 py-2 text-left ring-1 ring-line transition-colors hover:bg-raised",
                      "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-highlight",
                      alias === candidate.alias && "bg-raised ring-2 ring-fg",
                    )}>
                    <span className="truncate font-mono text-[13px] text-fg">{candidate.alias}</span>
                    <small className="shrink-0 text-[12px] text-fg-subtle">{candidate.source}</small>
                  </button>
                ))}
              </div>
            ) : (
              <div className="flex flex-col gap-2 text-[13px] leading-5 text-fg-muted">
                <p className="m-0">{t("link.noCandidates")}</p>
                <p className="m-0">{t(role === "home" ? "link.setup.emptyHome" : "link.setup.emptyLocal")}</p>
                <pre className="m-0 rounded-[8px] bg-surface px-3 py-2.5 font-mono text-[12px] leading-5 whitespace-pre-wrap text-fg ring-1 ring-line [overflow-wrap:anywhere]"><code>{"Host devbox\n  HostName devbox.example.com\n  User you\n  IdentityFile ~/.ssh/id_ed25519"}</code></pre>
              </div>
            ))}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <a href="https://opencodex.me/guides/remote-link/" target="_blank" rel="noopener noreferrer" className="text-[13px] font-medium text-highlight hover:underline">{t("link.setup.guide")}</a>
              <Button variant="ghost" size="sm" onClick={onRescan} disabled={busy !== null}><IconRefresh />{t(discovery === "failed" ? "link.retry" : "link.rescan")}</Button>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-[13px] leading-5 font-semibold" htmlFor="remote-link-alias">{t("link.alias")}</label>
            <div className="flex flex-wrap items-center gap-2">
              <input id="remote-link-alias" aria-describedby="remote-link-alias-help" className="input min-w-0 flex-1 font-mono" spellCheck={false} value={alias} onChange={event => onAliasChange(event.target.value)} placeholder={t("link.aliasPlaceholder")} autoComplete="off" />
              <Button variant="outline" onClick={onProbe} disabled={!alias.trim() || busy !== null}><IconLink />{busy === "probe" ? t("link.probing") : t("link.probe")}</Button>
            </div>
            <p id="remote-link-alias-help" className="m-0 text-[12px] leading-[18px] text-fg-subtle">{t("link.aliasRequired")}</p>
          </div>
          {probe && (
            <div className={CARD}>
              <div className="flex flex-col gap-1.5">
                <span className="text-[13px] font-semibold">{t("link.hostFingerprint")} <span className="font-normal text-fg-subtle">{probe.keyType}</span></span>
                <p className="remote-link-fingerprint m-0 rounded-[8px] bg-bg px-3 py-2 font-mono text-[12.5px] ring-1 ring-line [overflow-wrap:anywhere]"><code>{probe.fingerprint}</code></p>
              </div>
              <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={checkedFingerprint} onChange={event => onCheckedFingerprintChange(event.target.checked)} /> {t("link.confirmFingerprint")}</label>
              <Button variant="primary" className="self-start" onClick={onConfirmHost} disabled={!checkedFingerprint || busy !== null}>{busy === "confirm" ? t("link.confirming") : t("link.confirm")}</Button>
            </div>
          )}
          {confirmation && <ConfirmationCard confirmation={confirmation} isChildFlow={isChildFlow} childSelectable={childSelectable} busy={busy} onApplyLink={onApplyLink} onJoinLink={onJoinLink} />}
          {sheetOpen && discovery !== "failed" && actionError && <LinkErrorNotice error={actionError} />}
          {failedAction && actionError?.key !== "remoteLink.error.join_restart_failed" && (
            <div className="flex flex-col gap-2">
              {failedAction.phase === "probe" && <><p className="m-0 text-[13px] leading-5 text-fg-muted">{t("link.probeHelp")}</p><pre className="m-0 rounded-[8px] bg-surface px-3 py-2 font-mono text-[12px] whitespace-pre-wrap ring-1 ring-line"><code>{"ssh -o BatchMode=yes <alias> true"}</code></pre></>}
              <Button variant="outline" size="sm" className="self-start" onClick={onRetryFailedAction} disabled={busy !== null}>{t("link.retry")}</Button>
            </div>
          )}
        </div>
      </div>
      <footer className="flex shrink-0 justify-end gap-2 px-2 py-2"><Button variant="ghost" onClick={onClose}>{t("link.cancel")}</Button></footer>
    </dialog>
  );
}
