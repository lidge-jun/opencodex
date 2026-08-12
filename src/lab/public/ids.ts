import { domainHash, jcsStringify } from "../digest";

export type PublicEvidenceIdKind =
  | "subject"
  | "record"
  | "bundle"
  | "bundle_digest"
  | "artifact"
  | "publisher_key"
  | "revocation"
  | "route_registry";

const PUBLIC_EVIDENCE_DOMAIN: Record<PublicEvidenceIdKind, string> = {
  subject: "ocx-lab-public:subject:v1",
  record: "ocx-lab-public:record:v1",
  bundle: "ocx-lab-public:bundle:v1",
  bundle_digest: "ocx-lab-public:bundle-digest:v1",
  artifact: "ocx-lab-public:artifact:v1",
  publisher_key: "ocx-lab-public:publisher-key:v1",
  revocation: "ocx-lab-public:revocation:v1",
  route_registry: "ocx-lab-public:route-registry:v1",
};

export function publicEvidenceId(kind: PublicEvidenceIdKind, payload: unknown): string {
  return domainHash(PUBLIC_EVIDENCE_DOMAIN[kind], jcsStringify(payload));
}
