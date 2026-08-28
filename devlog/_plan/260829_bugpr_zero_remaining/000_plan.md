# 260829 — Bug-PR zero-remaining campaign

Objective: no open pull request labeled `bug` remains on `lidge-jun/opencodex`. Every
bug PR reaches a terminal disposition backed by evidence, the 429 OAuth rotation work
(#2807) lands on `dev`, matching issues close with cross-references, and important
bug issues with no PR get a reimplementation merged.

## Constraints

- Every change travels through a PR targeting `dev`. No direct push to `dev`.
- CI-first evidence. The repository's own `ci`, `test N/4`, `macos`, `hygiene`, and
  `gates` (privacy) checks on the exact head SHA are the primary proof. The full local
  `bun run test` suite is not run; when a suite is genuinely needed it runs remotely
  via `ssh lidge` + `ocx-run`.
- Commits and pushes use `--no-verify`.
- `--admin` merge is available (the operator holds admin) but never substitutes for the
  `MAINTAINERS.md` non-author security review on authentication, credential, OAuth,
  workflow, release, or dependency surfaces.
- Unfixed security reproduction detail stays in gitignored `.tmp/`, never `devlog/`.
- Unrelated dirty worktrees and the 10 existing stashes are preserved untouched.

## Live triage (2026-08-29, four parallel Sol-high lanes)

**Sixteen** open PRs carry the `bug` label. The first triage pass found fourteen; the A-gate
audit found that #2744 had been missed, and #2836 (this campaign's own keystone PR) is also
`bug`-labeled. The inventory is re-queried at the start of every work-phase and again at
closeout, because the set moves while the campaign runs — see
`001_audit_round1_synthesis.md`. Every row below is live evidence from
`gh pr view`/`gh pr checks`/`gh api compare` at triage time.

| PR | author | head SHA | mergeable | behind dev | real gates | security surface | matching issue |
|----|--------|----------|-----------|-----------|------------|------------------|----------------|
| #2835 | lidge-jun | 0dc8704531 | MERGEABLE/BLOCKED | 0 | 6 pass / 1 fail | no | none |
| #2828 | luvs01 | 019c792607 | MERGEABLE/BLOCKED (draft) | 0 | 1 pass / 9 never started | yes (grok inject credential fields) | #2830 partially |
| #2822 | luvs01 | 450b1bc60c | MERGEABLE/UNSTABLE | 1 | 6 pass / 1 fail | no | none |
| #2821 | luvs01 | d21ad61d51 | MERGEABLE/UNSTABLE | 11 | 6 pass / 3 fail | no | none |
| #2812 | gaoran1209 | 220a9048ed | MERGEABLE/BLOCKED | 77 | 5 pass / 3 fail | no | #2810 |
| #2807 | lidge-jun | 1c61a7e8cd | CONFLICTING/DIRTY | 80 | 9 pass / 0 fail | yes (OAuth core) | none (Closes #2745 is a PR) |
| #2799 | adtumk | e9a7bb7bb0 | MERGEABLE/CLEAN | 94 | 7 pass / 0 fail | no | none |
| #2798 | olddonkey | 856ad72d41 | MERGEABLE/CLEAN | 97 | 8 pass / 0 fail | no | none |
| #2797 | rrmlima | edaa044f28 | MERGEABLE/BLOCKED (draft) | 97 | 6 pass / 1 fail | yes (doctor reads env_key) | #2713 (partial) |
| #2796 | rrmlima | 2328c16c76 | MERGEABLE/BLOCKED (draft) | 97 | 6 pass / 3 fail | yes (client fingerprint) | #2717 |
| #2793 | smileBeda | 3a6e600eda | MERGEABLE/BLOCKED (draft) | 97 | 4 pass / 3 fail, unsponsored_surface | yes (78 files, auth core) | #2718 |
| #2785 | DevonGithub | 107f2cbb28 | MERGEABLE/UNSTABLE | 97 | 5 pass / 1 fail | no | none |
| #2638 | luvs01 | c8556f3703 | MERGEABLE/BLOCKED | 13 | 4 pass / 4 fail | yes (auth-context, routing) | none |
| #2497 | MarcTCruz | 86a49e8525 | CONFLICTING/DIRTY (draft) | 496 | 6 pass / 2 fail | yes (20 files, auth core) | #2221 |
| #2744 | yxr1995-maker | 1d8e35462a | CONFLICTING/DIRTY (draft) | 140 | CHANGES_REQUESTED | yes (core.ts + package.json) | none |
| #2836 | lidge-jun | befcac3e10 | MERGEABLE (wp8 keystone) | 0 | 23 pass / 0 fail, macOS queued | package.json (maintainer-authored) | n/a |

#2638 and #2828 moved after triage: both are now zero commits behind at rewritten heads
(`375e6f8fb8`, `019c792607`), so their recorded reviews no longer describe their current
diffs. They are handled by wp9, not by the reimplementation lane.

## The keystone: `dev` trails its own published channel

`test 2/4`, `test 3/4`, `test 4/4`, and `macos` fail on #2835, #2822, #2821, #2796,
#2797, and #2785 with one shared assertion, not with anything those PRs changed:

```
release version line > the in-tree version is never behind a released one
package.json version 2.35.0 is BEHIND the highest release tag v2.36.0-preview.20260829
```

Live state at triage:

| ref | package.json version |
|-----|----------------------|
| `dev` | 2.35.0 |
| `main` | 2.35.0 |
| `preview` | 2.36.0-preview.20260829 |
| tag `v2.36.0-preview.20260829` | 2.36.0-preview.20260829 |

The preview bump was cut on the prerelease train and never came back to `dev`, which is
the exact failure mode `tests/release-version-line.test.ts` was written for — its own
header documents the previous occurrence (repaired by hand in `32529c2b2`, when `dev`
said 2.24.2 against a published 2.26.0).

Consequence for this campaign: rebasing a stale bug PR onto `dev` does **not** turn its
CI green, because the failure is inherited from the base. The version line is therefore
work-phase wp8 and runs FIRST; every later lane rebases onto the repaired `dev`.

## Merge lanes

- **wp8 keystone** — repair `dev`'s version line so inherited red turns green.
- **wp2 Lane A** — approved and CI-clean: #2799, #2798. Rebase onto the repaired `dev`,
  confirm exact-head green, merge. #2798 is **security-gated**: `src/lib/destination-policy.ts`
  decides whether an OAuth bearer may be sent to an overridden destination, which
  `MAINTAINERS.md` covers under "other security-boundary changes" even though the hygiene
  gate's restricted-path list does not name it. Its approval must be re-earned on the
  rebased head.
- **wp3 Lane B** — approved but stale or inherited-red: #2822, #2821, #2785. Same
  treatment; patch integrity proven with `git patch-id --stable` and `git range-diff`.
- **wp4 Lane C** — #2807, the 429 OAuth rotation work. Conflicting, 80 behind, and
  carrying one live reviewer blocker (a rotated bearer can still be paired with the
  previous account's accepted origin). Reimplement on current `dev` with an executable
  A→429→B regression, then non-author security review.
- **wp5 Lane D** — reimplementation lane for PRs whose intent is right but whose branch
  cannot land as-is: #2812 (reviewer rejected the equivalence assumption), #2796, #2797,
  #2835 (host-identity disclosure in devlog), #2793, #2497, #2744. #2828 and #2638 were
  moved OUT of this lane into wp9 after the audit found their reviews bound to superseded
  heads. Every member that touches `src/server/responses/core.ts` (#2497, #2793, #2744) runs
  AFTER wp4 and re-verifies against the accumulated file.
- **wp9 re-audit** — #2638 and #2828 at their current heads, sequenced after wp4 because
  #2638 touches `src/server/responses/core.ts`.
- **wp6 Lane E** — PR-less bug issues worth reimplementing, chosen in wp1 from the 16
  open `bug` issues.
- **wp7 closeout** — issue closure with cross-references and the zero-open-bug-PR proof.

## Verifier reality check (PLAN-VERIFIER-REAL-01)

Corrected after the A-gate audit ran each command rather than trusting the plan.

- **Bootstrap first:** this worktree had no `node_modules`, which made `bun x tsc --noEmit`
  exit 1 with `TS2688: Cannot find type definition file for 'bun-types'` — an environment
  gap, not a type error. After `bun install`, `bun x tsc --noEmit` exits 0. A fresh rebase
  worktree needs `bun install` before its tests mean anything (a missing install surfaced as
  `Cannot find module 'zod/v4'` on #2799's rebase).
- `gh pr checks <N> --repo lidge-jun/opencodex` — exists, ran during triage, reads the
  exact PR head. This is the campaign's primary verifier.
- `bun x tsc --noEmit` and focused `bun test tests/<file>` — exist in `package.json`
  (`typecheck`); used for local implementation loops only, after the bootstrap above.
- `scripts/ci/assert-mergeable-review.sh <N>` — the executable pre-merge review gate added
  by this campaign. Fails closed unless an `APPROVED` review is bound to the exact current
  head, authored by someone other than the PR author, and listed as a current maintainer in
  `MAINTAINERS.md`. Proven non-vacuous: exit 0 on #2798 (real exact-head approval from
  Ingwannu), exit 1 on #2836 and #2812.
- `bun run skill:surface:check` — the read-only verifier. `bun run skill:surface` is a
  GENERATOR (`scripts/generate-ocx-skill-surface.ts` calls `writeFileSync`) and must never
  be cited as a gate.
- `bun run test` (full suite) — deliberately NOT used locally per the operator's
  instruction; the remote equivalent is `ssh lidge 'export PATH=$HOME/bin:$PATH; ocx-run
  <name> <workdir> <timeout> <command...>'`, confirmed present at
  `/home/lidgeai/bin/ocx-run`. Remote evidence counts only when the recorded workdir is
  proven to sit at the exact head SHA and the child command exercises the change; a bare
  `rc=0` from an unrelated directory proves nothing.
- `bun run privacy:scan` — runs inside the `gates` check on every PR head.
