# 130 — Dispositions (closes and verdicts with evidence)

User authorization on record: close issues/PRs that are already resolved on
`dev`. Anything beyond that (closing contributor PRs as superseded, asking
reporters for info) is executed only when this document's table names it, and
ambiguous cases go back to the user first.

## Close as already-fixed (issue)

| Item | Action | Evidence to cite in the close comment |
|------|--------|----------------------------------------|
| #806 | close | `d52b387db` is an ancestor of `origin/dev` (verified `git merge-base --is-ancestor`); GUI/CLI/docs wording split shipped (`gui/src/i18n/en.ts:1296-1315`) |

## Verification-needed issues — campaign verdicts

| Item | Disposition | Basis |
|------|-------------|-------|
| #994 | leave open; allowlist location identified, needs reporter's provider/model + wire capture | `src/providers/registry.ts:918-958,1637-1655` |
| #904 | leave open; `eeef7a32a` fixed surrogate boundaries but the original capture is still needed | 001 triage |
| #796 | leave open pending live Ark credential verification; structural fix `d3abf4345` + regression test already on dev | `tests/volcengine-ark-assistant-content.test.ts:90-125` |
| #418 | leave open; latest same-run trace does not reproduce; needs reporter's current trace | `src/server/responses/collaboration.ts:243-304` |

## Contributor PRs superseded by stack PRs

Disposition happens only after the corresponding stack PR lands on `dev`,
and only after a semantic-equivalence comparison (audit round 1, blocker 5):
the landed behavior and tests are compared against the contributor PR's full
scope, useful authorship is preserved where the contributor's approach was
adopted, and any contributor behavior intentionally not matched is recorded
with the reason. "The linked issue is fixed" alone is never sufficient.

| PR | Successor | Equivalence basis (from the decade docs) | Disposition when landed |
|---:|-----------|------------------------------------------|-------------------------|
| #966, #922 | 030 (#914) | #966 closest semantic source (classifier/retry extracted, sidecar blast radius excluded); #922 not equivalent (policy expansions rejected) | close with pointer, user confirm |
| #928 | 040 (#893) | field-only normalization ≠ commitment; event-synthesis design recorded | close with pointer, user confirm |
| #940 | 060 (#938) | ID-prefix idea equivalent; 750-line bundle's extra mechanisms deliberately excluded, named in the close comment | close with pointer, user confirm |
| #1006 | 050 (#875) | core policy adopted (bounded upstream JSON), diff superseded with attribution | adopt-or-close at that cycle's P |
| #961 | 120 (#959) | ADOPTED, not superseded — authorship preserved, hardening slice added | review forward, not close |

## Stale/broken PRs outside the stack

#933 (CI fail), #557 (CI fail), #936 (conflicting, needs security review per
MAINTAINERS), #569 (conflicting), #997/#947/#1000/#978/#983/#985 (unverified,
policy-only CI). These stay open; the campaign does not close contributor work
that merely needs the author. Recorded here so the surface state is complete.
