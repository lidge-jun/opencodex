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
import { runLinkEnrollment } from "./link-enrollment";
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
  ocx link probe <alias> [--proxy-command <cmd> --ssh-user <user> --ssh-port <port>] [--exclusive] [--json]
  ocx link add <alias> [--plant] [--expect-fingerprint SHA256:…] [--proxy-command <cmd> --ssh-user <user> --ssh-port <port>] [--exclusive] [--operation-id <id>] [--require-ephemeral] [--json]
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

Forced revoke skips remote cleanup. Run ocx disconnect on the remote client.
An explicit route (--proxy-command, --ssh-user and --ssh-port, with --exclusive) reaches ssh on the command line for every command and tunnel of the link, so ssh_config cannot change it; an exclusive link refuses route edits.
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

function errorCodeBody(body: unknown): { error: { code: string; hint?: string; cause?: string }; residual?: true; operationId?: string; outcome?: string; residualKind?: string; operationState?: "open" | "unknown" } | null {
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
  // link_suspended names whether the revoke that keeps the link down is open (the Home stopped during it) or unknown.
  const operationState = body.operationState === "open" || body.operationState === "unknown" ? body.operationState : undefined;
  return { error: { code, ...(hint ? { hint } : {}), ...(cause ? { cause } : {}) }, ...(body.residual === true ? { residual: true as const } : {}),
    ...(operationId ? { operationId } : {}), ...(outcome ? { outcome } : {}), ...(residualKind ? { residualKind } : {}), ...(operationState ? { operationState } : {}) };
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
  let wasEphemeral = false;
  if (force) {
    try {
      const store = (deps.readStore ?? (() => readLinkStore(linkStorePath())))();
      wasEphemeral = store.links.find(l => l.id === linkId)?.childKind === "ephemeral";
    } catch { /* fallback to standard recovery message when store is unavailable */ }
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
      throw error;
    }
    // A journalled revoke must not read as done when nothing was journalled: the caller settles a vanished link itself.
    if (operationId !== undefined) throw new RuntimeApiError("Link " + linkId + " is not on this Home; no revoke was journalled (code link_not_found).", 404, error instanceof RuntimeApiError ? error.body : null);
    remoteCleanup = "unverified";
  }
  if (force) {
    const recovery = wasEphemeral
      ? `Run ocx link recover --link-id ${linkId} once the machine answers, or ~/.cache/opencodex/bin/ocx-child detach on it.`
      : "Run ocx disconnect on the remote client.";
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
      ? "Link " + linkId + " is kept down: revoke operation " + op + " did not finish (the Home stopped during it). Repeat it with the same flags: ocx link revoke --link-id " + linkId + " --operation-id " + op + " (add --purge if it was a purge); if it then ends unknown, run: " + resolve
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
