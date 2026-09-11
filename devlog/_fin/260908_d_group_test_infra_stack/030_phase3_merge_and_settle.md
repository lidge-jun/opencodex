# Phase 3 — Merge the tip, settle the stack

## Gate

The product gate is the Cross-platform CI run on the tip's **exact** head SHA.
Record run id, head SHA, and each producer's conclusion. A cancelled or superseded
run is not evidence, and a run on an earlier head is not evidence for the merged
head. Read the producers, not only the aggregate `ci` check.

Expected to RUN (`ci: true` via `tests/**` and `scripts/**`): four Linux `test`
shards, `gates`, `storage policy`, `api usage`, `macos <n>/2`, `keyring` (three OS),
`docker smoke`.

Expected to be SKIPPED BY WORKFLOW, and recorded as such rather than as passes:
`windows <n>/6` and `macos control` (both `workflow_dispatch`-only), and
`npm-global <os>` (needs `packaging == 'true'`, which these four files do not set).

Merge also requires, on the same head:

- `enforce-target` success and `hygiene` success;
- every actionable automated review finding resolved;
- **outstanding maintainer change requests resolved or explicitly withdrawn**
  (`MAINTAINERS.md:62-64`) — read the human reviews immediately before merging, not
  only the bot findings;
- a refreshed read of head, base, merge state, and the integrating actor's
  repository permission immediately before merging.

## Maintainer integration record

`MAINTAINERS.md:59-63` permits a maintainer with `maintain` or `admin` to integrate
into `dev` without a second approval, and requires the decision and the exact-head
verification to be recorded in the pull request. Post that record as a comment
before merging: the integrating maintainer, the exact head SHA, the CI run link,
the job matrix including the skipped families, and the statement that local suite,
typecheck and build were NOT RUN by owner instruction.

The `Protect dev` ruleset still requires an approving review and code-owner review,
so the merge call itself will be refused without an explicit administrator bypass.
That bypass is the mechanism this policy exception is exercised through, and it is
conditional: verified maintainer identity with `admin`, base `dev`, every planned
check green on the exact head, and the integration record posted. It is never a way
past failing CI or an unresolved objection.

## Merge order

1. Refresh the tip against `dev` if `dev` moved; a moved base means the green run
   no longer describes the merge result, so re-run the gate on the new head.
2. Merge the tip pull request into `dev` with an explicit squash body. The repository
   sets `squash_merge_commit_message: COMMIT_MESSAGES`, so the landed message is not
   the pull-request description: supply it directly and make it carry the trailer.

   ```sh
   gh pr merge <tip> --repo lidge-jun/opencodex --squash --admin \
     --match-head-commit <exact-head-sha> --body-file <squash-body>
   ```

   `--body-file` supplies the **merge commit body**, which under `--squash` is the
   squash commit body, replacing the repository's `COMMIT_MESSAGES` default
   (verified against the installed `gh` 2.91.0 help). `--subject` is optional and
   only controls the title. `--match-head-commit` refuses the merge if the head
   moved after the gate was read.

   The squash body must contain, on its own line:

   ```text
   Co-authored-by: luvs01 <27862058+luvs01@users.noreply.github.com>
   ```

3. Read the landed squash SHA from GitHub, fetch `origin/dev`, and prove:
   `git merge-base --is-ancestor <squash-sha> origin/dev` exits 0, the landed commit
   message contains the trailer, and the four files on `dev` match the reviewed tip.

Merging is an external state change and stays user-authorized.

## Settling the source pull requests

Both #3924 and #3930 were carried by `cherry-pick -x`, so GitHub will not mark them
merged automatically. After the tip lands:

- Verify the landed commit's trailer **before** closing either source pull request.
  A closing comment is prose; only the trailer is contributor-graph data
  (`CREDITS.md` exists because that distinction was missed 27 times).
- Then close #3924 and #3930 with a comment naming the landed squash SHA, the tip
  pull request, and the preserved authorship.
- Do not delete the contributor branches on the fork; they are not ours.

## Linked issues

Neither #3924 nor #3930 declares a closing issue reference
(`closingIssuesReferences` is empty for both). If none is discovered during the
cycle, the "close linked issues" obligation is satisfied vacuously and recorded as
such. Any issue found to be resolved by this landing is closed at the moment the
change is on `dev`, with a comment naming the commit.

## Acceptance

- Tip CI: run id + head SHA + per-job conclusions on the merged head, with the three
  skipped job families named as skipped.
- `enforce-target` and `hygiene` green on that head; maintainer-integration record
  posted on the pull request.
- `git merge-base --is-ancestor <squash-sha> origin/dev` exits 0 after fetch, the
  landed commit carries the `luvs01` trailer, and the four files on `dev` match the
  reviewed tip.
- #3924 and #3930 closed after that verification; no lower-layer pull request was
  ever opened.
- Linked-issue status stated explicitly (closed, or none exists).
