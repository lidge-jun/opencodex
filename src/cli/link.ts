import { clientLinkStatusIdentity } from "../client/link-status";
import { clientLinkTunnelStatus } from "../client/link-tunnel";
import { loadConfig } from "../config";
import { projectLinkStatus, type ClientLinkIdentity, type LinkStatusConfig, type LinkStatusDto } from "../link/status-projection";
import { isEpochMs, type LinkChildParity } from "../link/child-parity";
import { CODEX_SETTINGS_DIGEST_PATTERN } from "../link/codex-settings";
import type { LinkLocalPeer, LinkPeerStatus } from "../link/compatibility";
import { runLinkEnrollment } from "./link-enrollment";
import { runLinkCleanup, type LinkCleanupDeps } from "./link-cleanup";
import { assertSshAlias } from "../link/ssh-argv";
import { linkStorePath } from "../link/paths";
import { isLinkPort } from "../link/ports";
import { readLinkStore, type LinkDirection, type LinkStore } from "../link/store";
import { findAvailablePort } from "../server/ports";
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
  ocx link probe <alias> [--json]
  ocx link add <alias> [--expect-fingerprint SHA256:…] [--json]
  ocx link port [--json]
  ocx link issue --alias <alias> --tunnel-port <port> [--json]
  ocx link status [--json]
  ocx link revoke --link-id <id> [--force --yes] [--json]
  ocx link reconnect --link-id <id> [--json]
  ocx link cleanup [--link-id <id>] [--json]

Forced revoke skips remote cleanup. Run ocx disconnect on the remote client.
Cleanup finds Windows Children and explains how to move them to Hub mode; it changes nothing.`;

type LinkState = "connecting" | "connected" | "reconnecting" | "failed" | "idle";
type ListenerState = "off" | "listening" | "failed";

export interface LinkStatusPayload {
  role: "standalone" | "home" | "child";
  listener: { state: ListenerState; port: number | null };
  links: Array<LinkChildParity & {
    id: string;
    alias: string;
    direction: LinkDirection;
    state: LinkState;
    since: string;
    reason: string | null;
    tunnelPort: number;
    peer?: LinkPeerStatus;
  }>;
  child: null | {
    alias: string;
    state: LinkState;
    since: string;
    reason: string | null;
  };
  local?: LinkLocalPeer;
}

export interface LinkIssuePayload {
  linkId: string;
  apiKeyId: string;
  key: string;
  listenerPort: number;
}

export interface LinkCliDeps extends RuntimeApiDeps, Omit<LinkCleanupDeps, "readStore"> {
  /** Test seam can shorten, never extend, the whole enrollment deadline. */
  enrollmentTimeoutMs?: number;
  choosePort?: () => Promise<number>;
  readConfig?: () => LinkStatusConfig;
  readClientLinkIdentity?: (linkId: string) => ClientLinkIdentity | null;
  readChildStatus?: () => LinkStatusDto["child"];
  confirmFingerprint?: (host: { alias: string; fingerprint: string; keyType: string }) => Promise<boolean>;
  readStore?: () => LinkStore;
  readAdminToken?: () => string | null;
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

function validateStatus(value: unknown): LinkStatusPayload {
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
  const links = value.links.map((candidate, index) => {
    if (!isRecord(candidate)) throw new Error(`invalid link API response: link ${index}`);
    // The OCX-6 parity fields are optional on the wire (an older runtime omits them) and always
    // present in this output, null when absent.
    assertKeys(candidate, ["id", "alias", "direction", "state", "since", "reason", "tunnelPort"], [...PARITY_KEYS, "peer"], `link ${index}`);
    const parity = validateParity(candidate, index);
    if (typeof candidate.id !== "string" || !LINK_ID.test(candidate.id)
      || !validString(candidate.alias) || (candidate.direction !== "hub-initiated" && candidate.direction !== "client-initiated")
      || (candidate.state !== "connecting" && candidate.state !== "connected" && candidate.state !== "reconnecting" && candidate.state !== "failed" && candidate.state !== "idle")
      || !validString(candidate.since) || !validNullableString(candidate.reason) || !isLinkPort(candidate.tunnelPort)) {
      throw new Error(`invalid link API response: link ${index} fields`);
    }
    return {
      id: candidate.id,
      alias: candidate.alias,
      direction: candidate.direction,
      state: candidate.state,
      since: candidate.since,
      reason: candidate.reason,
      tunnelPort: candidate.tunnelPort,
      ...parity,
      ...(candidate.peer !== undefined ? { peer: validatePeer(candidate.peer, index) } : {}),
    } as LinkStatusPayload["links"][number];
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

function validateRevoke(value: unknown, expectedLinkId: string): void {
  if (value === null) return;
  if (!isRecord(value)) throw new Error("invalid link API response: revoke object");
  assertExactKeys(value, ["linkId"], "revoke");
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
      // code survives, because callers branch on it and a code is never secret.
      throw new RuntimeApiError(`Link management request failed (${error.status})`, error.status, errorCodeBody(error.body));
    }
    throw error;
  }
}

function errorCodeBody(body: unknown): { error: { code: string }; residual?: true } | null {
  if (!isRecord(body) || !isRecord(body.error)) return null;
  const code = body.error.code;
  return typeof code === "string" && /^[a-z_]{1,64}$/.test(code) ? { error: { code }, ...(body.residual === true ? { residual: true as const } : {}) } : null;
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
    body: JSON.stringify({ alias, tunnelPort }),
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
  // A proxy older than the compatibility report ignores the query and answers the exact K16 shape.
  const result = validateStatus(await linkRequest<unknown>("/api/link/status?compatibility=1", {}, { ...deps, baseUrl }));
  console.log(JSON.stringify(result));
}

async function runRevoke(args: string[], deps: LinkCliDeps): Promise<void> {
  const wantsJson = takeJsonFlag(args);
  const force = takeFlag(args, "--force");
  const confirmed = takeFlag(args, "--yes");
  const linkId = takeOption(args, "--link-id");
  if (!linkId || !LINK_ID.test(linkId)) throw new CliUsageError("revoke requires a valid --link-id", LINK_USAGE);
  rejectArgs(args, LINK_USAGE);
  if (force && !confirmed) throw new CliUsageError("forced revoke skips remote cleanup; pass --yes to confirm", LINK_USAGE);
  if (confirmed && !force) throw new CliUsageError("--yes requires --force", LINK_USAGE);
  let remoteCleanup: "skipped" | "unverified" = "skipped";
  try {
    const response = await linkRequest<unknown>(`/api/link/${encodeURIComponent(linkId)}`, force ? {
      method: "DELETE",
      redirect: "error",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ force: true }),
    } : { method: "DELETE" }, deps);
    // Legacy revoke accepts an empty response; a forced receipt needs observed identity.
    if (force && response === null) throw new Error("invalid link API response: revoke object");
    validateRevoke(response, linkId);
  } catch (error) {
    // Revoke is idempotent: a link the Home no longer has is already revoked, and a Child retrying
    // a join rollback depends on that answer being success. A 404 without this code comes from a
    // listener that does not serve the management API and stays a failure.
    const code = error instanceof RuntimeApiError && error.status === 404 ? errorCodeBody(error.body)?.error.code : undefined;
    if (code !== "link_not_found") {
      if (force && !(error instanceof RuntimeApiError)) throw new Error("Forced link revoke failed; inspect link status before retrying.");
      throw error;
    }
    remoteCleanup = "unverified";
  }
  if (force) {
    const recovery = "Run ocx disconnect on the remote client.";
    printData({ linkId, remoteCleanup, recovery }, wantsJson, [
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
  const response = await linkRequest<unknown>(`/api/link/${encodeURIComponent(linkId)}/reconnect`, { method: "POST" }, deps);
  if (!isRecord(response)) throw new Error("invalid link API response: reconnect object");
  assertExactKeys(response, ["linkId"], "reconnect");
  if (response.linkId !== linkId) throw new Error("invalid link API response: reconnect link id");
  console.log(JSON.stringify({ linkId }));
}

export async function runLinkCommand(rawArgs: string[], deps: LinkCliDeps = {}): Promise<number> {
  return runCliAction(async () => {
    const args = [...rawArgs];
    const command = args.shift();
    if (command === "probe" || command === "add") await runLinkEnrollment(command, args, deps, linkRequest, LINK_USAGE);
    else if (command === "port") await runPort(args, deps);
    else if (command === "issue") await runIssue(args, deps);
    else if (command === "status") await runStatus(args, deps);
    else if (command === "revoke") await runRevoke(args, deps);
    else if (command === "reconnect") await runReconnect(args, deps);
    else if (command === "cleanup") await runLinkCleanup(args, deps, LINK_USAGE);
    else throw new CliUsageError("link requires one of: probe, add, port, issue, status, revoke, reconnect, cleanup", LINK_USAGE);
  });
}

const PARITY_KEYS = ["lastApplyAt", "runtimeStartedAt", "appliedCodexSettingsDigest", "reportedAt"] as const;

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
  return {
    lastApplyAt: time("lastApplyAt"),
    runtimeStartedAt: time("runtimeStartedAt"),
    appliedCodexSettingsDigest: typeof digest === "string" ? digest : null,
    reportedAt: time("reportedAt"),
  };
}
