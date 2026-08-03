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

export function requireManagementAuth(
  req: Request,
  state: ManagementAuthState,
  config?: OcxConfig,
): Response | null {
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
