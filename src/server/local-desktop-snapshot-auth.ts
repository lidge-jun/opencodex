import { timingSafeEqual } from "node:crypto";
import {
  LOCAL_MANAGEMENT_CAPABILITY_EXPIRES_AT_HEADER,
  LOCAL_MANAGEMENT_CAPABILITY_HEADER,
  LOCAL_MANAGEMENT_EXPECTED_PID_HEADER,
  LOCAL_MANAGEMENT_NONCE_HEADER,
  parseExpectedLocalManagementPid,
} from "../lib/local-management-capability";
import {
  desktopSnapshotBodyDigest,
  LOCAL_DESKTOP_SNAPSHOT_BODY_HEADER,
  LOCAL_DESKTOP_SNAPSHOT_PATH,
  verifyLocalDesktopSnapshotCapability,
} from "../lib/local-desktop-snapshot-capability";
import type { LocalManagementAuthContext } from "./management-auth";

const REPLAY_LIMIT = 256;
const consumed = new Map<string, number>();
const admittedBodyDigests = new WeakMap<Request, string>();

/** Admit only the snapshot POST; a grant never becomes a general management credential. */
export function hasLocalDesktopSnapshotCapability(
  req: Request,
  local: LocalManagementAuthContext | undefined,
  now = Date.now(),
): boolean {
  if (admittedBodyDigests.has(req)) return true;
  if (!local || req.method !== "POST" || req.headers.has("origin")) return false;
  let url: URL;
  try { url = new URL(req.url); } catch { return false; }
  if (url.pathname !== LOCAL_DESKTOP_SNAPSHOT_PATH || url.search !== "") return false;
  const expectedPid = parseExpectedLocalManagementPid(req.headers.get(LOCAL_MANAGEMENT_EXPECTED_PID_HEADER));
  if (expectedPid.kind !== "present" || expectedPid.pid !== local.pid) return false;
  const expiry = req.headers.get(LOCAL_MANAGEMENT_CAPABILITY_EXPIRES_AT_HEADER);
  if (!expiry || !/^[1-9]\d*$/.test(expiry)) return false;
  const expiresAt = Number(expiry);
  const capability = req.headers.get(LOCAL_MANAGEMENT_CAPABILITY_HEADER);
  const bodyDigest = req.headers.get(LOCAL_DESKTOP_SNAPSHOT_BODY_HEADER);
  if (!verifyLocalDesktopSnapshotCapability(
    local.attestationSecret, req.headers.get(LOCAL_MANAGEMENT_NONCE_HEADER),
    req.method, url.pathname, local.pid, local.port, expiresAt, bodyDigest, capability, now,
  )) return false;
  for (const [proof, until] of consumed) if (until <= now) consumed.delete(proof);
  if (!capability || !bodyDigest || consumed.has(capability) || consumed.size >= REPLAY_LIMIT) return false;
  consumed.set(capability, expiresAt);
  // Cache the authenticated digest, not a mutable header. The route must verify
  // its bounded raw body against this value before it changes display state.
  admittedBodyDigests.set(req, bodyDigest);
  return true;
}

/** Finish admission after the route has read at most 1 KiB, before parsing or storing JSON. */
export function verifyLocalDesktopSnapshotBody(req: Request, body: Uint8Array): boolean {
  const expected = admittedBodyDigests.get(req);
  if (!expected || body.byteLength > 1024) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(desktopSnapshotBodyDigest(body)));
}
