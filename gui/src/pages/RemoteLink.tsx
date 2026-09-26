import { useCallback, useEffect, useEffectEvent, useRef, useState, type ReactElement } from "react";
import {
  LinkApiError, parseRemoteLinkStatus, requestLinkJson, type LinkCandidateView, type LinkConfirmHostView,
  type LinkErrorCode, type LinkProbeView, type LinkRowWire, type LinkWireState, type RemoteLinkStatusWire,
} from "../remote-link-api";
import { IconLink, IconPlus, IconRefresh, IconTrash, IconX } from "../icons";
import { Trans } from "../i18n/provider";
import { type TKey, useT } from "../i18n/shared";
import { Notice } from "../ui";
import { isStandaloneRuntime } from "../api-targets";
import "../styles-remote-link.css";

type RemoteLinkRole = "home" | "child";
type RemoteLinkUiState = "off" | "role-select" | "adding-child" | "confirming-host" | "applying" | "joining" | "restart-waiting" | "connected" | "reconnecting" | "failed";

export interface RemoteLinkProps {
  apiBase: string;
  sessionReady: boolean;
  workspaceAvailable?: boolean;
  onOpenWorkspace?: () => void;
}

const STATUS_LABEL: Record<LinkWireState, TKey> = {
  connecting: "remoteLink.status.connecting",
  connected: "remoteLink.status.connected",
  reconnecting: "remoteLink.status.reconnecting",
  failed: "remoteLink.status.failed",
  idle: "remoteLink.status.idle",
};
const ERROR_TKEY: Record<LinkErrorCode, TKey> = {
  admission_failed: "remoteLink.error.admission_failed",
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
  join_connect_failed: "remoteLink.error.join_connect_failed",
  join_in_progress: "remoteLink.error.join_in_progress",
  join_issue_failed: "remoteLink.error.join_issue_failed",
  join_port_failed: "remoteLink.error.join_port_failed",
  join_restart_failed: "remoteLink.error.join_restart_failed",
  join_rollback_failed: "remoteLink.error.join_rollback_failed",
  join_tunnel_failed: "remoteLink.error.join_tunnel_failed",
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
  remote_ocx_missing: "remoteLink.error.remote_ocx_missing",
  remote_ocx_outdated: "remoteLink.error.remote_ocx_outdated",
  remote_ocx_unrecognized: "remoteLink.error.remote_ocx_unrecognized",
  remote_port_failed: "remoteLink.error.remote_port_failed",
  standalone_required: "remoteLink.error.standalone_required",
  tailscale_session_refused: "remoteLink.error.tailscale_session_refused",
  version_probe_failed: "remoteLink.error.version_probe_failed",
};
const REASON_TKEY: Record<string, TKey> = {
  auth: "remoteLink.reason.auth",
  hostkey: "remoteLink.reason.hostkey",
  forward: "remoteLink.reason.forward",
  timeout: "remoteLink.reason.timeout",
  bind: "remoteLink.reason.bind",
  persist: "remoteLink.reason.persist",
  compensation_failed: "remoteLink.reason.compensation_failed",
  "stale tunnel may hold the port": "remoteLink.reason.staleTunnel",
};

type FailedAction = { phase: "probe" | "apply" | "join"; alias: string };
type LinkAttempt = { controller: AbortController; sequence: number };

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
function nonEmpty(value: unknown): value is string { return typeof value === "string" && value.length > 0; }

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

type LinkActionError = { key: TKey; hint: string | null };
function linkActionError(error: unknown): LinkActionError { return { key: errorKey(error), hint: error instanceof LinkApiError ? error.hint : null }; }
function LinkErrorNotice({ error }: { error: LinkActionError }): ReactElement {
  const t = useT();
  return <Notice tone="err"><span className="remote-link-error">{t(error.key)}</span>{error.hint && <span className="remote-link-hint">{t("remoteLink.reason.generic")} <code>{error.hint}</code></span>}</Notice>;
}

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
  const [busy, setBusy] = useState<"candidates" | "probe" | "confirm" | "apply" | "join" | "remove" | null>(null);
  const [actionError, setActionError] = useState<LinkActionError | null>(null);
  const [failedAction, setFailedAction] = useState<FailedAction | null>(null);
  const [confirming, setConfirming] = useState<{ row: LinkRowWire; force: boolean } | null>(null);
  const [forceError, setForceError] = useState<TKey | null>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDialogElement>(null);
  const confirmRef = useRef<HTMLDialogElement>(null);
  const disconnectTriggerRef = useRef<HTMLButtonElement | null>(null);
  const roleRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const statusRequestRef = useRef<{ controller: AbortController; sequence: number } | null>(null);
  const statusSequenceRef = useRef(0);
  const linkAttemptRef = useRef<LinkAttempt | null>(null);
  const linkAttemptSequenceRef = useRef(0);

  const startLinkAttempt = useCallback((): LinkAttempt => {
    linkAttemptRef.current?.controller.abort();
    const attempt = { controller: new AbortController(), sequence: ++linkAttemptSequenceRef.current };
    linkAttemptRef.current = attempt;
    return attempt;
  }, []);

  const cancelLinkAttempt = useCallback(() => {
    linkAttemptSequenceRef.current += 1;
    linkAttemptRef.current?.controller.abort();
    linkAttemptRef.current = null;
  }, []);

  const isCurrentLinkAttempt = (attempt: LinkAttempt): boolean => linkAttemptRef.current?.sequence === attempt.sequence && !attempt.controller.signal.aborted;

  const abortStatusRequest = useCallback(() => {
    statusSequenceRef.current += 1;
    statusRequestRef.current?.controller.abort();
    statusRequestRef.current = null;
  }, []);

  const refreshStatus = useCallback(async () => {
    if (!sessionReady || document.visibilityState === "hidden") return;
    statusRequestRef.current?.controller.abort();
    const controller = new AbortController();
    const sequence = ++statusSequenceRef.current;
    statusRequestRef.current = { controller, sequence };
    try {
      const value = parseRemoteLinkStatus(await requestLinkJson<unknown>(apiBase, "/api/link/status", { signal: controller.signal }));
      if (controller.signal.aborted || statusSequenceRef.current !== sequence) return;
      setStatus(value);
      setStatusError(null);
      if (failedAction) {
        setUiState("failed");
      } else if (value.links.length === 0) {
        setUiState(current => value.role === "child" && current === "restart-waiting"
          ? "connected"
          : ["role-select", "adding-child", "confirming-host", "applying", "joining", "restart-waiting"].includes(current) ? current : "off");
      } else if (value.links.some(link => link.state === "failed")) setUiState("failed");
      else if (value.links.some(link => link.state === "reconnecting")) setUiState("reconnecting");
      else if (value.links.some(link => link.state === "connected")) setUiState("connected");
    } catch (error) {
      if (controller.signal.aborted || statusSequenceRef.current !== sequence) return;
      setStatusError(errorKey(error));
    } finally {
      if (statusRequestRef.current?.sequence === sequence) statusRequestRef.current = null;
    }
  }, [apiBase, failedAction, sessionReady]);

  const refreshStatusOnEffect = useEffectEvent(() => { void refreshStatus(); });

  useEffect(() => {
    if (!sessionReady) return;
    void Promise.resolve().then(refreshStatusOnEffect);
    const poll = window.setInterval(refreshStatusOnEffect, 5_000);
    const onVisibility = () => { if (document.visibilityState === "visible") refreshStatusOnEffect(); else abortStatusRequest(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => { window.clearInterval(poll); document.removeEventListener("visibilitychange", onVisibility); abortStatusRequest(); };
  }, [abortStatusRequest, sessionReady]);

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

  // Cancelling the sheet abandons the attempt, so late responses cannot recreate its state.
  const closeSheet = () => { cancelLinkAttempt(); setSheetOpen(false); setCandidates([]); setProbe(null); setConfirmation(null); setCheckedFingerprint(false); setActionError(null); setFailedAction(null); setBusy(null); setUiState(current => ["failed", "adding-child", "confirming-host", "applying", "joining"].includes(current) ? "adding-child" : current); addButtonRef.current?.focus(); };
  const standaloneRuntime = isStandaloneRuntime();
  // Joining restarts this OpenCodex and moves Codex routing to the Home, so the server offers it
  // only to a paired session; the local dashboard can still run the Home side.
  const childSelectable = standaloneRuntime && status?.joinAvailable === true;
  const openSheet = async () => {
    const attempt = startLinkAttempt();
    setSheetOpen(true); setUiState("adding-child"); setCandidates([]); setProbe(null); setConfirmation(null); setCheckedFingerprint(false); setActionError(null); setFailedAction(null); setBusy("candidates");
    try {
      const result = await requestLinkJson<unknown>(apiBase, "/api/link/candidates", { signal: attempt.controller.signal });
      if (!isCurrentLinkAttempt(attempt)) return;
      setCandidates(parseCandidates(result));
    } catch (error) {
      if (!isCurrentLinkAttempt(attempt)) return;
      setActionError(linkActionError(error));
    } finally {
      if (isCurrentLinkAttempt(attempt)) setBusy(null);
    }
  };
  const runProbe = async (requestedAlias = alias.trim(), attempt = linkAttemptRef.current ?? startLinkAttempt()) => {
    const value = requestedAlias.trim();
    if (!value) return;
    setBusy("probe"); setActionError(null); setProbe(null); setConfirmation(null); setCheckedFingerprint(false); setFailedAction(null); setUiState("adding-child");
    try {
      const result = await requestLinkJson<unknown>(apiBase, "/api/link/probe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ alias: value }), signal: attempt.controller.signal });
      if (!isCurrentLinkAttempt(attempt)) return;
      setProbe(parseProbe(result));
    } catch (error) {
      if (!isCurrentLinkAttempt(attempt)) return;
      setActionError(linkActionError(error)); setFailedAction({ phase: "probe", alias: value }); setUiState("failed");
    } finally {
      if (isCurrentLinkAttempt(attempt)) setBusy(null);
    }
  };
  const confirmHost = async () => {
    if (!probe || !checkedFingerprint) return;
    const attempt = linkAttemptRef.current;
    if (!attempt) return;
    setBusy("confirm"); setActionError(null);
    try {
      const result = await requestLinkJson<unknown>(apiBase, "/api/link/confirm-host", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ alias: probe.alias, fingerprint: probe.fingerprint }), signal: attempt.controller.signal });
      if (!isCurrentLinkAttempt(attempt)) return;
      setConfirmation(parseConfirmation(result));
    } catch (error) {
      if (!isCurrentLinkAttempt(attempt)) return;
      setActionError(linkActionError(error));
    } finally {
      if (isCurrentLinkAttempt(attempt)) setBusy(null);
    }
  };
  const applyLink = async (attempt = linkAttemptRef.current) => {
    const confirmed = confirmation;
    if (!confirmed || !attempt) return;
    setBusy("apply"); setActionError(null); setFailedAction(null); setUiState("applying");
    try {
      await requestLinkJson<{ linkId: string }>(apiBase, "/api/link/apply", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ alias: confirmed.alias }), signal: attempt.controller.signal });
      if (!isCurrentLinkAttempt(attempt)) return;
      closeSheet();
      void refreshStatus();
    } catch (error) {
      if (!isCurrentLinkAttempt(attempt)) return;
      setActionError(linkActionError(error)); setFailedAction({ phase: "apply", alias: confirmed.alias }); setUiState("failed");
    } finally {
      if (isCurrentLinkAttempt(attempt)) setBusy(null);
    }
  };

  const joinLink = async (requestedAlias = confirmation?.alias, attempt = linkAttemptRef.current ?? startLinkAttempt()) => {
    const value = requestedAlias?.trim();
    if (!value || !childSelectable) return;
    setBusy("join"); setActionError(null); setFailedAction(null); setUiState("joining");
    try {
      await requestLinkJson<{ linkId: string; alias: string; restarting: true }>(apiBase, "/api/link/join", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ alias: value }), signal: attempt.controller.signal });
      if (!isCurrentLinkAttempt(attempt)) return;
      closeSheet(); setUiState("restart-waiting");
    } catch (error) {
      if (!isCurrentLinkAttempt(attempt)) return;
      setActionError(linkActionError(error)); setFailedAction({ phase: "join", alias: value }); setUiState("failed");
    } finally {
      if (isCurrentLinkAttempt(attempt)) setBusy(null);
    }
  };

  const retryFailedAction = () => {
    if (!failedAction) { void refreshStatus(); return; }
    const attempt = startLinkAttempt();
    if (failedAction.phase === "probe") { setAlias(failedAction.alias); void runProbe(failedAction.alias, attempt); return; }
    if (failedAction.phase === "join") { void joinLink(failedAction.alias, attempt); return; }
    void applyLink(attempt);
  };

  const closeConfirmation = () => {
    setConfirming(null);
    setForceError(null);
    window.setTimeout(() => disconnectTriggerRef.current?.focus(), 0);
  };

  const moveRole = (index: number, key: string) => {
    const next = key === "Home" ? 0 : key === "End" ? 1 : key === "ArrowRight" || key === "ArrowDown" ? (index + 1) % 2 : key === "ArrowLeft" || key === "ArrowUp" ? (index + 1) % 2 : index;
    if (next === 1 && !childSelectable) return;
    if (next === index) return;
    roleRefs.current[next]?.focus();
    setRole(next === 0 ? "home" : "child");
  };
  const removeLink = async () => {
    if (!confirming) return;
    const pending = confirming;
    setBusy("remove"); setForceError(null);
    try { await requestLinkJson<{ linkId: string }>(apiBase, `/api/link/${encodeURIComponent(pending.row.id)}`, pending.force ? { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ force: true }) } : { method: "DELETE" }); closeConfirmation(); await refreshStatus(); }
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
  const primaryActionDisabled = role === "child" && !childSelectable;

  if (!sessionReady) return <div className="remote-link-page"><div className="page-head"><h2>{t("link.title")}</h2></div><Notice tone="warn">{t("link.sessionRequired")}</Notice></div>;

  return (
    <div className="remote-link-page">
      <div className="page-head"><div><h2>{t("link.title")}</h2><p className="page-sub">{t("link.subtitle")}</p></div><button type="button" className="btn btn-ghost btn-sm" onClick={() => void refreshStatus()} disabled={busy !== null}><IconRefresh />{t("link.refresh")}</button></div>
      {workspaceAvailable && <section className="panel remote-link-workspace-card"><div><strong>{t("remoteLink.workspaceMoved.title")}</strong><p>{t("remoteLink.workspaceMoved.body")}</p></div><button type="button" className="btn btn-ghost btn-sm" onClick={onOpenWorkspace ?? (() => { window.location.hash = "remote-workspace"; })}>{t("remoteLink.workspaceMoved.open")}</button></section>}
      {statusError && <Notice tone="err"><span className="remote-link-error">{t(statusError)}</span></Notice>}
      {statusRows.length === 0 && uiState === "off" && <section className="panel remote-link-off-preview"><div className="remote-link-switch-row"><div><strong>{t("link.switch")}</strong><p className="remote-link-info">{t("link.switchOffHint")}</p></div><button type="button" role="switch" className="remote-link-switch" aria-checked="false" aria-label={t("link.switch")} onClick={() => setUiState("role-select")} /></div><div className="remote-link-preview-content" aria-hidden="true"><div className="remote-link-preview-row"><div className="remote-link-preview-lines"><span /><span /><span /></div><span className="remote-link-status">{t("remoteLink.status.idle")}</span></div><div className="remote-link-preview-row"><div className="remote-link-preview-lines"><span /><span /></div><span className="remote-link-status">{t("remoteLink.role.child")}</span></div></div></section>}
      {uiState === "role-select" && <section className="panel remote-link-panel"><div><h3>{t("link.role.title")}</h3><p className="remote-link-info">{t("link.role.hint")}</p></div><div className="remote-link-role-grid" role="radiogroup" aria-label={t("link.role.title")}><button ref={element => { roleRefs.current[0] = element; }} type="button" role="radio" tabIndex={role === "home" ? 0 : -1} aria-checked={role === "home"} className="remote-link-role-card" onClick={() => setRole("home")} onKeyDown={event => { if (["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"].includes(event.key)) { event.preventDefault(); moveRole(0, event.key); } }}><strong>{t("link.role.home")}</strong><span>{t("link.role.homeHint")}</span></button><button ref={element => { roleRefs.current[1] = element; }} type="button" role="radio" tabIndex={childSelectable && role === "child" ? 0 : -1} aria-checked={role === "child"} aria-disabled={!childSelectable} className="remote-link-role-card" onClick={() => { if (childSelectable) { setRole("child"); void openSheet(); } }} onKeyDown={event => { if (childSelectable && ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"].includes(event.key)) { event.preventDefault(); moveRole(1, event.key); } }}><strong>{t("link.role.child")}</strong><span>{t("link.role.childHint")}</span></button></div>{!standaloneRuntime && <Notice tone="warn">{t("remoteLink.childDisabled")}</Notice>}{standaloneRuntime && status !== null && !status.joinAvailable && <Notice tone="warn">{t("remoteLink.childJoinUnavailable")}</Notice>}<button type="button" className="btn btn-primary" disabled={primaryActionDisabled || status?.role === "child"} onClick={() => void openSheet()}>{role === "child" ? t("remoteLink.findHome.action") : t("link.continue")}</button></section>}
      {(uiState === "connected" || uiState === "reconnecting" || uiState === "failed" || uiState === "restart-waiting" || status?.role === "child" || statusRows.length > 0 || uiState === "adding-child" || uiState === "confirming-host" || uiState === "applying" || uiState === "joining") && <section className="panel remote-link-panel"><div className="remote-link-toolbar"><div><h3>{role === "child" && standaloneRuntime ? t("remoteLink.findHome.title") : t("link.children")}</h3><p className="remote-link-info">{uiState === "restart-waiting" ? t("remoteLink.restart.waiting") : t(roleLabel)}</p></div><button ref={addButtonRef} type="button" className="btn btn-primary btn-sm" onClick={() => void openSheet()} disabled={busy !== null || uiState === "applying" || uiState === "joining" || uiState === "restart-waiting" || status?.role === "child"}><IconPlus />{role === "child" && standaloneRuntime ? t("remoteLink.findHome.action") : t("link.addChild")}</button></div>{uiState === "restart-waiting" ? <div className="remote-link-restart" aria-live="polite"><strong>{t("remoteLink.restart.title")}</strong><p>{t("remoteLink.restart.body")}</p></div> : status?.role === "child" ? <div className="remote-link-children" aria-live="polite"><div className="remote-link-row"><div className="remote-link-row-main"><strong>{status.child?.alias ?? t("remoteLink.role.child")}</strong>{status.child && <div className="remote-link-row-meta"><span className="remote-link-status" data-state={status.child.state}>{t(STATUS_LABEL[status.child.state])}</span></div>}</div></div></div> : statusRows.length > 0 ? <div className="remote-link-children" aria-live="polite">{statusRows.map(row => <div className="remote-link-row" key={row.id}><div className="remote-link-row-main"><strong>{row.alias}</strong><div className="remote-link-row-meta"><span className="remote-link-status" data-state={row.state}>{t(STATUS_LABEL[row.state])}</span><span>{row.direction === "hub-initiated" ? t("remoteLink.direction.hub") : t("remoteLink.direction.client")}</span>{row.reason && <span className="remote-link-error">{row.reason in REASON_TKEY ? t(REASON_TKEY[row.reason]) : <>{t("remoteLink.reason.generic")} <code>{row.reason}</code></>}</span>}</div></div><button type="button" className="btn btn-ghost btn-sm" onClick={event => { disconnectTriggerRef.current = event.currentTarget; setConfirming({ row, force: false }); }} disabled={busy !== null}><IconTrash />{t("link.disconnect")}</button></div>)}</div> : <p className="remote-link-info">{t(role === "child" && standaloneRuntime ? "remoteLink.findHome.empty" : "link.noChildren")}</p>}{(uiState === "reconnecting" || (uiState === "failed" && ((failedAction !== null && actionError?.key !== "remoteLink.error.join_restart_failed") || statusRows.some(row => row.state === "failed")))) && <div className="remote-link-status-message" aria-live="polite"><span className="remote-link-status" data-state={uiState === "failed" ? "failed" : "reconnecting"}>{t(STATUS_LABEL[uiState === "failed" ? "failed" : "reconnecting"])}</span><button type="button" className="btn btn-ghost btn-sm" onClick={retryFailedAction}>{t("link.retry")}</button></div>}{uiState === "joining" && <p className="remote-link-info" aria-live="polite">{t("remoteLink.joining")}</p>}{actionError && <LinkErrorNotice error={actionError} />}</section>}

      <dialog ref={sheetRef} className="remote-link-sheet" aria-labelledby="remote-link-sheet-title" onCancel={event => { event.preventDefault(); closeSheet(); }}>
        <div className="remote-link-sheet-head"><h3 id="remote-link-sheet-title">{role === "child" && standaloneRuntime ? t("remoteLink.findHome.title") : t("link.sheetTitle")}</h3><button type="button" className="btn btn-ghost btn-icon" onClick={closeSheet} aria-label={t("link.close")}><IconX /></button></div>
        <div className="remote-link-sheet-body"><div><h4>{role === "child" && standaloneRuntime ? t("remoteLink.findHome.body") : t("link.candidates")}</h4>{busy === "candidates" ? <p className="remote-link-info">{t("link.loading")}</p> : candidates.length > 0 ? <div className="remote-link-candidates">{candidates.map(candidate => <button type="button" className="remote-link-candidate" key={`${candidate.source}:${candidate.alias}`} onClick={() => setAlias(candidate.alias)}><span>{candidate.alias}</span><small>{candidate.source}</small></button>)}</div> : <p className="remote-link-info">{t("link.noCandidates")}</p>}</div><div className="remote-link-form"><label className="field-label" htmlFor="remote-link-alias">{t("link.alias")}</label><input id="remote-link-alias" className="input" spellCheck={false} value={alias} onChange={event => setAlias(event.target.value)} placeholder={t("link.aliasPlaceholder")} autoComplete="off" /><button type="button" className="btn btn-ghost" onClick={() => void runProbe()} disabled={!alias.trim() || busy !== null}><IconLink />{busy === "probe" ? t("link.probing") : t("link.probe")}</button></div>{probe && <div className="remote-link-panel"><div><span className="remote-link-info">{t("link.hostFingerprint")}</span><p className="remote-link-fingerprint"><code>{probe.fingerprint}</code></p><span className="remote-link-info">{probe.keyType}</span></div><label><input type="checkbox" checked={checkedFingerprint} onChange={event => setCheckedFingerprint(event.target.checked)} /> {t("link.confirmFingerprint")}</label><button type="button" className="btn btn-primary" onClick={() => void confirmHost()} disabled={!checkedFingerprint || busy !== null}>{busy === "confirm" ? t("link.confirming") : t("link.confirm")}</button></div>}{confirmation && <div className="remote-link-panel"><p className="remote-link-info">{t("link.ocxVersion", { version: confirmation.ocxVersion })}</p><button type="button" className="btn btn-primary" onClick={() => void (role === "child" && standaloneRuntime ? joinLink() : applyLink())} disabled={busy !== null || (role === "child" && !childSelectable)}>{role === "child" && standaloneRuntime ? (busy === "join" ? t("remoteLink.joining") : t("remoteLink.findHome.connect")) : (busy === "apply" ? t("link.applying") : t("link.apply"))}</button></div>}{actionError && <LinkErrorNotice error={actionError} />}<div className="remote-link-sheet-actions"><button type="button" className="btn btn-ghost" onClick={closeSheet}>{t("link.cancel")}</button></div></div>
      </dialog>

      <dialog ref={confirmRef} className="remote-link-confirm-dialog" aria-labelledby="remote-link-confirm-title" onCancel={event => { event.preventDefault(); closeConfirmation(); }}>
        {confirming && <><h3 id="remote-link-confirm-title">{confirming.force ? t("remoteLink.forceRemove.title", { alias: confirming.row.alias }) : t("link.disconnect")}</h3><p>{confirming.force ? <Trans k="remoteLink.forceRemove.body" cmd="ocx disconnect" vars={{ alias: confirming.row.alias }} /> : t("link.disconnectConfirm", { alias: confirming.row.alias })}</p>{forceError && <p className="remote-link-error" role="alert">{t(forceError)}</p>}<div className="remote-link-sheet-actions"><button type="button" className="btn btn-ghost" onClick={closeConfirmation}>{t("link.cancel")}</button><button type="button" className="btn btn-danger" onClick={() => void removeLink()} disabled={busy === "remove"}>{confirming.force ? t("remoteLink.forceRemove.confirm") : t("link.disconnect")}</button></div></>}
      </dialog>
    </div>
  );
}
