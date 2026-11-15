// Best-effort regression lint data, not a security boundary or completeness proof.
// Review rows for the #8294 offline signed-update verification modules (minisign.mjs, signed-supply.mjs,
// update-bounded-json.mjs, update-checkpoint-codec.mjs, update-contracts.mjs,
// update-signature-threshold.mjs, update-signed-version.mjs), kept apart from the base tables so the
// group is reviewed on its own. Every module here is pure verification over caller-supplied bytes: no
// filesystem, process, network or runtime capability, and no update authority. A file key may appear in
// only one table.
import type { UpdateReviewTable } from "./update-review-table";

export const signedSupplyReview: UpdateReviewTable = {
  staticImports: {
    "src/update/minisign.mjs": [
      "import { snapshotUpdateBytes } from \"./update-bytes.mjs\";", // pure: bounded copy of caller bytes
    ],
    "src/update/signed-supply.mjs": [
      "import { parseRootTransitionEnvelope, parseSignatureEnvelope, parseUpdateDocument } from \"./update-contracts.mjs\";", // pure: parse signed documents
      "import { EMBEDDED_ROOT_SHA256 } from \"./update-trust-anchor.mjs\";", // pure: embedded trust-anchor constant
      "import { snapshotUpdateBytes } from \"./update-bytes.mjs\";", // pure: bounded copy of caller bytes
      "import { verifySignatureThreshold } from \"./update-signature-threshold.mjs\";", // pure: count valid signatures
      "import { deriveCandidateId } from \"./update-candidate-id.mjs\";", // pure: digest-derived identifier
      "import { decodePublicKey, verifyMinisignBytes } from \"./minisign.mjs\";", // pure: signature verification
      "import { trustedCommentMatchesVersion } from \"./update-signed-version.mjs\";", // pure: version comparison
    ],
    "src/update/update-bounded-json.mjs": [
      "import { snapshotUpdateBytes } from \"./update-bytes.mjs\";", // pure: bounded copy of caller bytes
    ],
    "src/update/update-checkpoint-codec.mjs": [
      "import { snapshotUpdateBytes } from \"./update-bytes.mjs\";", // pure: bounded copy of caller bytes
      "import { parseRootTransitionEnvelope, parseUpdateDocument } from \"./update-contracts.mjs\";", // pure: parse signed documents
      "import { sameSignedVersion } from \"./update-signed-version.mjs\";", // pure: version comparison
    ],
    "src/update/update-contracts.mjs": [
      "import { parseBoundedJson } from \"./update-bounded-json.mjs\";", // pure: bounded JSON parse
      "import { decodePublicKey } from \"./minisign.mjs\";", // pure: key decoding
      "import { sameSignedVersion } from \"./update-signed-version.mjs\";", // pure: version comparison
    ],
    "src/update/update-signature-threshold.mjs": [
      "import { decodePublicKey, verifyMinisignBytes } from \"./minisign.mjs\";", // pure: signature verification
    ],
  },
  deferredImports: [],
  primitive: [
    ["src/update/update-signed-version.mjs:validVersion:VERSION.exec", "pure: RegExp#exec on a version string, not a process exec"],
    ["src/update/update-bounded-json.mjs:parseBoundedJson:NUMBER.exec", "pure: RegExp#exec on JSON number text, not a process exec"],
    // Keyed on the complete expression: any other Reflect member at these sites is still flagged.
    ["src/update/signed-supply.mjs:verifyExternalMetadataEvidence:Reflect.ownKeys(descriptors)", "pure: counts a descriptor snapshot's own keys; no capability acquisition"],
    ["src/update/update-checkpoint-codec.mjs:record:Reflect.ownKeys(value)", "pure: checks a decoded record's exact key set; no capability acquisition"],
    ["src/update/update-checkpoint-codec.mjs:list:Reflect.ownKeys(value)", "pure: checks a decoded list's exact index keys; no capability acquisition"],
  ],
  process: [],
  contracts: [
    ["src/update/signed-supply.mjs", "verifyExternalMetadataEvidence", "Reflect.ownKeys(descriptors)", 1, "read-only: exact own-key count of a caller descriptor snapshot before any field is trusted"],
    ["src/update/update-checkpoint-codec.mjs", "record", "Reflect.ownKeys(value)", 1, "read-only: exact key set of a decoded checkpoint record"],
    ["src/update/update-checkpoint-codec.mjs", "list", "Reflect.ownKeys(value)", 1, "read-only: exact index keys of a decoded checkpoint list"],
  ],
};

