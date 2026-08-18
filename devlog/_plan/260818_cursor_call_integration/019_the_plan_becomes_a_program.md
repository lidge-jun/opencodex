# 019 — The plan becomes a program

Fifteen audit rounds. Six of them (`r7`, `r8`, `r10`, `r12`, `r13`, `r14`, `r15`)
found the same defect class at different altitudes: a binding written as prose that
no shell would enforce. Each round I fixed the instances it named, and the next round
found new ones — `VERIFIED_BASE` captured twice, `git branch cursor-call-wire
<PR1_TIP>` failing `zsh -n`, three contradictory merge ladders, `<pr3>` that zsh
reads as a redirection, `PR1_TIP` consumed at line 88 and assigned at line 94, PR
numbers referenced but never assigned anywhere.

Seven rounds of the same failure is not seven mistakes. It is one wrong idea:
**I was trying to make a document behave like a program.**

A markdown file cannot enforce that a variable is assigned before it is read. It
cannot fail. Every fix I wrote was a promise that the next reader would execute the
fragments in the right order with the right values in scope — and every audit proved
that promise false, because the promise is unenforceable by construction.

## What changed

`cursor-call-integration.zsh` in this directory is now the executable form of
`010`/`020`/`030`/`040`/`050`. The decade docs keep their job — the EVIDENCE and the
REASONING for each decision, which is what a reviewer needs and what a script cannot
carry. The script owns what runs.

Properties the prose could never have:

- **`set -euo pipefail`** — an unset variable is a hard error, not a silent empty
  string. The entire class of finding that consumed seven rounds is now impossible.
- **State on disk** (`.tmp/cursor-call-integration.env`, gitignored). Each step reads
  what earlier steps recorded, so a compaction or a disconnect costs nothing, and
  `need VERIFIED_TIP` fails loudly instead of proceeding with an empty value.
- **Every assertion is a `test` or an `||die`.** There is no printed value for an
  operator to eyeball.
- **Idempotent steps** — `git branch -f`, `worktree add ... || true`, and
  `EXPECTED_DEV` re-derived from state on each run.
- **Nothing merges or pushes implicitly.** The operator names the step.

## Verified, not asserted

    zsh -n cursor-call-integration.zsh          -> PARSE_OK
    zsh cursor-call-integration.zsh state       -> "no state yet"
    zsh cursor-call-integration.zsh pin         -> recorded VERIFIED_BASE=1645bb924…
    zsh cursor-call-integration.zsh state       -> the value persisted
    zsh cursor-call-integration.zsh cut         -> FATAL: VERIFIED_TIP is not set (exit 1)
    zsh cursor-call-integration.zsh merge       -> FATAL: VERIFIED_TIP is not set (exit 1)
    zsh cursor-call-integration.zsh release_gates -> FATAL: MERGED_DEV is not set (exit 1)
    zsh cursor-call-integration.zsh record_prs 1 2 -> FATAL: usage (exit 1)
    zsh cursor-call-integration.zsh bogus       -> FATAL: unknown step (exit 1)

Those failures are the point: the ordering the prose could only request, the script
enforces.

## Step map

| Step | Doc | What it does |
|------|-----|--------------|
| `pin` | `010` | `VERIFIED_BASE` from live `ls-remote`, recorded |
| `rebase` | `010` | rebase onto it, assert ancestry, refuse conflict markers |
| `push` | `010`/`015` | `--force-with-lease`, assert remote == local |
| `verify` | `020` | `VERIFIED_TIP`, lidge worktree at that SHA, five gates each re-asserting HEAD |
| `cut` | `030` | boundaries by subject, three ancestry assertions, count partition, push branches |
| `verify_layers` | `020`/`030` | push the two layer branches, then typecheck + that layer's own tests AT ITS OWN HEAD |
| `record_prs` | `030` | operator records the three PR numbers after `gh pr create` |
| `merge` | `040` | per layer: base==dev, head==expected, live dev==EXPECTED_DEV, then merge and advance from the merge commit |
| `release_gates` | `050` | `MERGED_DEV` worktree on lidge, five gates |
| `release_state` | `050` | live main/dev/tags/dist-tags/releases for the readiness note |
| `cleanup` | `020`/`050` | remove the verification worktrees both phases require removing |

## What round 15 found in the FIRST version of this script

Writing the program did not make the program correct — it made its defects findable.
The audit ran it and found seven, three of them fatal:

- **`LIDGE_HOME=~/Developer/opencodex` expanded LOCALLY.** zsh resolved `~` to
  `/Users/jun`, so every ssh command sent a macOS path to a Linux host. The remote
  gates could not have run at all. Now single-quoted `'$HOME/Developer/opencodex'`,
  expanded by the remote shell.
- **`merge` could not resume.** It restarted at PR1 every time, so a disconnect
  between `gh pr merge` and `save` would re-attempt a merged PR. `merge_layer` now
  reads the PR state first: `MERGED` adopts its merge commit and returns, `OPEN`
  proceeds, anything else is fatal.
- **Layers were never verified at their own heads**, which `AGENTS.md:178-180`
  requires. `cut` pushed and moved on. That work is now `verify_layers`, and
  `merge` refuses without `LAYERS_GREEN_AT`.

And four smaller ones: `|| true` on worktree creation swallowed real failures and
accepted a dirty tree at the right HEAD; neither worktree was ever removed; the
conflict scan missed a lone `=======`; `push`/`verify` did not require
`VERIFIED_BASE`; re-running `pin` silently invalidated every downstream artifact;
and the state file was `source`d without validating what went into it.

Three more I found by running it myself: `save` appended instead of replacing,
`ROOT` counted `..` wrong and wrote state to `devlog/.tmp/`, and two steps never
called `load_state`.

Ten defects in a 200-line script, none of which fifteen rounds of reading prose had
surfaced. That is the case for the rewrite, and also the case for not trusting the
rewrite until it has been run.

## And round 16 found eight more, one of which bricked the whole thing

The fixes for round 15 introduced a fatal bug and left four holes:

- **The value validator rejected EVERYTHING.** `[[ "$v" == [A-Za-z0-9._/-]## ]]`
  needs `EXTENDED_GLOB`, which `set -euo pipefail` does not enable. Every `save`
  died, so `pin` could not record a base and nothing downstream could run at all.
  The security fix had bricked the script, and `zsh -n` cannot see it because the
  syntax is valid — only running it shows the match failing.
- **`LAYERS_GREEN_AT` was a presence check.** It stored `PR2_HEAD` and `merge`
  only asked whether it was non-empty, so verifying old layers then re-cutting new
  ones inherited the marker. It now stores `${PR1_HEAD}+${PR2_HEAD}` and `merge`
  compares it against the current heads.
- **`--repin` invalidated nothing.** The guard refused a silent re-pin, but the
  override rewrote `VERIFIED_BASE` and left every downstream artifact looking valid.
  It now clears them all, which is what makes the guard meaningful.
- **The MERGED resume path adopted a merge unchecked.** A PR merged by anyone, from
  any head, into any base, would have been accepted as campaign output. It now
  asserts base, head, and that the merge commit contains the verified head.
- **PR3's merge not being on `dev` was a log line.** Now fatal — the release gates
  would otherwise run on a commit that never landed.
- **`cleanup` could not clean a failed run.** The worktree paths were saved only
  after all gates passed, so the failure case left them unreachable. Saved on
  creation now.
- **`release_state` did not require the release gates**, so a readiness note could
  be prepared before anything verified the merged tree.
- **`rebase` restarted instead of continuing.** `010` expects two conflicts; a
  re-run mid-rebase would have discarded the resolution. It now detects
  `rebase-merge`/`rebase-apply` and continues.

Plus one of my own: the driver never passed `$@` to `step_pin`, so `--repin` could
not reach the guard it was written for.

Verified after the fixes: `pin` records, `record_prs` stores three numbers, the
re-pin guard refuses, and `pin --repin` clears every downstream key.

## Round 16's second pass: seven more, and a rule about save ordering

- **A MERGED layer did not prove its predecessor.** It checked base, head, and that
  the merge contained the verified head — but not that it was merged ONTO the
  `EXPECTED_DEV` this campaign produced. A merge made after an unrelated commit
  landed on `dev` would have been adopted as the next layer. Now the merge commit's
  first parent must equal `EXPECTED_DEV`.
- **`MERGED_DEV` was saved BEFORE its proofs.** A disconnect or a failing ancestry
  assertion left a durable key that `release_gates` trusts on the next invocation —
  reopening the exact bypass the proof existed to close. It is now the last thing
  `merge` does.

  The general rule this produces: **a durable key is a CLAIM that its proofs passed,
  so it is written after them, never before.** That is now true of every `save` in
  the file except the worktree paths, which are deliberately the opposite — they are
  cleanup handles, so they must exist BEFORE the thing that might fail.
- **`--repin` orphaned the remote worktrees.** It cleared `CC_WORKTREE` and
  `DEV_WORKTREE` without removing them first, so `cleanup` lost its only handle. It
  now removes them before forgetting them.
- **A failed per-layer gate left an untracked worktree.** `LAYER_WORKTREE` is
  recorded before the gates and cleared on success.
- **`subject_sha` could return two SHAs.** Two commits sharing a subject would have
  produced a two-line "SHA" that every later assertion compared against. It now
  fails unless exactly one matches.
- **Gate markers were not evidence.** `020` and `050` require the command, its
  output and the SHA. Every gate now appends a receipt to
  `.tmp/cursor-call-receipts.log`, including on failure, and the readiness note
  quotes from it.
- **`record_prs` recorded three unchecked numbers.** It now verifies each PR points
  at its layer head and carries all three template sections. The body's SUBSTANCE
  stays the agent's to write; its STRUCTURE is checkable, so it is checked.

Round 16 also drew the line the script should not cross: creating the PRs and
authoring their descriptions, the `docs-site/` determination, the readiness note's
judgment, and semantic conflict resolution are all work that requires understanding
what the change means. The script validates those afterwards rather than inventing
them.

`record_prs` is deliberately manual: PR numbers do not exist until `gh pr create`
returns them, and inventing a way to guess them would reintroduce exactly the
unbound-value problem this file exists to end.

## What the docs still own

The script says what runs. It does not say why dev's error-event EOF shape beat ours,
why WP2b must use `partialUsageFromEventState` rather than `resolvedTurnUsage`, why
the stack splits where it does, or why the merge is an owner-authorized exception
rather than policy compliance. Those live in `010`, `015`, `030` and `040`, and a
reviewer needs them more than they need the commands.
