import { timingSafeEqual } from "node:crypto";
import {
  LOCAL_MANAGEMENT_CAPABILITY_EXPIRES_AT_HEADER,
  LOCAL_MANAGEMENT_CAPABILITY_HEADER,
  LOCAL_MANAGEMENT_EXPECTED_PID_HEADER,
  LOCAL_MANAGEMENT_NONCE_HEADER,
  parseExpectedLocalManagementPid,
} from "../lib/local-management-capability";
import {
  accountSwitchBodyDigest, isLocalAccountSwitchPath,
  LOCAL_ACCOUNT_SWITCH_BODY_HEADER, verifyLocalAccountSwitchCapability,
} from "../lib/local-account-switch-capability";
import type { LocalManagementAuthContext } from "./management-auth";

const REPLAY_LIMIT = 256;
const BODY_LIMIT = 1024;
const consumed = new Map<string, number>();
const admittedBodyDigests = new WeakMap<Request, string>();

/** Admit one exact body-bound account switch on the attested local listener. */
export function hasLocalAccountSwitchCapability(
  req: Request, local: LocalManagementAuthContext | undefined, now = Date.now(),
): boolean {
  if (admittedBodyDigests.has(req)) return true;
  if (!local || req.method !== "PUT" || req.headers.has("origin")) return false;
  let url: URL;
  try { url = new URL(req.url); } catch { return false; }
  if (!isLocalAccountSwitchPath(url.pathname) || url.search !== "") return false;
  const expectedPid = parseExpectedLocalManagementPid(req.headers.get(LOCAL_MANAGEMENT_EXPECTED_PID_HEADER));
  if (expectedPid.kind !== "present" || expectedPid.pid !== local.pid) return false;
  const expiry = req.headers.get(LOCAL_MANAGEMENT_CAPABILITY_EXPIRES_AT_HEADER);
  if (!expiry || !/^[1-9]\d*$/.test(expiry)) return false;
  const expiresAt = Number(expiry);
  const capability = req.headers.get(LOCAL_MANAGEMENT_CAPABILITY_HEADER);
  const bodyDigest = req.headers.get(LOCAL_ACCOUNT_SWITCH_BODY_HEADER);
  if (!verifyLocalAccountSwitchCapability(
    local.attestationSecret, req.headers.get(LOCAL_MANAGEMENT_NONCE_HEADER),
    req.method, url.pathname, local.pid, local.port, expiresAt, bodyDigest, capability, now,
  )) return false;
  for (const [proof, until] of consumed) if (until <= now) consumed.delete(proof);
  if (!capability || !bodyDigest || consumed.has(capability) || consumed.size >= REPLAY_LIMIT) return false;
  consumed.set(capability, expiresAt);
  admittedBodyDigests.set(req, bodyDigest);
  return true;
}

/** Stream a bounded raw body and compare it with the authenticated, cached digest. */
export async function readVerifiedAccountSwitchBody(
  req: Request,
): Promise<{ status: 200; body: Uint8Array } | { status: 403 | 413 }> {
  const expected = admittedBodyDigests.get(req);
  if (!expected) return { status: 403 };
  const reader = req.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > BODY_LIMIT) {
          await reader.cancel();
          return { status: 413 };
        }
        chunks.push(value);
      }
    } catch {
      return { status: 403 };
    } finally {
      reader.releaseLock();
    }
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(accountSwitchBodyDigest(body)))) return { status: 403 };
  return { status: 200, body };
}
