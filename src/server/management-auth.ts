import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { adminApiTokenFilePath } from "../lib/admin-secrets";
import {
  LOCAL_MANAGEMENT_CAPABILITY_HEADER,
  LOCAL_MANAGEMENT_CAPABILITY_EXPIRES_AT_HEADER,
  LOCAL_MANAGEMENT_EXPECTED_PID_HEADER,
  LOCAL_MANAGEMENT_NONCE_HEADER,
  parseExpectedLocalManagementPid,
  verifyLocalManagementReadCapability,
} from "../lib/local-management-capability";
import {
  SYSTEM_RESTART_CAPABILITY_HEADER,
  SYSTEM_RESTART_EXPECTED_PID_HEADER,
  SYSTEM_RESTART_NONCE_HEADER,
  SYSTEM_RESTART_PATH,
  parseExpectedSystemRestartPid,
  verifySystemRestartCapability,
} from "../lib/system-restart-contract";
import {
  LOCAL_PROVIDER_RELOAD_CAPABILITY_HEADER,
  LOCAL_PROVIDER_RELOAD_EXPECTED_PID_HEADER,
  LOCAL_PROVIDER_RELOAD_EXPIRES_AT_HEADER,
  LOCAL_PROVIDER_RELOAD_NAME_HEADER,
  LOCAL_PROVIDER_RELOAD_NONCE_HEADER,
  LOCAL_PROVIDER_RELOAD_PATH,
  parseExpectedLocalProviderReloadPid,
  verifyLocalProviderReloadCapability,
} from "../lib/local-provider-reload-contract";
import { forgetEphemeralSecretPath, forgetHardenedSecretPath, hardenSecretDir, hardenSecretPath } from "../lib/windows-secret-acl";
import type { OcxConfig } from "../types";
import {
  isAllowedManagementOrigin,
  isApiAuthRequired,
  isDataPlaneAdmissionSecret,
  isLoopbackHostname,
  managementRequestOrigin,
  parseHttpHost,
} from "./auth-cors";

const GUI_SESSION_TTL_MS = 5 * 60_000;
const GUI_SESSION_LIMIT = 128;
const LOCAL_READ_REPLAY_LIMIT = 256;
const consumedLocalReadCapabilities = new Map<string, number>();
const admittedLocalReadRequests = new WeakSet<Request>();
const LOCAL_PROVIDER_RELOAD_REPLAY_LIMIT = 256;
const consumedLocalProviderReloadCapabilities = new Map<string, number>();
const admittedLocalProviderReloadRequests = new WeakSet<Request>();

interface GuiSessionRecord {
  csrfToken: string;
  origin: string;
  expiresAt: number;
}

export interface GuiSessionBootstrap extends GuiSessionRecord {
  token: string;
}

export type ManagementAuthState =
  | {
    available: true;
    token: string;
    source: "environment" | "file";
    sessions: Map<string, GuiSessionRecord>;
  }
  | { available: false; reason: string };

function fail(reason: string): ManagementAuthState {
  return { available: false, reason };
}

function assertSafeDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("management token directory is not a regular directory");
  chmodSync(path, 0o700);
  let hardened: { ok: boolean };
  try {
    hardened = hardenSecretDir(path, { required: true });
  } catch {
    // required:true hardening now fails closed on genuine ACL timeouts too;
    // keep the actionable guidance in the surfaced reason.
    hardened = { ok: false };
  }
  if (!hardened.ok) {
    throw new Error(
      "management token directory ACL hardening did not complete; set OPENCODEX_ADMIN_AUTH_TOKEN to use an environment token instead of a file-backed token",
    );
  }
}

function readExistingToken(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512) {
    throw new Error("management token path is not a regular secret file");
  }
  chmodSync(path, 0o600);
  let hardened: { ok: boolean };
  try {
    hardened = hardenSecretPath(path, { required: true });
  } catch {
    hardened = { ok: false };
  }
  if (!hardened.ok) {
    throw new Error(
      "management token file ACL hardening did not complete; set OPENCODEX_ADMIN_AUTH_TOKEN to use an environment token instead of a file-backed token",
    );
  }
  const token = readFileSync(path, "utf8").trim();
  if (!/^ocx_admin_[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("management token file is invalid");
  return token;
}

export function removeManagementTokenPathBestEffort(
  path: string,
  remove: (path: string) => void = unlinkSync,
  options?: { ephemeral?: boolean },
): void {
  // Temps get the full ephemeral release (success + both timeout namespaces);
  // stable token paths drop only the success memo — destination-keyed timeout
  // memos are intentional anti-restall state.
  const forget = options?.ephemeral ? forgetEphemeralSecretPath : forgetHardenedSecretPath;
  try {
    remove(path);
    forget(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") forget(path);
    /* other failures retain fail-closed state for the caller */
  }
}

function createTokenFile(path: string): string {
  const directory = dirname(path);
  const token = `ocx_admin_${randomBytes(32).toString("base64url")}`;
  const temporary = join(directory, `.${randomUUID()}.admin-token.tmp`);
  let linked = false;
  let fd: number | null = null;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, `${token}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    chmodSync(temporary, 0o600);
    let temporaryHardened: { ok: boolean };
    try {
      // Destination-keyed timeout memo (the final token path), not the temp.
      temporaryHardened = hardenSecretPath(temporary, { required: true, timeoutMemoKey: path });
    } catch {
      temporaryHardened = { ok: false };
    }
    if (!temporaryHardened.ok) {
      throw new Error(
        "management token temporary ACL hardening did not complete; set OPENCODEX_ADMIN_AUTH_TOKEN to use an environment token instead of a file-backed token",
      );
    }
    try {
      linkSync(temporary, path);
      linked = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return readExistingToken(path);
      throw error;
    }
    let finalHardened: { ok: boolean };
    try {
      finalHardened = hardenSecretPath(path, { required: true });
    } catch {
      finalHardened = { ok: false };
    }
    if (!finalHardened.ok) {
      throw new Error(
        "management token file ACL hardening did not complete; set OPENCODEX_ADMIN_AUTH_TOKEN to use an environment token instead of a file-backed token",
      );
    }
    return token;
  } catch (error) {
    if (linked) removeManagementTokenPathBestEffort(path);
    throw error;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
    removeManagementTokenPathBestEffort(temporary, unlinkSync, { ephemeral: true });
  }
}

function ready(token: string, source: "environment" | "file", config: OcxConfig): ManagementAuthState {
  if (isDataPlaneAdmissionSecret(token, config)) {
    return fail("management credential conflicts with a data-plane credential");
  }
  return { available: true, token, source, sessions: new Map() };
}

export function initializeManagementAuthState(config: OcxConfig): ManagementAuthState {
  const environmentToken = process.env.OPENCODEX_ADMIN_AUTH_TOKEN?.trim();
  if (environmentToken) {
    return ready(environmentToken, "environment", config);
  }
  try {
    const path = adminApiTokenFilePath();
    assertSafeDirectory(dirname(path));
    let token: string;
    try {
      token = readExistingToken(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      token = createTokenFile(path);
    }
    return ready(token, "file", config);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "management token initialization failed");
  }
}

function equalSecret(actual: string, expected: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(actual);
  const right = encoder.encode(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function removeExpiredSessions(state: Extract<ManagementAuthState, { available: true }>, now = Date.now()): void {
  for (const [token, session] of state.sessions) {
    if (session.expiresAt <= now) state.sessions.delete(token);
  }
}

function randomSessionSecret(prefix: "ocx_session_"): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

export function issueGuiSession(
  req: Request,
  config: OcxConfig,
  state: ManagementAuthState,
): GuiSessionBootstrap | null {
  if (isApiAuthRequired(config) || !state.available || req.method !== "GET" || !isAllowedManagementOrigin(req, config)) return null;
  const host = parseHttpHost(req.headers.get("Host"));
  if (!host || !isLoopbackHostname(host.hostname)) return null;
  const origin = managementRequestOrigin(req, config);
  if (!origin) return null;
  const now = Date.now();
  removeExpiredSessions(state, now);
  while (state.sessions.size >= GUI_SESSION_LIMIT) {
    const oldest = state.sessions.keys().next().value as string | undefined;
    if (!oldest) break;
    state.sessions.delete(oldest);
  }
  const token = randomSessionSecret("ocx_session_");
  const session: GuiSessionRecord = {
    csrfToken: randomBytes(32).toString("base64url"),
    origin,
    expiresAt: now + GUI_SESSION_TTL_MS,
  };
  state.sessions.set(token, session);
  return { token, ...session };
}

/**
 * Which credential actually authorized a management request.
 *
 * `admin-token` is the raw token from disk/env: anything running as the user can
 * read it, including a coding agent. `gui-session` is a session token this process
 * minted for a browser, and it only authorizes a mutation after the origin and the
 * per-session CSRF token match. Consent-bearing routes must key off this value
 * rather than off request headers, which the token holder can forge freely.
 * The capability principals are process-scoped HMACs bound to the current process
 * PID and listening port. Local reads are accepted only for two exact GET paths;
 * restart and provider reload remain separate wire contracts for their exact POSTs.
 */
export type ManagementPrincipal =
  | "admin-token"
  | "gui-session"
  | "local-read-capability"
  | "local-provider-reload-capability"
  | "system-restart-capability";

export interface LocalManagementAuthContext {
  attestationSecret: string;
  pid: number;
  port: number;
}

function hasSystemRestartCapability(
  req: Request,
  local: LocalManagementAuthContext | undefined,
): boolean {
  if (!local || req.method !== "POST") return false;
  let path: string;
  try {
    path = new URL(req.url).pathname;
  } catch {
    return false;
  }
  if (path !== SYSTEM_RESTART_PATH) return false;
  const expectedPid = parseExpectedSystemRestartPid(
    req.headers.get(SYSTEM_RESTART_EXPECTED_PID_HEADER),
  );
  if (expectedPid.kind !== "present" || expectedPid.pid !== local.pid) return false;
  return verifySystemRestartCapability(
    local.attestationSecret,
    req.headers.get(SYSTEM_RESTART_NONCE_HEADER),
    req.method,
    path,
    local.pid,
    local.port,
    req.headers.get(SYSTEM_RESTART_CAPABILITY_HEADER),
  );
}

function hasLocalReadCapability(
  req: Request,
  local: LocalManagementAuthContext | undefined,
): boolean {
  // requireManagementAuth and managementPrincipal inspect the same Request in
  // sequence. Preserve that one admission without accepting a replayed request.
  if (admittedLocalReadRequests.has(req)) return true;
  if (!local || req.method !== "GET") return false;
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return false;
  }
  // Do not let a future query-bearing variant silently inherit this narrow grant.
  if (url.search !== "") return false;
  const expectedPid = parseExpectedLocalManagementPid(
    req.headers.get(LOCAL_MANAGEMENT_EXPECTED_PID_HEADER),
  );
  if (expectedPid.kind !== "present" || expectedPid.pid !== local.pid) return false;
  const expiresAtRaw = req.headers.get(LOCAL_MANAGEMENT_CAPABILITY_EXPIRES_AT_HEADER);
  if (!expiresAtRaw || !/^[1-9]\d*$/.test(expiresAtRaw)) return false;
  const expiresAt = Number(expiresAtRaw);
  if (!Number.isSafeInteger(expiresAt)) return false;
  const capability = req.headers.get(LOCAL_MANAGEMENT_CAPABILITY_HEADER);
  const now = Date.now();
  if (!verifyLocalManagementReadCapability(
    local.attestationSecret,
    req.headers.get(LOCAL_MANAGEMENT_NONCE_HEADER),
    req.method,
    url.pathname,
    local.pid,
    local.port,
    expiresAt,
    capability,
    now,
  )) return false;
  for (const [consumed, retainedUntil] of consumedLocalReadCapabilities) {
    if (retainedUntil <= now) consumedLocalReadCapabilities.delete(consumed);
  }
  if (!capability || consumedLocalReadCapabilities.has(capability)) return false;
  if (consumedLocalReadCapabilities.size >= LOCAL_READ_REPLAY_LIMIT) return false;
  consumedLocalReadCapabilities.set(capability, expiresAt);
  admittedLocalReadRequests.add(req);
  return true;
}

function hasLocalProviderReloadCapability(
  req: Request,
  local: LocalManagementAuthContext | undefined,
): boolean {
  if (admittedLocalProviderReloadRequests.has(req)) return true;
  if (!local || req.method !== "POST") return false;
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return false;
  }
  if (url.pathname !== LOCAL_PROVIDER_RELOAD_PATH || url.search !== "") return false;
  const contentLength = req.headers.get("content-length");
  if (contentLength !== "0" || req.headers.has("transfer-encoding")) return false;
  const expectedPid = parseExpectedLocalProviderReloadPid(
    req.headers.get(LOCAL_PROVIDER_RELOAD_EXPECTED_PID_HEADER),
  );
  if (expectedPid.kind !== "present" || expectedPid.pid !== local.pid) return false;
  const expiresAtRaw = req.headers.get(LOCAL_PROVIDER_RELOAD_EXPIRES_AT_HEADER);
  if (!expiresAtRaw || !/^[1-9]\d*$/.test(expiresAtRaw)) return false;
  const expiresAt = Number(expiresAtRaw);
  if (!Number.isSafeInteger(expiresAt)) return false;
  const name = req.headers.get(LOCAL_PROVIDER_RELOAD_NAME_HEADER);
  const capability = req.headers.get(LOCAL_PROVIDER_RELOAD_CAPABILITY_HEADER);
  const now = Date.now();
  if (!verifyLocalProviderReloadCapability(
    local.attestationSecret,
    req.headers.get(LOCAL_PROVIDER_RELOAD_NONCE_HEADER),
    req.method,
    url.pathname,
    name,
    local.pid,
    local.port,
    expiresAt,
    capability,
    now,
  )) return false;
  for (const [consumed, retainedUntil] of consumedLocalProviderReloadCapabilities) {
    if (retainedUntil <= now) consumedLocalProviderReloadCapabilities.delete(consumed);
  }
  if (!capability || consumedLocalProviderReloadCapabilities.has(capability)) return false;
  if (consumedLocalProviderReloadCapabilities.size >= LOCAL_PROVIDER_RELOAD_REPLAY_LIMIT) return false;
  consumedLocalProviderReloadCapabilities.set(capability, expiresAt);
  admittedLocalProviderReloadRequests.add(req);
  return true;
}

/**
 * The principal for a request that already passed `requireManagementAuth`. Kept as a
 * separate resolution (rather than a changed return type) so every existing caller
 * keeps its `Response | null` contract. Browser and admin principals are derived
 * from the same session table and CSRF comparison the gate uses; the restart
 * principal is derived from the same process-scoped capability check.
 */
export function managementPrincipal(
  req: Request,
  state: ManagementAuthState,
  config?: OcxConfig,
  local?: LocalManagementAuthContext,
): ManagementPrincipal | null {
  if (hasSystemRestartCapability(req, local)) return "system-restart-capability";
  if (hasLocalProviderReloadCapability(req, local)) return "local-provider-reload-capability";
  if (hasLocalReadCapability(req, local)) return "local-read-capability";
  if (!state.available) return null;
  const actual = req.headers.get("x-opencodex-api-key")?.trim()
    || req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (!actual) return null;
  if (equalSecret(actual, state.token)) return "admin-token";
  if (!config) return null;
  removeExpiredSessions(state);
  return state.sessions.has(actual) ? "gui-session" : null;
}

export function requireManagementAuth(
  req: Request,
  state: ManagementAuthState,
  config?: OcxConfig,
  local?: LocalManagementAuthContext,
): Response | null {
  if (hasSystemRestartCapability(req, local)) return null;
  if (hasLocalProviderReloadCapability(req, local)) return null;
  if (hasLocalReadCapability(req, local)) return null;
  if (!state.available) {
    return Response.json({
      error: "management API unavailable",
      reason: state.reason,
      hint: "Set OPENCODEX_ADMIN_AUTH_TOKEN to bypass file-backed admin token ACL hardening",
    }, { status: 503 });
  }
  const actual = req.headers.get("x-opencodex-api-key")?.trim()
    || req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (actual && equalSecret(actual, state.token)) return null;
  if (actual && config) {
    removeExpiredSessions(state);
    const session = state.sessions.get(actual);
    if (session) {
      const requestOrigin = managementRequestOrigin(req, config);
      const claimedOrigin = req.headers.get("x-opencodex-gui-origin");
      const browserOrigin = req.headers.get("Origin");
      const sameOrigin = requestOrigin === session.origin
        && claimedOrigin === session.origin
        && (!browserOrigin || browserOrigin === session.origin);
      const safeMethod = req.method === "GET" || req.method === "HEAD";
      const csrf = req.headers.get("x-opencodex-csrf-token")?.trim();
      if (sameOrigin && (safeMethod || (browserOrigin === session.origin && !!csrf && equalSecret(csrf, session.csrfToken)))) {
        return null;
      }
    }
  }
  return Response.json({ error: "opencodex admin token required" }, { status: 401 });
}
