import { clientLinkStatusIdentity } from "../client/link-status";
import { clientLinkTunnelStatus } from "../client/link-tunnel";
import { loadConfig } from "../config";
import {
  projectLinkStatus, type ClientLinkIdentity, type LinkStatusConfig, type LinkStatusDto, type LinkTunnelDiagnostics, type LinkWireState,
} from "../link/status-projection";
import { TUNNEL_CAUSES } from "../link/tunnel-history";
import { isEpochMs, type LinkChildParity } from "../link/child-parity";
import { CODEX_SETTINGS_DIGEST_PATTERN } from "../link/codex-settings";
import { isRouteClientId, parseRouteClientOutcomes, ROUTE_INTENT_DIGEST_PATTERN, routeClientOutcomesForPeer } from "../link/route-intent";
import type { LinkLocalPeer, LinkPeerStatus } from "../link/compatibility";
import { journalFullGuidance, runLinkEnrollment } from "./link-enrollment";
import { runLinkCleanup, type LinkCleanupDeps } from "./link-cleanup";
import { LINK_CAPTURE_USAGE, runLinkCapture, type LinkCaptureDeps } from "./link-capture";
import { LINK_CHILD_OPS_USAGE, runLinkActivity, runLinkCheck, runLinkChildOp, runLinkPolicy } from "./link-child-ops";
import { LINK_ROUTES_USAGE, runLinkRoutes } from "./link-routes";
import { LINK_OPERATIONS_USAGE, runLinkOperations } from "./link-operations";
import { LINK_DIAGNOSTICS_USAGE, runLinkDiagnostics } from "./link-diagnostics";
import { LINK_RECOVER_USAGE, runLinkRecover } from "./link-recover";
import { validateChildOps, validateLinkWs, type LinkChildOpsView, type LinkWsView } from "./link-status-child";
import { assertSshAlias } from "../link/ssh-argv";
import { boundHint } from "../link/ssh-runner";
import { linkStorePath } from "../link/paths";
import { isLinkPort } from "../link/ports";
import { readLinkStore, type LinkDirection, type LinkStore } from "../link/store";
import { parseExplicitRoute } from "../link/explicit-route";
import { isOperationId } from "../link/operations-journal";
import type { LinkChildKind } from "../link/store";
import { findAvailablePort } from "../server/ports";
import { viaLocalControlSocket, type LocalControlDeps } from "./link-local-control";
import { validateLinkTraffic } from "./link-status-traffic";
import {
  CliUsageError,
  RuntimeApiError,
  rejectArgs,
  runCliAction,
  runtimeBaseUrl,
  runtimeRequest,
  takeIntegerOption,
  takeFlag,
  takeJsonFlag,
  printData,
  takeOption,
  type RuntimeApiDeps,
} from "./runtime-api";

export const LINK_USAGE = `Usage:
  ocx link probe <alias> [--proxy-command <cmd> --ssh-user <user> --ssh-port <port> [--ssh-identity-file <path>]] [--exclusive] [--json]
  ocx link add <alias> [--plant] [--expect-fingerprint SHA256:…] [--proxy-command <cmd> --ssh-user <user> --ssh-port <port> [--ssh-identity-file <path>]] [--exclusive] [--operation-id <id>] [--require-ephemeral] [--json]
  ocx link port [--json]
  ocx link issue --alias <alias> --tunnel-port <port> [--clients <id,...>] [--json]
  ocx link status [--json]
  ${LINK_DIAGNOSTICS_USAGE}
  ocx link revoke --link-id <id> [--purge] [--force --yes] [--operation-id <id>] [--json]
${LINK_RECOVER_USAGE}
  ocx link reconnect --link-id <id> [--json]
${LINK_ROUTES_USAGE.join("\n")}
${LINK_OPERATIONS_USAGE.join("\n")}
  ocx link cleanup [--link-id <id>] [--json]
  ocx link check (--link-id <id> | --all) [--no-wait] [--json]
${LINK_CHILD_OPS_USAGE.join("\n")}
${LINK_CAPTURE_USAGE.join("\n")}

Forced revoke skips remote cleanup. On a full install run ocx disconnect --expect-link <id> there, which acts only while the machine is connected to this link; for a lightweight Child run ocx link recover --link-id <id> on this Home.
An explicit route (--proxy-command, --ssh-user and --ssh-port, with --exclusive) reaches ssh on the command line for every command and tunnel of the link, so ssh_config cannot change it; an exclusive link refuses route edits. --ssh-identity-file <path> makes ssh offer that private key alone (no agent, no default key) for every command and tunnel of the link.
Recover cleans an ephemeral Child a forced revoke or an interrupted enrollment left behind, over the link's pinned SSH trust.
Cleanup reports each Child's platform with disconnect guidance; it changes nothing.
Diagnostics reads this computer's bounded link diagnostics file directly; it contacts no proxy and writes nothing.
Check reads each Home-initiated Child's installed version and update route; it changes no install.
Update, sync and restart-codex run on the Child over the link's SSH trust and wait for the job unless --no-wait.
Capture opens a short, local window in which this machine's link tunnels log sanitized SSH diagnostics.
Policy reads or changes how this Home keeps its Children current; without flags it only reads.`;

/**
 * What `ocx link status` prints: the runtime's status DTO itself, so a field the server adds (like
 * `peer` or the diagnostics `tunnel`) is part of this type the moment it is part of the wire. The `child` block is
 * read tolerantly, so its type is this CLI's view of it.
 */
export type LinkStatusPayload = Omit<LinkStatusDto, "links"> & {
  links: Array<Omit<LinkStatusDto["links"][number], "child" | "ws"> & { child?: LinkChildOpsView; ws?: LinkWsView }>;
};

export interface LinkIssuePayload {
  linkId: string;
  apiKeyId: string;
  key: string;
  listenerPort: number;
}

export interface LinkCliDeps extends RuntimeApiDeps, LocalControlDeps, LinkCaptureDeps, Omit<LinkCleanupDeps, "readStore"> {
  /** Test seam can shorten, never extend, the whole enrollment deadline. */
  enrollmentTimeoutMs?: number;
  choosePort?: () => Promise<number>;
  readConfig?: () => LinkStatusConfig;
  readClientLinkIdentity?: (linkId: string) => ClientLinkIdentity | null;
  readChildStatus?: () => LinkStatusDto["child"];
  confirmFingerprint?: (host: { alias: string; fingerprint: string; keyType: string; ocxVersion?: string | null; runtimeKind?: "full" | "ephemeral" | "missing"; binarySizeBytes?: number }) => Promise<boolean>;
  readStore?: () => LinkStore;
  readAdminToken?: () => string | null;
  /** Test seam for ocx link recover --forget, which a person must run (src/cli/agent-driven.ts). */
  agentDriven?: () => boolean;
  /** Test seam: the config directory whose link diagnostics `ocx link diagnostics` reads. */
  linkConfigDir?: string;
}

const LINK_ID = /^lnk_[0-9a-f]{16}$/;
const API_KEY_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const DATA_KEY = /^ocx_data_[0-9a-f]{40}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  assertKeys(value, keys, [], label);
}

/** Exact keys plus fields a newer proxy adds; an older proxy omits them. */
function assertKeys(value: Record<string, unknown>, keys: readonly string[], optional: readonly string[], label: string): void {
  const allowed = new Set([...keys, ...optional]);
  const actual = Object.keys(value);
  if (keys.some(key => !(key in value)) || actual.some(key => !allowed.has(key))) {
    throw new Error(`invalid link API response: ${label} fields`);
  }
}

function validListenerPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
}

function validString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function validStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(validString);
}

function validateLocal(value: unknown): LinkLocalPeer {
  if (!isRecord(value)) throw new Error("invalid link API response: local");
  assertExactKeys(value, ["version", "relayAuth", "features"], "local");
  if (!validString(value.version) || !validString(value.relayAuth) || !validStringList(value.features)) {
    throw new Error("invalid link API response: local fields");
  }
  return { version: value.version, relayAuth: value.relayAuth, features: [...value.features] };
}

function validatePeer(value: unknown, index: number): LinkPeerStatus {
  const fail = (): never => { throw new Error(`invalid link API response: link ${index} peer`); };
  if (!isRecord(value)) return fail();
  assertExactKeys(value, ["observedAt", "version", "versionRange", "relayAuth", "features", "compatibility", "reasons"], `link ${index} peer`);
  const range = value.versionRange;
  if (!validNullableString(value.observedAt) || !validNullableString(value.version) || !validNullableString(value.relayAuth)
    || (value.features !== null && !validStringList(value.features)) || !validStringList(value.reasons)
    || !["compatible", "degraded", "incompatible", "unknown"].includes(value.compatibility as string)
    || (range !== null && (!isRecord(range) || !validNullableString(range.min) || !validString(range.below)))) fail();
  return {
    observedAt: value.observedAt as string | null,
    version: value.version as string | null,
    versionRange: range === null ? null : { min: (range as Record<string, unknown>).min as string | null, below: (range as Record<string, unknown>).below as string },
    relayAuth: value.relayAuth as string | null,
    features: value.features === null ? null : [...value.features as string[]],
    compatibility: value.compatibility as LinkPeerStatus["compatibility"],
    reasons: [...value.reasons as string[]],
  };
}

export function validateStatus(value: unknown): LinkStatusPayload {
  if (!isRecord(value)) throw new Error("invalid link API response: status object");
  assertKeys(value, ["role", "listener", "links", "child"], ["local"], "status");
  if (value.role !== "standalone" && value.role !== "home" && value.role !== "child") {
    throw new Error("invalid link API response: status role");
  }
  if (!isRecord(value.listener)) throw new Error("invalid link API response: listener");
  assertExactKeys(value.listener, ["state", "port"], "listener");
  if (value.listener.state !== "off" && value.listener.state !== "listening" && value.listener.state !== "failed") {
    throw new Error("invalid link API response: listener state");
  }
  if (value.listener.port !== null && !validListenerPort(value.listener.port)) {
    throw new Error("invalid link API response: listener port");
  }
  if (!Array.isArray(value.links)) throw new Error("invalid link API response: links");
  const links = value.links.map((candidate, index): LinkStatusPayload["links"][number] => {
    if (!isRecord(candidate)) throw new Error(`invalid link API response: link ${index}`);
    // The OCX-6 parity fields are optional on the wire (an older runtime omits them) and always
    // present in this output, null when absent.
    assertKeys(candidate, ["id", "alias", "direction", "state", "since", "reason", "tunnelPort"], [...PARITY_KEYS, "peer", "tunnel", "childKind", "exclusive", "explicitRoute", "child", "ws", "traffic", "routes", "route", "routeBlocked"], `link ${index}`);
    const parity = validateParity(candidate, index);
    if (typeof candidate.id !== "string" || !LINK_ID.test(candidate.id)
      || !validString(candidate.alias) || (candidate.direction !== "hub-initiated" && candidate.direction !== "client-initiated")
      || (candidate.state !== "connecting" && candidate.state !== "connected" && candidate.state !== "reconnecting" && candidate.state !== "failed" && candidate.state !== "idle")
      || (candidate.childKind !== undefined && candidate.childKind !== "full" && candidate.childKind !== "ephemeral")
      || (candidate.exclusive !== undefined && candidate.exclusive !== true)
      || (candidate.explicitRoute !== undefined && (candidate.exclusive !== true || parseExplicitRoute(candidate.explicitRoute) === null))
      || !validString(candidate.since) || !validNullableString(candidate.reason) || !isLinkPort(candidate.tunnelPort)) {
      throw new Error(`invalid link API response: link ${index} fields`);
    }
    return {
      id: candidate.id,
      alias: candidate.alias,
      direction: candidate.direction as LinkDirection,
      state: candidate.state as LinkWireState,
      since: candidate.since,
      reason: candidate.reason,
      tunnelPort: candidate.tunnelPort,
      ...(candidate.childKind !== undefined ? { childKind: candidate.childKind as LinkChildKind } : {}),
      ...(candidate.exclusive === true ? { exclusive: true as const } : {}),
      ...(candidate.explicitRoute !== undefined ? { explicitRoute: parseExplicitRoute(candidate.explicitRoute)! } : {}),
      ...parity,
      ...(candidate.peer !== undefined ? { peer: validatePeer(candidate.peer, index) } : {}),
      ...(candidate.tunnel !== undefined ? { tunnel: validateTunnel(candidate.tunnel, index) } : {}),
      ...(candidate.child !== undefined ? { child: validateChildOps(candidate.child, index) } : {}),
      ...(candidate.ws !== undefined ? { ws: validateLinkWs(candidate.ws, index) } : {}),
      ...(candidate.traffic !== undefined ? { traffic: validateLinkTraffic(candidate.traffic, index) } : {}),
      ...validateRoutes(candidate, index),
    };
  });
  let child: LinkStatusPayload["child"] = null;
  if (value.child !== null) {
    if (!isRecord(value.child)) throw new Error("invalid link API response: child");
    assertExactKeys(value.child, ["alias", "state", "since", "reason"], "child");
    if (!validString(value.child.alias)
      || (value.child.state !== "connecting" && value.child.state !== "connected" && value.child.state !== "reconnecting" && value.child.state !== "failed" && value.child.state !== "idle")
      || !validString(value.child.since) || !validNullableString(value.child.reason)) {
      throw new Error("invalid link API response: child fields");
    }
    child = {
      alias: value.child.alias,
      state: value.child.state,
      since: value.child.since,
      reason: value.child.reason,
    };
  }
  return {
    role: value.role,
    listener: { state: value.listener.state, port: value.listener.port },
    links,
    child,
    ...(value.local !== undefined ? { local: validateLocal(value.local) } : {}),
  };
}

function validateIssue(value: unknown): LinkIssuePayload {
  if (!isRecord(value)) throw new Error("invalid link API response: issue object");
  assertExactKeys(value, ["linkId", "apiKeyId", "key", "listenerPort"], "issue");
  if (typeof value.linkId !== "string" || !LINK_ID.test(value.linkId)
    || typeof value.apiKeyId !== "string" || !API_KEY_ID.test(value.apiKeyId)
    || typeof value.key !== "string" || !DATA_KEY.test(value.key)
    || !validListenerPort(value.listenerPort)) {
    throw new Error("invalid link API response: issue fields");
  }
  return {
    linkId: value.linkId,
    apiKeyId: value.apiKeyId,
    key: value.key,
    listenerPort: value.listenerPort,
  };
}

function validateRevoke(value: unknown, expectedLinkId: string, operationId?: string): void {
  if (value === null) return;
  if (!isRecord(value)) throw new Error("invalid link API response: revoke object");
  if (operationId === undefined) assertExactKeys(value, ["linkId"], "revoke");
  else {
    // A journalled revoke (structure/remote-link.md, "Operation journal") answers its outcome and, for a purge, the receipt.
    assertKeys(value, ["linkId", "operationId", "outcome"], ["purged"], "revoke");
    if (value.operationId !== operationId || value.outcome !== "committed" || (value.purged !== undefined && value.purged !== true)) throw new Error("invalid link API response: revoke operation");
  }
  if (value.linkId !== expectedLinkId) throw new Error("invalid link API response: revoke link id");
}

function localStatus(store: LinkStore, deps: LinkCliDeps): LinkStatusPayload {
  const config = (deps.readConfig ?? loadConfig)();
  const identity = config.client?.transport === "link" && config.client.link
    ? (deps.readClientLinkIdentity ?? clientLinkStatusIdentity)(config.client.link.linkId) : null;
  return projectLinkStatus(store, [], { state: store.links.length > 0 && store.listenerPort !== null ? "listening" : "off", port: store.links.length > 0 ? store.listenerPort : null },
    config, { version: 1, entries: {} }, (deps.readChildStatus ?? clientLinkTunnelStatus)(), identity);
}

async function linkRequest<T>(path: string, init: RequestInit, deps: LinkCliDeps): Promise<T> {
  const hasTokenOverride = deps.readAdminToken !== undefined;
  const token = deps.readAdminToken?.() ?? null;
  const headers = new Headers(init.headers);
  if (hasTokenOverride) headers.set("x-opencodex-api-key", token ?? "");
  const requestInit: RequestInit = { ...init, headers };
  try {
    return await runtimeRequest<T>(path, requestInit, deps);
  } catch (error) {
    if (error instanceof RuntimeApiError) {
      // Never echo an API error body: issue responses contain a one-time data key. Only the error
      // code, the server's already-bounded hint and the residual flag survive (errorCodeBody).
      throw new RuntimeApiError(`Link management request failed (${error.status})`, error.status, errorCodeBody(error.body));
    }
    throw error;
  }
}

const OPERATION_OUTCOMES = new Set(["committed", "failed_clean", "residual", "unknown"]);

function errorCodeBody(body: unknown): { error: { code: string; hint?: string; cause?: string }; residual?: true; operationId?: string; outcome?: string; residualKind?: string; residualInstall?: "ephemeral" | "full"; linkId?: string; remotePlatform?: "posix" | "windows"; operationState?: "open" | "unknown"; bound?: "unsettled" | "recent" } | null {
  if (!isRecord(body) || !isRecord(body.error)) return null;
  const code = body.error.code;
  if (typeof code !== "string" || !/^[a-z_]{1,64}$/.test(code)) return null;
  // The hint is the only other field kept (#8357): the server builds it from a Child's last stderr
  // line, already bounded and redacted, and it is bounded and redacted again here. The rest of
  // the body is still never echoed.
  const hint = typeof body.error.hint === "string" ? boundHint(body.error.hint) : undefined;
  // A cause is a class word (an unproven route's `hostkey`, `auth`, ...): kept only in that shape.
  const cause = typeof body.error.cause === "string" && /^[a-z_]{1,32}$/.test(body.error.cause) ? body.error.cause : undefined;
  // An operation's id and outcome (structure/remote-link.md, "Operation journal") are closed forms, kept as such.
  const operationId = typeof body.operationId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(body.operationId) ? body.operationId : undefined;
  const outcome = typeof body.outcome === "string" && OPERATION_OUTCOMES.has(body.outcome) ? body.outcome : undefined;
  const residualKind = body.residualKind === "plant" || body.residualKind === "enrollment" ? body.residualKind : undefined;
  // A residual's Child step is bound to the attempt's link id: a link id shape, the install and the platform as closed words.
  const residualInstall = body.residualInstall === "ephemeral" || body.residualInstall === "full" ? body.residualInstall : undefined;
  const linkId = typeof body.linkId === "string" && LINK_ID.test(body.linkId) ? body.linkId : undefined;
  const remotePlatform = body.remotePlatform === "posix" || body.remotePlatform === "windows" ? body.remotePlatform : undefined;
  // link_suspended names whether the revoke that keeps the link down is open (it did not record its outcome) or unknown.
  const operationState = body.operationState === "open" || body.operationState === "unknown" ? body.operationState : undefined;
  // operation_journal_full names which bound it hit.
  const bound = body.bound === "unsettled" || body.bound === "recent" ? body.bound : undefined;
  return { error: { code, ...(hint ? { hint } : {}), ...(cause ? { cause } : {}) }, ...(body.residual === true ? { residual: true as const } : {}),
    ...(operationId ? { operationId } : {}), ...(outcome ? { outcome } : {}), ...(residualKind ? { residualKind } : {}), ...(residualInstall ? { residualInstall } : {}),
    ...(linkId ? { linkId } : {}), ...(remotePlatform ? { remotePlatform } : {}), ...(operationState ? { operationState } : {}), ...(bound ? { bound } : {}) };
}

async function runPort(args: string[], deps: LinkCliDeps): Promise<void> {
  takeJsonFlag(args);
  rejectArgs(args, LINK_USAGE);
  const port = await (deps.choosePort ?? (() => findAvailablePort(0, "127.0.0.1")))();
  if (!isLinkPort(port)) throw new Error("port allocator returned an invalid link port");
  console.log(JSON.stringify({ port }));
}

async function runIssue(args: string[], deps: LinkCliDeps): Promise<void> {
  takeJsonFlag(args);
  const alias = takeOption(args, "--alias");
  const rawClients = takeOption(args, "--clients");
  const selectedClients = rawClients?.split(",");
  if (selectedClients && (!selectedClients.length || !selectedClients.every(isRouteClientId) || new Set(selectedClients).size !== selectedClients.length)) throw new CliUsageError("--clients needs unique supported client IDs", LINK_USAGE);
  const tunnelPort = takeIntegerOption(args, "--tunnel-port", { min: 1024 });
  if (!alias || tunnelPort === undefined || !isLinkPort(tunnelPort)) {
    throw new CliUsageError("issue requires --alias and --tunnel-port", LINK_USAGE);
  }
  try { assertSshAlias(alias); }
  catch { throw new CliUsageError("--alias must be a valid SSH host alias", LINK_USAGE); }
  rejectArgs(args, LINK_USAGE);
  const result = validateIssue(await linkRequest<unknown>("/api/link/issue", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ alias, tunnelPort, ...(selectedClients ? { selectedClients } : {}) }),
  }, deps));
  console.log(JSON.stringify(result));
}

async function runStatus(args: string[], deps: LinkCliDeps): Promise<void> {
  takeJsonFlag(args);
  rejectArgs(args, LINK_USAGE);
  let baseUrl: string;
  try {
    baseUrl = await runtimeBaseUrl(deps);
  } catch (error) {
    if (!deps.baseUrl && error instanceof RuntimeApiError && error.status === 503) {
      const store = (deps.readStore ?? (() => readLinkStore(linkStorePath())))();
      console.log(JSON.stringify(localStatus(store, deps)));
      return;
    }
    throw error;
  }
  // A proxy older than the compatibility report, the tunnel diagnostics, the Child block, the link WebSocket counters or
  // the traffic counters ignores the query and answers without those fields.
  const result = validateStatus(await viaLocalControlSocket(baseUrl, deps,
    statusDeps => linkRequest<unknown>("/api/link/status?compatibility=1&diagnostics=1&children=1&transport=1&traffic=1&routes=1", {}, statusDeps)));
  console.log(JSON.stringify(result));
}

async function runRevoke(args: string[], deps: LinkCliDeps): Promise<void> {
  const wantsJson = takeJsonFlag(args);
  const purge = takeFlag(args, "--purge");
  const force = takeFlag(args, "--force");
  const confirmed = takeFlag(args, "--yes");
  const linkId = takeOption(args, "--link-id");
  const operationId = takeOption(args, "--operation-id");
  if (!linkId || !LINK_ID.test(linkId)) throw new CliUsageError("revoke requires a valid --link-id", LINK_USAGE);
  rejectArgs(args, LINK_USAGE);
  if (operationId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(operationId)) throw new CliUsageError("--operation-id is not a valid operation id", LINK_USAGE);
  const operationBody = operationId !== undefined ? { operationId } : {};
  if (purge && force) throw new CliUsageError("--purge cannot be combined with --force", LINK_USAGE);
  if (force && !confirmed) throw new CliUsageError("forced revoke skips remote cleanup; pass --yes to confirm", LINK_USAGE);
  if (confirmed && !force) throw new CliUsageError("--yes requires --force", LINK_USAGE);
  // The Child type the forced revoke's step depends on; unknown for a link saved before the Home recorded it, a link the store does
  // not list, or a store the CLI cannot read (then no tombstone may have been kept, and the machine may run either install).
  let childKind: "ephemeral" | "full" | "unknown" = "unknown";
  if (force) {
    try {
      const store = (deps.readStore ?? (() => readLinkStore(linkStorePath())))();
      const kind = store.links.find(l => l.id === linkId)?.childKind;
      if (kind === "ephemeral" || kind === "full") childKind = kind;
    } catch { /* the unknown-type step covers a store that cannot be read */ }
  }
  let remoteCleanup: "skipped" | "unverified" = "skipped";
  let recordedOutcome: unknown;
  try {
    const response = await linkRequest<unknown>(`/api/link/${encodeURIComponent(linkId)}`, force ? {
      method: "DELETE",
      redirect: "error",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ force: true, ...operationBody }),
    } : purge || operationId !== undefined ? {
      method: "DELETE",
      redirect: "error",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...(purge ? { purge: true } : {}), ...operationBody }),
    } : { method: "DELETE" }, deps);
    // Legacy revoke accepts an empty response; a forced receipt needs observed identity, and so does an operation.
    if ((force || operationId !== undefined) && response === null) throw new Error("invalid link API response: revoke object");
    validateRevoke(response, linkId, operationId);
    if (isRecord(response)) recordedOutcome = response.outcome;
    if (operationId !== undefined && !force) {
      const receipt = response as Record<string, unknown>;
      console.log(JSON.stringify({ linkId, operationId, outcome: receipt.outcome, ...(receipt.purged === true ? { purged: true } : {}) }));
      return;
    }
  } catch (error) {
    // Revoke is idempotent: a link the Home no longer has is already revoked, and a Child retrying
    // a join rollback depends on that answer being success. A 404 without this code comes from a
    // listener that does not serve the management API and stays a failure.
    const code = error instanceof RuntimeApiError && error.status === 404 ? errorCodeBody(error.body)?.error.code : undefined;
    if (code !== "link_not_found") {
      if (force && !(error instanceof RuntimeApiError)) throw new Error("Forced link revoke failed; inspect link status before retrying.");
      throw operationId !== undefined ? journalledRevokeError(error, operationId, linkId) : plainRevokeError(error);
    }
    // A journalled revoke must not read as done when nothing was journalled: the caller settles a vanished link itself.
    if (operationId !== undefined) throw new RuntimeApiError("Link " + linkId + " is not on this Home; no revoke was journalled (code link_not_found).", 404, error instanceof RuntimeApiError ? error.body : null);
    remoteCleanup = "unverified";
  }
  if (force) {
    const recovery = childKind === "ephemeral"
      // Never a bare local disconnect: a forced revoke is also the remedy when the Child now belongs to another link, a hub or
      // another Home, and a disconnect run there would remove that link. The link-bound recover checks ownership itself.
      ? `Run ocx link recover --link-id ${linkId} once the machine answers: it acts only when the machine's records name this link or nothing at all, and refuses a machine another link owns.`
      // The bound disconnect (#8662) acts only while the machine is connected to this link, which closes the race between a check
      // and a plain disconnect; an ocx older than the flag refuses it before it acts on the link, and then the check comes first.
      : childKind === "unknown"
        ? `The Child type is not known here (${remoteCleanup === "unverified" ? "the link is no longer on this Home, so no record of it says" : "the link was saved before the Home recorded it, or its record could not be read"}). If ocx link recover --list shows ${linkId}, run ocx link recover --link-id ${linkId} once the machine answers. Otherwise, once it answers, run ocx disconnect --expect-link ${linkId} on a full install, or the planted ocx-child's detach --expect-link ${linkId} on a lightweight Child (~/.cache/opencodex/bin/ocx-child; in Command Prompt on Windows %LOCALAPPDATA%\\opencodex\\bin\\ocx-child.exe, or %USERPROFILE%\\.cache\\opencodex\\bin\\ocx-child.exe where LOCALAPPDATA is not set): either refuses a machine that another link, a hub or another Home owns. A build older than that flag refuses it as a usage error before it acts on the link. Then, on a full install, check ocx connect status --json and run ocx disconnect only if it shows this link's id or no connection, right after that check (an enrollment that lands between the two commands would be removed); if it shows another link, a hub or another Home, or its state cannot be read, leave it as it is. On a lightweight Child, leave it as it is: its status cannot show an interrupted attach of another link, which a plain ocx-child detach would restore and then remove.`
      : `Run ocx disconnect --expect-link ${linkId} on the remote client once it answers: it disconnects only while the machine is connected to this link, so a newer link is never removed. An OpenCodex older than that flag refuses it as a usage error before it acts on the link; then check ocx connect status --json there and run ocx disconnect only if it shows this link's id or no connection, right after that check (an enrollment that lands between the two commands would be removed). If it shows another link, a hub or another Home, or its state cannot be read, leave it as it is.`;
    printData({ linkId, remoteCleanup, recovery, ...(operationId !== undefined && recordedOutcome !== undefined ? { operationId, outcome: recordedOutcome } : {}) }, wantsJson, [
      remoteCleanup === "skipped" ? `Revoked ${linkId}; remote cleanup was skipped.` : `Link ${linkId} is already absent; remote cleanup is unverified.`,
      recovery,
    ]);
    return;
  }
  console.log(JSON.stringify({ linkId }));
}

async function runReconnect(args: string[], deps: LinkCliDeps): Promise<void> {
  takeJsonFlag(args);
  const linkId = takeOption(args, "--link-id");
  if (!linkId || !LINK_ID.test(linkId)) throw new CliUsageError("reconnect requires a valid --link-id", LINK_USAGE);
  rejectArgs(args, LINK_USAGE);
  let response: unknown;
  try {
    response = await linkRequest<unknown>(`/api/link/${encodeURIComponent(linkId)}/reconnect`, { method: "POST" }, deps);
  } catch (error) {
    throw suspendedReconnect(error, linkId) ?? error;
  }
  if (!isRecord(response)) throw new Error("invalid link API response: reconnect object");
  assertExactKeys(response, ["linkId"], "reconnect");
  if (response.linkId !== linkId) throw new Error("invalid link API response: reconnect link id");
  console.log(JSON.stringify({ linkId }));
}

/**
 * 409 link_suspended: an unsettled revoke keeps the link down. The next step is built here from the validated operation id,
 * never from the server's text; a 409 keeps the CLI's exit 5.
 */
function suspendedReconnect(error: unknown, linkId: string): RuntimeApiError | null {
  if (!(error instanceof RuntimeApiError) || error.status !== 409 || errorCodeBody(error.body)?.error.code !== "link_suspended") return null;
  const body = isRecord(error.body) ? error.body : {};
  const op = isOperationId(body.operationId) ? body.operationId : null;
  const resolve = op ? "ocx link operations resolve --operation-id " + op + " --yes" : null;
  const message = !op
    ? "Link " + linkId + " is kept down by an unsettled revoke; find it with ocx link operations, then resolve it."
    : body.operationState === "open"
      ? "Link " + linkId + " is kept down: revoke operation " + op + " did not record its outcome (the Home stopped or the revoke failed before writing it). Repeat it with the flags of the first attempt: ocx link revoke --link-id " + linkId + " --operation-id " + op + ", with --purge only if the first attempt had it (the journal keeps only a digest of the flags, so a different --purge answers operation_mismatch); if it then ends unknown, run: " + resolve
      : "Link " + linkId + " is kept down: revoke operation " + op + " ended unknown and may have disconnected or purged the Child. Check the Child, then run: " + resolve;
  return new RuntimeApiError(message, 409, error.body);
}

export async function runLinkCommand(rawArgs: string[], deps: LinkCliDeps = {}): Promise<number> {
  // runCliAction maps thrown errors (2 usage, 4 on 404, 5 on 409, else 1) and returns 0 on success, so a
  // verb's own verdict exit (check: 6 for a partial result) travels beside it.
  let verdictExit = 0;
  const code = await runCliAction(async () => {
    const args = [...rawArgs];
    const command = args.shift();
    if (command === "probe" || command === "add") await runLinkEnrollment(command, args, deps, linkRequest, LINK_USAGE);
    else if (command === "port") await runPort(args, deps);
    else if (command === "issue") await runIssue(args, deps);
    else if (command === "status") await runStatus(args, deps);
    else if (command === "diagnostics") await runLinkDiagnostics(args, deps, LINK_USAGE);
    else if (command === "revoke") await runRevoke(args, deps);
    else if (command === "recover") await runLinkRecover(args, deps, linkRequest, LINK_USAGE);
    else if (command === "reconnect") await runReconnect(args, deps);
    else if (command === "cleanup") await runLinkCleanup(args, deps, LINK_USAGE);
    else if (command === "check") verdictExit = await runLinkCheck(args, deps, linkRequest, LINK_USAGE);
    else if (command === "update" || command === "sync" || command === "restart-codex") verdictExit = await runLinkChildOp(command, args, deps, linkRequest, LINK_USAGE);
    else if (command === "capture") await runLinkCapture(args, deps, LINK_USAGE);
    else if (command === "policy") await runLinkPolicy(args, deps, linkRequest, LINK_USAGE);
    else if (command === "routes") await runLinkRoutes(args, deps, linkRequest, LINK_USAGE);
    else if (command === "operations") await runLinkOperations(args, deps, linkRequest, LINK_USAGE);
    else if (command === "activity") await runLinkActivity(args, deps, linkRequest, LINK_USAGE);
    else throw new CliUsageError("link requires one of: probe, add, port, issue, status, diagnostics, revoke, recover, reconnect, routes, operations, cleanup, check, update, sync, restart-codex, capture, policy, activity", LINK_USAGE);
  });
  return code === 0 ? verdictExit : code;
}

const PARITY_KEYS = ["lastApplyAt", "runtimeStartedAt", "appliedCodexSettingsDigest", "reportedAt", "appliedRouteIntentDigest", "routeClientOutcomes"] as const;
const ROUTE_OUTCOMES = new Set(["transient", "readiness", "grant_unobserved", "forward", "auth", "hostkey"]);
const ROUTE_BLOCKS = new Set(["ssh_client_unsupported", "stop_unconfirmed"]);

/** The `?routes=1` fields of a multi-route row, all three or none. */
function validateRoutes(candidate: Record<string, unknown>, index: number): Pick<LinkStatusPayload["links"][number], "routes" | "route" | "routeBlocked"> {
  const fail = (): never => { throw new Error(`invalid link API response: link ${index} routes`); };
  const { routes, route, routeBlocked } = candidate;
  if (routes === undefined && route === undefined && routeBlocked === undefined) return {};
  if (!Array.isArray(routes) || routes.length < 2 || route === undefined || routeBlocked === undefined) return fail();
  const parsed = routes.map(entry => {
    if (!isRecord(entry)) return fail();
    assertExactKeys(entry, ["name", "eligibleAt", "lastOutcome"], `link ${index} route entry`);
    if (!validString(entry.name) || (entry.eligibleAt !== null && !validIso(entry.eligibleAt))) fail();
    const outcome = entry.lastOutcome;
    if (outcome !== null) {
      if (!isRecord(outcome)) return fail();
      assertExactKeys(outcome, ["class", "at"], `link ${index} route outcome`);
      if (!ROUTE_OUTCOMES.has(outcome.class as string) || !validIso(outcome.at)) fail();
    }
    return entry as unknown as NonNullable<LinkStatusPayload["links"][number]["routes"]>[number];
  });
  if (route !== null) {
    if (!isRecord(route)) return fail();
    assertExactKeys(route, ["name", "index", "since"], `link ${index} route`);
    if (!validString(route.name) || typeof route.index !== "number" || !Number.isSafeInteger(route.index) || route.index < 0
      || route.index >= routes.length || !validIso(route.since)) fail();
  }
  if (routeBlocked !== null && !ROUTE_BLOCKS.has(routeBlocked as string)) fail();
  return {
    routes: parsed,
    route: route as LinkStatusPayload["links"][number]["route"],
    routeBlocked: routeBlocked as LinkStatusPayload["links"][number]["routeBlocked"],
  };
}
const WIRE_STATES = new Set(["connecting", "connected", "reconnecting", "failed", "idle"]);
const CAUSES = new Set<string>(TUNNEL_CAUSES);

function validIso(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value));
}

function validateTunnel(value: unknown, index: number): LinkTunnelDiagnostics {
  const fail = (): never => { throw new Error(`invalid link API response: link ${index} tunnel`); };
  if (!isRecord(value)) return fail();
  assertExactKeys(value, ["attempt", "nextRetryAt", "lastTransition", "lastFailure"], `link ${index} tunnel`);
  const { attempt, nextRetryAt, lastTransition, lastFailure } = value;
  if (typeof attempt !== "number" || !Number.isSafeInteger(attempt) || attempt < 0) fail();
  if (nextRetryAt !== null && !validIso(nextRetryAt)) fail();
  if (lastTransition !== null) {
    if (!isRecord(lastTransition)) return fail();
    assertExactKeys(lastTransition, ["from", "to", "at", "cause"], `link ${index} tunnel transition`);
    if (!WIRE_STATES.has(lastTransition.from as string) || !WIRE_STATES.has(lastTransition.to as string)
      || !validIso(lastTransition.at) || (lastTransition.cause !== null && !CAUSES.has(lastTransition.cause as string))) fail();
  }
  if (lastFailure !== null) {
    if (!isRecord(lastFailure)) return fail();
    assertExactKeys(lastFailure, ["cause", "at"], `link ${index} tunnel failure`);
    if (!CAUSES.has(lastFailure.cause as string) || !validIso(lastFailure.at)) fail();
  }
  return value as unknown as LinkTunnelDiagnostics;
}

function validateParity(candidate: Record<string, unknown>, index: number): LinkChildParity {
  const time = (key: "lastApplyAt" | "runtimeStartedAt" | "reportedAt"): number | null => {
    const value = candidate[key];
    if (value === undefined || value === null) return null;
    if (!isEpochMs(value)) throw new Error(`invalid link API response: link ${index} ${key}`);
    return value;
  };
  const digest = candidate.appliedCodexSettingsDigest;
  if (digest !== undefined && digest !== null && (typeof digest !== "string" || !CODEX_SETTINGS_DIGEST_PATTERN.test(digest))) {
    throw new Error(`invalid link API response: link ${index} appliedCodexSettingsDigest`);
  }
  let route: Pick<LinkChildParity, "appliedRouteIntentDigest" | "routeClientOutcomes"> = {};
  if (candidate.appliedRouteIntentDigest !== undefined || candidate.routeClientOutcomes !== undefined) {
    const routeDigest = candidate.appliedRouteIntentDigest;
    const outcomes = parseRouteClientOutcomes(candidate.routeClientOutcomes);
    if ((routeDigest !== null && (typeof routeDigest !== "string" || !ROUTE_INTENT_DIGEST_PATTERN.test(routeDigest))) || !outcomes) {
      throw new Error(`invalid link API response: link ${index} route intent`);
    }
    route = { appliedRouteIntentDigest: routeDigest, routeClientOutcomes: routeClientOutcomesForPeer(outcomes) };
  }
  return {
    lastApplyAt: time("lastApplyAt"),
    runtimeStartedAt: time("runtimeStartedAt"),
    appliedCodexSettingsDigest: typeof digest === "string" ? digest : null,
    reportedAt: time("reportedAt"),
    ...route,
  };
}

/**
 * A journalled revoke that did not complete: the CLI's own text from the filtered body only, the caller's validated
 * operation id, the closed outcome and the filtered code, never the server's message. The status (and exit) stay.
 */
export function journalledRevokeError(error: unknown, operationId: string, linkId?: string): unknown {
  if (!(error instanceof RuntimeApiError) || !isRecord(error.body) || !isRecord(error.body.error) || typeof error.body.error.code !== "string") return error;
  const code = error.body.error.code;
  // The filtered body is re-checked here, as journalFullGuidance re-checks bound, so this helper is safe on its own.
  if (!/^[a-z_]{1,64}$/.test(code)) return error;
  // Commands are printed so that they run as printed: only a validated link id, a placeholder otherwise.
  const shownLink = linkId !== undefined && LINK_ID.test(linkId) ? linkId : "<link id>";
  if (code === "operation_journal_full") return new RuntimeApiError(journalFullGuidance(error.body, "revoke"), error.status, error.body);
  if (Object.hasOwn(REVOKE_REFUSALS, code)) return new RuntimeApiError(REVOKE_REFUSALS[code] + " (code " + code + ")", error.status, error.body);
  if (Object.hasOwn(RETIREMENT_GUIDANCE, code)) return new RuntimeApiError(RETIREMENT_GUIDANCE[code]!(shownLink) + " (code " + code + ")", error.status, error.body);
  // A fresh forced revoke is refused before its tombstone, first intent and tunnel stop and its refusal is recorded; a resumed one
  // (even one recorded failed_clean) may re-own its retirement receipt first and can finish under the same id once capacity is
  // freed, while a new id is refused with link_retirement_owned (#8416). A second refusal proves nothing (the live limit can still be
  // full), so the text never declares the refusal recorded: the same id first, then a new id, whose link_retirement_owned is safe.
  // That answer names an unfinished removal of the link, which may belong to another operation or to a plain revoke, so the text
  // points at the owner (ocx link operations) or a plain --force instead of claiming this id owns it.
  // It never says the link or key stay active either: an earlier attempt of a resumed revoke may have revoked the key and stopped
  // the tunnel before it failed and dropped its own tombstone, and this repeat then meets the limit while re-recording one. Nor that
  // this attempt left the link alone: the commit-time check (#8662) meets the limit after this attempt stopped the tunnel.
  if (code === "tombstone_limit") {
    return new RuntimeApiError("Too many forced revokes of ephemeral Children are waiting for cleanup; this attempt revoked no key, removed no record and did not contact the Child. Recover them with ocx link recover --link-id <id> (ocx link recover --list shows them), or have a person on this Home run ocx link recover --forget --link-id <id> --yes for machines that are gone. Then repeat this revoke with the same operation id (ocx link revoke --link-id " + shownLink + " --operation-id " + operationId + " --force --yes): an interrupted removal resumes under it. If it answers this refusal again although capacity is free, try a new operation id; if that answers link_retirement_owned, an unfinished removal holds this link: repeat the revoke of this link that owns it, whatever its recorded state (ocx link operations --json shows each entry's linkId), or finish it with ocx link revoke --link-id " + shownLink + " --force --yes without --operation-id. (code tombstone_limit)", error.status, error.body);
  }
  const outcome = error.body.operationId === operationId && typeof error.body.outcome === "string" && OPERATION_OUTCOMES.has(error.body.outcome) ? error.body.outcome : undefined;
  // Repeating first resumes a removal if this id still owns one (#8416); resolving first would leave its receipt and record behind. An
  // unknown can also arise before any receipt was claimed (a disconnect timeout or failure, a journal write), so the resume is
  // conditional. A resume while the record is still listed reopens the entry, and one that fails and cannot settle leaves it open,
  // which resolve refuses (operation_not_resolvable), so the next step follows the state the repeat left: resolve only unknown or
  // residual. A resume whose record was already gone settles committed, and clearing its receipt can still fail (503): one more
  // repeat clears what it left.
  const resolve = outcome === "unknown" ? "; repeat the revoke with the same operation id first (if this id still owns an unfinished removal, the repeat resumes it). If it does not finish, ocx link operations --operation-id " + operationId + " shows its state: if it reads committed, the removal finished: repeat it once more to clear what it left; if it reads unknown or residual, check the Child, then run ocx link operations resolve --operation-id " + operationId + " --yes; if it reads open, fix what stopped the revoke (for example the journal's disk) and repeat it with the same operation id" : "";
  const next = Object.hasOwn(NEXT_STEP, code) ? ". " + NEXT_STEP[code] : "";
  // A link-bound refusal's hint (#8662), only from the closed set and only in its plain-word form; never the server's text.
  const hint = code === "remote_disconnect_failed" ? boundRefusalHint(error) : undefined;
  const hinted = hint !== undefined ? ". " + BOUND_REFUSAL_HINTS[hint]!(againFor(outcome)) : "";
  return new RuntimeApiError("Link revoke did not complete" + (outcome ? " (operation " + operationId + ": " + outcome + ")" : "") + " (code " + code + (hint !== undefined ? ", hint " + hint : "") + ")" + resolve + next + hinted, error.status, error.body);
}

/** The validated link-bound hint of a remote_disconnect_failed answer (#8662), only from the closed set and only in plain-word form. */
function boundRefusalHint(error: RuntimeApiError): string | undefined {
  const body = error.body;
  const raw = isRecord(body) && isRecord(body.error) && body.error.code === "remote_disconnect_failed" ? body.error.hint : undefined;
  return typeof raw === "string" && /^[a-z0-9_-]{1,64}$/.test(raw) && Object.hasOwn(BOUND_REFUSAL_HINTS, raw) ? raw : undefined;
}

/** A plain revoke refused by the Child keeps the generic error unless its hint is in the closed set; the server's text is never shown. */
function plainRevokeError(error: unknown): unknown {
  if (!(error instanceof RuntimeApiError)) return error;
  const hint = boundRefusalHint(error);
  if (hint === undefined) return error;
  return new RuntimeApiError("Link revoke did not complete (code remote_disconnect_failed, hint " + hint + "). " + BOUND_REFUSAL_HINTS[hint]!(againFor(undefined)), error.status, error.body);
}

/**
 * The step after a refused revoke, chosen by the outcome the answer recorded: a failed_clean entry only replays its answer, so
 * the revoke runs again under a new id; an unknown one may own an unfinished removal, which the same id resumes.
 */
function againFor(outcome: string | undefined): string {
  if (outcome === "failed_clean") return "revoke again with a new operation id (repeating this id only replays this answer)";
  if (outcome === "unknown") return "repeat the revoke with the same operation id";
  return "revoke again";
}

/**
 * What a link-bound refusal means (the hints of remote_disconnect_failed). A text claims only what this attempt's Child command
 * did; an earlier attempt of a resumed revoke may have done more. A disconnect is named only after the check that allows it
 * (this link's id or no connection); every other branch says what not to do and which Home-side command to run.
 */
const BOUND_REFUSAL_HINTS: Record<string, (again: string) => string> = {
  child_link_mismatch: again => "The Child refused because of who it belongs to or what state it is in, and this attempt left its link state as it was. Do not disconnect it there. Check it with ocx connect status --json (on a lightweight Child, connect status --json of its planted ocx-child, ~/.cache/opencodex/bin/ocx-child, or in Command Prompt on Windows %LOCALAPPDATA%\\opencodex\\bin\\ocx-child.exe, or %USERPROFILE%\\.cache\\opencodex\\bin\\ocx-child.exe where LOCALAPPDATA is not set): if it shows another link, a hub or another Home, or no connection, revoke this link with --force once any enrollment of this link has finished. If it shows this link's id, a connect or key rotation of it may be in progress: let it finish on the Child, then " + again + "; if the same answer comes back, revoke this link with --force once any enrollment of this link has finished. If its state cannot be read, repair it on the Child, then " + again + "; if you cannot, or the machine cannot be reached, revoke this link with --force once any enrollment of this link has finished",
  child_residual: () => "The lightweight Child keeps records it cannot restore, and this attempt left them as they were. Do not run a plain ocx-child detach on it: an interrupted attach of another link can be what is left, and a plain detach would remove that link too. Revoke this link with --force",
  child_disconnect_pending: again => "The Child has an unfinished disconnect it could not tie to this link and may be partly cleaned. Check it with ocx connect status --json, which cannot say whose disconnect it is: only if it shows no connection, finish it there with ocx disconnect, then " + again + ". If it shows any link, a hub or another Home, if its state cannot be read, or if the machine cannot be reached, leave it and revoke this link with --force. If ocx disconnect refuses the receipt as unsafe, revoke with --force too",
  expect_link_unsupported: again => "The Child runs an ocx or ocx-child older than --expect-link and another Home-initiated link of this Home may reach the same machine, so it was not disconnected without the link check. Update OpenCodex on a full install, then " + again + " (an older planted ocx-child cannot be updated from this Home). Otherwise revoke this link with --force. Revoking the other link instead is no way out unless you mean to end it: no status check can show it is stale (an attach of it still in progress can show no link or an earlier one, and state that cannot be read shows none), under the same pinned host key its revoke is refused the same way, and through a shared route it disconnects the machine if the machine runs that link",
};

/**
 * A next step for codes that keep the generic text because what an earlier step changed differs by path. Where a repeat can
 * answer the same code again, the text says what that answer means and what a different step can and cannot do, so it never
 * sends the caller round the same step for ever.
 */
const NEXT_STEP: Record<string, string> = {
  // A resumed owner can meet the same live write failure again and keep its receipt, so a repeat proves nothing: the same id after
  // the fix, and a new id only through link_retirement_owned's guidance if one is tried.
  operation_journal_failed: "The journal could not record a step: fix what keeps it from being written (disk space, permissions), then repeat the revoke with the same operation id. If it keeps answering operation_journal_failed, a new operation id can be tried; if that answers link_retirement_owned, this id may still own the removal: follow that answer",
  // A stale retirement receipt (the record was edited after a removal claimed it, for example by ocx link routes, which does not
  // check for a receipt: #8678) answers link_changed to every revoke, this id's resume included, until the record matches the
  // receipt's copy again. A claim that met a changed record (no receipt for this id) is journalled, so this id replays it while a
  // new id reads the record afresh; a commit that met one leaves this id's receipt, so its repeat resumes the removal and meets
  // the same comparison. In one runtime a revoke and a route edit hold the same Child-job reservation, so the code never proves
  // that the link changed while this revoke ran.
  link_changed: "The link, or the record of its unfinished removal, no longer matches what this removal started from: read ocx link status, then repeat the revoke with the same operation id. If it answers link_changed again, the link may have been edited after its removal began (for example with ocx link routes). A new operation id can remove it only when no unfinished removal of this link remains; while one remains, no revoke finishes it until the link matches that removal's copy again",
};

/**
 * #8416's refusals for an interrupted removal of the link. The owning operation and the way out are only in the server's message,
 * which the CLI never prints, so these name where to look and make no claim about what an earlier attempt changed.
 */
const RETIREMENT_GUIDANCE: Record<string, (link: string) => string> = {
  // A journalled owner refuses any revoke without --force that is not its own id; a plain revoke without --force finishes only
  // a removal no journalled operation owns (link-routes.ts foreignRetirement). A revoke without --force refuses --yes.
  link_retirement_owned: link => "An unfinished removal holds this link. Repeat the revoke of this link that owns it, whatever its recorded state (ocx link operations --json shows each entry's linkId; another revoke's id answers its own outcome or this refusal again), or finish it with ocx link revoke --link-id " + link + " --force --yes without --operation-id. If no journalled operation owns it, ocx link revoke --link-id " + link + " without --operation-id and without --force also finishes it when its Child cleanup can run again.",
  // Unreachable with --operation-id at this head (foreignRetirement admits only this operation's own receipt, resumed in its own
  // mode); kept as a closed text with no state claim. "--force" with the same id would answer operation_mismatch, so it is not offered.
  link_retirement_mode_mismatch: link => "This link's removal was interrupted in another mode than this revoke asks for. Repeat the revoke that started it with its options (ocx link operations --json shows each entry's linkId), or finish it with ocx link revoke --link-id " + link + " --force --yes without --operation-id.",
  // Not a retirement refusal, but its way out names the link too, so it runs as printed. A replay that follows a resumed removal
  // can meet an unreadable journal after that removal finished (#8416): no state claim.
  operation_journal_unreadable: link => "The link operation journal (<configDir>/link/operations.json) is damaged or could not be read. Keep a copy, move it aside and repeat the revoke with the same operation id; if that answers link_not_found, the link is already gone (a resumed removal can finish before the read fails). A forced revoke runs without the journal: ocx link revoke --link-id " + link + " --force --yes, without --operation-id (it skips the Child's cleanup).",
};

/**
 * Closed texts for refusals of a journalled revoke. Each claims only what holds on every path that answers the code, on a
 * first and on a resumed attempt (the table in structure/remote-link.md, "Operation journal"); any other code, including ones
 * a newer Home adds, keeps the generic text.
 */
const REVOKE_REFUSALS: Record<string, string> = {
  operation_mismatch: "This operation id was already used with other parameters. Nothing was changed; repeat it with the flags of its first attempt, or use a new operation id.",
  link_operation_open: "An unfinished revoke holds this link; repeat it with its own operation id to settle it first. Nothing was changed.",
  // A resumed revoke can re-own its retirement receipt before this 409 (#8416), so it claims only what holds for every path.
  link_operation_in_progress: "Another link operation for this alias or link is running. This attempt did not touch the link, its key or the Child; retry when it ends.",
};
