import { randomBytes, timingSafeEqual } from "node:crypto";
import type { OcxConfig } from "../types";
import {
  HUB_RELAY_CREDENTIAL_PATH, HUB_RELAY_ENROLLMENT_ID_HEADER, HUB_RELAY_ENROLLMENT_PROOF_HEADER,
  HUB_RELAY_PROOF_TIME_HEADER, HUB_RELAY_REVOCATION_HEADER, HUB_RELAY_TOKEN_PREFIX, hubRelayDigest, hubRelayEnrollmentProof,
  hubRelayReadTarget, hubRelayRequestTarget, isHubRelayToken,
} from "../remote/hub-management-relay";

export const HUB_RELAY_IDLE_TTL_MS = 5 * 60_000;
const READ_PROOF_SKEW_MS = 30_000;
const MAX_LEASES = 1024;
type Lease = { tokenDigest: string; keyDigest: string; expiresAt: number };
const leases = new WeakMap<object, Map<string, Lease>>();

function equalDigest(actual: string | null, expected: string): boolean {
  if (!actual || !/^[A-Za-z0-9_-]{43}$/.test(actual)) return false;
  return timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

function enrolledKey(
  req: Request, config: OcxConfig, operation: "issue" | "read" | "revoke", credential = "",
  read?: { at: string; method: string; target: string },
) {
  if (config.runtimeRole !== "hub") return null;
  const id = req.headers.get(HUB_RELAY_ENROLLMENT_ID_HEADER);
  const entry = id && config.apiKeys?.find(key => key.id === id);
  if (!entry || !equalDigest(req.headers.get(HUB_RELAY_ENROLLMENT_PROOF_HEADER),
    hubRelayEnrollmentProof(entry.key, entry.id, operation, credential, read))) return null;
  return entry;
}

export function admitHubRelayRead(
  owner: object, req: Request, config: OcxConfig, token: string, now = performance.now(), wallTime = Date.now(),
): string | null {
  if (!isHubRelayToken(token) || !hubRelayReadTarget(req)) return null;
  const entries = leases.get(owner);
  const id = req.headers.get(HUB_RELAY_ENROLLMENT_ID_HEADER);
  if (!entries || !id) return null;
  const lease = entries.get(id);
  if (!lease) return null;
  if (lease.expiresAt <= now) {
    entries.delete(id);
    return null;
  }
  if (!equalDigest(hubRelayDigest(token), lease.tokenDigest)) return null;
  const at = req.headers.get(HUB_RELAY_PROOF_TIME_HEADER);
  if (!at || !/^\d{13}$/.test(at) || Math.abs(Number(at) - wallTime) > READ_PROOF_SKEW_MS) return null;
  const entry = enrolledKey(req, config, "read", token, { at, method: req.method, target: hubRelayRequestTarget(req) });
  if (!entry || !equalDigest(hubRelayDigest(entry.key), lease.keyDigest)) return null;
  lease.expiresAt = now + HUB_RELAY_IDLE_TTL_MS;
  return entry.id;
}

export function issueHubRelayCredential(
  owner: object, req: Request, config: OcxConfig, now = performance.now(),
): Response {
  if (req.method !== "POST" || hubRelayRequestTarget(req) !== HUB_RELAY_CREDENTIAL_PATH) return reply(404);
  if (req.body) return reply(400);
  const entry = enrolledKey(req, config, "issue");
  if (!entry) return reply(401);
  let entries = leases.get(owner);
  if (!entries) leases.set(owner, entries = new Map());
  for (const [id, lease] of entries) {
    if (lease.expiresAt <= now) entries.delete(id);
  }
  if (!entries.has(entry.id) && entries.size >= MAX_LEASES) return reply(503);
  const token = HUB_RELAY_TOKEN_PREFIX + randomBytes(32).toString("base64url");
  entries.set(entry.id, { tokenDigest: hubRelayDigest(token), keyDigest: hubRelayDigest(entry.key), expiresAt: now + HUB_RELAY_IDLE_TTL_MS });
  return Response.json({ token }, { status: 201, headers: { "cache-control": "no-store" } });
}

export function revokeHubRelayCredential(owner: object, req: Request, config: OcxConfig): Response {
  if (req.method !== "DELETE" || hubRelayRequestTarget(req) !== HUB_RELAY_CREDENTIAL_PATH) return reply(404);
  if (req.body || req.headers.has("authorization") || req.headers.has("x-opencodex-api-key")) return reply(400);
  const digest = req.headers.get(HUB_RELAY_REVOCATION_HEADER);
  if (!digest || !/^[A-Za-z0-9_-]{43}$/.test(digest)) return reply(401);
  const entry = enrolledKey(req, config, "revoke", digest);
  if (!entry) return reply(401);
  const entries = leases.get(owner);
  const lease = entries?.get(entry.id);
  if (lease && equalDigest(digest, lease.tokenDigest)) entries?.delete(entry.id);
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}

function reply(status: number): Response {
  return Response.json({ error: "hub relay credential refused" }, { status, headers: { "cache-control": "no-store" } });
}
