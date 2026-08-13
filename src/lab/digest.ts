import { createHash, createHmac } from "node:crypto";
import { jcsStringify } from "./conformance/jcs";
import {
  fixtureDigest,
  scenarioManifestDigest,
  suiteManifestDigest,
} from "./conformance/digest";

export { fixtureDigest, scenarioManifestDigest, suiteManifestDigest, jcsStringify };
export { jcsEqual } from "./conformance/jcs";

/** Domain-separated SHA-256: UTF-8(domain) || NUL || payload. */
export function domainHash(domain: string, payload: Uint8Array | string): string {
  const hash = createHash("sha256");
  hash.update(new TextEncoder().encode(`${domain}\0`));
  if (typeof payload === "string") hash.update(new TextEncoder().encode(payload));
  else hash.update(payload);
  return hash.digest("hex");
}

export const LAB_DOMAIN = {
  event: "ocx-lab:event:v1",
  subject: "ocx-lab:subject:v1",
  claimSourceManifest: "ocx-lab:claim-source-manifest:v1",
  scenarioManifest: "ocx-lab:scenario-manifest:v1",
  suiteManifest: "ocx-lab:suite-manifest:v1",
  fixture: "ocx-lab:fixture:v1",
  localFingerprint: "ocx-lab:local-fingerprint:v1",
  artifactBytes: "ocx-lab:artifact-bytes:v1",
} as const;

export function eventIdForPayload(eventWithoutId: unknown): string {
  return domainHash(LAB_DOMAIN.event, jcsStringify(eventWithoutId));
}

export function subjectIdForSubject(subject: unknown): string {
  return domainHash(LAB_DOMAIN.subject, jcsStringify(subject));
}

export function claimSourceManifestDigest(manifest: unknown): string {
  return domainHash(LAB_DOMAIN.claimSourceManifest, jcsStringify(manifest));
}

/** Content digest for already-redacted artifact bytes (not contract fixture domain). */
export function artifactBytesDigest(bytes: Uint8Array): string {
  return domainHash(LAB_DOMAIN.artifactBytes, bytes);
}

export function localFingerprint(
  fieldName: string,
  value: unknown,
  salt: Uint8Array | string,
): string {
  const key = typeof salt === "string" ? new TextEncoder().encode(salt) : salt;
  const preimage = `${LAB_DOMAIN.localFingerprint}\0${fieldName}\0`;
  return createHmac("sha256", key)
    .update(new TextEncoder().encode(preimage))
    .update(new TextEncoder().encode(jcsStringify(value)))
    .digest("hex");
}

export function isSha256Hex(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}
