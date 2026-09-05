# Lane B catalog carry roadmap

## Loop specification

- Archetype: spec-satisfaction repair and attributable integration.
- Trigger: owner assigned catalog lane B and authorized stacked PRs, no-verify pushes, merges and immediate closure of completed source work.
- Goal: manual OpenAI visibility, persistent context limits, Go effort/ordering, provider model management and Fable 1M selectors work together on dev.
- Non-goals: other lanes, release/main/preview promotion, deployment, global proxy/config changes, new dependencies, broad cleanup.
- Tool/credential scope: git and authenticated GitHub CLI for this repository; inherited-model subagents; read-only local inspection; isolated QA or remote checks only when needed.
- Write scope: this unit, the exact source-PR files named by each decade plan, necessary focused regression/SoT follow-ups, and ignored scratch/evidence. Preserve peer changes.
- Resource policy: user authorized inherited parallel agents without a numeric cap. No imposed token/cost limit. Six-hour work-phase checkpoint; a reached bound is reported honestly, never as success. Context compaction only checkpoints work.
- Verifier: current-head Cross-platform CI, GUI tests/lint/build and privacy checks from repository CI; independent diff review; GUI observation where rendering changed; git ancestry and attribution checks. Local tests, suites, typechecks and builds are prohibited for this run.
- Stop: all five outcomes verified on dev, replacements merged, original PRs closed and fully resolved issues closed.
- Memory artifact: this unit plus the session-bound goalplan; volatile source/review/CI snapshots in `.tmp/lane-b/`.
- Outcomes: DONE after proof; NOOP only with current-code proof; external BLOCKED/UNSAFE/NEEDS_HUMAN requires evidence and no other authorized progress. Pending CI is continuing work.
- Escalation up: main reclaims a packet after two distinct agents fail it. Down: delegate only explicit bounded tasks recorded at P; no speculative implementation of a later phase.

## Current tree and source anchors

Initial dev is `81871b3fa7034250b8d5ba2cbbfde44e40f0e69c`. The managed checkout stays in place and is adopted as `codex/lane-b-01-visibility`.

| Phase | Source PR/head | Contract | Branch plan |
|---|---|---|---|
| roadmap | current dev | lock these documents only | base visibility branch |
| visibility / 010 | #3653 / `956eedac439922cf7645f130ef8432833e813a9a` | distinguish native and configured manual rows | `codex/lane-b-01-visibility`, base dev |
| context / 020 | #3654 / `8facdb0d8c10109701015c0f6109fc67b1d9dd3c` | preserve selection independently of enabled state | `codex/lane-b-02-context`, base 01 |
| ordering / 030 | #3571 / `0a935c5694229760c8c1cd5a62072107d8ae6696` | separate picker/spawn rank and exact efforts | `codex/lane-b-03-ordering`, base 02 |
| management / 040 | #3659 / `ff4e5cd5352b9c1bd05e3de0091f3483ca130be5` | consume visibility contract for hide/delete and static sync | `codex/lane-b-04-management`, base 03 |
| fable / 050 | #3649 / `95becce94255982667cef10308806770d49cc05b` | preserve 1M selector and canonical upstream route | `codex/lane-b-05-fable`, base 04 |
| landing / 060 | all verified replacement heads | bottom-up dev integration and closure | retain parent refs until child retarget |

The owner explicitly requests stacked PR delivery. Context and ordering share persisted catalog configuration; model management consumes the visibility and catalog contracts. Fable is functionally independent and placed last only to satisfy the requested stack delivery; no runtime dependency is claimed. One work-phase is one full PABCD cycle; each implementation phase is verified before the next.

## Existing owners and SoT

Runtime management lives in `src/server/management/`, catalog publication in `src/codex/catalog/`, persistence in `src/config.ts` and `src/providers/context-cap.ts`, dashboard rows in `gui/src/models-groups.ts`, provider workspace in `gui/src/components/provider-workspace/`. Focused tests remain in domain directories; new files update both test-layout manifests. Read nested AGENTS before changes.

SoT synchronization targets are `structure/02_config-and-codex-home.md` (context persistence), `structure/03_catalog-and-subagents.md` (efforts and ordering), and `structure/05_gui-and-management-api.md` (visibility and model operations), plus the source PR's public documentation. Add narrow contract notes only when existing text would otherwise be incomplete or contradictory.

## Verification execution policy

`.github/workflows/ci.yml:7` accepts all PR bases, including open stack heads. Its `changes` filter controls actual test execution; a green aggregate with skipped test jobs is insufficient. `workflow_dispatch` supports all lanes. Inspect each actual run's head SHA, event, test jobs and conclusions. Author-reported historical test counts do not certify a carry head.

`git diff --check` and a Python document-completeness checker are documentation/static artifact checks, not repository test execution. These are the only local checks in the docs-only cycle. Implementation C receipts invoke a read-only GitHub evidence verifier that asserts the actual checked-out SHA and successful test jobs; the verifier never starts local tests. Screenshot paths already in original PRs preserve author evidence; rendering changes require an actual observation of the carried state or an explicitly identified outstanding gate.

## Attribution and publication

Carry source non-merge commits with `git cherry-pick -x` when compatible; otherwise apply the exact merge-base diff preserving binaries and create a scoped commit with actual source-author `Co-authored-by` trailers. Keep source PR/head references in every replacement description. Do not cherry-pick upstream merge commits as new feature content. Every push uses `git push --no-verify`; no direct dev pushes or contributor-branch rewrites.

GitHub operations stay sequential. Bottom-up merge commits preserve ancestry; if squash is required, restack the children immediately and revalidate. Before merging, inspect current head, exact-head CI, outstanding reviews and any peer dev drift. Preserve all author trailers. Close source PRs as superseded and issues #3650/#3651 as completed only after their replacement is reachable from dev and solves the full report.

## Shared surfaces

- A #3679 and B #3654 share `src/config.ts`; B reconciles both independent field additions.
- D #3625 and B #3659 share locale modules; retain all keys.
- D #3646 and B #3649 share Claude alias routing; D owns hub alias resolution, B owns Fable native selector round-trip.
- A #3568 and B #3571 share layout manifests and provider docs; preserve both additions.

Independent review findings involving security stay in ignored scratch space. Public plans describe the already-public source changes, never unpublished vulnerability analysis.

## Owner steering and verification checkpoints

The owner explicitly authorized admin merges during execution. Once a child PR is open, land a verified parent with `--admin --merge`, prove dev ancestry and immediately close its completed source work; retain/retarget the child before any parent-ref cleanup. The final landing cycle reconciles all outcomes rather than delaying every already-ready parent until the end.

An implementation preparation cycle may close after the exact-head functional CI jobs (Linux/macOS full tests, typecheck, GUI tests and privacy), independent review and applicable remote GUI/docs checks pass. Queued aggregate packaging/keyring jobs remain explicit PR merge gates; do not claim them passed or merge before resolving required checks. This allows the next stack layer to be prepared while ancillary jobs queue, without weakening final verification or source-closure requirements.
