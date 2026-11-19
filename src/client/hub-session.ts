import { createHash } from "node:crypto";
import { lstatSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config/paths";
import { atomicWriteFileNoFollow } from "../config/atomic-write";
import { readBoundedRegularFileSync } from "../lib/bounded-file-read";
import { sameFileIdentity } from "../lib/file-identity";
import { verifySecretPathAcl } from "../lib/windows-secret-acl";
import { readServiceApiTokenState } from "../lib/service-secrets";
import { hubRelayEnrollmentProof, isHubRelayToken } from "../remote/hub-management-relay";
import type { OcxClientConnectionConfig } from "../types";
import { assertNoClientDisconnectPending, isLinkConnection, readClientConnectionState, sameClientConnectionOwner } from "./state";

const MAX_HUB_SESSION_BYTES = 4096;

export interface HubRelayCredential {
  kind: "relay";
  token: string;
}

export type HubCredentialOwner = Pick<OcxClientConnectionConfig, "managementUrl" | "apiKeyId" | "connectedAt" | "tokenFingerprint">;
export type HubCredentialState =
  | { kind: "absent" }
  | { kind: "unsafe" }
  | { kind: "present"; credential: HubRelayCredential };

function fingerprint({ managementUrl, apiKeyId, connectedAt, tokenFingerprint }: HubCredentialOwner): string {
  return createHash("sha256").update(JSON.stringify([managementUrl, apiKeyId, connectedAt, tokenFingerprint])).digest("base64url");
}

export function parseHubCredential(value: unknown): HubRelayCredential | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return Object.keys(record).sort().join(",") === "kind,token" && record.kind === "relay" && isHubRelayToken(record.token)
    ? { kind: "relay", token: record.token }
    : null;
}

export function hubSessionFilePath(): string {
  return join(getConfigDir(), "hub-management-session.json");
}

/** The listener checks the owner against the same connection snapshot it forwards to. */
export function readHubCredential(owner: HubCredentialOwner): HubCredentialState {
  const path = hubSessionFilePath();
  let initial;
  try {
    initial = lstatSync(path, { bigint: true });
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "absent" } : { kind: "unsafe" };
  }
  try {
    if (!initial.isFile() || initial.isSymbolicLink() || initial.size > BigInt(MAX_HUB_SESSION_BYTES)) return { kind: "unsafe" };
    const privateFile = process.platform === "win32"
      ? verifySecretPathAcl(path)
      : (initial.mode & 0o777n) === 0o600n && initial.uid === BigInt(process.getuid!());
    if (!privateFile) return { kind: "unsafe" };
    const raw = readBoundedRegularFileSync(path, MAX_HUB_SESSION_BYTES);
    const current = lstatSync(path, { bigint: true });
    if (!sameFileIdentity(current, initial) || current.ctimeNs !== initial.ctimeNs) return { kind: "unsafe" };
    const record: unknown = JSON.parse(raw.toString("utf8"));
    if (!record || typeof record !== "object" || Object.keys(record).sort().join(",") !== "credential,owner") return { kind: "unsafe" };
    const { owner: ownerFingerprint, credential: stored } = record as Record<string, unknown>;
    const credential = parseHubCredential(stored);
    return credential && ownerFingerprint === fingerprint(owner)
      ? { kind: "present", credential }
      : { kind: "unsafe" };
  } catch {
    return { kind: "unsafe" };
  }
}

export function writeHubCredential(credential: HubRelayCredential, owner: HubCredentialOwner): void {
  const parsed = parseHubCredential(credential);
  if (!parsed) throw new Error("refusing to persist an invalid Hub relay credential");
  atomicWriteFileNoFollow(hubSessionFilePath(), `${JSON.stringify({ owner: fingerprint(owner), credential: parsed })}\n`);
}

export function readHubRelayAdmission(
  owner: HubCredentialOwner, method: string, target: string,
): { token: string; keyId: string; proof: string; at: string } | null {
  const stored = readHubCredential(owner);
  if (stored.kind !== "present") return null;
  const key = readServiceApiTokenState();
  if (key.kind !== "present" || key.fingerprint !== owner.tokenFingerprint) return null;
  const { token } = stored.credential;
  const at = String(Date.now());
  const proof = hubRelayEnrollmentProof(key.token, owner.apiKeyId, "read", token, { at, method, target });
  return { token, keyId: owner.apiKeyId, proof, at };
}

/** Follow rotation of this enrollment and fence a disconnect or replacement. */
export function currentHubRelayAdmission(
  connection: OcxClientConnectionConfig, method: string, target: string,
): ReturnType<typeof readHubRelayAdmission> {
  try { assertNoClientDisconnectPending(); } catch { return null; }
  const live = readClientConnectionState();
  if (live.kind !== "connected" || live.value.pendingOperation || isLinkConnection(live.value)
    || !sameClientConnectionOwner(live.value, connection) || live.value.managementUrl !== connection.managementUrl) return null;
  return readHubRelayAdmission(live.value, method, target);
}

export function removeHubCredential(): void {
  try { unlinkSync(hubSessionFilePath()); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
