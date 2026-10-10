# 030 — PR targeting origin/dev and merge

## Branch

From the worktree and branch already created in 020 (`docs/credits-3988-rrmlima`
on `/tmp/opencodex-credits-3988`). Do **not** `git switch -c` from `origin/dev`
again — that would leave the 020 commit behind.

## wp3 P stale-check (after wp2 D)

Previous D: CREDITS.md row is commit `d0360cc6d780e0d5a497a961a5dc3ce62f6b42ad`
on local `docs/credits-3988-rrmlima` in `/private/tmp/opencodex-credits-3988`.
`origin/dev` is still `2206f9606`. The branch is **not** on origin yet. Push
this existing branch; do not recreate it from `origin/dev`.

Do not commit unrelated dirty files from the session working tree.

## Push

```
git push -u origin HEAD --no-verify
```

Authorized by the operator for this loop.

## PR body (repository template)

Base: `dev`. Fill every section of `.github/PULL_REQUEST_TEMPLATE.md`.

Title: `docs(credits): record the #3988 carry whose merge dropped the trailer`

Body:

```markdown
## Summary

- Record #3988 by @rrmlima on CREDITS.md. Maintainer carry #4031 named the
  trailer in the pull-request description; the merge commit and the
  cherry-pick (`14ce693e5`, authored as an unmapped machine identity) did not
  keep a GitHub-resolvable co-author. Forward attribution uses the account-linked
  noreply trailer on this commit. No history rewrite.

### Maintainer-integration decision

Merging under `MAINTAINERS.md` maintainer integration into `dev`: documentation-only
CREDITS.md repair, same class as #3787 / #3811. Exact-head SHA: (fill
`HEAD_OID` here before merge). Local suite **NOT RUN** (operator instruction). Hosted
Cross-platform CI is not the verifier for this row; GraphQL `Commit.authors` on the
squash object must resolve `rrmlima`. This is maintainer integration, not self-approval.

## Verification

- `git log origin/dev -n 3000` carry scan; GitHub GraphQL `Commit.authors` on
  `14ce693e5` (`user: null` for the unmapped machine author; only CommandCodeBot otherwise).
- `rg '/pull/3988' CREDITS.md`
- Local bun test / typecheck / full suite: **NOT RUN** (operator instruction).

## Checklist

- [x] Scope stays focused and avoids unrelated cleanup.
- [x] Docs or release notes were updated when needed.
- [x] Security-sensitive changes were reviewed for secrets, auth, and unsafe defaults.
```

`[skip ci]` in the commit subject is enough to skip hosted suite, matching #3811.

## Merge

Deterministic contract: **squash** with an explicit commit message that
**contains the literal trailer**. Do not rely on GitHub copying the PR body.
This is the failure mode that dropped the #4031 trailer.

1. Capture `HEAD_OID=$(gh pr view --json headRefOid -q .headRefOid)`.
   Write that SHA into the PR description's "Exact-head SHA:" line (and a
   comment if the description was already submitted) **before** merging —
   `MAINTAINERS.md` requires the exact-head record on the PR.
2. Squash with `--match-head-commit "$HEAD_OID"` and a message that includes
   the subject plus:

   ```
   Co-authored-by: rrmlima <137737127+rrmlima@users.noreply.github.com>
   ```

   Example:

   ```
   gh pr merge --squash --match-head-commit "$HEAD_OID" --subject "docs(credits): record the #3988 carry whose merge dropped the trailer" --body "Forward attribution for #3988 / #4031.

   Co-authored-by: rrmlima <137737127+rrmlima@users.noreply.github.com>
   "
   ```

3. Read `MERGE_OID=$(gh pr view --json mergeCommit -q .mergeCommit.oid)` and
   inspect **that object**, not `origin/dev` tip (another PR can land first):

   ```
   git fetch origin
   git log -1 --format=%B "$MERGE_OID"
   ```

   The body must contain `137737127+rrmlima@users.noreply.github.com`.

4. GraphQL-resolve that exact object (trailer text is not enough —
   `CREDITS.md` "Verify the landing"):

   ```
   gh api graphql -f query='query { repository(owner:"lidge-jun", name:"opencodex") { object(expression:"'"$MERGE_OID"'") { ... on Commit { authors(first:10) { nodes { name email user { login } } } } } } }'
   ```

   Require a node with `user.login == "rrmlima"`.

## Accept

- PR URL returned; `gh pr view --json state,baseRefName,mergedAt,mergeCommit`
  shows `MERGED`, base `dev`.
- Squash object body has the numeric-id noreply trailer **and** GraphQL
  `Commit.authors` on that oid includes `user.login = rrmlima`.
- No local suite was run.

## wp3 B merge

PR #4432 squash `dcd13b4358befaae0fdca845a8219103943faca0` on `dev`. GraphQL `user.login=rrmlima`.
