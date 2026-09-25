import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { LinkApiError, requestLinkJson, type LinkErrorCode } from "../remote-link-api";
import { IconLink, IconPlus, IconRefresh, IconTrash, IconX } from "../icons";
import { Trans } from "../i18n/provider";
import { type TKey, useT } from "../i18n/shared";
import { Notice } from "../ui";
import "../styles-remote-link.css";

export type RemoteLinkRole = "home" | "child";
export type RemoteLinkUiState = "off" | "role-select" | "adding-child" | "confirming-host" | "applying" | "connected" | "reconnecting" | "failed";
export type LinkWireDirection = "hub-initiated" | "client-initiated";
export type LinkWireState = "connecting" | "connected" | "reconnecting" | "failed" | "idle";
export type LinkListenerState = "off" | "listening" | "failed";

export interface LinkCandidateView { alias: string; source: string }
export interface LinkProbeView { alias: string; fingerprint: string; keyType: string }
export interface LinkConfirmHostView { alias: string; fingerprint: string; ocxVersion: string }
export interface LinkRowWire { id: string; alias: string; direction: LinkWireDirection; state: LinkWireState; since: string; reason: string | null; tunnelPort: number }
export interface RemoteLinkStatusWire {
  role: "standalone" | "home" | "child";
  listener: { state: LinkListenerState; port: number | null };
  links: LinkRowWire[];
  child: null | { alias: string; state: LinkWireState; since: string; reason: string | null };
}

export interface RemoteLinkProps {
  apiBase: string;
  sessionReady: boolean;
  workspaceAvailable?: boolean;
  onOpenWorkspace?: () => void;
}

const LINK_STATES: readonly LinkWireState[] = ["connecting", "connected", "reconnecting", "failed", "idle"];
const LINK_ROLES = ["standalone", "home", "child"] as const;
const STATUS_LABEL: Record<LinkWireState, TKey> = {
  connecting: "remoteLink.status.connecting",
  connected: "remoteLink.status.connected",
  reconnecting: "remoteLink.status.reconnecting",
  failed: "remoteLink.status.failed",
  idle: "remoteLink.status.idle",
};
const ERROR_TKEY: Record<LinkErrorCode, TKey> = {
  admission_timeout: "remoteLink.error.admission_timeout",
  compensation_failed: "remoteLink.error.compensation_failed",
  fingerprint_failed: "remoteLink.error.fingerprint_failed",
  forbidden: "remoteLink.error.forbidden",
  host_confirmation_expired: "remoteLink.error.host_confirmation_expired",
  host_fingerprint_mismatch: "remoteLink.error.host_fingerprint_mismatch",
  host_not_confirmed: "remoteLink.error.host_not_confirmed",
  invalid_alias: "remoteLink.error.invalid_alias",
  invalid_body: "remoteLink.error.invalid_body",
  invalid_link_id: "remoteLink.error.invalid_link_id",
  key_issue_failed: "remoteLink.error.key_issue_failed",
  key_revoke_failed: "remoteLink.error.key_revoke_failed",
  link_apply_failed: "remoteLink.error.link_apply_failed",
  link_exists: "remoteLink.error.link_exists",
  link_not_found: "remoteLink.error.link_not_found",
  link_remove_failed: "remoteLink.error.link_remove_failed",
  link_unavailable: "remoteLink.error.link_unavailable",
  listener_unavailable: "remoteLink.error.listener_unavailable",
  probe_failed: "remoteLink.error.probe_failed",
  remote_connect_failed: "remoteLink.error.remote_connect_failed",
  remote_disconnect_failed: "remoteLink.error.remote_disconnect_failed",
  remote_port_failed: "remoteLink.error.remote_port_failed",
  tailscale_session_refused: "remoteLink.error.tailscale_session_refused",
  version_probe_failed: "remoteLink.error.version_probe_failed",
};

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
function nonEmpty(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function isLinkState(value: unknown): value is LinkWireState { return typeof value === "string" && LINK_STATES.includes(value as LinkWireState); }

// oxlint-disable-next-line react/only-export-components -- parser is the page's API-boundary test seam.
export function parseRemoteLinkStatus(value: unknown): RemoteLinkStatusWire {
  if (!isRecord(value) || !LINK_ROLES.includes(value.role as typeof LINK_ROLES[number])) throw new Error("invalid status");
  const listener = value.listener;
  if (!isRecord(listener) || !["off", "listening", "failed"].includes(String(listener.state)) || (listener.port !== null && typeof listener.port !== "number")) throw new Error("invalid listener");
  if (!Array.isArray(value.links)) throw new Error("invalid links");
  const links = value.links.map(item => {
    if (!isRecord(item) || !nonEmpty(item.id) || !nonEmpty(item.alias) || !["hub-initiated", "client-initiated"].includes(String(item.direction)) || !isLinkState(item.state) || !nonEmpty(item.since) || (item.reason !== null && typeof item.reason !== "string") || typeof item.tunnelPort !== "number") throw new Error("invalid link");
    return { id: item.id, alias: item.alias, direction: item.direction as LinkWireDirection, state: item.state, since: item.since, reason: item.reason as string | null, tunnelPort: item.tunnelPort };
  });
  let child: RemoteLinkStatusWire["child"] = null;
  if (value.child !== null) {
    if (!isRecord(value.child) || !nonEmpty(value.child.alias) || !isLinkState(value.child.state) || !nonEmpty(value.child.since) || (value.child.reason !== null && typeof value.child.reason !== "string")) throw new Error("invalid child");
    child = { alias: value.child.alias, state: value.child.state, since: value.child.since, reason: value.child.reason as string | null };
  }
  return { role: value.role as RemoteLinkStatusWire["role"], listener: { state: listener.state as LinkListenerState, port: listener.port as number | null }, links, child };
}

function parseCandidates(value: unknown): LinkCandidateView[] {
  if (!isRecord(value) || !Array.isArray(value.candidates)) throw new Error("invalid candidates");
  return value.candidates.map(candidate => {
    if (!isRecord(candidate) || !nonEmpty(candidate.alias) || !nonEmpty(candidate.source)) throw new Error("invalid candidate");
    return { alias: candidate.alias, source: candidate.source };
  });
}

function parseProbe(value: unknown): LinkProbeView {
  if (!isRecord(value) || !nonEmpty(value.alias) || !nonEmpty(value.fingerprint) || !nonEmpty(value.keyType)) throw new Error("invalid probe");
  return { alias: value.alias, fingerprint: value.fingerprint, keyType: value.keyType };
}

function parseConfirmation(value: unknown): LinkConfirmHostView {
  if (!isRecord(value) || !nonEmpty(value.alias) || !nonEmpty(value.fingerprint) || !nonEmpty(value.ocxVersion)) throw new Error("invalid confirmation");
  return { alias: value.alias, fingerprint: value.fingerprint, ocxVersion: value.ocxVersion };
}

function errorKey(error: unknown): TKey {
  if (error instanceof LinkApiError && error.code in ERROR_TKEY) return ERROR_TKEY[error.code as LinkErrorCode];
  return "remoteLink.error.generic";
}

// eslint-disable-next-line local-i18n/no-hardcoded-ui-strings -- CSS class names are not visible UI text.
function statusClass(state: LinkWireState): string { return `remote-link-status remote-link-status--${state}`; }

export default function RemoteLink({ apiBase, sessionReady, workspaceAvailable = false, onOpenWorkspace }: RemoteLinkProps): ReactElement {
  const t = useT();
  const [uiState, setUiState] = useState<RemoteLinkUiState>("off");
  const [role, setRole] = useState<RemoteLinkRole>("home");
  const [status, setStatus] = useState<RemoteLinkStatusWire | null>(null);
  const [statusError, setStatusError] = useState<TKey | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [candidates, setCandidates] = useState<LinkCandidateView[]>([]);
  const [alias, setAlias] = useState("");
  const [probe, setProbe] = useState<LinkProbeView | null>(null);
  const [confirmation, setConfirmation] = useState<LinkConfirmHostView | null>(null);
  const [checkedFingerprint, setCheckedFingerprint] = useState(false);
  const [busy, setBusy] = useState<"candidates" | "probe" | "confirm" | "apply" | "remove" | null>(null);
  const [actionError, setActionError] = useState<TKey | null>(null);
  const [confirming, setConfirming] = useState<{ row: LinkRowWire; force: boolean } | null>(null);
  const [forceError, setForceError] = useState<TKey | null>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDialogElement>(null);
  const confirmRef = useRef<HTMLDialogElement>(null);

  const refreshStatus = useCallback(async () => {
    if (!sessionReady || document.visibilityState === "hidden") return;
    try {
      const value = parseRemoteLinkStatus(await requestLinkJson<unknown>(apiBase, "/api/link/status"));
      setStatus(value);
      setStatusError(null);
      if (value.links.length === 0) {
        setUiState(current => ["role-select", "adding-child", "confirming-host", "applying"].includes(current) ? current : "off");
      } else if (value.links.some(link => link.state === "failed")) setUiState("failed");
      else if (value.links.some(link => link.state === "reconnecting")) setUiState("reconnecting");
      else if (value.links.some(link => link.state === "connected")) setUiState("connected");
    } catch (error) {
      setStatusError(errorKey(error));
    }
  }, [apiBase, sessionReady]);

  useEffect(() => {
    if (!sessionReady) return;
    // oxlint-disable-next-line react/react-compiler -- the first status read synchronizes the page with the protected API.
    void refreshStatus();
    const poll = window.setInterval(() => { void refreshStatus(); }, 5_000);
    const onVisibility = () => { if (document.visibilityState === "visible") void refreshStatus(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => { window.clearInterval(poll); document.removeEventListener("visibilitychange", onVisibility); };
  }, [refreshStatus, sessionReady]);

  useEffect(() => {
    if (!sheetOpen) { sheetRef.current?.close?.(); return; }
    const dialog = sheetRef.current;
    if (dialog && !dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal(); else dialog.setAttribute("open", "");
    }
    window.setTimeout(() => dialog?.querySelector<HTMLElement>("input, button")?.focus(), 0);
  }, [sheetOpen]);

  useEffect(() => {
    const dialog = confirmRef.current;
    if (!confirming) { dialog?.close?.(); return; }
    if (dialog && !dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal(); else dialog.setAttribute("open", "");
    }
  }, [confirming]);

  const closeSheet = () => { setSheetOpen(false); setProbe(null); setConfirmation(null); setCheckedFingerprint(false); setActionError(null); addButtonRef.current?.focus(); };
  const openSheet = async () => {
    setSheetOpen(true); setUiState("adding-child"); setActionError(null); setBusy("candidates");
    try { setCandidates(parseCandidates(await requestLinkJson<unknown>(apiBase, "/api/link/candidates"))); }
    catch (error) { setActionError(errorKey(error)); }
    finally { setBusy(null); }
  };
  const runProbe = async () => {
    const value = alias.trim();
    if (!value) return;
    setBusy("probe"); setActionError(null); setProbe(null); setConfirmation(null); setCheckedFingerprint(false);
    try { setProbe(parseProbe(await requestLinkJson<unknown>(apiBase, "/api/link/probe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ alias: value }) }))); }
    catch (error) { setActionError(errorKey(error)); }
    finally { setBusy(null); }
  };
  const confirmHost = async () => {
    if (!probe || !checkedFingerprint) return;
    setBusy("confirm"); setActionError(null);
    try { setConfirmation(parseConfirmation(await requestLinkJson<unknown>(apiBase, "/api/link/confirm-host", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ alias: probe.alias, fingerprint: probe.fingerprint }) }))); }
    catch (error) { setActionError(errorKey(error)); }
    finally { setBusy(null); }
  };
  const applyLink = async () => {
    if (!confirmation) return;
    setBusy("apply"); setActionError(null); setUiState("applying");
    try { await requestLinkJson<{ linkId: string }>(apiBase, "/api/link/apply", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ alias: confirmation.alias }) }); closeSheet(); await refreshStatus(); }
    catch (error) { setActionError(errorKey(error)); setUiState("failed"); }
    finally { setBusy(null); }
  };
  const removeLink = async () => {
    if (!confirming) return;
    const pending = confirming;
    setBusy("remove"); setForceError(null);
    try { await requestLinkJson<{ linkId: string }>(apiBase, `/api/link/${encodeURIComponent(pending.row.id)}`, pending.force ? { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ force: true }) } : { method: "DELETE" }); setConfirming(null); await refreshStatus(); }
    catch (error) {
      if (!pending.force && error instanceof LinkApiError && error.code === "remote_disconnect_failed") setConfirming({ row: pending.row, force: true });
      else setForceError(errorKey(error));
    }
    finally { setBusy(null); }
  };

  const statusRows = status?.links ?? [];
  // A machine that chose Home but has no link yet still reports standalone; the panel follows the
  // operator's choice so the heading does not contradict the action in front of them.
  const choseHome = role === "home" && (uiState === "adding-child" || uiState === "confirming-host" || uiState === "applying");
  const roleLabel: TKey = status?.role === "home" || choseHome ? "remoteLink.role.home" : status?.role === "child" ? "remoteLink.role.child" : "remoteLink.role.standalone";
  const primaryActionDisabled = role === "child";

  if (!sessionReady) return <div className="remote-link-page"><div className="page-head"><h2>{t("link.title")}</h2></div><Notice tone="warn">{t("link.sessionRequired")}</Notice></div>;

  return (
    <div className="remote-link-page">
      <div className="page-head"><div><h2>{t("link.title")}</h2><p className="page-sub">{t("link.subtitle")}</p></div><button type="button" className="btn btn-ghost btn-sm" onClick={() => void refreshStatus()} disabled={busy !== null}><IconRefresh />{t("link.refresh")}</button></div>
      {workspaceAvailable && <section className="panel remote-link-workspace-card"><div><strong>{t("remoteLink.workspaceMoved.title")}</strong><p>{t("remoteLink.workspaceMoved.body")}</p></div><button type="button" className="btn btn-ghost btn-sm" onClick={onOpenWorkspace ?? (() => { window.location.hash = "remote-workspace"; })}>{t("remoteLink.workspaceMoved.open")}</button></section>}
      {statusError && <Notice tone="err"><span className="remote-link-error">{t(statusError)}</span></Notice>}
      {statusRows.length === 0 && uiState === "off" && <section className="panel remote-link-off-preview"><div className="remote-link-switch-row"><div><strong>{t("link.switch")}</strong><p className="remote-link-info">{t("link.switchOffHint")}</p></div><button type="button" role="switch" className="remote-link-switch" aria-checked="false" aria-label={t("link.switch")} onClick={() => setUiState("role-select")} /></div><div className="remote-link-preview-content" aria-hidden="true"><div className="remote-link-preview-row"><div className="remote-link-preview-lines"><span /><span /><span /></div><span className="remote-link-status">{t("remoteLink.status.idle")}</span></div><div className="remote-link-preview-row"><div className="remote-link-preview-lines"><span /><span /></div><span className="remote-link-status">{t("remoteLink.role.child")}</span></div></div></section>}
      {uiState === "role-select" && <section className="panel remote-link-panel"><div><h3>{t("link.role.title")}</h3><p className="remote-link-info">{t("link.role.hint")}</p></div><div className="remote-link-role-grid" role="radiogroup" aria-label={t("link.role.title")}><button type="button" role="radio" aria-checked={role === "home"} className="remote-link-role-card" onClick={() => setRole("home")}><strong>{t("link.role.home")}</strong><span>{t("link.role.homeHint")}</span></button><button type="button" role="radio" aria-checked={role === "child"} className="remote-link-role-card" onClick={() => setRole("child")}><strong>{t("link.role.child")}</strong><span>{t("link.role.childHint")}</span></button></div>{role === "child" && <Notice tone="warn">{t("link.childPending")}</Notice>}<button type="button" className="btn btn-primary" disabled={primaryActionDisabled} onClick={() => { if (role === "home") setUiState("adding-child"); }}>{t("link.continue")}</button></section>}
      {(uiState === "connected" || uiState === "reconnecting" || uiState === "failed" || statusRows.length > 0 || uiState === "adding-child" || uiState === "confirming-host" || uiState === "applying") && <section className="panel remote-link-panel"><div className="remote-link-toolbar"><div><h3>{t("link.children")}</h3><p className="remote-link-info">{t(roleLabel)}</p></div><button ref={addButtonRef} type="button" className="btn btn-primary btn-sm" onClick={() => void openSheet()} disabled={busy !== null || uiState === "applying"}><IconPlus />{t("link.addChild")}</button></div>{statusRows.length > 0 ? <div className="remote-link-children" aria-live="polite">{statusRows.map(row => <div className="remote-link-row" key={row.id}><div className="remote-link-row-main"><strong>{row.alias}</strong><div className="remote-link-row-meta"><span className={statusClass(row.state)}>{t(STATUS_LABEL[row.state])}</span><span>{row.direction === "hub-initiated" ? t("remoteLink.direction.hub") : t("remoteLink.direction.client")}</span>{row.reason && <span className="remote-link-error">{row.reason in ERROR_TKEY ? t(ERROR_TKEY[row.reason as LinkErrorCode]) : t("remoteLink.error.generic")}</span>}</div></div><button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirming({ row, force: false })} disabled={busy !== null}><IconTrash />{t("link.disconnect")}</button></div>)}</div> : <p className="remote-link-info">{t("link.noChildren")}</p>}{(uiState === "reconnecting" || uiState === "failed") && <div className="remote-link-status-message" aria-live="polite"><span className={statusClass(uiState === "failed" ? "failed" : "reconnecting")}>{t(STATUS_LABEL[uiState === "failed" ? "failed" : "reconnecting"])}</span><button type="button" className="btn btn-ghost btn-sm" onClick={() => void refreshStatus()}>{t("link.retry")}</button></div>}{actionError && <Notice tone="err"><span className="remote-link-error">{t(actionError)}</span></Notice>}</section>}

      <dialog ref={sheetRef} className="remote-link-sheet" aria-labelledby="remote-link-sheet-title" onCancel={event => { event.preventDefault(); closeSheet(); }}>
        <div className="remote-link-sheet-head"><h3 id="remote-link-sheet-title">{t("link.sheetTitle")}</h3><button type="button" className="btn btn-ghost btn-icon" onClick={closeSheet} aria-label={t("link.close")}><IconX /></button></div>
        <div className="remote-link-sheet-body"><div><h4>{t("link.candidates")}</h4>{busy === "candidates" ? <p className="remote-link-info">{t("link.loading")}</p> : candidates.length > 0 ? <div className="remote-link-candidates">{candidates.map(candidate => <button type="button" className="remote-link-candidate" key={`${candidate.source}:${candidate.alias}`} onClick={() => setAlias(candidate.alias)}><span>{candidate.alias}</span><small>{candidate.source}</small></button>)}</div> : <p className="remote-link-info">{t("link.noCandidates")}</p>}</div><div className="remote-link-form"><label htmlFor="remote-link-alias">{t("link.alias")}</label><input id="remote-link-alias" value={alias} onChange={event => setAlias(event.target.value)} placeholder={t("link.aliasPlaceholder")} autoComplete="off" /><button type="button" className="btn btn-ghost" onClick={() => void runProbe()} disabled={!alias.trim() || busy !== null}><IconLink />{busy === "probe" ? t("link.probing") : t("link.probe")}</button></div>{probe && <div className="remote-link-panel"><div><span className="remote-link-info">{t("link.hostFingerprint")}</span><p className="remote-link-fingerprint"><code>{probe.fingerprint}</code></p><span className="remote-link-info">{probe.keyType}</span></div><label><input type="checkbox" checked={checkedFingerprint} onChange={event => setCheckedFingerprint(event.target.checked)} /> {t("link.confirmFingerprint")}</label><button type="button" className="btn btn-primary" onClick={() => void confirmHost()} disabled={!checkedFingerprint || busy !== null}>{busy === "confirm" ? t("link.confirming") : t("link.confirm")}</button></div>}{confirmation && <div className="remote-link-panel"><p className="remote-link-info">{t("link.ocxVersion", { version: confirmation.ocxVersion })}</p><button type="button" className="btn btn-primary" onClick={() => void applyLink()} disabled={busy !== null}>{busy === "apply" ? t("link.applying") : t("link.apply")}</button></div>}{actionError && <Notice tone="err"><span className="remote-link-error">{t(actionError)}</span></Notice>}<div className="remote-link-sheet-actions"><button type="button" className="btn btn-ghost" onClick={closeSheet}>{t("link.cancel")}</button></div></div>
      </dialog>

      <dialog ref={confirmRef} className="remote-link-confirm-dialog" aria-labelledby="remote-link-confirm-title" onCancel={event => { event.preventDefault(); setConfirming(null); setForceError(null); }}>
        {confirming && <><h3 id="remote-link-confirm-title">{confirming.force ? t("remoteLink.forceRemove.title", { alias: confirming.row.alias }) : t("link.disconnect")}</h3><p>{confirming.force ? <Trans k="remoteLink.forceRemove.body" cmd="ocx disconnect" vars={{ alias: confirming.row.alias }} /> : t("link.disconnectConfirm", { alias: confirming.row.alias })}</p>{forceError && <p className="remote-link-error" role="alert">{t(forceError)}</p>}<div className="remote-link-sheet-actions"><button type="button" className="btn btn-ghost" onClick={() => { setConfirming(null); setForceError(null); }}>{t("link.cancel")}</button><button type="button" className="btn btn-danger" onClick={() => void removeLink()} disabled={busy === "remove"}>{confirming.force ? t("remoteLink.forceRemove.confirm") : t("link.disconnect")}</button></div></>}
      </dialog>
    </div>
  );
}
