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
  takeJsonFlag,
  takeOption,
  type RuntimeApiDeps,
} from "./runtime-api";

export const LINK_USAGE = `Usage:
  ocx link port [--json]
  ocx link issue --alias <alias> --tunnel-port <port> [--json]
  ocx link status [--json]
  ocx link revoke --link-id <id> [--json]`;

type LinkState = "connecting" | "connected" | "reconnecting" | "failed" | "idle";
type ListenerState = "off" | "listening" | "failed";

export interface LinkStatusPayload {
  role: "standalone" | "home" | "child";
  listener: { state: ListenerState; port: number | null };
  links: Array<{
    id: string;
    alias: string;
    direction: LinkDirection;
    state: LinkState;
    since: string;
    reason: string | null;
    tunnelPort: number;
  }>;
  child: null | {
    alias: string;
    state: LinkState;
    since: string;
    reason: string | null;
  };
}

export interface LinkIssuePayload {
  linkId: string;
  apiKeyId: string;
  key: string;
  listenerPort: number;
}

export interface LinkCliDeps extends RuntimeApiDeps {
  choosePort?: () => Promise<number>;
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
  const expected = new Set(keys);
  const actual = Object.keys(value);
  if (actual.length !== expected.size || actual.some(key => !expected.has(key))) {
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

function validateStatus(value: unknown): LinkStatusPayload {
  if (!isRecord(value)) throw new Error("invalid link API response: status object");
  assertExactKeys(value, ["role", "listener", "links", "child"], "status");
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
    assertExactKeys(candidate, ["id", "alias", "direction", "state", "since", "reason", "tunnelPort"], `link ${index}`);
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

function localStatus(store: LinkStore): LinkStatusPayload {
  const hasLinks = store.links.length > 0;
  return {
    role: hasLinks ? "home" : "standalone",
    listener: {
      state: hasLinks && store.listenerPort !== null ? "listening" : "off",
      port: hasLinks ? store.listenerPort : null,
    },
    links: store.links.map(link => ({
      id: link.id,
      alias: link.alias,
      direction: link.direction,
      state: "idle",
      since: link.createdAt,
      reason: null,
      tunnelPort: link.tunnelPort,
    })),
    child: null,
  };
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

function errorCodeBody(body: unknown): { error: { code: string } } | null {
  if (!isRecord(body) || !isRecord(body.error)) return null;
  const code = body.error.code;
  return typeof code === "string" && /^[a-z_]{1,64}$/.test(code) ? { error: { code } } : null;
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
      console.log(JSON.stringify(localStatus(store)));
      return;
    }
    throw error;
  }
  const result = validateStatus(await linkRequest<unknown>("/api/link/status", {}, { ...deps, baseUrl }));
  console.log(JSON.stringify(result));
}

async function runRevoke(args: string[], deps: LinkCliDeps): Promise<void> {
  takeJsonFlag(args);
  const linkId = takeOption(args, "--link-id");
  if (!linkId || !LINK_ID.test(linkId)) throw new CliUsageError("revoke requires a valid --link-id", LINK_USAGE);
  rejectArgs(args, LINK_USAGE);
  try {
    const response = await linkRequest<unknown>(`/api/link/${encodeURIComponent(linkId)}`, { method: "DELETE" }, deps);
    validateRevoke(response, linkId);
  } catch (error) {
    // Revoke is idempotent: a link the Home no longer has is already revoked, and a Child retrying
    // a join rollback depends on that answer being success. A 404 without this code comes from a
    // listener that does not serve the management API and stays a failure.
    const code = error instanceof RuntimeApiError && error.status === 404 ? errorCodeBody(error.body)?.error.code : undefined;
    if (code !== "link_not_found") throw error;
  }
  console.log(JSON.stringify({ linkId }));
}

export async function runLinkCommand(rawArgs: string[], deps: LinkCliDeps = {}): Promise<number> {
  return runCliAction(async () => {
    const args = [...rawArgs];
    const command = args.shift();
    if (command === "port") await runPort(args, deps);
    else if (command === "issue") await runIssue(args, deps);
    else if (command === "status") await runStatus(args, deps);
    else if (command === "revoke") await runRevoke(args, deps);
    else throw new CliUsageError("link requires one of: port, issue, status, revoke", LINK_USAGE);
  });
}
