# Audit rounds — synthesis and dispositions

## Round 1

Independent reviewer, read-only, 2026-08-03. Verdict: **FAIL**, 6 High + 2
Medium. Every blocker was re-verified locally before being accepted; none is
taken on the reviewer's word alone.

## Root cause across the blockers

Three of the six High findings (1, 2, 5) are the same mistake wearing different
clothes: **the plan reasoned about each job in isolation and not about the
dependency graph the jobs form.** A gate that lists three `needs:` while five
jobs exist, a filter job with no permission to filter, a required check on a
path-filtered workflow — each is locally sensible and globally wrong.

Blocker 3 has a different root cause and a worse one: an assumption stated as a
finding. "25 test files reference `gui/` but read source rather than importing
built artifacts" was written from a `rg` of import *paths* without running a
single one of those tests.

## Dispositions

| # | Sev | Finding | Disposition |
|---|---|---|---|
| 1 | High | Gate omits `changes`/`select-windows-runner`; skip-as-pass hides a failed producer | **ACCEPT** |
| 2 | High | `dorny/paths-filter` needs `pull-requests: read`; workflow grants only `contents: read` | **ACCEPT** |
| 3 | High | Dropping GUI install breaks shards — JSX tests need React | **ACCEPT** |
| 4 | High | Packaging filter omits `src/**` → src-only PRs get zero Windows signal | **ACCEPT** |
| 5 | High | PR-level `paths:` + required `ci` check = permanently pending docs-only PRs | **ACCEPT, deferred** |
| 6 | High | Windows `if:` as written also runs on `dev` pushes; `matrix` invalid in job `if:` | **ACCEPT** |
| 7 | Medium | `if: always()` parses as string, not boolean | **ACCEPT** |
| 8 | Medium | "once-only" claim false while platform legs duplicate gates; job count wrong | **ACCEPT** |

### Verified locally, not accepted on report

**Blocker 3** — ran the test rather than reading the import:

```
$ bun test tests/provider-workspace-rail.test.ts
error: Cannot find module 'react/jsx-dev-runtime' from
  gui/src/components/provider-workspace/ProviderRail.tsx
0 pass, 1 fail
```

`ProviderRail.tsx:52` is JSX (`return (<span className={cls}>`), React lives
only in `gui/package.json`, and `gui/node_modules` is absent in a fresh
checkout. The shard job must keep the GUI install. **The plan's own
verification step would have caught this only by luck** — "run one shard
locally" would have passed on shards not containing these files.

**Blocker 6** — ran actionlint on a minimal reproduction:

```
if: ${{ matrix.name != 'windows' }}
=> context "matrix" is not allowed here. available contexts are
   "github", "inputs", "needs", "vars".
```

Confirms Option A (split jobs) is the only workable shape, as `020` suspected
but had not proven.

**Blocker 7** — ran the parser:

```
$ bun -e 'console.log(JSON.stringify(Bun.YAML.parse("jobs:\n  ci:\n    if: always()\n")))'
{"jobs":{"ci":{"if":"always()"}}}
```

String, not boolean. The doc's pin was wrong.

### The one finding the reviewer cleared

I had flagged the gate's `grep '"result": "failure"'` as a possible silent
no-match if `toJSON` emitted compact JSON. The reviewer opened the GitHub
expressions documentation: `toJSON` "Returns a pretty-print JSON
representation", and the official `needs` example shows `"result": "failure"`
with that exact spacing. The concern was unfounded.

It is still being changed. Depending on the whitespace of a pretty-printer for
whether CI can fail is a correct-by-coincidence design. The gate moves to `jq`,
which parses instead of pattern-matching — see below.

### Blocker 5, and why it is accepted but deferred

The reviewer is right that `on.pull_request.paths` and a *required* `ci` check
cannot coexist: a docs-only PR would never create the check and would hang
pending forever.

It is deferred rather than fixed here because the conflict is not live. `dev`
has no branch protection (`404 Branch not protected`), so nothing is required
today. Removing the pinned 14-entry path list is a separate decision with its
own blast radius — those pins exist because an audit round deleted entries one
at a time and nothing went red — and bundling it into a CI-speed change would
be exactly the drive-by scope expansion the repo's own guidance warns against.

What this unit does instead: **document the coupling at the point where it will
bite.** The PR description and `040` state that requiring `ci` in branch
protection must be accompanied by removing the workflow-level `paths:` filter,
or by moving the gate to an always-triggered workflow. Recorded as a known
follow-up, not silently left as a trap.

## Amendments applied

1. **`010`** — gate rewritten to `jq`-based result inspection with an explicit
   allowlist (`success`/`skipped` pass, everything else fails), `needs:` covers
   every producer, GUI install stays in the shard job, `if` pin corrected to
   the string form.
2. **`020`** — Option A (split jobs) confirmed as the only valid shape with
   actionlint evidence; Windows condition pinned to dispatch-or-main/preview
   rather than not-pull-request; platform steps enumerated explicitly instead
   of "unchanged"; the "eighth" arithmetic error corrected to "quarter".
3. **`030`** — `pull-requests: read` added to the `changes` job; packaging
   filter widened to every input that reaches the published tarball, so
   src-only PRs keep a Windows packaged-CLI signal.
4. **`000`** — job count corrected to seven; concurrency table added;
   blocker-5 coupling recorded.
5. **`040`** — maintainer security review added as an explicit gate
   (`MAINTAINERS.md`: GitHub Actions changes require it), alongside bot review.

## What this round says about the plan's method

The plan was strong on external evidence (Bun semantics, GitHub docs, measured
timings) and weak on *executing its own assumptions*. Blocker 3 was one `bun
test` away from being caught during planning. The lesson carried into the
implementation phases: **every claim of the form "this dependency is not
needed" gets run, not read.**

---

## Round 2

Same reviewer, re-audit of the amendments. Verdict: **FAIL**, 2 High + 4 Medium

2 Low. Round 1's blockers 2, 3, 4, 6, 7 confirmed closed; 5 confirmed
accurately deferred; 1 and 8 partially closed.

The reviewer also confirmed the `jq` gate is now correct, having probed it
against every documented `needs.*.result` value (`success`, `failure`,
`cancelled`, `skipped`, an unknown value, and malformed JSON) — the allowlist
rejects everything it should and `set -euo pipefail` catches a jq parse
failure. `jq 1.7` ships in the current `ubuntu-latest` image.

### Root cause: the phase boundary was fictional

Round 1 was about the dependency graph between jobs. Round 2 is about the
dependency between *commits*, and it is the more embarrassing finding.

Phase 1 said "Windows and macOS legs are untouched in this phase". Phase 1 also
replaced the `test` job. Those legs **are** `include:` entries of the `test`
job — so phase 1 as written deletes two platforms while asserting it does not.
The phase boundary described a state the workflow could never be in, and no
amount of care inside phase 2 could have fixed it.

This is the same failure shape as round 1's blocker 3: a claim about the
existing code written without checking the existing code. There it was "these
tests don't need React"; here it was "these legs are separate from that job".

### Dispositions

| # | Sev | Finding | Disposition |
|---|---|---|---|
| 1 | High | Phase 1 cannot preserve Windows/macOS as written | **ACCEPT** — phases 1 and 2 merged into one commit (`010` + `011`) |
| 2 | High | Phase 2/3 tell the implementer not to update `ci.needs`, which the derived pin rejects | **ACCEPT** — each phase now states its complete `needs` list explicitly |
| 3 | Med | `assets/**`, `README.md`, `LICENSE` in the packaging filter but not in the workflow's own paths | **ACCEPT** — outer path list widened in the same commit, with the pinned `ciPaths` array extended |
| 4 | Med | Windows steps still deferred to "same shape as macOS" | **ACCEPT** — enumerated, including the self-hosted wipe, with pins |
| 5 | Med | `000` says macOS "stops re-running the full suite", `011` says it runs it | **ACCEPT** — `000` corrected; macOS drops the repeated gates, not the suite |
| 6 | Med | Concurrency table sums rows instead of deriving peak from the graph | **ACCEPT** — split into jobs-per-run and peak-simultaneous |
| 7 | Low | Filter pin samples 4 of 10 patterns | **ACCEPT** — whole-list comparison |
| 8 | Low | Stale claims: "eighth", `failure`/`cancelled` wording, "every push" | **ACCEPT** — all three corrected |

### Renumbering

Merging the platform work into phase 1 makes the old `020` a sub-document of
phase 1, so the unit renumbers: `020_platform_legs.md` → `011_platform_legs.md`
(phase 1's second document), and the affected-scoping doc keeps `030` as phase
2. Decade ranges still map to phases; phase 1 simply owns two documents.

### What the two rounds together say

Both rounds found the same class of defect: **a confident statement about code
that had not been executed or read at the point of the claim.** The external
research was sound throughout — Bun's shard semantics, GitHub's skip behavior,
the runner limits all held up. What failed twice was local grounding.

That is worth recording because it is not what an audit is usually expected to
catch. The plan's weakest points were not its research; they were the sentences
that sounded too obvious to check.

---

## Round 3

Same reviewer. Verdict: **FAIL**, 1 High + 4 Medium + 1 Low. Round 2's blockers
1, 2, 7, 8 confirmed closed; the `ci.needs` progression was independently
modelled at both commit boundaries and passes.

### Dispositions

| # | Sev | Finding | Disposition |
|---|---|---|---|
| 1 | High | Duplicate `steps:` key in the enumerated Windows job — fails actionlint | **ACCEPT** |
| 2 | Med | `paths-filter` with no `base:` diffs a `dev` push against `main` | **ACCEPT** |
| 3 | Med | Concurrency table puts src-only PRs in the wrong row and understates graph peak | **ACCEPT** |
| 4 | Med | The macOS contradiction in `000` was never actually removed | **ACCEPT** |
| 5 | Med | `030` says the outer path list "stays exactly as it is", then grows it | **ACCEPT** |
| 6 | Low | Renumbering left stale phase references | **ACCEPT** |

### The two that matter

**Blocker 1 was mine, freshly introduced.** The round-2 amendment that
enumerated the Windows steps left the original `steps:` line in place above the
new one. It is a one-character-class error that makes the workflow invalid, and
it survived because I had linted *fragments* — a job condition here, a `needs:`
list there — rather than an assembled workflow.

Fixed, and the method fixed with it: the phase-1 verification list now requires
`actionlint` against the complete assembled workflow. Done, and it passes:

```
$ actionlint .github/workflows/ci.yml   # full proposed shape, all 8 jobs
ACTIONLINT CLEAN
```

**Blocker 2 is the one no amount of re-reading my own plan would have found.**
`dorny/paths-filter` defaults `base` to the repository's default branch:

```
$ gh api repos/lidge-jun/opencodex --jq .default_branch
main
```

So a push to `dev` would be diffed against `main`, and every area touched since
the last promotion would keep reading as "changed" until `main` caught up. The
GUI and packaging jobs would run on nearly every dev push, and the per-push
saving this phase exists to produce would silently not happen — while the
workflow stayed green and looked correct. `base: ${{ github.ref }}` fixes it,
and the input is pinned in the suite. (See round 4: this fix was claimed here
one round before it actually reached the plan.)

The action SHA was independently confirmed to be tag v3.0.2:

```
$ gh api repos/dorny/paths-filter/git/ref/tags/v3.0.2 --jq .object.sha
de90cc6fb38fc0963ad72b210f1f284cd68cea36
```

### Gate logic, verified directly

```
all success/skipped -> (empty)      => pass
one failure         -> b=failure    => fail
one cancelled       -> a=cancelled  => fail
unknown "neutral"   -> a=neutral    => fail
```

The allowlist rejects unknown result values rather than ignoring them, which is
the property a denylist would not have had.

### Three rounds, one pattern

Round 1: a claim about tests that had not been run. Round 2: a claim about job
structure that had not been read. Round 3: a claim about YAML validity that had
not been linted as a whole, and a third-party default that had not been looked
up.

Every single blocker across three rounds was a **local, checkable fact stated
without checking it** — never a research failure, never a design disagreement.
The design survived all three rounds essentially unchanged. What kept failing
was the gap between "this is obviously true" and "I ran the thing that proves
it".

---

## Round 4

Same reviewer. Verdict: **GO-WITH-FIXES (blockers=1)** — one Medium blocker
plus one non-blocking stale sentence. Round 3's items all confirmed closed,
including the assembled-workflow actionlint run, both `ci.needs` boundaries,
and the jq allowlist behavior.

### The blocker

**The `base:` fix existed only in this synthesis document, not in the plan it
described.** Round 3 recorded "`base: ${{ github.ref }}` fixes it, and the
input is now pinned in the suite" — but `030`'s `changes` job still had a bare
`with: filters:` and no test assertion. Implementing the plan verbatim would
have reproduced the exact sticky-diff bug round 3 had just identified.

Cause: the edit meant to add `base:` to `030` did not apply, and the synthesis
was written as though it had. The same thing had already happened once in this
unit — round 3's blocker 4 was a macOS correction I believed I had made and had
not.

Fixed: `base:` is in `030`'s job spec with the failure explained inline, and
the promised suite pin is written out. Verified by grep rather than by
recollection:

```
$ grep -n "base:" 030_affected_scoping.md
106:          base: ${{ github.ref }}
```

Also fixed: `040`'s stale "7 → 9-12" concurrency wording, now consistent with
`000`'s runner-count / maximum-antichain distinction.

### The lesson, sharpened

Rounds 1-3 shared a pattern: a claim about the code made without running the
code. Round 4 is narrower and worse — **a claim about my own edit, made without
re-reading the file.** A patch tool reporting success proves only that it
matched context lines somewhere, not that the intended change is where you
believe it is.

Standing rule adopted for the implementation phases: after any amendment a
later step depends on, grep for the changed token in the changed file before
writing a sentence that assumes it landed.

---

## Round 5 — the first live CI run, and the review bots

The pre-merge audit ran four rounds against the plan. This round is what
running it actually taught, which is a different thing.

### The first sharded run went red, and it was my fault

Shard 1/4 and macOS failed on `management-integration-routes.test.ts`: a test
that fetches the served dashboard and reads its session bootstrap out of the
meta tags. The token came back empty.

Diagnosed rather than guessed. The test also fails on an untouched checkout of
`dev` when `gui/dist` is absent, and passes there after `bun run build` — so
the dependency is pre-existing and real. What my change removed was its
*accidental* satisfaction: the old three-platform job ran the suite and the GUI
build in the same job, so `gui/dist` always existed by the time tests ran.
Splitting the suite away from the gates broke that without anyone noticing,
and area-scoping the gates' build behind `gui/**` meant even that copy was
conditional.

Every job that runs the root suite now builds the GUI unconditionally, and a
suite pin asserts it — driven red first.

**This is the failure the four planning rounds could not have caught.** The
dependency was invisible in the workflow, invisible in the test file, and only
existed as a side effect of two things sharing a job. No amount of reading
finds that; running it does.

### Review bots: 9 comments, dispositions

| Source | Finding | Disposition |
|---|---|---|
| Codex P1 | `release.yml` accepts any successful `ci.yml` run for a SHA, so a green PR run — which skips Windows — could satisfy the publish gate | **FIXED** |
| Codex P2 | `.gitattributes` missing from the packaging filter | **FIXED** |
| CodeRabbit (Major) | `git clean -xffd . \|\| true` swallows a failed self-hosted wipe | **FIXED** |
| CodeRabbit (Minor) | `persist-credentials: false` missing on checkouts | **FIXED** |
| CodeRabbit (Minor) | Plan's shard/platform examples omit the GUI build | **FIXED** |
| CodeRabbit (Minor) | `040`'s gate sequence claims fail-fast without `set -e` | **FIXED** |
| CodeRabbit (Major) | `040`'s leak scan omits `devlog` and uses two different pattern sets | **FIXED** |
| CodeRabbit (Minor) | Devlog dates are "future-dated" (2026-08-03) | **REBUTTED** |

**The Codex P1 was the best find of the entire review**, planning rounds
included. My change made the Windows leg conditional on the event, but
`release.yml` selects a CI run by SHA and status alone. After a promotion, the
PR run for that same commit is still there, still green, and still Windows-free
— so the publish gate could be satisfied by a run that proved nothing about
Windows, while the promotion run carrying Windows was still in flight or had
failed. That is precisely the coverage hole this unit promised not to open, and
it was outside the file I was editing. The gate now selects a `push` run on the
release branch specifically.

**The date rebuttal.** The bot read CI timestamps in UTC (`2026-08-02T17:xx`)
and concluded the 2026-08-03 dates were in the future. The workspace runs in
Asia/Seoul, where those UTC timestamps are already the 3rd:

```
local: 2026-08-03 02:55 KST
utc:   2026-08-02 17:55 UTC
```

The dates are correct in the timezone they were written in, and the unit slug
matches them. Changing them to match a UTC reading would make the record less
accurate, not more.
