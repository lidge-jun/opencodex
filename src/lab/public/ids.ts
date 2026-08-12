import { domainHash, jcsStringify } from "../digest";

const PUBLIC_ID_DOMAINS = {
  subject: "ocx-lab:public-subject:v1",
  record: "ocx-lab:public-record:v1",
  bundle: "ocx-lab:public-bundle:v1",
  artifact: "ocx-lab:public-artifact:v1",
  publisher: "ocx-lab:public-publisher:v1",
  revocation: "ocx-lab:public-revocation:v1",
} as const;

export type PublicEvidenceIdKind = keyof typeof PUBLIC_ID_DOMAINS;

export function publicEvidenceId(kind: Exclude<PublicEvidenceIdKind, "artifact">, payload: unknown): string {
  return domainHash(PUBLIC_ID_DOMAINS[kind], jcsStringify(payload));
}

export function publicArtifactId(bytes: Uint8Array): string {
  return domainHash(PUBLIC_ID_DOMAINS.artifact, bytes);
}
