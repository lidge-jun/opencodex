# wp2 — green merge train

Five bug PRs are review-ready with every check green. An independent Sol reviewer
read each diff against current dev. Results below; one is NOT safe to land.

## Merge set

### #3430 fix(server): allow image routes on loopback listener — @ChickenBreast-ky
SAFE-TO-MERGE. Adds exactly the two image POST paths to the loopback allowlist at
`src/server/index.ts:815`. The handler still applies API admission and origin checks
(`src/server/index.ts:1688-1692`), so the public listener stays credential-gated;
GET and sub-paths remain denied. Regression: `tests/loopback-listener-integration.test.ts:349`.
Closes #3428.

### #3420 fix(responses): preserve outputs missing call ids — @ildunari
SAFE-TO-MERGE. Repair is scoped to tool-output items with no nonempty `call_id` and a
representable output (`src/adapters/openai-responses.ts:995`); valid stateful outputs
pass unchanged and malformed ones fail closed. Regression:
`tests/openai-responses-passthrough.test.ts:2248`. No `Closes` tag — no issue to close.

### #3405 fix(opencode-go): satisfy provider wire contract — @adtumk
MERGE-WITH-NOTE. Destination matching is exact; session values are opaque hashes;
explicit headers win; config is not mutated. The PR body reports four full-suite
failures it attributes to the dev baseline, not to itself. Since this unit does not
run the local suite, the note is recorded rather than re-litigated: hosted CI on the
PR is green, which is this unit's authoritative verifier. Closes #3378.

### #3401 fix(cli): heal deleted cwd at launch — @agentHits
MERGE-WITH-NOTE. `isatty(0/1)` avoids Bun lazy stream construction
(`src/cli/star-prompt.ts:168`, `src/update/notify.ts:125`); both launchers recover to
`homedir()`. Test coverage is partial: `tests/update-notify.test.ts:139` proves the TTY
guard under an unlinked cwd but does not spawn a launcher subprocess. Accepted as a
follow-up, not a blocker. Closes #3400.

### #3403 fix(proxy): accept dotted ns.name tool echo — @ianlyoo
HOLD — do not merge in wp2. The reviewer found a dispatch-collision risk: dotted
aliases are inserted into `toolNsMap` at `src/server/responses/collaboration.ts:136-143`
with no collision detection. Tool names allow any non-control character
(`src/responses/namespace-tool-compat.ts` `isRepresentableName`), so
`{namespace:"a", name:"b.c"}` and `{namespace:"a.b", name:"c"}` both flatten to `a.b.c`;
the second silently overwrites the first, so a dotted provider echo can invoke the
wrong client tool. The undeclared-tool guard collapses both identities into one set
entry at `src/server/responses-undeclared-tool-guard.ts:98`. This sits on the
client-tool authorization boundary, so it is treated as a real blocker.

Disposition: keep #3403 open in wp2 and hand it to wp3 as a NAMED work item
(wp3 item "#3403 collision repair"). `maintainerCanModify` is true on
`ianlyoo:fix-dotted-tool-alias`, so wp3 pushes the collision fix onto the author's
branch, preserving @ianlyoo as PR author; if that push is refused, wp3 opens a
successor branch whose commit carries `Co-authored-by: Youngin (Ian) Lyoo`.
wp3 owns driving it to MERGED or CLOSED — a posted review alone does not discharge it.

## Merge order

`src/adapters/openai-responses.ts` is touched by both #3420 and #3405, in distant
hunks (~906-1141 vs ~1966-2008). Merge #3430 first (smallest, isolated), then #3420,
then #3405, refreshing between each so the second lands on the first's result.
Order: 3430 -> 3401 -> 3420 -> 3405.

## Accept criteria

- each merged PR reports `state=MERGED` with a `mergedAt` and a dev merge sha
- linked issues #3428, #3400, #3378 are CLOSED after their merge lands
- no local full-suite run; `gh pr checks` is the recorded evidence
- #3403 carries a posted review naming the collision with file:line
- #3403 is explicitly handed to wp3 as a named item, not left unowned

## Manual issue closing (audit residual)

`gh pr view --json closingIssuesReferences` returns EMPTY for all five PRs even though
the bodies contain `Closes #N`: GitHub only auto-closes when the PR merges into the
default branch (`main`), and these target `dev`. Every linked issue must therefore be
closed manually after its merge lands, quoting the dev merge sha.

## Merge mechanics (wp2 P-phase stale check, re-verified against the live repo)

Re-verified before executing: all four of #3430, #3401, #3420, #3405 report
`mergeable=MERGEABLE` with zero non-success checks. `mergeStateStatus=BLOCKED` is not a
CI failure — the `Protect dev` ruleset requires one approving review, and every PR sits
at `REVIEW_REQUIRED`.

Ruleset (`gh api repos/lidge-jun/opencodex/rules/branches/dev`):
`required_approving_review_count: 1`, `require_code_owner_review: true`,
`require_extra_approval_for_unattributed_changes: true`,
`allowed_merge_methods: ["merge", "squash"]` — rebase merges are off, so squash it is.

How the review requirement is satisfied: these are contributor PRs, so the maintainer
reviews and approves them normally. MAINTAINERS.md line 172 notes that the admin role
also holds a `pull_request` bypass, but a bypass is not the right instrument here —
"Authors do not approve their own pull requests" still governs, and the file requires
that any bypass use be RECORDED on the PR rather than inferred from a merge timestamp.
Since the maintainer is not the author of any of these four, an ordinary approving review
is both available and more honest, and it leaves the reasoning visible on the PR.
CODEOWNERS puts `@lidge-jun` on `/src/adapters/`, `/src/providers/`, `/src/codex/`,
`/src/server/`, and `/.github/`, so the same review satisfies code-owner sign-off.

Each approval carries the substantive finding from the independent review lane, so the
merge record shows what was checked — including the two MERGE-WITH-NOTE items (#3405's
claimed-baseline suite failures, #3401's partial launcher coverage).
