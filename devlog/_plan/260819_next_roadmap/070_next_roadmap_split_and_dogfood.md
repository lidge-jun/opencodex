# 070 — Next roadmap: bug PRs, the split merge, and the dogfooding gate

Written 2026-08-19 after the queue-drain campaign closed. State at writing:
56 open PRs (17 `review-ready`), 24 open `bug` issues, `dev` at `c4bf833c9`,
npm `latest=2.26.0` / `preview=2.26.0-preview.20260819`.

> **Status: stages A-C executed 2026-08-19.** 14 PRs merged including the full
> split stack (#2019, #2023, #2036); 8 held with posted blockers. Outcome and
> lessons: `090_merge_loop_outcome.md`. Per-phase evidence:
> `080_merge_loop_ledger.md`.
>
> **What this document got wrong, again.** Its claim that a barrel extraction
> cannot be meaningfully tested — and therefore needs the hygiene exception —
> was disproved during execution. Forking a `Set` inside the barrel leaves
> `tsc --noEmit` at exit 0, and no test imported the leaves directly, so barrel
> and leaf were never compared to each other.
> `tests/types-barrel-identity.test.ts` now covers it. Reuse the phase order
> below; do not reuse the exception argument.
>
> **The preview soak gate (C3 and C5) has NOT run.** The split is on `dev` and
> has never been exercised as a published build. That gate is still owed, and
> the freeze-vs-shared-attribution question it raises is still a user decision.

## The question this answers

Merging a mega-file split is not like merging a fix. A fix either works or
fails on the path it touches. A split touches **no path and every path at
once**: nothing changes behaviorally, so nothing fails visibly, and the way it
breaks is by dropping something the type system or a test never looked at.

So the ordering below is not "important things first". It is **cheapest-to-
verify first, and the split only once the queue behind it is short enough that
a rebase storm is affordable.**

## Fact 1: the three split PRs are not one risk class

This is the single most useful thing measured, and it reorders everything.

| PR | `src` diff | Runtime code moved | Real risk |
|---|---|---|---|
| #2019 WP1 | 3 files, +184/-162 | 7 value helpers (`namespacedToolName`, `modelInList`, wire pins) | **low** |
| #2023 WP1b | 5 files, +1801/-1720 | **none — type-only** | **near zero** |
| #2036 WP2a | 4 files, +29/-25 | 2 functions + 2 import sites | **low, but it is the one that touches routing** |

`#2023` looks like the scariest PR in the repository (1801 insertions,
1720 deletions) and is the safest thing in this document. Every line it moves
is erased at compile time. If the barrel is wrong, `tsc` fails; there is no
runtime state in which it can be subtly wrong. The independent audit already
confirmed 85/85 exports and 53/53 interfaces with zero field drift.

`#2036` is 29 lines and is the only one that changes what `src/router.ts` and
`src/routing/profile.ts` import at runtime.

**Corrected after review: the TDZ framing was overstated.** The cycle is real,
but the bindings crossing it are *function declarations*, which hoist — there
is no demonstrated top-level access that could hit a temporal dead zone. And
`#2036` **removes** the cycle rather than introducing one; the new leaf has
zero imports. Its CI, npm-global smoke, and startup checks are already green at
its exact head. Calling it "the riskiest split" was not supported.

What is still true, and is the reason to isolate it: it is the only one of the
three whose failure mode would be a **startup** failure rather than a compile
failure, and startup ordering is the thing the suite structurally cannot
observe — every test imports a fully-warm module graph. That justifies its own
soak window. It does not justify calling it dangerous.

The cycle is real, not hypothetical. On `dev`:

```
src/config.ts:38          import { routingProfileIssues } from "./routing/profile";
src/routing/profile.ts:16 import { hasOwnProvider } from "../config";
```

`#2036` cuts the return edge by moving `hasOwnProvider`/`isValidProviderName`
into `src/config/provider-name.ts` and repointing `profile.ts` and `router.ts`
at the leaf. That is the correct fix and the risk assessment named it as the
prerequisite for the rest of WP2. It is still the one to isolate, because
"which module finished initializing first" is not something the test suite
observes — every test imports a fully-warm module graph.

### Revised risk ranking

`#2019` moves actual runtime bindings (7 functions plus module-level constants
including `MODEL_ADAPTER_OVERRIDE_ALLOWED` and the wire-pin table). `#2036`
moves 2 functions and removes a cycle. `#2023` moves nothing executable.

So the honest ordering by *runtime* exposure is
**#2019 > #2036 > #2023** — which happens to match the ancestry-forced merge
order for the first two. The plan's soak windows follow exposure, not size.

**Correction (caught in review of this document's own first draft).** The first
version of this section said "merge #2023 first because it is type-only". That
is impossible: `#2023`'s base is `codex/split-wp1-types`, and
`git merge-base --is-ancestor` confirms `#2023` *contains* `#2019`. A stacked
child cannot land before its parent. Risk ranking does not get to override
ancestry.

**Actual merge order: #2019 -> #2023 -> #2036.**

The risk finding still changes something real, just not the order: it changes
**where the soak windows go**. `#2019` and `#2023` are one logical unit (the
parent is 7 pure-function moves, the child is type-only) and can share a
window. `#2036` gets its own, because it is the only one that touches module
init.

## Fact 2: the rebase storm is 10 PRs, not 6 — the first count was wrong

**Corrected after review.** The first draft sampled 11 PRs I guessed were
likely and reported 6 hits. Enumerating every open PR gives 13 that touch
`src/types.ts` or `src/config.ts` — 10 once the three split PRs themselves are
excluded. The draft missed **#2112, #1829, #1645, #1624** and undercounted the
conflicting ones.

| PR | Mergeable | Touches | Note |
|---|---|---|---|
| #2112 | MERGEABLE | types | **bug PR** (#2106 candidate), draft |
| #2080 | MERGEABLE | config | review-ready, FastWire B2 |
| #2054 | CONFLICTING | types | +1683, already conflicting |
| #2050 | MERGEABLE | types | +11559, 63 files |
| #1934 | MERGEABLE | types | **bug PR**, draft |
| #1905 | CONFLICTING | both | already conflicting |
| #1829 | MERGEABLE | config | +2237 |
| #1747 | CONFLICTING | both | +4548, 87 files |
| #1645 | MERGEABLE | types | vision sidecars |
| #1624 | CONFLICTING | both | already conflicting |

**Four are already CONFLICTING** (#2054, #1905, #1747, #1624), not two. And the
draft's inference from that was wrong too: "already conflicting means the split
costs them nothing" is false. An existing text conflict does not pre-pay for
structural drift — those branches still have to be reconciled against module
paths that will not exist in the form they were written against.

**Consequence: the storm is real but still not a reason to wait for the whole
queue.** Six MERGEABLE PRs pay a genuine cost (#2112, #2080, #2050, #1934,
#1829, #1645). Of those, the two worth landing first are the ones that are both
small and close to ready: **#2080** (review-ready) and **#1934** (bug fix). The
rest are large or draft and will need author work regardless.

## Fact 3: we already have a dogfooding channel and are not using it as a gate

`preview` publishes to npm under the `preview` dist-tag
(`release.yml` enforces `*-preview.*` versions on that branch). Right now
`preview` is **14 commits behind `dev` and 30 ahead** — it is a release
artifact, not a soak channel.

The split is exactly the change class where a soak channel earns its cost: no
test will catch a dropped optional field that nothing reads yet, but a week of
real traffic will.

**Consequence: preview becomes the split's gate.** Not for bug fixes — those
keep going straight to `dev`.

### Two operational details the first draft skipped

**Cutting a preview is a release operation, not a tag.** `release.yml` is
`workflow_dispatch` only, allows exactly `main`/`latest` or
`preview`/`preview`, and requires a `*-preview.*` version in the dispatched
`preview` checkout. `scripts/release.ts` automates the ceremony but **commits
and pushes** — there is no dry-run rehearsal. And `preview` is currently 14
behind / 30 ahead of `dev`, so "cut a preview of C1+C2" means first
reconciling a divergent branch, not fast-forwarding it. Budget that as a step.

**Freeze the candidate or lose attribution.** The plan's claim that `#2036`
gets its "own blame surface" is only true if the preview cut for it contains
*it* and not a week of unrelated bug merges. Each soak window must name an
exact SHA and state what else rode along. If continuous bug merging makes that
impossible, the honest options are a short `dev` freeze around the split cuts
or an explicit admission that attribution is shared — not a claimed isolation
the history does not support.

## The roadmap

### Phase A — clear the cheap queue (no split work)

Merge order among `review-ready`, smallest blast radius first:

1. **#2085** (admission window) — 44 lines, verdict already posted, merge.
2. **#2086** (`ocx models` CLI) — flip from draft, merge.
3. **#2102** (`prompt_cache_retention`) — after the API-key regression we
   asked for. Then close #2091 and #2099 as superseded.
4. **#2035** (Google reasoning tiers), **#2031** (MiMo vision sidecar),
   **#1878** (docs) — small, independent, review-ready.
5. **#2105** (Claude shell hook), **#2103** (xAI tool schema) — review-ready,
   one subsystem each.

Deliberately **not** in phase A: #2101 (1397 lines, account entitlement — needs
its own security-adjacent review), the Antigravity stack #2068-#2071 (~5600
lines, one author, needs a dedicated lane), #2072/#2075/#2080 FastWire
(#2072 already has an unresolved assumed-tier billing finding).

### Phase B — land the two PRs the split would inconvenience

**#2080** and **#1934**. Both touch a split target; both are cheaper to land
now than to rebase later. #2080 is review-ready; #1934 is draft and needs the
author.

If either stalls more than a few days, drop it from this phase rather than
letting it hold the split. The storm cost for two import-line rebases is
lower than the cost of the split rotting again.

### Phase C — the split merge, one PR per soak window

This is the part that needs the discipline.

**C1. #2019 (WP1, value helpers) -> dev.**
Parent of the stack; must land first. The 7 moved helpers are pure functions
with no module state. Post-merge check: grep for duplicate declarations — the
"singleton forking" risk from the original risk assessment does not apply to
pure functions, but the habit should start on the cheapest PR, not the
dangerous one.

**C2. #2023 (WP1b, type-only) -> dev**, after retargeting from
`codex/split-wp1-types` to `dev` (the parent branch is deletable only after
that retarget — deleting the base of an open PR closes it, which this campaign
already relearned on #2089).

Requires: `test-exception-approved` from a maintainer. The hygiene gate is
right that `src/` changed without a test, and the honest answer is that a
barrel's oracle is `tsc` plus the 396 test files that import through it — a
test asserting "the barrel re-exports `OcxTool`" restates the compiler. The
exception label exists in `pr-hygiene.yml` for exactly this.

Verification beyond CI: re-run the export/interface parity audit against the
merge commit, not the PR head. That audit is now the standing check for every
remaining split PR — a name-level check would miss a dropped field inside a
preserved interface, which is the only way a barrel extraction can hurt.

**C3. Cut a preview release containing C1+C2. Soak 5-7 days.**
This is the first real dogfooding gate. See the section below for what
"soak" means concretely.

**C4. #2036 (WP2a, config leaf) -> dev, alone.**
Do not bundle it with C1/C2. Not because it is dangerous — the review showed it
is not — but because it is the only one whose failure mode is **startup**
rather than compile, and startup ordering is what the suite structurally cannot
observe. A window where it is the only module-graph change is the cheapest way
to attribute a "the proxy will not start" report if one arrives. Freeze around
the cut, or state plainly what else rode along.

**C5. Second preview. Soak. Then promote to `main`/`latest`.**

### Phase D — WP2b onward, only after C5 is clean

The stateful config train (schema + load + mutation + live-rebase, which the
risk assessment says must move together or not at all) is the first genuinely
dangerous work package: eight module-level singletons, including a SQLite
mutation lock and three WeakMaps keyed on config object identity. Forking any
one of them is a silent correctness bug.

Do not start it until a preview carrying C1-C4 has soaked without a
split-attributable report. If phase C produces even one, the answer is to fix
the mechanism that let it through before adding a harder package.

## What "dogfooding" has to mean here, concretely

A soak that only checks "did anyone complain" cannot distinguish a clean split
from an unexercised one. Three things make it a real gate:

**1. The maintainer's own `ocx` runs the preview build** — the published
tarball, installed the way a user installs it, not the dev checkout.

**Correction to the first draft's justification.** It argued the risk was a
missed `src/types/*.ts` file causing a module-not-found in the published
package. That is not credible: `package.json` ships `src` **wholesale**
(`files: ["bin","src",...]`), `.npmignore` does not exclude it, and the current
published preview tarball contains 724 `src/` entries. A file committed under
`src/` is shipped; a file not committed fails CI first. And for `#2023`
specifically the references are type-only and erased — there is no runtime
resolution to fail.

The honest reason to run the published build is narrower and applies to
**`#2019` and `#2036`**, which do move runtime bindings: it exercises the
packaged module graph and real startup, which `npm-global-smoke` (install only)
does not.

**For `#2023` the runtime soak proves nothing at all**, and the plan should not
pretend otherwise. Erased interfaces cannot fail a routed turn. Its real risk is
a **type-contract** regression — a dropped optional field, a widened union, an
interface a downstream consumer no longer satisfies — and the gate for that is
the export/interface parity audit plus `tsc` against the merge commit, which is
exactly what this campaign already built and ran.

**2. Named surfaces get exercised, not just "used for a while".** The split
moves types used by routing, config, providers, and accounts. A soak that only
runs one provider on one model proves nothing about `OcxProviderConfig` or
`OcxComboConfig`. Minimum exercise set per soak window:

- one Codex-account (native) turn and one API-key provider turn,
- one routed/combo turn (exercises `OcxComboTarget`, `OcxRoutingProfileConfig`),
- one vision or image turn (`OcxImageContent`, sidecar config),
- `ocx doctor`, `ocx models`, and a dashboard load (the config and catalog
  types),
- one proxy restart (module init order — this is the C4 gate specifically).

**3. A dated `NO-REPORT` line is written down.** "Nothing broke" that is not
recorded is indistinguishable from "nobody looked". Each soak window closes
with a line in this unit naming the version, the dates, and which surfaces
were exercised — or naming the report and its disposition.

**Explicitly not a gate:** green CI on the merge commit. That is necessary and
it is already automatic. The whole point of the soak is the class of defect CI
cannot see, and this campaign produced two of those (a directory handle leak
on truncated scans, a warning branch that could never fire) in code that was
green.

## Bug PRs and issues — where they sit in all this

**Corrected: "never gated on the split" was false.** Two of the overlapping
PRs are themselves bug fixes — **#2112** (the #2106 `code_mode_only` candidate)
and **#1934** (namespaced tool aliases). Any overlapping PR that has not landed
before the split must be rebased or re-cut against leaves that did not exist
when it was written. That is gating, whatever we call it.

The accurate statement: **most** bug work is independent of the split, and the
two that are not should land in phase B alongside #2080. Everything else flows
continuously.

Standing bug work, in rough priority:

| Issue | Why it ranks |
|---|---|
| #2107, #2108 (Windows/WSL 502, native-main gate stuck) | user-visible breakage on a supported platform; #2108 needs a restart to clear |
| #2097 (unentitled accounts advertised) | routing sends traffic to accounts that will refuse it; #2101 is the candidate fix but is 1397 lines |
| #2092 (`prompt_cache_retention`) | decided, waiting on #2102 |
| #2047 (K12 short window) | decided as "neither PR merges"; both need the scorer gate |
| #1852 (PowerShell blocks /healthz) | #1876 is the candidate fix, review-ready |
| #2106 (`code_mode_only` opt-out) | #2112 is a fresh candidate, draft |

The pattern worth noticing: **five of these already have a candidate PR open.**
The bottleneck is review throughput, not authorship. That is what phase A is
for, and it is why phase A comes before the split rather than after.

## Sequencing summary

```
A: cheap review-ready merges        (no split work, unblocks 6 issues)
B: #2080 + #1934 (+ #2112 if ready) (overlapping PRs, incl. 2 bug fixes)
C1: #2019 value moves  -> dev       (parent; most runtime exposure)
C2: retarget #2023 to dev, re-verify, merge   (type-only; parity audit is its gate, not the soak)
C3: preview + 5-7 day soak          <- first real gate
C4: #2036 config leaf  -> dev alone (startup-order exposure; freeze around the cut)
C5: preview + soak -> promote to latest
D: WP2b stateful config train       (only if C5 is clean)
```

Most bug PRs flow continuously alongside A-C. The exceptions are the 10 PRs
that touch `src/types.ts` or `src/config.ts`, two of which are bug fixes; they
either land in phase B or pay a rebase after phase C.

## What this document got wrong, and why that is worth recording

An adversarial review of the first draft returned FAIL on four counts, and all
four were real:

1. **A dependency error.** It proposed merging `#2023` before `#2019` because
   `#2023` is safer. `#2023` is a *child* of `#2019` and contains it; the
   order was impossible. Risk ranking does not override ancestry.
2. **A wrong count.** 6 overlapping PRs became 10 once every open PR was
   enumerated instead of sampled, and 2 "already conflicting" became 4.
3. **A backwards justification.** The dogfooding argument rested on a packaging
   failure that `files: ["src"]` makes impossible, and applied it to the one PR
   (`#2023`) whose contents are erased at compile time.
4. **An overstated risk.** `#2036`'s TDZ story described a hazard the code does
   not have — the cyclic bindings are hoisted function declarations, and the PR
   removes the cycle rather than adding one.

The pattern is the same one 060 recorded from the campaign itself: **the
conclusions mostly survived and the reasons did not.** Isolating `#2036` is
still right, just not for the stated reason. Landing overlapping PRs early is
still right, but for six PRs rather than three. A plan whose reasoning is wrong
in this way still produces roughly correct actions — right up until someone
reuses the reasoning for a decision it does not fit.
