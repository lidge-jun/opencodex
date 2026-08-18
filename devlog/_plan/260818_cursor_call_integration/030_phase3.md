# 030 — WP4: the stacked pull requests against dev

> **EXECUTION AUTHORITY: `cursor-call-integration.zsh cut | record_prs`.**
> The commands below are the reasoning, not the runbook. Seven audit rounds proved a
> markdown file cannot enforce that a variable is bound before it is read (`019`), so
> the script owns what runs and this doc owns why. If they disagree the script is
> right and this doc is stale — fix the doc.

Five versions. `r1` F4 killed a fabricated split; `r3` F3 found phase boundaries;
`r4` F2 killed the commit-range version for "ownership impurity"; `r5` killed the
ownership version's procedure; `r6` killed the forward-construction version on
ancestry, overbroad pathspecs, and WP2b landing in the wrong layer.

Four consecutive failures on the same question is the signal to re-examine the
question, not to patch the fifth answer (LOOP-REPAIR-01).

## The mistake was mine, and it was a category error

I was requiring the stack layers to be **subsystem-pure** — each layer touching only
its own files. That came from `r4` F2's observation that the top commit range also
edits PR1-owned files, which I read as a defect in the split.

It is not a defect. **A stacked PR does not promise subsystem purity. It promises
reviewable increments in dependency order.** Every mechanism I then invented to
achieve purity — cherry-pick, `rebase -i` split, forward tree copy — broke a
different git invariant, because purity requires moving content between commits and
the history is already final.

The natural stack is the rebased history itself, cut at existing commits.

## The stack

After the WP2 rebase, `VERIFIED_BASE..cursor-call` is one linear history. Cut it:

| PR | Head branch | Base | Range | Content |
|----|-------------|------|-------|---------|
| 1 | `cursor-call-wire` | `VERIFIED_BASE` | `VERIFIED_BASE..PR1_TIP` | Decode research docs + Cursor wire hardening: the EOF resolution (`emittedTerminal`), tool-result image encoder, and their tests |
| 2 | `cursor-call-cancel` | `cursor-call-wire` | `PR1_TIP..PR2_TIP` | Unexpected server-side CANCEL provenance (reads PR1's `emittedTerminal`) |
| 3 | `cursor-call` | `cursor-call-cancel` | `PR2_TIP..cursor-call` | Bridge/adapter terminal semantics, WP2b, the integration unit, and the late honesty corrections to PR1's files |

`PR1_TIP` = the rebased commit whose subject is
`docs(devlog): record what shipped for 010 and 020, and why 030 did not`.
`PR2_TIP` = the rebased `docs(devlog): record what shipped for 040`.
Both subjects are unique in the range — verified in `r5`:
`git log --format='%s' VERIFIED_BASE..cursor-call | sort | uniq -d` returns nothing.

Every property the previous four versions fought for is now free:

- **Ancestry** is automatic — all three branches are commits on one linear history,
  so `cursor-call-wire` is an ancestor of `cursor-call-cancel` is an ancestor of
  `cursor-call`. This was `r6`'s finding 1.
- **Union = the branch** is automatic — the three ranges partition the history
  exactly. This was `r4` F2, `r5` F2, and `r6` F4.
- **No commit ever moves**, so nothing can be dropped or duplicated.

## What PR3 legitimately contains, stated up front

PR3's range includes three kinds of change a reviewer should expect:

1. Bridge/adapter terminal work — its main subject.
2. **WP2b** (the EOF truncation error's partial usage). It edits
   `protobuf-events.ts`, which PR1's EOF resolution selects, so a reader might expect
   it in PR1. It is in PR3 because that is where it lands chronologically, and PR1 is
   not *wrong* without it — PR1 makes truncation reportable, PR3 makes it report
   tokens. That is a normal stacked increment. `tests/cursor-interaction-query.test.ts`
   (WP2b's contract test) is therefore also PR3's, which resolves `r4` F4 the other
   way: both move together.
3. **Late corrections to PR1-owned files** — `2ea12062d`'s comment fixes in
   `request-builder.ts` and two cursor tests, and `be1b881ec`'s two decode docs. These
   are the honesty corrections from audits `r1`/`r2`. Say so in PR3's body rather
   than letting a reviewer wonder why a bridge PR touches a cursor comment.

## Procedure

Run after the WP2 rebase and WP2b are on `cursor-call`. Nothing here rewrites
anything.

0. **Bind to the verified tree (audit `r10`).** `cursor-call` is mutable and `020`
   verified one specific SHA:

       test "$(git rev-parse cursor-call)" = "$VERIFIED_TIP"

   If it fails, the branch moved after verification and the gates no longer describe
   what is about to be reviewed. Re-run `020` rather than cutting branches from an
   unverified tree.

1. Find the boundaries in the REBASED history (the rebase preserves order, and the
   original SHAs no longer exist):

       git log --format='%h %s' "$VERIFIED_BASE"..cursor-call

   Read `PR1_TIP` and `PR2_TIP` off that list by subject, then confirm each:

       git show --stat "$PR1_TIP"   # must be the 010/020 shipped-record doc commit
       git show --stat "$PR2_TIP"   # must be the 040 shipped-record doc commit

   Bind them to variables rather than reading them by eye, so step 5's assertions
   have something to compare against:

       PR1_TIP=$(git log --format='%H %s' "$VERIFIED_BASE"..cursor-call | grep -F 'record what shipped for 010 and 020' | cut -d' ' -f1)
       PR2_TIP=$(git log --format='%H %s' "$VERIFIED_BASE"..cursor-call | grep -F 'record what shipped for 040' | cut -d' ' -f1)
       test -n "$PR1_TIP" && test -n "$PR2_TIP"

2. Create the branches at those commits, consuming the captured variables (audit
   `r14`: the angle-bracket form is not shell syntax and fails `zsh -n`):

       git branch cursor-call-wire   "$PR1_TIP"
       git branch cursor-call-cancel "$PR2_TIP"

3. Prove the stack mechanically — all three ancestry assertions plus the count
   identity must pass:

       git merge-base --is-ancestor "$VERIFIED_BASE" cursor-call-wire   # exit 0
       git merge-base --is-ancestor cursor-call-wire cursor-call-cancel   # exit 0
       git merge-base --is-ancestor cursor-call-cancel cursor-call        # exit 0
       git rev-list --count "$VERIFIED_BASE"..cursor-call-wire
       git rev-list --count cursor-call-wire..cursor-call-cancel
       git rev-list --count cursor-call-cancel..cursor-call
       # the counts must sum to:
       git rev-list --count "$VERIFIED_BASE"..cursor-call

   The FIRST assertion is not redundant (audit `r8`): `rev-list --count A..B` counts
   commits reachable from B and not A even when A is not an ancestor of B, so the
   three counts can sum correctly while the bottom of the stack does not actually sit
   on the verified base. Demonstrated: against `dev` at `1645bb924`,
   `git merge-base --is-ancestor 1645bb924 dfb6fb884` exits 1 while the counts still
   add up. Only the ancestry chain `VERIFIED_BASE → wire → cancel → tip`, together
   with the counts, establishes the partition.

4. **Record each PR's expected head SHA as real variables.** `040` asserts these
   immediately before merging. Written as executable assignments, not a legend — a
   probe of the earlier prose form exited 127 under zsh because `NAME = value` runs
   `NAME` as a command (audit `r13`):

       PR1_HEAD=$(git rev-parse cursor-call-wire)
       PR2_HEAD=$(git rev-parse cursor-call-cancel)
       PR3_HEAD=$(git rev-parse cursor-call)

   Then assert they are the SHAs step 1 identified and step 0 pinned, which is what
   binds the branch tips to the verified tree (the ancestry and count checks above
   prove topology, not identity):

       test "$PR1_HEAD" = "$PR1_TIP"
       test "$PR2_HEAD" = "$PR2_TIP"
       test "$PR3_HEAD" = "$VERIFIED_TIP"

5. **Run each layer's gates before opening its PR (audit `r12`).** The layer branches
   only exist from step 2 onward, which is why `020`'s per-layer section runs HERE
   rather than earlier: one lidge worktree pinned to each layer head, per the
   procedure in `020`. A PR body must cite a run at ITS OWN head — the stack-tip run
   belongs to PR3 alone, because PR1's tests passing at the stack tip prove nothing
   about a tree that excludes PR2 and PR3.

6. Push the two new branches and open the PRs bottom-up, each citing its own run.

## Policy constraints (`AGENTS.md`)

- `dev` is the only integration target. Never `main`.
- Stacked children targeting an OPEN parent's head branch are intentional;
  `enforce-target` skips the wrong-base gate for them (`AGENTS.md:218-225`).
  Retarget each child to `dev` after its parent lands.
- `.github/PULL_REQUEST_TEMPLATE.md` requires **Summary**, **Verification**,
  **Checklist**; `enforce-target` rejects thin descriptions.
- Each layer carries its OWN verification evidence (`AGENTS.md:178-180`), per `020`.

## Description content

- **Summary** — the defect and the wire behavior before/after for that layer. Three
  mandatory honest notes: (a) in PR1, that dev independently fixed the clean-EOF
  defect and our surviving contribution is `emittedTerminal` plus one guard;
  (b) wherever tool-result images appear, that the ENCODER supports them and nothing
  reaches Cursor today because all Cursor models are in `noVisionModels`; (c) in PR3,
  that its range also carries WP2b and the late corrections to PR1-owned files, and
  why.
- **Verification** — that layer's own commands, output, and SHA.
- **Checklist** — three boxes, honestly, `docs-site/` determination made here.
- No `Closes #`.

## Verification (C)

```
gh pr list --state open --json number,baseRefName,headRefName,title
gh pr view <n> --json body
```

PR1 base `dev`; PR2 base `cursor-call-wire`; PR3 base `cursor-call-cancel`; step 3's
ancestry chain and count identity recorded; all three template sections non-thin in
each.

## Fallback

If step 3 fails — which would mean the rebase did not preserve order as expected —
open ONE PR from `cursor-call` to `dev` and say why in the body. Do not invent a
sixth splitting scheme.
