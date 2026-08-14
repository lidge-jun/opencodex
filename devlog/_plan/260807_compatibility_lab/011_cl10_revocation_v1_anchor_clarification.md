# CL-10 V1 revocation anchor clarification

Status: normative clarification to `010_cl10_public_evidence_export.md` section 17.

`PublicEvidenceRevocationV1` uses exactly one already-verified target bundle as its authority anchor. The revocation may contain between 1 and 256 sorted unique targets, but every target must resolve inside that one anchor bundle:

- a `bundle` target must equal the anchor bundle ID;
- a `record` target must name a record contained by the anchor bundle;
- mixed bundle/record targets are allowed only when they all resolve inside the same anchor bundle;
- multiple distinct bundle IDs in one V1 revocation are not supported and must be rejected;
- targets spread across multiple bundles are not supported even when those bundles use the same publisher key.

The publisher algorithm, key ID and exact public key in the revocation must match the already-verified anchor bundle before the revocation signature is authoritative. V1 therefore has no cross-key, key-rotation or multi-bundle authority bootstrap.

The phrase "one or more bundle/record IDs" in section 17 describes the bounded target list, not multiple independent bundle authority contexts. Where that wording could be read as authorizing a single V1 revocation across multiple bundles, this clarification is authoritative.

Supporting multi-bundle revocation requires a separately reviewed contract/schema revision that defines how all target bundles are supplied, verified, bounded and bound to the signing authority before persistence or application.
