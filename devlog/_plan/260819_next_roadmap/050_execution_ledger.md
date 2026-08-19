# 050 — Execution ledger

Append-only record of what each work-phase actually did, with the evidence that
establishes it. A claim without an entry here did not happen.

Loop: HOTL, session `01a01949`, goalplan
`drain-the-opencodex-pr-queue-in-reviewable-order`.

## Standing constraints

- **One merge lane only.** `#2084` then `#2089`. Every other PR in this loop is
  review, rebase, or retarget.
- **Force-push is limited to branches we own** (`codex/split-*`,
  `codex/tmp-reclaim-*`). Contributor fork heads are never rewritten; their
  bases are retargeted with `gh` instead.
- **R5 (the split program proper) is out of scope.** WP1/WP1b/WP2a get rebased
  so they stop rotting; no split train starts.

## wp0 — docs-first roadmap cycle

Outcome: **DONE.**

| Item | Evidence |
|---|---|
| Decade docs written | `000_roadmap.md`, `010`, `020`, `030`, `040` |
| Committed | `015f119d5` |
| Audit corrections | `f94cbda63` |
| Audit lane | sol-medium read-only agent `01a01963` |

### What the audit changed

Six load-bearing claims were sent to an independent lane. Four came back
CONFIRMED; two came back PARTIAL, and both PARTIALs were real errors in the
first draft, not quibbles.

**010 had the stale-base mechanism backwards.** The first draft said CI ran
"dev's newer test against the PR's older source." Run `32130164359` shows the
opposite: the *test* held the old two-argument assertion and the *source* held
the new three-argument call from `91979cf14`. `6c0bde453` fixed the assertion
afterwards. The conclusion (merge skew, not a defect) survived; the stated
mechanism did not. The draft also undercounted the failing legs — six, not
four — and called `#2023` "fully green" when `hygiene` and `enforce-target`
fail on it.

**030 overstated how reachable `#2062`'s fail-open is.** `#2056` adds
`shortPercent` to `hasKnownQuotaValue`, so short-only snapshots enter the valid
cache; `#2062` does not, so its short-only parses return `null` and the
fail-open needs disk hydration or direct cache insertion to reach. Narrower,
not absent. The audit also found a `#2062`-only defect the draft missed: a
later partial snapshot drops the preserved short tuple.

**One risk nobody had flagged:** `#2102`'s sanitizer is called outside the
`if (forward)` branch, so the chosen `prompt_cache_retention` fix also strips
the field from API-key and third-party `openai-responses` passthroughs. That is
defensible for genuine OpenAI endpoints and untested for custom ones.

The lesson worth carrying: the draft's *conclusions* held up, and its
*explanations* did not. An explanation that survives because its conclusion is
right is still wrong, and it is exactly the kind of wrong that gets copied
forward into the next document.

## wp1 — R2 merge temp-reclaim stack

Outcome: **DONE.** Both PRs merged after three confirmed review findings were
fixed.

| Step | Evidence |
|---|---|
| #2084 merged | `973258488`, ancestor of `origin/dev` |
| #2089 retargeted to `dev` | diff became the 9 phase-2 files only |
| #2089 merged | `c4bf833c9`, ancestor of `origin/dev` |
| Checks at merge | zero FAILURE, zero PENDING on both exact heads |
| Post-merge CI | runs `32241217016` and `32241261180` on the merge SHAs |
| Branches deleted | both, after the retarget (never before) |

A pre-merge review lane (sol-medium, agent `01a0196e`) returned
**DO-NOT-MERGE** on the original heads. Three of its findings were confirmed
against the code and fixed; the blocking one was adjudicated down and is
recorded here rather than silently dropped.

### Fixed on `codex/tmp-reclaim-1-sweeper` (`1fbac66f8`)

**Directory handle leak on every truncated scan.** `list` is a generator that
closes its handle in a `finally`, but the consumer drove it with manual
`iterator.next()` calls and left the loop with `break`. A `finally` does not
run when a consumer simply stops calling `next()` — only `return()` resumes the
generator to completion. The periodic reclaim truncates *by design* (entry cap,
cleanup cap, 25 ms deadline), so this leaked one handle per truncated tick,
every minute, on exactly the slow filesystems the deadline exists for.
Every early exit now routes through a `stopScan()` that calls
`iterator.return()`.

**The deadline test was vacuous.** Its fake clock started at `0` while the
fixtures carried real epoch mtimes, so every computed age was negative and the
files survived the 15-minute grace whether or not a deadline check existed —
the test passed against its own ablation. The clock is now anchored to real
time and the test carries an explicit unbounded-run assertion, so the deadline
is the only reason nothing is removed.

Both fixes were **driven red**: reverting `stopScan()` fails the new closure
test and nothing else; deleting the deadline check fails the repaired deadline
test and nothing else.

### Fixed on `codex/tmp-reclaim-2-doctor` (`e298cf8ea`)

**The budget warning could never print.** It keyed on
`eligible > removed + failed`, but outside a dry run an entry is counted
eligible and then unlinked or failed on the same iteration, so those two are
always equal. An operator whose backlog exceeded the 4096-file budget was told
the reclaim had finished. The scan now carries an explicit `truncated` flag,
set wherever the loop stops on a budget rather than on the end of the
directory, OR-ed across swept directories. The dry-run report is bounded by the
entry cap too, so a truncated report now says its count is a floor.

The partial-reclaim test asserted a state production cannot reach
(`eligible: 816, removed: 512`); it now uses a reachable one and is paired
with an ablation guard. Driven red: restoring the old comparison fails it.

Verification: 174 pass / 0 fail across `doctor`, `responses-state`, and
`state-store-sweeper`; `tsc --noEmit` clean.

### Adjudicated, not fixed

**The reviewer's stated blocker — the boot floor can unlink a live writer's
temp — is real but narrower than "blocking".** When `predatesBoot` is true the
liveness probe is genuinely skipped. But reaching it requires a writer that has
been stalled past the 15-minute grace *and* whose temp mtime predates this
machine's boot. On a single host that is self-contradictory: a process running
now cannot have written before the boot it is running after. The scenario needs
a config dir shared across hosts or containers — which the code comment already
names as the case where the computed boot can be wrong.

Left as-is deliberately: the alternative is to gate the floor on
single-host ownership, which needs a durable host identity we do not have. The
comment documents the limit honestly. Revisit if shared-config-dir deployments
become supported rather than incidental.

**Two smaller findings deferred with reasons.** (a) An aliased config dir
(literal and resolved paths pointing at one directory through a symlink) makes
the `Set` hold two strings for one directory, so a dry run double-counts.
Cosmetic, and the fix is a `realpath` dedupe worth doing with a test that can
build the alias. (b) `resolveWriteTarget` follows a snapshot symlink out of the
config dir, so scanning follows it too. That is the intended dotfiles-managed
behavior; containment would be a separate design decision, not a fix.

## wp4 — R4 modelRecordValue batch review

Outcome: **DONE (review only, no merges).** Lane: sol-medium agent `01a01979`.

The review did not merely confirm the batch premise — it **refuted the shared
contract as originally written**, which is the whole reason this lane was worth
running. The draft implied every per-model map should migrate to
`modelRecordValue`. Two maps (`modelPreferHostedTools`,
`modelOpenRouterRouting`) are deliberately exact-own-only, so migrating them
adds family and case-folded inheritance the adapter will not honor. The
invariant is "read it the way the runtime reads *that map*"; `modelRecordValue`
is only its implementation for the family-aware set.

Verdicts: `#2085` merge, `#2086` merge, `#2100` hold (missing
`noVisionModels` precedence lets routing pick a candidate for image work that
execution rejects), `#2077` hold (over-broad migration reaches
`modelPreferHostedTools`; `modelOpenRouterRouting` still read raw).

Full reasoning in `040_r4_modelrecordvalue_batch.md`.

Verdicts posted to the PRs:

| PR | Comment |
|---|---|
| #2077 | `5340642374` |
| #2085 | `5340642645` |
| #2086 | `5340642926` |
| #2100 | `5340637836` |

A first attempt at the #2100 comment was posted through a shell argument and
the backticks in it were evaluated by zsh, stripping every code span. It was
deleted and reposted from a file. Worth remembering: PR bodies full of
identifiers go through `--body-file`, never `--body`.

## wp2 — R1 rebase split stack

Outcome: **DONE — and the stale-base hypothesis is now measured, not assumed.**

| PR | Old head | New head | Rebase |
|---|---|---|---|
| #2019 WP1 | `194f9f2a9` | `35990f6ea` | clean, no conflicts |
| #2023 WP1b | `b2ac2500c` | `874598bd3` | **recut**, see below |
| #2036 WP2a | `7561e5551` | `6c6925a4d` | clean, no conflicts |

`#2019` and `#2036` rebased without a single conflict, which is itself
evidence for the stale-base reading: 102 and 42 commits of drift produced zero
textual disagreement.

### The claim 010 refused to assert, now proven

`010` deliberately said the stale-base diagnosis was the hypothesis the rebase
would *test*, not an established fact, because old CI on a sibling PR cannot
prove a rebased head is clean. The test has now run. On `#2019`'s rebased head
(run `32241365996`):

```
test 1/4  pass     test 2/4  pass
test 3/4  pass     test 4/4  pass
gates     pass     macos-launchd  pass
```

Every leg that was red before is green after, with **no source change** — the
same extraction, replayed onto current `dev`. Six failing legs to zero. The
extraction was never broken; the base was.

### WP1b was recut, not rebased — and that is the honest description

The rebase conflicted across the entire file. The reason is structural rather
than semantic: WP1b rewrites `types.ts` from 1884 lines into a 103-line barrel,
so *any* dev commit that adds a declaration to the old file collides with the
rewrite everywhere. Three conflict hunks spanning lines 1-3450 is what "the
file was replaced" looks like to a three-way merge.

Resolving hunk-by-hunk would have been guesswork. Instead the leaves were
re-applied onto the rebased parent and the actual dev delta was re-homed
deliberately. That delta was exactly three declarations:

| Declaration | Origin | New home |
|---|---|---|
| `OcxReasoningReplayIdentity.credentialDurableIdentity` | #2078 | `src/types/request.ts` |
| `CodexAccount.planSource` | dev | `src/types/accounts.ts` |
| `CodexAccount.planCredentialGeneration` | dev | `src/types/accounts.ts` |

Taking "ours" on that conflict would have silently dropped all three. Verified
after: `tsc --noEmit` clean, 150 tests pass, `types.ts` at 103 lines.

### CI proof on the new heads

| PR | New head | Cross-platform CI |
|---|---|---|
| #2019 | `35990f6ea` | run `32241365996` **success** |
| #2023 | `874598bd3` | run `32241478125` **success** |
| #2036 | `6c6925a4d` | run `32241513290` **success** |

On `#2019` the six legs that were red before the rebase — `test 1/4` through
`test 4/4`, `gates`, and `macos` — all pass on the new head with no source
change other than the rebase. 010 called stale base the hypothesis this rebase
would test rather than an established fact; it held.

The mechanism is confirmed at the line level: on `35990f6ea` the assertion at
`tests/codex-app-server-processes.test.ts:393` and the call at
`src/cli/dispatch.ts:246` now both carry the three-argument
`invalidateCodexModelsCacheWithPermit(permit, owningCodexHome, { allowWhenDesiredDisabled: true })`
form. They disagreed only because CI merged an old head against a newer base.

### Independent check for silent loss

"Exactly three fields" was a claim about a recut, not a guarantee, so a
separate lane (`01a01988`) compared every exported name and every interface
field between `origin/dev` and the new head:

```
EXPORT_COUNTS dev=85 leaf_declarations=85 barrel_reexports=85
DEV_MISSING_FROM_LEAVES (none)   DEV_MISSING_FROM_BARREL (none)
ALL_INTERFACE_COUNTS dev=53 head=53
ALL_MISSING_FIELDS 0   ALL_EXTRA_FIELDS 0
```

It confirmed the delta was exactly the three claimed fields, and that
`#2019`/`#2036` are patch-identical to their pre-rebase series by
`git range-diff`. Worth keeping for the rest of the split program: a
name-level audit alone would miss a dropped field inside a preserved
interface, which is the failure mode a barrel extraction actually risks.

### The hygiene gate still fails, correctly

All three still fail `hygiene: missing_regression_test` and `enforce-target`.
The first is right and is not fixed by rebasing: a pure-move PR changes `src/`
without changing a test. The honest resolution is `test-exception-approved` —
the oracle for a barrel extraction is the ~400 files that import through it
plus `tsc`, and a test asserting "the barrel re-exports `OcxTool`" restates
the compiler.

## wp3 — R3 collisions and retargets

Outcome: **DONE** (decisions recorded, retargets applied, no merges).

All eight wrong-branch PRs retargeted `main` -> `dev`: #2110, #2109, #2099,
#2082, #2063, #2062, #2032, #2029. Seven are `MERGEABLE` after the retarget;
#2063 is `CONFLICTING` and overlaps the already-merged #2055, so it needs an
author rebase and a rescope. No contributor head was rewritten — every one of
those heads lives in a fork.

`prompt_cache_retention` (#2092): **#2102 wins.** Comment posted there with
the reasoning and the one pre-merge request (its sanitizer sits outside the
`if (forward)` branch, so it also touches API-key and third-party passthroughs
and needs an API-key regression). #2091 and #2099 told why they were not
chosen rather than closed silently.

K12 (#2047): **neither #2056 nor #2062 merges.** Same root cause posted on
both, with the asymmetry named — #2062 is narrower on reachability, #2056 is
ahead on preservation, both carry the scoring fail-open.

### Final retarget state (verified at close)

| PR | Base | Mergeable |
|---|---|---|
| #2110 | `dev` | MERGEABLE |
| #2109 | `dev` | MERGEABLE |
| #2099 | `dev` | MERGEABLE |
| #2082 | `dev` | MERGEABLE |
| #2063 | `dev` | **CONFLICTING** |
| #2062 | `dev` | MERGEABLE |
| #2032 | `dev` | MERGEABLE |
| #2029 | `dev` | MERGEABLE |

All eight are drafts, which is the contributor-PR default and not a problem to
solve here. `#2063` is the one that needs its author: it conflicts and overlaps
`#2055`, which already merged as a partial fix for the same issue, so it needs
a rescope rather than a mechanical rebase.

## Loop close

Terminal outcome: **DONE.** Five work-phases, ten criteria, all carrying
evidence.

One merge lane was authorized and one was used. Everything else in this loop
was review, rebase, or retarget — which is what the scope asked for, and worth
stating plainly because a queue-drain loop is exactly where scope creep would
be easiest to justify after the fact.

### What the review lanes actually bought

Three independent lanes ran. None of them merely agreed:

- The **roadmap audit** caught the stale-base mechanism stated backwards, an
  undercounted failure set, and a "fully green" claim that was not.
- The **pre-merge review** returned DO-NOT-MERGE and found a directory-handle
  leak on every truncated scan, a budget warning that could never print, and a
  deadline test that passed against its own ablation. All three were confirmed
  in code and fixed before the merge.
- The **batch review** refuted the shared contract the batch was built on.

The pattern across all three: the *conclusions* in the first drafts held up and
the *explanations* did not. An explanation that survives because its conclusion
happens to be right is still wrong, and it is the kind of wrong that gets
copied into the next document unchallenged.
