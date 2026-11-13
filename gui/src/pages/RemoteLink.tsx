import { useCallback, useEffect, useEffectEvent, useRef, useState, type KeyboardEvent, type ReactElement } from "react";
import {
  LinkApiError, parseRemoteLinkConfirmation, parseRemoteLinkStatus, readRuntimeHealth, requestLinkJson, waitForChildRuntime, type ChildRestartWaitDeps, type LinkCandidateView, type LinkConfirmHostView,
  type LinkErrorCode, type LinkJoinDenied, type LinkProbeView, type LinkResidual, type LinkRowWire, type LinkWireState, type RemoteLinkStatusWire,
} from "../remote-link-api";
import { IconPlus, IconRefresh, IconTrash } from "../icons";
import { type TKey, useT } from "../i18n/shared";
import { isStandaloneRuntime, standaloneApiTargets } from "../api-targets";
import { ConnectPairingForm } from "../connect-pairing";
import FallbackPanel from "../components/FallbackPanel";
import { Button } from "@/components/ui-v2/button";
import { Banner, PageHeader, StateBadge } from "../components/v2-startup/primitives";
import { LinkIntro, LinkStatus, LinkSwitchRow, Monogram, RoleCard } from "../components/v2-startup/remote-link-parts";
import { type ForceRemovedLink, RemoteLinkDisconnectDialog, RemoteLinkForceRemovedNotice } from "./RemoteLinkDialogs";
import { type BoundRefusal, boundRefusal } from "../remote-link-api";
import { RemoteLinkDiagnostics } from "./RemoteLinkDiagnostics";
import { LinkErrorNotice, RemoteLinkSheet, type LinkActionErrorView, type LinkChildStep } from "./RemoteLinkSheet";
import { getChildJob, jobHoldsLink, type ChildJobView, type ChildOp } from "../remote-link-child-ops-api";
import { ChildBulkBar, ChildJobProgress, ChildPolicyPanel, ChildRowActions, ChildRowBadges } from "./RemoteLinkChildActions";
import "../styles-remote-link.css";

type RemoteLinkRole = "home" | "child";
type RemoteLinkUiState = "off" | "role-select" | "adding-child" | "confirming-host" | "applying" | "joining" | "restart-waiting" | "connected" | "reconnecting" | "failed";

export interface RemoteLinkProps {
  apiBase: string;
  /** Base for this computer's own diagnostics; on a connected Child the machine plane, never the Home relay. */
  diagnosticsApiBase?: string;
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
  child_external_provider_conflict: "remoteLink.error.child_external_provider_conflict",
  child_port_busy: "remoteLink.error.child_port_busy",
  compensation_failed: "remoteLink.error.compensation_failed",
  fingerprint_failed: "remoteLink.error.fingerprint_failed",
  forbidden: "remoteLink.error.forbidden",
  host_confirmation_expired: "remoteLink.error.host_confirmation_expired",
  host_fingerprint_mismatch: "remoteLink.error.host_fingerprint_mismatch",
  host_not_confirmed: "remoteLink.error.host_not_confirmed",
  invalid_alias: "remoteLink.error.invalid_alias",
  invalid_body: "remoteLink.error.invalid_body",
  invalid_job_id: "remoteLink.error.invalid_job_id",
  invalid_link_id: "remoteLink.error.invalid_link_id",
  join_connect_failed: "remoteLink.error.join_connect_failed",
  join_in_progress: "remoteLink.error.join_in_progress",
  join_issue_failed: "remoteLink.error.join_issue_failed",
  join_port_failed: "remoteLink.error.join_port_failed",
  join_port_mismatch: "remoteLink.error.join_port_mismatch",
  join_restart_failed: "remoteLink.error.join_restart_failed",
  join_rollback_failed: "remoteLink.error.join_rollback_failed",
  join_tunnel_failed: "remoteLink.error.join_tunnel_failed",
  job_not_found: "remoteLink.error.job_not_found",
  key_issue_failed: "remoteLink.error.key_issue_failed",
  key_revoke_failed: "remoteLink.error.key_revoke_failed",
  link_apply_failed: "remoteLink.error.link_apply_failed",
  link_exists: "remoteLink.error.link_exists",
  link_not_found: "remoteLink.error.link_not_found",
  link_not_home_initiated: "remoteLink.error.link_not_home_initiated",
  link_operation_in_progress: "remoteLink.error.link_operation_in_progress",
  link_remove_failed: "remoteLink.error.link_remove_failed",
  link_unavailable: "remoteLink.error.link_unavailable",
  listener_unavailable: "remoteLink.error.listener_unavailable",
  no_eligible_links: "remoteLink.error.no_eligible_links",
  policy_write_failed: "remoteLink.error.policy_write_failed",
  probe_failed: "remoteLink.error.probe_failed",
  purge_unsupported: "remoteLink.error.purge_unsupported",
  remote_connect_failed: "remoteLink.error.remote_connect_failed",
  remote_disconnect_failed: "remoteLink.error.remote_disconnect_failed",
  remote_ocx_missing: "remoteLink.error.remote_ocx_missing",
  remote_ocx_outdated: "remoteLink.error.remote_ocx_outdated",
  remote_ocx_unrecognized: "remoteLink.error.remote_ocx_unrecognized",
  remote_plant_failed: "remoteLink.error.remote_plant_failed",
  remote_plant_timeout: "remoteLink.error.remote_plant_timeout",
  remote_plant_unavailable: "remoteLink.error.remote_plant_unavailable",
  remote_port_failed: "remoteLink.error.remote_port_failed",
  runtime_role_client: "remoteLink.error.runtime_role_client",
  standalone_required: "remoteLink.error.standalone_required",
  tailscale_session_refused: "remoteLink.error.tailscale_session_refused",
  version_probe_failed: "remoteLink.error.version_probe_failed",
  link_pin_conflict: "remoteLink.error.link_pin_conflict",
  host_key_changed: "remoteLink.error.host_key_changed",
  trust_file_unexpected: "remoteLink.error.trust_file_unexpected",
  key_cleanup_failed: "remoteLink.error.key_cleanup_failed",
  link_cleanup_uncertain: "remoteLink.error.link_cleanup_uncertain",
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

function errorKey(error: unknown): TKey {
  if (error instanceof LinkApiError && error.code in ERROR_TKEY) return ERROR_TKEY[error.code as LinkErrorCode];
  return "remoteLink.error.generic";
}

/** Whether a Child applied the Home's current Codex settings; null when either digest is unknown. */
function paritySynced(homeDigest: string | null, childDigest: string | null): boolean | null {
  return homeDigest !== null && childDigest !== null ? homeDigest === childDigest : null;
}

/**
 * The Child's recovery step for each residual variant, bound to the attempt's link id (src/link/residual-recovery.ts): every
 * command carries --expect-link, so it leaves a Child that another link joined since. One command per chip ({cmd}); further
 * lines name the bound rule and what a build older than the flag does. Without an id nothing can be bound.
 */
const POSIX_PURGE = "~/.cache/opencodex/bin/ocx-child detach --purge";
const WINDOWS_PURGE = '"%LOCALAPPDATA%\\opencodex\\bin\\ocx-child.exe" detach --purge';
// Where the plant puts the binary on a Windows Child without LOCALAPPDATA.
const WINDOWS_FALLBACK_PURGE = '"%USERPROFILE%\\.cache\\opencodex\\bin\\ocx-child.exe" detach --purge';
function residualChildStep(residual: LinkResidual): LinkChildStep {
  const id = residual.linkId;
  if (id === null || residual.step === "noLink") return { key: "remoteLink.residual.noLink" };
  const bound = (cmd: string) => cmd + " --expect-link " + id;
  const vars = { linkId: id };
  const boundLine = { key: "remoteLink.residual.bound", vars } as const;
  const olderFull = { key: "remoteLink.residual.olderFull", cmd: "ocx connect status --json", vars } as const;
  const olderLightweight = { key: "remoteLink.residual.olderLightweight" } as const;
  const fallback = { key: "remoteLink.residual.purgeWindowsFallback", cmd: bound(WINDOWS_FALLBACK_PURGE) } as const;
  // The lightweight agent by its managed path for the Child's platform (not necessarily on PATH), then a copy placed by hand.
  const posixDetach = bound("~/.cache/opencodex/bin/ocx-child detach");
  const windowsDetach = bound('"%LOCALAPPDATA%\\opencodex\\bin\\ocx-child.exe" detach');
  const windowsFallbackDetach = { key: "remoteLink.residual.purgeWindowsFallback", cmd: bound('"%USERPROFILE%\\.cache\\opencodex\\bin\\ocx-child.exe" detach') } as const;
  const placed = residual.platform === "windows" ? { key: "remoteLink.residual.lightweightPlacedWindows", cmd: "where.exe ocx-child" } as const
    : { key: "remoteLink.residual.lightweightPlaced", cmd: "command -v ocx-child" } as const;
  const lightweightMore = residual.platform === "windows" ? [windowsFallbackDetach, placed]
    : residual.platform === "posix" ? [placed] : [{ key: "remoteLink.residual.purgeAnyWindows", cmd: windowsDetach } as const, windowsFallbackDetach, placed];
  switch (residual.step) {
    case "purge": return { key: "remoteLink.residual.purge", cmd: bound(POSIX_PURGE), more: [boundLine] };
    case "purgeWindows": return { key: "remoteLink.residual.purgeWindows", cmd: bound(WINDOWS_PURGE), more: [fallback, boundLine] };
    case "purgeAny": return { key: "remoteLink.residual.purgeAny", cmd: bound(POSIX_PURGE), more: [{ key: "remoteLink.residual.purgeAnyWindows", cmd: bound(WINDOWS_PURGE) }, fallback, boundLine] };
    case "ephemeral": return residual.platform === "windows"
      ? { key: "remoteLink.residual.purgeWindows", cmd: windowsDetach, more: [...lightweightMore, boundLine, olderLightweight] }
      : { key: residual.platform === "posix" ? "remoteLink.residual.ephemeral" : "remoteLink.residual.purgeAny", cmd: posixDetach, more: [...lightweightMore, boundLine, olderLightweight] };
    case "full": return { key: "remoteLink.residual.full", cmd: bound("ocx disconnect"), more: [boundLine, olderFull] };
    case "unknown": return { key: "remoteLink.residual.unknown", cmd: bound("ocx disconnect"), more: [{ key: "remoteLink.residual.unknownLightweight", cmd: residual.platform === "windows" ? windowsDetach : posixDetach }, ...lightweightMore, boundLine, olderLightweight, olderFull] };
  }
}

function linkActionError(error: unknown): LinkActionErrorView {
  if (!(error instanceof LinkApiError)) return { key: errorKey(error), hint: null };
  return { key: errorKey(error), hint: error.hint, childStep: error.residual ? residualChildStep(error.residual) : null };
}

export default function RemoteLink({ apiBase, diagnosticsApiBase = apiBase, sessionReady, pairingRecoveryAvailable = false, onRequestPairing, workspaceAvailable = false, onOpenWorkspace, onChildReady = reloadDashboard, restartWait }: RemoteLinkProps): ReactElement {
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
  // Revision 6: child operations and the policy save never enter `busy`, which RemoteLinkSheet types as a closed union.
  const [childOpBusy, setChildOpBusy] = useState<{ linkId: string | "all"; op: ChildOp } | null>(null);
  const [policyBusy, setPolicyBusy] = useState(false);
  // Bumped by the page Refresh so the policy panel re-reads alongside the status; a poll never bumps it.
  const [policyReload, setPolicyReload] = useState(0);
  const [childJobs, setChildJobs] = useState<ChildJobView[]>([]);
  const childJobIds = useRef(new Set<string>());
  const [actionError, setActionError] = useState<LinkActionErrorView | null>(null);
  const [failedAction, setFailedAction] = useState<FailedAction | null>(null);
  const [confirming, setConfirming] = useState<{ row: LinkRowWire; force: boolean; refusal?: BoundRefusal | null } | null>(null);
  const [purgeOnDisconnect, setPurgeOnDisconnect] = useState(false);
  const [forceError, setForceError] = useState<TKey | null>(null);
  const [forceRemoved, setForceRemoved] = useState<ForceRemovedLink[]>([]);
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
      const value = parseRemoteLinkStatus(await requestLinkJson<unknown>(apiBase, "/api/link/status?children=1", { signal: controller.signal }));
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
    const confirmBody = role === "home"
      ? { alias: probe.alias, fingerprint: probe.fingerprint, allowMissing: true }
      : { alias: probe.alias, fingerprint: probe.fingerprint };
    try {
      const result = await requestLinkJson<unknown>(apiBase, "/api/link/confirm-host", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(confirmBody), signal: attempt.controller.signal });
      if (!isCurrentLinkAttempt(attempt)) return;
      setConfirmation(parseRemoteLinkConfirmation(result));
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
    const applyBody = confirmed.runtimeKind === "missing" ? { alias: confirmed.alias, plant: true } : { alias: confirmed.alias };
    try {
      await requestLinkJson<{ linkId: string }>(apiBase, "/api/link/apply", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(applyBody), signal: attempt.controller.signal });
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
    setPurgeOnDisconnect(false);
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
    const deleteInit: RequestInit = pending.force
      ? { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ force: true }) }
      : purgeOnDisconnect && pending.row.childKind === "ephemeral"
        ? { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ purge: true }) }
        : { method: "DELETE" };
    try {
      await requestLinkJson<{ linkId: string }>(apiBase, `/api/link/${encodeURIComponent(pending.row.id)}`, deleteInit);
      if (pending.force) setForceRemoved(current => [...current.filter(item => item.id !== pending.row.id), { id: pending.row.id, alias: pending.row.alias, kind: pending.row.childKind ?? "unknown" }]);
      closeConfirmation(); await refreshStatus();
    }
    catch (error) {
      if (!pending.force && error instanceof LinkApiError && error.code === "remote_disconnect_failed") setConfirming({ row: pending.row, force: true, refusal: boundRefusal(error.hint) });
      else setForceError(errorKey(error));
    }
    finally { setBusy(null); }
  };

  const statusRows = status?.links ?? [];
  // A job accepted by this page disables its links' actions and Disconnect at once. The status row's
  // activeJob only appears on the next poll, so the tracked childJobs are the earlier signal.
  const heldLinks = new Set(statusRows.filter(row => jobHoldsLink(childJobs, row.id)).map(row => row.id));
  // A job the page did not start itself: running before a reload, in another tab, or started by the scheduler.
  const trackJob = useCallback((job: ChildJobView) => {
    if (childJobIds.current.has(job.jobId)) return;
    childJobIds.current.add(job.jobId);
    setChildJobs(current => [...current, job]);
  }, []);
  const finishJob = useCallback((jobId: string) => {
    setChildJobs(current => current.filter(job => job.jobId !== jobId));
    void refreshStatus();
  }, [refreshStatus]);
  // Each polled snapshot replaces the page's copy, so a row is released when its own item ends, not when the
  // whole bulk job does.
  const updateJob = useCallback((job: ChildJobView) => {
    setChildJobs(current => current.map(item => item.jobId === job.jobId ? job : item));
  }, []);
  useEffect(() => {
    for (const row of status?.links ?? []) {
      const active = row.child?.activeJob;
      if (!active || childJobIds.current.has(active.jobId)) continue;
      childJobIds.current.add(active.jobId);
      getChildJob(apiBase, active.jobId)
        .then(job => setChildJobs(current => current.some(item => item.jobId === job.jobId) ? current : [...current, job]))
        .catch(() => { childJobIds.current.delete(active.jobId); });   // gone since the read; the next status poll retries
    }
  }, [apiBase, status]);
  // A machine that chose Home but has no link yet still reports standalone; the panel follows the
  // operator's choice so the heading does not contradict the action in front of them.
  const choseHome = role === "home" && (uiState === "adding-child" || uiState === "confirming-host" || uiState === "applying");
  const roleLabel: TKey = status?.role === "home" || choseHome ? "remoteLink.role.home" : status?.role === "child" ? "remoteLink.role.child" : "remoteLink.role.standalone";
  const primaryActionDisabled = role === "child" && !childSelectable;

  const refreshButton = <Button variant="ghost" size="sm" onClick={() => { setPolicyReload(value => value + 1); void refreshStatus(); }} disabled={busy !== null}><IconRefresh />{t("link.refresh")}</Button>;
  if (!sessionReady) return (
    <div className="remote-link-page flex min-w-0 flex-col gap-5 font-sans text-fg">
      <PageHeader title={t("link.title")} subtitle={t("link.subtitle")} />
      <Banner tone="warn" action={pairingRecoveryAction}>{t("link.sessionRequired")}</Banner>
    </div>
  );

  const childHome = role === "child" && standaloneRuntime;
  const showLinks = uiState === "connected" || uiState === "reconnecting" || uiState === "failed" || uiState === "restart-waiting" || status?.role === "child" || statusRows.length > 0 || uiState === "adding-child" || uiState === "confirming-host" || uiState === "applying" || uiState === "joining";
  // Child badges, actions, the bulk bar and the policy panel exist only for a Home that reports a `child` block.
  const showChildOps = status?.role === "home" && statusRows.some(row => row.child);
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
      {forceRemoved.map(removed => <RemoteLinkForceRemovedNotice key={removed.id} removed={removed} onDismiss={() => setForceRemoved(current => current.filter(item => item.id !== removed.id))} />)}

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
            {showChildOps && (
              <>
                <ChildBulkBar apiBase={apiBase} rows={statusRows} onJob={trackJob} onError={setActionError} onRun={setChildOpBusy} />
                {childJobs.map(job => <ChildJobProgress key={job.jobId} apiBase={apiBase} job={job} onDone={() => finishJob(job.jobId)} onJobUpdate={updateJob} />)}
              </>
            )}
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
                {statusRows.map(row => {
                  const synced = paritySynced(status?.homeCodexSettingsDigest ?? null, row.appliedCodexSettingsDigest ?? null);
                  return (
                    <li className="remote-link-row flex min-w-0 items-center gap-3 px-4 py-3" key={row.id}>
                      <Monogram name={row.alias} />
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <span className="truncate text-[14px] font-semibold">{row.alias}</span>
                          {row.childKind && <StateBadge tone={row.childKind === "ephemeral" ? "ok" : "neutral"}>{t(row.childKind === "ephemeral" ? "remoteLink.badge.ephemeral" : "remoteLink.badge.full")}</StateBadge>}
                          {synced !== null && <StateBadge tone={synced ? "ok" : "warn"}>{t(synced ? "remoteLink.parity.synced" : "remoteLink.parity.outdated")}</StateBadge>}
                          {row.child && <ChildRowBadges row={row.child} />}
                        </div>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12px] leading-5 text-fg-muted">
                          <LinkStatus state={row.state}>{t(STATUS_LABEL[row.state])}</LinkStatus>
                          <span>{row.direction === "hub-initiated" ? t("remoteLink.direction.hub") : t("remoteLink.direction.client")}</span>
                          {row.reason && <span className="remote-link-error text-danger">{row.reason in REASON_TKEY ? t(REASON_TKEY[row.reason]) : <>{t("remoteLink.reason.generic")} <code className="font-mono">{row.reason}</code></>}</span>}
                        </div>
                      </div>
                      {row.child && row.direction === "hub-initiated" && (
                        <ChildRowActions apiBase={apiBase} link={row} disabled={childOpBusy !== null || heldLinks.has(row.id)}
                          onJob={trackJob} onError={setActionError} onDialog={open => setChildOpBusy(open ? { linkId: row.id, op: "observe" } : null)}
                          onRun={setChildOpBusy} />
                      )}
                      <Button variant="ghost" size="sm" className="hover:bg-danger-soft hover:text-danger" onClick={event => { disconnectTriggerRef.current = event.currentTarget; setPurgeOnDisconnect(false); setConfirming({ row, force: false }); }} disabled={busy !== null || row.child?.activeJob != null || heldLinks.has(row.id)} title={row.child?.activeJob || heldLinks.has(row.id) ? t("remoteLink.child.disconnectBlocked") : undefined}>
                        <IconTrash />{t("link.disconnect")}
                      </Button>
                    </li>
                  );
                })}
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
      {showChildOps && <ChildPolicyPanel apiBase={apiBase} busy={policyBusy} reloadSignal={policyReload} onBusy={setPolicyBusy} onError={setActionError} />}
      {(status?.role === "child" || statusRows.length > 0) && <FallbackPanel apiBase={apiBase} section="devices" readOnly={status?.role === "child"} />}
      <RemoteLinkDiagnostics apiBase={diagnosticsApiBase} />

      <RemoteLinkSheet
        sheetRef={sheetRef}
        role={role}
        standaloneRuntime={standaloneRuntime}
        childSelectable={childSelectable}
        discovery={discovery}
        candidates={candidates}
        alias={alias}
        onAliasChange={setAlias}
        probe={probe}
        checkedFingerprint={checkedFingerprint}
        onCheckedFingerprintChange={setCheckedFingerprint}
        confirmation={confirmation}
        busy={busy}
        sheetOpen={sheetOpen}
        actionError={actionError}
        failedAction={failedAction}
        onClose={closeSheet}
        onRescan={() => void loadCandidates()}
        onProbe={() => void runProbe()}
        onConfirmHost={() => void confirmHost()}
        onApplyLink={() => void applyLink()}
        onJoinLink={() => void joinLink()}
        onRetryFailedAction={retryFailedAction}
      />

      <RemoteLinkDisconnectDialog
        confirmRef={confirmRef}
        confirming={confirming}
        purge={purgeOnDisconnect}
        onPurgeChange={setPurgeOnDisconnect}
        forceError={forceError}
        busy={busy === "remove"}
        onClose={closeConfirmation}
        onConfirm={() => void removeLink()}
      />
    </div>
  );
}
