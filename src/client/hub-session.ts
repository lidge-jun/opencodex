/**
 * The hub management credential a connected client holds for its own loopback callers.
 *
 * A client stores a per-client DATA key, which admits `/v1/*` and nothing under `/api/*`. Every
 * management consumer on the machine — `ocx account list`, the AImorph panel, the usage reporter,
 * the dashboard's editing paths — therefore used to read a client listener that answered 404 for
 * exactly the routes it asked for.
 *
 * The fix is not to widen the data key. `ocx connect` already obtains a real management credential
 * to issue that key: a gui-session minted from the single-use pairing grant, or the operator's
 * admin token when `--admin-token-stdin` was used. This file keeps that credential, mode 0600, so
 * the loopback listener can stamp it on the management calls it relays to the hub.
 *
 * `ocx connect` earned it and threw it away before; keeping it grants the machine nothing it did
 * not already hold at connect time. The exchange itself is never replayed here — a pairing grant
 * is single-use — so an expired session is reported as such rather than silently retried.
 */
import { existsSync, lstatSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config";
import { atomicWriteFile } from "../config/atomic-write";

const MAX_HUB_SESSION_BYTES = 4096;
const SESSION_TOKEN = /^ocx_session_[A-Za-z0-9_-]{43}$/;
const CSRF_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const ADMIN_TOKEN = /^ocx_admin_[A-Za-z0-9_-]{43}$/;

export interface HubGuiSession {
  kind: "session";
  token: string;
  csrfToken: string;
  browserOrigin: string;
}

export interface HubAdminCredential {
  kind: "admin";
  token: string;
}

export type HubManagementCredential = HubGuiSession | HubAdminCredential;

export type HubCredentialState =
  | { kind: "absent" }
  | { kind: "unsafe"; reason: string }
  | { kind: "present"; credential: HubManagementCredential };

function canonicalOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) return null;
    return url.origin;
  } catch { return null; }
}

export function parseHubCredential(value: unknown): HubManagementCredential | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.kind === "admin") {
    if (Object.keys(record).sort().join(",") !== "kind,token") return null;
    return typeof record.token === "string" && ADMIN_TOKEN.test(record.token)
      ? { kind: "admin", token: record.token }
      : null;
  }
  if (record.kind !== "session") return null;
  if (Object.keys(record).sort().join(",") !== "browserOrigin,csrfToken,kind,token") return null;
  if (typeof record.token !== "string" || !SESSION_TOKEN.test(record.token)) return null;
  if (typeof record.csrfToken !== "string" || !CSRF_TOKEN.test(record.csrfToken)) return null;
  const browserOrigin = canonicalOrigin(record.browserOrigin);
  return browserOrigin ? { kind: "session", token: record.token, csrfToken: record.csrfToken, browserOrigin } : null;
}

export function hubSessionFilePath(): string {
  return join(getConfigDir(), "hub-management-session.json");
}

export function readHubCredential(): HubCredentialState {
  const path = hubSessionFilePath();
  if (!existsSync(path)) return { kind: "absent" };
  let stat;
  try { stat = lstatSync(path); } catch { return { kind: "unsafe", reason: "hub credential path could not be inspected" }; }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_HUB_SESSION_BYTES) {
    return { kind: "unsafe", reason: "hub credential path is not a bounded regular file" };
  }
  try {
    const credential = parseHubCredential(JSON.parse(readFileSync(path, "utf8")));
    return credential ? { kind: "present", credential } : { kind: "unsafe", reason: "hub credential file is malformed" };
  } catch {
    return { kind: "unsafe", reason: "hub credential file could not be read" };
  }
}

export function writeHubCredential(credential: HubManagementCredential): void {
  if (!parseHubCredential(credential)) throw new Error("refusing to persist an invalid hub credential");
  atomicWriteFile(hubSessionFilePath(), `${JSON.stringify(credential)}\n`);
}

export function removeHubCredential(): void {
  try { unlinkSync(hubSessionFilePath()); } catch { /* already gone */ }
}

