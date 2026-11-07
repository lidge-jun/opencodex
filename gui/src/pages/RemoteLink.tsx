import { useCallback, useEffect, useEffectEvent, useRef, useState, type KeyboardEvent, type ReactElement } from "react";
import {
  LinkApiError, parseRemoteLinkStatus, readRuntimeHealth, requestLinkJson, waitForChildRuntime, type ChildRestartWaitDeps, type LinkCandidateView, type LinkConfirmHostView,
  type LinkErrorCode, type LinkJoinDenied, type LinkProbeView, type LinkRowWire, type LinkWireState, type RemoteLinkStatusWire,
} from "../remote-link-api";
import { IconLink, IconPlus, IconRefresh, IconTrash, IconX } from "../icons";
import { Trans } from "../i18n/provider";
import { type TKey, useT } from "../i18n/shared";
import { isStandaloneRuntime, standaloneApiTargets } from "../api-targets";
import { ConnectPairingForm } from "../connect-pairing";
import FallbackPanel from "../components/FallbackPanel";
import { Button } from "@/components/ui-v2/button";
import { cn } from "@/lib/utils";
import { Banner, IconButton, PageHeader } from "../components/v2-startup/primitives";
import { LinkIntro, LinkStatus, LinkSwitchRow, Monogram, RoleCard, SheetSteps } from "../components/v2-startup/remote-link-parts";
import "../styles-remote-link.css";

type RemoteLinkRole = "home" | "child";
type RemoteLinkUiState = "off" | "role-select" | "adding-child" | "confirming-host" | "applying" | "joining" | "restart-waiting" | "connected" | "reconnecting" | "failed";

export interface RemoteLinkProps {
  apiBase: string;
  sessionReady: boolean;
  pairingRecoveryAvailable?: boolean;
  onRequestPairing?: () => void;
  workspaceAvailable?: boolean;
  onOpenWorkspace?: () => void;
  /** Called once the Child runtime answers after a join; the page reloads as that runtime. */
  onChildReady?: () => void;
  /** Test seam for the restart wait (fetch, clock, sleep). A caller passes one stable object. */
  restartWait?: Omit<ChildRestartWaitDeps, "onSlow">;
}

// The served document carries the runtime role and a fresh session, so only a reload makes the
// dashboard the Child's.
function reloadDashboard(): void { window.location.reload(); }

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
  join_port_mismatch: "remoteLink.error.join_port_mismatch",
  join_restart_failed: "remoteLink.error.join_restart_failed",
  join_rollback_failed: "remoteLink.error.join_rollback_failed",
  join_tunnel_failed: "remoteLink.error.join_tunnel_failed",
  key_issue_failed: "remoteLink.error.key_issue_failed",
  key_revoke_failed: "remoteLink.error.key_revoke_failed",
  link_apply_failed: "remoteLink.error.link_apply_failed",
  link_exists: "remoteLink.error.link_exists",
  link_not_found: "remoteLink.error.link_not_found",
  // Only `ocx link reconnect` can reach it: Retry restarts Home-initiated rows only.
  link_not_home_initiated: "remoteLink.error.generic",
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
const JOIN_DENIED_TKEY: Record<LinkJoinDenied, TKey> = {
  pairing_required: "remoteLink.joinDenied.pairing_required",
  standalone_required: "remoteLink.childDisabled",
  join_port_mismatch: "remoteLink.error.join_port_mismatch",
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
  return <Banner tone="err"><span className="remote-link-error">{t(error.key)}</span>{error.hint && <span className="remote-link-hint mt-1 block text-[12px] text-fg-muted [overflow-wrap:anywhere]">{t("remoteLink.reason.generic")} <code className="font-mono">{error.hint}</code></span>}</Banner>;
}

export default function RemoteLink({ apiBase, sessionReady, pairingRecoveryAvailable = false, onRequestPairing, workspaceAvailable = false, onOpenWorkspace, onChildReady = reloadDashboard, restartWait }: RemoteLinkProps): ReactElement {
  const t = useT();
  const [uiState, setUiState] = useState<RemoteLinkUiState>("off");
  const [role, setRole] = useState<RemoteLinkRole>("home");
  const [status, setStatus] = useState<RemoteLinkStatusWire | null>(null);
  const [statusError, setStatusError] = useState<TKey | null>(null);
  const [statusAuthorizationFailed, setStatusAuthorizationFailed] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [discovery, setDiscovery] = useState<"idle" | "loading" | "ready" | "failed">("idle");
  const [candidates, setCandidates] = useState<LinkCandidateView[]>([]);
  const [alias, setAlias] = useState("");
  const [probe, setProbe] = useState<LinkProbeView | null>(null);
  const [confirmation, setConfirmation] = useState<LinkConfirmHostView | null>(null);
  const [checkedFingerprint, setCheckedFingerprint] = useState(false);
  const [busy, setBusy] = useState<"candidates" | "probe" | "confirm" | "apply" | "join" | "remove" | "reconnect" | null>(null);
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
  // The standalone's pid before the join; the Child runtime that replaces it has another one.
  const restartPidRef = useRef<number | null>(null);
  const restartingRef = useRef(false);
  const [restartSlow, setRestartSlow] = useState(false);
  const pairingRecoveryAction = pairingRecoveryAvailable && onRequestPairing && (!sessionReady || statusAuthorizationFailed)
    ? <button type="button" className="link-btn" onClick={onRequestPairing}>{t("connection.pairing.title")}</button>
    : null;

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
    // While this computer restarts into a Child, the draining standalone cannot answer; the
    // /healthz wait below owns the page until it reloads.
    if (!sessionReady || document.visibilityState === "hidden" || restartingRef.current) return;
    statusRequestRef.current?.controller.abort();
    const controller = new AbortController();
    const sequence = ++statusSequenceRef.current;
    statusRequestRef.current = { controller, sequence };
    try {
      const value = parseRemoteLinkStatus(await requestLinkJson<unknown>(apiBase, "/api/link/status", { signal: controller.signal }));
      if (controller.signal.aborted || statusSequenceRef.current !== sequence) return;
      setStatus(value);
      setStatusError(null);
      setStatusAuthorizationFailed(false);
      if (failedAction) {
        setUiState("failed");
      } else if (value.role === "child") {
        // A Child shows its own link row; the tunnel state is on that row.
        setUiState("connected");
      } else if (value.links.length === 0) {
        setUiState(current => ["role-select", "adding-child", "confirming-host", "applying", "joining", "restart-waiting"].includes(current) ? current : "off");
      } else if (value.links.some(link => link.state === "failed")) setUiState("failed");
      else if (value.links.some(link => link.state === "reconnecting")) setUiState("reconnecting");
      else if (value.links.some(link => link.state === "connected")) setUiState("connected");
    } catch (error) {
      if (controller.signal.aborted || statusSequenceRef.current !== sequence) return;
      setStatusError(errorKey(error));
      setStatusAuthorizationFailed(error instanceof LinkApiError && (error.status === 401 || error.status === 403));
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
    if (uiState !== "restart-waiting") return;
    const controller = new AbortController();
    // The wait keeps checking past the slow notice, so a late Child still brings the page back.
    void waitForChildRuntime(apiBase, restartPidRef.current, controller.signal, { ...restartWait, onSlow: () => setRestartSlow(true) }).then(outcome => {
      if (outcome === "ready") onChildReady();
    });
    return () => controller.abort();
  }, [apiBase, onChildReady, restartWait, uiState]);

  useEffect(() => {
    if (!sheetOpen) {
      const wasOpen = sheetRef.current?.open;
      sheetRef.current?.close?.();
      if (wasOpen) addButtonRef.current?.focus();
      return;
    }
    const dialog = sheetRef.current;
    if (dialog && !dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal(); else dialog.setAttribute("open", "");
    }
    const timer = window.setTimeout(() => dialog?.querySelector<HTMLElement>("input, button")?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [sheetOpen]);

  useEffect(() => {
    const dialog = confirmRef.current;
    if (!confirming) { dialog?.close?.(); return; }
    if (dialog && !dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal(); else dialog.setAttribute("open", "");
    }
  }, [confirming]);

  // Cancelling the sheet abandons the attempt, so late responses cannot recreate its state.
  const closeSheet = () => { cancelLinkAttempt(); setSheetOpen(false); setDiscovery("idle"); setCandidates([]); setProbe(null); setConfirmation(null); setCheckedFingerprint(false); setActionError(null); setFailedAction(null); setBusy(null); setUiState(current => ["failed", "adding-child", "confirming-host", "applying", "joining"].includes(current) ? "adding-child" : current); };
  const standaloneRuntime = isStandaloneRuntime();
  // The server offers the join to this dashboard session only on a standalone runtime that runs
  // on its configured port, the one port the Child runtime can restart on.
  const childSelectable = standaloneRuntime && status?.joinAvailable === true;
  const joinDeniedKey = status?.joinDenied ? JOIN_DENIED_TKEY[status.joinDenied] : "remoteLink.joinDenied.unavailable";
  // Offer code entry only after the operator opens link setup, and only on the
  // literal same-origin loopback transport accepted by the standalone mint.
  const localPairingTarget = standaloneApiTargets(apiBase).shared;
  const canPairLocally = standaloneRuntime && window.location.protocol === "http:"
    && ["127.0.0.1", "[::1]"].includes(window.location.hostname)
    && localPairingTarget.serverOrigin === window.location.origin;
  const loadCandidates = async () => {
    const attempt = startLinkAttempt();
    setDiscovery("loading"); setCandidates([]); setActionError(null); setFailedAction(null); setBusy("candidates");
    setProbe(null); setConfirmation(null); setCheckedFingerprint(false);
    try {
      const result = await requestLinkJson<unknown>(apiBase, "/api/link/candidates", { signal: attempt.controller.signal });
      if (!isCurrentLinkAttempt(attempt)) return;
      setCandidates(parseCandidates(result)); setDiscovery("ready");
    } catch (error) {
      if (!isCurrentLinkAttempt(attempt)) return;
      setDiscovery("failed"); setActionError(linkActionError(error));
    } finally {
      if (isCurrentLinkAttempt(attempt)) setBusy(null);
    }
  };
  const openSheet = async () => {
    setSheetOpen(true); setUiState("adding-child");
    await loadCandidates();
  };
  const runProbe = async (requestedAlias = alias.trim(), attempt = linkAttemptRef.current ?? startLinkAttempt()) => {
    const value = requestedAlias.trim();
    if (!value) return;
    if (discovery === "failed") setDiscovery("idle");
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
      // The pid before the restart, so the wait below reloads only onto the new Child runtime.
      restartPidRef.current = (await readRuntimeHealth(apiBase, attempt.controller.signal))?.pid ?? null;
      if (!isCurrentLinkAttempt(attempt)) return;
      await requestLinkJson<{ linkId: string; alias: string; restarting: true }>(apiBase, "/api/link/join", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ alias: value }), signal: attempt.controller.signal });
      if (!isCurrentLinkAttempt(attempt)) return;
      restartingRef.current = true;
      abortStatusRequest();
      closeSheet(); setRestartSlow(false); setUiState("restart-waiting");
    } catch (error) {
      if (!isCurrentLinkAttempt(attempt)) return;
      setActionError(linkActionError(error)); setFailedAction({ phase: "join", alias: value }); setUiState("failed");
    } finally {
      if (isCurrentLinkAttempt(attempt)) setBusy(null);
    }
  };

  // Retry on a failed or reconnecting Home link restarts its tunnel now instead of only re-reading
  // status, which never changed a link the supervisor had given up on.
  const reconnectLinks = async () => {
    const rows = (status?.links ?? []).filter(row => row.direction === "hub-initiated" && (row.state === "failed" || row.state === "reconnecting"));
    if (rows.length === 0) { await refreshStatus(); return; }
    setBusy("reconnect"); setActionError(null);
    try {
      const results = await Promise.allSettled(rows.map(row => requestLinkJson<{ linkId: string }>(apiBase, `/api/link/${encodeURIComponent(row.id)}/reconnect`, { method: "POST" })));
      const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (rejected) setActionError(linkActionError(rejected.reason));
    } finally {
      await refreshStatus();
      setBusy(null);
    }
  };

  const retryFailedAction = () => {
    if (!failedAction) { void reconnectLinks(); return; }
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

  const refreshButton = <Button variant="ghost" size="sm" onClick={() => void refreshStatus()} disabled={busy !== null}><IconRefresh />{t("link.refresh")}</Button>;
  if (!sessionReady) return (
    <div className="remote-link-page flex min-w-0 flex-col gap-5 font-sans text-fg">
      <PageHeader title={t("link.title")} subtitle={t("link.subtitle")} />
      <Banner tone="warn" action={pairingRecoveryAction}>{t("link.sessionRequired")}</Banner>
    </div>
  );

  const childHome = role === "child" && standaloneRuntime;
  const showLinks = uiState === "connected" || uiState === "reconnecting" || uiState === "failed" || uiState === "restart-waiting" || status?.role === "child" || statusRows.length > 0 || uiState === "adding-child" || uiState === "confirming-host" || uiState === "applying" || uiState === "joining";
  const showStatusMessage = !sheetOpen && (uiState === "reconnecting" || (uiState === "failed" && ((failedAction !== null && actionError?.key !== "remoteLink.error.join_restart_failed") || statusRows.some(row => row.state === "failed"))));
  const onRoleKey = (event: KeyboardEvent<HTMLButtonElement>, index: number, enabled: boolean) => {
    if (enabled && ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"].includes(event.key)) { event.preventDefault(); moveRole(index, event.key); }
  };

  return (
    <div className="remote-link-page flex min-w-0 flex-col gap-5 font-sans text-fg">
      <PageHeader title={t("link.title")} subtitle={t("link.subtitle")} actions={refreshButton} />
      {workspaceAvailable && (
        <Banner tone="info" className="remote-link-workspace-card" action={<Button variant="outline" size="sm" onClick={onOpenWorkspace ?? (() => { window.location.hash = "remote-workspace"; })}>{t("remoteLink.workspaceMoved.open")}</Button>}>
          <strong className="font-semibold">{t("remoteLink.workspaceMoved.title")}</strong>{" "}<span className="text-fg-muted">{t("remoteLink.workspaceMoved.body")}</span>
        </Banner>
      )}
      {statusError && <Banner tone="err" action={pairingRecoveryAction}><span className="remote-link-error">{t(statusError)}</span></Banner>}

      {statusRows.length === 0 && uiState === "off" && <LinkIntro onTurnOn={() => setUiState("role-select")} />}

      {uiState === "role-select" && (
        <section className="remote-link-panel flex min-w-0 flex-col rounded-[12px] bg-surface p-1 ring-1 ring-line" aria-label={t("link.role.title")}>
          <LinkSwitchRow on onToggle={() => setUiState("off")} hint={t("link.role.title")} />
          <div className="flex min-w-0 flex-col gap-4 rounded-[8px] bg-bg p-4 ring-1 ring-line">
            <p className="m-0 max-w-[72ch] text-[13px] leading-5 text-fg-muted">{t("link.role.hint")}</p>
            <div className="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label={t("link.role.title")}>
              <RoleCard role="home" buttonRef={element => { roleRefs.current[0] = element; }} tabIndex={role === "home" ? 0 : -1} checked={role === "home"}
                onSelect={() => setRole("home")} onKeyDown={event => onRoleKey(event, 0, true)} />
              <RoleCard role="child" buttonRef={element => { roleRefs.current[1] = element; }} tabIndex={childSelectable && role === "child" ? 0 : -1} checked={role === "child"} disabled={!childSelectable}
                onSelect={() => { if (childSelectable) { setRole("child"); void openSheet(); } }} onKeyDown={event => onRoleKey(event, 1, childSelectable)} />
            </div>
            {!standaloneRuntime && <Banner tone="warn">{t("remoteLink.childDisabled")}</Banner>}
            {standaloneRuntime && status !== null && !status.joinAvailable && <Banner tone="warn">{t(joinDeniedKey)}</Banner>}
          </div>
          <div className="flex justify-end px-3 py-2.5">
            <Button variant="primary" data-action="continue" disabled={primaryActionDisabled || status?.role === "child"} onClick={() => void openSheet()}>
              {role === "child" ? t("remoteLink.findHome.action") : t("link.continue")}
            </Button>
          </div>
        </section>
      )}
      {uiState === "role-select" && canPairLocally && status?.joinAvailable === false && status.joinDenied === "pairing_required" && (
        <ConnectPairingForm local target={localPairingTarget} onConnected={() => { void refreshStatus(); }} />
      )}

      {showLinks && (
        <section className="remote-link-panel flex min-w-0 flex-col rounded-[12px] bg-surface p-1 ring-1 ring-line" aria-labelledby="remote-link-list-title">
          <div className="flex flex-wrap items-center gap-3 px-4 py-3">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <h3 id="remote-link-list-title" className="m-0 text-[15px] leading-6 font-semibold tracking-[-0.01em]">{childHome ? t("remoteLink.findHome.title") : t("link.children")}</h3>
              <span className="text-[13px] leading-5 text-fg-muted">{uiState === "restart-waiting" ? t("remoteLink.restart.waiting") : t(roleLabel)}</span>
            </div>
            <Button ref={addButtonRef} variant="primary" size="sm" onClick={() => void openSheet()} disabled={busy !== null || uiState === "applying" || uiState === "joining" || uiState === "restart-waiting" || status?.role === "child"}>
              <IconPlus />{childHome ? t("remoteLink.findHome.action") : t("link.addChild")}
            </Button>
          </div>
          <div className="flex min-w-0 flex-col rounded-[8px] bg-bg ring-1 ring-line">
            {uiState === "restart-waiting" ? (
              <div className="remote-link-restart flex flex-col gap-1.5 px-4 py-4" aria-live="polite">
                <strong className="text-[14px] font-semibold">{t("remoteLink.restart.title")}</strong>
                <p className="m-0 text-[13px] leading-5 text-fg-muted">{t("remoteLink.restart.body")}</p>
                {restartSlow && <Banner tone="warn" className="mt-1">{t("remoteLink.restart.slow")}</Banner>}
              </div>
            ) : status?.role === "child" ? (
              <ul className="remote-link-children m-0 list-none p-0" aria-live="polite">
                <li className="remote-link-row flex min-w-0 items-center gap-3 px-4 py-3">
                  <Monogram name={status.child?.alias ?? t("remoteLink.role.child")} />
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-[14px] font-semibold">{status.child?.alias ?? t("remoteLink.role.child")}</span>
                    {status.child && <LinkStatus state={status.child.state}>{t(STATUS_LABEL[status.child.state])}</LinkStatus>}
                  </div>
                </li>
              </ul>
            ) : statusRows.length > 0 ? (
              <ul className="remote-link-children m-0 flex list-none flex-col divide-y divide-line p-0" aria-live="polite">
                {statusRows.map(row => (
                  <li className="remote-link-row flex min-w-0 items-center gap-3 px-4 py-3" key={row.id}>
                    <Monogram name={row.alias} />
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="truncate text-[14px] font-semibold">{row.alias}</span>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12px] leading-5 text-fg-muted">
                        <LinkStatus state={row.state}>{t(STATUS_LABEL[row.state])}</LinkStatus>
                        <span>{row.direction === "hub-initiated" ? t("remoteLink.direction.hub") : t("remoteLink.direction.client")}</span>
                        {row.reason && <span className="remote-link-error text-danger">{row.reason in REASON_TKEY ? t(REASON_TKEY[row.reason]) : <>{t("remoteLink.reason.generic")} <code className="font-mono">{row.reason}</code></>}</span>}
                      </div>
                    </div>
                    <Button variant="ghost" size="sm" className="hover:bg-danger-soft hover:text-danger" onClick={event => { disconnectTriggerRef.current = event.currentTarget; setConfirming({ row, force: false }); }} disabled={busy !== null}>
                      <IconTrash />{t("link.disconnect")}
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="m-0 px-4 py-6 text-center text-[13px] text-fg-muted">{t(childHome ? "remoteLink.findHome.empty" : "link.noChildren")}</p>
            )}
          </div>
          {(showStatusMessage || uiState === "joining" || (!sheetOpen && actionError)) && (
            <div className="flex flex-col gap-2 px-3 py-2.5">
              {showStatusMessage && (
                <div className="remote-link-status-message flex items-center justify-between gap-3" aria-live="polite">
                  <LinkStatus state={uiState === "failed" ? "failed" : "reconnecting"}>{t(STATUS_LABEL[uiState === "failed" ? "failed" : "reconnecting"])}</LinkStatus>
                  <Button variant="outline" size="sm" onClick={retryFailedAction} disabled={busy !== null}>{t("link.retry")}</Button>
                </div>
              )}
              {uiState === "joining" && <p className="m-0 text-[13px] text-fg-muted" aria-live="polite">{t("remoteLink.joining")}</p>}
              {!sheetOpen && actionError && <LinkErrorNotice error={actionError} />}
            </div>
          )}
        </section>
      )}
      {(status?.role === "child" || statusRows.length > 0) && <FallbackPanel apiBase={apiBase} section="devices" readOnly={status?.role === "child"} />}

      <dialog ref={sheetRef} aria-labelledby="remote-link-sheet-title" onCancel={event => { event.preventDefault(); closeSheet(); }}
        className="remote-link-sheet m-auto max-h-[min(800px,calc(100dvh-24px))] w-[min(620px,calc(100vw-24px))] flex-col overflow-hidden rounded-[14px] border-0 bg-surface p-1 text-fg shadow-lg ring-1 ring-line backdrop:bg-black/40 open:flex">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[10px] bg-bg ring-1 ring-line">
          <header className="flex flex-col gap-3 border-b border-line px-5 pt-4 pb-3.5">
            <div className="flex items-start justify-between gap-3">
              <h3 id="remote-link-sheet-title" className="m-0 text-[16px] leading-6 font-semibold tracking-[-0.015em]">{childHome ? t("remoteLink.findHome.title") : t("link.sheetTitle")}</h3>
              <IconButton label={t("link.close")} onClick={closeSheet}><IconX /></IconButton>
            </div>
            <SheetSteps step={confirmation ? 2 : probe ? 1 : 0} />
          </header>
          <div className="flex min-h-0 flex-col gap-5 overflow-y-auto px-5 py-4">
            {role === "home" && <div className="flex flex-col gap-1 text-[13px] leading-5 text-fg-muted"><p className="m-0">{t("link.setup.relationship")}</p><p className="m-0">{t("link.setup.requirements")}</p></div>}
            <div className="flex flex-col gap-2">
              <h4 className="m-0 text-[13px] leading-5 font-semibold">{childHome ? t("remoteLink.findHome.body") : t("link.candidates")}</h4>
              {discovery === "loading" && <p className="m-0 text-[13px] text-fg-muted" role="status">{t("link.loading")}</p>}
              {discovery === "failed" && <><p className="m-0 text-[13px] text-fg-muted">{t("link.discoveryFailed")}</p>{sheetOpen && actionError && <LinkErrorNotice error={actionError} />}</>}
              {discovery === "ready" && (candidates.length > 0 ? (
                <div className="flex flex-col gap-1.5">
                  {candidates.map(candidate => (
                    <button type="button" key={`${candidate.source}:${candidate.alias}`} onClick={() => setAlias(candidate.alias)} aria-pressed={alias === candidate.alias}
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
                <Button variant="ghost" size="sm" onClick={() => void loadCandidates()} disabled={busy !== null}><IconRefresh />{t(discovery === "failed" ? "link.retry" : "link.rescan")}</Button>
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-[13px] leading-5 font-semibold" htmlFor="remote-link-alias">{t("link.alias")}</label>
              <div className="flex flex-wrap items-center gap-2">
                <input id="remote-link-alias" aria-describedby="remote-link-alias-help" className="input min-w-0 flex-1 font-mono" spellCheck={false} value={alias} onChange={event => setAlias(event.target.value)} placeholder={t("link.aliasPlaceholder")} autoComplete="off" />
                <Button variant="outline" onClick={() => void runProbe()} disabled={!alias.trim() || busy !== null}><IconLink />{busy === "probe" ? t("link.probing") : t("link.probe")}</Button>
              </div>
              <p id="remote-link-alias-help" className="m-0 text-[12px] leading-[18px] text-fg-subtle">{t("link.aliasRequired")}</p>
            </div>
            {probe && (
              <div className="flex flex-col gap-3 rounded-[10px] bg-surface p-4 ring-1 ring-line">
                <div className="flex flex-col gap-1.5">
                  <span className="text-[13px] font-semibold">{t("link.hostFingerprint")} <span className="font-normal text-fg-subtle">{probe.keyType}</span></span>
                  <p className="remote-link-fingerprint m-0 rounded-[8px] bg-bg px-3 py-2 font-mono text-[12.5px] ring-1 ring-line [overflow-wrap:anywhere]"><code>{probe.fingerprint}</code></p>
                </div>
                <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={checkedFingerprint} onChange={event => setCheckedFingerprint(event.target.checked)} /> {t("link.confirmFingerprint")}</label>
                <Button variant="primary" className="self-start" onClick={() => void confirmHost()} disabled={!checkedFingerprint || busy !== null}>{busy === "confirm" ? t("link.confirming") : t("link.confirm")}</Button>
              </div>
            )}
            {confirmation && (
              <div className="flex flex-col gap-3 rounded-[10px] bg-surface p-4 ring-1 ring-line">
                <p className="m-0 text-[13px] text-fg-muted">{t("link.ocxVersion", { version: confirmation.ocxVersion })}</p>
                {childHome && <Banner tone="warn">{t("remoteLink.findHome.notice")}</Banner>}
                <Button variant="primary" className="self-start" onClick={() => void (childHome ? joinLink() : applyLink())} disabled={busy !== null || (role === "child" && !childSelectable)}>
                  {childHome ? (busy === "join" ? t("remoteLink.joining") : t("remoteLink.findHome.connect")) : (busy === "apply" ? t("link.applying") : t("link.apply"))}
                </Button>
              </div>
            )}
            {sheetOpen && discovery !== "failed" && actionError && <LinkErrorNotice error={actionError} />}
            {failedAction && actionError?.key !== "remoteLink.error.join_restart_failed" && (
              <div className="flex flex-col gap-2">
                {failedAction.phase === "probe" && <><p className="m-0 text-[13px] leading-5 text-fg-muted">{t("link.probeHelp")}</p><pre className="m-0 rounded-[8px] bg-surface px-3 py-2 font-mono text-[12px] whitespace-pre-wrap ring-1 ring-line"><code>{"ssh -o BatchMode=yes <alias> true"}</code></pre></>}
                <Button variant="outline" size="sm" className="self-start" onClick={retryFailedAction} disabled={busy !== null}>{t("link.retry")}</Button>
              </div>
            )}
          </div>
        </div>
        <footer className="flex shrink-0 justify-end gap-2 px-2 py-2"><Button variant="ghost" onClick={closeSheet}>{t("link.cancel")}</Button></footer>
      </dialog>

      <dialog ref={confirmRef} aria-labelledby="remote-link-confirm-title" onCancel={event => { event.preventDefault(); closeConfirmation(); }}
        className="remote-link-confirm-dialog m-auto w-[min(440px,calc(100vw-24px))] rounded-[14px] border-0 bg-surface p-1 text-fg shadow-lg ring-1 ring-line backdrop:bg-black/40">
        {confirming && <>
          <div className="flex flex-col gap-2 rounded-[10px] bg-bg px-5 py-4 ring-1 ring-line">
            <h3 id="remote-link-confirm-title" className="m-0 text-[16px] leading-6 font-semibold tracking-[-0.015em]">{confirming.force ? t("remoteLink.forceRemove.title", { alias: confirming.row.alias }) : t("link.disconnect")}</h3>
            <p className="m-0 text-[14px] leading-[21px] text-fg-muted">{confirming.force ? <Trans k="remoteLink.forceRemove.body" cmd="ocx disconnect" vars={{ alias: confirming.row.alias }} /> : t("link.disconnectConfirm", { alias: confirming.row.alias })}</p>
            {forceError && <p className="remote-link-error m-0 text-[13px] text-danger" role="alert">{t(forceError)}</p>}
          </div>
          <div className="flex justify-end gap-2 px-2 py-2">
            <Button variant="ghost" data-action="cancel" onClick={closeConfirmation}>{t("link.cancel")}</Button>
            <Button variant="danger" data-action="confirm" onClick={() => void removeLink()} disabled={busy === "remove"}>{confirming.force ? t("remoteLink.forceRemove.confirm") : t("link.disconnect")}</Button>
          </div>
        </>}
      </dialog>
    </div>
  );
}
