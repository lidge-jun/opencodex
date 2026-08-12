import { domainHash, jcsStringify } from "../digest";

const PUBLIC_ID_DOMAINS = {
  subject: "ocx-lab:public-subject:v1",
  record: "ocx-lab:public-record:v1",
  bundle: "ocx-lab:public-bundle:v1",
  artifact: "ocx-lab:public-artifact:v1",
  publisher: "ocx-lab:public-publisher:v1",
  revocation: "ocx-lab:public-revocation:v1",
  bundleDigest: "ocx-lab:public-bundle-digest:v1",
} as const;

export type PublicEvidenceIdKind = "subject" | "record" | "bundle" | "publisher" | "revocation";
export function publicEvidenceId(kind: PublicEvidenceIdKind, payload: unknown): string {
  return domainHash(PUBLIC_ID_DOMAINS[kind], jcsStringify(payload));
}
export function publicArtifactId(bytes: Uint8Array): string {
  return domainHash(PUBLIC_ID_DOMAINS.artifact, bytes);
}
export function publicPublisherKeyId(publicKeyDer: Uint8Array): string {
  return domainHash(PUBLIC_ID_DOMAINS.publisher, publicKeyDer);
}
export function publicBundleDigest(payload: unknown): string {
  return domainHash(PUBLIC_ID_DOMAINS.bundleDigest, jcsStringify(payload));
}
