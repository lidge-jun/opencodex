# 2.56.0 release train — roadmap

Status: open. Opened 2026-09-15. Roadmap repaired 2026-09-15 after a reviewer round rejected the
first version; what changed is recorded under "Repairs" at the end.

## The frozen range

The release candidate is **`2702911708`** and the baseline is **`1cc89cf88c`** (`v2.55.0`, the
current `main` tip). Nine commits, named here so "every commit was audited" is a checkable claim
rather than a feeling:

| Commit | PR | What it is |
| --- | --- | --- |
| `369be813c4` | #4673 | reasoning input items get the summary the upstream requires |
| `11f1119718` | #4672 | `bridge.ts` split behind a facade |
| `3ea88f3db8` | #4674 | lab synchronous-activation guard extended to callees |
| `a63a47363f` | #4675 | `server/index.ts` split behind a facade |
| `89bc67353c` | #4681 | a quota test stops deleting the real OpenCodex home |
| `485a525aa9` | #4677 | `server/responses/core.ts` split behind a facade |
| `4bef58bf82` | #4684 | devlog only |
| `2046e684ed` | #4685 | devlog only — this plan unit |
| `2702911708` | #4683 | continuation replay misses refuse instead of truncating |

Three of the nine are facade splits of the hottest files in the project, each landed as a
behaviour-preserving refactor. A refactor that claims to change nothing is exactly the change a
release audit should not take on faith, and it is why the audit spends most of its budget there.

## Constraint that shapes the whole unit

No local full suite, typecheck or build. Hosted CI at an exact head SHA is the only accepted
evidence for "this tree passes". Source reading and single focused test files are the local
instruments. Every claim below therefore names either a CI run at a SHA or a specific file read.

## Work phases

| Phase | Doc | Outcome |
| --- | --- | --- |
| wp1 | this file | Roadmap locked and repaired; implementation starts in wp2. |
| wp2 | `010_land_4683.md` | #4683 landed on `dev` with CI green at its exact head. **Done.** |
| wp3 | `020_regression_audit.md` | Every commit in the frozen range audited; findings triaged. |
| wp4 | `030_release.md` | 2.56.0 on `main` and `preview`, publish verified. |

## Completion criteria

1. #4683 squash-merged into `dev` with Cross-platform CI success at its exact head SHA.
   **Met:** head `d8ef6ee9b889e51e5d3e547d60a537b8fbecfb85`, run `34935526979` success, squashed
   as `2702911708`.
2. Each of the nine commits enumerated above has a recorded subagent verdict, and the final tree at
   `2702911708` is audited for the invariants the three facade splits could break together. Every
   REGRESSION or RISK is fixed on `dev` or accepted here in writing with a stated reason.
3. An explicit go/no-go decision is recorded against that audit before any promotion merge.
4. 2.56.0 reaches `main` and `preview`, each with hosted CI success at its exact promotion head,
   and the release workflow reports a successful publish dispatched with `expected-sha` equal to
   the `main` release commit. That commit is not the frozen candidate itself — a promotion merge
   creates a new commit — so what must match the candidate is its tree, not its SHA, and
   `release.yml` refuses any dispatch whose `expected-sha` differs from the commit it checks out.
5. No local full suite, typecheck or build was run anywhere in this unit. Every pass claim in these
   documents cites either a hosted CI run at a SHA or a named focused test file.

## Repairs

The first roadmap was reviewed and rejected. Three blockers, all now discharged:

- **The release order contradicted `MAINTAINERS.md`.** It promoted first and moved `dev` after.
  `MAINTAINERS.md` lines 84-91 require the `dev` version move first. `030_release.md` now states
  the order the policy and the workflow gates actually force.
- **The audit range had no frozen endpoint**, so "every commit" could not be checked. The table
  above pins it, including the two devlog commits the first slice list omitted.
- **The landed evidence for #4683 was stale**, naming an intermediate head. Criterion 1 now carries
  the exact head, the CI run and the squash commit.
