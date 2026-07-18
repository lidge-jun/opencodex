# Cycle 010 Audit Amendment

Reviewer: GPT-5.6 Sol, high reasoning, priority service tier
Result: `VERDICT: GO-WITH-FIXES (blockers=1)`

The initial Cycle-010 helper contract removed only canonical `chatgpt` rows. Because
marker 1 makes later runs idempotent, a malformed, key-auth, or custom-base row could
otherwise remain publicly configured forever.

Accepted amendment: before setting marker 1, remove any own `chatgpt` provider row
regardless of shape. Preserve the separate OAuth credential store, never copy row
secrets, preserve all nonlegacy ordering, and test canonical/noncanonical/extra-field
rows with and without pool intent plus a second idempotent projection.

## Repair audit

Result: `VERDICT: PASS`

The same reviewer confirmed the amended fixtures and contract close the blocker with
no new activation or feasibility issue. Registry, derive, router, config loading,
startup, auth, management, and GUI remain unchanged in Cycle 010.

## Implementation review amendment

The same reviewer found three code-level gaps. Accepted fixes:

1. Preserve an exact preexisting canonical Multi row; fail closed with a typed collision
   before changing any noncanonical reserved-id row, so custom credentials are not lost.
2. Build projection metadata through the existing native `buildCatalogEntries`
   authoritative/fallback path and inject a null template to test catalog absence.
3. Expand migration activation coverage to shape × pool intent, exact serialized-input
   preservation, external OAuth-store invariance, canonical/noncanonical Multi collision,
   and second-projection idempotence.

## Implementation repair verdict

Result: `VERDICT: PASS`

Focused suite: 73 passed, 0 failed. TypeScript typecheck passed. The reviewer confirmed
both null and non-null native-template branches, collision safety, migration coverage,
and no registry/router/config/startup/derive/auth change or public Multi activation.
