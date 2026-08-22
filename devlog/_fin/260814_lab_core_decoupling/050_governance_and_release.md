# 050 — Phase 5: governance, verification, and release

Unit: `260814_lab_core_decoupling`. Depends on: phases 1–4.

## Governance actions already taken (2026-08-14)

Recorded here because they are part of this unit's decision, not a separate event.

- PR [#1510](https://github.com/lidge-jun/opencodex/pull/1510) — CL-10 operator and
  community integration — **closed** with an explanatory comment.
- PR [#1628](https://github.com/lidge-jun/opencodex/pull/1628) — CL-10 public evidence
  trust core — **closed** with the same comment.

Both comments state the reason (dependency direction into the core, with file:line
evidence), that the branches and CL-01..09 history are untouched, and that the work may be
resubmitted on top of the boundary. Branch refs `cl10-public-core`,
`feat/cl-10-public-evidence-contract`, and the two `backup/cl-10*` refs remain on the
remote; nothing was deleted.

No other open PR was touched. A file-level check across the 44 open PRs found only
#1639 (mimo-free auth repair, incidental `router.ts` line) and #1623 (adapter registry
refactor touching a Lab conformance file) overlapping the scope at all, and neither is CL
feature work.

## CODEOWNERS

`.github/CODEOWNERS` already routes `/src/server/` to all three maintainers. The owner
directive is that the three core files specifically require **owner** approval. Add a
dedicated section after the existing "High-impact runtime behavior" block:

```diff
+# Proxy core boundary — owner approval required.
+# These files carry every user's request path. Optional subsystems must register into
+# core-owned slots rather than being imported here; see
+# devlog/_fin/260814_lab_core_decoupling/ and tests/core-lab-boundary.test.ts.
+/src/router.ts @lidge-jun
+/src/server/index.ts @lidge-jun
+/src/server/lifecycle.ts @lidge-jun
+/src/server/responses/core.ts @lidge-jun
```

Later rules win in CODEOWNERS, so these must sit **after** the `/src/server/` line to take
effect. Placement is load-bearing, not cosmetic.

## Branch protection

CODEOWNERS requests review; it does not require it. `MAINTAINERS.md` is explicit that no
branch protection is configured on this repository and that the approval requirement is
convention. This unit changes that for `dev`.

Owner has `admin: true` (verified via `gh api repos/lidge-jun/opencodex --jq .permissions`),
so the rule can be applied:

```bash
gh api -X PUT repos/lidge-jun/opencodex/branches/dev/protection \
  --input .tmp/dev-protection.json
```

with `required_pull_request_reviews.require_code_owner_reviews: true`,
`required_approving_review_count: 1`, `enforce_admins: false`, and
`required_status_checks` left as-is to avoid breaking the existing CI gates.

`enforce_admins: false` is deliberate: the owner performs emergency repairs and release
promotions directly, and `MAINTAINERS.md` already reserves direct pushes for exactly that.

Verify by reading the rule back:

```bash
gh api repos/lidge-jun/opencodex/branches/dev/protection --jq '{
  code_owner: .required_pull_request_reviews.require_code_owner_reviews,
  count: .required_pull_request_reviews.required_approving_review_count
}'
```

## MODIFY: `MAINTAINERS.md`

The change-log section is authoritative and currently records that branch protection is
absent. Append an entry dated 2026-08-14 recording: the boundary decision, the CL-10
closures, the CODEOWNERS addition, and that branch protection is now configured on `dev` —
so the file stops asserting something that is no longer true.

## Verification

Local (fast feedback): focused `bun test` per phase, then `bun x tsc --noEmit`.

Authoritative (Linux, matching CI): remote runner `lidge` — Ubuntu, Bun 1.3.14 at
`~/.bun/bin/bun`.

```bash
rsync the working tree to a scratch dir on lidge
~/.bun/bin/bun install
~/.bun/bin/bun x tsc --noEmit
~/.bun/bin/bun test
```

Record the tail with pass/fail counts and the exit code. A pre-existing failure unrelated
to this unit is reported as a baseline, not silently absorbed.

## Push

Branch `codex/lab-core-decoupling` off `dev`. Commits are per-phase, so the boundary work
is reviewable one seam at a time.

`git push --no-verify` — the local `.git/hooks/pre-push` shim runs `bun run prepush`, and
the authoritative suite run happens on `lidge`. The bypass skips a duplicate local run, not
verification: the `lidge` evidence is recorded before the push.

## PR

Against `dev`, following `.github/PULL_REQUEST_TEMPLATE.md` (Summary, Verification,
Checklist). The description states the six coupling points, the boundary design, the
`lidge` evidence, and links this devlog unit. No `gui` mention, so no screenshot gate.

## Release

Release is owner-authorized for this work. `scripts/release.ts` is the release authority
and `MAINTAINERS.md` reserves promotion to the owner.

Ordering constraint: the release runs from `dev` **after** the PR lands, not from the
feature branch. If the PR is still open when this phase is reached, the release is
reported as deferred with that reason rather than forced — a release from an unmerged
branch would contradict the branch policy this same unit is tightening.

## Accept criteria

- CL-10 PRs closed with comments; branches intact. ✅ done 2026-08-14
- CODEOWNERS carries the owner-only core section, positioned after `/src/server/`.
- Branch protection on `dev` verified by reading the rule back.
- `MAINTAINERS.md` change log updated.
- `lidge` typecheck and suite evidence recorded.
- Branch pushed with `--no-verify`; PR opened against `dev`.
- Release executed, or deferred with a stated reason.
