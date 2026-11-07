import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config/paths";
import { withConfigMutationLockSync } from "../config/mutation-lock";
import { atomicWriteFileNoFollowStreamed } from "../config/atomic-write";
import type { OcxConfig } from "../types";
import { isLoopbackHostname, isTrustedHubManagementRequest, managementRequestOrigin } from "./auth-cors";
import { mintSession, type GuiSessionRecord, type GuiSessionState } from "./gui-session";

export const REMEMBERED_GUI_TTL_MS = 30 * 86400_000;
const RECORD_LIMIT = 128;
const STORE_LIMIT = 128 * 1024;
type State = GuiSessionState & { token: string };
interface DeviceRecord {
  digest: string;
  credential: string;
  proof: string;
  serverOrigin: string;
  userAgent: string;
  expiresAt: number;
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const storePath = () => join(getConfigDir(), "dashboard-sessions.json");

function directOrigin(req: Request, config: OcxConfig): string | null {
  const origin = managementRequestOrigin(req, config);
  if (!origin) return null;
  const url = new URL(origin);
  // The process-marked hub management listener sits behind a local TLS terminator, so its
  // request URL is http: while the canonical public origin is https:. Nothing forwarded is trusted.
  if (new URL(req.url).origin !== origin && !isTrustedHubManagementRequest(req)) return null;
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHostname(url.hostname))) return null;
  const browser = req.headers.get("Origin");
  if (browser !== null && browser !== origin) return null;
  const site = req.headers.get("Sec-Fetch-Site");
  return site && site !== "same-origin" && site !== "none" ? null : origin;
}

function cookieName(origin: string): string {
  return (origin.startsWith("https:") ? "__Host-" : "") + "ocx_dashboard_" + hash(origin).slice(0, 16);
}

function deviceDigest(req: Request, origin: string): string | null {
  const name = cookieName(origin);
  const matches = (req.headers.get("Cookie") ?? "").split(";").map(part => part.trim()).filter(part => part.startsWith(name + "="));
  if (matches.length !== 1) return null;
  const token = matches[0]!.slice(name.length + 1);
  return /^ocx_device_[A-Za-z0-9_-]{43}$/.test(token) ? hash(token) : null;
}

function cookie(origin: string, token: string, maxAge: number): string {
  return cookieName(origin) + "=" + token + "; Path=/; HttpOnly; SameSite=Strict; Max-Age=" + maxAge
    + (origin.startsWith("https:") ? "; Secure" : "");
}

function readRecords(): DeviceRecord[] {
  const path = storePath();
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  try {
    const stat = fstatSync(fd, { bigint: true });
    const entry = lstatSync(path, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || stat.size > STORE_LIMIT || entry.isSymbolicLink()
      || stat.dev !== entry.dev || stat.ino !== entry.ino) throw new Error("unsafe dashboard session store");
    // Size the read from the stat we validated: a store that grows mid-read overflows
    // the +1 sentinel byte and is rejected instead of silently truncated at a fixed limit.
    const bytes = Buffer.alloc(Number(stat.size) + 1);
    let length = 0;
    while (length < bytes.length) { const count = readSync(fd, bytes, length, bytes.length - length, null); if (!count) break; length += count; }
    if (length > stat.size) throw new Error("dashboard session store changed during read");
    const value: unknown = JSON.parse(bytes.subarray(0, length).toString("utf8"));
    if (!Array.isArray(value) || value.length > RECORD_LIMIT) throw new Error("invalid dashboard session store");
    for (const row of value) {
      if (!row || typeof row !== "object" || Object.keys(row).length !== 6
        || ![row.digest, row.credential, row.proof, row.userAgent].every(v => typeof v === "string" && /^[a-f0-9]{64}$/.test(v))
        || typeof row.serverOrigin !== "string" || row.serverOrigin.length > 2048
        || !Number.isSafeInteger(row.expiresAt) || row.expiresAt <= 0) throw new Error("invalid dashboard session record");
      const url = new URL(row.serverOrigin);
      if (url.origin !== row.serverOrigin || !["http:", "https:"].includes(url.protocol)) throw new Error("invalid dashboard session origin");
    }
    return value as DeviceRecord[];
  } finally { closeSync(fd); }
}

function matches(row: DeviceRecord, req: Request, origin: string, state: State, now: number, ignoreUserAgent = false): boolean {
  return row.serverOrigin === origin && row.credential === hash(state.token)
    && (ignoreUserAgent || row.userAgent === hash(req.headers.get("User-Agent") ?? "")) && row.expiresAt > now;
}

function mintDeviceSession(row: DeviceRecord, state: State, now: number) {
  const session = mintSession(row.serverOrigin, row.serverOrigin, "remembered-admin", state, now);
  const record = state.sessions.get(session.token)!;
  record.persistentDigest = row.digest;
  record.persistentExpiresAt = row.expiresAt;
  session.expiresAt = Math.min(session.expiresAt, row.expiresAt);
  return session;
}

export function rememberGuiDevice(req: Request, config: OcxConfig, state: State, now = Date.now()) {
  const origin = directOrigin(req, config);
  if (req.method !== "POST" || !origin || req.headers.get("Origin") !== origin || req.body !== null) return null;
  return withConfigMutationLockSync(() => {
    const previous = deviceDigest(req, origin);
    const rows = readRecords().filter(row => row.expiresAt > now && row.credential === hash(state.token));
    // Re-sign-in replaces only this device, never another server or browser's record.
    const retained = rows.filter(row => !(row.digest === previous && matches(row, req, origin, state, now)));
    if (retained.length >= RECORD_LIMIT) throw new Error("dashboard device limit reached");
    const token = "ocx_device_" + randomBytes(32).toString("base64url");
    const proof = "ocx_proof_" + randomBytes(32).toString("base64url");
    const row: DeviceRecord = { digest: hash(token), credential: hash(state.token), proof: hash(proof), serverOrigin: origin,
      userAgent: hash(req.headers.get("User-Agent") ?? ""), expiresAt: now + REMEMBERED_GUI_TTL_MS };
    atomicWriteFileNoFollowStreamed(storePath(), fd => writeFileSync(fd, JSON.stringify([...retained, row])));
    return { session: mintDeviceSession(row, state, now), device: { proof }, cookie: cookie(origin, token, REMEMBERED_GUI_TTL_MS / 1000) };
  });
}

export function resumeGuiDevice(req: Request, config: OcxConfig, state: State, now = Date.now()) {
  const origin = directOrigin(req, config);
  if (req.method !== "GET" || !origin) return null;
  const digest = deviceDigest(req, origin);
  const proof = req.headers.get("X-OpenCodex-Device-Proof");
  if (!digest || !proof || !/^ocx_proof_[A-Za-z0-9_-]{43}$/.test(proof)) return null;
  try {
    const row = readRecords().find(row => row.digest === digest && row.proof === hash(proof) && matches(row, req, origin, state, now));
    return row ? mintDeviceSession(row, state, now) : null;
  } catch { return null; }
}

export function rememberedGuiSessionIsCurrent(req: Request, config: OcxConfig, state: State, session: GuiSessionRecord, purpose: "access" | "logout" = "access"): boolean {
  if (!session.persistentDigest) return true;
  const origin = directOrigin(req, config);
  if (!origin || deviceDigest(req, origin) !== session.persistentDigest) return false;
  // Admission alone may tolerate browser updates for revocation; currentness and resume stay bound.
  const revoking = purpose === "logout" && req.method === "POST" && new URL(req.url).pathname === "/api/session/logout";
  try { return readRecords().some(row => row.digest === session.persistentDigest && matches(row, req, origin, state, Date.now(), revoking)); }
  catch { return false; }
}

export function forgetGuiDevice(req: Request, config: OcxConfig, state: State): string | null {
  const origin = directOrigin(req, config);
  if (!origin || req.method !== "POST") return null;
  const digest = deviceDigest(req, origin);
  if (digest) withConfigMutationLockSync(() => {
    const rows = readRecords();
    // User-Agent and expiry protect resumption, not deletion: a browser update between
    // Remember and Forget must still remove the record Forget was reached through.
    const found = rows.find(row => row.digest === digest && row.serverOrigin === origin
      && row.credential === hash(state.token));
    if (found) atomicWriteFileNoFollowStreamed(storePath(), fd => writeFileSync(fd, JSON.stringify(rows.filter(row => row !== found))));
    for (const [token, session] of state.sessions) if (session.persistentDigest === digest) state.sessions.delete(token);
  });
  return cookie(origin, "", 0);
}
