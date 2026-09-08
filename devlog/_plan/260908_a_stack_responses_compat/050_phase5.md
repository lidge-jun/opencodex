# 050 — Phase 5: publish, single CI run, merge, settle

## Publication

Push all four branches with `--no-verify`, in chain order:

```
git push --no-verify origin codex/a-stack-l1-muse-free
git push --no-verify origin codex/a-stack-l2-spark-lite
git push --no-verify origin codex/a-stack-l3-claude-strict
git push --no-verify origin codex/a-stack-l4-routed-agentmsg
```

Pushing l1-l3 starts no workflow: `.github/workflows/ci.yml` limits its `push`
trigger to `[main, preview, dev]`, and no pull request points at those refs.

## The single pull request

Open exactly one pull request: `codex/a-stack-l4-routed-agentmsg` -> `dev`. Its
head contains all four layers, so the one Cross-platform CI run it starts is
cumulative evidence for the whole stack. The description follows
`.github/PULL_REQUEST_TEMPLATE.md` (Summary, Verification, Checklist), states that
local suites were NOT RUN by maintainer instruction with CI as the verification
gate, and names every carried pull request and issue.

Author preservation: each carried commit keeps its original author through a
`Co-authored-by` trailer that survives a squash, satisfying
`missing_coauthor_credit` in `.github/scripts/pr-carry-attribution.cjs`:

- `Co-authored-by: MohamadSabree8 <mohamadsabree8@users.noreply.github.com>`
- `Co-authored-by: R <53855466+cb8010d6@users.noreply.github.com>`
- `Co-authored-by: mashfromband <matsumoto.yukuhashi@gmail.com>`

## Merge gate

Merge only when the tip's Cross-platform CI is green on the exact head SHA of the
pull request. Skipped, cancelled or queued jobs are not passing evidence, and a
green run on an earlier head does not certify a newer one. After merging, fetch
`origin/dev` and prove landing in the way the chosen merge method allows.

The method decides the proof, and only one of the three preserves the tip SHA:

- **Create a merge commit.** The tip SHA itself becomes reachable from `dev`, so
  `git merge-base --is-ancestor <tip-sha> origin/dev` exits 0 and is sufficient.
- **Squash and merge.** GitHub writes one new commit, so the tip SHA never becomes
  an ancestor and that check would fail on a successful merge.
- **Rebase and merge.** GitHub replays the commits onto `dev` with new SHAs, so the
  original tip SHA is likewise not an ancestor.

For the two rewriting methods, identify the landed commit or commits on `dev`
first, then prove landing by content and attribution rather than by the original
SHA:

- `git diff <tip-sha> origin/dev -- <every path the stack touched>` is empty;
- `git merge-base --is-ancestor <landed-sha> origin/dev` exits 0 for the landed
  commit;
- the landed record carries all three `Co-authored-by` trailers.

Record the method used together with its matching proof, rather than asserting
ancestry of the original tip generically.

## Settlement

Once the change is confirmed on `dev`:

- PRs #3906, #3886 and #3917 — comment that the work landed on `dev` through the
  stack tip, name the merge commit, and close them. Their authors are already
  preserved in the trailers.
- Issues #3885 (Spark `adapter_eof`), #3922 (Claude tool strict) and #3911
  (routed `agent_message` 422) — close, since PRs target `dev` and GitHub only
  auto-closes on merges into the default branch.
- PR #3838 stays open; its residual work is unrelated to this stack.

## Verification (C)

The tip CI run identified by its run id and head SHA, with every required job
reporting success, plus the merge-method-specific landing proof above against a
freshly fetched `origin/dev`. Local suites: NOT RUN by maintainer instruction.


## Merge readiness is broader than one workflow (audit finding 7)

The single tip CI run is the verification evidence this session produces, but it is
not by itself the whole merge gate. `MAINTAINERS.md:57-69` also requires the
applicable required checks, resolution of outstanding maintainer objections, and
applicable security review. The `dev`-only maintainer-integration path still
records the decision and the exact-head evidence. Anything in that set that this
session cannot satisfy is reported rather than assumed.

## Attribution is added, not inherited

The three carried commits do **not** already contain `Co-authored-by` trailers in
their original messages. The trailers listed above are added when the commits are
carried onto the stack, and their presence is verified on the final squash-surviving
record before the children are closed.
